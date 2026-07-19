"""Canonical, provider-neutral point-in-time data contract for S2.

The implementation is intentionally dependency-free. Qlib and any Taiwan
data adapter must consume this contract; neither is allowed to define it.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping


DATA_CONTRACT_SCHEMA = "tw-quant-engine-data-contract/v1"
FIXTURE_SCHEMA = "tw-quant-engine-s2-pit-fixture/v1"


class ContractError(ValueError):
    """Raised when a record violates the canonical data contract."""


DATA_FIELDS: dict[str, frozenset[str]] = {
    "price_bar": frozenset(
        {
            "record_type",
            "security_id",
            "trading_date",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "currency",
            "available_at",
            "source_ref",
            "snapshot_id",
        }
    ),
    "fundamental_observation": frozenset(
        {
            "record_type",
            "security_id",
            "metric",
            "period_end",
            "reported_at",
            "available_at",
            "value",
            "unit",
            "currency",
            "source_ref",
            "snapshot_id",
        }
    ),
    "corporate_action": frozenset(
        {
            "record_type",
            "security_id",
            "action_type",
            "ex_date",
            "announced_at",
            "available_at",
            "factor",
            "cash_amount",
            "currency",
            "source_ref",
            "snapshot_id",
        }
    ),
}

PROVENANCE_FIELDS = frozenset(
    {
        "source_id",
        "snapshot_id",
        "retrieved_at",
        "content_digest",
        "schema_version",
        "license_ref",
    }
)


def _non_empty(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{field} must be a non-empty string")
    return value.strip()


def _date(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ContractError(f"{field} must be an ISO date string")
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise ContractError(f"{field} must be an ISO date string") from exc


def _timestamp(value: Any, field: str) -> str:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError as exc:
            raise ContractError(f"{field} must be an ISO timestamp") from exc
    else:
        raise ContractError(f"{field} must be an ISO timestamp")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ContractError(f"{field} must include an explicit timezone")
    normalized = parsed.astimezone(timezone.utc)
    return normalized.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _number(value: Any, field: str, *, non_negative: bool = False) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractError(f"{field} must be a JSON number")
    if isinstance(value, float) and not math.isfinite(value):
        raise ContractError(f"{field} must be finite")
    if non_negative and value < 0:
        raise ContractError(f"{field} must be non-negative")
    return value


def _validate_provenance(item: Mapping[str, Any]) -> dict[str, Any]:
    if set(item) != PROVENANCE_FIELDS:
        missing = sorted(PROVENANCE_FIELDS - set(item))
        unknown = sorted(set(item) - PROVENANCE_FIELDS)
        raise ContractError(f"provenance fields invalid; missing={missing}, unknown={unknown}")
    return {
        "source_id": _non_empty(item["source_id"], "source_id"),
        "snapshot_id": _non_empty(item["snapshot_id"], "snapshot_id"),
        "retrieved_at": _timestamp(item["retrieved_at"], "retrieved_at"),
        "content_digest": _non_empty(item["content_digest"], "content_digest"),
        "schema_version": _non_empty(item["schema_version"], "schema_version"),
        "license_ref": _non_empty(item["license_ref"], "license_ref"),
    }


def validate_record(item: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and normalize one provider-neutral data record."""
    if not isinstance(item, Mapping):
        raise ContractError("record must be an object")
    record_type = item.get("record_type")
    if record_type not in DATA_FIELDS:
        raise ContractError(f"unsupported record_type: {record_type!r}")
    fields = DATA_FIELDS[record_type]
    missing = sorted(fields - set(item))
    unknown = sorted(set(item) - fields)
    if missing or unknown:
        raise ContractError(f"record fields invalid; missing={missing}, unknown={unknown}")

    result: dict[str, Any] = {
        "record_type": record_type,
        "security_id": _non_empty(item["security_id"], "security_id"),
        "available_at": _timestamp(item["available_at"], "available_at"),
        "source_ref": _non_empty(item["source_ref"], "source_ref"),
        "snapshot_id": _non_empty(item["snapshot_id"], "snapshot_id"),
    }

    if record_type == "price_bar":
        result.update(
            {
                "trading_date": _date(item["trading_date"], "trading_date"),
                "open": _number(item["open"], "open"),
                "high": _number(item["high"], "high"),
                "low": _number(item["low"], "low"),
                "close": _number(item["close"], "close"),
                "volume": _number(item["volume"], "volume", non_negative=True),
                "currency": _non_empty(item["currency"], "currency"),
            }
        )
        if result["low"] > min(result["open"], result["close"]):
            raise ContractError("price_bar low is above open/close")
        if result["high"] < max(result["open"], result["close"]):
            raise ContractError("price_bar high is below open/close")
    elif record_type == "fundamental_observation":
        result.update(
            {
                "metric": _non_empty(item["metric"], "metric"),
                "period_end": _date(item["period_end"], "period_end"),
                "reported_at": _timestamp(item["reported_at"], "reported_at"),
                "value": _number(item["value"], "value"),
                "unit": _non_empty(item["unit"], "unit"),
                "currency": _non_empty(item["currency"], "currency"),
            }
        )
    else:
        result.update(
            {
                "action_type": _non_empty(item["action_type"], "action_type"),
                "ex_date": _date(item["ex_date"], "ex_date"),
                "announced_at": _timestamp(item["announced_at"], "announced_at"),
                "factor": _number(item["factor"], "factor"),
                "cash_amount": _number(item["cash_amount"], "cash_amount"),
                "currency": _non_empty(item["currency"], "currency"),
            }
        )
        if result["factor"] <= 0:
            raise ContractError("corporate_action factor must be positive")
    return result


