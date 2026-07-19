"""Offline, provider-neutral OHLCV fixture contract for the K1 slice."""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Mapping


KLINE_FIXTURE_SCHEMA = "tw-quant-engine-kline-fixture/v1"
KLINE_CASES = frozenset({"valid", "partial", "empty", "unsupported"})
KLINE_PERIODS = frozenset({"1D", "1W", "M", "Q"})
KLINE_MARKETS = frozenset({"TWSE", "TPEx", "US", "TAIFEX"})
_FIXTURE_FIELDS = frozenset({"schema", "as_of", "ingested_at", "provenance", "datasets"})
_PROVENANCE_FIELDS = frozenset({"source", "fixture_id", "network", "provider_calls"})
_DATASET_FIELDS = frozenset(
    {"dataset_id", "case", "instrument", "periods_available", "unsupported_periods", "adjustment_policy", "bars", "quality"}
)
_INSTRUMENT_FIELDS = frozenset(
    {"instrument_id", "market", "symbol", "display_name", "asset_class", "currency", "contract_month", "expiry"}
)
_BAR_FIELDS = frozenset({"trading_date", "bar_time", "timezone", "session", "available_at", "open", "high", "low", "close", "volume"})
_QUALITY_FIELDS = frozenset({"status", "reason_codes"})


class KlineContractError(ValueError):
    """Raised when an offline K-line fixture violates its contract."""


