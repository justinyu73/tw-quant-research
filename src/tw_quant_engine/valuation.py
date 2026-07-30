"""P6 valuation & analysis: fail-closed worksheet validation, deterministic Bear/Base/Bull fair values, price/volume indicators.

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


WORKSHEET_SCHEMA = "tqr-scenario-valuation-worksheet/v1"
WORKSHEET_STORE_SCHEMA = "tqr-scenario-valuation-worksheets/v1"
WORKSHEET_STORE_VERSION = 1
EVALUATION_SCHEMA = "tqr-scenario-valuation-evaluation/v1"
INDICATOR_RESULT_SCHEMA = "tqe-price-volume-indicator/v1"
FORMULA_VERSION = "tqr-scenario-valuation/v1"
MAX_WORKSHEETS = 50
MAX_INDICATOR_PERIOD = 250

SCENARIOS = ("bear", "base", "bull")
BUY_ZONE_KEYS = ("watch", "first", "second", "sweet", "extreme")
DEFAULT_BUY_ZONE_RATIOS = {"watch": 0.90, "first": 0.85, "second": 0.80, "sweet": 0.75, "extreme": 0.65}
EPS_KINDS = ("actual", "estimate")
STAGES = ("watch", "near", "first", "second", "sweet", "extreme")
INDICATOR_TYPES = ("zscore", "price_percentile", "ma_deviation")
PRICE_BASIS = "close"
STD_CONVENTION = "population"
ASSUMPTION_SOURCE = "user_supplied_assumption"
DATA_STATUS = "draft"

_WORKSHEET_ID_PATTERN = re.compile(r"^[A-Za-z0-9:_.-]+$")
_WORKSHEET_KEYS = frozenset(
    {"schema", "worksheet_id", "label", "target", "scenarios", "buy_zone_ratios", "basis", "created_at"}
)
_SCENARIO_KEYS = frozenset({"eps", "pe"})
_BASIS_KEYS = frozenset(
    {"eps_period", "eps_kind", "pe_rationale", "financial_data_date", "valuation_date", "change_reason"}
)


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


def _validate_scenarios(scenarios: Any) -> dict[str, Any]:
    """Bear/Base/Bull are all required: one point estimate hides the range."""
    if not isinstance(scenarios, Mapping):
        raise ValuationValidationError("scenarios must be an object")
    if set(scenarios) != set(SCENARIOS):
        raise ValuationValidationError("scenarios must contain exactly bear, base and bull")
    out: dict[str, Any] = {}
    for name in SCENARIOS:
        entry = scenarios[name]
        if not isinstance(entry, Mapping) or set(entry) != _SCENARIO_KEYS:
            raise ValuationValidationError(f"scenarios.{name} must contain exactly eps and pe")
        out[name] = {
            "eps": _positive(entry["eps"], f"scenarios.{name}.eps"),
            "pe": _positive(entry["pe"], f"scenarios.{name}.pe"),
        }
    return out


def _validate_buy_zone_ratios(ratios: Any) -> dict[str, float]:
    if ratios is None:
        return dict(DEFAULT_BUY_ZONE_RATIOS)
    if not isinstance(ratios, Mapping) or set(ratios) != set(BUY_ZONE_KEYS):
        raise ValuationValidationError("buy_zone_ratios must contain exactly " + ", ".join(BUY_ZONE_KEYS))
    out: dict[str, float] = {}
    for key in BUY_ZONE_KEYS:
        value = _number(ratios[key], f"buy_zone_ratios.{key}")
        if not 0 < value <= 1:
            raise ValuationValidationError(f"buy_zone_ratios.{key} must be in (0, 1]")
        out[key] = value
    ordered = [out[key] for key in BUY_ZONE_KEYS]
    if ordered != sorted(ordered, reverse=True):
        raise ValuationValidationError("buy_zone_ratios must decrease from watch to extreme")
    return out


def _validate_basis(basis: Any) -> dict[str, Any]:
    """Every valuation records what it was based on, so a price move can never
    silently become the reason a fair value changed."""
    if not isinstance(basis, Mapping) or set(basis) != _BASIS_KEYS:
        raise ValuationValidationError("basis must contain exactly " + ", ".join(sorted(_BASIS_KEYS)))
    eps_kind = basis["eps_kind"]
    if eps_kind not in EPS_KINDS:
        raise ValuationValidationError("basis.eps_kind must be actual or estimate")
    out: dict[str, Any] = {"eps_kind": eps_kind}
    for field in ("eps_period", "pe_rationale", "financial_data_date", "valuation_date", "change_reason"):
        value = basis[field]
        if not isinstance(value, str) or len(value) > 200:
            raise ValuationValidationError(f"basis.{field} must be a string of at most 200 chars")
        out[field] = value.strip()
    if not out["eps_period"]:
        raise ValuationValidationError("basis.eps_period is required")
    if not out["valuation_date"]:
        raise ValuationValidationError("basis.valuation_date is required")
    return out


def validate_worksheet(definition: Any, admitted_security_ids: Iterable[str]) -> dict[str, Any]:
    """Fail-closed validation of one tqr-scenario-valuation-worksheet/v1 definition."""
    if not isinstance(definition, Mapping):
        raise ValuationValidationError("worksheet must be an object")
    unknown = set(definition) - _WORKSHEET_KEYS
    if unknown:
        raise ValuationValidationError(f"worksheet has unknown fields: {sorted(unknown)}")
    if definition.get("schema") != WORKSHEET_SCHEMA:
        raise ValuationValidationError(f"worksheet schema must be {WORKSHEET_SCHEMA}")
    worksheet_id = definition.get("worksheet_id")
    if not isinstance(worksheet_id, str) or not worksheet_id or len(worksheet_id) > 64 or not _WORKSHEET_ID_PATTERN.match(worksheet_id):
        raise ValuationValidationError("worksheet_id must be 1-64 chars of [A-Za-z0-9:_.-]")
    label = definition.get("label")
    if not isinstance(label, str) or not label.strip() or len(label) > 120:
        raise ValuationValidationError("label must be a non-empty string of at most 120 chars")
    created_at = _timestamp(definition.get("created_at"), "created_at")
    return {
        "schema": WORKSHEET_SCHEMA,
        "worksheet_id": worksheet_id,
        "label": label.strip(),
        "target": _validate_target(definition.get("target"), admitted_security_ids),
        "scenarios": _validate_scenarios(definition.get("scenarios")),
        "buy_zone_ratios": _validate_buy_zone_ratios(definition.get("buy_zone_ratios")),
        "basis": _validate_basis(definition.get("basis")),
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


def compute_scenario_values(scenarios: Mapping[str, Any]) -> dict[str, float]:
    """Fair value per scenario = EPS x PE. No other model is offered."""
    return {name: scenarios[name]["eps"] * scenarios[name]["pe"] for name in SCENARIOS}


def compute_buy_zone(base_value: float, ratios: Mapping[str, float]) -> dict[str, float]:
    """Buy ladder is always a ratio of the Base fair value, never of a price."""
    return {key: base_value * ratios[key] for key in BUY_ZONE_KEYS}


def stage_for_price(price: float, base_value: float, ratios: Mapping[str, float]) -> str:
    zone = compute_buy_zone(base_value, ratios)
    if price <= zone["extreme"]:
        return "extreme"
    if price <= zone["sweet"]:
        return "sweet"
    if price <= zone["second"]:
        return "second"
    if price <= zone["first"]:
        return "first"
    if price <= zone["watch"]:
        return "near"
    return "watch"


def _comparison(current_price: float, base_value: float, zone: Mapping[str, float]) -> dict[str, Any]:
    return {
        "vs_base_value": "above" if current_price > base_value else "below" if current_price < base_value else "at",
        "discount_pct": (current_price - base_value) / base_value,
        "gap_to_first_pct": (current_price - zone["first"]) / zone["first"],
        "gap_to_sweet_pct": (current_price - zone["sweet"]) / zone["sweet"],
        "research_comparison_only": True,
    }


def evaluate_worksheet(worksheet: Mapping[str, Any], bars: Sequence[Mapping[str, Any]] | None) -> dict[str, Any]:
    """Deterministic derived outputs for one validated worksheet.

    ``bars`` is the admitted EOD series (raw close basis). Missing or empty data
    fails closed to an insufficient_data state; nothing is fetched or
    extrapolated. The comparison is a research note, never a recommendation.
    """
    values = compute_scenario_values(worksheet["scenarios"])
    base_value = values["base"]
    ratios = worksheet["buy_zone_ratios"]
    zone = compute_buy_zone(base_value, ratios)
    base = {
        "worksheet_id": worksheet["worksheet_id"],
        "label": worksheet["label"],
        "security_id": worksheet["target"]["security_id"],
        "scenario_values": values,
        "base_value": base_value,
        "buy_zone": zone,
        "buy_zone_ratios": dict(ratios),
        "scenarios": copy.deepcopy(dict(worksheet["scenarios"])),
        "basis": copy.deepcopy(dict(worksheet["basis"])),
        "formula_version": FORMULA_VERSION,
        "assumption_source": ASSUMPTION_SOURCE,
        "data_status": DATA_STATUS,
        "research_only": True,
    }
    admitted = [bar for bar in (bars or []) if isinstance(bar, Mapping) and isinstance(bar.get("close"), (int, float)) and not isinstance(bar.get("close"), bool)]
    if not admitted:
        base.update({"status": "insufficient_data", "current_price": None, "price_as_of": None, "stage": None, "comparison": None})
        return base
    latest = admitted[-1]
    current_price = float(latest["close"])
    base.update(
        {
            "status": "ok",
            "current_price": current_price,
            "price_as_of": latest.get("trading_date"),
            "price_basis": PRICE_BASIS,
            "stage": stage_for_price(current_price, base_value, ratios),
            "comparison": _comparison(current_price, base_value, zone),
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
    "SCENARIOS",
    "BUY_ZONE_KEYS",
    "DEFAULT_BUY_ZONE_RATIOS",
    "PRICE_BASIS",
    "STD_CONVENTION",
    "WORKSHEET_SCHEMA",
    "WORKSHEET_STORE_SCHEMA",
    "WORKSHEET_STORE_VERSION",
    "ValuationValidationError",
    "closes_from_bars",
    "compute_scenario_values",
    "compute_buy_zone",
    "stage_for_price",
    "compute_indicator",
    "evaluate_worksheet",
    "evaluate_worksheets",
    "parse_worksheet_store",
    "serialize_worksheet_store",
    "validate_indicator_request",
    "validate_worksheet",
]
