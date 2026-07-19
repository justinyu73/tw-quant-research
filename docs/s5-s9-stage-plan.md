# S5–S9 staged execution plan

## Operating rule

This is a planning artifact only. S5–S9 implementation is not authorized by
this document. Human approval of the companion package is required before S5
starts.

Each stage follows the same bounded loop:

```text
goal_intake -> approved scope -> smallest implementation
  -> self-run acceptance -> evidence re-verification
  -> stage summary -> next stage only after pass
```

The agent may continue to the next stage only when the current stage's
acceptance evidence is independently produced and status is `pass`. A failed
test, repeated failure threshold, missing evidence, or an unplanned design
fork stops the sequence and asks for direction. No stage may be reported as
pass from narrative inspection alone.

## Global rules for S5–S9

- LH remains an external driver; it does not own or copy this repo.
- Every stage has its own goal intake, allowed-file list, work unit, runner,
  summary, and evidence artifact.
- Evidence must contain the actual command, exit code, stdout/stderr digests,
  parsed result, changed-file list, and any network observation.
- Default network policy is `false`. Any stage that needs a new external
  source is a fork and stops before making the request.
- No credentials, cookies, broker tokens, private exports, FinMind, live
  orders, commits, pushes, or automatic promotion.
- No forward-fill, silent adjustment, retrieval-time substitution, or
  look-ahead leakage.
- The sequence has a failure budget of three consecutive failed acceptance
  attempts per stage. The third consecutive failure stops the sequence and
  requests review; a hard stop rule stops immediately.

## S5 — quality checks and explicit corporate actions

### goal_intake

Build deterministic quality checks over the S4 product rows and keep corporate
actions explicit and provenance-linked. If the factor direction or unit
semantics of a corporate-action source cannot be proved, preserve the action
as `unadmitted` and stop before deriving adjusted prices.

### Allowed scope

- Offline S4/S3 fixtures plus synthetic corporate-action fixtures.
- OHLCV, date, duplicate-key, numeric, unit, availability, provenance, and
  source-conflict checks.
- Explicit `corporate_action` records and an adjustment convention test only
  when the factor convention is documented by the fixture.
- No new network request, factor model, backtest, or dashboard.

### Acceptance standard

- Invalid OHLC, negative volume, duplicate logical keys, mixed units/currency,
  ambiguous revisions, and missing provenance fail closed.
- Corporate actions remain separate from raw OHLCV; no silent adjusted close.
- A synthetic split/dividend fixture proves the exact admitted factor direction,
  ex-date boundary, cash amount, and `as_of` visibility.
- A missing or ambiguous factor convention produces `unadmitted`, not a
  guessed adjustment.
- S1–S4 tests, Qlib synthetic regression, and LH preflight remain green.

### Evidence

`workflow/evidence/s5-quality-corporate-actions.acceptance.json`

## S6 — deterministic feature pipeline

### goal_intake

Create a provider-neutral, point-in-time feature pipeline from admitted S4/S5
rows. Every feature has a stable field ID, formula version, window, unit,
missingness rule, and source lineage.

### Allowed scope

- Offline admitted fixtures only.
- Deterministic price and revenue features such as 1/5/20-day returns,
  rolling volatility, volume statistics, revenue MoM, and revenue YoY.
- Exact calendar/trading-date windows and fail-closed missingness handling.
- No model fitting, factor ranking, backtest, provider initialization, or
  external data fetch.

### Acceptance standard

- Every feature is computed from rows visible at its `as_of` time.
- Window boundaries are exact; missing observations are not silently filled.
- First-window rows return an explicit null/reason code, not a partial value.
- Known synthetic fixtures produce exact expected values and stable digest.
- Feature metadata includes formula version, unit, window, `as_of`, source
  snapshot IDs, and quality status.
- S1–S5 tests and LH preflight remain green.

### Evidence

`workflow/evidence/s6-feature-pipeline.acceptance.json`

