"""P6 in-app alerts: fail-closed definition validation, deterministic evaluation, session-local store.

Scope is strictly in-app alerts per docs/tqe-p6-in-app-alerts-contract.md:
- evaluation runs only here in the local engine, over admitted fixture/read-model data;
- evaluation produces in-app events only; there is no delivery step and no external channel;
- alert definitions persist as a flat versioned JSON store (tqe-in-app-alerts/v1),
  watchlist style, owned by the local app; definitions never leave the local machine.
"""
from __future__ import annotations

import copy
import re
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping


ALERT_SCHEMA = "tqe-in-app-alert/v1"
ALERT_STORE_SCHEMA = "tqe-in-app-alerts/v1"
ALERT_EVENT_SCHEMA = "tqe-in-app-alert-event/v1"
ALERT_EVALUATION_SCHEMA = "tqe-in-app-alert-evaluation/v1"
ALERT_STORE_VERSION = 1
IN_APP_CHANNEL = "in_app"
CHANNELS = (IN_APP_CHANNEL,)
MAX_ALERTS = 50

# Indicators already computed by the local engine (kline_view read models).
KNOWN_INDICATORS = frozenset({"ma", "ema", "rsi", "macd", "kd", "atr"})
PARAMETERIZED_INDICATORS = frozenset({"ma", "ema"})
OPERATORS = frozenset({">=", "<="})

_ALERT_ID_PATTERN = re.compile(r"^[A-Za-z0-9:_.-]+$")
_ALERT_KEYS = frozenset({"schema", "alert_id", "label", "enabled", "target", "condition", "dedup", "expiry", "created_at"})


