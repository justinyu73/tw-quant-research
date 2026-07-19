"""Fail-closed quality checks for S5."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any, Iterable, Mapping

from tw_quant_engine.data_contract import ContractError, PointInTimeDataset, validate_record


QUALITY_SCHEMA = "tw-quant-engine-quality-report/v1"


def _issue(code: str, message: str, *, severity: str = "error") -> dict[str, str]:
    return {"code": code, "message": message, "severity": severity}


def _logical_key(record: Mapping[str, Any]) -> tuple[Any, ...]:
    record_type = record["record_type"]
    if record_type == "price_bar":
        return record_type, record["security_id"], record["trading_date"]
    if record_type == "fundamental_observation":
        return record_type, record["security_id"], record["metric"], record["period_end"]
    return record_type, record["security_id"], record["action_type"], record["ex_date"]


def _same_payload(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    ignored = {"snapshot_id", "source_ref"}
    return {key: value for key, value in left.items() if key not in ignored} == {
        key: value for key, value in right.items() if key not in ignored
    }


def check_records(
    records: Iterable[Mapping[str, Any]],
    provenance: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    """Validate records, provenance, monotonicity, units, and source conflicts."""
    issues: list[dict[str, str]] = []
    normalized: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        try:
            normalized.append(validate_record(record))
        except ContractError as exc:
            issues.append(_issue("invalid_record", f"record[{index}]: {exc}"))

    normalized_provenance = list(provenance)
    try:
        PointInTimeDataset(normalized, normalized_provenance)
    except (ContractError, TypeError) as exc:
        issues.append(_issue("invalid_provenance_or_duplicate", str(exc)))

    provenance_ids = {
        item.get("snapshot_id") for item in normalized_provenance if isinstance(item, Mapping)
    }
    for record in normalized:
        if record["snapshot_id"] not in provenance_ids:
            issues.append(_issue("missing_provenance", record["snapshot_id"]))

    by_security: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in normalized:
        if record["record_type"] == "price_bar":
            by_security[record["security_id"]].append(record)
    for security_id, rows in by_security.items():
        dates = [row["trading_date"] for row in rows]
        if dates != sorted(dates):
            issues.append(_issue("non_monotonic_trading_date", security_id))

    fundamental_groups: dict[tuple[str, str], set[tuple[str, str]]] = defaultdict(set)
    for record in normalized:
        if record["record_type"] == "fundamental_observation":
            fundamental_groups[(record["security_id"], record["metric"])].add(
                (record["unit"], record["currency"])
            )
    for key, units in fundamental_groups.items():
        if len(units) > 1:
            issues.append(_issue("mixed_fundamental_units", f"{key}: {sorted(units)}"))

    revisions: dict[tuple[Any, ...], list[dict[str, Any]]] = defaultdict(list)
    for record in normalized:
        revisions[_logical_key(record)].append(record)
    for key, rows in revisions.items():
        by_available: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            by_available[row["available_at"]].append(row)
        for available_at, candidates in by_available.items():
            if len(candidates) > 1 and any(not _same_payload(candidates[0], row) for row in candidates[1:]):
                issues.append(_issue("source_conflict", f"{key} at {available_at}"))

    status = "pass"
    if any(issue["code"] == "source_conflict" for issue in issues):
        status = "conflict"
    elif issues:
        status = "invalid"
    return {
        "schema": QUALITY_SCHEMA,
        "status": status,
        "record_count": len(normalized),
        "issues": issues,
    }


__all__ = ["QUALITY_SCHEMA", "check_records"]
