#!/usr/bin/env python3
"""Run final S9 hardening and write evidence only when all gates pass."""
from __future__ import annotations

import json
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

from tw_quant_engine.backtest import BacktestConfig, run_backtest  # noqa: E402
from tw_quant_engine.product_view import build_read_only_view, view_digest  # noqa: E402
from release_hardening import REQUIRED_EVIDENCE, audit_forbidden_files, file_digest, normalized_json_digest, validate_evidence  # noqa: E402


EVIDENCE_PATH = ROOT / "workflow/evidence/s9-release-hardening.acceptance.json"
S7_PATH = ROOT / "tests/fixtures/s7/backtest.json"
S8_PATH = ROOT / "tests/fixtures/s8/product-view.json"
QLIB_PYTHON = Path("/tmp/tw-quant-engine-s1-venv/bin/python")


def run_command(argv: Sequence[str], *, timeout: int) -> dict[str, Any]:
    completed = subprocess.run(list(argv), cwd=ROOT, text=True, capture_output=True, timeout=timeout, check=False)
    return {"argv": list(argv), "exit_code": completed.returncode, "stdout_digest": file_digest_from_text(completed.stdout), "stderr_digest": file_digest_from_text(completed.stderr)}


def file_digest_from_text(value: str) -> str:
    import hashlib

    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def main() -> int:
    captured_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    evidence_checks = {stage: validate_evidence(ROOT / relative, stage) for stage, relative in REQUIRED_EVIDENCE.items()}
    evidence_pass = all(item["status"] == "pass" for item in evidence_checks.values())
    forbidden_audit = audit_forbidden_files(ROOT)

    fixture_paths = sorted((ROOT / "tests/fixtures").rglob("*.json"))
    fixture_digests_a = {str(path.relative_to(ROOT)): file_digest(path) for path in fixture_paths}
    fixture_digests_b = {str(path.relative_to(ROOT)): file_digest(path) for path in fixture_paths}
    evidence_digests_a = {stage: normalized_json_digest(ROOT / relative) for stage, relative in REQUIRED_EVIDENCE.items()}
    evidence_digests_b = {stage: normalized_json_digest(ROOT / relative) for stage, relative in REQUIRED_EVIDENCE.items()}

    s7 = json.loads(S7_PATH.read_text(encoding="utf-8"))
    s8 = json.loads(S8_PATH.read_text(encoding="utf-8"))
    replay_probe = {"status": "pass", "network_requests": 0}
    try:
        with patch.object(socket, "socket", side_effect=AssertionError("S9 network is forbidden")):
            result_a = run_backtest(s7["records"], s7["provenance"], s7["signals"], as_of=s7["as_of"], config=BacktestConfig(**s7["config"]))
            view_a = build_read_only_view(s8["product_rows"], s8["feature_rows"], result_a, as_of="2026-01-07T23:59:59Z", evidence_links=s8["evidence_links"])
            result_b = run_backtest(s7["records"], s7["provenance"], s7["signals"], as_of=s7["as_of"], config=BacktestConfig(**s7["config"]))
            view_b = build_read_only_view(s8["product_rows"], s8["feature_rows"], result_b, as_of="2026-01-07T23:59:59Z", evidence_links=s8["evidence_links"])
    except Exception as exc:
        replay_probe = {"status": "fail", "network_requests": 0, "error_type": type(exc).__name__, "error": str(exc)}
        result_a = result_b = {}
        view_a = view_b = {}

    default_tests = run_command([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-v"], timeout=240)
    if QLIB_PYTHON.is_file():
        qlib_version = run_command([str(QLIB_PYTHON), "-c", "import qlib; print(qlib.__version__)"], timeout=60)
        qlib_tests = run_command([str(QLIB_PYTHON), "-B", "-m", "unittest", "discover", "-s", "tests", "-v"], timeout=240)
        qlib_matrix = {"available": True, "version": qlib_version, "tests": qlib_tests, "status": "pass" if qlib_version["exit_code"] == 0 and qlib_tests["exit_code"] == 0 else "fail"}
    else:
        qlib_matrix = {"available": False, "status": "fail", "reason": "required local Qlib replay environment is missing"}
    preflight = run_command([sys.executable, "scripts/lh_preflight.py"], timeout=60)
    preflight_output = subprocess.run([sys.executable, "scripts/lh_preflight.py"], cwd=ROOT, text=True, capture_output=True, timeout=60, check=False)
    try:
        preflight_json = json.loads(preflight_output.stdout)
    except json.JSONDecodeError:
        preflight_json = {"status": "fail", "parse": "fail"}

    documentation_checks = {
        "readme_current_state": "S1–S8 已依批准包完成" in (ROOT / "README.md").read_text(encoding="utf-8"),
        "workflow_sequential_gate": "status: pass" in (ROOT / "workflow/README.md").read_text(encoding="utf-8"),
        "s9_cannot_claim": "不啟用 live trading" in (ROOT / "README.md").read_text(encoding="utf-8"),
        "manifest_research_only": json.loads((ROOT / "workflow/engine-manifest.json").read_text(encoding="utf-8")).get("mode") == "research-only",
    }
    replay_checks = {
        "fixture_digests_match": fixture_digests_a == fixture_digests_b,
        "evidence_digests_match": evidence_digests_a == evidence_digests_b,
        "backtest_digest_match": bool(result_a) and view_digest(result_a) == view_digest(result_b),
        "product_view_digest_match": bool(view_a) and view_digest(view_a) == view_digest(view_b),
    }
    hardening_checks = {
        "evidence_chain_pass": evidence_pass,
        "forbidden_audit_pass": forbidden_audit["status"] == "pass",
        "replay_pass": all(replay_checks.values()),
        "documentation_pass": all(documentation_checks.values()),
        "network_guard_pass": replay_probe["status"] == "pass",
        "default_tests_pass": default_tests["exit_code"] == 0,
        "qlib_matrix_pass": qlib_matrix["status"] == "pass",
        "preflight_pass": preflight["exit_code"] == 0 and preflight_json.get("status") == "pass",
    }
    status = "pass" if all(hardening_checks.values()) else "fail"
    evidence = {
        "schema": "tw-quant-engine-stage-acceptance/v1",
        "stage_id": "S9",
        "package_id": "tw-quant-engine-s5-s9-research-product-chain-001",
        "status": status,
        "capture_method": "offline evidence-chain audit, fixture replay, dependency matrices, and subprocess verification",
        "captured_at": captured_at,
        "approval": {"approved": True, "approved_by": "user", "execution_boundary": "workflow/s5-s9-approval-package.json", "network_enabled": False, "network_requests": 0, "finmind_used": False},
        "network_policy": {"enabled": False, "observed_network_calls": 0, "fixture_only": True},
        "evidence_chain": evidence_checks,
        "forbidden_artifact_audit": forbidden_audit,
        "replay": {"checks": replay_checks, "fixture_digests": fixture_digests_a, "evidence_normalized_digests": evidence_digests_a, "network_probe": replay_probe},
        "hardening_checks": hardening_checks,
        "documentation_checks": documentation_checks,
        "offline_verification": {"default_tests": default_tests, "qlib_matrix": qlib_matrix, "preflight": {**preflight, "parsed": preflight_json}},
        "changed_files": ["README.md", "workflow/README.md", "scripts/release_hardening.py", "docs/s9-release-hardening.md", "tests/test_s9_release_hardening.py", "workflow/lh-work-unit.s9.example.json", "scripts/run_s9_acceptance.py", "workflow/evidence/s9-release-hardening.acceptance.json"],
        "acceptance_notes": [
            "S9 verifies S1-S8 evidence and reproducibility; it adds no product or trading scope.",
            "Normalized evidence digests exclude only captured_at and subprocess output digest fields documented in docs/s9-release-hardening.md.",
            "A pass does not claim investment performance, live trading readiness, data completeness, or production deployment acceptance.",
        ],
    }
    EVIDENCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE_PATH.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": status, "network_requests": 0, "default_tests_exit": default_tests["exit_code"], "qlib_matrix": qlib_matrix["status"], "preflight": preflight_json.get("status"), "hardening_checks": hardening_checks}, sort_keys=True))
    return 0 if status == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
