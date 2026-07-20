"""Offline S3-to-S2 source mapping with fail-closed admission semantics."""
from __future__ import annotations

import calendar
import hashlib
import json
import math
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from tw_quant_engine.data_contract import ContractError, validate_record


MAPPING_SCHEMA = "tw-quant-engine-s4-mapping-result/v1"
S3_FIXTURE_SCHEMA = "tw-quant-engine-s3-source-admission-fixture/v1"


def _pick(row: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        value = row.get(key)
        if value not in (None, "", "-"):
            return value
    return None


def _number(value: Any) -> int | float | None:
    if value in (None, "", "-", "--") or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value if math.isfinite(float(value)) else None
    text = str(value).strip().replace(",", "")
    if not text or text in {"-", "--"}:
        return None
    try:
        parsed = float(text)
    except ValueError:
        return None
    return int(parsed) if parsed.is_integer() else parsed


def parse_roc_date(value: Any) -> str:
    text = str(value).strip()
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        return date.fromisoformat(text).isoformat()
    slash_match = re.fullmatch(r"(\d{2,4})/(\d{1,2})/(\d{1,2})", text)
    if slash_match:
        year, month, day = (int(part) for part in slash_match.groups())
        return date(year if year >= 1911 else year + 1911, month, day).isoformat()
    if len(text) != 7 or not text.isdigit():
        raise ValueError(f"unsupported ROC date: {value!r}")
    year = int(text[:3]) + 1911
    month = int(text[3:5])
    day = int(text[5:7])
    return date(year, month, day).isoformat()


def parse_roc_period_end(value: Any) -> str:
    text = str(value).strip()
    if len(text) == 7 and text[4] == "-":
        return date.fromisoformat(text + "-01").replace(day=calendar.monthrange(int(text[:4]), int(text[5:7]))[1]).isoformat()
    if len(text) != 5 or not text.isdigit():
        raise ValueError(f"unsupported ROC period: {value!r}")
    year = int(text[:3]) + 1911
    month = int(text[3:5])
    return date(year, month, calendar.monthrange(year, month)[1]).isoformat()


def _timestamp(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _snapshot_id(source_id: str, digest: str) -> str:
    digest_text = digest.split(":", 1)[-1]
    stable = hashlib.sha256(f"{source_id}:{digest_text}".encode("utf-8")).hexdigest()[:20]
    return f"{source_id}-{stable}"


def _provenance(metadata: Mapping[str, Any], source_id: str) -> dict[str, Any]:
    return {
        "source_id": source_id,
        "snapshot_id": _snapshot_id(source_id, str(metadata.get("content_digest", "missing-digest"))),
        "endpoint": metadata.get("endpoint"),
        "retrieved_at": metadata.get("retrieved_at"),
        "content_digest": metadata.get("content_digest"),
        "schema_version": S3_FIXTURE_SCHEMA,
        "license_ref": metadata.get("license_ref"),
    }


def _base_result(item: Mapping[str, Any], *, record_type: str | None, market: str | None) -> dict[str, Any]:
    metadata = item.get("metadata")
    if not isinstance(metadata, Mapping):
        return {
            "schema": MAPPING_SCHEMA,
            "source_id": "unknown",
            "market": market,
            "record_type": record_type,
            "status": "invalid",
            "reason_codes": ["missing_source_metadata"],
            "candidate_fields": {},
            "record": None,
            "provenance": {},
        }
    source_id = str(metadata.get("source_id", "unknown"))
    return {
        "schema": MAPPING_SCHEMA,
        "source_id": source_id,
        "market": market,
        "record_type": record_type,
        "status": "invalid" if metadata.get("http_status") != 200 else "unadmitted",
        "reason_codes": [] if metadata.get("http_status") == 200 else ["source_response_not_200"],
        "candidate_fields": {},
        "record": None,
        "provenance": _provenance(metadata, source_id),
    }


def _finish(result: dict[str, Any], item: Mapping[str, Any]) -> dict[str, Any]:
    metadata = item["metadata"]
    row = item.get("sample_row")
    if not isinstance(row, Mapping):
        result["reason_codes"].append("empty_source_sample")
        return result
    if result["status"] == "invalid":
        return result
    for field in ("endpoint", "retrieved_at", "content_digest", "license_ref"):
        if not result["provenance"].get(field):
            result["reason_codes"].append(f"missing_provenance_{field}")
    available_at = _timestamp(_pick(row, "available_at", "published_at", "publication_time", "發布時間", "發佈時間"))
    if available_at is None:
        result["reason_codes"].append("missing_source_available_at")
    result["candidate_fields"]["available_at"] = available_at
    if result["record_type"] == "fundamental_observation":
        reported_at = _timestamp(_pick(row, "reported_at", "reported_time", "出表時間", "發表時間"))
        result["candidate_fields"]["reported_at"] = reported_at
        if reported_at is None:
            result["reason_codes"].append("missing_source_reported_at")
        if not result["candidate_fields"].get("unit"):
            result["reason_codes"].append("missing_source_unit")
        if not result["candidate_fields"].get("currency"):
            result["reason_codes"].append("missing_source_currency")
    if result["reason_codes"]:
        return result

    candidate = result["candidate_fields"]
    try:
        record = {
            "record_type": result["record_type"],
            **candidate,
            "source_ref": metadata["endpoint"],
            "snapshot_id": result["provenance"]["snapshot_id"],
        }
        result["record"] = validate_record(record)
        result["status"] = "admitted"
    except (ContractError, KeyError, TypeError) as exc:
        result["status"] = "invalid"
        result["reason_codes"].append(f"canonical_validation_failed:{type(exc).__name__}")
    return result


def map_source_item(item: Mapping[str, Any]) -> dict[str, Any]:
    metadata = item.get("metadata")
    source_id = metadata.get("source_id") if isinstance(metadata, Mapping) else None
    row = item.get("sample_row") if isinstance(item.get("sample_row"), Mapping) else {}
    market = "TWSE" if str(source_id).startswith("twse_") else "TPEX" if str(source_id).startswith("tpex_") else None
    if source_id == "mops_landing":
        result = _base_result(item, record_type=None, market=None)
        result["reason_codes"].append("disclosure_context_only")
        result["status"] = "unadmitted"
        return result
    if source_id not in {"twse_daily_close", "tpex_daily_close", "twse_monthly_revenue", "tpex_monthly_revenue"}:
        result = _base_result(item, record_type=None, market=market)
        result["reason_codes"].append("unsupported_source_record_type")
        return result

    is_price = source_id.endswith("daily_close")
    result = _base_result(item, record_type="price_bar" if is_price else "fundamental_observation", market=market)
    if is_price:
        if source_id == "twse_daily_close":
            fields = {
                "security_id": _pick(row, "Code", "證券代號"),
                "trading_date": _pick(row, "Date", "日期"),
                "open": _number(_pick(row, "OpeningPrice", "開盤價")),
                "high": _number(_pick(row, "HighestPrice", "最高價")),
                "low": _number(_pick(row, "LowestPrice", "最低價")),
                "close": _number(_pick(row, "ClosingPrice", "收盤價")),
                "volume": _number(_pick(row, "TradeVolume", "成交股數")),
            }
        else:
            fields = {
                "security_id": _pick(row, "SecuritiesCompanyCode", "證券代號"),
                "trading_date": _pick(row, "Date", "日期"),
                "open": _number(_pick(row, "Open", "開盤價")),
                "high": _number(_pick(row, "High", "最高價")),
                "low": _number(_pick(row, "Low", "最低價")),
                "close": _number(_pick(row, "Close", "收盤價")),
                "volume": _number(_pick(row, "TradingShares", "成交股數")),
            }
        if fields["trading_date"] is not None:
            try:
                fields["trading_date"] = parse_roc_date(fields["trading_date"])
            except ValueError:
                result["reason_codes"].append("invalid_trading_date")
        fields["currency"] = _pick(row, "currency") or "TWD"
        result["candidate_fields"].update(fields)
    else:
        fields = {
            "security_id": _pick(row, "公司代號", "Code"),
            "metric": "monthly_revenue",
            "period_end": None,
            "value": _number(_pick(row, "營業收入-當月營收", "當月營收", "Revenue")),
            "unit": _pick(row, "unit", "source_unit"),
            "currency": _pick(row, "currency"),
        }
        period = _pick(row, "資料年月", "period_end", "Date")
        if period is not None:
            try:
                fields["period_end"] = parse_roc_period_end(period)
            except ValueError:
                result["reason_codes"].append("invalid_period_end")
        result["candidate_fields"].update(fields)
    return _finish(result, item)


def map_s3_fixture(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    if payload.get("schema") != S3_FIXTURE_SCHEMA:
        raise ValueError("S3 fixture schema mismatch")
    fetches = payload.get("fetches")
    if not isinstance(fetches, list):
        raise ValueError("S3 fixture fetches must be a list")
    return [map_source_item(item) for item in fetches]


def load_s3_fixture(path: str | Path) -> list[dict[str, Any]]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError("S3 fixture root must be an object")
    return map_s3_fixture(payload)


__all__ = [
    "MAPPING_SCHEMA",
    "S3_FIXTURE_SCHEMA",
    "load_s3_fixture",
    "map_s3_fixture",
    "map_source_item",
    "parse_roc_date",
    "parse_roc_period_end",
]
