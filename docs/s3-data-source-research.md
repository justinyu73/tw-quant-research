# S3 — Taiwan public data source research and approval package

Research date: 2026-07-15

S3 is approval-pending. This document records the public entry points and the
bounded first-fetch policy. It does not authorize a network request by itself.

## Source decision

| source | role | public entry point | first data families | decision |
|---|---|---|---|---|
| TWSE OpenAPI | primary listed-market source | `https://openapi.twse.com.tw/v1` and `https://openapi.twse.com.tw/v1/swagger.json` | daily prices, market index, calendar, listed-company master, monthly revenue, financial statements, ex-right/ex-dividend | admit for S3 bounded fetch |
| TPEx OpenAPI | primary OTC-market source | `https://www.tpex.org.tw/openapi/v1/` and `https://www.tpex.org.tw/openapi/swagger.json` | OTC prices, PER/PBR, calendar-related market data, ex-right/ex-dividend, OTC financial statements and revenue | admit for S3 bounded fetch |
| MOPS / XBRL | primary disclosure and publication context | `https://mops.twse.com.tw/mops/`, `https://mopsov.twse.com.tw/mops/web/ezsearch`, `https://mops.twse.com.tw/mops/web/t147sb01` | announcements, filing dates, monthly revenue, financial statements, XBRL taxonomy | admit as public disclosure source; no assumed stable API |
| FinMind | secondary mirror / cross-check only | `https://api.finmindtrade.com/api/v4/data`, `/api/v4/datalist`, `/api/v4/translation` | Taiwan prices, adjusted prices, fundamentals, dividends, institutional and margin data | research-only; not canonical in S3 |

The TWSE Swagger catalog exposes, among others, `STOCK_DAY_ALL`,
`STOCK_DAY_AVG_ALL`, `MI_INDEX`, `holidaySchedule`, `TWT48U_ALL`,
`t187ap03_L`, `t187ap05_L`, `t187ap06_L_ci`, and `t187ap07_L_ci`. The TPEx
catalog exposes `tpex_mainboard_daily_close_quotes`,
`tpex_mainboard_quotes`, `tpex_mainboard_peratio_analysis`,
`tpex_exright_daily`, `tpex_exright_prepost`, `tpex_cmode`,
`mopsfin_t187ap05_O`, `mopsfin_t187ap06_O_ci`, and
`mopsfin_t187ap07_O_ci`.

## License and access findings

The Government Data Open License v1.0 permits reproduction, distribution,
transmission, compilation, adaptation, and derivative works, but requires
explicit attribution. It also states that providers may cease providing a
dataset and disclaim data accuracy/performance. S3 must record the license
reference and attribution text in provenance; it must not infer investment
quality from the license.

TWSE and TPEx public datasets listed through data.gov.tw are marked free and
point to their respective OpenAPI descriptions. Exact API terms, response
schema, and rate behavior must still be captured during the approved fetch.

FinMind documents a v4 data endpoint and a 300 requests/hour limit without a
token, rising to 600/hour with a token. Its repository is Apache-2.0 for the
code, while its README separately describes the data/project as educational
and non-commercial. Therefore S3 does not make FinMind the canonical source.

## S3 first-fetch boundary

The first S3 slice is a bounded source-admission fetch, not a historical data
backfill:

1. One TWSE listed-market daily price response (`response=json`).
2. One TWSE monthly-revenue response (`response=json`).
3. One TPEx OTC daily-close response (`/openapi/v1/` plus the current ROC date query).
4. One TPEx OTC revenue response (`/openapi/v1/`).
5. One MOPS/XBRL public disclosure page used to verify publication context.

Every response must be saved as a small public fixture or digestable snapshot,
with request URL, retrieval timestamp, HTTP status, content type, source
version/terms URL, and content digest. No full-history download is allowed.

Point-in-time rule: `available_at` may use a source-published timestamp only
when the response exposes or documents it. If a source supplies no reliable
publication/availability time, the observation is stored as `unadmitted` and
must not enter a point-in-time backtest by using retrieval time as a silent
substitute.

## Research references

- TWSE OpenAPI: <https://openapi.twse.com.tw/>
- TPEx OpenAPI: <https://www.tpex.org.tw/openapi/>
- TWSE listed daily prices: <https://data.gov.tw/dataset/11548>
- TWSE listed-company master: <https://data.gov.tw/dataset/18419>
- TWSE monthly revenue: <https://data.gov.tw/dataset/18420>
- TWSE ex-right/ex-dividend notice: <https://data.gov.tw/dataset/89748>
- TPEx listed/OTC stock quotes: <https://data.gov.tw/dataset/11370>
- MOPS: <https://mops.twse.com.tw/mops/>
- Government Data Open License: <https://data.gov.tw/license>
- FinMind API quick start: <https://finmind.github.io/en/quickstart/>

## S3 acceptance boundary

S3 can pass only if the three primary source families are reachable through the
allowlisted public entry points, the bounded responses can be mapped to S2
records without losing source or availability semantics, and the raw/source
digests and attribution records are reproducible. It does not approve factor
logic, Qlib provider initialization, backtesting, or product acceptance.
