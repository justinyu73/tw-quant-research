"""K6a EOD snapshot policy, full-row mapping, and record-replay helpers."""
from __future__ import annotations

import gzip
import hashlib
import json
import math
import re
from datetime import date, datetime, time
from pathlib import Path
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo

from tw_quant_engine.ingestion import parse_roc_date
from tw_quant_engine.kline_contract import KLINE_FIXTURE_SCHEMA, KlineFixture


K6A_SNAPSHOT_SCHEMA = "tw-quant-engine-k6a-eod-snapshot/v1"
AVAILABLE_AT_POLICY = "trading_date_at_15:00:00_Asia/Taipei"
TAIPEI = ZoneInfo("Asia/Taipei")


class K6aSnapshotError(ValueError):
    """Raised when a K6a snapshot cannot be admitted safely."""


def classify_taiwan_asset_class(security_id: str) -> tuple[str | None, str | None]:
    """Classify only the Taiwan equity/ETF universe; fail closed otherwise."""
    code = str(security_id).strip().upper()
    if re.fullmatch(r"7[A-Z0-9]{5}", code):
        return None, "excluded_warrant"
    if re.fullmatch(r"00[A-Z0-9]{2,4}", code):
        return "etf", None
    if re.fullmatch(r"[1-9][0-9]{3}", code):
        return "equity", None
    return None, "unknown_asset_class"


def normalize_trading_date(value: str) -> str:
    if not isinstance(value, str):
        raise K6aSnapshotError("trading_date must be YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise K6aSnapshotError("trading_date must be YYYY-MM-DD") from exc
    return parsed.isoformat()


def roc_trading_date(value: str) -> str:
    parsed = date.fromisoformat(normalize_trading_date(value))
    return f"{parsed.year - 1911:03d}/{parsed.month:02d}/{parsed.day:02d}"


def available_at_for_trading_date(value: str) -> str:
    parsed = date.fromisoformat(normalize_trading_date(value))
    return datetime.combine(parsed, time(15, 0), tzinfo=TAIPEI).isoformat()


def _bar_time_for_trading_date(value: str) -> str:
    parsed = date.fromisoformat(normalize_trading_date(value))
    return datetime.combine(parsed, time(13, 30), tzinfo=TAIPEI).isoformat()


def _as_of_for_trading_date(value: str) -> str:
    parsed = date.fromisoformat(normalize_trading_date(value))
    return datetime.combine(parsed, time(23, 59, 59), tzinfo=TAIPEI).isoformat()


def _pick(row: Mapping[str, Any], keys: Sequence[str]) -> Any:
    for key in keys:
        value = row.get(key)
        if value not in (None, "", "-", "--"):
            return value
    return None


def _number(value: Any) -> int | float | None:
    if value in (None, "", "-", "--", "N/A") or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value if math.isfinite(float(value)) else None
    text = str(value).strip().replace(",", "")
    if not text or text in {"-", "--", "N/A"}:
        return None
    try:
        parsed = float(text)
    except ValueError:
        return None
    return int(parsed) if parsed.is_integer() else parsed


def _safe_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value)


def _canonical_digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


def _unadmitted(index: int, security_id: str | None, reasons: list[str]) -> dict[str, Any]:
    return {
        "row_index": index,
        "security_id": security_id,
        "reason_codes": sorted(set(reasons)),
    }


