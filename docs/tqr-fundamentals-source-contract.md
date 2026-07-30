# TQR fundamentals source contract

Authority: [`tqr-research-platform-spec.md`](tqr-research-platform-spec.md)
Decision: `TQR-FUNDAMENTALS-SOURCE-001`
Status: `twse_implemented_forward_accumulation` (TPEx deferred)
Verified: 2026-07-31 (live probe, `scripts/probe_fundamentals_sources.py`)

Machine-readable record:
[`workflow/tqr-fundamentals-source-contract.json`](../workflow/tqr-fundamentals-source-contract.json).

This note records what the candidate free endpoints actually return. It admits
no source, enables no field, and creates no normalized fixture. Every number
below was measured by one human-run unauthenticated GET per endpoint, not
inferred from documentation.

## Probe result

| Source | Endpoint | HTTP | Rows | Distinct periods | `available_at` field | Admission |
| --- | --- | --- | --- | --- | --- | --- |
| twse_monthly_revenue | `/v1/opendata/t187ap05_L` | 200 | 1,082 | 1 | 出表日期 | candidate |
| twse_income_statement | `/v1/opendata/t187ap06_L_ci` | 200 | 1,045 | 1 | 出表日期 | candidate |
| twse_balance_sheet | `/v1/opendata/t187ap07_L_ci` | 200 | 1,045 | 1 | 出表日期 | candidate |
| tpex_monthly_revenue | `/openapi/v1/mopsfin_t187ap05_O` | 200 | 891 | 1 | 出表日期 | candidate |
| tpex_income_statement | `/openapi/v1/mopsfin_t187ap06_O_ci` | 200 | 883 | 1 | Date | candidate |
| tpex_balance_sheet | `/openapi/v1/mopsfin_t187ap07_O_ci` | 200 | 883 | 1 | Date | candidate |

All six are bounded, unauthenticated, single-GET JSON arrays under the
Government Data Open License v1. Attribution is required in provenance.

## Finding 1 — every endpoint is a latest-period snapshot

Measured: each response carried exactly **one** distinct period across all rows.
Monthly revenue returned `資料年月 = 11506` (2026-06); both statement endpoints
returned `年度/季別 = 115/1` (2026 Q1).

**Consequence for the spec.** The Trend Table's "最近 8 季" and "最近 12 個月"
cannot be produced from these sources in one fetch. Two admissible paths:

1. **Forward accumulation** — one human-run capture per publication cycle,
   appended locally. A full 8-quarter table takes ~2 years to fill; a 12-month
   revenue table takes ~1 year. This reuses the option-B pattern already
   selected for price history in P5.1.
2. **A separately admitted historical source** — not yet found among free
   official endpoints; would need its own contract.

Until one is chosen, the Trend Table must keep rendering its explicit
`unavailable` empty state, and must show a partial series honestly (n of 8
quarters) rather than padding.

## Finding 2 — 出表日期 is a batch export date, not a filing date

Measured: `t187ap06_L_ci` returned `出表日期 = 1150728` identically for all 1,045
rows while every row was period `115/1`. It is the date the exchange regenerated
the export, not the date each company filed.

**Normalization rule this forces.** `available_at = 出表日期` is admissible
because it is *later* than the true filing date, which is the conservative,
PIT-safe direction. `published_at` must stay `null` until a per-company filing
timestamp source is admitted. Labelling 出表日期 as `published_at` is prohibited.

## Finding 3 — the response digest moves without the data moving

Because 出表日期 sits in every row and advances with each export run, a
whole-response `content_digest` will differ day to day even when the financial
values are unchanged.

**Consequence.** Append-only snapshot dedupe must key on
`(security_id, year, quarter)` plus the financial values. Keying on the response
digest would create a fresh "new" record on every capture and corrupt the
period series.

## Finding 4 — the exchanges name the same fields differently

TPEx statement endpoints use `SecuritiesCompanyCode` / `Year` / `Season` / `Date`
where TWSE uses `公司代號` / `年度` / `季別` / `出表日期`. This is a per-source
mapping task, not a missing field. An earlier probe pass reported these two TPEx
endpoints as rejected; that was a defect in the probe's column matching, not a
source defect, and is corrected here.

## Finding 5 — the value-investing minimum fields are all present

`t187ap06_L_ci` carries `營業收入`, `營業成本`, `營業毛利（毛損）`,
`營業利益（損失）`, `本期淨利（淨損）`, and `基本每股盈餘（元）`. Gross,
operating, and net margin plus quarterly EPS are therefore all derivable once a
period is captured — with no estimate, consensus, or forward EPS involved, which
keeps the `forward_eps` prohibition intact.

## Open questions for the human gate

1. Is a free official historical series available for prior quarters, or is
   forward accumulation the only admissible path?
2. What is the exact publication cadence per endpoint, so a capture reminder can
   be scheduled without polling?
3. Should TPEx be admitted in the same slice as TWSE, or deferred until the TWSE
   normalization contract is proven?

## What this contract does not authorize

Enabling any `unavailable` field in the UI; background or scheduled fetching;
treating 出表日期 as a company publication time; estimating a missing period from
price or from an adjacent period.

## Reproduce

```sh
python3 scripts/probe_fundamentals_sources.py --write-samples
```

Writes `workflow/tqr-fundamentals-source-contract.json` and one bounded sample
row per source under `tests/fixtures/tqr-fundamentals/`. This is the only code
path in the repo that contacts these endpoints; the sidecar and dashboard never
do.

## Implementation status (2026-07-31)

TWSE only, per the human decision to prove the normalization contract before
adding TPEx.

| Piece | Where |
| --- | --- |
| Normalization + forward accumulation | `src/tw_quant_engine/fundamentals.py` |
| Human-run capture | `scripts/capture_twse_fundamentals.py` |
| Read model route | `GET /fundamentals?security_id=` |
| Offline tests | `tests/test_tqr_fundamentals.py` (16 cases) |

Live capture on 2026-07-31 normalized 1,082 monthly-revenue rows (period
2026-06) and 1,045 income-statement rows (period 2026Q1) with zero drops. A
second immediate run reported `added: 0, restated: 0, unchanged: 2127`,
confirming that an advancing batch export date alone never creates a duplicate
period.

Cross-check: the recomputed 台泥 2026-06 revenue YoY of 32.3988% matches the
source's own `營業收入-去年同月增減(%)` column of 32.39878166305348, so the ratio
convention is correct while remaining independently computed.

TPEx (`mopsfin_t187ap05_O`, `mopsfin_t187ap06_O_ci`) stays unimplemented. Its
`SecuritiesCompanyCode` / `Year` / `Season` / `Date` naming needs its own mapping
entry before admission.
