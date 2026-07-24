# TQE P5 execution plan

This is the operational handoff for the approved P5 target. It is intentionally
separate from the 7B general provider-runtime workstream.

> **Revision 2026-07-22 (option B).** The user selected decision option B
> (`reduce_history_depth_target`) in
> [`workflow/tqe-p5-twse-source-contract.json`](../workflow/tqe-p5-twse-source-contract.json),
> superseding option C the same day. Reason: no free official bounded
> three-year bulk source exists, and the per-session MI_INDEX alternative
> conflicts with the TWSE website terms of use (scripted downloads require
> TWSE consent). The three-year retrospective goal is replaced by forward
> accumulation from the official free `STOCK_DAY_ALL` daily snapshot; the
> acceptance checklist below is revised accordingly.

## Target

Admit a point-in-time TWSE EOD history by forward accumulation: capture the
official free `STOCK_DAY_ALL` full-market daily snapshot once per trading day
starting at the activation date, bind an official calendar response in the
same human-approved work-unit, apply only a separately evidenced
corporate-action adjustment, and prove the normalized fixture through offline
P1-P4 replay. Three calendar years of history are reached by accumulation
(target: activation date + 3 years); backfill of 2023-07-20..activation is
deferred until a free official bulk source appears.

## Work packages

| Package | Output | Gate |
| --- | --- | --- |
| P5.0 | Target preflight | Read-only, deterministic, `provider_calls=0` |
| P5.1 | TWSE daily-snapshot source + calendar contract | Exact endpoint, terms, schema, license, version, digest |
| P5.2 | Corporate-action fixture reference | S5 convention, factor, ex-date, `available_at`, source digest |
| P5.3 | Exact work-unit | Named GET purposes, parameters, cutoff, host allowlist, SHA-256 digest |
| P5.4 | External raw evidence + normalized fixture | No credentials/private data; deterministic mapping and digest |
| P5.5 | Coverage/read model | Expected/observed/missing sessions and indicator windows |
| P5.6 | Acceptance replay | Unit tests, LH preflight, P4 closure, dashboard preview/browser gates |

The active draft work-unit shape is recorded at
[`workflow/tqe-p5-forward-accumulation.work-unit.draft.json`](../workflow/tqe-p5-forward-accumulation.work-unit.draft.json).
It is deliberately `draft_not_runnable` until the exact digest is approved.
The earlier drafts
[`workflow/tqe-p5-twse-work-unit.draft.json`](../workflow/tqe-p5-twse-work-unit.draft.json)
and
[`workflow/tqe-p5-twse-work-unit.option-c.draft.json`](../workflow/tqe-p5-twse-work-unit.option-c.draft.json)
are superseded records.

The first source-contract research record is
[`docs/tqe-p5-source-contract-research.md`](tqe-p5-source-contract-research.md).
The machine-readable result is
[`workflow/tqe-p5-twse-source-contract.json`](../workflow/tqe-p5-twse-source-contract.json).
Its status is `source_contract_selected_pending_activation` (option B source
selected; the exact work-unit digest is not yet approved); it does not
authorize a provider call. The independent P5.2 corporate-action admission is
recorded in
[`workflow/tqe-p5-corporate-action-admission.json`](../workflow/tqe-p5-corporate-action-admission.json)
and has passed offline validation. The complete adjusted OHLCV and volume
policy is fixed in
[`workflow/tqe-p5-adjusted-ohlcv-volume-policy.json`](../workflow/tqe-p5-adjusted-ohlcv-volume-policy.json).

## Acceptance checklist

- [ ] ~~TWSE source is an exact official bulk-history endpoint with at least
  the selected three-year coverage.~~ Revised 2026-07-22 (option B): TWSE
  source is the official open-licensed `STOCK_DAY_ALL` daily snapshot,
  captured once per trading day from the activation date; history
  accumulates toward three calendar years instead of starting with them.
- [ ] Official calendar and daily-snapshot capture are bound to the same
  work-unit digest.
- [ ] Activation date is fixed in the approved work-unit; each capture is
  stamped with its own retrieval date, and no backfill before the activation
  date is claimed.
- [ ] Corporate-action fixture is separately approved and point-in-time valid.
- [x] Adjusted OHLCV and volume policy is defined before P5.4.
- [ ] Raw response is caller-owned external evidence; normalized fixture is
  compact, attributed (資料來源：臺灣證券交易所), and digestible.
- [ ] K2/K3 range and coverage output is deterministic and fail-closed.
- [ ] P1-P4 gates pass offline after normalization.
- [ ] Human accepts TWSE before TPEx or any 7B work begins.

## Stop / handoff rule

If P5.1 cannot identify a real official source with the selected semantics,
stop and report `source_contract_blocked`; do not silently substitute another
endpoint or issue an unbounded date loop. Option C (bounded per-session
MI_INDEX capture) was withdrawn on 2026-07-22 over the TWSE terms-of-use
conflict; its artifacts are retained as superseded records and must not be
activated without a new explicit user decision.