## S7 — provider-neutral backtest engine

### goal_intake

Build a deterministic research-only backtest loop over admitted S6 features and
prices. The engine must make signal timing, position timing, costs, slippage,
cash, and metrics explicit and reproducible.

### Allowed scope

- Synthetic and captured offline fixtures only.
- Long-only baseline strategy harness with explicit signal-to-next-bar timing.
- Configurable transaction cost and slippage inputs with default zero only in
  the synthetic acceptance fixture.
- Deterministic equity curve, returns, drawdown, turnover, and trade ledger.
- Qlib may be used only as a comparison/evaluation surface; the canonical
  loop and data contract remain repo-native.

### Acceptance standard

- A known two/three-bar fixture produces an exact trade ledger and equity
  curve.
- A signal generated at `t` cannot trade using close or feature data first
  available after `t`.
- Costs and slippage change results exactly when non-zero and are never hidden.
- No position is opened from an unadmitted row; missing data fails closed.
- Metrics are defined and tested: cumulative return, annualized return only
  with an explicit calendar convention, max drawdown, volatility, Sharpe/IR
  only with declared assumptions, turnover, and trade count.
- S1–S6 tests and LH preflight remain green; no investment-performance claim.

### Evidence

`workflow/evidence/s7-backtest.acceptance.json`

## S8 — read-only local product view

### goal_intake

Expose a read-only local product view for aligned prices, fundamentals,
features, backtest results, quality state, and provenance. The view is a
consumer of the S4–S7 read models; it does not create new financial logic.

### Allowed scope

- Local/offline generated payloads and a read-only local interface.
- Stable field names from `config/product-alignment.yaml` and feature/backtest
  metadata.
- As-of filtering, source/status display, formula version, and evidence links.
- No external network, authentication, write endpoints, order placement,
  cloud deployment, or dashboard design fork without a new review.

### Acceptance standard

- Every displayed numeric field maps to a canonical/product field and formula
  version; no dashboard-only calculation is allowed.
- As-of view hides future observations and visibly marks `unadmitted`,
  `conflict`, and `invalid` data.
- Provenance and evidence links survive into the view.
- Read-only boundary is tested: write methods and unknown routes fail closed.
- Empty, missing, and conflicting data states have deterministic output.
- Local output is reproducible from fixtures; no external call is observed.
- S1–S7 tests and LH preflight remain green.

### Evidence

`workflow/evidence/s8-read-only-product-view.acceptance.json`

## S9 — release hardening and final acceptance

### goal_intake

Make the completed research-only engine reproducible, inspectable, and safe to
hand off. S9 validates the entire S1–S8 chain without adding product scope.

### Allowed scope

- Full offline test matrix, evidence schema validation, deterministic rerun,
  documentation/index consistency, and allowed-file audit.
- Rebuild or replay from committed/local fixtures only.
- Final stage summary and release-readiness report.

### Acceptance standard

- S1–S8 evidence artifacts exist, parse, and are internally consistent.
- Full default and optional Qlib synthetic test matrices pass; LH preflight is
  pass and write-free.
- Network guard reports zero external calls for the release test.
- Repeated clean-room-style replay gives matching fixture/product/evidence
  digests, excluding explicitly documented timestamps.
- No credentials/private data/unapproved providers or forbidden files exist.
- README, workflow, field/formula docs, and cannot-claim statements agree.
- Final status is `pass` only from the generated evidence; otherwise stop.

### Evidence

`workflow/evidence/s9-release-hardening.acceptance.json`

## Planned artifact pattern

Each stage will add only its approved files:

```text
workflow/lh-work-unit.sN.example.json
scripts/run_sN_acceptance.py
tests/fixtures/sN/*
tests/test_sN_*.py
workflow/evidence/sN-*.acceptance.json
docs/sN-*.md
```

The next stage is never inferred from a green unit test alone. The stage
runner, evidence status, failure count, and summary must all agree.
