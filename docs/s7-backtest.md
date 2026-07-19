# S7 — Provider-neutral research backtest

S7 is a deterministic long-only research loop. A target signal observed on
trading date `t` executes only at the next visible bar's open. The engine does
not place orders, call a provider, or claim investment performance.

Execution prices are explicit:

```text
buy_price  = open * (1 + slippage_bps / 10000)
sell_price = open * (1 - slippage_bps / 10000)
fee        = gross_notional * transaction_cost_bps / 10000
```

The baseline uses all available cash for a long position, no leverage, no
shorting, and no signal execution on the final bar. Metrics include cumulative
return, annualized return with an explicit 365-day convention, max drawdown,
turnover, and trade count. The trade ledger retains signal date, execution
date, price, quantity, fees, slippage, and signal snapshot ID.
