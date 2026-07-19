"""Read-only K-line view model for the K3 slice."""
from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Mapping


KLINE_READ_MODEL_SCHEMA = "tw-quant-engine-kline-read-model/v1"
KLINE_READ_ONLY_ROUTES = frozenset({"/kline", "/kline/bars", "/kline/quality", "/kline/evidence"})


class KlineReadModelError(ValueError):
    """Raised when an aggregated K-line result cannot become a safe view model."""


def _timestamp(value: Any, field: str) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError as exc:
            raise KlineReadModelError(f"{field} must be an ISO timestamp") from exc
    else:
        raise KlineReadModelError(f"{field} must be an ISO timestamp")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise KlineReadModelError(f"{field} must include an explicit timezone")
    return parsed.astimezone(timezone.utc)


def _digest(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


def _indicator_values(bars: list[Mapping[str, Any]], period: int, *, exponential: bool) -> list[dict[str, Any]]:
    if period < 1:
        raise KlineReadModelError("indicator period must be positive")
    values: list[dict[str, Any]] = []
    previous: float | int | None = None
    for index, bar in enumerate(bars):
        key = bar.get("period_key")
        item: dict[str, Any] = {"period_key": key, "value": None, "status": "insufficient_window"}
        if index + 1 >= period:
            closes = [float(value["close"]) for value in bars[index + 1 - period : index + 1]]
            if exponential:
                if previous is None:
                    previous = sum(closes) / period
                else:
                    alpha = 2 / (period + 1)
                    previous = (alpha * float(bar["close"])) + ((1 - alpha) * previous)
                item["value"] = previous
            else:
                item["value"] = sum(closes) / period
            item["status"] = "admitted"
        values.append(item)
    return values


def _rsi_values(bars: list[Mapping[str, Any]], period: int = 14) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    closes = [float(bar["close"]) for bar in bars]
    for index in range(len(closes)):
        item: dict[str, Any] = {"period_key": bars[index].get("period_key"), "value": None, "status": "insufficient_window"}
        if index >= period:
            changes = [closes[offset] - closes[offset - 1] for offset in range(index - period + 1, index + 1)]
            gains = sum(max(change, 0.0) for change in changes) / period
            losses = sum(max(-change, 0.0) for change in changes) / period
            item["value"] = 100.0 if losses == 0 else 100.0 - (100.0 / (1.0 + gains / losses))
            item["status"] = "admitted"
        values.append(item)
    return values


def _atr_values(bars: list[Mapping[str, Any]], period: int = 14) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    true_ranges: list[float] = []
    for index, bar in enumerate(bars):
        previous_close = float(bars[index - 1]["close"]) if index else float(bar["close"])
        true_ranges.append(max(float(bar["high"]) - float(bar["low"]), abs(float(bar["high"]) - previous_close), abs(float(bar["low"]) - previous_close)))
        item: dict[str, Any] = {"period_key": bar.get("period_key"), "value": None, "status": "insufficient_window"}
        if index + 1 >= period:
            item["value"] = sum(true_ranges[index + 1 - period : index + 1]) / period
            item["status"] = "admitted"
        values.append(item)
    return values


def _kd_values(bars: list[Mapping[str, Any]], period: int = 9) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    k_values: list[dict[str, Any]] = []
    d_values: list[dict[str, Any]] = []
    previous_k = 50.0
    previous_d = 50.0
    for index, bar in enumerate(bars):
        key = bar.get("period_key")
        k_item: dict[str, Any] = {"period_key": key, "value": None, "status": "insufficient_window"}
        d_item: dict[str, Any] = {"period_key": key, "value": None, "status": "insufficient_window"}
        if index + 1 >= period:
            window = bars[index + 1 - period : index + 1]
            highest = max(float(item["high"]) for item in window)
            lowest = min(float(item["low"]) for item in window)
            rsv = 50.0 if highest == lowest else (float(bar["close"]) - lowest) / (highest - lowest) * 100.0
            previous_k = (2.0 * previous_k + rsv) / 3.0
            previous_d = (2.0 * previous_d + previous_k) / 3.0
            k_item["value"] = previous_k
            d_item["value"] = previous_d
            k_item["status"] = "admitted"
            d_item["status"] = "admitted"
        k_values.append(k_item)
        d_values.append(d_item)
    return k_values, d_values


def _macd_values(bars: list[Mapping[str, Any]], *, fast_period: int = 12, slow_period: int = 26, signal_period: int = 9) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    fast = _indicator_values(bars, fast_period, exponential=True)
    slow = _indicator_values(bars, slow_period, exponential=True)
    macd: list[dict[str, Any]] = []
    macd_numbers: list[float | None] = []
    for index, bar in enumerate(bars):
        value = None
        status = "insufficient_window"
        if fast[index]["value"] is not None and slow[index]["value"] is not None:
            value = float(fast[index]["value"]) - float(slow[index]["value"])
            status = "admitted"
        macd.append({"period_key": bar.get("period_key"), "value": value, "status": status})
        macd_numbers.append(value)
    signal: list[dict[str, Any]] = []
    previous: float | None = None
    for index, bar in enumerate(bars):
        item: dict[str, Any] = {"period_key": bar.get("period_key"), "value": None, "status": "insufficient_window"}
        if index + 1 >= signal_period:
            window = macd_numbers[index + 1 - signal_period : index + 1]
            if all(value is not None for value in window):
                if previous is None:
                    previous = sum(float(value) for value in window) / signal_period
                else:
                    alpha = 2 / (signal_period + 1)
                    previous = (alpha * float(window[-1])) + ((1 - alpha) * previous)
                item["value"] = previous
                item["status"] = "admitted"
        signal.append(item)
    return macd, signal


def _coverage(bars: list[Mapping[str, Any]], *, ma_period: int, ema_period: int) -> dict[str, Any]:
    """Summarize admitted history without filling or inferring sessions."""
    observed_sessions: list[str] = []
    expected_sessions: list[str] = []
    missing_sessions: list[str] = []
    period_keys: list[str] = []
    for index, bar in enumerate(bars):
        observed = bar.get("observed_sessions")
        if observed is None:
            observed = [bar.get("trading_date")]
        if not isinstance(observed, list) or any(not isinstance(value, str) or not value for value in observed):
            raise KlineReadModelError(f"bars[{index}].observed_sessions must be a list of date strings")
        expected = bar.get("expected_sessions") or []
        if not isinstance(expected, list) or any(not isinstance(value, str) or not value for value in expected):
            raise KlineReadModelError(f"bars[{index}].expected_sessions must be a list of date strings")
        quality = bar.get("quality") or {}
        missing = quality.get("missing_sessions") or []
        if not isinstance(missing, list) or any(not isinstance(value, str) or not value for value in missing):
            raise KlineReadModelError(f"bars[{index}].quality.missing_sessions must be a list of date strings")
        observed_sessions.extend(observed)
        expected_sessions.extend(expected)
        missing_sessions.extend(missing)
        period_key = bar.get("period_key") or bar.get("trading_date")
        if isinstance(period_key, str) and period_key:
            period_keys.append(period_key)

    observed_unique = sorted(set(observed_sessions))
    expected_unique = sorted(set(expected_sessions))
    missing_unique = sorted(set(missing_sessions))
    indicator_windows = {
        "ma": ma_period,
        "ema": ema_period,
        "rsi": 15,
        "macd": 34,
        "kd": 9,
        "atr": 14,
    }
    minimum_bars = max(indicator_windows.values())
    calendar_status = "not_supplied"
    if expected_unique:
        calendar_status = "partial" if missing_unique else "complete"
    depth_status = "empty" if not bars else "insufficient" if len(bars) < minimum_bars else "ready"
    return {
        "bar_count": len(bars),
        "first_period_key": period_keys[0] if period_keys else None,
        "last_period_key": period_keys[-1] if period_keys else None,
        "first_trading_date": observed_unique[0] if observed_unique else None,
        "last_trading_date": observed_unique[-1] if observed_unique else None,
        "observed_session_count": len(observed_unique),
        "expected_session_count": len(expected_unique) if expected_unique else None,
        "missing_session_count": len(missing_unique),
        "calendar_status": calendar_status,
        "depth_status": depth_status,
        "minimum_bars_for_indicators": minimum_bars,
        "indicator_ready": {
            key: len(bars) >= window for key, window in indicator_windows.items()
        },
    }


def build_kline_read_model(
    aggregation: Mapping[str, Any],
    *,
    ma_period: int = 5,
    ema_period: int = 20,
) -> dict[str, Any]:
    """Build a deterministic read-only model without browser-side calculations."""
    if aggregation.get("schema") != "tw-quant-engine-kline-aggregation/v1":
        raise KlineReadModelError("aggregation schema mismatch")
    as_of = _timestamp(aggregation.get("as_of"), "as_of")
    ingested_at = _timestamp(aggregation.get("ingested_at"), "ingested_at")
    instrument = aggregation.get("instrument")
    if not isinstance(instrument, Mapping):
        raise KlineReadModelError("instrument is required")
    bars = copy.deepcopy(aggregation.get("bars") or [])
    if not isinstance(bars, list):
        raise KlineReadModelError("bars must be a list")
    for index, bar in enumerate(bars):
        if not isinstance(bar, Mapping):
            raise KlineReadModelError(f"bars[{index}] must be an object")
        available_at = _timestamp(bar.get("available_at"), f"bars[{index}].available_at")
        if available_at > as_of:
            raise KlineReadModelError("bar available_at is after as_of")
    source_quality = aggregation.get("quality")
    if not isinstance(source_quality, Mapping):
        raise KlineReadModelError("quality is required")
    status = source_quality.get("status")
    if status not in {"valid", "partial", "invalid", "unavailable", "unsupported_period"}:
        raise KlineReadModelError("quality status unsupported")
    reasons = sorted({reason for reason in source_quality.get("reason_codes", []) if isinstance(reason, str)})
    indicators: dict[str, Any] = {
        "ma": {
            "period": ma_period,
            "formula": "simple moving average of close",
            "values": _indicator_values(bars, ma_period, exponential=False) if bars else [],
        },
        "ema": {
            "period": ema_period,
            "formula": "exponential moving average of close with alpha=2/(period+1)",
            "values": _indicator_values(bars, ema_period, exponential=True) if bars else [],
        },
        "rsi": {
            "period": 14,
            "formula": "100 - 100 / (1 + average gain / average loss), window=14",
            "values": _rsi_values(bars) if bars else [],
        },
        "macd": {
            "fast_period": 12,
            "slow_period": 26,
            "signal_period": 9,
            "formula": "EMA(12) - EMA(26), signal=EMA(9) of MACD",
            "values": [],
            "signal_values": [],
        },
        "kd": {
            "period": 9,
            "formula": "K/D smoothed RSV with window=9",
            "values": [],
            "d_values": [],
        },
        "atr": {
            "period": 14,
            "formula": "simple average true range, window=14",
            "values": _atr_values(bars) if bars else [],
        },
        "volume": {
            "formula": "source volume histogram",
            "values": [],
        },
    }
    if bars:
        indicators["macd"]["values"], indicators["macd"]["signal_values"] = _macd_values(bars)
        indicators["kd"]["values"], indicators["kd"]["d_values"] = _kd_values(bars)
    coverage = _coverage(bars, ma_period=ma_period, ema_period=ema_period)
    latest_study_values = [
        series[-1]
        for indicator in indicators.values()
        for key in ("values", "signal_values", "d_values")
        for series in [indicator.get(key) or []]
        if series
    ]
    if status == "valid" and bars and any(value["status"] == "insufficient_window" for value in latest_study_values):
        status = "partial"
        reasons.append("insufficient_indicator_window")
    quality = {
        "status": status,
        "reason_codes": sorted(set(reasons)),
        "missing_sessions": list(source_quality.get("missing_sessions") or []),
    }
    available_values = [bar["available_at"] for bar in bars if isinstance(bar.get("available_at"), str)]
    model = {
        "schema": KLINE_READ_MODEL_SCHEMA,
        "read_only": True,
        "instrument": copy.deepcopy(dict(instrument)),
        "period": aggregation.get("period"),
        "as_of": as_of.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "timezone": bars[0].get("timezone") if bars else None,
        "session": bars[0].get("session") if bars else None,
        "available_at": max(available_values) if available_values else None,
        "ingested_at": ingested_at.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "source": aggregation.get("source"),
        "adjustment_policy": aggregation.get("adjustment_policy"),
        "bars": bars,
        "indicators": indicators,
        "coverage": coverage,
        "quality": quality,
        "provenance": {
            "source": aggregation.get("source"),
            "fixture_id": aggregation.get("fixture_id"),
            "aggregation_schema": aggregation.get("schema"),
            "aggregation_digest": _digest(dict(aggregation)),
            "as_of": as_of.isoformat(timespec="microseconds").replace("+00:00", "Z"),
            "available_at": max(available_values) if available_values else None,
        },
    }
    model["snapshot_digest"] = _digest(model)
    return model


def read_only_kline_request(model: Mapping[str, Any], method: str, path: str) -> dict[str, Any]:
    """Serve an in-memory GET-only K-line view."""
    if path not in KLINE_READ_ONLY_ROUTES:
        return {"status": 404, "error": "unknown_route"}
    if method.upper() != "GET":
        return {"status": 405, "error": "read_only", "allow": ["GET"]}
    if path == "/kline":
        data: Any = copy.deepcopy(dict(model))
    elif path == "/kline/bars":
        data = copy.deepcopy(model.get("bars", []))
    elif path == "/kline/quality":
        data = copy.deepcopy(model.get("quality", {}))
    else:
        data = copy.deepcopy({key: model.get(key) for key in ("provenance", "as_of", "available_at", "source")})
    return {"status": 200, "data": data}


__all__ = ["KLINE_READ_MODEL_SCHEMA", "KLINE_READ_ONLY_ROUTES", "KlineReadModelError", "build_kline_read_model", "read_only_kline_request"]
