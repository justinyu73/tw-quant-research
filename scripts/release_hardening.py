"""S9 read-only checks for evidence, replay, and repository safety."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping


REQUIRED_EVIDENCE = {
    "S1": "workflow/evidence/s1-qlib-spike.acceptance.json",
    "S2": "workflow/evidence/s2-data-contract.acceptance.json",
    "S3": "workflow/evidence/s3-public-data.acceptance.json",
    "S4": "workflow/evidence/s4-ingestion-product-alignment.acceptance.json",
    "S5": "workflow/evidence/s5-quality-corporate-actions.acceptance.json",
    "S6": "workflow/evidence/s6-feature-pipeline.acceptance.json",
    "S7": "workflow/evidence/s7-backtest.acceptance.json",
    "S8": "workflow/evidence/s8-read-only-product-view.acceptance.json",
}
VOLATILE_KEYS = frozenset({"captured_at", "stdout_digest", "stderr_digest", "stderr_digest_normalized"})
FORBIDDEN_NAMES = frozenset({".env", "credentials.json", "cookies.txt", "secrets.json", "broker-token.json"})
FORBIDDEN_SUFFIXES = frozenset({".pem", ".key", ".p12", ".pfx"})


def _without_volatile(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _without_volatile(item) for key, item in value.items() if key not in VOLATILE_KEYS}
    if isinstance(value, list):
        return [_without_volatile(item) for item in value]
    return value


def canonical_digest(value: Any) -> str:
    encoded = json.dumps(_without_volatile(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


def file_digest(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def normalized_json_digest(path: Path) -> str:
    return canonical_digest(json.loads(path.read_text(encoding="utf-8")))


def _network_values(value: Any, key: str = "") -> list[tuple[str, Any]]:
    found: list[tuple[str, Any]] = []
    if isinstance(value, Mapping):
        for child_key, child in value.items():
            if child_key in {"network_used", "network_enabled", "network_requests", "observed_network_calls"}:
                found.append((child_key, child))
            found.extend(_network_values(child, child_key))
    elif isinstance(value, list):
        for child in value:
            found.extend(_network_values(child, key))
    return found


def validate_evidence(path: Path, expected_stage: str) -> dict[str, Any]:
    errors: list[str] = []
    try:
        evidence = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"path": str(path), "stage_id": expected_stage, "status": "fail", "errors": [f"parse:{type(exc).__name__}"]}
    if not isinstance(evidence, dict):
        return {"path": str(path), "stage_id": expected_stage, "status": "fail", "errors": ["root_not_object"]}
    if evidence.get("schema") != "tw-quant-engine-stage-acceptance/v1":
        errors.append("schema_mismatch")
    if evidence.get("stage_id") != expected_stage:
        errors.append("stage_mismatch")
    if evidence.get("status") != "pass":
        errors.append("status_not_pass")
    for key, value in _network_values(evidence):
        if key in {"network_used", "network_enabled"} and value is not False:
            errors.append(f"{key}_not_false")
        if key in {"network_requests", "observed_network_calls"} and value != 0:
            errors.append(f"{key}_not_zero")
    offline = evidence.get("offline_verification")
    if isinstance(offline, Mapping):
        tests = offline.get("tests")
        if isinstance(tests, Mapping) and tests.get("exit_code") != 0:
            errors.append("tests_not_green")
        preflight = offline.get("preflight")
        if isinstance(preflight, Mapping) and isinstance(preflight.get("parsed"), Mapping) and preflight["parsed"].get("status") != "pass":
            errors.append("preflight_not_green")
    return {"path": str(path), "stage_id": expected_stage, "status": "pass" if not errors else "fail", "errors": errors, "normalized_digest": normalized_json_digest(path)}


def audit_forbidden_files(root: Path) -> dict[str, Any]:
    forbidden: list[str] = []
    for path in root.rglob("*"):
        if not path.is_file() or ".git" in path.parts or "__pycache__" in path.parts or "node_modules" in path.parts or "target" in path.parts:
            continue
        if path.name in FORBIDDEN_NAMES or path.suffix.lower() in FORBIDDEN_SUFFIXES:
            forbidden.append(str(path.relative_to(root)))
        if path.stat().st_size > 2 * 1024 * 1024:
            forbidden.append(f"{path.relative_to(root)}:large_artifact")
    source_registry = root / "src/tw_quant_engine/source_registry.py"
    if source_registry.is_file() and "finmind" in source_registry.read_text(encoding="utf-8").lower():
        forbidden.append("source_registry:finmind_active_reference")
    s3_fixture = root / "tests/fixtures/s3/source-admission.json"
    if s3_fixture.is_file():
        payload = json.loads(s3_fixture.read_text(encoding="utf-8"))
        if payload.get("finmind_used") is not False:
            forbidden.append("s3_fixture:finmind_used")
    return {"status": "pass" if not forbidden else "fail", "forbidden": sorted(forbidden)}


__all__ = ["REQUIRED_EVIDENCE", "audit_forbidden_files", "canonical_digest", "file_digest", "normalized_json_digest", "validate_evidence"]
