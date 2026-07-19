#!/usr/bin/env python3
"""Export a source archive using the open-source release exclusion manifest."""
from __future__ import annotations

import argparse
import json
import subprocess
import tarfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "config" / "open-source-release.json"
DEFAULT_OUTPUT = ROOT / "outputs" / "tw-quant-research-source.tar.gz"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser


def _candidate_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return sorted(Path(item) for item in result.stdout.decode("utf-8").split("\0") if item and (ROOT / item).is_file())


def export_archive(output: Path = DEFAULT_OUTPUT) -> dict[str, object]:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    source_release = manifest["source_release"]
    excluded = {
        str(item["path"])
        for key in ("internal_files_excluded", "design_production_records_excluded")
        for item in source_release.get(key, [])
    }
    candidates = [path for path in _candidate_files() if str(path) not in excluded]
    output = output if output.is_absolute() else ROOT / output
    output.parent.mkdir(parents=True, exist_ok=True)
    root_name = output.name.removesuffix(".tar.gz")
    with tarfile.open(output, "w:gz") as archive:
        for relative in candidates:
            archive.add(ROOT / relative, arcname=f"{root_name}/{relative}", recursive=False)
    return {
        "schema": "tw-quant-engine-open-source-source-archive/v1",
        "status": "pass",
        "output": str(output.relative_to(ROOT)) if output.is_relative_to(ROOT) else str(output),
        "file_count": len(candidates),
        "excluded_file_count": len(excluded),
        "excluded_files": sorted(excluded),
        "bytes": output.stat().st_size,
    }


def main() -> int:
    args = _parser().parse_args()
    print(json.dumps(export_archive(args.output), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
