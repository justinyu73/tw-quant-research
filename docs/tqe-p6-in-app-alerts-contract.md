# TQE P6 in-app alerts activation contract

Status: `contract_defined_pending_implementation`

This is the activation contract for capability 3 (alerts / notifications) of
[`docs/tqe-p6-deferred-capability-activation-proposal.md`](tqe-p6-deferred-capability-activation-proposal.md),
approved by the human gate owner on 2026-07-22 as the first capability in the
approved activation order 3 → 5 → 2.

Scope is strictly **in-app alerts**: user-defined conditions evaluated by the
local engine against admitted data, with results presented inside the app.
**No external delivery channel is in scope.** Email, webhook, push, SMS, and
any other off-machine channel remain unapproved; each requires its own
separate human gate with its own credential boundary before any work begins.
Automatic order placement remains `prohibited`; nothing in this contract
creates an order route, order command, or order UI control.

## Alert definition schema

Schema id: `tqe-in-app-alert/v1`. An alert definition is a JSON object:

| Field | Type | Semantics |
| --- | --- | --- |
| `schema` | string | constant `tqe-in-app-alert/v1` |
| `alert_id` | string | caller-assigned unique id within the local store |
| `label` | string | human-readable name shown in the UI |
| `enabled` | boolean | disabled alerts are never evaluated |
| `target` | object | exactly one security: `{ "security_id": "<universe security id>" }`; the id must resolve in the admitted universe |
| `condition` | object | see condition types below |
| `dedup` | object | `{ "policy": "once_per_session" \| "cooldown_seconds", "cooldown_seconds": int? }` — an alert that has fired does not fire again within the same session (`once_per_session`) or until `cooldown_seconds` have elapsed since its last firing |
| `expiry` | object | `{ "policy": "session" \| "until", "until": "<ISO 8601 datetime>"? }` — `session` alerts are dropped when the session ends; `until` alerts stop evaluating at the given timestamp |
| `created_at` | string | ISO 8601 creation timestamp |

Condition types (exactly one per alert, discriminated by `condition.type`):

- `price_threshold`: `{ "type": "price_threshold", "field": "close", "op": ">=" | "<=", "value": number }` — evaluated against the latest admitted bar of the target.
- `indicator_threshold`: `{ "type": "indicator_threshold", "indicator": "<name>", "params": { ... }, "op": ">=" | "<=", "value": number }` — the indicator must be one already computed by the local engine from admitted data; no new indicator is introduced by this contract.

Unknown condition types, unknown indicators, unknown fields, and targets
outside the admitted universe are rejected at definition time (fail-closed
validation), never silently ignored.

## Evaluation contract

- Evaluation runs **only in the local engine** (`src/tw_quant_engine`). No
  evaluation logic lives in a remote service; there is no remote service.
- Evaluation reads **only admitted data**: the same committed fixtures and
  loopback GET read model that the P4 boundary admits. An alert may not
  trigger, and must not be able to trigger, any provider call or host egress.
- Evaluation is **deterministic**: the same admitted input data and the same
  alert definitions always produce the same set of fired alerts. Evaluation
  results must be **offline-replayable** against committed fixtures with no
  network and no wall-clock dependence beyond explicit `expiry.until`
  timestamps fixed in the fixture.
- Evaluation produces an in-app event only (see UI boundary). There is no
  delivery step in this contract.

## Persistence

- Alert definitions live in session-local local state, following the existing
  watchlist style: a flat versioned JSON save owned by the local app (Tauri
  command surface / session state), e.g. `tqe-in-app-alerts/v1` storage.
- Alert definitions **never leave the local machine**: no cloud sync, no
  telemetry, no export to any provider. Any future persistence beyond the
  local machine is a separate privacy + persistence approval (capability 4
  territory) and is out of scope here.
- Firing history is session-local and is not required to persist across
  sessions in this slice.

## UI presentation boundary

- Fired alerts are presented as research annotations inside the app (e.g. an
  alerts panel entry / chart marker), labelled as research-only.
- The alerts UI must not form anything resembling an order-decision surface:
  no order ticket, no buy/sell affordance, no position sizing, no linkage to
  any broker or execution concept, and no wording that frames a firing as a
  trade instruction. The P4 audit invariant (`/orders` absent from the
  browser surface, no order command in the Tauri surface) must keep passing.
- The StrategySpec remains `not_admitted`; alerts do not evaluate or execute
  strategy specs.

## Test and evidence requirements

- Deterministic fixture tests: committed fixtures drive evaluation tests that
  assert exact fired-alert sets, dedup behaviour, and expiry behaviour with no
  network and no wall-clock dependence.
- Delivery is **stubbed in tests**: the only channel in scope is the in-app
  event, and tests assert that no external channel code path exists or is
  invoked (loopback stub at most).
- Acceptance JSON per work-unit records the channel scope explicitly
  (`channels: ["in_app"]`, external channels listed as unapproved), following
  the `workflow/evidence/*.acceptance.json` style.
- The evidence chain for activation remains: exact contract (this document) →
  hashed work-unit → host-egress admission where applicable (none expected;
  zero network) → caller-owned raw / repository-owned normalized evidence →
  offline P1-P4 replay → human acceptance.
- `python3 scripts/p4_research_closure.py` must keep passing throughout;
  amendments, not silent edits, are the activation mechanism.

## Fail-closed rules

- Invalid definition (bad schema, unknown condition/indicator/field, target
  outside the admitted universe, malformed dedup/expiry): reject at definition
  time; do not evaluate.
- Admitted data unavailable or unreadable for a target: skip evaluation of
  that target and surface a research-only "data unavailable" state; never
  fetch from a provider to fill the gap.
- Any attempt to configure an external delivery channel: rejected by
  construction — no such field exists in the schema.
- Any ambiguity between alert firing and order action: the feature must
  degrade to inert (no firing) rather than risk an order-like surface.

## Cannot-claim list

Until separately approved and evidenced, no work under this contract may claim:

- external delivery of any kind (email, webhook, push, SMS) implemented or
  approved;
- alert-triggered order placement, order routing, or any execution capability;
- activation of capabilities 1, 2, 4, 5, or 6;
- persistence of alert definitions or history off the local machine;
- provider calls or host egress of any kind;
- StrategySpec admission or execution semantics;
- product acceptance or automatic promotion to the next capability.