class AlertValidationError(ValueError):
    """Raised when an alert definition or store fails fail-closed validation."""


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str):
        raise AlertValidationError(f"{field} must be an ISO 8601 timestamp")
    candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError as exc:
        raise AlertValidationError(f"{field} must be an ISO 8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise AlertValidationError(f"{field} must include an explicit timezone")
    return parsed.astimezone(timezone.utc)


def _isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AlertValidationError(f"{field} must be a number")
    if value != value or value in (float("inf"), float("-inf")):
        raise AlertValidationError(f"{field} must be finite")
    return float(value)


def _validate_target(target: Any, admitted_security_ids: Iterable[str]) -> dict[str, Any]:
    if not isinstance(target, Mapping) or set(target) != {"security_id"}:
        raise AlertValidationError("target must be exactly {security_id}")
    security_id = target["security_id"]
    if not isinstance(security_id, str) or not security_id:
        raise AlertValidationError("target.security_id must be a non-empty string")
    if security_id not in set(admitted_security_ids):
        raise AlertValidationError(f"target security {security_id!r} is outside the admitted universe")
    return {"security_id": security_id}


def _validate_condition(condition: Any) -> dict[str, Any]:
    if not isinstance(condition, Mapping):
        raise AlertValidationError("condition must be an object")
    kind = condition.get("type")
    if kind == "price_threshold":
        if set(condition) != {"type", "field", "op", "value"}:
            raise AlertValidationError("price_threshold condition has unknown or missing fields")
        if condition["field"] != "close":
            raise AlertValidationError("price_threshold field must be close")
        if condition["op"] not in OPERATORS:
            raise AlertValidationError("condition op must be >= or <=")
        return {
            "type": "price_threshold",
            "field": "close",
            "op": condition["op"],
            "value": _number(condition["value"], "condition.value"),
        }
    if kind == "indicator_threshold":
        if set(condition) != {"type", "indicator", "params", "op", "value"}:
            raise AlertValidationError("indicator_threshold condition has unknown or missing fields")
        indicator = condition["indicator"]
        if indicator not in KNOWN_INDICATORS:
            raise AlertValidationError(f"unknown indicator {indicator!r}")
        params = condition["params"]
        if not isinstance(params, Mapping):
            raise AlertValidationError("condition.params must be an object")
        if indicator in PARAMETERIZED_INDICATORS:
            if set(params) - {"period"}:
                raise AlertValidationError(f"{indicator} params may only contain period")
            if "period" in params:
                period = params["period"]
                if isinstance(period, bool) or not isinstance(period, int) or period < 1:
                    raise AlertValidationError("condition.params.period must be a positive integer")
        elif params:
            raise AlertValidationError(f"{indicator} uses the engine-fixed window; params must be empty")
        if condition["op"] not in OPERATORS:
            raise AlertValidationError("condition op must be >= or <=")
        return {
            "type": "indicator_threshold",
            "indicator": indicator,
            "params": dict(params),
            "op": condition["op"],
            "value": _number(condition["value"], "condition.value"),
        }
    raise AlertValidationError(f"unknown condition type {kind!r}")


def _validate_dedup(dedup: Any) -> dict[str, Any]:
    if not isinstance(dedup, Mapping):
        raise AlertValidationError("dedup must be an object")
    policy = dedup.get("policy")
    if policy == "once_per_session":
        if set(dedup) != {"policy"}:
            raise AlertValidationError("once_per_session dedup takes no extra fields")
        return {"policy": "once_per_session"}
    if policy == "cooldown_seconds":
        if set(dedup) != {"policy", "cooldown_seconds"}:
            raise AlertValidationError("cooldown_seconds dedup requires cooldown_seconds")
        seconds = dedup["cooldown_seconds"]
        if isinstance(seconds, bool) or not isinstance(seconds, int) or seconds < 1:
            raise AlertValidationError("dedup.cooldown_seconds must be a positive integer")
        return {"policy": "cooldown_seconds", "cooldown_seconds": seconds}
    raise AlertValidationError(f"unknown dedup policy {policy!r}")


def _validate_expiry(expiry: Any) -> dict[str, Any]:
    if not isinstance(expiry, Mapping):
        raise AlertValidationError("expiry must be an object")
    policy = expiry.get("policy")
    if policy == "session":
        if set(expiry) != {"policy"}:
            raise AlertValidationError("session expiry takes no extra fields")
        return {"policy": "session"}
    if policy == "until":
        if set(expiry) != {"policy", "until"}:
            raise AlertValidationError("until expiry requires until")
        until = _timestamp(expiry["until"], "expiry.until")
        return {"policy": "until", "until": _isoformat(until)}
    raise AlertValidationError(f"unknown expiry policy {policy!r}")


def validate_alert(definition: Any, admitted_security_ids: Iterable[str]) -> dict[str, Any]:
    """Fail-closed validation of one tqe-in-app-alert/v1 definition."""
    if not isinstance(definition, Mapping):
        raise AlertValidationError("alert definition must be an object")
    unknown = set(definition) - _ALERT_KEYS
    if unknown:
        raise AlertValidationError(f"alert definition has unknown fields: {sorted(unknown)}")
    if definition.get("schema") != ALERT_SCHEMA:
        raise AlertValidationError("alert schema must be tqe-in-app-alert/v1")
    alert_id = definition.get("alert_id")
    if not isinstance(alert_id, str) or not alert_id or len(alert_id) > 64 or not _ALERT_ID_PATTERN.match(alert_id):
        raise AlertValidationError("alert_id must be 1-64 chars of [A-Za-z0-9:_.-]")
    label = definition.get("label")
    if not isinstance(label, str) or not label.strip() or len(label) > 120:
        raise AlertValidationError("label must be a non-empty string of at most 120 chars")
    enabled = definition.get("enabled")
    if not isinstance(enabled, bool):
        raise AlertValidationError("enabled must be a boolean")
    created_at = _timestamp(definition.get("created_at"), "created_at")
    return {
        "schema": ALERT_SCHEMA,
        "alert_id": alert_id,
        "label": label.strip(),
        "enabled": enabled,
        "target": _validate_target(definition.get("target"), admitted_security_ids),
        "condition": _validate_condition(definition.get("condition")),
        "dedup": _validate_dedup(definition.get("dedup")),
        "expiry": _validate_expiry(definition.get("expiry")),
        "created_at": _isoformat(created_at),
    }


def serialize_alert_store(definitions: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Flat versioned JSON store (watchlist style). Session-expiry alerts are dropped."""
    alerts = [
        copy.deepcopy(dict(definition))
        for definition in definitions
        if isinstance(definition, Mapping) and (definition.get("expiry") or {}).get("policy") != "session"
    ]
    return {"schema": ALERT_STORE_SCHEMA, "version": ALERT_STORE_VERSION, "alerts": alerts}


def parse_alert_store(payload: Any, admitted_security_ids: Iterable[str]) -> list[dict[str, Any]]:
    """Fail-closed parse of a tqe-in-app-alerts/v1 store payload."""
    if not isinstance(payload, Mapping):
        raise AlertValidationError("alert store must be an object")
    if payload.get("schema") != ALERT_STORE_SCHEMA:
        raise AlertValidationError("alert store schema must be tqe-in-app-alerts/v1")
    if payload.get("version") != ALERT_STORE_VERSION:
        raise AlertValidationError("alert store version must be 1")
    raw_alerts = payload.get("alerts")
    if not isinstance(raw_alerts, list):
        raise AlertValidationError("alert store alerts must be a list")
    if len(raw_alerts) > MAX_ALERTS:
        raise AlertValidationError(f"alert store cannot contain more than {MAX_ALERTS} alerts")
    alerts = [validate_alert(definition, admitted_security_ids) for definition in raw_alerts]
    alert_ids = [alert["alert_id"] for alert in alerts]
    if len(set(alert_ids)) != len(alert_ids):
        raise AlertValidationError("alert store alert_id values must be unique")
    return alerts


def _session_entry(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, Mapping):
        return None
    fired_count = raw.get("fired_count")
    if isinstance(fired_count, bool) or not isinstance(fired_count, int) or fired_count < 0:
        return None
    last_fired_at = raw.get("last_fired_at")
    if last_fired_at is not None:
        try:
            last_fired_at = _isoformat(_timestamp(last_fired_at, "session_state.last_fired_at"))
        except AlertValidationError:
            return None
    return {"fired_count": fired_count, "last_fired_at": last_fired_at}


def _met(observed: float, op: str, threshold: float) -> bool:
    return observed >= threshold if op == ">=" else observed <= threshold


def _observed_value(alert: Mapping[str, Any], model: Mapping[str, Any]) -> float | None:
    """Latest admitted observation from the read model; None means data unavailable."""
    condition = alert["condition"]
    if condition["type"] == "price_threshold":
        bars = model.get("bars") or []
        if not bars:
            return None
        close = bars[-1].get("close")
        if isinstance(close, bool) or not isinstance(close, (int, float)):
            return None
        return float(close)
    indicator = model.get("indicators", {}).get(condition["indicator"])
    if not isinstance(indicator, Mapping):
        return None
    requested_period = condition["params"].get("period")
    if requested_period is not None and indicator.get("period") != requested_period:
        return None
    values = indicator.get("values") or []
    if not values:
        return None
    latest = values[-1]
    if latest.get("status") != "admitted" or latest.get("value") is None:
        return None
    return float(latest["value"])


def evaluate_alerts(
    definitions: Iterable[Mapping[str, Any]],
    market_data: Mapping[str, Mapping[str, Any] | None],
    *,
    now: str | datetime,
    session_state: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Deterministically evaluate validated alerts against admitted read-model data.

    ``now`` is explicit so fixture replay has no wall-clock dependence. Delivery is
    stubbed by construction: the result only carries in-app events (channel in_app).
    """
    moment = now if isinstance(now, datetime) else _timestamp(now, "now")
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise AlertValidationError("now must include an explicit timezone")
    moment = moment.astimezone(timezone.utc)
    state: dict[str, dict[str, Any]] = {}
    for alert_id, raw_entry in (session_state or {}).items():
        entry = _session_entry(raw_entry)
        if entry is not None:
            state[str(alert_id)] = entry

    fired: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for definition in definitions:
        alert = copy.deepcopy(dict(definition))
        alert_id = alert["alert_id"]
        security_id = alert["target"]["security_id"]

        def skip(reason: str) -> None:
            skipped.append({"alert_id": alert_id, "security_id": security_id, "reason": reason})

        if not alert["enabled"]:
            skip("disabled")
            continue
        expiry = alert["expiry"]
        if expiry["policy"] == "until" and moment >= _timestamp(expiry["until"], "expiry.until"):
            skip("expired")
            continue
        entry = state.get(alert_id)
        dedup = alert["dedup"]
        if dedup["policy"] == "once_per_session" and entry and entry["fired_count"] >= 1:
            skip("dedup_once_per_session")
            continue
        if dedup["policy"] == "cooldown_seconds" and entry and entry["last_fired_at"] is not None:
            elapsed = (moment - _timestamp(entry["last_fired_at"], "session_state.last_fired_at")).total_seconds()
            if elapsed < dedup["cooldown_seconds"]:
                skip("dedup_cooldown")
                continue
        model = market_data.get(security_id)
        if model is None:
            skip("data_unavailable")
            continue
        observed = _observed_value(alert, model)
        if observed is None:
            skip("data_unavailable")
            continue
        condition = alert["condition"]
        if not _met(observed, condition["op"], condition["value"]):
            skip("condition_not_met")
            continue
        fired_at = _isoformat(moment)
        fired.append(
            {
                "schema": ALERT_EVENT_SCHEMA,
                "alert_id": alert_id,
                "label": alert["label"],
                "security_id": security_id,
                "condition_type": condition["type"],
                "observed_value": observed,
                "op": condition["op"],
                "threshold": condition["value"],
                "fired_at": fired_at,
                "channel": IN_APP_CHANNEL,
                "research_only": True,
            }
        )
        state[alert_id] = {
            "fired_count": (entry["fired_count"] if entry else 0) + 1,
            "last_fired_at": fired_at,
        }
    return {
        "schema": ALERT_EVALUATION_SCHEMA,
        "evaluated_at": _isoformat(moment),
        "channels": list(CHANNELS),
        "fired": fired,
        "skipped": skipped,
        "session_state": state,
    }


__all__ = [
    "ALERT_SCHEMA",
    "ALERT_STORE_SCHEMA",
    "ALERT_EVENT_SCHEMA",
    "ALERT_EVALUATION_SCHEMA",
    "ALERT_STORE_VERSION",
    "CHANNELS",
    "IN_APP_CHANNEL",
    "KNOWN_INDICATORS",
    "MAX_ALERTS",
    "AlertValidationError",
    "evaluate_alerts",
    "parse_alert_store",
    "serialize_alert_store",
    "validate_alert",
]
