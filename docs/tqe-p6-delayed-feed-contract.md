# TQE P6 delayed provider feed contract

Status: `contract_defined_pending_digest_approval`

This is the activation contract for capability 2 (delayed provider feed) of
[`docs/tqe-p6-deferred-capability-activation-proposal.md`](tqe-p6-deferred-capability-activation-proposal.md),
third in the approved activation order 3 → 5 → 2. It is independent of the
realtime feed (capability 1), which remains `deferred_not_approved`;
approval of this contract must not imply approval of realtime.

Scope: **scheduled, human-initiated bounded capture** of delayed quotes or
post-close snapshots into the research read model. Following the P5.1
option-C pattern, feed capture is an explicitly bounded, enumerated,
human-approved request loop — exact endpoint, request budget, per-run digest
— **not** a persistent connection, not streaming, and not an unattended
poller. Automatic order placement remains `prohibited`; nothing in this
contract creates an order route, order command, order UI control, or any
order-decision surface.

## Data-source contract requirements (P5.1 style)

No capture may run until a source contract records, for the chosen endpoint:

- exact endpoint URL, HTTP method, and query parameters;
- **delay definition**: the contractual delay of the feed (see delay
  definition below), plus the per-field freshness semantics proven by trial
  capture — never assumed;
- update cadence (how often the source changes during a trading session and
  after close);
- response schema (content type, encoding, full field list);
- coverage (which securities/markets one bounded response covers);
- licence and redistribution terms for delayed data, reviewed independently
  of the EOD bulk terms;
- versioned digest policy (sha256 per captured response, bytes, retrieval
  timestamp, bound to the same work-unit);
- request budget: named, bounded GETs per capture run, serialized with a
  conservative delay and a hard session cap.

### Candidate endpoints (read-only verification, 2026-07-22)

| Candidate | Endpoint | Verification result |
| --- | --- | --- |
| `twse_mis_getstockinfo` (primary) | `GET https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw` | Reachable, HTTP 200 JSON, no auth. Observed fields include open/high/low/last (`o/h/l/z`), previous close (`y`), volume (`v`), quote date/time (`d`/`t`), five-level bid/ask (`a/b/f/g`), and a `userDelay` field. The exact delay and per-field freshness semantics are **not yet proven** — they must be established by the first human trial capture during market hours (quote timestamp vs server `queryTime.sysTime`), not assumed. |
| `twse_legacy_mi_index_csv` (post-close snapshot alternative) | `GET https://www.twse.com.tw/exchangeReport/MI_INDEX?response=csv&date=YYYYMMDD&type=ALL` | Already assessed in `workflow/tqe-p5-twse-source-contract.json` (`option_c_endpoint_assessment`): full-market daily closing CSV, trial capture recorded. Satisfies the "end-of-interval snapshot" reading of this capability only; it carries no intraday freshness. |
| `tpex_delayed_info` | `https://www.tpex.org.tw/zh-tw/service/data/product/delay.html` | Licensing/product page for TPEx delayed information; no free public endpoint located. Not admitted. |
| `twse_openapi` catalogue | `https://openapi.twse.com.tw/v1/swagger.json` | Fetched 2026-07-22: 143 paths, **no delayed-quote endpoint exists**; `exchangeReport/MI_INDEX20` is the daily top-20-by-volume report, not a delay feed. |
| `twse_mis_fibest` (retired) | `https://mis.twse.com.tw/stock/fibest.jsp?stock=2330` | HTTP 404 on 2026-07-22; the legacy page endpoint is retired. Recorded so no work-unit resurrects it. |

### Delay definition (regulatory anchor)

The TWSE 交易資訊使用管理辦法 defines 延遲資訊 (delayed information) as
market transaction information delayed by **twenty minutes or more** relative
to realtime
(`https://twse-regulation.twse.com.tw/m/LawContent.aspx?FID=FL007129`,
located 2026-07-22). The source contract must record the feed's delay in
that frame, and the trial capture must demonstrate it empirically; if the
chosen endpoint turns out to be fresher than its labelled delay, the feed
must be treated as realtime-class and this contract does not cover it
(capability 1 territory — stop, do not capture).

