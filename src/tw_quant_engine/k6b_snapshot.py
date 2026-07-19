"""K6b TAIFEX TX daily-session admission and record-replay snapshots."""
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

from tw_quant_engine.kline_contract import KLINE_FIXTURE_SCHEMA, KlineFixture


K6B_SNAPSHOT_SCHEMA = "tw-quant-engine-k6b-taifex-eod-snapshot/v1"
AVAILABLE_AT_POLICY = "trading_date_at_15:00:00_Asia/Taipei"
TAIFEX_CONTRACT = "TX"
TAIFEX_ASSET_CLASS = "future"
TAIPEI = ZoneInfo("Asia/Taipei")


class K6bSnapshotError(ValueError):
    """Raised when a K6b snapshot cannot be admitted safely."""


def normalize_trading_date(value: str) -> str:
    if not isinstance(value, str):
        raise K6bSnapshotError("trading_date must be YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise K6bSnapshotError("trading_date must be YYYY-MM-DD") from exc
    return parsed.isoformat()


def normalize_contract_month(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"\d{6}", value.strip()):
        raise K6bSnapshotError("contract_month must be YYYYMM")
    text = value.strip()
    try:
        date(int(text[:4]), int(text[4:]), 1)
    except ValueError as exc:
        raise K6bSnapshotError("contract_month must be a valid YYYYMM") from exc
    return text


def parse_taifex_trading_date(value: Any) -> str:
    text = str(value).strip()
    if re.fullmatch(r"\d{8}", text):
        try:
            return date(int(text[:4]), int(text[4:6]), int(text[6:])).isoformat()
        except ValueError as exc:
            raise K6bSnapshotError(f"invalid TAIFEX trading date: {value!r}") from exc
    return normalize_trading_date(text)


def available_at_for_trading_date(value: str) -> str:
    parsed = date.fromisoformat(normalize_trading_date(value))
    return datetime.combine(parsed, time(15, 0), tzinfo=TAIPEI).isoformat()


def _bar_time_for_trading_date(value: str) -> str:
    parsed = date.fromisoformat(normalize_trading_date(value))
    return datetime.combine(parsed, time(13, 45), tzinfo=TAIPEI).isoformat()


def _as_of_for_trading_date(value: str) -> str:
    parsed = date.fromisoformat(normalize_trading_date(value))
    return datetime.combine(parsed, time(23, 59, 59), tzinfo=TAIPEI).isoformat()


def _pick(row: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in row and row[key] is not None and row[key] != "":
            return row[key]
    return None


def _number(value: Any) -> int | float | None:
    if value in (None, "", "-", "--", "NULL", "N/A") or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value if math.isfinite(float(value)) else None
    text = str(value).strip().replace(",", "")
    if not text or text in {"-", "--", "NULL", "N/A"}:
        return None
    try:
        parsed = float(text)
    except ValueError:
        return None
    return int(parsed) if parsed.is_integer() else parsed


def _is_zero(value: Any) -> bool:
    parsed = _number(value)
    return parsed == 0


def _safe_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value)


def _canonical_digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


def _unadmitted(index: int, contract: str | None, contract_month: str | None, reasons: list[str]) -> dict[str, Any]:
    return {
        "row_index": index,
        "contract": contract,
        "contract_month": contract_month,
        "reason_codes": sorted(set(reasons)),
    }


def map_taifex_rows(
    rows: Sequence[Mapping[str, Any]],
    *,
    trading_date: str,
    contract_month: str,
) -> dict[str, Any]:
    """Map only one TX outright month and regular-session row to a K1 dataset."""
    expected_date = normalize_trading_date(trading_date)
    expected_month = normalize_contract_month(contract_month)
    available_at = available_at_for_trading_date(expected_date)
    bar_time = _bar_time_for_trading_date(expected_date)
    datasets: list[dict[str, Any]] = []
    unadmitted: list[dict[str, Any]] = []
    seen_bars: set[tuple[str, str]] = set()
    excluded_by_reason: dict[str, int] = {}
    category_counts: dict[str, int] = {
        "tx_rows": 0,
        "target_contract_month_rows": 0,
        "tx_regular_rows": 0,
        "tx_after_hours_rows": 0,
        "target_regular_rows": 0,
        "target_after_hours_rows": 0,
        "spread_rows": 0,
        "other_contract_month_rows": 0,
        "other_contract_rows": 0,
        "settlement_zero_rows": 0,
        "settlement_zero_target_contract_month_rows": 0,
        "admitted_regular_rows": 0,
    }
    admitted_settlement_price: int | float | None = None

    def record_unadmitted(item: dict[str, Any]) -> None:
        unadmitted.append(item)
        for reason in item["reason_codes"]:
            excluded_by_reason[reason] = excluded_by_reason.get(reason, 0) + 1

    for index, row in enumerate(rows):
        if not isinstance(row, Mapping):
            record_unadmitted(_unadmitted(index, None, None, ["row_not_object"]))
            continue

        raw_contract = _pick(row, "Contract", "契約")
        contract = str(raw_contract).strip() if raw_contract is not None else None
        raw_month = _pick(row, "ContractMonth(Week)", "ContractMonth", "到期月份(週別)", "到期月份")
        month = str(raw_month).strip() if raw_month is not None else None
        if contract is None:
            record_unadmitted(_unadmitted(index, None, month, ["missing_contract"]))
            continue
        if contract != TAIFEX_CONTRACT:
            category_counts["other_contract_rows"] += 1
            record_unadmitted(_unadmitted(index, contract, month, ["excluded_other_contract"]))
            continue

        category_counts["tx_rows"] += 1
        settlement_raw = _pick(row, "SettlementPrice", "結算價")
        if _is_zero(settlement_raw):
            category_counts["settlement_zero_rows"] += 1
        raw_session = str(_pick(row, "TradingSession", "交易時段") or "").strip()
        if raw_session == "一般":
            category_counts["tx_regular_rows"] += 1
        elif raw_session == "盤後":
            category_counts["tx_after_hours_rows"] += 1

        if not month:
            record_unadmitted(_unadmitted(index, contract, None, ["missing_contract_month"]))
            continue
        if "/" in month:
            category_counts["spread_rows"] += 1
            record_unadmitted(_unadmitted(index, contract, month, ["excluded_spread"]))
            continue
        if not re.fullmatch(r"\d{6}", month):
            record_unadmitted(_unadmitted(index, contract, month, ["invalid_contract_month"]))
            continue
        if month != expected_month:
            category_counts["other_contract_month_rows"] += 1
            record_unadmitted(_unadmitted(index, contract, month, ["excluded_other_contract_month"]))
            continue

        category_counts["target_contract_month_rows"] += 1
        if _is_zero(settlement_raw):
            category_counts["settlement_zero_target_contract_month_rows"] += 1

        session = raw_session
        if session == "盤後":
            category_counts["target_after_hours_rows"] += 1
            record_unadmitted(_unadmitted(index, contract, month, ["excluded_after_hours"]))
            continue
        if session != "一般":
            record_unadmitted(_unadmitted(index, contract, month, ["unknown_trading_session"]))
            continue
        category_counts["target_regular_rows"] += 1

        reasons: list[str] = []
        raw_date = _pick(row, "Date", "日期")
        if raw_date is None:
            reasons.append("missing_source_trading_date")
        else:
            try:
                source_date = parse_taifex_trading_date(raw_date)
            except (K6bSnapshotError, TypeError, ValueError):
                reasons.append("invalid_source_trading_date")
            else:
                if source_date != expected_date:
                    reasons.append("source_trading_date_mismatch")

        values = {
            "open": _number(_pick(row, "Open", "開盤價")),
            "high": _number(_pick(row, "High", "最高價")),
            "low": _number(_pick(row, "Low", "最低價")),
            "close": _number(_pick(row, "Last", "Close", "最後成交價", "收盤價")),
            "volume": _number(_pick(row, "Volume", "成交量", "合計成交量")),
        }
        if any(value is None for value in values.values()):
            reasons.append("missing_or_invalid_ohlcv")
        else:
            if values["volume"] < 0:
                reasons.append("negative_volume")
            if values["low"] > min(values["open"], values["close"]):
                reasons.append("low_above_open_or_close")
            if values["high"] < max(values["open"], values["close"]):
                reasons.append("high_below_open_or_close")

        settlement = _number(settlement_raw)
        if settlement is None:
            reasons.append("missing_or_invalid_settlement")
        elif settlement == 0:
            reasons.append("settlement_zero")
        elif settlement < 0:
            reasons.append("invalid_settlement")

        key = (TAIFEX_CONTRACT, expected_month)
        if key in seen_bars:
            reasons.append("duplicate_contract_month_session")
        if reasons:
            record_unadmitted(_unadmitted(index, contract, month, reasons))
            continue

        seen_bars.add(key)
        admitted_settlement_price = settlement
        dataset = {
            "dataset_id": f"taifex_daily_fut-{TAIFEX_CONTRACT}-{expected_month}-{expected_date}",
            "case": "partial",
            "instrument": {
                "instrument_id": f"TAIFEX:{TAIFEX_CONTRACT}:{expected_month}",
                "market": "TAIFEX",
                "symbol": TAIFEX_CONTRACT,
                "display_name": f"臺股期貨 {expected_month}",
                "asset_class": TAIFEX_ASSET_CLASS,
                "currency": "TWD",
                "contract_month": expected_month,
                "expiry": None,
            },
            "periods_available": ["1D"],
            "unsupported_periods": [],
            "adjustment_policy": "unadjusted",
            "quality": {"status": "partial", "reason_codes": ["expiry_not_in_source"]},
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
        category_counts["admitted_regular_rows"] = category_counts.get("admitted_regular_rows", 0) + 1

    return {
        "trading_date": expected_date,
        "contract": TAIFEX_CONTRACT,
        "contract_month": expected_month,
        "available_at": available_at,
        "available_at_policy": AVAILABLE_AT_POLICY,
        "row_count": len(rows),
        "admitted_count": len(datasets),
        "unadmitted_count": len(unadmitted),
        "excluded_by_reason": excluded_by_reason,
        "category_counts": category_counts,
        "contract_metadata": {
            "contract": TAIFEX_CONTRACT,
            "asset_class": TAIFEX_ASSET_CLASS,
            "contract_month": expected_month,
            "expiry": None,
            "reason_codes": ["expiry_not_in_source"],
            "source_session": "一般",
            "session": "regular",
            "settlement_price": admitted_settlement_price,
        },
        "datasets": datasets,
        "unadmitted_rows": unadmitted,
    }


def _flatten_bars(fixture: KlineFixture) -> list[dict[str, Any]]:
    bars: list[dict[str, Any]] = []
    for dataset in fixture.datasets:
        for bar in dataset["bars"]:
            bars.append({"dataset_id": dataset["dataset_id"], "instrument": dataset["instrument"], **bar})
    return bars


def build_snapshot(*, source_metadata: Mapping[str, Any], mapping: Mapping[str, Any]) -> dict[str, Any]:
    source_id = str(source_metadata.get("source_id") or "")
    content_digest = str(source_metadata.get("content_digest") or "")
    retrieved_at = str(source_metadata.get("retrieved_at") or "")
    if not source_id or not content_digest or not retrieved_at:
        raise K6bSnapshotError("source metadata must include source_id, retrieved_at, and content_digest")
    trading_date = normalize_trading_date(str(mapping.get("trading_date") or ""))
    contract_month = normalize_contract_month(str(mapping.get("contract_month") or ""))
    datasets = mapping.get("datasets")
    if not isinstance(datasets, list) or not datasets:
        raise K6bSnapshotError("target contract month has no admitted regular-session row")
    contract_metadata = mapping.get("contract_metadata")
    if not isinstance(contract_metadata, Mapping) or contract_metadata.get("expiry") is not None:
        raise K6bSnapshotError("K6b expiry must remain null and explicit")

    fixture_payload = {
        "schema": KLINE_FIXTURE_SCHEMA,
        "as_of": _as_of_for_trading_date(trading_date),
        "ingested_at": retrieved_at,
        "provenance": {
            "source": "offline-fixture",
            "fixture_id": f"k6b-{source_id}-{TAIFEX_CONTRACT}-{contract_month}-{trading_date}",
            "network": False,
            "provider_calls": False,
        },
        "datasets": datasets,
    }
    fixture = KlineFixture.from_payload(fixture_payload)
    bars = _flatten_bars(fixture)
    snapshot = {
        "schema": K6B_SNAPSHOT_SCHEMA,
        "snapshot_id": f"{source_id}-{TAIFEX_CONTRACT}-{contract_month}-{trading_date}-{content_digest.split(':', 1)[-1][:20]}",
        "source_id": source_id,
        "trading_date": trading_date,
        "contract": TAIFEX_CONTRACT,
        "contract_month": contract_month,
        "asset_class": TAIFEX_ASSET_CLASS,
        "expiry": None,
        "expiry_reason": "expiry_not_in_source",
        "available_at": available_at_for_trading_date(trading_date),
        "available_at_policy": AVAILABLE_AT_POLICY,
        "retrieved_at": retrieved_at,
        "source_metadata": dict(source_metadata),
        "content_digest": content_digest,
        "contract_metadata": dict(contract_metadata),
        "row_counts": {
            "raw": int(mapping.get("row_count", 0)),
            "admitted": int(mapping.get("admitted_count", len(fixture.datasets))),
            "unadmitted": int(mapping.get("unadmitted_count", 0)),
            "excluded_by_reason": dict(mapping.get("excluded_by_reason") or {}),
            "category_counts": dict(mapping.get("category_counts") or {}),
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
        raise K6bSnapshotError(f"unable to read K6b snapshot: {snapshot_path}") from exc
    if not isinstance(payload, Mapping) or payload.get("schema") != K6B_SNAPSHOT_SCHEMA:
        raise K6bSnapshotError("unsupported K6b snapshot schema")
    if payload.get("asset_class") != TAIFEX_ASSET_CLASS or payload.get("expiry") is not None:
        raise K6bSnapshotError("K6b snapshot expiry/asset class contract mismatch")
    if payload.get("expiry_reason") != "expiry_not_in_source":
        raise K6bSnapshotError("K6b snapshot must explain missing expiry")
    fixture_payload = payload.get("kline_fixture")
    if not isinstance(fixture_payload, Mapping):
        raise K6bSnapshotError("K6b snapshot must contain a K1 fixture")
    KlineFixture.from_payload(fixture_payload)
    return dict(payload)


def bars_digest_from_mapping(mapping: Mapping[str, Any]) -> str:
    datasets = mapping.get("datasets")
    if not isinstance(datasets, list):
        raise K6bSnapshotError("mapping datasets must be a list")
    bars: list[dict[str, Any]] = []
    for dataset in datasets:
        if not isinstance(dataset, Mapping):
            raise K6bSnapshotError("mapping dataset must be an object")
        for bar in dataset.get("bars", []):
            bars.append({"dataset_id": dataset["dataset_id"], "instrument": dataset["instrument"], **bar})
    return _canonical_digest(bars)


__all__ = [
    "AVAILABLE_AT_POLICY",
    "K6B_SNAPSHOT_SCHEMA",
    "K6bSnapshotError",
    "TAIFEX_ASSET_CLASS",
    "TAIFEX_CONTRACT",
    "available_at_for_trading_date",
    "bars_digest_from_mapping",
    "build_snapshot",
    "load_snapshot",
    "map_taifex_rows",
    "normalize_contract_month",
    "normalize_trading_date",
    "parse_taifex_trading_date",
]
