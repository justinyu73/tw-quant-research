# TQE P6 valuation & analysis contract

Status: `contract_defined_pending_digest_approval`

This is the activation contract for capability 5 of
[`docs/tqe-p6-deferred-capability-activation-proposal.md`](tqe-p6-deferred-capability-activation-proposal.md),
**reshaped by the human gate owner on 2026-07-22**. The owner's decision, in
their words: 「同意能力 5，但我不需要模擬下單，我要算的是分析和股票價值。」
Capability 5 is therefore **valuation & analysis computation**, not paper
trading. Paper trading / simulated order matching is returned to
`deferred_not_approved`, and the broker read-only connector remains a
separate, unapproved gate. Automatic order placement stays `prohibited`;
nothing in this contract creates an order route, order command, order UI
control, or any simulated order artifact.

This contract supersedes
[`docs/tqe-p6-paper-trading-simulation-contract.md`](tqe-p6-paper-trading-simulation-contract.md)
(kept for audit history, marked `superseded_by_user_decision_2026_07_22`).

## Scope layering (honest data reality)

The only admitted data today is EOD OHLCV (price/volume). Official
fundamental fields (EPS, ROE, monthly revenue, etc.) remain
`defined_pending_source_admission` (C1, source not admitted). The scope is
layered accordingly:

**In this slice:**

- Price/volume analysis computed from admitted EOD data: z-score, historical
  percentile, and moving-average deviation (conventions below).
- **Fair value worksheet**: the user manually enters assumptions (estimated
  EPS, target PE, dividend, growth rate, discount rate, safety margin). Every
  manual input is labelled `draft` / `user_supplied_assumption`; the engine
  computes a fair-value range and compares it with the current admitted
  price. No manual input may be presented as official data, market
  consensus, or an official forward estimate.

**Not in this slice:**

- Automatic population of official fundamental fields (blocked on C1 source
  admission; fields stay `unavailable` per
  `workflow/tqr-unavailable-field-contracts.json`).
- Any order placement or simulated order matching (paper trading returned to
  `deferred_not_approved`).
- Any investment advice, recommendation, solicitation, or performance
  promise.
- Forward EPS / forward PE from any estimate or consensus source (remains
  `none_admitted_in_this_phase`).

## Fair value worksheet

Schema id: `tqe-fair-value-worksheet/v1`. A worksheet is a JSON object:

| Field | Type | Semantics |
| --- | --- | --- |
| `schema` | string | constant `tqe-fair-value-worksheet/v1` |
| `worksheet_id` | string | caller-assigned unique id within the local store |
| `label` | string | human-readable name |
| `target` | object | exactly one security: `{ "security_id": "<universe security id>" }`; must resolve in the admitted universe |
| `model` | object | one valuation model with explicit parameters (below) |
| `safety_margin` | number | fraction in `[0, 1)`; defines the buy-zone discount against fair value |
| `assumption_notes` | string | free-text user note recording why the assumptions were chosen |
| `created_at` | string | ISO 8601 creation timestamp |

Every worksheet must display, per the TQR spec (`fair_value_worksheet`
contract, spec lines 98-100): EPS source (`user_supplied_assumption` in this
slice), PE source (`user_supplied_assumption`), safety margin, formula
version (`tqe-fair-value/v1`), and data status (`draft`).

### Valuation models (all deterministic, all parameters explicit)

Exactly one model per worksheet, discriminated by `model.type`:

1. **本益比法 `pe_multiple`**
   - Inputs: `eps` (user-supplied, TWD per share), `target_pe` (user-supplied).
   - Formula: `FV = eps × target_pe`.
2. **股利折價簡式 `dividend_discount_simple`**（Gordon growth 簡式）
   - Inputs: `dps` (user-supplied annual dividend per share), `growth_rate g`
     (user-supplied), `discount_rate r` (user-supplied).
   - Formula: `FV = dps × (1 + g) / (r − g)`, valid only when `r > g > -1`;
     otherwise rejected at definition time (fail-closed).
3. **成長調整本益比 `growth_adjusted_pe`**（PEG 型）
   - Inputs: `eps` (user-supplied), `growth_pct` (user-supplied, percent),
     `peg` (user-supplied).
   - Formula: `FV = eps × (growth_pct × peg)`; rejected when
     `growth_pct × peg <= 0`.

Derived outputs per worksheet:

- `fair_value`: the computed FV above.
- `buy_zone_ceiling = fair_value × (1 − safety_margin)`.
- `current_price`: latest admitted close of the target (raw OHLCV basis), with
  its `as_of` date shown.
- `comparison`: current price vs fair value and vs buy-zone ceiling
  (above / within / below), plus the percentage gap. This is a research
  comparison only, never a recommendation.

Unknown model types, missing or non-positive parameters, violated domain
constraints (`r <= g`, non-finite results), and targets outside the admitted
universe are rejected at definition time — never silently clamped or
estimated.

