"""Deterministic read-only product view over the S4-S7 read models."""
from __future__ import annotations

import copy
import hashlib
import json
from collections import Counter
from datetime import date, datetime, timezone
from typing import Any, Iterable, Mapping


PRODUCT_VIEW_SCHEMA = "tw-quant-engine-read-only-product-view/v1"
READ_ONLY_ROUTES = frozenset({"/", "/health", "/products", "/features", "/backtest", "/evidence"})


class ProductViewError(ValueError):
    """Raised when a product view input cannot be represented safely."""


def _cutoff(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError as exc:
            raise ProductViewError("as_of must be an ISO timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ProductViewError("as_of must include an explicit timezone")
    return parsed.astimezone(timezone.utc)


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc)


def _status(row: Mapping[str, Any]) -> str:
    quality = row.get("quality")
    if not isinstance(quality, Mapping):
        return "invalid"
    status = quality.get("admission_status")
    return status if status in {"admitted", "unadmitted", "invalid"} else "invalid"


def _row_date(row: Mapping[str, Any]) -> date | None:
    for container_name, field in (("bar", "trading_date"), ("fundamental", "period_end")):
        container = row.get(container_name)
        if isinstance(container, Mapping) and isinstance(container.get(field), str):
            try:
                return date.fromisoformat(container[field])
            except ValueError:
                return None
    return None


def _row_available_at(row: Mapping[str, Any]) -> datetime | None:
    provenance = row.get("provenance")
    return _timestamp(provenance.get("available_at")) if isinstance(provenance, Mapping) else None


def _visible_product(row: Mapping[str, Any], cutoff: datetime) -> bool:
    row_date = _row_date(row)
    if row_date is not None and row_date > cutoff.date():
        return False
    available_at = _row_available_at(row)
    if available_at is not None:
        return available_at <= cutoff
    # Keep incomplete rows visible so the product can show its invalid/unadmitted state.
    return _status(row) != "admitted"


def _visible_feature(row: Mapping[str, Any], cutoff: datetime) -> bool:
    row_date = row.get("trading_date")
    if isinstance(row_date, str):
        try:
            if date.fromisoformat(row_date) > cutoff.date():
                return False
        except ValueError:
            return False
    feature_as_of = _timestamp(row.get("as_of"))
    return feature_as_of is None or feature_as_of <= cutoff


def _quality_summary(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    statuses: Counter[str] = Counter()
    reasons: Counter[str] = Counter()
    for row in rows:
        statuses[_status(row)] += 1
        quality = row.get("quality")
        if isinstance(quality, Mapping):
            for reason in quality.get("reason_codes", []):
                if isinstance(reason, str):
                    reasons[reason] += 1
    return {
        "status_counts": {key: statuses.get(key, 0) for key in ("admitted", "unadmitted", "invalid")},
        "reason_counts": dict(sorted(reasons.items())),
    }


def build_read_only_view(
    product_rows: Iterable[Mapping[str, Any]],
    feature_rows: Iterable[Mapping[str, Any]],
    backtest_result: Mapping[str, Any] | None,
    *,
    as_of: str | datetime,
    evidence_links: Iterable[str] = (),
) -> dict[str, Any]:
    """Assemble a view without deriving or mutating financial values."""
    cutoff = _cutoff(as_of)
    products = [copy.deepcopy(row) for row in product_rows if _visible_product(row, cutoff)]
    features = [copy.deepcopy(row) for row in feature_rows if _visible_feature(row, cutoff)]
    products.sort(key=lambda row: json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    features.sort(key=lambda row: json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")))

    if not backtest_result:
        backtest_state: dict[str, Any] = {"status": "empty", "result": None}
    else:
        result = copy.deepcopy(dict(backtest_result))
        result_as_of = _timestamp(result.get("as_of"))
        if result_as_of is None:
            backtest_state = {"status": "invalid", "result": result}
        elif result_as_of > cutoff:
            backtest_state = {"status": "future_hidden", "result": None}
        else:
            backtest_state = {"status": "available", "result": result}

    formula_versions = sorted(
        {
            row.get("formula_version")
            for row in [*products, *features]
            if isinstance(row.get("formula_version"), str)
        }
    )
    links = sorted({link for link in evidence_links if isinstance(link, str) and link})
    view = {
        "schema": PRODUCT_VIEW_SCHEMA,
        "read_only": True,
        "as_of": cutoff.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "products": products,
        "features": features,
        "backtest": backtest_state,
        "quality": _quality_summary(products),
        "formula_versions": formula_versions,
        "evidence_links": links,
        "numeric_field_registry": {
            "products": ["bar.open", "bar.high", "bar.low", "bar.close_raw", "bar.volume_shares", "bar.daily_return_1d", "fundamental.monthly_revenue", "fundamental.revenue_mom", "fundamental.revenue_yoy"],
            "features": ["features.<name>.value"],
            "backtest": ["equity_curve.equity", "metrics.cumulative_return", "metrics.annualized_return", "metrics.max_drawdown", "metrics.turnover", "metrics.trade_count"],
        },
        "empty_state": not products and not features and backtest_state["status"] == "empty",
    }
    return view


def read_only_request(view: Mapping[str, Any], method: str, path: str) -> dict[str, Any]:
    """Serve an in-memory GET-only view; no network/server is involved."""
    normalized_method = method.upper()
    if path not in READ_ONLY_ROUTES:
        return {"status": 404, "error": "unknown_route"}
    if normalized_method != "GET":
        return {"status": 405, "error": "read_only", "allow": ["GET"]}
    if path == "/":
        data: Any = copy.deepcopy(dict(view))
    elif path == "/health":
        data = {"schema": view.get("schema"), "read_only": view.get("read_only"), "as_of": view.get("as_of")}
    else:
        data = copy.deepcopy(view.get(path[1:]))
    return {"status": 200, "data": data}


def view_digest(view: Mapping[str, Any]) -> str:
    encoded = json.dumps(view, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


__all__ = ["PRODUCT_VIEW_SCHEMA", "ProductViewError", "READ_ONLY_ROUTES", "build_read_only_view", "read_only_request", "view_digest"]