## Runtime boundary amendment requirements

A runtime amendment (new matrix row replacing the P4 `deferred` entry for the
delayed row) must define, before activation:

- **Delay label propagation**: every read-model row and every UI surface
  derived from the feed carries an explicit delay/staleness label (feed
  timestamp, capture timestamp, and contractual delay). Delayed data must
  never be presented as current or realtime; the label is part of the data,
  not decoration.
- **PIT semantics**: `available_at` semantics consistent with the P5.2
  point-in-time convention (`available_at <= as_of`); a delayed quote is
  visible to research computations only with its own availability timestamp,
  never back-dated to look current.
- **Cutoff and staleness**: reconnect/backoff policy for the bounded capture
  loop, a staleness threshold after which data is labelled stale rather than
  current, and fail-closed behaviour when the feed drops (see fail-closed).
- **Consumers unchanged**: alerts (capability 3) and valuation & analysis
  (capability 5) continue to evaluate only admitted data. Feed data becomes
  admitted to those consumers only through this capability's own evidence
  chain; the delayed label must survive into any consumer surface.

## Risks and mitigations

- **Licence terms for delayed data differ from realtime and from EOD bulk**;
  approval of the P5 EOD slice does not extend to delayed intraday data.
  Mitigation: independent licence review recorded in the source contract
  before any capture; one provider and one market per approval.
- **Misuse risk**: delayed quotes must not feed anything resembling an order
  decision surface. Mitigation: the research-only boundary still applies;
  the P4 audit must keep passing; the UI shows research labels only; no
  order-like artifact may be produced from feed data.
- **Operational**: capture failures, clock skew, and gap detection can
  silently corrupt indicators. Mitigation: staleness is always visible, never
  assumed; deterministic replay against captured fixtures is the only
  evaluation path.
- **Undocumented endpoint risk** (`twse_mis_getstockinfo` has no published
  API contract): terms-of-use review and robots policy review are
  pre-activation requirements, and the schema must be probed and recorded at
  trial capture, P5.1 style.

## Test and evidence requirements

- First human trial capture: bounded, human-approved GETs with caller-owned
  raw evidence (sha256, bytes, retrieval timestamp, content type, encoding),
  proving the delay semantics during market hours.
- Deterministic normalization of captured responses into the read model with
  the delay label; repository-owned normalized fixtures.
- Offline P1-P4 replay against captured data; deterministic fixture tests
  with no network and no wall-clock dependence.
- A work-unit acceptance JSON with `provider_calls` accounted per approved
  request, delay-labelling evidence, and the runtime amendment recorded.
- `python3 scripts/p4_research_closure.py` must keep passing throughout;
  amendments, not silent edits, are the activation mechanism.

## Fail-closed rules

- No approved source contract digest and work-unit digest: no capture, no
  host egress.
- Feed response fails schema probe or encoding probe at capture: reject the
  capture; do not normalize partial or unverified bytes.
- Feed fresher than its contractual delay (realtime-class): stop; this
  contract does not cover realtime — do not capture under this capability.
- Feed drops or exceeds the staleness threshold: label data stale; never
  present the last value as current.
- Any consumer surface that cannot carry the delay label: do not admit feed
  data to that surface.
- Any ambiguity between a delayed quote and an order decision input: the
  feature degrades to inert rather than risk an order-like surface.

## Cannot-claim list

Until separately approved and evidenced, no work under this contract may claim:

- realtime or streaming data of any kind (capability 1 stays
  `deferred_not_approved`);
- a persistent connection, unattended poller, or implicit unbounded request
  loop;
- capture executed before human approval of the source contract digest and
  the work-unit digest, with host-egress admission;
- delayed data presented as current, or any surface without a delay label;
- order placement, simulated order matching, or any order-decision surface
  fed by feed data;
- redistribution of feed data beyond the local machine;
- licence terms inherited from the P5 EOD bulk slice;
- activation of capabilities 1, 4, or 6;
- product acceptance or automatic promotion.
