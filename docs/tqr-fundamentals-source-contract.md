# TQR fundamentals source contract

Authority: [`tqr-research-platform-spec.md`](tqr-research-platform-spec.md)
Decision: `TQR-FUNDAMENTALS-SOURCE-001`
Status: `twse_and_tpex_live_proven_forward_accumulation`
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

## Finding 4 — the exchanges name the same fields differently, per family

Corrected 2026-07-31 against the recorded sample rows under
`tests/fixtures/tqr-fundamentals/tpex_*.sample.json`. The earlier wording —
"TPEx statement endpoints use `SecuritiesCompanyCode` / `Year` / `Season` /
`Date` where TWSE uses `公司代號` / `年度` / `季別` / `出表日期`" — was right about
the income statement and wrong about the other two families. The divergence is
per family, not per exchange:

| Family | Identity / period columns | Divergence from TWSE |
| --- | --- | --- |
| `tpex_monthly_revenue` | `出表日期` / `資料年月` / `公司代號` / `公司名稱` / `產業別` | none — the TWSE column names verbatim |
| `tpex_income_statement` | `Date` / `Year` / `Season` / `SecuritiesCompanyCode` / `CompanyName` | identity columns only; financial columns stay Chinese and match TWSE |
| `tpex_balance_sheet` | `Date` / `年度` / `季別` / `SecuritiesCompanyCode` / `CompanyName` | mixed convention — it does **not** use `Year` / `Season` |

The balance sheet also renames the three totals, which the earlier finding did
not record at all:

| Concept | TWSE | TPEx |
| --- | --- | --- |
| Total assets | `資產總額` | `資產總計` |
| Total liabilities | `負債總額` | `負債總計` |
| Total equity | `權益總額` | `權益總計` |

**Why this one is dangerous rather than merely different.** A missing datum
normalizes to `None` by design and a malformed row is dropped, but a column the
mapping never finds does neither: every row normalizes, no row is dropped, the
capture report shows a healthy count, and `assets`, `liabilities`, `equity`,
`debt_ratio` and `current_ratio` are all silently `None`. Normalization therefore
treats an absent *mapped* column as a `FundamentalsMappingError` that aborts the
capture, distinct from the row-level `FundamentalsError` that only drops a row.

An earlier probe pass reported the two TPEx statement endpoints as rejected; that
was a defect in the probe's column matching, not a source defect.

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
3. ~~Should TPEx be admitted in the same slice as TWSE, or deferred until the
   TWSE normalization contract is proven?~~ Answered 2026-07-31: deferred, then
   admitted once the TWSE contract was proven by live capture. TPEx was built
   offline-first and its first live capture has since been run.
4. Does a company that moves between TPEx and TWSE ever appear in both exports
   for the same period? Still open, but the first two-market capture produced 0
   conflicts, so no collision has been observed yet. The observation key excludes market so that such a
   company keeps one continuous series, which makes a same-key/different-market
   pair ambiguous. It is reported as a merge conflict and refused rather than
   guessed; only a live capture across a real listing move can retire this.

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

Both exchanges are mapped and both are now proven by live capture.

| Piece | Where |
| --- | --- |
| Normalization + forward accumulation | `src/tw_quant_engine/fundamentals.py` |
| Families implemented | monthly_revenue, income_statement, balance_sheet |
| Markets implemented | TWSE (live-proven), TPEx (live-proven) |
| Human-run capture | `scripts/capture_fundamentals.py` (`--market`, `--family`) |
| Read model route | `GET /fundamentals?security_id=` |
| Offline tests | `tests/test_tqr_fundamentals.py` (28 cases) |

Live capture on 2026-07-31 normalized 1,082 monthly-revenue rows (period
2026-06) and 1,045 income-statement rows (period 2026Q1) with zero drops. A
second immediate run reported `added: 0, restated: 0, unchanged: 2127`,
confirming that an advancing batch export date alone never creates a duplicate
period.

Cross-check: the recomputed 台泥 2026-06 revenue YoY of 32.3988% matches the
source's own `營業收入-去年同月增減(%)` column of 32.39878166305348, so the ratio
convention is correct while remaining independently computed.

TPEx (`mopsfin_t187ap05_O`, `mopsfin_t187ap06_O_ci`, `mopsfin_t187ap07_O_ci`) is
mapped per Finding 4 and covered by offline tests over the recorded sample rows,
including an assertion that the balance-sheet totals and both derived ratios are
real numbers rather than the silent `None` the 總額/總計 split would otherwise
produce. Attribution now follows each observation's own provenance, so TPEx data
is credited to 證券櫃檯買賣中心 and never to 證交所.

The first TPEx live capture has been run by the operator. Measured from the
resulting local series (`fundamentals-series.json`), not inferred:

| TPEx family | Admitted observations | Distinct periods | `available_at` |
| --- | --- | --- | --- |
| monthly_revenue | 891 | 1 (`2026-06`) | 2026-07-17 |
| income_statement | 883 | 1 (`2026Q1`) | 2026-07-31 |
| balance_sheet | 883 | 1 (`2026Q1`) | 2026-07-31 |

Each family carries exactly one distinct period, so Finding 1 holds for TPEx as
it does for TWSE. The admitted counts equal the row counts this contract's
2026-07-30 probe measured (891 / 883 / 883); the capture run's own
`source_rows` and `dropped` figures were not retained, so this contract states
the admitted counts it can verify and does not claim a drop count.

Across the whole series the merge recorded 0 `supersedes` and 0 `conflicts`: no
same-key/different-market collision occurred in practice.

### Balance sheet (added 2026-07-31)

`t187ap07_L_ci` supplies `資產總額`, `負債總額`, `權益總額`, `流動資產`,
`流動負債`, `每股參考淨值`, from which debt ratio, current ratio, and BVPS are
derived. Same single-period constraint and same forward accumulation.

A live re-capture observed the income-statement response grow from 1,045 to
1,046 rows as one more company filed. The merge reported
`added: 1, unchanged: 1045`, confirming that dedupe distinguishes a genuinely
new security from an unchanged one under real source movement.
