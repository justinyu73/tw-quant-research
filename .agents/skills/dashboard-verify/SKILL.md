---
name: dashboard-verify
description: Run the TQE dashboard offline front-end verification (preview build + Playwright browser smoke for RWD and the P6 in-app alerts panel) and record acceptance evidence.
whenToUse: Use after changing anything under ui/dashboard/ (app.js, dashboard-core.js, styles.css, index.template.html), the sidecar read-model surface, or the in-app alerts feature, when you need browser-level proof that the research-only dashboard still renders and behaves correctly with zero network egress.
---

# Dashboard front-end verification

All steps are offline: the preview is built from committed fixtures and a loopback
sidecar (`127.0.0.1`); the Playwright scripts assert that no request leaves the
loopback surface.

## Prerequisites

- `playwright-core` is a repo devDependency (root `node_modules`); the headless
  Chromium build lives in `~/.cache/ms-playwright` (override with
  `CHROMIUM_EXECUTABLE_PATH` if needed).
- Python 3 with the repo `src/` layout; no extra packages are required.

## Steps

1. Build the preview (also done internally by each smoke script with a fresh
   sidecar port, but run it explicitly when you only need the static bundle):

   ```sh
   python3 scripts/build_dashboard_preview.py
   ```

   Output lands in `outputs/dashboard-preview/`.

2. RWD / general browser smoke (six breakpoints, watchlist, kline, notes,
   backtest settings, visual baselines):

   ```sh
   node scripts/dashboard-browser-smoke.cjs
   ```

   Prints a JSON report. Read `status`:
   - `pass` — functional checks and pixel baselines all green.
   - `functional_pass_baseline_required` — behavior is fine but screenshots
     differ from `EXPECTED_SCREENSHOTS`; review the images in
     `outputs/dashboard-browser/` and only then update the expected hashes
     (this is an intentional visual change, never a silent edit).
   - `fail` — a functional assertion broke; `browser_errors` and
     `external_requests` in the report point at the cause. Exit code 2.
   `external_requests` must always be `[]` — anything else means host egress.

3. P6 in-app alerts panel smoke:

   ```sh
   node scripts/dashboard-alerts-smoke.cjs
   ```

   Prints a JSON report with per-assertion `checks` (panel rendered,
   research-only label, no order-like affordance in the DOM, add alert,
   session-expiry exclusion from the persisted store, evaluation events,
   loopback-only requests, persistence across reload, fail-closed 400 for an
   invalid definition, no unexpected console errors). `status: "pass"` with
   exit code 0 means every check passed; otherwise the failing check name and
   detail are in the report.

## Shared harness pattern

Both smoke scripts use the same shape (keep new scripts consistent):
spawn `scripts/tqe_sidecar.py` on a free loopback port → rebuild the preview
with `TQE_SIDECAR_URL` pointing at it → serve `outputs/dashboard-preview/` via
a small `http.createServer` on `127.0.0.1` → drive headless Chromium with
`playwright-core` → collect `browser_errors` / `external_requests` → print one
JSON report and set `process.exitCode` (`0` pass, `2` assertion fail, `1`
harness error). The helper functions (`freePort`, `waitForSidecar`,
`findChromium`, `startServer`) are duplicated by design; copy them when adding
a new smoke script instead of inventing a new harness.

## Evidence

After a verification run that matters (release candidate, contract-bound work
unit, visual baseline change), record it under `workflow/evidence/` following
the existing `*.acceptance.json` style: schema id, `status` (use
`implemented_pending_human_acceptance` until the human gate owner accepts —
never write `pass` for acceptance the human has not given), the exact `argv`
and `exit_code` of each command under `offline_verification`, and honest
`acceptance_notes` listing what was and was not done.
