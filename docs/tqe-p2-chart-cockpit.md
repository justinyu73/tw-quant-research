# TQE P2 chart cockpit

P2 turns the existing local chart surface into a small research cockpit while
keeping the repository boundary read-only for market data.

## Implemented surface

- Lightweight Charts 5.2 is used from the bundled local asset.
- Candles are in the main pane; volume is a separate lower pane. RSI, MACD,
  KD, and ATR render in a study pane when selected. MA and EMA remain overlays
  on the price pane.
- Fit, zoom in, and zoom out call the chart time scale. Normal chart drag and
  wheel interactions remain available from the chart library.
- The study registry is explicit: MA, EMA, RSI, MACD, KD, ATR, and volume. The
  formulas and admission windows are generated in the Python read model and
  tested before the browser renders them.
- `標記 Draw` is a session-local marker tool. A chart click adds an above-bar
  marker and `清除` removes the current chart's markers. Drawings are not
  persisted to the sidecar or silently synced anywhere.
- `模板 default/research` is a session-local layout/study preset toggle. It is
  intentionally not a cloud or file persistence feature.
- The K-line card also exposes a technical-readings strip for the latest
  admitted MA(5), EMA(20), RSI(14), and MACD values, so a visible line and its
  numeric readout can be checked together.

## Acceptance

`tests/test_k3_kline_read_model.py` verifies study windows and formulas;
`tests/test_k4_kline_ui_contract.py` verifies the local chart contract; and
`scripts/dashboard-browser-smoke.cjs` exercises Fit/Zoom, a study switch, a
draw marker, template toggle, Symbol Search, period switching, and responsive
overflow.

The broad K6a/K6b catalog remains one-date per instrument, but the local
`TWSE:2330` replay artifact now gives the 1D chart 360 bars and admitted
technical readings. Other periods can still report `partial` when their
calendar or study window is not available; the UI does not fill those states.
