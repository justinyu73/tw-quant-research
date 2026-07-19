"""Serve the dashboard in a plain browser with the loopback sidecar wired.

Unlike serve_dashboard_dev.py (Tauri starts the sidecar as an external binary),
this standalone command starts the read-only offline sidecar in-process so the
dashboard's runtime K-line fetch works when opened directly at the served URL.
Everything stays on 127.0.0.1; no network, no write, no live data.
"""
from __future__ import annotations

import argparse
import os
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from tw_quant_engine.desktop_sidecar import create_server, load_catalog, validate_loopback_host  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--sidecar-port", type=int, default=8766)
    args = parser.parse_args()

    host = validate_loopback_host("127.0.0.1")
    catalog = load_catalog(ROOT / "tests" / "fixtures")
    sidecar = create_server(catalog, host=host, port=args.sidecar_port)
    sidecar_url = f"http://{host}:{args.sidecar_port}"
    threading.Thread(target=sidecar.serve_forever, daemon=True).start()
    print(f"TQE sidecar listening on {sidecar_url} instruments={len(catalog.instruments)}", flush=True)

    os.environ["TQE_SIDECAR_URL"] = sidecar_url
    from build_dashboard_preview import DEFAULT_OUTPUT, build_preview  # after env is set

    build_preview(DEFAULT_OUTPUT)
    handler = partial(SimpleHTTPRequestHandler, directory=str(DEFAULT_OUTPUT))
    server = ThreadingHTTPServer((host, args.port), handler)
    print(f"TQE dashboard listening on http://{host}:{args.port}  (open this in your browser)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
        sidecar.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
