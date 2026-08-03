#!/usr/bin/env python3
"""Run the TQE loopback sidecar with optional desktop local-data updates."""
from __future__ import annotations

import argparse
import os
import sys
import threading
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

# Frozen (PyInstaller) builds have no OS CA store; the spec bundles certifi,
# so point the default SSL context at it for the TWSE download path.
if getattr(sys, "frozen", False):
    try:
        import certifi

        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    except Exception:
        pass

from tw_quant_engine.desktop_sidecar import create_server, load_catalog, validate_loopback_host  # noqa: E402


def _default_fixture_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path.cwd())) / "fixtures"
    return ROOT / "tests" / "fixtures"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.getenv("TQE_SIDECAR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("TQE_SIDECAR_PORT", "8767")))
    parser.add_argument("--fixture-dir", type=Path, default=Path(os.getenv("TQE_FIXTURE_DIR", _default_fixture_dir())))
    parser.add_argument("--data-dir", type=Path, default=None, help="optional writable local data directory for explicit user updates")
    parser.add_argument(
        "--exit-with-parent",
        action="store_true",
        help="shut down when the parent process closes our stdin (desktop shell only)",
    )
    return parser


def _exit_when_parent_closes_stdin(server) -> None:
    """The desktop shell cannot reap us on a crash or a force quit, and a
    surviving sidecar holds its executable open — the next install then fails
    with files in use. The parent's pipe closing is the one signal that
    survives every exit path."""
    def watch() -> None:
        try:
            sys.stdin.buffer.read()
        except Exception:
            pass
        server.shutdown()

    thread = threading.Thread(target=watch, daemon=True)
    thread.start()


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    host = validate_loopback_host(args.host)
    data_dir = args.data_dir or (Path(os.environ["TQE_DATA_DIR"]) if os.getenv("TQE_DATA_DIR") else None)
    catalog = load_catalog(args.fixture_dir, data_dir=data_dir)
    server = create_server(catalog, host=host, port=args.port, fixture_root=args.fixture_dir, data_dir=data_dir)
    print(
        f"TQR sidecar listening on http://{host}:{args.port} "
        f"instruments={len(catalog.instruments)} digest={catalog.digest}",
        flush=True,
    )
    if args.exit_with_parent:
        _exit_when_parent_closes_stdin(server)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
