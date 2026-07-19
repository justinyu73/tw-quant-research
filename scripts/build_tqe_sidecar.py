#!/usr/bin/env python3
"""Build the offline TQE sidecar with the target-specific Tauri name."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BINARIES = ROOT / "frontend" / "src-tauri" / "binaries"
SPEC = ROOT / "scripts" / "tqe_sidecar.spec"
SIDECAR_BASENAME = "tqe-sidecar"
SUPPORTED_TARGETS = {
    "x86_64-pc-windows-msvc": ".exe",
    "x86_64-apple-darwin": "",
    "aarch64-apple-darwin": "",
    "x86_64-unknown-linux-gnu": "",
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=sorted(SUPPORTED_TARGETS))
    parser.add_argument("--output", type=Path, help="optional explicit output path")
    parser.add_argument("--force-existing", action="store_true", help="allow replacing an existing tracked binary")
    return parser


def _is_tracked(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", str(relative)],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def build_sidecar(target: str, output: Path | None = None, *, force_existing: bool = False) -> dict[str, object]:
    if target not in SUPPORTED_TARGETS:
        raise ValueError(f"unsupported Tauri target: {target}")
    suffix = SUPPORTED_TARGETS[target]
    destination = output or (BINARIES / f"{SIDECAR_BASENAME}-{target}{suffix}")
    destination = destination if destination.is_absolute() else ROOT / destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and _is_tracked(destination) and not force_existing:
        raise RuntimeError(f"refusing to replace tracked file; pass --force-existing: {destination.relative_to(ROOT)}")

    with tempfile.TemporaryDirectory(prefix="tqe-sidecar-build-") as directory:
        build_root = Path(directory)
        command = [
            sys.executable,
            "-m",
            "PyInstaller",
            "--clean",
            "--noconfirm",
            "--distpath",
            str(build_root / "dist"),
            "--workpath",
            str(build_root / "build"),
            str(SPEC),
        ]
        subprocess.run(command, cwd=ROOT, check=True)
        built = build_root / "dist" / f"tqe-sidecar{suffix}"
        if not built.is_file() or built.stat().st_size == 0:
            raise RuntimeError(f"PyInstaller did not produce {built}")
        shutil.copy2(built, destination)

    if os.name != "nt":
        destination.chmod(destination.stat().st_mode | 0o111)
    try:
        output_name = str(destination.relative_to(ROOT))
    except ValueError:
        output_name = str(destination)
    return {
        "status": "pass",
        "target": target,
        "output": output_name,
        "bytes": destination.stat().st_size,
    }


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    print(json.dumps(build_sidecar(args.target, args.output, force_existing=args.force_existing), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
