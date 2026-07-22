# TQE P6 deferred-capability activation proposal

Status: `approved_activation_order_3_5_2`

## Approval record

- Approved by: user (human gate owner)
- Approval date: 2026-07-22
- Approved activation order: 3 (in-app alerts) → 5 (paper trading
  simulation) → 2 (delayed provider feed), executed strictly in sequence;
  each capability still follows the full evidence chain (contract → hashed
  work-unit → egress admission where applicable → offline replay → human
  acceptance) before activation.
- Capability 3 is approved for contract definition now:
  [`docs/tqe-p6-in-app-alerts-contract.md`](tqe-p6-in-app-alerts-contract.md)
  is the activation contract, scoped strictly to in-app alerts with no
  external delivery channel.
- Capabilities 5 and 2 are approved as `approved_next` (in that order); their
  contracts are not drafted yet and will be proposed only after capability 3
  completes its evidence chain.
- Capabilities 1 (realtime feed), 4 (news/social/cloud workspace), and 6
  (7B general provider runtime) are deferred: not approved, not activated,
  and no work may begin on them under this approval.
- Automatic order placement remains `prohibited`. This approval does not
  create, and no derived contract or work-unit may create, an order route,
  order command, or order UI control.

This document is an activation proposal for the capabilities recorded as
`deferred` in [`docs/tqe-p4-runtime-boundary.md`](tqe-p4-runtime-boundary.md),
plus the 7B general provider runtime recorded as
`provider_capability_not_active` in
[`docs/tqe-p5-phase-driver-contract-amendment.md`](tqe-p5-phase-driver-contract-amendment.md).
It proposes per-capability prerequisite contracts, risks, and approval
conditions. It does not implement, enable, or authorize any capability, and it
does not modify the approved P4 boundary.

Out of scope: automatic order placement remains `prohibited`. No proposal,
amendment, or work-unit derived from this document may create an order route,
order command, or order UI control. Requesting that prohibition be lifted is
explicitly not part of this proposal.

## Scope and capability inventory

| # | Capability | P4/P5 recorded status | Proposed next gate | Approval status (2026-07-22) |
| --- | --- | --- | --- | --- |
| 1 | Realtime provider feed | deferred (P4: "Realtime or delayed provider feed") | data-source contract + runtime amendment | `deferred_not_approved` |
| 2 | Delayed provider feed | deferred (same P4 row, split for separate approval) | data-source contract + runtime amendment | `approved_next` (3rd in sequence) |
| 3 | Alerts / notifications | deferred (P4) | event + delivery contract | `approved_contract_defined` (1st in sequence; in-app only) |
| 4 | News / social / cloud workspace | deferred (P4) | source, privacy, persistence approval | `deferred_not_approved` |
| 5 | Paper trading / broker connector → **valuation & analysis** (reshaped 2026-07-22) | deferred (P4) | credential + order-authority gate | `contract_defined_pending_digest_approval` (2nd in sequence; valuation & analysis; paper trading returned to `deferred_not_approved`) |
| 6 | 7B general provider runtime | `provider_capability_not_active` (P5 amendment) | separate contract, capability matrix, acceptance package | `deferred_not_approved` |

Realtime and delayed feeds are one row in the P4 capability matrix but are
split here because they carry different latency, licensing, and staleness
contracts; approval of one must not imply approval of the other.

## 1. Realtime provider feed

- Activation status (2026-07-22 human gate): `deferred_not_approved` — not
  approved, not activated; no contract or work-unit may be started.
- Capability description: streaming or polling delivery of intraday quotes
  (and optionally trades) from a named provider into the research read model,
  with the loopback GET-only transport extended under an explicit contract.
- Why deferred today: the P4 boundary commits the research surface to
  committed fixtures and loopback GET only; no provider has an approved
  data-source contract, and realtime redistribution/licence terms for TWSE/TPEx
  data are unresolved.
- Prerequisite contracts:
  - Data-source contract in the P5.1 style: exact endpoint, protocol
    (WebSocket/SSE/poll), authentication method, schema, coverage, licence and
    redistribution terms, rate limits, and a versioned digest.
  - Runtime boundary amendment: a new matrix row replacing the P4 `deferred`
    entry, defining reconnect/backoff policy, clock and staleness labelling,
    and fail-closed behaviour when the feed drops.
  - Test and evidence: recorded fixture capture with caller-owned raw
    evidence, deterministic normalization into the K-line read model, offline
    P1-P4 replay against captured data, and a work-unit acceptance JSON with
    `provider_calls` accounted per approved request.
- Risks:
  - Licence/redistribution: realtime Taiwan exchange data is fee-licensed;
    redistribution or display terms may forbid the intended use. Legal review
    required before any capture.
  - Operational: reconnect storms, gap detection, and clock skew can silently
    corrupt indicators; staleness must be visible, not assumed.
