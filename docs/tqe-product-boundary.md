# TQE product boundary: free research data workbench v1

Status: user-confirmed direction for the next execution slice.

The product is a local, read-only research data workbench. Its job is to
collect free official or public reference data, preserve the raw and
normalized forms locally with provenance, and help a human evaluate financial
reports, events, and company stories with explicit calculations.

It is not a real-time quote terminal, broker system, automatic trading system,
or autonomous quantitative-computation service.

## In scope

- Free official or public data sources only.
- Human-initiated, bounded data capture.
- Local raw-reference retention when the source terms permit it.
- Normalized records with source, retrieval time, period, and digest metadata.
- Human-directed financial, valuation, comparison, and tracking calculations.
- Company story, event, filing, and research-note tracking.
- Read-only charts, tables, evidence panels, and local watchlists.
- Desktop-only explicit update of the currently selected TWSE listed equity for
  a trailing 1, 2, or 3 years; the downloaded raw responses and normalized K
  line snapshots stay in the user's application data directory.

## Out of scope

- Paid data subscriptions or purchased Data E-Shop products.
- Credentials, cookies, private exports, or vendor-only feeds.
- Real-time or delayed quote service.
- Broker integration, order placement, portfolio execution, or auto-trading.
- Automatic strategy execution, unattended screening, or automatic promotion.
- Treating a calculated score as an investment decision or product acceptance.
- Full-market or TPEx historical download from the current update panel.

## Data flow

```text
human selects symbol/topic/range
        -> free public source capture
        -> local raw evidence + normalized read model
        -> provenance and quality checks
        -> human financial/story evaluation
        -> explicit calculation or note
```

P5 must therefore reject paid subscription products even when their schema and
coverage are technically suitable. A free source contract must be established
before any human-run capture work-unit is activated.

The current desktop update is a bounded TWSE implementation of that rule. It is
not a background refresh: the human chooses the selected listed stock and the
1/2/3-year range, then explicitly starts the download. Browser preview mode is
fixture-only and does not download data.
