"""P6 valuation & analysis: fail-closed worksheet validation, deterministic fair-value models, price/volume indicators.

Scope per docs/tqe-p6-valuation-analysis-contract.md:
- fair value worksheets (tqe-fair-value-worksheet/v1) compute fair value from
  explicit user-supplied assumptions only; every input is labelled
  user_supplied_assumption with data status draft — never official data,
  market consensus, or an official forward estimate;
- price/volume indicators (z-score, price percentile, MA deviation) are
  computed deterministically from admitted EOD data (raw close basis);
- worksheets persist as a flat versioned JSON store (tqe-fair-value-worksheets/v1),
  watchlist style, owned by the local app; nothing leaves the local machine;
- no order, simulated order, credential, or provider code path exists here.
"""
from __future__ import annotations

import copy
import re
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence


WORKSHEET_SCHEMA = "tqe-fair-value-worksheet/v1"
WORKSHEET_STORE_SCHEMA = "tqe-fair-value-worksheets/v1"
WORKSHEET_STORE_VERSION = 1
EVALUATION_SCHEMA = "tqe-fair-value-evaluation/v1"
INDICATOR_RESULT_SCHEMA = "tqe-price-volume-indicator/v1"
FORMULA_VERSION = "tqe-fair-value/v1"
MAX_WORKSHEETS = 50
MAX_INDICATOR_PERIOD = 250

MODEL_TYPES = ("pe_multiple", "dividend_discount_simple", "growth_adjusted_pe")
INDICATOR_TYPES = ("zscore", "price_percentile", "ma_deviation")
PRICE_BASIS = "close"
STD_CONVENTION = "population"
ASSUMPTION_SOURCE = "user_supplied_assumption"
DATA_STATUS = "draft"

_WORKSHEET_ID_PATTERN = re.compile(r"^[A-Za-z0-9:_.-]+$")
_WORKSHEET_KEYS = frozenset(
    {"schema", "worksheet_id", "label", "target", "model", "safety_margin", "assumption_notes", "created_at"}
)
_MODEL_KEYS = {
    "pe_multiple": frozenset({"type", "eps", "target_pe"}),
    "dividend_discount_simple": frozenset({"type", "dps", "growth_rate", "discount_rate"}),
    "growth_adjusted_pe": frozenset({"type", "eps", "growth_pct", "peg"}),
}