- Approval conditions / human gate: human approval of the exact source
  contract digest, the runtime amendment, and a bounded capture work-unit
  before host egress; human acceptance replay after capture. One provider and
  one market per approval.

## 2. Delayed provider feed

- Activation status (2026-07-22 human gate): `approved_next`, third in the
  approved sequence (after capabilities 3 and 5). Its contract is not drafted
  yet; drafting begins only after capability 3 completes its evidence chain.
- Capability description: scheduled pull of delayed (e.g. 15-20 minute) quotes
  or end-of-interval snapshots, materially the same shape as realtime but with
  a contractual delay and no streaming session.
- Why deferred today: same P4 row as realtime; no approved source contract,
  and the P5 workstream deliberately admitted only bulk EOD history, not any
  intraday or delayed feed.
- Prerequisite contracts:
  - Data-source contract: exact endpoint, delay definition, update cadence,
    schema, coverage, terms, and digest.
  - Runtime boundary amendment: delay label propagation into the UI and read
    model so delayed data is never presented as current; cutoff and
    `available_at` semantics consistent with the P5.2 point-in-time
    convention.
  - Test and evidence: same evidence chain as realtime (raw caller-owned,
    normalized repository-owned, offline replay, work-unit digest approval).
- Risks:
  - Licence terms for delayed data differ from realtime and from EOD bulk;
    approval of the P5 EOD slice does not extend to delayed intraday data.
  - Misuse risk: delayed quotes must not feed anything resembling an order
    decision surface; the research-only boundary still applies.
- Approval conditions / human gate: independent of realtime; human approval of
  its own contract digest and amendment. May be approved before realtime as a
  lower-risk stepping stone, but only by explicit human decision, not by
  default.

## 3. Alerts / notifications

- Activation status (2026-07-22 human gate): `approved_contract_defined`,
  first in the approved sequence. The activation contract is
  [`docs/tqe-p6-in-app-alerts-contract.md`](tqe-p6-in-app-alerts-contract.md),
  scoped strictly to in-app alerts; every external delivery channel (email,
  webhook, etc.) remains unapproved and requires its own separate human gate.
- Capability description: user-defined conditions over the read model (price,
  indicator, or event thresholds) that produce in-app and/or externally
  delivered notifications.
- Why deferred today: P4 requires a separate event and delivery contract; the
  current surface is session-local with no event bus, no persistence for alert
  definitions beyond flat v1 watchlist saves, and no delivery channel.
- Prerequisite contracts:
  - Event contract: alert definition schema, evaluation point (local engine
    only, evaluated against admitted data), dedup/expiry semantics.
  - Delivery contract: named channels (in-app first; any external channel such
    as email or webhook is a separate approval), credential handling for each
    channel, and rate limits.
  - Persistence amendment: where alert definitions live, with privacy review
    if they leave the local machine.
  - Test and evidence: deterministic local evaluation tests against fixtures,
    delivery disabled or loopback-stubbed in tests, acceptance JSON recording
    channel scope.
- Risks:
  - External delivery is an egress channel; it must pass the same host-egress
    admission as any provider call.
  - Alert fatigue and false positives degrade trust in the research surface;
    evaluation must be deterministic and replayable.
- Approval conditions / human gate: in-app-only alerts may be proposed as a
  first slice; each external delivery channel is a separate human approval
  with its own credential boundary.

## 4. News / social / cloud workspace

- Activation status (2026-07-22 human gate): `deferred_not_approved` — not
  approved, not activated; no contract or work-unit may be started.
- Capability description: ingestion of news or social sources linked to
  universe securities, and/or synchronization of workspace state (watchlists,
  drawings, specs) to a cloud backend.
- Why deferred today: P4 requires separate source, privacy, and persistence
  approval; the current design is deliberately session-local with no cloud
  sync, and no source contract or privacy review exists.
- Prerequisite contracts:
  - Source contract per feed: exact endpoints, terms, licence, update
    cadence, and digest, in the P5.1 style.
  - Privacy contract: what user data (watchlists, drawings, identifiers)
    leaves the machine, where it is stored, retention, and deletion.
  - Persistence contract: storage backend, conflict policy, and
    migration path from the current session-local state.
  - Test and evidence: fixtures with no personal data, offline replay, and a
    privacy checklist signed off before any egress.
- Risks:
  - Privacy/regulatory: syncing user research state to a cloud backend may
    trigger personal-data obligations; social content raises copyright and
    terms-of-service exposure.
  - Content integrity: unvetted social sources can inject misleading signals
    into research; provenance labelling is mandatory.
- Approval conditions / human gate: news ingestion and cloud sync are separate
  approvals. Cloud sync additionally requires the privacy contract to be
  human-approved before any endpoint is contacted.

## 5. Paper trading / broker connector → reshaped: valuation & analysis