## Price/volume analysis indicators

Computed locally from admitted EOD data only, aligned with the TQR spec
vocabulary and the `tqr-draft/zscore-computed-field` contract. All indicators
record their parameter set alongside the result.

1. **Z-score** — `(price − N-period mean) / N-period standard deviation`
   (spec lines 85-88). Recorded conventions for this slice:
   - `period N`: explicit integer parameter (e.g. 20, 60), recorded in the
     result;
   - `price basis`: raw `close` (the only current price basis per the
     adjusted-close contract);
   - `population/sample`: **population** standard deviation (divide by N),
     recorded in the result.
2. **歷史百分位 `price_percentile`** — rank of the latest admitted close
   within the trailing N-period close window, expressed as a percentage in
   `[0, 100]`; `period N` explicit and recorded.
3. **均線乖離 `ma_deviation`** — `close / SMA_N(close) − 1`, expressed as a
   fraction; `period N` explicit and recorded.

Insufficient admitted history for the requested period yields a research-only
"insufficient data" state, never an extrapolation or a fetch.

## Input boundary and labelling rules

- **Admitted data**: EOD OHLCV from committed fixtures / loopback GET read
  model. Labelled with source and `as_of`.
- **User-supplied assumptions**: every manual input (EPS, PE, DPS, growth,
  discount rate, safety margin) is labelled `draft` /
  `user_supplied_assumption` at entry, in storage, and in every rendered
  output. It must never be represented as official data, market consensus, or
  an official forward estimate (TQR spec lines 98-100).
- Point-in-time semantics follow the P5.2 convention (`available_at <= as_of`)
  for the admitted price data.
- The engine must not fetch, estimate, or back-fill any fundamental input;
  there is no code path from a worksheet to a provider.

## UI presentation boundary

- All outputs are research analysis: fair-value worksheets and indicator
  panels labelled "research only — user assumptions", with assumption source
  and data status visible wherever a number appears.
- No order-like affordance of any kind: no order ticket, no buy/sell button,
  no simulated-order control, no position sizing.
- No investment-advice, solicitation, or performance-promise language; a
  worksheet comparison ("price below buy-zone ceiling") is a research note,
  never a recommendation.
- StrategySpec remains `not_admitted`; this slice does not evaluate or
  execute strategy specs.
- P4 audit invariants must keep passing: no `/orders` route in the browser
  surface, no order command in the Tauri command surface.

## Persistence

- Worksheets and indicator settings live in session-local local state,
  following the watchlist / in-app alerts style: flat versioned JSON owned by
  the local app (e.g. `tqe-fair-value-worksheets/v1` storage).
- Nothing leaves the local machine: no cloud sync, no telemetry, no export.
  Off-machine persistence is capability 4 territory and out of scope.

## Test and evidence requirements

- Deterministic fixture tests: committed fixtures drive indicator tests
  asserting exact z-score / percentile / MA-deviation values and worksheet
  tests asserting exact FV, buy-zone, and comparison arithmetic per model,
  with no network and no wall-clock dependence.
- Tests assert that no order, simulated-order, credential, or provider code
  path exists or is invoked.
- Acceptance JSON per work-unit records the scope
  (`mode: "valuation_analysis_only"`, paper trading and broker connector
  recorded as unapproved), following the `workflow/evidence/*.acceptance.json`
  style.
- The activation evidence chain remains: exact contract (this document) →
  hashed work-unit → human digest approval → offline replay → human
  acceptance. Zero network expected.

## Fail-closed rules

- Invalid worksheet or indicator request (bad schema, unknown model, invalid
  parameter domain, target outside the admitted universe): reject at
  definition time; do not compute.
- Admitted data missing or insufficient for a requested period: research-only
  "insufficient data" state; never fetch, never extrapolate.
- Any attempt to mark a user-supplied assumption as official, consensus, or
  forward estimate: rejected by construction — the label is fixed at schema
  level.
- Any ambiguity between a worksheet comparison and a trade instruction: the
  feature degrades to inert rather than risk an order-like artifact.
- Data not yet available under PIT (`available_at > as_of`): invisible to
  every computation.

## Cannot-claim list

Until separately approved and evidenced, no work under this contract may claim:

- simulated order matching or paper trading of any kind (returned to
  `deferred_not_approved`);
- order placement, amendment, cancellation, routing, or any execution
  capability, real or simulated;
- automatic population of official fundamental fields (EPS, ROE, revenue,
  margins) — blocked on C1 source admission;
- forward EPS / forward PE from any estimate or consensus source;
- investment advice, recommendation, solicitation, or performance promise;
- user-supplied assumptions presented as official data or market consensus;
- provider calls, credentials, or host egress of any kind;
- StrategySpec admitted or executed;
- persistence off the local machine;
- activation of capabilities 1, 2, 4, or 6;
- product acceptance or automatic promotion to the next capability.
