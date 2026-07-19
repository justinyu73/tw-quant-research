# TQE P5 human op-demo

This demo proves the P5.2 corporate-action admission path, the current
read-only dashboard locally, and the bounded free-first 2330 history replay.
The capture utility is human-run and separate from dashboard runtime; it does
not activate a paid source or advance the blocked P5.1/P5.3 gates.

## Operator steps

Run from the repository root:

```sh
git status -sb
python3 scripts/p5_corporate_action_validation.py
python3 scripts/p5_work_unit_digest.py
python3 scripts/p5_execution_target.py
python3 -B -m unittest discover -s tests -v
python3 scripts/lh_preflight.py
python3 scripts/p4_research_closure.py
git diff --check
npm run dashboard:browser-smoke
```

For the one-time official TWSE history capture used by the chart verification:

```sh
python3 scripts/capture_twse_stock_day.py --stock-no 2330 --start 2025-01 --end 2026-06
```

This writes the bounded local artifact
`tests/fixtures/k6a/twse_2330_history-2025-2026.json.gz`. Review its source
metadata and digest before retaining or replacing it.

## Expected observations

1. The P5.2 validator returns JSON with `stage_id: "P5.2"`, `status: "pass"`,
   `network: false`, `provider_calls: 0`, and every check set to `true`.
2. The P5 target reports `status: "blocked_source_contract"` and
   `execution_ready: false`; P5.2 passing does not bypass the P5.1 bulk-source
   hard stop.
3. The test suite is green and the LH/P4 checks report `pass`.
4. The normal verification commands are local and write-free; the separate
   capture command is the only human-approved network step and writes one
   bounded, provenance-labelled 2330 snapshot.
5. The policy check shows split volume inversion (`1000 -> 2000`) while raw
   OHLCV remains unchanged.
6. The work-unit digest is reported as `template_only_waiting_p5_1` and
   `activation_ready: false`.
7. The Playwright browser smoke returns `functional_pass: true`, zero browser
   errors, zero external requests, and no responsive horizontal overflow at
   1024px or 820px. After the redesigned screen is human-reviewed, the six
   new screenshot digests may replace the old visual baseline.

## Start the local frontend for human review

The current preview is available at
[`http://127.0.0.1:4173/`](http://127.0.0.1:4173/). If it is not running,
use two terminals from the repository root:

Terminal A:

```sh
python3 scripts/tqe_sidecar.py --host 127.0.0.1 --port 8767
```

Terminal B:

```sh
TQE_SIDECAR_URL=http://127.0.0.1:8767 python3 scripts/build_dashboard_preview.py
python3 -m http.server 4173 --bind 127.0.0.1 --directory outputs/dashboard-preview
```

The browser preview is read-only for market data. Watchlist changes use the
same schema as Tauri: browser dev uses localStorage, while the full Tauri dev
shell uses atomic local JSON persistence.

## Human frontend acceptance

1. Open `http://127.0.0.1:4173/` and confirm `資料 READ ONLY` and `研究駕駛艙`.
2. Open `個股分析`; confirm `TWSE:2330`, K-line canvas, `1D`, history
   range `2025-01-02 → 2026-07-15`, and `360 / session 360`.
3. Confirm the technical line is visible and the technical readings show
   non-empty MA(5), EMA(20), RSI(14), and MACD values.
4. Use fit, zoom, RSI, drawing, clear drawing, and template controls.
5. Switch to `M`; confirm the state remains visibly `partial` where the
   monthly history cannot satisfy a study window.
6. Search `TX:202608`; confirm the future/partial state is explicit.
7. Add a symbol to the watchlist; confirm the row appears, click save, and
   confirm the browser dev message says it was saved to local storage.
8. Open `市場篩選`, apply the TWSE filter, and add the admitted row to a group.
9. Open `市場資料`, inspect a row detail dialog, then open `研究計算` and
   confirm the read-only result is rendered.

## Current bugs / acceptance limits

- The previous blocking behavior was real: the browser preview disabled the
  save path and the sidecar fixture had only one 2330 bar. Dev localStorage
  fallback and the bounded history artifact now remove those two blockers.
- The 2330 artifact proves data and study plumbing, not strategy effectiveness.
  Universe-wide effectiveness still requires a separate point-in-time test.
- Tauri JSON save/reload remains a separate desktop-shell acceptance; browser
  localStorage only proves the dev preview path.

## Evidence to inspect

- [`workflow/tqe-p5-corporate-action-admission.json`](../workflow/tqe-p5-corporate-action-admission.json)
- [`workflow/evidence/p5.2-corporate-action.acceptance.json`](../workflow/evidence/p5.2-corporate-action.acceptance.json)
- [`workflow/evidence/p5.3-work-unit-digest.acceptance.json`](../workflow/evidence/p5.3-work-unit-digest.acceptance.json)
- [`tests/fixtures/s5/corporate-actions.json`](../tests/fixtures/s5/corporate-actions.json)

## Do not run in this demo

- `scripts/run_s3_source_admission.py`
- the draft P5 work-unit through host egress
- TPEx, US-equity, general provider-runtime, broker, or order workflows