def _non_empty(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise KlineContractError(f"{field} must be a non-empty string")
    return value.strip()


def _date(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise KlineContractError(f"{field} must be an ISO date string")
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise KlineContractError(f"{field} must be an ISO date string") from exc


def _timestamp(value: Any, field: str) -> str:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError as exc:
            raise KlineContractError(f"{field} must be an ISO timestamp") from exc
    else:
        raise KlineContractError(f"{field} must be an ISO timestamp")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise KlineContractError(f"{field} must include an explicit timezone")
    return parsed.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _number(value: Any, field: str, *, non_negative: bool = False) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise KlineContractError(f"{field} must be a JSON number")
    if isinstance(value, float) and not math.isfinite(value):
        raise KlineContractError(f"{field} must be finite")
    if non_negative and value < 0:
        raise KlineContractError(f"{field} must be non-negative")
    return value


def _fields(item: Mapping[str, Any], expected: frozenset[str], label: str) -> None:
    missing = sorted(expected - set(item))
    unknown = sorted(set(item) - expected)
    if missing or unknown:
        raise KlineContractError(f"{label} fields invalid; missing={missing}, unknown={unknown}")


def _validate_instrument(item: Mapping[str, Any]) -> dict[str, Any]:
    _fields(item, _INSTRUMENT_FIELDS, "instrument")
    market = item["market"]
    if market not in KLINE_MARKETS:
        raise KlineContractError(f"instrument market unsupported: {market!r}")
    instrument_id = _non_empty(item["instrument_id"], "instrument_id")
    if not instrument_id.startswith(f"{market}:"):
        raise KlineContractError("instrument_id must begin with its market prefix")
    asset_class = _non_empty(item["asset_class"], "asset_class")
    expected_asset_classes = {"future", "futures"} if market == "TAIFEX" else {"equity", "etf"}
    if asset_class not in expected_asset_classes:
        raise KlineContractError(f"{market} must use asset_class in {sorted(expected_asset_classes)!r}")
    contract_month = item["contract_month"]
    expiry = item["expiry"]
    if market == "TAIFEX":
        if not isinstance(contract_month, str) or len(contract_month) != 6 or not contract_month.isdigit():
            raise KlineContractError("TAIFEX contract_month must be YYYYMM")
        if expiry is not None:
            expiry = _date(expiry, "expiry")
    elif contract_month is not None or expiry is not None:
        raise KlineContractError("non-futures instruments cannot carry contract_month or expiry")
    return {
        "instrument_id": instrument_id,
        "market": market,
        "symbol": _non_empty(item["symbol"], "symbol"),
        "display_name": _non_empty(item["display_name"], "display_name"),
        "asset_class": asset_class,
        "currency": _non_empty(item["currency"], "currency"),
        "contract_month": contract_month,
        "expiry": expiry,
    }


def _validate_bar(item: Mapping[str, Any], *, dataset_id: str, index: int) -> dict[str, Any]:
    _fields(item, _BAR_FIELDS, f"{dataset_id}.bars[{index}]")
    result = {
        "trading_date": _date(item["trading_date"], f"{dataset_id}.trading_date"),
        "bar_time": _timestamp(item["bar_time"], f"{dataset_id}.bar_time"),
        "timezone": _non_empty(item["timezone"], f"{dataset_id}.timezone"),
        "session": _non_empty(item["session"], f"{dataset_id}.session"),
        "available_at": _timestamp(item["available_at"], f"{dataset_id}.available_at"),
        "open": _number(item["open"], f"{dataset_id}.open"),
        "high": _number(item["high"], f"{dataset_id}.high"),
        "low": _number(item["low"], f"{dataset_id}.low"),
        "close": _number(item["close"], f"{dataset_id}.close"),
        "volume": _number(item["volume"], f"{dataset_id}.volume", non_negative=True),
    }
    if result["low"] > min(result["open"], result["close"]):
        raise KlineContractError(f"{dataset_id}.low is above open/close")
    if result["high"] < max(result["open"], result["close"]):
        raise KlineContractError(f"{dataset_id}.high is below open/close")
    return result


def _validate_quality(item: Mapping[str, Any], *, dataset_id: str) -> dict[str, Any]:
    _fields(item, _QUALITY_FIELDS, f"{dataset_id}.quality")
    status = item["status"]
    if status not in {"valid", "partial", "invalid", "unavailable"}:
        raise KlineContractError(f"{dataset_id}.quality.status unsupported")
    reasons = item["reason_codes"]
    if not isinstance(reasons, list) or any(not isinstance(reason, str) or not reason for reason in reasons):
        raise KlineContractError(f"{dataset_id}.quality.reason_codes must be a list of non-empty strings")
    return {"status": status, "reason_codes": list(reasons)}


def _validate_dataset(item: Mapping[str, Any], *, as_of: str) -> dict[str, Any]:
    if not isinstance(item, Mapping):
        raise KlineContractError("dataset must be an object")
    _fields(item, _DATASET_FIELDS, "dataset")
    dataset_id = _non_empty(item["dataset_id"], "dataset_id")
    case = item["case"]
    if case not in KLINE_CASES:
        raise KlineContractError(f"{dataset_id}.case unsupported")
    periods = item["periods_available"]
    unsupported_periods = item["unsupported_periods"]
    for field, values in (("periods_available", periods), ("unsupported_periods", unsupported_periods)):
        if not isinstance(values, list) or any(value not in KLINE_PERIODS for value in values):
            raise KlineContractError(f"{dataset_id}.{field} must contain only known periods")
        if len(values) != len(set(values)):
            raise KlineContractError(f"{dataset_id}.{field} contains duplicate periods")
    if set(periods) & set(unsupported_periods):
        raise KlineContractError(f"{dataset_id} cannot both support and reject a period")
    bars = item["bars"]
    if not isinstance(bars, list):
        raise KlineContractError(f"{dataset_id}.bars must be a list")
    normalized_bars = [_validate_bar(bar, dataset_id=dataset_id, index=index) for index, bar in enumerate(bars)]
    trading_dates = [bar["trading_date"] for bar in normalized_bars]
    if len(trading_dates) != len(set(trading_dates)):
        raise KlineContractError(f"{dataset_id}.bars contains duplicate trading_date")
    cutoff = datetime.fromisoformat(as_of[:-1] + "+00:00")
    if any(datetime.fromisoformat(bar["available_at"][:-1] + "+00:00") > cutoff for bar in normalized_bars):
        raise KlineContractError(f"{dataset_id}.bars contains data unavailable after fixture as_of")
    quality = _validate_quality(item["quality"], dataset_id=dataset_id)
    if case == "valid" and (not normalized_bars or quality["status"] != "valid" or quality["reason_codes"]):
        raise KlineContractError(f"{dataset_id}.valid requires non-empty valid bars without reasons")
    if case == "partial" and (not normalized_bars or quality["status"] != "partial" or not quality["reason_codes"]):
        raise KlineContractError(f"{dataset_id}.partial requires partial bars with reasons")
    if case == "empty" and (normalized_bars or quality["status"] != "unavailable" or "no_data" not in quality["reason_codes"]):
        raise KlineContractError(f"{dataset_id}.empty requires unavailable no_data state")
    if case == "unsupported" and (not normalized_bars or not unsupported_periods):
        raise KlineContractError(f"{dataset_id}.unsupported requires bars and unsupported periods")
    return {
        "dataset_id": dataset_id,
        "case": case,
        "instrument": _validate_instrument(item["instrument"]),
        "periods_available": list(periods),
        "unsupported_periods": list(unsupported_periods),
        "adjustment_policy": _non_empty(item["adjustment_policy"], f"{dataset_id}.adjustment_policy"),
        "bars": normalized_bars,
        "quality": quality,
    }


class KlineFixture:
    """Validated, immutable-by-convention K1 fixture payload."""

    def __init__(self, payload: Mapping[str, Any]) -> None:
        self.payload = json.loads(json.dumps(payload, ensure_ascii=False))

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "KlineFixture":
        if not isinstance(payload, Mapping):
            raise KlineContractError("fixture must be an object")
        _fields(payload, _FIXTURE_FIELDS, "fixture")
        if payload["schema"] != KLINE_FIXTURE_SCHEMA:
            raise KlineContractError(f"unsupported fixture schema: {payload.get('schema')!r}")
        as_of = _timestamp(payload["as_of"], "as_of")
        ingested_at = _timestamp(payload["ingested_at"], "ingested_at")
        provenance = payload["provenance"]
        if not isinstance(provenance, Mapping):
            raise KlineContractError("provenance must be an object")
        _fields(provenance, _PROVENANCE_FIELDS, "provenance")
        if provenance["source"] != "offline-fixture":
            raise KlineContractError("K1 fixture source must be offline-fixture")
        if not isinstance(provenance["network"], bool) or provenance["network"]:
            raise KlineContractError("K1 fixture network must be false")
        if not isinstance(provenance["provider_calls"], bool) or provenance["provider_calls"]:
            raise KlineContractError("K1 fixture provider_calls must be false")
        _non_empty(provenance["fixture_id"], "provenance.fixture_id")
        datasets = payload["datasets"]
        if not isinstance(datasets, list) or not datasets:
            raise KlineContractError("fixture.datasets must be a non-empty list")
        normalized_datasets = [_validate_dataset(item, as_of=as_of) for item in datasets]
        dataset_ids = [item["dataset_id"] for item in normalized_datasets]
        if len(dataset_ids) != len(set(dataset_ids)):
            raise KlineContractError("duplicate dataset_id")
        instrument_ids = [item["instrument"]["instrument_id"] for item in normalized_datasets]
        if len(instrument_ids) != len(set(instrument_ids)):
            raise KlineContractError("duplicate canonical instrument_id")
        for dataset in normalized_datasets:
            dataset["source"] = "offline-fixture"
            dataset["fixture_id"] = _non_empty(provenance["fixture_id"], "provenance.fixture_id")
            dataset["as_of"] = as_of
            dataset["ingested_at"] = ingested_at
        normalized = {
            "schema": KLINE_FIXTURE_SCHEMA,
            "as_of": as_of,
            "ingested_at": ingested_at,
            "provenance": {
                "source": "offline-fixture",
                "fixture_id": _non_empty(provenance["fixture_id"], "provenance.fixture_id"),
                "network": False,
                "provider_calls": False,
            },
            "datasets": normalized_datasets,
        }
        return cls(normalized)

    @classmethod
    def from_path(cls, path: str | Path) -> "KlineFixture":
        fixture_path = Path(path)
        try:
            payload = json.loads(fixture_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise KlineContractError(f"unable to read K1 fixture: {fixture_path}") from exc
        return cls.from_payload(payload)

    @property
    def as_of(self) -> str:
        return self.payload["as_of"]

    @property
    def datasets(self) -> list[dict[str, Any]]:
        return self.payload["datasets"]

    def by_case(self, case: str) -> dict[str, Any]:
        matches = [dataset for dataset in self.datasets if dataset["case"] == case]
        if len(matches) != 1:
            raise KlineContractError(f"expected exactly one dataset for case {case!r}")
        return matches[0]

    def digest(self) -> str:
        encoded = json.dumps(self.payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


def load_fixture(path: str | Path) -> KlineFixture:
    """Load and validate one K1 fixture without network access."""
    return KlineFixture.from_path(path)


__all__ = [
    "KLINE_CASES",
    "KLINE_FIXTURE_SCHEMA",
    "KLINE_MARKETS",
    "KLINE_PERIODS",
    "KlineContractError",
    "KlineFixture",
    "load_fixture",
]