- Activation status (2026-07-22 human gate, updated same day):
  `contract_defined_pending_digest_approval` as **valuation & analysis**,
  second in the approved sequence (after capability 3). The owner decided on
  2026-07-22: 「同意能力 5，但我不需要模擬下單，我要算的是分析和股票價值。」
  - Active contract:
    [`docs/tqe-p6-valuation-analysis-contract.md`](tqe-p6-valuation-analysis-contract.md)
    (fair value worksheet with explicit user-supplied assumptions +
    price/volume indicators over admitted EOD data).
  - Active work-unit draft: `workflow/tqe-p6-valuation-analysis.work-unit.draft.json`.
  - **Paper trading / simulated order matching is returned to
    `deferred_not_approved`.** The earlier draft
    [`docs/tqe-p6-paper-trading-simulation-contract.md`](tqe-p6-paper-trading-simulation-contract.md)
    is marked `superseded_by_user_decision_2026_07_22` and retained for audit
    history only.
  - The broker read-only connector remains a separate, independent approval
    and is not covered by either contract.
- Capability description (reshaped): deterministic valuation and analysis
  computation over admitted EOD price/volume data — a fair value worksheet
  driven by explicit user-supplied assumptions (labelled `draft`, never
  official data or consensus) plus price/volume indicators (z-score,
  percentile, MA deviation). Original P4 description, retained for the
  record: simulated order execution against admitted market data for strategy
  evaluation, and/or a read-capable broker connector for positions and
  balances. This is simulation and read-only inspection only.
- Why deferred today: P4 requires a separate credential and order-authority
  gate; no credential boundary exists, and the StrategySpec remains
  `not_admitted` with no execution semantics.
- Prerequisite contracts:
  - Simulation contract: fill model, fee/slippage assumptions, data inputs,
    and an explicit statement that fills are hypothetical.
  - Credential boundary: storage, scope, and revocation for any broker API
    key; read-only scopes only; no order-capable credential may be stored
    under this proposal.
  - Order-authority gate: a written, human-approved statement of what the
    connector may not do (place, amend, or cancel real orders), enforced in
    the command surface the way the P4 audit enforces GET-only sidecar access.
  - Test and evidence: deterministic simulation tests against fixtures,
    audit-script extension proving no order route exists, acceptance JSON.
- Risks:
  - Broker/regulatory: connecting to a broker, even read-only, may fall under
    the broker's API agreement and local regulation; terms review is required.
    Paper-trading results must never be presented as a solicitation or
    performance promise.
  - Scope creep: the largest risk is a paper-trading path drifting toward real
    order capability. Automatic order placement stays `prohibited`; this
    proposal does not weaken that.
- Approval conditions / human gate: two independent human approvals —
  simulation-only first, broker read-only connector second, each with its own
  credential boundary and audit evidence. No combined approval.

## 6. 7B general provider runtime

- Activation status (2026-07-22 human gate): `deferred_not_approved` — not
  approved, not activated; no contract or work-unit may be started.
- Capability description: the general provider runtime workstream selected as
  7B — a reusable runtime for binding provider sources beyond the single
  approved P5 TWSE slice.
- Why not active today: the P5 amendment records it as
  `provider_capability_not_active` and states it requires a separate contract,
  capability matrix, credential boundary, egress policy, and acceptance
  package; no P5 file or work-unit may promote it implicitly.
- Prerequisite contracts:
  - 7B contract and capability matrix: which provider classes are in scope
    (EOD bulk, calendar, corporate actions as fetchable sources, intraday),
    each with its own data-source contract.
  - Credential boundary and egress policy: host allowlist, credential storage,
    rate limits, and per-provider admission, extending the P5.3 work-unit
    pattern.
  - Acceptance package: per-provider acceptance JSONs plus a runtime-level
    acceptance replaying offline P1-P4 gates.
  - Test and evidence: same evidence chain as P5 (raw caller-owned, normalized
    repository-owned, digest-approved work units, offline replay).
- Risks:
  - A general runtime multiplies licence, ToS, and egress surface; each
    provider must be admitted individually even after the runtime exists.
  - Design risk of over-generalizing before a second real source is admitted;
    the runtime should be shaped by the P5 TWSE slice plus one additional
    admitted source, not designed abstractly.
- Approval conditions / human gate: human approval of the 7B contract,
  capability matrix, and acceptance package before any 7B work-unit is
  created; per-provider human gates remain in force after the runtime is
  approved.

## Cross-cutting approval rules

- Each capability above is an independent human gate; approval of one never
  implies approval of another, matching the P4 promotion rule.
- Every activation must follow the established evidence chain: exact contract,
  hashed work-unit, host-egress admission where applicable, caller-owned raw
  evidence, repository-owned normalized evidence, offline P1-P4 replay, and
  human acceptance.
- The P4 audit command (`python3 scripts/p4_research_closure.py`) must keep
  passing until the corresponding amendment is approved; amendments, not
  silent edits to the boundary, are the activation mechanism.
- Automatic order placement remains `prohibited` under every capability in
  this proposal.
