#!/usr/bin/env python3
"""Run the approved S1 Qlib integration spike."""
from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.qlib_spike import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
