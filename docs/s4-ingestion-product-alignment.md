# S4 — Offline ingestion, provenance, and product-field alignment

## Approval boundary

This document is an S4 design and approval artifact. It does not authorize
implementation until the S4 package is explicitly approved. S4 uses the
captured S3 fixtures offline; it performs no new network request.

S4 produces a deterministic source-to-canonical mapper and a small product
read model. The canonical S2 contract remains authoritative. Qlib does not
own the fields, formulas, timestamp rules, or provenance.

## Inputs and outputs

| layer | input/output | authority |
|---|---|---|
| source capture | S3 bounded fixture: raw sample row, endpoint, status, digest, terms | S3 evidence |
| canonical mapping | S2 `price_bar` / `fundamental_observation` candidate plus provenance | S2 contract |
| admission | `admitted`, `unadmitted`, `conflict`, or `invalid` with reason | fail-closed predicate |
| product read model | stable field IDs, units, formula version, quality and lineage | `config/product-alignment.yaml` |

The current S3 samples do not expose a reliable source-published timestamp.
Therefore S4 must preserve them as `unadmitted`; it must not use
`retrieved_at` as `available_at`. S4 may prove mapping and formula behavior
with synthetic offline rows that contain explicit timestamps.

## Product-aligned field contract

### Price product

| product field | canonical source | unit | rule |
|---|---|---|---|
| `instrument.security_id` | `security_id` | string | preserve leading zeroes |
| `instrument.market` | source registry | enum `TWSE`/`TPEX` | source-defined, never inferred from symbol suffix |
| `bar.trading_date` | `trading_date` | ISO date | convert ROC `YYYMMDD` using `year + 1911` |
| `bar.open/high/low/close_raw` | `price_bar` OHLC | TWD/share | raw price only; no silent adjustment |
| `bar.volume_shares` | `price_bar.volume` | shares | TWSE `TradeVolume`, TPEx `TradingShares` |
| `bar.daily_return_1d` | derived | ratio | requires prior admitted close |
| `quality.admission_status` | admission predicate | enum | fail closed on missing PIT evidence |

### Fundamental product

| product field | canonical source | unit | rule |
|---|---|---|---|
| `fundamental.monthly_revenue` | `fundamental_observation.value` | source-declared | unit must be explicitly declared; no assumed “thousand TWD” |
| `fundamental.revenue_mom` | derived | ratio | exact previous calendar month only |
| `fundamental.revenue_yoy` | derived | ratio | exact same calendar month in prior year only |
| `provenance.available_at` | S2 `available_at` | UTC timestamp | absent source publication timestamp means unadmitted |

Every product row carries `source_id`, `endpoint`, `snapshot_id`,
`content_digest`, `license_ref`, and `formula_version` where a formula is
present. A row cannot become `admitted` merely because its HTTP response was
200.

## Source-to-field mapping

The mapping is explicit and provider-specific:

| source | raw field | target | note |
|---|---|---|---|
| TWSE daily | `Code` | `security_id` | string preservation |
| TWSE daily | `Date` | `trading_date` | ROC date conversion |
| TWSE daily | `OpeningPrice`, `HighestPrice`, `LowestPrice`, `ClosingPrice` | OHLC | numeric parse, no adjustment |
| TWSE daily | `TradeVolume` | `volume_shares` | share count |
| TPEx daily | `SecuritiesCompanyCode` | `security_id` | string preservation |
| TPEx daily | `Date` | `trading_date` | ROC date conversion |
| TPEx daily | `Open`, `High`, `Low`, `Close` | OHLC | numeric parse, no adjustment |
| TPEx daily | `TradingShares` | `volume_shares` | do not substitute `TransactionAmount` |
| TWSE/TPEx revenue | `公司代號` | `security_id` | string preservation |
| TWSE/TPEx revenue | `資料年月` | `period_end` | convert `YYYMM` to last day of that month |
| TWSE/TPEx revenue | `營業收入-當月營收` | revenue value | only after source unit is admitted |
| TWSE/TPEx revenue | `出表日期` | publication-date candidate | date-only value is not an `available_at` timestamp |

## Formula contract

Formula version: `s4-v1`.

1. One-day return:

   `daily_return_1d(t) = close_raw(t) / close_raw(t-1) - 1`

   The result is null with reason `missing_or_zero_prior_close` if the prior
   close is absent or zero. It is not forward-filled and is not computed from
   an unadmitted row.

2. Monthly revenue growth:

   `revenue_mom(p) = revenue(p) / revenue(previous_calendar_month) - 1`

   Only an exact adjacent calendar month qualifies; missing months do not get
   filled from the nearest observation.

3. Year-over-year revenue growth:

   `revenue_yoy(p) = revenue(p) / revenue(same_calendar_month_previous_year) - 1`

   The denominator must have the same company, metric, unit, and currency.

4. Admission status:

   `admitted = HTTP_200 AND schema_valid AND required_fields_present AND explicit_available_at AND provenance_valid`

   Otherwise the row is `unadmitted`, `conflict`, or `invalid` with a stable
   reason code. `retrieved_at` is never a fallback for `available_at`.

Adjusted close, total-return price, corporate-action application, valuation,
factor scores, and backtest returns are explicitly outside S4. S4 keeps
`close_raw` and any future corporate-action factor separate.

## Acceptance test focus

| test group | required proof |
|---|---|
| offline boundary | socket/network call is blocked; fixture replay still completes |
| source mapping | TWSE and TPEx field names map to the same canonical fields; TPEx uses `TradingShares` |
| date conversion | ROC `1150715` becomes `2026-07-15`; `11506` becomes `2026-06-30` |
| numeric/unit safety | malformed numbers, missing revenue unit, and mixed currency fail closed |
| PIT | no source publication timestamp means `unadmitted`; retrieval time is never substituted |
| provenance | endpoint, source, snapshot, digest, license, and formula version survive mapping |
| price formula | known close sequence gives exact return; zero/missing prior close gives null reason |
| revenue formulas | exact MoM/YoY denominators only; no nearest-period or forward-fill behavior |
| OHLC invariants | low/high constraints and non-negative volume remain enforced |
| adjustment isolation | raw close is unchanged; no implicit split/dividend adjustment appears |
| conflict handling | duplicate logical key or source disagreement is flagged/fails closed |
| determinism | repeated offline run gives stable output and evidence digests |
| regression | S1/S2 tests remain green and LH preflight remains pass |

## S4 cannot claim

S4 cannot claim data completeness, source accuracy beyond captured response
checks, adjusted-price correctness, factor validity, backtest validity,
dashboard acceptance, investment performance, or S5 approval.
