#!/usr/bin/env python3
"""Human-run bounded capture of one fundamentals period into the local series.

One explicit run captures the single period each free endpoint currently
publishes and merges it into the local append-only series. There is no schedule,
no polling, and no background job: the operator decides when a new period exists
and runs this once.

Re-running on an unchanged period is a no-op even though the exchange's batch
export date advances, because dedupe keys on the financial values.

Both exchanges are captured by default. A same-key/different-market collision is
never merged silently: it is reported and the run exits non-zero.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.fundamentals import (  # noqa: E402
    BALANCE_SHEET,
    FAMILIES,
    INCOME_STATEMENT,
    MARKETS,
    MONTHLY_REVENUE,
    SERIES_SCHEMA,
    TPEX,
    TWSE,
    empty_series,
    merge_observations,
    normalize_rows,
)

ENDPOINTS = {
    (TWSE, MONTHLY_REVENUE): "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
    (TWSE, INCOME_STATEMENT): "https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci",
    (TWSE, BALANCE_SHEET): "https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ci",
    (TPEX, MONTHLY_REVENUE): "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O",
    (TPEX, INCOME_STATEMENT): "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_ci",
    (TPEX, BALANCE_SHEET): "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap07_O_ci",
}
USER_AGENT = "tqr-fundamentals-capture"
TIMEOUT = 60
DEFAULT_SERIES = Path.home() / ".local/share/io.github.justinyu73.twquantengine/fundamentals-series.json"


def load_series(path: Path) -> dict:
    if not path.exists():
        return empty_series()
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema") != SERIES_SCHEMA:
        raise SystemExit(f"existing series has unexpected schema: {payload.get('schema')!r}")
    return payload


def fetch(url: str) -> list:
    response = urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=TIMEOUT)
    if response.status != 200:
        raise SystemExit(f"{url} returned HTTP {response.status}")
    rows = json.loads(response.read())
    if not isinstance(rows, list):
        raise SystemExit(f"{url} did not return a row array")
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--series", type=Path, default=DEFAULT_SERIES, help="local series file to merge into")
    parser.add_argument("--family", choices=list(FAMILIES), action="append",
                        help="limit to one family; repeatable (default: all)")
    parser.add_argument("--market", choices=list(MARKETS), action="append",
                        help="limit to one market; repeatable (default: all)")
    parser.add_argument("--from-file", type=Path,
                        help="replay a saved response instead of fetching; requires exactly one --family and one --market")
    parser.add_argument("--dry-run", action="store_true", help="report the merge without writing")
    args = parser.parse_args()

    families = args.family or list(FAMILIES)
    markets = args.market or list(MARKETS)
    if args.from_file and (len(families) != 1 or len(markets) != 1):
        raise SystemExit("--from-file requires exactly one --family and one --market")

    series = load_series(args.series)
    report = {"series": str(args.series), "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"), "captures": {}}
    conflicts = []

    for market in markets:
        for family in families:
            rows = json.loads(args.from_file.read_text(encoding="utf-8")) if args.from_file else fetch(ENDPOINTS[(market, family)])
            observations = normalize_rows(rows, family, market)
            series = merge_observations(series, observations)
            conflicts.extend(series["last_merge"]["conflicts"])
            periods = sorted({item["period"] for item in observations})
            report["captures"][f"{market}/{family}"] = {
                "source_rows": len(rows),
                "normalized": len(observations),
                "dropped": len(rows) - len(observations),
                "periods": periods,
                "merge": series["last_merge"],
            }

    report["total_observations"] = len(series["observations"])
    report["conflicts"] = conflicts
    if conflicts:
        # Ambiguous identity: refuse to persist a series built on a guess.
        report["written"] = False
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1
    if not args.dry_run:
        args.series.parent.mkdir(parents=True, exist_ok=True)
        args.series.write_text(json.dumps(series, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        report["written"] = True
    else:
        report["written"] = False

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
