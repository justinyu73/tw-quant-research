"""Product read-model alignment built from S4 mapping results."""
from __future__ import annotations

import hashlib
import json
from datetime import date
from typing import Any, Iterable, Mapping

from tw_quant_engine.formulas import (
    FORMULA_VERSION,
    daily_return_1d,
    revenue_mom,
    revenue_yoy,
    previous_calendar_month,
    same_month_previous_year,
)


PRODUCT_SCHEMA = "tw-quant-engine-product-row/v1"


def _candidate_value(result: Mapping[str, Any], key: str) -> Any:
    record = result.get("record")
    if isinstance(record, Mapping) and key in record:
        return record[key]
    candidate = result.get("candidate_fields")
    return candidate.get(key) if isinstance(candidate, Mapping) else None


def _provenance_row(result: Mapping[str, Any]) -> dict[str, Any]:
    provenance = result.get("provenance")
    if not isinstance(provenance, Mapping):
        return {}
    return {
        "source_id": provenance.get("source_id"),
        "endpoint": provenance.get("endpoint"),
        "snapshot_id": provenance.get("snapshot_id"),
        "content_digest": provenance.get("content_digest"),
        "license_ref": provenance.get("license_ref"),
        "available_at": _candidate_value(result, "available_at"),
    }


def _base_product_row(result: Mapping[str, Any]) -> dict[str, Any]:
    record_type = result.get("record_type")
    row: dict[str, Any] = {
        "schema": PRODUCT_SCHEMA,
        "formula_version": FORMULA_VERSION,
        "record_type": record_type,
        "instrument": {
            "security_id": _candidate_value(result, "security_id"),
            "market": result.get("market"),
        },
        "quality": {
            "admission_status": result.get("status"),
            "reason_codes": list(result.get("reason_codes", [])),
        },
        "provenance": _provenance_row(result),
    }
    if record_type == "price_bar":
        row["bar"] = {
            "trading_date": _candidate_value(result, "trading_date"),
            "open": _candidate_value(result, "open"),
            "high": _candidate_value(result, "high"),
            "low": _candidate_value(result, "low"),
            "close_raw": _candidate_value(result, "close"),
            "volume_shares": _candidate_value(result, "volume"),
            "daily_return_1d": None,
        }
    elif record_type == "fundamental_observation":
        row["fundamental"] = {
            "period_end": _candidate_value(result, "period_end"),
            "metric": _candidate_value(result, "metric"),
            "monthly_revenue": _candidate_value(result, "value"),
            "unit": _candidate_value(result, "unit"),
            "currency": _candidate_value(result, "currency"),
            "revenue_mom": None,
            "revenue_yoy": None,
        }
    return row


def _admitted_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in rows if row["quality"]["admission_status"] == "admitted"]


def _derive_price_returns(rows: list[dict[str, Any]]) -> None:
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in _admitted_rows(rows):
        if row["record_type"] == "price_bar":
            groups.setdefault(row["instrument"]["security_id"], []).append(row)
    for group in groups.values():
        group.sort(key=lambda row: row["bar"]["trading_date"])
        for previous, current in zip(group, group[1:]):
            result = daily_return_1d(
                current["bar"]["close_raw"],
                previous["bar"]["close_raw"],
                both_admitted=True,
            )
            current["bar"]["daily_return_1d"] = result.value
            if result.reason:
                current["quality"]["reason_codes"].append(result.reason)


def _derive_revenue_growth(rows: list[dict[str, Any]]) -> None:
    groups: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for row in _admitted_rows(rows):
        if row["record_type"] == "fundamental_observation":
            fundamental = row["fundamental"]
            key = (
                row["instrument"]["security_id"],
                fundamental["metric"],
                fundamental["unit"],
                fundamental["currency"],
            )
            groups.setdefault(key, []).append(row)
    for group in groups.values():
        by_period = {date.fromisoformat(row["fundamental"]["period_end"]): row for row in group}
        for period, current in by_period.items():
            prior_month = by_period.get(previous_calendar_month(period))
            prior_year = by_period.get(same_month_previous_year(period))
            if prior_month is not None:
                current["fundamental"]["revenue_mom"] = revenue_mom(
                    current["fundamental"]["monthly_revenue"],
                    prior_month["fundamental"]["monthly_revenue"],
                ).value
            if prior_year is not None:
                current["fundamental"]["revenue_yoy"] = revenue_yoy(
                    current["fundamental"]["monthly_revenue"],
                    prior_year["fundamental"]["monthly_revenue"],
                ).value


def build_product_rows(results: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    rows = [_base_product_row(result) for result in results]
    _derive_price_returns(rows)
    _derive_revenue_growth(rows)
    return rows


def product_digest(rows: Iterable[Mapping[str, Any]]) -> str:
    encoded = json.dumps(list(rows), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


__all__ = ["PRODUCT_SCHEMA", "build_product_rows", "product_digest"]
