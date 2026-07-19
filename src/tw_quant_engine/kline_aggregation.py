"""Deterministic EOD period aggregation for the K2 slice."""
from __future__ import annotations

import copy
import hashlib
import json
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Mapping


KLINE_AGGREGATION_SCHEMA = "tw-quant-engine-kline-aggregation/v1"
PERIODS = frozenset({"1D", "1W", "M", "Q"})


class KlineAggregationError(ValueError):
    """Raised when period aggregation cannot be performed safely."""


def _timestamp(value: Any, field: str) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError as exc:
            raise KlineAggregationError(f"{field} must be an ISO timestamp") from exc
    else:
        raise KlineAggregationError(f"{field} must be an ISO timestamp")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise KlineAggregationError(f"{field} must include an explicit timezone")
    return parsed.astimezone(timezone.utc)


def _date(value: Any, field: str) -> date:
    if not isinstance(value, str):
        raise KlineAggregationError(f"{field} must be an ISO date")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise KlineAggregationError(f"{field} must be an ISO date") from exc


def _period_key(trading_date: date, period: str) -> str:
    if period == "1D":
        return trading_date.isoformat()
    if period == "1W":
        iso = trading_date.isocalendar()
        return f"{iso.year}-W{iso.week:02d}"
    if period == "M":
        return f"{trading_date.year:04d}-{trading_date.month:02d}"
    if period == "Q":
        quarter = ((trading_date.month - 1) // 3) + 1
        return f"{trading_date.year:04d}-Q{quarter}"
    raise KlineAggregationError(f"unsupported period: {period!r}")


def _period_bounds(period_key: str, period: str) -> tuple[date, date]:
    if period == "1D":
        value = _date(period_key, "period_key")
        return value, value
    if period == "1W":
        year, week = period_key.split("-W")
        start = date.fromisocalendar(int(year), int(week), 1)
        return start, start + timedelta(days=6)
    if period == "M":
        year, month = (int(part) for part in period_key.split("-"))
        start = date(year, month, 1)
        next_month = date(year + (month == 12), 1 if month == 12 else month + 1, 1)
        return start, next_month - timedelta(days=1)
    if period == "Q":
        year, quarter = period_key.split("-Q")
        month = (int(quarter) - 1) * 3 + 1
        start = date(int(year), month, 1)
        next_quarter = date(int(year) + (month == 10), 1 if month == 10 else month + 3, 1)
        return start, next_quarter - timedelta(days=1)
    raise KlineAggregationError(f"unsupported period: {period!r}")


def _number(value: Any, field: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise KlineAggregationError(f"{field} must be a number")
    return value


def _normalize_bars(bars: list[Mapping[str, Any]], *, as_of: datetime) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen_dates: set[str] = set()
    for index, item in enumerate(bars):
        trading_date = _date(item.get("trading_date"), f"bars[{index}].trading_date")
        date_key = trading_date.isoformat()
        if date_key in seen_dates:
            raise KlineAggregationError("duplicate trading_date")
        seen_dates.add(date_key)
        available_at = _timestamp(item.get("available_at"), f"bars[{index}].available_at")
        if available_at > as_of:
            continue
        open_value = _number(item.get("open"), f"bars[{index}].open")
        high_value = _number(item.get("high"), f"bars[{index}].high")
        low_value = _number(item.get("low"), f"bars[{index}].low")
        close_value = _number(item.get("close"), f"bars[{index}].close")
        volume = _number(item.get("volume"), f"bars[{index}].volume")
        if low_value > min(open_value, close_value):
            raise KlineAggregationError("low is above open/close")
        if high_value < max(open_value, close_value):
            raise KlineAggregationError("high is below open/close")
        if volume < 0:
            raise KlineAggregationError("volume must be non-negative")
        normalized.append(
            {
                "trading_date": date_key,
                "bar_time": _timestamp(item.get("bar_time"), f"bars[{index}].bar_time").isoformat().replace("+00:00", "Z"),
                "timezone": str(item.get("timezone") or ""),
                "session": str(item.get("session") or ""),
                "available_at": available_at.isoformat().replace("+00:00", "Z"),
                "open": open_value,
                "high": high_value,
                "low": low_value,
                "close": close_value,
                "volume": volume,
            }
        )
    normalized.sort(key=lambda item: (item["trading_date"], item["bar_time"]))
    if any(not item["timezone"] or not item["session"] for item in normalized):
        raise KlineAggregationError("timezone and session are required")
    timezones = {item["timezone"] for item in normalized}
    if len(timezones) > 1:
        raise KlineAggregationError("cannot mix timezones inside one dataset")
    return normalized


def _normalize_expected_sessions(expected_sessions: Mapping[str, list[str]] | None) -> dict[str, list[str]]:
    if expected_sessions is None:
        return {}
    result: dict[str, list[str]] = {}
    for period_key, values in expected_sessions.items():
        if not isinstance(period_key, str) or not isinstance(values, list) or not values:
            raise KlineAggregationError("expected_sessions must map period keys to non-empty date lists")
        dates = sorted({_date(value, "expected_session").isoformat() for value in values})
        if len(dates) != len(values):
            raise KlineAggregationError("expected_sessions contains duplicate dates")
        result[period_key] = dates
    return result


def _quality_for_group(period: str, period_key: str, observed: list[str], expected: list[str] | None) -> dict[str, Any]:
    if period == "1D":
        return {"status": "valid", "reason_codes": [], "missing_sessions": []}
    if expected is None:
        return {"status": "partial", "reason_codes": ["calendar_not_supplied"], "missing_sessions": []}
    missing = sorted(set(expected) - set(observed))
    if missing:
        return {"status": "partial", "reason_codes": ["missing_sessions"], "missing_sessions": missing}
    return {"status": "valid", "reason_codes": [], "missing_sessions": []}


def aggregate_dataset(
    dataset: Mapping[str, Any],
    *,
    period: str,
    as_of: str | datetime,
    expected_sessions: Mapping[str, list[str]] | None = None,
) -> dict[str, Any]:
    """Aggregate one validated K1 dataset without filling or network access."""
    if period not in PERIODS:
        raise KlineAggregationError(f"unsupported period: {period!r}")
    cutoff = _timestamp(as_of, "as_of")
    dataset_id = str(dataset.get("dataset_id") or "")
    if not dataset_id:
        raise KlineAggregationError("dataset_id is required")
    instrument = copy.deepcopy(dataset.get("instrument"))
    if not isinstance(instrument, Mapping):
        raise KlineAggregationError("instrument is required")
    base = {
        "schema": KLINE_AGGREGATION_SCHEMA,
        "dataset_id": dataset_id,
        "instrument": instrument,
        "period": period,
        "as_of": cutoff.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "ingested_at": str(dataset.get("ingested_at") or cutoff.isoformat(timespec="microseconds").replace("+00:00", "Z")),
        "source": str(dataset.get("source") or "offline-fixture"),
        "fixture_id": str(dataset.get("fixture_id") or "k1-unknown"),
        "adjustment_policy": str(dataset.get("adjustment_policy") or ""),
        "bars": [],
    }
    case = dataset.get("case")
    if case == "empty":
        base["quality"] = {"status": "unavailable", "reason_codes": ["no_data"], "missing_sessions": []}
        return base
    # ``periods_available`` describes periods already present in the source
    # fixture. K2 may derive 1W/M/Q from EOD bars; only an explicit
    # ``unsupported_periods`` declaration blocks a derived period.
    if period in set(dataset.get("unsupported_periods") or []):
        base["quality"] = {"status": "unsupported_period", "reason_codes": ["unsupported_period"], "missing_sessions": []}
        return base
    raw_bars = dataset.get("bars")
    if not isinstance(raw_bars, list):
        raise KlineAggregationError("bars must be a list")
    bars = _normalize_bars(raw_bars, as_of=cutoff)
    if not bars:
        base["quality"] = {"status": "unavailable", "reason_codes": ["no_data_at_as_of"], "missing_sessions": []}
        return base
    calendar = _normalize_expected_sessions(expected_sessions)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for bar in bars:
        grouped[_period_key(_date(bar["trading_date"], "trading_date"), period)].append(bar)
    for period_key in sorted(grouped):
        group = grouped[period_key]
        observed = [item["trading_date"] for item in group]
        expected = calendar.get(period_key)
        quality = _quality_for_group(period, period_key, observed, expected)
        period_start, period_end = _period_bounds(period_key, period)
        aggregated = {
            "period_key": period_key,
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "trading_date": observed[-1],
            "bar_time": group[-1]["bar_time"],
            "timezone": group[0]["timezone"],
            "session": group[0]["session"],
            "available_at": max(item["available_at"] for item in group),
            "observed_sessions": observed,
            "expected_sessions": expected or [],
            "open": group[0]["open"],
            "high": max(item["high"] for item in group),
            "low": min(item["low"] for item in group),
            "close": group[-1]["close"],
            "volume": sum(item["volume"] for item in group),
            "quality": quality,
        }
        base["bars"].append(aggregated)
    statuses = {bar["quality"]["status"] for bar in base["bars"]}
    base["quality"] = {"status": "valid" if statuses == {"valid"} else "partial", "reason_codes": sorted({reason for bar in base["bars"] for reason in bar["quality"]["reason_codes"]}), "missing_sessions": sorted({missing for bar in base["bars"] for missing in bar["quality"]["missing_sessions"]})}
    return base


def aggregate_digest(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


__all__ = ["KLINE_AGGREGATION_SCHEMA", "KlineAggregationError", "aggregate_dataset", "aggregate_digest"]
