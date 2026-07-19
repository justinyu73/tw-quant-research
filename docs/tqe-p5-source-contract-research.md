# TQE P5.1 TWSE source-contract research

Status: `source_contract_blocked`

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

## Current boundary

No provider call was made while preparing this note. The next executable
artifact remains
[`workflow/tqe-p5-twse-work-unit.draft.json`](../workflow/tqe-p5-twse-work-unit.draft.json),
which is `draft_not_runnable` until this research gate passes.