class ValuationValidationError(ValueError):
    """Raised when a worksheet, store, or indicator request fails fail-closed validation."""


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValuationValidationError(f"{field} must be an ISO 8601 timestamp")
    candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError as exc:
        raise ValuationValidationError(f"{field} must be an ISO 8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValuationValidationError(f"{field} must include an explicit timezone")
    return parsed.astimezone(timezone.utc)


def _isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValuationValidationError(f"{field} must be a number")
    if value != value or value in (float("inf"), float("-inf")):
        raise ValuationValidationError(f"{field} must be finite")
    return float(value)


def _positive(value: Any, field: str) -> float:
    result = _number(value, field)
    if result <= 0:
        raise ValuationValidationError(f"{field} must be positive")
    return result


def _validate_target(target: Any, admitted_security_ids: Iterable[str]) -> dict[str, Any]:
    if not isinstance(target, Mapping) or set(target) != {"security_id"}:
        raise ValuationValidationError("target must be exactly {security_id}")
    security_id = target["security_id"]
    if not isinstance(security_id, str) or not security_id:
        raise ValuationValidationError("target.security_id must be a non-empty string")
    if security_id not in set(admitted_security_ids):
        raise ValuationValidationError(f"target security {security_id!r} is outside the admitted universe")
    return {"security_id": security_id}


def _validate_model(model: Any) -> dict[str, Any]:
    if not isinstance(model, Mapping):
        raise ValuationValidationError("model must be an object")
    kind = model.get("type")
    if kind not in _MODEL_KEYS:
        raise ValuationValidationError(f"unknown model type {kind!r}")
    if set(model) != _MODEL_KEYS[kind]:
        raise ValuationValidationError(f"{kind} model has unknown or missing fields")
    if kind == "pe_multiple":
        return {
            "type": kind,
            "eps": _positive(model["eps"], "model.eps"),
            "target_pe": _positive(model["target_pe"], "model.target_pe"),
        }
    if kind == "dividend_discount_simple":
        dps = _positive(model["dps"], "model.dps")
        growth = _number(model["growth_rate"], "model.growth_rate")
        discount = _positive(model["discount_rate"], "model.discount_rate")
        if growth <= -1:
            raise ValuationValidationError("model.growth_rate must be greater than -1")
        if discount <= growth:
            raise ValuationValidationError("model.discount_rate must be greater than model.growth_rate")
        return {"type": kind, "dps": dps, "growth_rate": growth, "discount_rate": discount}
    eps = _positive(model["eps"], "model.eps")
    growth_pct = _number(model["growth_pct"], "model.growth_pct")
    peg = _number(model["peg"], "model.peg")
    if growth_pct * peg <= 0:
        raise ValuationValidationError("model.growth_pct x model.peg must be positive")
    return {"type": kind, "eps": eps, "growth_pct": growth_pct, "peg": peg}


def validate_worksheet(definition: Any, admitted_security_ids: Iterable[str]) -> dict[str, Any]:
    """Fail-closed validation of one tqe-fair-value-worksheet/v1 definition."""
    if not isinstance(definition, Mapping):
        raise ValuationValidationError("worksheet must be an object")
    unknown = set(definition) - _WORKSHEET_KEYS
    if unknown:
        raise ValuationValidationError(f"worksheet has unknown fields: {sorted(unknown)}")
    if definition.get("schema") != WORKSHEET_SCHEMA:
        raise ValuationValidationError("worksheet schema must be tqe-fair-value-worksheet/v1")
    worksheet_id = definition.get("worksheet_id")
    if not isinstance(worksheet_id, str) or not worksheet_id or len(worksheet_id) > 64 or not _WORKSHEET_ID_PATTERN.match(worksheet_id):
        raise ValuationValidationError("worksheet_id must be 1-64 chars of [A-Za-z0-9:_.-]")
    label = definition.get("label")
    if not isinstance(label, str) or not label.strip() or len(label) > 120:
        raise ValuationValidationError("label must be a non-empty string of at most 120 chars")
    safety_margin = _number(definition.get("safety_margin"), "safety_margin")
    if safety_margin < 0 or safety_margin >= 1:
        raise ValuationValidationError("safety_margin must be a fraction in [0, 1)")
    notes = definition.get("assumption_notes")
    if not isinstance(notes, str) or len(notes) > 500:
        raise ValuationValidationError("assumption_notes must be a string of at most 500 chars")
    created_at = _timestamp(definition.get("created_at"), "created_at")
    return {
        "schema": WORKSHEET_SCHEMA,
        "worksheet_id": worksheet_id,
        "label": label.strip(),
        "target": _validate_target(definition.get("target"), admitted_security_ids),
        "model": _validate_model(definition.get("model")),
        "safety_margin": safety_margin,
        "assumption_notes": notes,
        "created_at": _isoformat(created_at),
    }


def serialize_worksheet_store(definitions: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Flat versioned JSON store (watchlist style); session-local, never leaves the machine."""
    worksheets = [copy.deepcopy(dict(definition)) for definition in definitions if isinstance(definition, Mapping)]
    return {"schema": WORKSHEET_STORE_SCHEMA, "version": WORKSHEET_STORE_VERSION, "worksheets": worksheets}


def parse_worksheet_store(payload: Any, admitted_security_ids: Iterable[str]) -> list[dict[str, Any]]:
    """Fail-closed parse of a tqe-fair-value-worksheets/v1 store payload."""
    if not isinstance(payload, Mapping):
        raise ValuationValidationError("worksheet store must be an object")
    if payload.get("schema") != WORKSHEET_STORE_SCHEMA:
        raise ValuationValidationError("worksheet store schema must be tqe-fair-value-worksheets/v1")
    if payload.get("version") != WORKSHEET_STORE_VERSION:
        raise ValuationValidationError("worksheet store version must be 1")
    raw = payload.get("worksheets")
    if not isinstance(raw, list):
        raise ValuationValidationError("worksheet store worksheets must be a list")
    if len(raw) > MAX_WORKSHEETS:
        raise ValuationValidationError(f"worksheet store cannot contain more than {MAX_WORKSHEETS} worksheets")
    worksheets = [validate_worksheet(definition, admitted_security_ids) for definition in raw]
    ids = [worksheet["worksheet_id"] for worksheet in worksheets]
    if len(set(ids)) != len(ids):
        raise ValuationValidationError("worksheet store worksheet_id values must be unique")
    return worksheets


def compute_fair_value(model: Mapping[str, Any]) -> float:
    """Exact fair value per model (formula version tqe-fair-value/v1)."""
    kind = model["type"]
    if kind == "pe_multiple":
        return model["eps"] * model["target_pe"]
    if kind == "dividend_discount_simple":
        return model["dps"] * (1 + model["growth_rate"]) / (model["discount_rate"] - model["growth_rate"])
    if kind == "growth_adjusted_pe":
        return model["eps"] * (model["growth_pct"] * model["peg"])
    raise ValuationValidationError(f"unknown model type {kind!r}")


def _comparison(current_price: float, fair_value: float, buy_zone_ceiling: float) -> dict[str, Any]:
    vs_fair = "above" if current_price > fair_value else "below" if current_price < fair_value else "at"
    return {
        "vs_fair_value": vs_fair,
        "vs_buy_zone_ceiling": "below" if current_price < buy_zone_ceiling else "above_or_at",
        "gap_to_fair_value_pct": (current_price - fair_value) / fair_value,
        "gap_to_buy_zone_ceiling_pct": (current_price - buy_zone_ceiling) / buy_zone_ceiling,
        "research_comparison_only": True,
    }


def evaluate_worksheet(worksheet: Mapping[str, Any], bars: Sequence[Mapping[str, Any]] | None) -> dict[str, Any]:
    """Deterministic derived outputs for one validated worksheet.

    ``bars`` is the admitted EOD series (raw close basis). Missing or empty
    data fails closed to an insufficient_data state; nothing is fetched or
    extrapolated. The comparison is a research note, never a recommendation.
    """
    fair_value = compute_fair_value(worksheet["model"])
    buy_zone_ceiling = fair_value * (1 - worksheet["safety_margin"])
    base = {
        "worksheet_id": worksheet["worksheet_id"],
        "label": worksheet["label"],
        "security_id": worksheet["target"]["security_id"],
        "fair_value": fair_value,
        "buy_zone_ceiling": buy_zone_ceiling,
        "model": copy.deepcopy(dict(worksheet["model"])),
        "safety_margin": worksheet["safety_margin"],
        "formula_version": FORMULA_VERSION,
        "assumption_source": ASSUMPTION_SOURCE,
        "data_status": DATA_STATUS,
        "research_only": True,
    }
    admitted = [bar for bar in (bars or []) if isinstance(bar, Mapping) and isinstance(bar.get("close"), (int, float)) and not isinstance(bar.get("close"), bool)]
    if not admitted:
        base.update({"status": "insufficient_data", "current_price": None, "price_as_of": None, "comparison": None})
        return base
    latest = admitted[-1]
    current_price = float(latest["close"])
    base.update(
        {
            "status": "ok",
            "current_price": current_price,
            "price_as_of": latest.get("trading_date"),
            "price_basis": PRICE_BASIS,
            "comparison": _comparison(current_price, fair_value, buy_zone_ceiling),
        }
    )
    return base


def evaluate_worksheets(
    definitions: Iterable[Mapping[str, Any]],
    market_data: Mapping[str, Sequence[Mapping[str, Any]] | None],
) -> dict[str, Any]:
    """Evaluate validated worksheets against admitted read-model bars; deterministic."""
    results = []
    for definition in definitions:
        worksheet = copy.deepcopy(dict(definition))
        security_id = worksheet["target"]["security_id"]
        results.append(evaluate_worksheet(worksheet, market_data.get(security_id)))
    return {
        "schema": EVALUATION_SCHEMA,
        "formula_version": FORMULA_VERSION,
        "assumption_source": ASSUMPTION_SOURCE,
        "data_status": DATA_STATUS,
        "results": results,
    }


def validate_indicator_request(request: Any, admitted_security_ids: Iterable[str]) -> dict[str, Any]:
    """Fail-closed validation of one price/volume indicator request."""
    if not isinstance(request, Mapping):
        raise ValuationValidationError("indicator request must be an object")
    if set(request) != {"type", "security_id", "period"}:
        raise ValuationValidationError("indicator request must be exactly {type, security_id, period}")
    kind = request["type"]
    if kind not in INDICATOR_TYPES:
        raise ValuationValidationError(f"unknown indicator type {kind!r}")
    security_id = request["security_id"]
    if not isinstance(security_id, str) or not security_id:
        raise ValuationValidationError("indicator security_id must be a non-empty string")
    if security_id not in set(admitted_security_ids):
        raise ValuationValidationError(f"indicator security {security_id!r} is outside the admitted universe")
    period = request["period"]
    if isinstance(period, bool) or not isinstance(period, int) or period < 1 or period > MAX_INDICATOR_PERIOD:
        raise ValuationValidationError(f"indicator period must be an integer in [1, {MAX_INDICATOR_PERIOD}]")
    return {"type": kind, "security_id": security_id, "period": period}


def compute_indicator(kind: str, closes: Sequence[float], period: int) -> dict[str, Any]:
    """Deterministic price/volume indicator over admitted closes (raw close basis).

    Insufficient admitted history fails closed to insufficient_data; nothing is
    extrapolated. Z-score uses the recorded population standard deviation
    convention (divide by N).
    """
    result = {
        "schema": INDICATOR_RESULT_SCHEMA,
        "type": kind,
        "period": period,
        "price_basis": PRICE_BASIS,
        "research_only": True,
    }
    if kind == "zscore":
        result["std_convention"] = STD_CONVENTION
    window = [float(value) for value in closes][-period:] if len(closes) >= period else []
    if not window:
        result.update({"status": "insufficient_data", "value": None})
        return result
    latest = window[-1]
    if kind == "zscore":
        mean = sum(window) / period
        variance = sum((value - mean) ** 2 for value in window) / period
        std = variance ** 0.5
        value = 0.0 if std == 0 else (latest - mean) / std
    elif kind == "price_percentile":
        value = sum(1 for item in window if item <= latest) / period * 100.0
    elif kind == "ma_deviation":
        sma = sum(window) / period
        if sma <= 0:
            result.update({"status": "insufficient_data", "value": None})
            return result
        value = latest / sma - 1
    else:
        raise ValuationValidationError(f"unknown indicator type {kind!r}")
    result.update({"status": "ok", "value": value})
    return result


def closes_from_bars(bars: Sequence[Mapping[str, Any]] | None) -> list[float]:
    """Admitted closes from a read-model bar series; non-numeric entries fail closed out."""
    closes: list[float] = []
    for bar in bars or []:
        if not isinstance(bar, Mapping):
            continue
        close = bar.get("close")
        if isinstance(close, bool) or not isinstance(close, (int, float)):
            continue
        closes.append(float(close))
    return closes


__all__ = [
    "ASSUMPTION_SOURCE",
    "DATA_STATUS",
    "EVALUATION_SCHEMA",
    "FORMULA_VERSION",
    "INDICATOR_RESULT_SCHEMA",
    "INDICATOR_TYPES",
    "MAX_INDICATOR_PERIOD",
    "MAX_WORKSHEETS",
    "MODEL_TYPES",
    "PRICE_BASIS",
    "STD_CONVENTION",
    "WORKSHEET_SCHEMA",
    "WORKSHEET_STORE_SCHEMA",
    "WORKSHEET_STORE_VERSION",
    "ValuationValidationError",
    "closes_from_bars",
    "compute_fair_value",
    "compute_indicator",
    "evaluate_worksheet",
    "evaluate_worksheets",
    "parse_worksheet_store",
    "serialize_worksheet_store",
    "validate_indicator_request",
    "validate_worksheet",
]
