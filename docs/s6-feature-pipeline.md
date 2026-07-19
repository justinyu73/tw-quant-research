# S6 — Deterministic point-in-time feature pipeline

S6 uses admitted S5/S2 records offline. It first applies the S2 `as_of`
visibility rule and then excludes rows whose `trading_date` is later than the
cutoff. It computes only raw-price features; S5 corporate-action adjustment is
not silently applied.

Feature version: `s6-v1`.

| feature | formula | window | missing rule |
|---|---|---:|---|
| `return_1d` | `close_t / close_t-1 - 1` | 1 observation | `insufficient_window` |
| `return_5d` | `close_t / close_t-5 - 1` | 5 observations | `insufficient_window` |
| `volatility_5d` | population stddev of the five 1d returns ending at t | 5 returns | `insufficient_window` |
| `volume_mean_5d` | mean of current and previous four volumes | 5 observations | `insufficient_window` |

No nearest-period substitution, forward-fill, partial window, future row,
or adjusted-price substitution is allowed. Every feature row carries the
`as_of`, formula version, raw-price basis, and contributing snapshot IDs.
