# TQE P6 delayed-feed runtime boundary amendment (proposal)

Status: `proposed_not_active`

This is a **proposal** for the runtime boundary amendment required by
[`docs/tqe-p6-delayed-feed-contract.md`](tqe-p6-delayed-feed-contract.md)
§Runtime boundary amendment requirements. It records the exact boundary text
that activation would add; it does **not** activate the delayed feed, does not
modify the approved P4 boundary, and does not authorize any capture. The
activation mechanism is human approval of this amendment together with the
source contract digest
([`workflow/tqe-p6-delayed-feed-source-contract.json`](../workflow/tqe-p6-delayed-feed-source-contract.json))
and the work-unit digest — amendments, not silent edits.

Until approved, the P4 `deferred` row for "Realtime or delayed provider feed"
remains in force and `python3 scripts/p4_research_closure.py` must keep
passing unchanged.

## Proposed capability-matrix row (replaces the P4 `deferred` delayed row)

| Capability | Proposed status after approval | Boundary |
| --- | --- | --- |
| Delayed provider feed (capability 2, TWSE only) | `active_bounded_human_initiated` | Scheduled, human-initiated, enumerated bounded GET capture per approved work-unit; no persistent connection, no streaming, no unattended poller; one provider and one market per approval; realtime feed (capability 1) stays `deferred_not_approved`. |

## Delay label propagation (the label is part of the data)

- Every read-model row derived from the feed carries: `feed_timestamp`
  (source quote time), `captured_at` (retrieval time), `contractual_delay`
  (from the source contract), and `delay_class: "delayed"`.
- Every UI surface derived from feed data shows an explicit delay/staleness
  label. Delayed data must never be presented as current or realtime; the
  label is part of the data, not decoration.
- The label propagates through normalization, the sidecar read model, and the
  dashboard unchanged; any surface that cannot carry the label must not
  receive feed data (fail-closed).

## Point-in-time semantics (aligned with P5.2)

- A delayed quote is visible to research computations only with its own
  `available_at` (= `captured_at`), consistent with the P5.2 convention
  `available_at <= as_of`; it is never back-dated to look current.
- `retrieved_at` is never used as `available_at` for any other field, and a
  delayed quote never overwrites admitted EOD history.

## Cutoff, staleness, and fail-closed runtime behaviour

- Bounded capture loop only: the session-enumerated GET list, conservative
  serialization delay, and hard session cap recorded in the work-unit;
  reconnect/backoff applies inside one approved run, never as an implicit
  loop.
- Staleness threshold: data older than the contractual delay plus the
  threshold recorded in the work-unit is labelled `stale`, never `current`.
- Feed drop, schema probe failure, or encoding probe failure: the capture is
  rejected fail-closed; partial or unverified bytes are never normalized.
- Feed fresher than its contractual delay (realtime-class): stop; this
  amendment does not cover realtime — do not capture under this capability.

## Consumers unchanged

- Alerts (capability 3) and valuation & analysis (capability 5) continue to
  evaluate only admitted data. Feed data becomes admitted to those consumers
  only through this capability's own evidence chain (contract → hashed
  work-unit → host-egress admission → caller-owned raw evidence →
  repository-owned normalized fixture → offline replay → human acceptance),
  and the delay label must survive into any consumer surface.
- No order route, order command, order UI control, or order-decision surface
  may be fed by feed data; automatic order placement remains `prohibited`.

## Approval and evidence chain

1. Human approval of the source contract digest
   (`workflow/tqe-p6-delayed-feed-source-contract.json`), including the
   terms-of-use/robots review and the independent delayed-data licence review.
2. Human approval of this amendment.
3. Human approval of the exact work-unit digest
   (`workflow/tqe-p6-delayed-feed.work-unit.draft.json`, finalized).
4. Host-egress admission recorded.
5. First human trial capture during market hours proving delay semantics,
   caller-owned raw evidence (sha256, bytes, retrieval timestamp, encoding
   probe).
6. Repository-owned normalized fixtures; deterministic offline tests with no
   network and no wall-clock dependence; offline P1-P4 replay;
   `p4_research_closure.py` passing before and after.
7. Human acceptance recorded in the work-unit acceptance JSON with
   `provider_calls` accounted per approved request.

The current L1/report-only contract remains the authority for all
capabilities not explicitly admitted by this bounded chain.
