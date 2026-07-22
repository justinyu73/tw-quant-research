# TQE P6 paper trading simulation contract (simulation-only first slice)

Status: `superseded_by_user_decision_2026_07_22`

Superseded on 2026-07-22 by human gate owner decision: 「同意能力 5，但我不需要
模擬下單，我要算的是分析和股票價值。」Capability 5 is reshaped as valuation &
analysis; paper trading / simulated order matching returns to
`deferred_not_approved`. The active contract is
[`docs/tqe-p6-valuation-analysis-contract.md`](tqe-p6-valuation-analysis-contract.md).
This document is retained unchanged below for audit history only and
authorizes nothing.

---

Original (superseded) content follows.

Status at drafting: `contract_defined_pending_digest_approval`

This is the activation contract for capability 5 (paper trading / broker
connector) of
[`docs/tqe-p6-deferred-capability-activation-proposal.md`](tqe-p6-deferred-capability-activation-proposal.md),
approved by the human gate owner on 2026-07-22 as the second capability in the
approved activation order 3 → 5 → 2, simulation only.

Scope is strictly the **simulation-only first slice**: hypothetical fills
computed by the local engine against admitted data, presented as
research-only hypothetical performance notes. The **broker read-only
connector is a separate, independent human approval and is out of scope** —
no credential, endpoint, or broker API of any kind is covered here. Automatic
order placement remains `prohibited`; nothing in this contract creates an
order route, order command, or order UI control.

## Simulation spec schema

Schema id: `tqe-paper-trading-sim/v1`. A simulation spec is a JSON object:

| Field | Type | Semantics |
| --- | --- | --- |
| `schema` | string | constant `tqe-paper-trading-sim/v1` |
| `sim_id` | string | caller-assigned unique id within the local store |
| `label` | string | human-readable name shown in the UI |
| `target` | object | exactly one security: `{ "security_id": "<universe security id>" }`; must resolve in the admitted universe |
| `rules` | object | simple deterministic entry/exit rules (see below) |
| `quantity` | object | `{ "shares": int }` fixed share quantity per simulated trade (lot handling explicit in the spec) |
| `cost_model` | object | parameterized fee/tax/slippage assumptions (see below) |
| `created_at` | string | ISO 8601 creation timestamp |

Rules are deliberately minimal for this slice: date- or threshold-based
entry/exit over the single target (e.g. `buy_on_date`, `sell_on_date`, or
`price_threshold` crossing in the style of the in-app alerts condition
types). **This slice does not give the research StrategySpec execution
semantics** — see "Scope decision" below.

Unknown rule types, unknown fields, and targets outside the admitted universe
are rejected at definition time (fail-closed validation).

## Simulation contract (fill model)

- Input data: admitted EOD OHLCV only — the same committed fixtures and
  loopback GET read model admitted under the P4/P5 boundary. No intraday
  data, no provider feed, no live quotes.
- Fill price rule (explicit, deterministic): a simulated order instructed
  after the close of trading day T fills at the **open of the next trading
  day T+1** (`next_trading_day_open`, the default and only fill rule in this
  slice). If the T+1 bar is missing from admitted data, the fill does not
  happen (fail-closed, see below).
- Fill prices use the **raw OHLCV** series (`raw_ohlcv_unchanged` per
  `workflow/tqe-p5-adjusted-ohlcv-volume-policy.json`); the adjusted series
  remains a research indicator surface and is not a cash-flow basis.
- Point-in-time semantics follow the P5.2 convention: only data with
  `available_at <= as_of` is visible to the simulation; corporate-action
  evidence that was not available at `as_of` must not influence a fill.
- Hypothetical fills statement: every fill is hypothetical. The simulation
  produces **no real order instruction** of any kind — no order object, no
  order id, no broker message, no route — only a research record of
  hypothetical trades.

## Cost model (fee / tax / slippage assumptions)

Parameterized, with Taiwan market conventions as documented defaults:

| Parameter | Default | Semantics |
| --- | --- | --- |
| `brokerage_fee_rate` | 0.001425 | TW brokerage fee (0.1425%), applied to buy and sell notional |
| `fee_discount` | 1.0 | multiplicative discount on the brokerage fee |
| `transaction_tax_rate_sell` | 0.003 | TW securities transaction tax (0.3%), sell side only |
| `slippage_bps` | 0 | additive slippage in basis points applied adversely to the fill price |

All parameters are explicit in the spec; there are no hidden defaults inside
the engine. Results must display the parameter set alongside the hypothetical
performance so assumptions are never implicit.

## Input boundary

- Simulation reads **only admitted data** and local fixtures. It must not
  trigger, and must not be able to trigger, any provider call, catch-up
  fetch, or host egress to fill a data gap.
- Evaluation is **deterministic and offline-replayable**: the same admitted
  fixtures and the same spec always produce the same hypothetical trades and
  the same performance numbers, with no network and no wall-clock dependence.

