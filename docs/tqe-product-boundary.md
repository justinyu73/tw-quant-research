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
information architecture is fixed as six primary sections:
`Home／Watchlist／Company／Valuation／Buy Plan／Review`; provenance and settings stay
reachable from inside a page. Each page keeps the
same page header, content width, card header, control row, table overflow, and
status treatment; only the page-specific read model changes.

The shared visual contract is:

- Font: `Noto Sans TC`, then the platform Chinese UI font; numeric identifiers
  and values use a monospace fallback.
- Type ladder (single source: the one `:root` in `ui/dashboard/styles.css`):
  page title 28 px / 1.18, card+panel title 19 px / 1.3, subsection title 15 px,
  top-nav item 15 px, body and human input value 14 px / 1.55, label and
  subtitle 12 px, badge 11 px. 11 px is the floor: Traditional Chinese
  strokes blur below it. Numeric readouts and icons are sized for the datum
  or glyph and are deliberately outside this ladder.
- Layout: a single 58 px top navigation bar carrying the six primary sections
  on dark chrome (`#131722`); there is no left rail. Content max-width
  1,440 px, 16–28 px page padding, 8–18 px component gaps, 36–40 px form
  controls.
- Responsive behavior: 1,100 px collapses multi-column work areas, 820 px
  collapses dense grids and preserves horizontal table scrolling, and 720 px
  goes single-column. The nav strip never wraps or collapses into a rail: it
  scrolls horizontally inside its own container so all six sections stay
  reachable at 390 px.
- Any block whose element count does not divide its column count uses
  `auto-fit` rather than a fixed track: a five-tile strip in a four-column
  grid leaves a visible hole.
- Interaction: every input/select keeps focus while typing or choosing; destructive
  actions are explicit and confirmable; deleting a custom watchlist group never
  deletes its instruments from another group or from the global saved watchlist.
- Palette: neutral paper-like surfaces, dark terminal navigation, blue primary
  action, and restrained red/green/yellow status colors. Avoid gradients and
  dashboard-only decoration on research data blocks.

This section is the canonical UI decision for the shared dashboard CSS. The
implementation may add page-specific classes only when they preserve this
hierarchy and responsive contract.

## Research planning and tracking prototype v1

Decision: `TQR-IA-003` (supersedes `TQR-IA-002`)
Status: active
Authority: [`docs/tqr-research-platform-spec.md`](tqr-research-platform-spec.md)

This decision defines the value research workspace without widening the product
into an automatic strategy service. The work areas are a watchlist comparison
surface ordered by discount to Base fair value, a Bear/Base/Bull valuation
worksheet with a staged buy ladder, a staged buy plan, and a monthly/quarterly
thesis review. The formula/condition draft editor and the validation-settings
report surface are retired. Financial tracking keeps human-entered industry,
observation status, score, and notes as local drafts; official financial fields
remain unavailable until their free-source and PIT contracts are admitted.

The detailed IA, field availability, formula editor, validation settings,
wireframes, and acceptance criteria have exactly one authority: the linked
specification. The five named documentation entry points are navigational
pointers only and must not redefine these decisions.
