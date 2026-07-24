# TQE P5.1 TWSE source-contract research

Status: `source_contract_selected_pending_activation` (option B, forward
accumulation, selected by the user 2026-07-22; formerly
`source_contract_blocked`)

The product boundary is free-first: paid Data E-Shop subscriptions are not
admissible, even if their schema and historical coverage fit the research
need. The system stores free reference data locally for human financial and
company-story evaluation; it is not an automated trading or quantitative
execution service. See [`tqe-product-boundary.md`](tqe-product-boundary.md).

This note records source candidates for the approved P5 TWSE-first work-unit.
It does not authorize a market-data request or admit a provider. The machine-
readable decision is recorded in
[`workflow/tqe-p5-twse-source-contract.json`](../workflow/tqe-p5-twse-source-contract.json).

## Candidate official surfaces

| Candidate | Official reference | Current role | Admission status |
| --- | --- | --- | --- |
| TWSE OpenAPI daily transactions | [`STOCK_DAY_ALL`](https://openapi.twse.com.tw/) | Latest full-market daily transaction snapshot | Rejected for P5 bulk: no proof of one bounded three-year response |
| TWSE OpenAPI daily close/monthly average | [`STOCK_DAY_AVG_ALL`](https://openapi.twse.com.tw/) | Close and monthly-average snapshot | Rejected: does not provide daily OHLCV |
| TWSE historical stock-day page | [historical stock-day query](https://wwwc.twse.com.tw/zh/trading/historical/stock-day.html) | Interactive historical query | Rejected for P5 bulk: date and security code query, no bounded all-market contract |
| TWSE Data E-Shop | [official Data E-Shop](https://www.twse.com.tw/zh/products/dataeshop.html) | Ordered historical-data service | Not admitted: no approved public download contract or fixture terms |
| TWSE Data E-Shop trade file | [成交檔 product](https://eshop.twse.com.tw/zh/product/detail/0000000063ce6ab00163d860b694000a) | All-stock monthly raw trade file | Rejected: raw trades, custom production, excludes recent year, internal-use restriction |
| TWSE Data E-Shop Daily Quotes | [Daily Quotes product](https://eshop.twse.com.tw/en/product/detail/ef7b7785e2cb4793baca3644c8a74d4e) | Official daily full-market OHLCV file subscription | Rejected: paid subscription; outside the free-only product boundary |
| TWSE official calendar | [`holidaySchedule/holidaySchedule`](https://openapi.twse.com.tw/) | Calendar input in the same work-unit | Candidate only; digest and coverage binding remain pending |
| Government data catalogue daily transactions | [dataset 11549](https://data.gov.tw/dataset/11549) | Public catalogue/provenance reference | Confirms daily OHLCV fields and open-data metadata, not three-year bulk coverage |

## Decision

P5.1 is complete as a fail-closed source-contract review with status
`source_contract_blocked`. The official catalogue describes `STOCK_DAY_ALL` as
the daily transaction dataset and lists the OHLCV-related fields, but that is
not evidence that one bounded response contains the selected range. The
official historical page exposes a query surface with a date and security-code
input, while the official Data E-Shop describes ordered historical products;
neither is an admitted unauthenticated bulk endpoint for this work-unit.

The selected range therefore remains unadmitted. No source ID was added to the
provider registry, no normalized market-data fixture was created, and no
repository provider work-unit was run.

## Resolution audit after approval

The follow-up search found an official product with suitable OHLCV coverage,
but it is a paid subscription and is therefore rejected. The official
catalogue's own suggestion records that the public dataset only
exposes the post-update single quote and requests historical access by date and
security code. That confirms the current public dataset is not evidence of a
three-year all-market bulk response. The official historical page and Data
E-Shop remain query/order surfaces rather than an approved unauthenticated
bulk download contract. The newly checked official trade-file product is also
not sufficient: it is raw trades rather than OHLCV, excludes the most recent
year, and carries internal-use restrictions.

This audit is recorded in the `resolution_audit` object of
[`workflow/tqe-p5-twse-source-contract.json`](../workflow/tqe-p5-twse-source-contract.json).
The result remains `no_official_bounded_bulk_artifact_found`; the Daily Quotes
product is recorded as rejected under the free-only boundary. P5.2 is already
pass, while P5.1 and activation-ready P5.3 remain blocked pending a free public
source contract.

## Required P5.1 evidence

The exact candidate can enter the work-unit only after the following are
captured and reviewed:

- endpoint URL, method, query parameters, and redirect behavior;
- terms URL, license, attribution, and response content type;
- response schema and field mapping for OHLCV;
- proof that one bounded response covers `2023-07-20` through `2026-07-19`;
- official calendar response/version bound to the same work-unit;
- raw response byte count and SHA-256 digest;
- no credential, cookie, private export, or unbounded snapshot.

If no candidate proves the selected range, stop with `source_contract_blocked`;
do not substitute the existing latest-day endpoint or create an implicit
per-trading-day loop. The current P5.1 result is that stop condition.

## 2026-07-22 re-verification

Each candidate was re-checked on 2026-07-22 against the official surfaces and
current public reporting. No provider call was made by the repository; the
checks below are read-only web verification of official pages and catalogue
entries.

| Candidate | Verification source | 2026-07-22 result |
| --- | --- | --- |
| TWSE OpenAPI `STOCK_DAY_ALL` | [official OpenAPI portal](https://openapi.twse.com.tw/); independent 2026-06 report ([finlab comparison](https://finlab.finance/blog/python-get-taiwan-stock-data), "官方，但只留最新") | Confirmed: still a latest-day full-market snapshot; no historical depth or bounded multi-year response. Rejection stands. |
| TWSE OpenAPI `STOCK_DAY_AVG_ALL` | [official OpenAPI portal](https://openapi.twse.com.tw/) | Confirmed: close and monthly-average fields only, no daily OHLCV. Rejection stands. |
| TWSE historical stock-day page | [official historical query page](https://wwwc.twse.com.tw/zh/trading/historical/stock-day.html) | Confirmed: interactive per-date, per-security-code query surface (JavaScript-rendered form); no bounded all-market bulk contract. Rejection stands. |
| TWSE Data E-Shop Daily Quotes | [official product page](https://eshop.twse.com.tw/en/product/detail/ef7b7785e2cb4793baca3644c8a74d4e), fetched 2026-07-22 | Confirmed: daily OHLCV fields (A05E: open, high, low, close, volume, transactions, trading value), start date 1992-01-04, daily period, files TWT62U/TWT69U/TWTA5U — but unit of subscription is month with cart checkout, i.e. a paid Data E-Shop subscription. Technically suitable; still rejected under the free-only product boundary. |
| TWSE Data E-Shop trade file | [official product page](https://eshop.twse.com.tw/zh/product/detail/0000000063ce6ab00163d860b694000a) | No change found: raw trades, custom production, excludes the most recent year, internal-use restriction. Rejection stands. |
| Government data catalogue dataset 11549 | [dataset page](https://data.gov.tw/dataset/11549), fetched 2026-07-22 | Confirmed: free, daily update, OHLCV fields, government open-data license v1, pointing at the same OpenAPI swagger; metadata and provenance reference only, no three-year bulk coverage. |
| TWSE official calendar `holidaySchedule` | [official OpenAPI portal](https://openapi.twse.com.tw/) | Still candidate only; retrieval timestamp, byte count, SHA-256 digest, and version binding to the same work-unit remain pending capture at activation. |

Conclusion: the 2026-07-19 audit result is unchanged. No free official
bounded three-year bulk artifact exists as of 2026-07-22; the only official
product with suitable schema and coverage remains the paid Daily Quotes
subscription. P5.1 therefore stays `source_contract_blocked` and now carries
explicit `decision_options` and a human-gate `next_action` in
[`workflow/tqe-p5-twse-source-contract.json`](../workflow/tqe-p5-twse-source-contract.json).

## Current boundary

No provider call was made while preparing this note. The next executable
artifact remains
[`workflow/tqe-p5-twse-work-unit.draft.json`](../workflow/tqe-p5-twse-work-unit.draft.json),
which is `draft_not_runnable` until this research gate passes.

## 2026-07-22 user decision: option C, and MI_INDEX endpoint re-check

The human gate owner selected decision option C
(`C_bounded_per_trading_day_capture_from_official_free_daily_endpoint`) on
2026-07-22. The selection is recorded in the `decision.user_selection` block of
[`workflow/tqe-p5-twse-source-contract.json`](../workflow/tqe-p5-twse-source-contract.json).
The top-level status stays `source_contract_blocked` with sub-state
`option_c_approved_fresh_p5_1_pass_pending`: the selection approves the
request-budget and work-unit-shape amendment direction, but activation still
requires a fresh P5.1 contract pass for the chosen endpoint.

### MI_INDEX endpoint re-check (read-only, no market data downloaded)

The legacy TWSE full-market daily closing quotes CSV endpoint was re-verified
on 2026-07-22 from public documentation and practitioner reports:

- Method/URL: `GET https://www.twse.com.tw/exchangeReport/MI_INDEX?response=csv&date=YYYYMMDD&type=ALL`
  ([iT邦 C# walkthrough](https://ithelp.ithome.com.tw/articles/10258478),
  [finlab crawler tutorial](https://finlab.finance/blog/taiwan-stock-daily-crawler-tutorial)).
  `type=ALL` returns the full market; `type=ALLBUT0999` excludes warrants and
  CBBC ([QuantPass](https://quantpass.org/python_crawler1/)).
- Response: CSV with several sections; index rows are prefixed with `=` lines
  and the full-market section starts at the `證券代號` header row. Encoding is
  historically Big5/CP950 and must be detected and recorded at trial capture.
- Columns (16): 證券代號, 證券名稱, 成交股數, 成交筆數, 成交金額, 開盤價,
  最高價, 最低價, 收盤價, 漲跌(+/-), 漲跌價差, 最後揭示買價, 最後揭示買量,
  最後揭示賣價, 最後揭示賣量, 本益比
  ([shiangsoft schema listing](https://blog.shiangsoft.com/stock-price-clawer/)).
  This covers the required OHLCV plus amount and transaction count.
- Historical depth: public tutorials show arbitrary past dates working
  (2018-01-31, 2021-05-07, 2022-04-12); the commonly cited earliest date is
  2004-02-11. Depth inside 2023-07-20..2026-07-19 is not assumed — it must be
  proven by the first human trial capture.
- robots/rate-limit: `https://www.twse.com.tw/robots.txt` (fetched 2026-07-22)
  disallows only `/epaper/` and `/FTSE/`; the MI_INDEX path is not excluded.
  TWSE publishes no numeric rate limit; practitioner reports describe
  throttling or bans on dense crawling, so the amended work-unit serializes
  requests with a conservative delay and a hard session cap
  ([iT邦 practitioner note](https://ithelp.ithome.com.tw/m/articles/10300618)).
- Terms: no explicit bulk-download prohibition was located during read-only
  verification; terms-of-use and fixture-retention license review remains a
  pre-activation requirement.

These findings are recorded in the `option_c_endpoint_assessment` block of the
source contract.

### Amended work-unit shape

The amended bounded-loop draft is
[`workflow/tqe-p5-twse-work-unit.option-c.draft.json`](../workflow/tqe-p5-twse-work-unit.option-c.draft.json):
one GET per trading session against MI_INDEX, sessions enumerated from the
official `holidaySchedule` calendar (digest pending), cap 750 sessions plus 1
calendar GET (751 total), fail-closed on any anomaly, per-session sha256
records. It remains `draft_not_runnable`.

### Still missing before activation

- first human trial capture (sha256, bytes, timestamp) for one recent session;
- official calendar digest bound to the same work-unit;
- enumerated session list at or below the cap;
- fixture retention/license/size/sha256 policy approval;
- per-session work-unit digest approved by the human before host egress;
- CSV encoding/schema probe from the trial capture;
- terms-of-use review record for the MI_INDEX endpoint.

The acceptance evidence for this decision is
[`workflow/evidence/p5.1-option-c-selection.acceptance.json`](../workflow/evidence/p5.1-option-c-selection.acceptance.json).