def map_eod_rows(
    rows: Sequence[Mapping[str, Any]],
    *,
    source_id: str,
    market: str,
    trading_date: str,
    field_names: Mapping[str, Sequence[str]],
) -> dict[str, Any]:
    """Map every provider row to one K1 dataset or an explicit unadmitted row."""
    expected_date = normalize_trading_date(trading_date)
    available_at = available_at_for_trading_date(expected_date)
    bar_time = _bar_time_for_trading_date(expected_date)
    datasets: list[dict[str, Any]] = []
    unadmitted: list[dict[str, Any]] = []
    seen_security_ids: set[str] = set()
    admitted_by_asset_class = {"equity": 0, "etf": 0}
    excluded_by_reason: dict[str, int] = {}

    def record_unadmitted(item: dict[str, Any]) -> None:
        unadmitted.append(item)
        for reason in item["reason_codes"]:
            excluded_by_reason[reason] = excluded_by_reason.get(reason, 0) + 1

    for index, row in enumerate(rows):
        reasons: list[str] = []
        if not isinstance(row, Mapping):
            record_unadmitted(_unadmitted(index, None, ["row_not_object"]))
            continue
        raw_security_id = _pick(row, field_names["security_id"])
        security_id = str(raw_security_id).strip() if raw_security_id is not None else None
        if not security_id:
            record_unadmitted(_unadmitted(index, None, ["missing_security_id"]))
            continue

        asset_class, asset_reason = classify_taiwan_asset_class(security_id)
        if asset_reason:
            record_unadmitted(_unadmitted(index, security_id, [asset_reason]))
            continue

        raw_source_date = _pick(row, field_names["trading_date"])
        if raw_source_date is None:
            reasons.append("missing_source_trading_date")
        else:
            try:
                source_date = parse_roc_date(raw_source_date)
            except (TypeError, ValueError):
                reasons.append("invalid_source_trading_date")
            else:
                if source_date != expected_date:
                    reasons.append("source_trading_date_mismatch")

        values = {
            key: _number(_pick(row, field_names[key]))
            for key in ("open", "high", "low", "close", "volume")
        }
        if any(values[key] is None for key in values):
            reasons.append("missing_or_invalid_ohlcv")
        elif values["volume"] < 0:
            reasons.append("negative_volume")
        elif values["low"] > min(values["open"], values["close"]):
            reasons.append("low_above_open_or_close")
        elif values["high"] < max(values["open"], values["close"]):
            reasons.append("high_below_open_or_close")
        if security_id and security_id in seen_security_ids:
            reasons.append("duplicate_security_id")

        if reasons:
            record_unadmitted(_unadmitted(index, security_id, reasons))
            continue

        seen_security_ids.add(security_id)
        admitted_by_asset_class[asset_class] += 1
        display_name = _pick(row, field_names["display_name"]) or security_id
        dataset = {
            "dataset_id": f"{source_id}-{_safe_id(security_id)}-{expected_date}",
            "case": "valid",
            "instrument": {
                "instrument_id": f"{market}:{security_id}",
                "market": market,
                "symbol": security_id,
                "display_name": str(display_name).strip() or security_id,
                "asset_class": asset_class,
                "currency": "TWD",
                "contract_month": None,
                "expiry": None,
            },
            "periods_available": ["1D"],
            "unsupported_periods": [],
            "adjustment_policy": "unadjusted",
            "quality": {"status": "valid", "reason_codes": []},
            "bars": [
                {
                    "trading_date": expected_date,
                    "bar_time": bar_time,
                    "timezone": "Asia/Taipei",
                    "session": "regular",
                    "available_at": available_at,
                    "open": values["open"],
                    "high": values["high"],
                    "low": values["low"],
                    "close": values["close"],
                    "volume": values["volume"],
                }
            ],
        }
        datasets.append(dataset)

    datasets.sort(key=lambda item: item["dataset_id"])
    return {
        "trading_date": expected_date,
        "available_at": available_at,
        "available_at_policy": AVAILABLE_AT_POLICY,
        "row_count": len(rows),
        "admitted_count": len(datasets),
        "unadmitted_count": len(unadmitted),
        "admitted_by_asset_class": admitted_by_asset_class,
        "excluded_by_reason": excluded_by_reason,
        "datasets": datasets,
        "unadmitted_rows": unadmitted,
    }


def _flatten_bars(fixture: KlineFixture) -> list[dict[str, Any]]:
    bars: list[dict[str, Any]] = []
    for dataset in fixture.datasets:
        for bar in dataset["bars"]:
            bars.append(
                {
                    "dataset_id": dataset["dataset_id"],
                    "instrument": dataset["instrument"],
                    **bar,
                }
            )
    return bars


