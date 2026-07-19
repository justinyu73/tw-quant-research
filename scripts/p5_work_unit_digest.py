#!/usr/bin/env python3
"""Compute the non-runnable P5 work-unit template digest read-only."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DRAFT_PATH = ROOT / "workflow/tqe-p5-twse-work-unit.draft.json"
SOURCE_PATH = ROOT / "workflow/tqe-p5-twse-source-contract.json"
CORPORATE_ACTION_PATH = ROOT / "workflow/tqe-p5-corporate-action-admission.json"
POLICY_PATH = ROOT / "workflow/tqe-p5-adjusted-ohlcv-volume-policy.json"


def _load(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain an object")
    return payload


def _digest(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


def run(root: Path = ROOT) -> dict[str, Any]:
    draft = _load(root / DRAFT_PATH.relative_to(ROOT))
    source = _load(root / SOURCE_PATH.relative_to(ROOT))
    corporate_action = _load(root / CORPORATE_ACTION_PATH.relative_to(ROOT))
    policy = _load(root / POLICY_PATH.relative_to(ROOT))
    digest = _digest(draft)
    checks = {
        "draft_is_non_runnable": draft.get("status") == "draft_not_runnable",
        "source_contract_is_blocked": source.get("status") == "source_contract_blocked"
        and source.get("selected_source") is None,
        "corporate_action_is_admitted": corporate_action.get("stage_id") == "P5.2"
        and corporate_action.get("status") == "pass",
        "adjusted_ohlcv_policy_is_defined": policy.get("policy_id") == "tqe-adjusted-ohlcv-volume/v1"
        and policy.get("status") == "defined_for_p5_4",
        "network_and_provider_calls_are_disabled": draft.get("network") is False
        and draft.get("provider_calls") is False,
        "digest_is_stable": digest.startswith("sha256:") and len(digest) == 71,
        "activation_is_not_claimed": draft.get("host_egress") == "required_before_activation",
    }
    errors = [name for name, passed in checks.items() if not passed]
    return {
        "schema": "tw-quant-engine-p5-work-unit-digest/v1",
        "stage_id": "P5.3",
        "status": "fail" if errors else "blocked_source_contract",
        "work_unit_id": draft.get("work_unit_id"),
        "draft_path": str((root / DRAFT_PATH.relative_to(ROOT)).relative_to(root)),
        "template_digest": digest,
        "digest_status": "template_only_waiting_p5_1",
        "activation_ready": False,
        "network": False,
        "provider_calls": 0,
        "checks": checks,
        "errors": errors,
    }


def main() -> int:
    result = run()
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["status"] != "fail" else 1


if __name__ == "__main__":
    sys.exit(main())