## UI presentation boundary

- Results are presented as **hypothetical performance / research notes**,
  always labelled "hypothetical — research only" with the cost-model
  parameters shown.
- No order-like affordance: no order ticket, no buy/sell button, no position
  sizing control, no broker linkage, no wording that frames a hypothetical
  fill as an instruction or recommendation.
- **No solicitation or performance-promise language**: simulated results must
  never be presented as expected returns, a solicitation, or a promise of
  performance (proposal §5 broker/regulatory risk).
- The StrategySpec remains `not_admitted`; this slice does not evaluate or
  execute strategy specs.
- The P4 audit invariants must keep passing: no `/orders` route in the
  browser surface, no order command in the Tauri command surface.

## Persistence

- Simulation specs and hypothetical results live in session-local local
  state, following the watchlist / in-app alerts style: a flat versioned JSON
  save owned by the local app (e.g. `tqe-paper-trading-sims/v1` storage).
- Specs and results **never leave the local machine**: no cloud sync, no
  telemetry, no export to any provider or broker. Off-machine persistence is
  capability 4 territory and out of scope.

## Order-authority gate

Under this contract the system must not:

- place, amend, or cancel any real order;
- create an order route, order command, or order UI control;
- store, transmit, or reference any broker credential or session;
- generate any artifact shaped like an order instruction (order id, broker
  message format, FIX/REST order payload).

Enforcement: `python3 scripts/p4_research_closure.py` must pass before and
after implementation (it mechanically checks no `/orders` browser route, no
order command in the Tauri surface, GET-only sidecar, research-only
manifest). Any implementation work-unit must include this audit in its
verification list, and the acceptance evidence must record its result. Any
future extension of the audit script to cover the simulation surface is an
amendment, approved like any other — not a silent edit.

## Credential boundary

- The simulation-only slice requires **no credentials** and stores none.
- Any broker connector, including read-only positions/balances access, is a
  **separate, subsequent human approval** with its own credential boundary
  (storage, scope, revocation; read-only scopes only), as recorded in the
  proposal §5 two-approval rule. No combined approval exists or is implied.

## Test and evidence requirements

- Deterministic fixture tests: committed fixtures drive simulation tests
  asserting exact hypothetical trades, fill prices (T+1 open rule), fee/tax
  arithmetic, and PIT visibility behaviour, with no network and no
  wall-clock dependence.
- Tests assert that no order route/command/credential code path exists or is
  invoked.
- Acceptance JSON per work-unit records the simulation scope
  (`mode: "simulation_only"`, broker connector listed as unapproved),
  following the `workflow/evidence/*.acceptance.json` style.
- The activation evidence chain remains: exact contract (this document) →
  hashed work-unit → human digest approval → offline replay → human
  acceptance. No host-egress admission is expected (zero network).

## Fail-closed rules

- Invalid spec (bad schema, unknown rule/field, target outside the admitted
  universe, non-positive quantity, negative fee parameters): reject at
  definition time; do not simulate.
- Required bar missing from admitted data (no T+1 open, gap in the series):
  the fill does not happen; the simulation records a research-only
  "no fill — data unavailable" state and never fetches from a provider.
- Data not yet available under PIT (`available_at > as_of`): invisible to the
  simulation; using it is a contract violation.
- Any ambiguity between a hypothetical fill and a real order: the feature
  degrades to inert (no simulated trade) rather than risk an order-like
  artifact.
- Any request for credentials or broker endpoints: rejected by construction —
  no such field exists in the schema.

## Scope decision (why single-security simple rules, not StrategySpec execution)

This slice simulates simple explicit rules over a single admitted security
rather than executing the research StrategySpec, because:

- the P4 boundary records StrategySpec as `visible, not admitted` with "no
  execution semantics"; giving it execution semantics is a promotion that
  requires its own contract and human gate, and must not happen implicitly
  through a paper-trading slice;
- single-security, explicit-rule simulation is the minimal surface that
  exercises the fill model, cost model, and PIT semantics deterministically,
  keeping the audit and evidence chain small and reviewable;
- it eliminates scope creep toward a general strategy-execution engine, which
  is the proposal §5's named largest risk for the paper-trading path.

## Cannot-claim list

Until separately approved and evidenced, no work under this contract may claim:

- broker connector (read-only or otherwise) implemented or approved;
- order placement, amendment, cancellation, routing, or any execution
  capability, real or live;
- credentials stored, transmitted, or used for any purpose;
- StrategySpec admitted or executed;
- intraday, delayed, or realtime data used in simulation;
- provider calls or host egress of any kind;
- simulated results presented as a solicitation, recommendation, or
  performance promise;
- persistence of specs or results off the local machine;
- activation of capabilities 1, 2, 4, or 6;
- product acceptance or automatic promotion to the next capability.