def _canonical_key(record: Mapping[str, Any]) -> tuple[Any, ...]:
    record_type = record["record_type"]
    if record_type == "price_bar":
        identity = (record["security_id"], record["trading_date"])
    elif record_type == "fundamental_observation":
        identity = (record["security_id"], record["metric"], record["period_end"])
    else:
        identity = (record["security_id"], record["action_type"], record["ex_date"])
    return (record_type, *identity, record["snapshot_id"])


def _logical_key(record: Mapping[str, Any]) -> tuple[Any, ...]:
    return _canonical_key({**record, "snapshot_id": "__version__"})


class PointInTimeDataset:
    """Validated records with an as-of view that selects visible revisions."""

    def __init__(
        self,
        records: Iterable[Mapping[str, Any]],
        provenance: Iterable[Mapping[str, Any]],
    ) -> None:
        normalized_provenance = [_validate_provenance(item) for item in provenance]
        provenance_ids = {item["snapshot_id"] for item in normalized_provenance}
        if len(provenance_ids) != len(normalized_provenance):
            raise ContractError("duplicate provenance snapshot_id")
        normalized_records = [validate_record(item) for item in records]
        missing_provenance = sorted(
            {item["snapshot_id"] for item in normalized_records} - provenance_ids
        )
        if missing_provenance:
            raise ContractError(f"records reference unknown snapshots: {missing_provenance}")
        keys = [_canonical_key(item) for item in normalized_records]
        if len(set(keys)) != len(keys):
            raise ContractError("duplicate canonical record key")
        self._records = tuple(normalized_records)
        self._provenance = tuple(
            sorted(normalized_provenance, key=lambda item: item["snapshot_id"])
        )

    @classmethod
    def from_fixture(cls, payload: Mapping[str, Any]) -> "PointInTimeDataset":
        if payload.get("schema") != FIXTURE_SCHEMA:
            raise ContractError("fixture schema mismatch")
        records = payload.get("records")
        provenance = payload.get("provenance")
        if not isinstance(records, list) or not isinstance(provenance, list):
            raise ContractError("fixture must contain records and provenance arrays")
        return cls(records=records, provenance=provenance)

    def as_of(self, as_of: str | datetime) -> list[dict[str, Any]]:
        """Return the latest visible version of each logical record as of a time."""
        cutoff = _timestamp(as_of, "as_of")
        cutoff_dt = datetime.fromisoformat(cutoff.replace("Z", "+00:00"))
        visible: dict[tuple[Any, ...], dict[str, Any]] = {}
        for record in self._records:
            available_dt = datetime.fromisoformat(
                record["available_at"].replace("Z", "+00:00")
            )
            if available_dt > cutoff_dt:
                continue
            key = _logical_key(record)
            current = visible.get(key)
            if current is None:
                visible[key] = record
                continue
            current_dt = datetime.fromisoformat(
                current["available_at"].replace("Z", "+00:00")
            )
            if available_dt > current_dt:
                visible[key] = record
            elif available_dt == current_dt and _canonical_key(record) != _canonical_key(current):
                raise ContractError("ambiguous revisions share the same available_at")
        return [
            copy.deepcopy(record)
            for record in sorted(
                visible.values(), key=lambda item: _canonical_key(item)
            )
        ]

    def digest(self) -> str:
        payload = {
            "schema": DATA_CONTRACT_SCHEMA,
            "provenance": list(self._provenance),
            "records": sorted(self._records, key=_canonical_key),
        }
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


def load_fixture(path: str | Path) -> PointInTimeDataset:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ContractError("fixture root must be an object")
    return PointInTimeDataset.from_fixture(payload)


__all__ = [
    "ContractError",
    "DATA_CONTRACT_SCHEMA",
    "FIXTURE_SCHEMA",
    "PointInTimeDataset",
    "load_fixture",
    "validate_record",
]
