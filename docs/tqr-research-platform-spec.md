# TQR research planning and tracking prototype v1

Authority: `docs/tqe-product-boundary.md#research-planning-and-tracking-prototype-v1`
Decision: `TQR-IA-002`
Status: active

## Purpose and hard boundary

TQR is a personal Taiwan-stock research workbench. It helps a human maintain a
watchlist, preserve free reference data locally, inspect a price chart, track
financial evidence, record a research thesis, configure a calculation draft,
and review a human-run research result.

This specification does **not** authorize real-time quotes, paid sources,
provider credentials, broker connectivity, order placement, unattended
screening, automatic promotion, or a claim that a draft rule is an investment
decision. Every calculated or imported value must remain traceable to its
source, period, retrieval time, `available_at`, and data-quality state.

## IA map

| Area | Screen | P1 purpose | Current data mode |
| --- | --- | --- | --- |
| 行情 | 市場首頁 | command centre: self-selected symbols, data update, research shortcuts | local EOD / desktop update |
| 行情 | 行情分析 | K line, price, indicators, drawing and quick watchlist controls | local K line |
| 行情 | 我的自選 | comparison table, group management, symbol search and local save | local watchlist + K line |
| 行情 | 技術指標 | MA, EMA, RSI, MACD and coverage explanation | derived from local K line |
| 研究計畫 | 因子與公式 | filter shortcuts plus auditable formula-rule drafts | UI draft; no automatic execution |
| 研究計畫 | 財務追蹤 | financial tracker, official-observation table and human review | source-gated; manual draft allowed |
| 研究計畫 | 驗證報告 | PIT-safe validation settings and saved research report | settings draft + existing read-only result |
| 記錄 | 研究筆記 | thesis, support, counter-evidence and next review | local notes |
| 記錄 | 資料來源 | provenance, snapshot and quality inspection | read-only evidence |

The full conceptual roadmap also includes market regime, entry signals,
tranche planning, risk limits, and data quality. In P1 these are represented
as formula/settings vocabulary only. They do not create background jobs or
automated trading behaviour.

## Data availability vocabulary

| State | UI treatment | Meaning |
| --- | --- | --- |
| `available` | value plus source / period / `available_at` | admitted, usable record |
| `unadmitted` | value may be visible as evidence, never as a calculation input | source or quality gate rejected it |
| `invalid` | error state and reason code | record failed validation |
| `unavailable` | em dash and an explicit source gap | no admitted data; never estimate from price |
| `draft` | local human setting | non-authoritative personal input, not an official datum |

The P1 financial tracker must use `unavailable` for monthly revenue, EPS,
margin, ROE, cash flow, TTM valuation, and percentile valuation until their
free-source, normalization, PIT, and quality contracts are admitted. Forward
EPS/PE is unavailable in this product phase. `Close` is the only current
price basis; `Adjusted Close` remains disabled until the adjusted OHLCV and
volume policy is approved.

## Field dictionary

### Market and price

The future dictionary includes index close, 1/5/20/60-day and YTD return,
drawdown from all-time high, MA 5/10/20/60/120/240, price-to-MA deviation,
MACD, RSI 14, ATR 14, historical volatility, maximum drawdown, volume ratio,
advance/decline breadth, and external-risk fields.

Only individual-symbol local K line indicators are available in P1. Market
breadth, institutional flows, VIX, DXY, US 10-year yield, FX, and futures
position need separately admitted sources and must render as unavailable until
then.

### Observation pool and comparison

Each tracked symbol has: identifier, company name, market, industry theme,
subindustry, watch status, manual note, market cap, price statistics, rolling
returns, moving averages, price deviation, Z-score, historical percentile,
relative strength, liquidity, and data status.

P1 permits the following manual fields in a local prototype draft:

- Industry theme: Power Infrastructure, Server Interconnect, Passive
  Components, Memory, Edge AI, or Other.
- Watch status: 核心持續追蹤, 等待合理估值, 等待止跌, 基本面待確認, 暫停觀察, or 排除.
- Human fundamental score: 1–5, or unset.
- Human note: support, counter-evidence, one-off income, and next review.

Z-score is `(price - N-period mean) / N-period standard deviation`. Its
period, price basis, and population/sample convention must be recorded before
it becomes a computed field. P1 exposes the setting vocabulary but does not
claim a calculation result without an admitted price-policy contract.

### Fundamentals and valuation

The planned groups are operating growth (monthly/quarterly revenue and EPS),
profit quality (gross/operating/net margin, ROE, ROA), financial quality (cash
flow, debt, inventory, receivables, capex, shares), and valuation (trailing or
PIT TTM PE, PB, PS, EV/EBITDA, earnings/dividend yield, historical percentiles
and user-entered fair-value assumptions).

