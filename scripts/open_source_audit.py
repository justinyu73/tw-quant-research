#!/usr/bin/env python3
"""Audit the current source tree before publishing an open-source release."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "config" / "open-source-release.json"
FORBIDDEN_NAMES = {".env", "credentials.json", "cookies.txt", "secrets.json", "broker-token.json"}
FORBIDDEN_SUFFIXES = {".pem", ".key", ".p12", ".pfx"}
LARGE_FILE_BYTES = 2 * 1024 * 1024
SECRET_PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |)?PRIVATE KEY-----"),
    re.compile(r"\b(?:ghp|github_pat|sk|xox[baprs])_[A-Za-z0-9_\-]{20,}\b"),
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="fail when a publication blocker exists")
    return parser


def _candidate_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    paths = [Path(item) for item in result.stdout.decode("utf-8").split("\0") if item]
    return sorted(path for path in paths if (ROOT / path).is_file())


def _manifest() -> dict[str, Any]:
    payload = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if payload.get("schema") != "tw-quant-engine-open-source-release/v1":
        raise ValueError("open-source release manifest schema mismatch")
    return payload


def _excluded_paths(manifest: dict[str, Any]) -> dict[str, str]:
    entries: dict[str, str] = {}
    source_release = manifest.get("source_release", {})
    for item in source_release.get("internal_files_excluded", []):
        entries[str(item["path"])] = str(item["reason"])
    for item in source_release.get("design_production_records_excluded", []):
        entries[str(item["path"])] = str(item["reason"])
    return entries


def _scan_public_files(paths: list[Path]) -> tuple[list[str], list[str]]:
    forbidden: list[str] = []
    secret_hits: list[str] = []
    for relative in paths:
        if relative.name in FORBIDDEN_NAMES or relative.suffix.lower() in FORBIDDEN_SUFFIXES:
            forbidden.append(str(relative))
        absolute = ROOT / relative
        size = absolute.stat().st_size
        if size > LARGE_FILE_BYTES:
            forbidden.append(f"{relative}:large_artifact:{size}")
        try:
            text = absolute.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for pattern in SECRET_PATTERNS:
            if pattern.search(text):
                secret_hits.append(str(relative))
                break
    return sorted(set(forbidden)), sorted(set(secret_hits))


def audit(strict: bool = False) -> dict[str, Any]:
    manifest = _manifest()
    candidates = _candidate_files()
    excluded = _excluded_paths(manifest)
    missing_exclusions = sorted(path for path in excluded if not (ROOT / path).is_file())
    public = [path for path in candidates if str(path) not in excluded]
    forbidden, secret_hits = _scan_public_files(public)
    license_present = any((ROOT / name).is_file() for name in ("LICENSE", "LICENSE.md", "COPYING"))
    blockers: list[str] = []
    if missing_exclusions:
        blockers.append("manifest_exclusion_missing")
    if forbidden:
        blockers.append("forbidden_or_large_public_file")
    if secret_hits:
        blockers.append("secret_pattern_in_public_file")
    if not license_present:
        blockers.append("license_missing")
    status = "pass" if not blockers else "review_required"
    return {
        "schema": "tw-quant-engine-open-source-audit/v1",
        "status": status,
        "strict": strict,
        "manifest": str(MANIFEST.relative_to(ROOT)),
        "candidate_file_count": len(candidates),
        "public_file_count": len(public),
        "excluded_file_count": len(excluded),
        "excluded_files": [{"path": path, "reason": excluded[path]} for path in sorted(excluded)],
        "missing_exclusions": missing_exclusions,
        "license_present": license_present,
        "forbidden_or_large_public_files": forbidden,
        "secret_pattern_public_files": secret_hits,
        "blockers": blockers,
        "runtime_boundary": manifest["runtime_boundary"],
    }


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    report = audit(strict=args.strict)
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if args.strict and report["status"] != "pass" else 0


if __name__ == "__main__":
    raise SystemExit(main())
