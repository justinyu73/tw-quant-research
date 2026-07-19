#!/usr/bin/env python3
"""Deterministic, dependency-free, read-only preflight for LH."""
from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REQUIRED_FILES = (
    "README.md",
    "pyproject.toml",
    "config/universe.yaml",
    "config/strategy.yaml",
    "config/valuation.yaml",
    "docs/lh-driver-contract.md",
    "workflow/engine-manifest.json",
    "workflow/lh-work-unit.example.json",
)


def run_preflight(root: Path = ROOT) -> dict[str, object]:
    missing = [relative for relative in REQUIRED_FILES if not (root / relative).is_file()]
    manifest_path = root / "workflow/engine-manifest.json"
    manifest: dict[str, object] = {}
    errors: list[str] = []
    if manifest_path.is_file():
        try:
            loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                manifest = loaded
            else:
                errors.append("workflow/engine-manifest.json must contain an object")
        except json.JSONDecodeError as exc:
            errors.append(f"invalid engine manifest JSON: {exc}")
    errors.extend(f"missing required file: {relative}" for relative in missing)
    if manifest.get("driver") != "loop-hybrid":
        errors.append("engine manifest driver must be loop-hybrid")
    if manifest.get("mode") != "research-only":
        errors.append("engine manifest mode must be research-only")
    if manifest.get("writes_repo") is not False:
        errors.append("engine manifest writes_repo must be false")
    return {
        "schema": "tw-quant-engine-preflight/v1",
        "status": "pass" if not errors else "fail",
        "engine_id": manifest.get("engine_id", "unknown"),
        "phase": manifest.get("current_phase", "unknown"),
        "driver": manifest.get("driver", "unknown"),
        "writes_repo": False,
        "errors": errors,
    }


def main() -> int:
    result = run_preflight()
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
