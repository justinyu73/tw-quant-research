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
- Desktop-only explicit update of the user's selected watchlist, or one
  currently selected TWSE listed equity, for a trailing 1, 2, or 3 years; the
  downloaded raw responses and normalized K line snapshots stay in the user's
  application data directory.

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
not a background refresh: the human chooses the watchlist or selected listed
stock and the 1/2/3-year range, then explicitly starts the download. Browser
preview mode is fixture-only and does not download data.

## Desktop IA/UIUX contract v1

Decision: `TQR-UIUX-001`
Status: active

The desktop product uses one research-terminal shell across all pages. The
information architecture is fixed as `行情：市場首頁／行情分析／我的自選／技術指標`、
`研究：選股中心／財報／回測報告`、`記錄：研究筆記／資料來源`。 Each page keeps the
same page header, content width, card header, control row, table overflow, and
status treatment; only the page-specific read model changes.

The shared visual contract is:

- Font: `Noto Sans TC`, then the platform Chinese UI font; numeric identifiers
  and values use a monospace fallback.
- Type scale: body 14 px / 1.55, helper 12 px / 1.5, card title 16 px / 1.3,
  section title 18 px / 1.3, page title 30 px / 1.18, display title 36 px / 1.12.
- Layout: fixed desktop navigation, 62 px top bar, content max-width 1,440 px,
  16–28 px page padding, 8–18 px component gaps, and 36–40 px form controls.
- Responsive behavior: 1,100 px collapses multi-column work areas, 820 px
  collapses dense grids and preserves horizontal table scrolling, and 720 px
  switches to a compact navigation rail with single-column controls.
- Interaction: every input/select keeps focus while typing or choosing; destructive
  actions are explicit and confirmable; deleting a custom watchlist group never
  deletes its instruments from another group or from the global saved watchlist.
- Palette: neutral paper-like surfaces, dark terminal navigation, blue primary
  action, and restrained red/green/yellow status colors. Avoid gradients and
  dashboard-only decoration on research data blocks.

This section is the canonical UI decision for the shared dashboard CSS. The
implementation may add page-specific classes only when they preserve this
hierarchy and responsive contract.
