# TQE P5 execution target and acceptance specification

P5 is approved as the next execution target for TWSE historical EOD admission.
The active slice is TWSE; TPEx follows only after the TWSE slice passes its
acceptance gate. General provider runtime (the former 7B choice) is a separate
workstream and is not activated by P5.

## Human decision record

| Choice | Selected decision | Execution meaning |
| --- | --- | --- |
| 1A | Official bulk history source | Freeze an exact official TWSE bulk-history endpoint before capture. |
| 2A | TWSE first | The first work-unit slice is TWSE; TPEx is a subsequent bounded slice. |
| 3A | Three years to `2026-07-19` | `2023-07-20` through `2026-07-19`, with `as_of=2026-07-19T23:59:59+08:00`. |
| 4B | Calendar and EOD in one work-unit | The work-unit must bind at least two named GETs: bulk history and official calendar. |
| 5B | Separate corporate-action fixture | Adjustment evidence is a separately approved input; it is not silently fetched or inferred. |
| 6A | Raw external, normalized in repo | Raw response remains caller-owned evidence; normalized fixture, manifest, and digest are repository artifacts. |
| 7B | Separate general provider runtime | Deferred to an independent contract/workstream; excluded from P5. |
| 8A | Host-egress exact work-unit | Only the exact human-approved work-unit may cross the provider boundary. |

## Execution goals

### P5-G1 — Exact TWSE bulk source contract

Freeze the official endpoint, terms, attribution, response shape, date coverage,
and request digest. The existing `twse_daily_close` daily endpoint is not
automatically treated as a three-year bulk source; if it cannot provide the
selected range, the work stops before provider execution.

### P5-G2 — Point-in-time history

Admit only records in `2023-07-20` through `2026-07-19`, visible at or before
`2026-07-19T23:59:59+08:00`. `trading_date`, `available_at`, `retrieved_at`,
and `as_of` remain separate fields.

### P5-G3 — Official calendar and coverage

Capture an official calendar response in the same work-unit as the bulk EOD
response. Pin its version and SHA-256 digest. The read model must report
expected sessions, observed sessions, missing sessions, calendar status, and
indicator readiness without inferring or filling dates.

### P5-G4 — Adjusted OHLCV with separate evidence

Use the existing S5 corporate-action convention only after a separate,
preapproved corporate-action fixture supplies factor, ex-date, available-at,
source, and digest provenance. Raw OHLCV remains unchanged; adjusted values
are derived and separately labelled. Missing or ambiguous evidence is
`unadmitted`.

### P5-G5 — Replayable evidence

Keep raw provider evidence outside the repository under the caller-owned
evidence path. Commit only the compact normalized fixture, manifest, source
metadata, calendar reference, corporate-action reference, and SHA-256 digests.

### P5-G6 — Offline acceptance

Feed the normalized fixture into the existing K2/K3 read model, then replay P1
through P4 gates with `network=false`. No dashboard, provider, alert, broker,
or order capability is added by this slice.

## Execution sequence

1. Run `python3 scripts/p5_execution_target.py`.
2. Freeze the exact TWSE bulk-history and calendar source contracts.
3. Validate the separately approved corporate-action fixture.
4. Freeze the exact work-unit JSON and SHA-256 digest.
5. Obtain host-egress admission for the named bulk-history and calendar GETs.
6. Capture raw evidence externally and normalize the TWSE fixture into the repo.
7. Build the range/coverage read model and adjusted-value evidence.
8. Replay P1-P4 offline gates.
9. Stop for human acceptance before TPEx or any provider-runtime expansion.

## Hard stops

- No exact official bulk endpoint or insufficient three-year coverage.
- Calendar and bulk history are not bound to the same work-unit digest.
- `available_at` is replaced by retrieval time or post-`as_of` data appears.
- Adjustment factor convention, corporate-action source, or point-in-time
  visibility is ambiguous.
- Raw evidence contains credentials, private exports, or unbounded snapshots.
- Work-unit request budget exceeds its named purposes.
- US data, general provider runtime, realtime, alerts, cloud sync, paper
  trading, broker access, or order placement enters the slice.

## Current state

The workflow is `source_contract_blocked`, not provider-active. P5.1 completed
the fail-closed source review and recorded its result in
[`workflow/tqe-p5-twse-source-contract.json`](../workflow/tqe-p5-twse-source-contract.json).
P5.2 independently passed the corporate-action fixture admission. The overall
workflow remains blocked by P5.1 until an official bounded three-year bulk
artifact or endpoint is supplied and approved; no latest-day substitution or
implicit date loop is allowed. The complete adjusted OHLCV and volume policy is
already defined in
[`workflow/tqe-p5-adjusted-ohlcv-volume-policy.json`](../workflow/tqe-p5-adjusted-ohlcv-volume-policy.json),
so it is no longer an internal P5.4 design blocker.
