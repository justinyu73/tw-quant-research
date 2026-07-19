# PyInstaller source spec for the later desktop bundle.
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules


SPEC_DIR = Path(SPECPATH).resolve()
if SPEC_DIR.is_file():
    SPEC_DIR = SPEC_DIR.parent
ROOT = SPEC_DIR.parent
fixture_datas = []
for market in ("k6a", "k6b"):
    fixture_dir = ROOT / "tests" / "fixtures" / market
    for fixture in sorted(fixture_dir.glob("*.json.gz")):
        fixture_datas.append((str(fixture), f"fixtures/{market}"))


a = Analysis(
    [str(ROOT / "scripts" / "tqe_sidecar.py")],
    pathex=[str(ROOT / "src")],
    binaries=[],
    datas=fixture_datas,
    hiddenimports=collect_submodules("tw_quant_engine"),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="tqe-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)
