#!/usr/bin/env python3
"""Read-only preflight for the human-selected P5 execution target."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_PATH = ROOT / "workflow/tqe-p5-history-admission.json"
SOURCE_CONTRACT_PATH = ROOT / "workflow/tqe-p5-twse-source-contract.json"
CORPORATE_ACTION_PATH = ROOT / "workflow/tqe-p5-corporate-action-admission.json"
WORK_UNIT_DIGEST_PATH = ROOT / "workflow/evidence/p5.3-work-unit-digest.acceptance.json"
MANIFEST_PATH = ROOT / "workflow/engine-manifest.json"
DRIVER_CONTRACT_PATH = ROOT / "docs/lh-driver-contract.md"
AMENDMENT_PATH = ROOT / "docs/tqe-p5-phase-driver-contract-amendment.md"


def _load(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def run(root: Path = ROOT) -> dict[str, Any]:
    workflow_path = root / WORKFLOW_PATH.relative_to(ROOT)
    manifest_path = root / MANIFEST_PATH.relative_to(ROOT)
    driver_path = root / DRIVER_CONTRACT_PATH.relative_to(ROOT)
    amendment_path = root / AMENDMENT_PATH.relative_to(ROOT)
    errors: list[str] = []

    try:
        workflow = _load(workflow_path)
        source_contract = _load(root / SOURCE_CONTRACT_PATH.relative_to(ROOT))
        corporate_action = _load(root / CORPORATE_ACTION_PATH.relative_to(ROOT))
        work_unit_digest = _load(root / WORK_UNIT_DIGEST_PATH.relative_to(ROOT))
        manifest = _load(manifest_path)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return {
            "schema": "tw-quant-engine-p5-execution-target/v1",
            "status": "fail",
            "execution_ready": False,
            "provider_calls": 0,
            "errors": [str(exc)],
        }

    driver_text = driver_path.read_text(encoding="utf-8") if driver_path.is_file() else ""
    amendment_text = amendment_path.read_text(encoding="utf-8") if amendment_path.is_file() else ""
    human_selection = workflow.get("human_selection")
    scope = workflow.get("scope")
    in_scope = scope.get("in_scope", []) if isinstance(scope, dict) else []
    out_of_scope = scope.get("out_of_scope", []) if isinstance(scope, dict) else []
    source_scope = human_selection.get("source_market_scope", {}) if isinstance(human_selection, dict) else {}
    selected_markets = source_scope.get("in_scope", []) if isinstance(source_scope, dict) else []
    deferred_scope = source_scope.get("deferred_scope", []) if isinstance(source_scope, dict) else []
    execution = human_selection.get("execution", {}) if isinstance(human_selection, dict) else {}

    checks = {
        "manifest_points_to_p5": manifest.get("next_phase_target") == "p5_history_admission",
        "manifest_target_is_work_unit_preparation": manifest.get("next_phase_target_status") in {
            "active_work_unit_preparation",
            "blocked_source_contract",
        },
        "workflow_is_next_phase_target": workflow.get("phase_role") == "next_phase_execution_target",
        "workflow_preparation_is_blocked_or_active": workflow.get("preparation_status") in {
            "active_work_unit_preparation",
            "blocked_pending_source_contract_resolution",
        },
        "twse_tpex_are_in_scope": set(("TWSE", "TPEx")).issubset(set(selected_markets) or set()),
        "us_and_new_provider_are_deferred": {"US_equity", "new_provider"}.issubset(set(deferred_scope))
        and {"US_equity", "new_provider"}.issubset(set(out_of_scope) or set()),
        "bounded_human_run_is_selected": execution.get("mode") == "human_run_exact_work_unit",
        "host_egress_is_selected": execution.get("host_egress") is True,
        "provider_calls_disabled_in_preparation": workflow.get("provider_calls") is False,
        "network_disabled_in_preparation": workflow.get("network") is False,
        "write_routes_disabled": workflow.get("write_routes") is False,
        "current_driver_is_l1_report_only": "L1/report-only" in driver_text,
        "amendment_is_not_active": "provider_capability_not_active" in amendment_text,
        "exact_work_unit_is_required": "exact_human_run_work_unit_digest" in workflow.get("required_decisions", []),
        "adjustment_provenance_is_required": "adjustment_provenance_missing_or_ambiguous" in workflow.get("hard_stops", []),
        "twse_source_contract_is_fail_closed": source_contract.get("status")
        in {"source_contract_blocked", "source_contract_selected_pending_activation"}
        and source_contract.get("provider_calls_made_by_repository") == 0
        and (
            source_contract.get("selected_source") is None
            or (
                isinstance(source_contract.get("selected_source"), dict)
                and source_contract["selected_source"].get("activation")
                in {"pending_work_unit_digest_approval", "approved_pending_first_capture"}
            )
        ),
        "corporate_action_admission_is_pass": corporate_action.get("stage_id") == "P5.2"
        and corporate_action.get("status") == "pass"
        and corporate_action.get("provider_calls") == 0,
        "work_unit_digest_is_valid": work_unit_digest.get("stage_id") == "P5.3"
        and work_unit_digest.get("status")
        in {"blocked_source_contract", "approved_pending_execution"},
    }
    errors.extend(name for name, passed in checks.items() if not passed)
    workflow_status = workflow.get("status")
    if workflow_status == "approved_pending_first_capture":
        pending_gates: list[str] = []
    elif workflow_status == "pending_work_unit_digest_approval":
        pending_gates = ["p5_3_exact_human_run_work_unit_digest"]
    else:
        pending_gates = [
            "p5_1_official_twse_three_year_bulk_and_calendar_contract",
            "p5_3_exact_human_run_work_unit_digest",
        ]
    status = "fail" if errors else (
        "blocked_source_contract"
        if workflow_status == "source_contract_blocked"
        else ("approved_pending_first_capture" if workflow_status == "approved_pending_first_capture" else "pending_human_gate")
    )
    return {
        "schema": "tw-quant-engine-p5-execution-target/v1",
        "status": status,
        "phase_role": workflow.get("phase_role"),
        "preparation_step": workflow.get("current_preparation_step"),
        "execution_ready": False,
        "provider_calls": 0,
        "pending_gates": pending_gates,
        "checks": checks,
        "errors": errors,
    }


def main() -> int:
    result = run()
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["status"] != "fail" else 1


if __name__ == "__main__":
    sys.exit(main())
