#!/usr/bin/env python3
"""Read-only P5.2 validator for the separately approved action fixture."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = ROOT / "tests/fixtures/s5/corporate-actions.json"
S5_EVIDENCE_PATH = ROOT / "workflow/evidence/s5-quality-corporate-actions.acceptance.json"
P5_WORKFLOW_PATH = ROOT / "workflow/tqe-p5-history-admission.json"
POLICY_PATH = ROOT / "workflow/tqe-p5-adjusted-ohlcv-volume-policy.json"

sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.corporate_actions import (  # noqa: E402
    ADJUSTMENT_POLICY,
    PRICE_MULTIPLIER_CONVENTION,
    adjust_close,
    adjust_ohlcv,
)
from tw_quant_engine.data_contract import PointInTimeDataset, validate_record  # noqa: E402
from tw_quant_engine.quality_checks import check_records  # noqa: E402


P5_AS_OF = "2026-07-19T23:59:59+08:00"
APPROVED_FIXTURE_SCHEMA = "tw-quant-engine-s5-quality-fixture/v1"
APPROVED_RAW_FILE_DIGEST = "sha256:33be0287d129183a908386dd9afd6844ed93fb52829982e96a5cceb942c44e54"
APPROVED_PIT_DIGEST = "sha256:8019df3a210f770780fc63e8fd5de443d2de1d6b7ead6950c108d3c1d1f4eb7b"
APPROVED_S5_EVIDENCE_DIGEST = "sha256:e8b09e76e63bb68c52488d70d518ab13ad5683f2a21b5a3f0a7489cdd4d9f111"


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _file_digest(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def run(root: Path = ROOT) -> dict[str, Any]:
    fixture_path = root / FIXTURE_PATH.relative_to(ROOT)
    evidence_path = root / S5_EVIDENCE_PATH.relative_to(ROOT)
    workflow_path = root / P5_WORKFLOW_PATH.relative_to(ROOT)
    errors: list[str] = []

    try:
        fixture = _read_json(fixture_path)
        evidence = _read_json(evidence_path)
        workflow = _read_json(workflow_path)
        policy = _read_json(root / POLICY_PATH.relative_to(ROOT))
        records = fixture["records"]
        provenance = fixture["provenance"]
        if not isinstance(records, list) or not isinstance(provenance, list):
            raise ValueError("fixture records and provenance must be arrays")
        dataset = PointInTimeDataset(records, provenance)
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        return {
            "schema": "tw-quant-engine-p5-corporate-action-validation/v1",
            "stage_id": "P5.2",
            "status": "fail",
            "network": False,
            "provider_calls": 0,
            "errors": [str(exc)],
        }

    actions = [row for row in records if isinstance(row, Mapping) and row.get("record_type") == "corporate_action"]
    action = actions[0] if len(actions) == 1 else {}
    normalized_action: dict[str, Any] = {}
    try:
        normalized_action = validate_record(action)
    except Exception as exc:  # noqa: BLE001 - report a deterministic validation result
        errors.append(f"action_validation:{exc}")

    action_provenance = next(
        (item for item in provenance if item.get("snapshot_id") == action.get("snapshot_id")),
        {},
    )
    quality = check_records(records, provenance)
    before = dataset.as_of("2025-12-19T23:59:59Z")
    after = dataset.as_of("2025-12-20T11:00:00Z")
    before_action_visible = any(row.get("record_type") == "corporate_action" for row in before)
    after_action_visible = any(row.get("record_type") == "corporate_action" for row in after)

    pre_ex_adjustment = adjust_close(
        100,
        "2026-01-02",
        actions,
        convention=PRICE_MULTIPLIER_CONVENTION,
        as_of=P5_AS_OF,
    )
    on_ex_adjustment = adjust_close(
        50,
        "2026-01-05",
        actions,
        convention=PRICE_MULTIPLIER_CONVENTION,
        as_of=P5_AS_OF,
    )
    full_ohlcv_adjustment = adjust_ohlcv(
        {"open": 100, "high": 101, "low": 99, "close": 100, "volume": 1000},
        "2026-01-02",
        actions,
        convention=PRICE_MULTIPLIER_CONVENTION,
        as_of=P5_AS_OF,
    )

    checks = {
        "fixture_schema_is_approved": fixture.get("schema") == APPROVED_FIXTURE_SCHEMA,
        "fixture_raw_digest_is_approved": _file_digest(fixture_path) == APPROVED_RAW_FILE_DIGEST,
        "fixture_pit_digest_is_approved": dataset.digest() == APPROVED_PIT_DIGEST,
        "s5_evidence_digest_is_approved": _file_digest(evidence_path) == APPROVED_S5_EVIDENCE_DIGEST,
        "quality_report_is_pass": quality.get("status") == "pass" and quality.get("issues") == [],
        "exactly_one_corporate_action": len(actions) == 1,
        "factor_convention_is_explicit": fixture.get("factor_convention") == PRICE_MULTIPLIER_CONVENTION,
        "action_provenance_is_linked": action_provenance.get("snapshot_id") == action.get("snapshot_id")
        and isinstance(action_provenance.get("content_digest"), str)
        and action_provenance.get("content_digest", "").startswith("sha256:"),
        "action_source_and_license_are_explicit": action.get("source_ref") == "synthetic://s5/corporate-action"
        and action_provenance.get("source_id") == "synthetic-twse"
        and action_provenance.get("license_ref") == "https://data.gov.tw/license",
        "action_factor_is_positive_and_explicit": normalized_action.get("factor") == 0.5
        and normalized_action.get("cash_amount") == 0
        and normalized_action.get("currency") == "TWD",
        "action_is_visible_at_p5_as_of": action.get("available_at", "") < P5_AS_OF,
        "point_in_time_visibility_boundary_is_proven": not before_action_visible and after_action_visible,
        "pre_ex_date_adjustment_is_exact": pre_ex_adjustment == {
            "raw_close": 100.0,
            "adjustment_factor": 0.5,
            "adjusted_close": 50.0,
            "convention": PRICE_MULTIPLIER_CONVENTION,
        },
        "ex_date_boundary_keeps_factor_neutral": on_ex_adjustment["adjustment_factor"] == 1.0
        and on_ex_adjustment["adjusted_close"] == 50.0,
        "s5_evidence_is_offline_pass": evidence.get("status") == "pass"
        and evidence.get("network_policy", {}).get("observed_network_calls") == 0,
        "p5_adjustment_selection_is_explicit": workflow.get("human_selection", {})
        .get("adjustment_policy", {})
        .get("selected")
        == "adjusted_ohlcv",
        "full_adjusted_ohlcv_policy_is_defined": policy.get("policy_id") == ADJUSTMENT_POLICY
        and policy.get("status") == "defined_for_p5_4"
        and policy.get("p5_1_unlocked_by_this_policy") is False
        and full_ohlcv_adjustment["adjusted_ohlcv"]["volume"] == 2000.0,
    }
    errors.extend(name for name, passed in checks.items() if not passed)
    return {
        "schema": "tw-quant-engine-p5-corporate-action-validation/v1",
        "stage_id": "P5.2",
        "status": "pass" if not errors else "fail",
        "network": False,
        "provider_calls": 0,
        "fixture": {
            "path": str(fixture_path.relative_to(root)),
            "schema": fixture.get("schema"),
            "raw_file_digest": _file_digest(fixture_path),
            "pit_digest": dataset.digest(),
            "record_count": len(records),
            "corporate_action_count": len(actions),
        },
        "corporate_action": {
            "security_id": action.get("security_id"),
            "action_type": action.get("action_type"),
            "ex_date": action.get("ex_date"),
            "available_at": action.get("available_at"),
            "factor": action.get("factor"),
            "factor_convention": fixture.get("factor_convention"),
            "source_ref": action.get("source_ref"),
            "snapshot_id": action.get("snapshot_id"),
            "source_content_digest": action_provenance.get("content_digest"),
        },
        "adjustment_contract": {
            "raw_ohlcv_unchanged": True,
            "derived_adjusted_values": True,
            "p5_2_validates_fixture_input_only": True,
            "p5_4_must_apply_defined_full_ohlcv_volume_policy": True,
        },
        "checks": checks,
        "errors": errors,
    }


def main() -> int:
    result = run()
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
