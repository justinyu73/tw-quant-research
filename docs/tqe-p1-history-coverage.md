# TQE P1 history and coverage contract

P1 makes K-line depth inspectable in the read model. The read model does not
acquire a provider feed or fill missing bars. A separate human-run capture
utility can create an explicitly bounded local snapshot for replay.

## Read-model fields

`kline.coverage` is an additive part of the existing read-only model:

- `bar_count`: number of admitted bars for the selected period;
- `first_trading_date` / `last_trading_date`: actual observed session range;
- `observed_session_count`: unique sessions represented by those bars;
- `expected_session_count`: expected count only when a source calendar was
  explicitly supplied, otherwise `null`;
- `missing_session_count`: sessions declared by the calendar but not observed;
- `calendar_status`: `complete`, `partial`, or `not_supplied`;
- `depth_status`: `ready`, `insufficient`, or `empty`, based on the configured
  MA/EMA windows;
- `minimum_bars_for_indicators` and `indicator_ready`: the exact depth needed
  by the currently exposed studies.

The existing `quality.status` and `reason_codes` remain authoritative. A
coverage summary explains why an apparently valid source row may still be
`partial` for chart studies. The browser only renders this read model; it does
not calculate indicators or infer a trading calendar.

## Current fixture result

The committed desktop K6a/K6b snapshots remain shallow for the broad market
catalog, but the bounded `TWSE:2330` history artifact now contains 359 official
TWSE daily bars from `2025-01-02` through `2026-06-30`; the existing
`2026-07-15` snapshot extends the replay model to 360 bars. Its 1D model is
`ready` for MA, EMA, RSI, MACD, KD, and ATR. Weekly/monthly/quarterly calendar
states remain explicit `partial` until a calendar contract is admitted.

## Acceptance

The contract is covered by `tests/test_k3_kline_read_model.py`,
`tests/test_desktop_sidecar.py`, `tests/test_capture_twse_stock_day.py`, and
the dashboard browser smoke. The accepted runtime boundary is research-only,
GET/read-only, local fixture-backed, and free of provider calls; capture is a
separate human-run acquisition step.
