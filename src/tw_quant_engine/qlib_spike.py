"""Small, offline Qlib integration spike for S1.

This module deliberately does not initialize a Qlib market-data provider. The
fixture is synthetic so the integration check proves only that the pinned Qlib
runtime and a narrow evaluation API can be called reproducibly.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any


S1_SCHEMA = "tw-quant-engine-s1-qlib-spike/v1"
QLIB_VERSION = "0.9.7"
SYNTHETIC_RETURNS = (0.01, -0.005, 0.02, 0.0, 0.003, -0.004, 0.006, 0.002)


def synthetic_fixture() -> list[dict[str, float | str]]:
    """Return a fixed, provider-free daily return fixture."""
    return [
        {"date": f"2024-01-{day:02d}", "return": value}
        for day, value in enumerate(SYNTHETIC_RETURNS, start=2)
    ]


def fixture_digest() -> str:
    """Hash the canonical fixture representation for reproducibility checks."""
    encoded = json.dumps(
        synthetic_fixture(), sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def run_qlib_spike() -> dict[str, Any]:
    """Run one narrow Qlib evaluation call against synthetic returns."""
    try:
        import pandas as pd
        import qlib
        from qlib.contrib.evaluate import risk_analysis
    except ImportError as exc:  # pragma: no cover - exercised by the CLI
        raise RuntimeError(
            "Qlib S1 dependency is unavailable; install tw-quant-engine[qlib]"
        ) from exc

    actual_version = str(getattr(qlib, "__version__", "unknown"))
    if actual_version != QLIB_VERSION:
        raise RuntimeError(
            f"Qlib version mismatch: expected {QLIB_VERSION}, got {actual_version}"
        )

    fixture = synthetic_fixture()
    returns = pd.Series(
        [row["return"] for row in fixture],
        index=pd.to_datetime([row["date"] for row in fixture]),
        name="synthetic_return",
        dtype="float64",
    )
    risk = risk_analysis(returns, N=252, mode="product")
    risk_metrics = {
        str(metric): float(value)
        for metric, value in risk["risk"].items()
    }

    return {
        "schema": S1_SCHEMA,
        "stage": "S1",
        "status": "pass",
        "qlib_package": "pyqlib",
        "qlib_version": actual_version,
        "provider_initialized": False,
        "network_used": False,
        "fixture_rows": len(fixture),
        "fixture_digest": fixture_digest(),
        "risk_metrics": risk_metrics,
    }


def main() -> int:
    print(json.dumps(run_qlib_spike(), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
