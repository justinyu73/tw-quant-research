"""Small provider-neutral, research-only backtest loop for S7."""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping

from tw_quant_engine.data_contract import ContractError, PointInTimeDataset, validate_record


BACKTEST_SCHEMA = "tw-quant-engine-backtest-result/v1"


class BacktestError(ValueError):
    """Raised when a backtest would violate a research safety boundary."""


@dataclass(frozen=True)
class BacktestConfig:
    initial_cash: float = 100000.0
    transaction_cost_bps: float = 0.0
    slippage_bps: float = 0.0
    calendar_days_per_year: int = 365

    def __post_init__(self) -> None:
        if self.initial_cash <= 0:
            raise BacktestError("initial_cash must be positive")
        if self.transaction_cost_bps < 0 or self.slippage_bps < 0:
            raise BacktestError("transaction cost and slippage must be non-negative")
        if self.calendar_days_per_year <= 0:
            raise BacktestError("calendar_days_per_year must be positive")


def _decimal(value: Any, field: str) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise BacktestError(f"{field} is not numeric") from exc
    if not parsed.is_finite():
        raise BacktestError(f"{field} is not finite")
    return parsed


def _timestamp(value: str) -> datetime:
    candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(candidate)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise BacktestError("signal available_at must include timezone")
    return parsed.astimezone(timezone.utc)


def _metric(values: list[Decimal], config: BacktestConfig, final_equity: Decimal, initial: Decimal, days: int) -> dict[str, float | int | None]:
    peak = values[0]
    max_drawdown = Decimal("0")
    for value in values:
        peak = max(peak, value)
        max_drawdown = min(max_drawdown, value / peak - Decimal("1"))
    cumulative = final_equity / initial - Decimal("1")
    annualized = None
    if days > 0:
        annualized = float((final_equity / initial) ** (Decimal(config.calendar_days_per_year) / Decimal(days)) - Decimal("1"))
    return {
        "cumulative_return": float(cumulative),
        "annualized_return": annualized,
        "max_drawdown": float(max_drawdown),
        "trade_count": 0,
    }


def run_backtest(
    price_bars: Iterable[Mapping[str, Any]],
    provenance: Iterable[Mapping[str, Any]],
    signals: Iterable[Mapping[str, Any]],
    *,
    as_of: str,
    config: BacktestConfig,
) -> dict[str, Any]:
    """Run a long-only target-position loop with next-bar-open execution."""
    visible = PointInTimeDataset(price_bars, provenance).as_of(as_of)
    bars = sorted(
        [validate_record(row) for row in visible if row["record_type"] == "price_bar"],
        key=lambda row: row["trading_date"],
    )
    if not bars:
        raise BacktestError("no visible price bars")
    security_ids = {row["security_id"] for row in bars}
    if len(security_ids) != 1:
        raise BacktestError("S7 baseline requires one security at a time")
    cutoff = _timestamp(as_of)
    signal_by_date: dict[str, dict[str, Any]] = {}
    for signal in signals:
        if signal.get("status") != "admitted":
            raise BacktestError("unadmitted signal cannot trade")
        signal_date = str(signal.get("signal_date"))
        if signal_date not in {bar["trading_date"] for bar in bars}:
            raise BacktestError(f"signal date is not a visible trading date: {signal_date}")
        available_at = _timestamp(str(signal.get("available_at")))
        if available_at > cutoff:
            continue
        target = signal.get("target_position")
        if target not in (0, 1):
            raise BacktestError("target_position must be 0 or 1")
        if signal_date in signal_by_date and signal_by_date[signal_date] != signal:
            raise BacktestError(f"conflicting signals on {signal_date}")
        signal_by_date[signal_date] = dict(signal)

    initial = _decimal(config.initial_cash, "initial_cash")
    cash = initial
    quantity = Decimal("0")
    position = 0
    pending: dict[str, Any] | None = None
    trades: list[dict[str, Any]] = []
    equity_curve: list[dict[str, Any]] = []
    cost_rate = Decimal(str(config.transaction_cost_bps)) / Decimal("10000")
    slippage_rate = Decimal(str(config.slippage_bps)) / Decimal("10000")

    for index, bar in enumerate(bars):
        if pending is not None:
            target = pending["target_position"]
            if target != position:
                raw_open = _decimal(bar["open"], "open")
                if target == 1:
                    execution_price = raw_open * (Decimal("1") + slippage_rate)
                    quantity = cash / (execution_price * (Decimal("1") + cost_rate))
                    gross = quantity * execution_price
                    fee = gross * cost_rate
                    cash -= gross + fee
                    position = 1
                    side = "buy"
                else:
                    execution_price = raw_open * (Decimal("1") - slippage_rate)
                    gross = quantity * execution_price
                    fee = gross * cost_rate
                    cash += gross - fee
                    quantity = Decimal("0")
                    position = 0
                    side = "sell"
                trades.append(
                    {
                        "signal_date": pending["signal_date"],
                        "execution_date": bar["trading_date"],
                        "side": side,
                        "execution_price": float(execution_price),
                        "quantity": float(quantity if side == "buy" else gross / execution_price),
                        "gross_notional": float(gross),
                        "fee": float(fee),
                        "slippage_bps": config.slippage_bps,
                        "transaction_cost_bps": config.transaction_cost_bps,
                        "signal_snapshot_id": pending.get("snapshot_id"),
                    }
                )
            pending = None

        close = _decimal(bar["close"], "close")
        equity = cash + quantity * close
        equity_curve.append(
            {
                "trading_date": bar["trading_date"],
                "cash": float(cash),
                "quantity": float(quantity),
                "position": position,
                "equity": float(equity),
            }
        )

        signal = signal_by_date.get(bar["trading_date"])
        if signal is not None and signal["target_position"] != position:
            if index == len(bars) - 1:
                raise BacktestError("signal on final bar has no next-bar execution")
            pending = {
                "signal_date": bar["trading_date"],
                "target_position": signal["target_position"],
                "snapshot_id": signal.get("snapshot_id"),
            }

    final_equity = Decimal(str(equity_curve[-1]["equity"]))
    days = (date.fromisoformat(bars[-1]["trading_date"]) - date.fromisoformat(bars[0]["trading_date"])).days
    metrics = _metric([Decimal(str(row["equity"])) for row in equity_curve], config, final_equity, initial, days)
    metrics["trade_count"] = len(trades)
    metrics["turnover"] = float(sum(Decimal(str(trade["gross_notional"])) for trade in trades) / initial)
    return {
        "schema": BACKTEST_SCHEMA,
        "as_of": cutoff.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "config": {
            "initial_cash": config.initial_cash,
            "transaction_cost_bps": config.transaction_cost_bps,
            "slippage_bps": config.slippage_bps,
            "calendar_days_per_year": config.calendar_days_per_year,
        },
        "equity_curve": equity_curve,
        "trades": trades,
        "metrics": metrics,
    }


def backtest_digest(result: Mapping[str, Any]) -> str:
    encoded = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


__all__ = ["BACKTEST_SCHEMA", "BacktestConfig", "BacktestError", "backtest_digest", "run_backtest"]
