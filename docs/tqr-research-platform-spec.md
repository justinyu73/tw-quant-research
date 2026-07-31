# TQR value research workspace v1

Authority: `docs/tqe-product-boundary.md#research-planning-and-tracking-prototype-v1`
Decision: `TQR-IA-003`
Status: active
Supersedes: `TQR-IA-002`, `TQR-FORMULA-002`, `TQR-VALIDATION-002`

## Product definition and hard boundary

Value Research Workspace is a personal Taiwan-stock **value investing** research
app. It answers exactly three questions for one company at a time:

1. Is the business still growing on a fundamental basis?
2. What is it reasonably worth?
3. Which staged buy band is the current price in?

It is **not** an automatic trading system, a quantitative trading platform, a
factor-trading system, a TradingView clone, a technical-analysis dashboard, an
AI stock picker, or a backtest performance showcase.

This specification does not authorize real-time quotes, paid sources, provider
credentials, broker connectivity, order placement, unattended screening,
automatic promotion, or any claim that a draft rule is an investment decision.
Every calculated or imported value must remain traceable to its source, period,
retrieval time, `available_at`, and data-quality state.

## Evaluation order

```text
company operations -> financial reports -> growth assumptions -> fair value
  -> margin of safety -> staged buy prices -> comparison against market price
```

Market price is a comparison basis only. Two inferences are forbidden:

- price fell, therefore future earnings will fall;
- price halved, therefore the company is cheap.

Market context (index moves, sector moves, panic) may be displayed to explain
*why* a price moved and to help judge mispricing, but must never feed a fair
value. Automatically cutting EPS because of market fear is prohibited.

## IA map

Primary navigation is exactly six sections. Adding a seventh requires a new
decision id.

| Screen | Purpose | Current data mode |
| --- | --- | --- |
| Home | which companies are near my buy price today | derived from local valuation + local EOD |
| Watchlist | main work surface: value, discount, buy stage per company | local watchlist + EOD + user valuation |
| Company | one company: thesis, fundamentals, trend, price reference | local notes + EOD; fundamentals unavailable |
| Valuation | Bear/Base/Bull EPS x PE, buy bands, valuation basis | user assumptions only |
| Buy Plan | budget, staged prices, staged ratios, reached-price prompt | derived from valuation ladder |
| Review | monthly/quarterly thesis review and outcome | local records |

`資料來源` (provenance) and `設定` remain reachable from inside a page. They are
not primary navigation and must not redefine any decision here.

Sorting on Home and Watchlist uses **discount to Base fair value only**. MACD
scores, momentum scores, AI recommendation scores, sentiment scores, and blended
quant scores are prohibited as ordering keys.

## Data availability vocabulary

| State | UI treatment | Meaning |
| --- | --- | --- |
| `available` | value plus source / period / `available_at` | admitted, usable record |
| `unadmitted` | visible as evidence, never as a calculation input | source or quality gate rejected it |
| `invalid` | error state and reason code | record failed validation |
| `unavailable` | em dash and an explicit source gap | no admitted data; never estimate from price |
| `draft` | local human setting | non-authoritative personal input, not an official datum |

Monthly revenue, EPS, gross/operating/net margin, ROE, ROA, cash flow, TTM
valuation, and percentile valuation are `unavailable` until their free-source,
normalization, PIT, and quality contracts are admitted. Forward EPS/PE is
unavailable in this product phase. `Close` is the only current price basis;
`Adjusted Close` remains disabled until the adjusted OHLCV and volume policy is
approved.

## Valuation contract

Decision: `TQR-VALUATION-003`
Implementation: `src/tw_quant_engine/valuation.py`, schema
`tqr-scenario-valuation-worksheet/v1`.

There is exactly one valuation model:

```text
scenario fair value = scenario EPS x scenario PE     for scenario in {bear, base, bull}
```

All three scenarios are required; a single point estimate is rejected. EPS and PE
are user-supplied assumptions labelled `draft` with
`assumption_source = user_supplied_assumption`. They are never presented as
official data, market consensus, or an analyst estimate, and no calculation may
overwrite them.

The staged buy ladder is always a ratio of the **Base** fair value, never of a
price high or a moving average:

| Band | Default ratio |
| --- | --- |
| 觀察區 | 0.90 |
| 第一階段 | 0.85 |
| 第二階段 | 0.80 |
| 甜蜜區 | 0.75 |
| 極端錯價 | 0.65 |

Ratios are editable per company and must decrease monotonically from 觀察區 to
極端錯價. Band membership is inclusive at the ratio: a price exactly at
`base x 0.85` is 第一階段.

Every worksheet records its basis, so a price move can never silently become the
reason a fair value changed:

`eps_period`, `eps_kind` (`actual` | `estimate`), `pe_rationale`,
`financial_data_date`, `valuation_date`, `change_reason`.

## Buy plan contract

Decision: `TQR-BUYPLAN-003`
Store: `tqr-buy-plans/v1`, local only.

