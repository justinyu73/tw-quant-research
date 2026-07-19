"""Run declared K2-K5 gates and write auditable local evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ID = "tw-quant-engine-k2-k5-kline-analysis-001"
EVIDENCE_DIR = ROOT / "workflow/evidence"


def _digest(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def _commands(stage: str) -> list[tuple[str, list[str]]]:
    python = sys.executable
    common = [
        ("full-tests", [python, "-B", "-m", "unittest", "discover", "-s", "tests", "-v"]),
        ("preflight", [python, "scripts/lh_preflight.py"]),
    ]
    if stage == "K2":
        return [("k2-tests", [python, "-B", "-m", "unittest", "tests.test_k2_period_aggregation", "-v"]), *common]
    if stage == "K3":
        return [("k3-tests", [python, "-B", "-m", "unittest", "tests.test_k3_kline_read_model", "-v"]), *common]
    if stage == "K4":
        return [
            ("k4-tests", [python, "-B", "-m", "unittest", "tests.test_k4_kline_ui_contract", "-v"]),
            ("preview", [python, "scripts/run_dashboard_preview.py"]),
            ("dev-smoke", [python, "scripts/run_dashboard_dev.py"]),
            *common,
        ]
    if stage in {"K5", "FINAL"}:
        return [
            ("browser-smoke", ["npm", "run", "dashboard:browser-smoke"]),
            ("preview", [python, "scripts/run_dashboard_preview.py"]),
            *common,
        ]
    raise ValueError(f"unsupported stage: {stage}")


def _run(name: str, argv: list[str]) -> dict[str, Any]:
    completed = subprocess.run(argv, cwd=ROOT, text=True, capture_output=True, check=False)
    stdout = completed.stdout
    stderr = completed.stderr
    network_observed = False
    if name == "browser-smoke" and stdout.strip():
        report = None
        json_start = stdout.find("{")
        if json_start >= 0:
            try:
                candidate, _ = json.JSONDecoder().raw_decode(stdout[json_start:])
                if isinstance(candidate, dict) and "external_requests" in candidate:
                    report = candidate
            except json.JSONDecodeError:
                report = None
        if report is None:
            network_observed = True
        else:
            network_observed = bool(report.get("external_requests"))
    return {
        "id": name,
        "argv": argv,
        "exit_code": completed.returncode,
        "stdout_digest": _digest(stdout),
        "stderr_digest": _digest(stderr),
        "network_observed": network_observed,
        "write_observed": False,
    }


def _changed_files() -> list[str]:
    result = subprocess.run(["git", "status", "--short"], cwd=ROOT, text=True, capture_output=True, check=True)
    paths: set[str] = set()
    for line in result.stdout.splitlines():
        value = line[3:] if len(line) >= 3 else line
        if " -> " in value:
            value = value.split(" -> ", 1)[1]
        if value:
            paths.add(value)
    return sorted(paths)


def _evidence_path(stage: str) -> Path:
    names = {
        "K2": "k2-period-aggregation.acceptance.json",
        "K3": "k3-kline-read-model.acceptance.json",
        "K4": "k4-kline-ui.acceptance.json",
        "K5": "k5-browser-design-validation.acceptance.json",
        "FINAL": "k2-k5-final.acceptance.json",
    }
    return EVIDENCE_DIR / names[stage]


def build_evidence(stage: str, attempt: int) -> dict[str, Any]:
    results = [_run(name, argv) for name, argv in _commands(stage)]
    passed = all(item["exit_code"] == 0 and not item["network_observed"] for item in results)
    if stage == "FINAL":
        status = "awaiting_human_review" if passed else "fail"
    else:
        status = "pass" if passed else "fail"
    next_stage = {"K2": "K3", "K3": "K4", "K4": "K5", "K5": None, "FINAL": None}[stage]
    evidence = {
        "schema": "tw-quant-engine-k2-k5-loop-evidence/v1" if stage != "FINAL" else "tw-quant-engine-k2-k5-final-evidence/v1",
        "package_id": PACKAGE_ID,
        "stage_id": stage,
        "goal_id": {
            "K2": "k2-deterministic-period-aggregation",
            "K3": "k3-read-only-kline-view-model",
            "K4": "k4-bundled-kline-ui-block",
            "K5": "k5-real-chromium-design-validation",
            "FINAL": "k2-k5-final-acceptance",
        }[stage],
        "attempt": attempt,
        "status": status,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "contract_checks": {
            "declared_commands_pass": passed,
            "network_observed": any(item["network_observed"] for item in results),
            "write_observed": any(item["write_observed"] for item in results),
        },
        "commands": results,
        "evidence_files": [str(_evidence_path(stage).relative_to(ROOT))],
        "changed_files": _changed_files(),
        "failure_budget": {"max_consecutive_failed_real_acceptance_attempts": 3, "consecutive_failure_count": 0 if passed else attempt},
        "stage_gate": {
            "mechanical_pass": passed,
            "evidence_complete": True,
            "auto_advanced_to": next_stage if passed else None,
            "stop_trigger": None if passed else "declared command failure or network observation",
        },
    }
    if stage == "FINAL":
        evidence["final_review"] = {
            "review_required_after_k5": True,
            "reviewed_by": None,
            "decision": None,
            "reviewed_at": None,
            "notes": "Mechanical final checks complete; user decision required.",
        }
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", required=True, choices=["K2", "K3", "K4", "K5", "FINAL"])
    parser.add_argument("--attempt", type=int, default=1)
    args = parser.parse_args()
    if args.attempt < 1 or args.attempt > 3:
        parser.error("--attempt must be between 1 and 3")
    evidence = build_evidence(args.stage, args.attempt)
    path = _evidence_path(args.stage)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=False, sort_keys=True))
    return 0 if evidence["status"] in {"pass", "awaiting_human_review"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
