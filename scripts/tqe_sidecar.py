#!/usr/bin/env python3
"""Run the TQE offline read-only sidecar on loopback."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from tw_quant_engine.desktop_sidecar import create_server, load_catalog, validate_loopback_host  # noqa: E402


def _default_fixture_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path.cwd())) / "fixtures"
    return ROOT / "tests" / "fixtures"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.getenv("TQE_SIDECAR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("TQE_SIDECAR_PORT", "8766")))
    parser.add_argument("--fixture-dir", type=Path, default=Path(os.getenv("TQE_FIXTURE_DIR", _default_fixture_dir())))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    host = validate_loopback_host(args.host)
    catalog = load_catalog(args.fixture_dir)
    server = create_server(catalog, host=host, port=args.port)
    print(
        f"TQR sidecar listening on http://{host}:{args.port} "
        f"instruments={len(catalog.instruments)} digest={catalog.digest}",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
