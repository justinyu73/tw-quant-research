"""Build and serve the local dashboard for the Tauri development shell."""
from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from build_dashboard_preview import DEFAULT_OUTPUT, build_preview


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5173)
    args = parser.parse_args()
    build_preview(DEFAULT_OUTPUT)
    handler = partial(SimpleHTTPRequestHandler, directory=str(DEFAULT_OUTPUT))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"TQR dashboard dev server listening on http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
