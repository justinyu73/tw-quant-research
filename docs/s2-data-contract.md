# S2 — Canonical point-in-time data contract

## Scope

S2 defines a provider-neutral, dependency-free contract for price bars,
fundamental observations, corporate actions, and provenance snapshots. The
fixture is synthetic. No Qlib provider, Taiwan data source, network request, or
data adapter is part of this stage.

Qlib consumes the canonical records later; it does not own the schema or the
point-in-time visibility rules.

## Time and revision rules

- `trading_date`, `period_end`, and `ex_date` are ISO calendar dates.
- `available_at`, `reported_at`, and `announced_at` require explicit timezone
  information and are normalized to UTC `Z` form.
- `as_of` returns only records with `available_at <= as_of`.
- A restatement is a new `snapshot_id`; it never overwrites the earlier
  snapshot.
- For one logical key, the latest visible revision is selected at `as_of`.
- Equal-time competing revisions fail closed as ambiguous.
- Missing data is not forward-filled by this contract.
- Corporate-action factors remain explicit; price adjustment is a later,
  separate transformation.

## Required record families

`price_bar`, `fundamental_observation`, and `corporate_action` each require a
`security_id`, `available_at`, `source_ref`, and `snapshot_id`. Fundamental
records additionally carry `metric`, `period_end`, `reported_at`, `value`,
`unit`, and `currency`. Every snapshot must have a provenance record with a
content digest and license reference.

## Acceptance boundary

S2 passes only when the synthetic fixture is deterministic and tests prove
future visibility is blocked, restatements replay correctly, duplicate keys and
naive timestamps fail, and corporate actions remain explicit. A pass does not
approve S3 data sources, factor logic, valuation, backtesting, or product
acceptance.