def build_snapshot(
    *,
    source_metadata: Mapping[str, Any],
    mapping: Mapping[str, Any],
) -> dict[str, Any]:
    source_id = str(source_metadata.get("source_id") or "")
    content_digest = str(source_metadata.get("content_digest") or "")
    retrieved_at = str(source_metadata.get("retrieved_at") or "")
    if not source_id or not content_digest or not retrieved_at:
        raise K6aSnapshotError("source metadata must include source_id, retrieved_at, and content_digest")
    trading_date = normalize_trading_date(str(mapping.get("trading_date") or ""))
    datasets = mapping.get("datasets")
    if not isinstance(datasets, list) or not datasets:
        raise K6aSnapshotError("at least one admitted K1 dataset is required")

    fixture_payload = {
        "schema": KLINE_FIXTURE_SCHEMA,
        "as_of": _as_of_for_trading_date(trading_date),
        "ingested_at": retrieved_at,
        "provenance": {
            "source": "offline-fixture",
            "fixture_id": f"k6a-{source_id}-{trading_date}",
            "network": False,
            "provider_calls": False,
        },
        "datasets": datasets,
    }
    fixture = KlineFixture.from_payload(fixture_payload)
    bars = _flatten_bars(fixture)
    snapshot = {
        "schema": K6A_SNAPSHOT_SCHEMA,
        "snapshot_id": f"{source_id}-{trading_date}-{content_digest.split(':', 1)[-1][:20]}",
        "source_id": source_id,
        "trading_date": trading_date,
        "available_at": available_at_for_trading_date(trading_date),
        "available_at_policy": AVAILABLE_AT_POLICY,
        "retrieved_at": retrieved_at,
        "source_metadata": dict(source_metadata),
        "content_digest": content_digest,
        "row_counts": {
            "raw": int(mapping.get("row_count", 0)),
            "admitted": int(mapping.get("admitted_count", len(fixture.datasets))),
            "unadmitted": int(mapping.get("unadmitted_count", 0)),
            "admitted_by_asset_class": dict(mapping.get("admitted_by_asset_class") or {}),
            "excluded_by_reason": dict(mapping.get("excluded_by_reason") or {}),
        },
        "unadmitted_rows": list(mapping.get("unadmitted_rows") or []),
        "bars_digest": _canonical_digest(bars),
        "bars": bars,
        "kline_fixture": fixture_payload,
    }
    snapshot["snapshot_digest"] = _canonical_digest(snapshot)
    return snapshot


def load_snapshot(path: str | Path) -> dict[str, Any]:
    snapshot_path = Path(path)
    try:
        if snapshot_path.suffix == ".gz":
            with gzip.open(snapshot_path, "rt", encoding="utf-8") as handle:
                payload = json.load(handle)
        else:
            payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise K6aSnapshotError(f"unable to read K6a snapshot: {snapshot_path}") from exc
    if not isinstance(payload, Mapping) or payload.get("schema") != K6A_SNAPSHOT_SCHEMA:
        raise K6aSnapshotError("unsupported K6a snapshot schema")
    fixture_payload = payload.get("kline_fixture")
    if not isinstance(fixture_payload, Mapping):
        raise K6aSnapshotError("K6a snapshot must contain a K1 fixture")
    KlineFixture.from_payload(fixture_payload)
    return dict(payload)


def bars_digest_from_mapping(mapping: Mapping[str, Any]) -> str:
    datasets = mapping.get("datasets")
    if not isinstance(datasets, list):
        raise K6aSnapshotError("mapping datasets must be a list")
    bars: list[dict[str, Any]] = []
    for dataset in datasets:
        if not isinstance(dataset, Mapping):
            raise K6aSnapshotError("mapping dataset must be an object")
        for bar in dataset.get("bars", []):
            bars.append({"dataset_id": dataset["dataset_id"], "instrument": dataset["instrument"], **bar})
    return _canonical_digest(bars)


__all__ = [
    "AVAILABLE_AT_POLICY",
    "K6A_SNAPSHOT_SCHEMA",
    "K6aSnapshotError",
    "available_at_for_trading_date",
    "bars_digest_from_mapping",
    "build_snapshot",
    "classify_taiwan_asset_class",
    "load_snapshot",
    "map_eod_rows",
    "normalize_trading_date",
    "roc_trading_date",
]
