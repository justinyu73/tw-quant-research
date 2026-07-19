"""Point-in-time, deterministic feature pipeline for S6."""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, timezone
from statistics import pstdev
from typing import Any, Iterable, Mapping

from tw_quant_engine.data_contract import PointInTimeDataset


FEATURE_SCHEMA = "tw-quant-engine-feature-row/v1"
FEATURE_VERSION = "s6-v1"


def _cutoff(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
        parsed = datetime.fromisoformat(candidate)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("as_of must include an explicit timezone")
    return parsed.astimezone(timezone.utc)


def _feature(value: float | None, unit: str, window: int, reason: str | None, snapshots: list[str]) -> dict[str, Any]:
    return {
        "value": value,
        "unit": unit,
        "window": window,
        "status": "admitted" if reason is None else "unadmitted",
        "reason": reason,
        "source_snapshot_ids": snapshots,
    }


def _price_rows(records: Iterable[Mapping[str, Any]], as_of: datetime) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        if record["record_type"] != "price_bar":
            continue
        if date.fromisoformat(record["trading_date"]) > as_of.date():
            continue
        grouped.setdefault(record["security_id"], []).append(dict(record))
    for rows in grouped.values():
        rows.sort(key=lambda row: row["trading_date"])
    return grouped


def build_feature_rows(
    records: Iterable[Mapping[str, Any]],
    provenance: Iterable[Mapping[str, Any]],
    *,
    as_of: str | datetime,
) -> list[dict[str, Any]]:
    """Build features only from records visible at the supplied PIT cutoff."""
    cutoff = _cutoff(as_of)
    visible = PointInTimeDataset(records, provenance).as_of(cutoff.isoformat().replace("+00:00", "Z"))
    grouped = _price_rows(visible, cutoff)
    output: list[dict[str, Any]] = []
    for security_id, rows in grouped.items():
        for index, row in enumerate(rows):
            closes = [float(item["close"]) for item in rows]
            volumes = [float(item["volume"]) for item in rows]
            snapshots = [row["snapshot_id"]]
            features: dict[str, dict[str, Any]] = {}

            if index < 1:
                features["return_1d"] = _feature(None, "ratio", 1, "insufficient_window", snapshots)
            else:
                features["return_1d"] = _feature(closes[index] / closes[index - 1] - 1, "ratio", 1, None, [rows[index - 1]["snapshot_id"], row["snapshot_id"]])

            if index < 5:
                features["return_5d"] = _feature(None, "ratio", 5, "insufficient_window", snapshots)
                features["volatility_5d"] = _feature(None, "ratio", 5, "insufficient_window", snapshots)
            else:
                return_values = [closes[position] / closes[position - 1] - 1 for position in range(index - 4, index + 1)]
                features["return_5d"] = _feature(closes[index] / closes[index - 5] - 1, "ratio", 5, None, [item["snapshot_id"] for item in rows[index - 5 : index + 1]])
                features["volatility_5d"] = _feature(pstdev(return_values), "ratio", 5, None, [item["snapshot_id"] for item in rows[index - 5 : index + 1]])

            if index < 4:
                features["volume_mean_5d"] = _feature(None, "shares", 5, "insufficient_window", snapshots)
            else:
                features["volume_mean_5d"] = _feature(sum(volumes[index - 4 : index + 1]) / 5, "shares", 5, None, [item["snapshot_id"] for item in rows[index - 4 : index + 1]])

            output.append(
                {
                    "schema": FEATURE_SCHEMA,
                    "formula_version": FEATURE_VERSION,
                    "security_id": security_id,
                    "market": "unknown",
                    "trading_date": row["trading_date"],
                    "as_of": cutoff.isoformat(timespec="microseconds").replace("+00:00", "Z"),
                    "price_basis": "close_raw",
                    "features": features,
                }
            )
    return output


def feature_digest(rows: Iterable[Mapping[str, Any]]) -> str:
    encoded = json.dumps(list(rows), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


__all__ = ["FEATURE_SCHEMA", "FEATURE_VERSION", "build_feature_rows", "feature_digest"]
