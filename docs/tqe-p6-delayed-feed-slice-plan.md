# TQE P6 delayed-feed implementation slice plan

Status: `planned_pending_activation_approval`

This plan expands the seven `implementation_slices` of
[`workflow/tqe-p6-delayed-feed.work-unit.draft.json`](../workflow/tqe-p6-delayed-feed.work-unit.draft.json)
into executable slices. It is a plan only: **no slice may start before the
activation requirements are met** (source contract digest approval, runtime
amendment approval, work-unit digest approval, host-egress admission — see
[`docs/tqe-p6-delayed-feed-runtime-amendment.md`](tqe-p6-delayed-feed-runtime-amendment.md)
§Approval and evidence chain). Slices S1–S2 involve provider contact and are
human-gated; S3–S7 are offline and may be prepared against fixtures but not
wired to any live capture path before approval.

## S1 — Source contract finalization (human-gated, provider contact)

- Scope: complete `resolution_required` in
  [`workflow/tqe-p6-delayed-feed-source-contract.json`](../workflow/tqe-p6-delayed-feed-source-contract.json)
  for `twse_mis_getstockinfo`: terms-of-use and robots review, independent
  delayed-data licence review, request budget enumeration.
- Touches: `workflow/tqe-p6-delayed-feed-source-contract.json` (status flip
  only after evidence), decision record.
- Evidence: review findings appended to the source contract; no code.
- Gate: human decision recorded in the source contract `decision` block.

## S2 — First human trial capture (human-gated, provider contact)

- Scope: bounded, human-approved GETs during market hours proving the delay
  semantics (quote timestamp `d`/`t` vs server `queryTime.sysTime`), encoding
  and schema probe, freshness classification per the contract's fail-closed
  rule (fresher than contractual delay → realtime-class → stop).
- Touches: new `scripts/p6_delayed_feed_trial_capture.cjs` (proposed,
  following `scripts/p5_trial_capture.cjs` pattern: playwright-core request
  context, caller-owned raw evidence, sha256/bytes/timestamps).
- Evidence: trial-capture record appended to the source contract
  (`first_trial_capture`, mirroring the P5.1 shape); raw files under
  `outputs/` (not committed).
- Acceptance: delay class demonstrated; source contract status may then move
  to approved-by-human.

## S3 — Normalization module with delay labels (offline)

- Scope: deterministic normalization of captured `getStockInfo` JSON into the
  research read model with the delay-label block (`feed_timestamp`,
  `captured_at`, `contractual_delay`, `delay_class`).
- Touches: new `src/tw_quant_engine/delayed_feed.py` (proposed): schema probe,
  CP950/UTF-8 handling if needed, normalization, staleness classification;
  no network imports — capture bytes arrive as files/fixtures.
- Tests: `tests/test_p6_delayed_feed.py` — fixture-based, no network, no
  wall-clock dependence (timestamps injected); fail-closed cases (schema
  drift, missing delay proof, realtime-class rejection).
- Fixtures: `tests/fixtures/p6/delayed_feed_*.json` derived from the S2 trial
  capture, repository-owned after terms review.

## S4 — Snapshot store and data_update wiring (offline)

- Scope: append-only delayed-quote snapshot (source, `feed_timestamp`,
  `captured_at`, `available_at = captured_at`, digest), keeping delayed data
  separate from admitted EOD history; manual ingestion path only.
- Touches: `src/tw_quant_engine/data_update.py` (add delayed-quote snapshot
  kind alongside the existing watchlist-update flow), snapshot module
  following the `k6a_snapshot.py` pattern.
- Tests: extend `tests/test_data_update.py`-style coverage for the new
  snapshot kind; PIT rule `available_at <= as_of` enforced; delayed data never
  overwrites EOD.

## S5 — Sidecar read model and route (offline)

- Scope: read-only sidecar route exposing delayed-quote rows with the full
  delay-label block; staleness computed from injected clock, never wall clock
  in tests.
- Touches: `src/tw_quant_engine/desktop_sidecar.py` (new GET route, e.g.
  `GET /delayed-quote?instrument=TWSE:2330`), read-model builder carrying the
  label.
- Tests: extend `tests/test_desktop_sidecar.py`-style route tests;
  fail-closed when the label cannot be carried.

## S6 — Dashboard presentation with delay/staleness labelling (offline)

- Scope: research-only presentation of delayed quotes with an explicit
  delay/staleness label on every surface that shows feed data; never styled
  as current; alerts (capability 3) and valuation (capability 5) surfaces keep
  consuming admitted EOD only until feed admission is separately evidenced.
- Touches: `ui/dashboard/app.js`, `dashboard-core.js`, `styles.css`; browser
  smoke expectations updated.
- Tests: `node tests/dashboard-core.test.cjs` cases for label presence and
  stale rendering; `npm run dashboard:browser-smoke` pixel gate.
- Contract guard: `scripts/p4_research_closure.py` checks
  (loopback-only, no order route) must keep passing — any UI text change must
  not break the `not_admitted` marker checks.

## S7 — Acceptance evidence package (offline)

- Scope: work-unit acceptance JSON with `provider_calls` accounted per
  approved request, delay-labelling evidence, the runtime amendment recorded,
  offline P1-P4 replay results.
- Touches: `workflow/evidence/p6-delayed-feed.acceptance.json` (new),
  work-unit status flip (human action).
- Verification gates (all offline): `python3 -B -m unittest discover -s
  tests -v`, `python3 scripts/lh_preflight.py`, `python3
  scripts/p4_research_closure.py`, `npm run dashboard:browser-smoke`,
  `python3 scripts/open_source_audit.py --strict`.

## Cross-slice rules

- No slice creates a persistent connection, streaming session, unattended
  poller, order route, or order-decision surface.
- Any ambiguity between a delayed quote and an order decision input: the
  feature degrades to inert.
- Automatic order placement remains `prohibited` throughout.