Fields: total budget, allocation percent for 第一階段 / 第二階段 / 甜蜜區 /
保留資金, and portfolio maximum position. Allocations plus reserve must total
100%. Stage prices are taken from the valuation ladder; they are never derived
from market price or historical highs.

When price reaches a band the app prints exactly one kind of message:

```text
價格已進入<band>區間。請確認投資假設是否仍成立。
```

`建議立即買進`, `強力買進`, and any confidence score are prohibited. There is no
order, simulated order, broker, or credential code path.

## Company workspace contract

Five sections, in this order: Thesis, Fundamental Snapshot, Trend Table,
Valuation Summary, Price Reference.

Thesis is structured, not free text: 投資摘要, 成長驅動, 競爭優勢, 產業位置,
風險, Thesis 失效條件, plus a last-checked date. Free-form research notes sit
below it and never feed a calculation.

### Trend Table depth

Source contract: [`tqr-fundamentals-source-contract.md`](tqr-fundamentals-source-contract.md)
Decision: `TQR-FUNDAMENTALS-SOURCE-001`
Verified: 2026-07-31

Every admitted free endpoint returns a **latest-period snapshot only** (one
distinct period per response). "最近 8 季" and "最近 12 個月" therefore cannot be
produced from one fetch. The table renders whatever periods have actually been
captured, labelled `n of 8`; it must never pad, interpolate, or carry a period
forward. Until a capture path is approved it keeps its `unavailable` empty state.

`available_at` for these sources is the exchange's batch export date (出表日期 /
`Date`), which is later than the true filing date and therefore PIT-safe.
`published_at` stays null; labelling the export date as a company publication
time is prohibited.

Price Reference (K line) is the last block on the page and exists only to show
historical price position, prior highs/lows, and drawdown. MACD, RSI, KD, and
Bollinger bands are off by default, may be enabled manually, and never
participate in a value judgement. There is no standalone technical-indicator
screen.

## Review contract

Decision: `TQR-REVIEW-003`
Store: `tqr-reviews/v1`, local only.

Five questions per review — revenue, EPS, margin, outlook, thesis — each answered
`符合` / `偏離` / `待確認`, plus one outcome from 維持估值 / 上調合理價值 /
下調合理價值 / 暫停買進 / 投資假設失效, plus a review date. A review cannot be
saved until every question is answered and an outcome is chosen. History is
retained so a past conclusion keeps its date and reasoning.

## AI boundary

AI may summarize filings, extract revenue/EPS/margin, compare quarters, digest
earnings calls, surface fundamental changes, raise open questions, and help draft
Bear/Base/Bull scenarios.

AI may not decide a buy, modify a fair value, cut EPS because price fell, predict
price from news sentiment, output `必漲`/`必跌`, replace fundamental judgement
with chart reading, or emit an unexplainable blended score.

## Explicitly out of scope in v1

Automatic trading, broker APIs, high-frequency or tick data, minute-level
backtests, factor mining, alpha ranking, multi-factor models, ML price
prediction, Monte Carlo, complex DCF, technical-indicator strategies, automatic
stop-loss, AI bottom-calling, Bloomberg/TradingView clones.

## Wireframe and responsive contract

Decision: `TQR-WIREFRAME-003`

Every screen uses the shared terminal shell: fixed desktop navigation, one page
header, one card hierarchy, 34–40 px controls, and table overflow only inside a
`.table-responsive` wrapper.

The watchlist command area keeps four non-overlapping regions: group management;
symbol search plus the primary add action; clear/save actions; persistence
status. A search-result overlay must never intercept the primary add action.

Valuation, buy-plan, and review forms collapse from 3-column to 2-column at
1100 px and to 1-column at 720 px. No input, select, label, or button may
overlap. Tables may scroll horizontally inside their own wrappers, but the
document must never gain a horizontal scrollbar.

## Acceptance criteria

- Primary navigation renders exactly six sections in the order above, and no
  retired section (`research`, `backtest`, `features`, `products`, `market`,
  `fundamentals`, `stories`, `overview`) is reachable from it.
- A user can add/remove a watchlist symbol with a regular click and select a
  group without holding the mouse button; deleting a custom group asks for
  confirmation and cannot delete the default group.
- Before any valuation exists, 合理價值 / 折價 / 買進價 columns render `—`;
  after a Base worksheet is evaluated they render real numbers and a stage.
- A valuation worksheet cannot be added without all three scenarios, a
  monotonic ratio ladder, an EPS period, an EPS kind, and a valuation date.
- A buy plan cannot be saved unless allocations plus reserve total 100%, and
  stage prices equal the valuation ladder.
- A review cannot be saved until all five questions are answered and an outcome
  is chosen; saved reviews appear in history with their date.
- No actionable control anywhere carries 下單 / 送單 / 回測 / 因子 / AI 信心 /
  強力買進 / 建議立即買進 text.
- At 1440, 1280, 1024, 820, 720, and 390 px the watchlist regions do not overlap
  and `documentElement.scrollWidth <= innerWidth`.
- Browser smoke reports no page errors and no non-loopback/external requests.
- Unit tests, deterministic preflight, research closure, and public-tree audit
  pass before any PR or release is proposed.