Any fair-value worksheet must show its EPS source, PE source, safety margin,
formula version, and data status. A manual input is labelled `draft`; it must
not be represented as a market consensus or an official forward estimate.

## Formula and factor draft contract

Decision: `TQR-FORMULA-002`

A formula row contains:

```text
[enabled] [data category] [field] [operator] [comparison type] [value] [period]
```

Supported UI categories are price, return, moving average, momentum,
volatility, volume, fundamentals, valuation, market, regime, and manual
fields. Supported operator vocabulary is `>`, `>=`, `<`, `<=`, `=`, `!=`,
`Between`, `Not Between`, `Cross Above`, `Cross Below`, `Increase`,
`Decrease`, `Consecutive Increase`, `Consecutive Decrease`, `Is True`,
`Is False`, `Is Null`, and `Is Not Null`.

Comparison types are fixed numeric value, another field, historic mean,
historic median, historic percentile, industry mean, market value, previous
period, and a declared custom formula. Logical composition supports AND, OR,
NOT, and nested groups in the specification. P1 makes individual rows
interactive but does not execute nested logic or derive missing inputs.

Factor mode is either a hard filter or a soft score. A future factor definition
records name, source field, direction, transformation, weight, missing-value
policy, lower/upper bounds, and enabled state. A total score is a human-run
research calculation, never an automatic action.

## Regime, signal, tranche, and risk vocabulary

P1 regime values are `Risk-on`, `Correction`, `Risk-off`, and `Unknown`.
Potential future regime inputs are index/MA relationships, rolling return,
volatility, breadth, futures positioning, and VIX. They remain unavailable
unless the required source is admitted.

The planning vocabulary includes observation, first/second/third tranche,
stop-adding, and fundamental invalidation; allocation methods may be fixed,
Z-score, valuation, drawdown, inverse volatility, regime, or custom. Risk
settings include concentration, cash, drawdown, liquidity, loss, and exit
limits. These are explicit human plans in P1, not an execution engine.

## Validation settings and report contract

Decision: `TQR-VALIDATION-002`

The validation-settings draft records universe, start/end date when admitted,
benchmark, rebalance frequency, signal time, fill time, fee, tax, slippage,
minimum trade value, maximum positions, and fractional-share policy. The UI
must make this invariant visible:

```text
signal uses data available after market close
-> fill is next open / next VWAP / next close
```

It must reject the invalid combination “use today close data and fill at today
close”. A saved report may present return, CAGR, benchmark/excess return,
win-rate, volatility, Sharpe, Sortino, drawdown, Calmar, VaR/CVaR, turnover,
holding days, costs, factor IC, regime/year breakdown, sensitivity, and sample
size only when those values belong to a reproducible saved result.

## Wireframe and responsive contract

Decision: `TQR-WIREFRAME-002`

Every screen uses the shared terminal shell: fixed desktop navigation, 62 px
top bar, one page header, one card hierarchy, 36–40 px controls, and table
overflow only inside a `.table-responsive` wrapper.

The watchlist command area is divided into four non-overlapping regions:

1. Current/new group management.
2. Symbol search and the primary “加入自選” action.
3. Clear/save actions.
4. Persistence status.

At wide widths the regions may share a row. At the actual content-container
width below 1040 px they become separate rows; at 620 px group and action
controls stack; at 420 px destructive/create controls take their own row. A
search-result overlay must never intercept the primary add action.

Formula, financial-review, and validation-setting forms use the same rule:
wide grids may collapse to 3-column, 2-column, then 1-column form regions;
no input, select, label, or button may overlap. Tables may scroll horizontally
inside their own wrappers, but the application document must not gain a
horizontal scrollbar.

## Acceptance criteria

- User can add/remove a symbol with a regular click and can select a watchlist
  group without holding the mouse button.
- Deleting a custom group asks for confirmation and cannot delete the default
  group or instruments in another group.
- The formula editor can add/remove a row and edit its field values as a local
  draft without starting a calculation.
- The financial tracker and validation settings can save a local prototype
  draft; they clearly identify it as non-official input.
- At 1440, 1280, 1024, 820, 720, and 390 px, the watchlist regions do not
  overlap and `documentElement.scrollWidth <= innerWidth`.
- Browser smoke reports no page errors and no non-loopback/external requests.
- Unit, deterministic preflight, dashboard preview, and public-tree audit
  continue to pass before any PR or release is proposed.
