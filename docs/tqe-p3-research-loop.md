# TQE P3 research loop

P3 connects three local, inspectable concepts:

```text
grouped watchlist → ScreenSpec → approved product read model → StrategySpec review
```

## Grouped watchlist

The desktop session can create and switch groups, and a symbol can belong to
the active group. The persisted Tauri payload remains the existing v1 flat
`items` schema; group membership is explicitly session-local until a separate
schema and migration approval exists.

## ScreenSpec

The linked screener filters only the approved `view.products` read model by
quality, market, and bounded row count. The typed spec is rendered in the UI
and the result button adds a canonical instrument id to the active session
group. It does not infer fundamentals from bars or call a remote provider.

## StrategySpec

P3 emits a visible research-only handoff contract with human-review entry,
unconfigured exit, and `not_admitted` execution status. This is deliberately a
review seam, not a backtest submission, alert, broker connector, or order
workflow.

## Acceptance

`tests/dashboard-core.test.cjs` covers group and screen helpers. The browser
smoke covers group creation, linked result addition, ScreenSpec application,
StrategySpec visibility, and the existing watchlist/K-line flows. The next
runtime capabilities remain a separate boundary in P4.
