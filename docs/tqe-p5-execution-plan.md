# TQE P5 execution plan

This is the operational handoff for the approved P5 target. It is intentionally
separate from the 7B general provider-runtime workstream.

## Target

Admit a three-year TWSE EOD history from an exact official bulk source, bind an
official calendar response in the same human-approved work-unit, apply only a
separately evidenced corporate-action adjustment, and prove the normalized
fixture through offline P1-P4 replay.

## Work packages

| Package | Output | Gate |
| --- | --- | --- |
| P5.0 | Target preflight | Read-only, deterministic, `provider_calls=0` |
| P5.1 | TWSE bulk source + calendar contract | Exact endpoint, terms, schema, coverage, version, digest |
| P5.2 | Corporate-action fixture reference | S5 convention, factor, ex-date, `available_at`, source digest |
| P5.3 | Exact work-unit | Named GET purposes, parameters, cutoff, host allowlist, SHA-256 digest |
| P5.4 | External raw evidence + normalized fixture | No credentials/private data; deterministic mapping and digest |
| P5.5 | Coverage/read model | Expected/observed/missing sessions and indicator windows |
| P5.6 | Acceptance replay | Unit tests, LH preflight, P4 closure, dashboard preview/browser gates |

The caller-owned draft work-unit shape is recorded at
[`workflow/tqe-p5-twse-work-unit.draft.json`](../workflow/tqe-p5-twse-work-unit.draft.json).
It is deliberately `draft_not_runnable` until the exact source contracts and
digest are bound.

The first source-contract research record is
[`docs/tqe-p5-source-contract-research.md`](tqe-p5-source-contract-research.md).
The machine-readable result is
[`workflow/tqe-p5-twse-source-contract.json`](../workflow/tqe-p5-twse-source-contract.json).
It is `source_contract_blocked`; it does not authorize a provider call.
The independent P5.2 corporate-action admission is recorded in
[`workflow/tqe-p5-corporate-action-admission.json`](../workflow/tqe-p5-corporate-action-admission.json)
and has passed offline validation. The complete adjusted OHLCV and volume
policy is fixed in
[`workflow/tqe-p5-adjusted-ohlcv-volume-policy.json`](../workflow/tqe-p5-adjusted-ohlcv-volume-policy.json).

## Acceptance checklist

- [ ] TWSE source is an exact official bulk-history endpoint with at least the
  selected three-year coverage.
- [ ] Official calendar and bulk history are bound to the same work-unit digest.
- [ ] `as_of=2026-07-19T23:59:59+08:00` is enforced without look-ahead.
- [ ] Corporate-action fixture is separately approved and point-in-time valid.
- [x] Adjusted OHLCV and volume policy is defined before P5.4.
- [ ] Raw response is caller-owned external evidence; normalized fixture is
  compact, attributed, and digestible.
- [ ] K2/K3 range and coverage output is deterministic and fail-closed.
- [ ] P1-P4 gates pass offline after normalization.
- [ ] Human accepts TWSE before TPEx or any 7B work begins.

## Stop / handoff rule

If P5.1 cannot identify a real official bulk endpoint with the selected
coverage, stop and report `source_contract_blocked`; do not substitute the
existing latest-day endpoint or silently issue an unbounded date loop.
