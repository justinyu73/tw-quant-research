"""Explicit corporate-action validation and forward price adjustment for S5."""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping

from tw_quant_engine.data_contract import ContractError, validate_record


PRICE_MULTIPLIER_CONVENTION = "price_multiplier_after_ex_date"
ADJUSTMENT_POLICY = "tqe-adjusted-ohlcv-volume/v1"
SHARE_COUNT_ACTIONS = frozenset({"split", "reverse_split", "bonus_issue"})
CASH_DIVIDEND_ACTIONS = frozenset({"cash_dividend"})


class CorporateActionError(ValueError):
    """Raised when corporate-action semantics are not explicitly admitted."""


def _as_of(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
        parsed = datetime.fromisoformat(candidate)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise CorporateActionError("as_of must include an explicit timezone")
    return parsed.astimezone(timezone.utc)


def _decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise CorporateActionError(f"invalid numeric value: {value!r}") from exc


def validate_action(action: Mapping[str, Any], *, convention: str) -> dict[str, Any]:
    if convention != PRICE_MULTIPLIER_CONVENTION:
        raise CorporateActionError("corporate-action factor convention is not admitted")
    try:
        normalized = validate_record(action)
    except ContractError as exc:
        raise CorporateActionError(str(exc)) from exc
    if normalized["record_type"] != "corporate_action":
        raise CorporateActionError("action record_type must be corporate_action")
    return normalized


def adjustment_factor(
    trading_date: str,
    actions: Iterable[Mapping[str, Any]],
    *,
    convention: str,
    as_of: str | datetime,
) -> Decimal:
    if convention != PRICE_MULTIPLIER_CONVENTION:
        raise CorporateActionError("corporate-action factor convention is not admitted")
    target_date = date.fromisoformat(trading_date)
    cutoff = _as_of(as_of)
    factor = Decimal("1")
    for action in actions:
        normalized = validate_action(action, convention=convention)
        available = _as_of(normalized["available_at"])
        if available > cutoff:
            continue
        if date.fromisoformat(normalized["ex_date"]) > target_date:
            factor *= _decimal(normalized["factor"])
    return factor


def adjust_close(
    raw_close: Any,
    trading_date: str,
    actions: Iterable[Mapping[str, Any]],
    *,
    convention: str,
    as_of: str | datetime,
) -> dict[str, Any]:
    raw = _decimal(raw_close)
    factor = adjustment_factor(trading_date, actions, convention=convention, as_of=as_of)
    return {
        "raw_close": float(raw),
        "adjustment_factor": float(factor),
        "adjusted_close": float(raw * factor),
        "convention": convention,
    }


def adjust_ohlcv(
    ohlcv: Mapping[str, Any],
    trading_date: str,
    actions: Iterable[Mapping[str, Any]],
    *,
    convention: str,
    as_of: str | datetime,
) -> dict[str, Any]:
    """Derive adjusted OHLCV without mutating the raw bar."""
    if convention != PRICE_MULTIPLIER_CONVENTION:
        raise CorporateActionError("corporate-action factor convention is not admitted")
    required = ("open", "high", "low", "close", "volume")
    if any(field not in ohlcv for field in required):
        raise CorporateActionError("OHLCV must contain open, high, low, close, and volume")
    raw = {field: _decimal(ohlcv[field]) for field in required}
    price_factor = Decimal("1")
    volume_factor = Decimal("1")
    action_snapshot_ids: list[str] = []
    target_date = date.fromisoformat(trading_date)
    cutoff = _as_of(as_of)
    normalized_actions = [validate_action(action, convention=convention) for action in actions]
    for action in sorted(normalized_actions, key=lambda item: (item["ex_date"], item["snapshot_id"])):
        available = _as_of(action["available_at"])
        if available > cutoff or date.fromisoformat(action["ex_date"]) <= target_date:
            continue
        factor = _decimal(action["factor"])
        if factor <= 0:
            raise CorporateActionError("corporate-action factor must be positive")
        action_type = action["action_type"]
        if action_type in SHARE_COUNT_ACTIONS:
            price_factor *= factor
            volume_factor /= factor
        elif action_type in CASH_DIVIDEND_ACTIONS:
            price_factor *= factor
        else:
            raise CorporateActionError(f"volume policy is not admitted for action type: {action_type}")
        action_snapshot_ids.append(action["snapshot_id"])
    adjusted = {
        "open": raw["open"] * price_factor,
        "high": raw["high"] * price_factor,
        "low": raw["low"] * price_factor,
        "close": raw["close"] * price_factor,
        "volume": raw["volume"] * volume_factor,
    }
    return {
        "raw_ohlcv": {field: float(value) for field, value in raw.items()},
        "adjusted_ohlcv": {field: float(value) for field, value in adjusted.items()},
        "price_adjustment_factor": float(price_factor),
        "volume_adjustment_factor": float(volume_factor),
        "adjustment_policy": ADJUSTMENT_POLICY,
        "action_snapshot_ids": action_snapshot_ids,
    }


__all__ = [
    "ADJUSTMENT_POLICY",
    "CorporateActionError",
    "PRICE_MULTIPLIER_CONVENTION",
    "adjust_close",
    "adjustment_factor",
    "adjust_ohlcv",
    "validate_action",
]
