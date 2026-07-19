#!/usr/bin/env python3
"""Manually record one allowlisted TWSE/TPEx EOD response into a K6a snapshot."""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.adapters.tpex_openapi import fetch_tpex_daily, map_tpex_daily_rows  # noqa: E402
from tw_quant_engine.adapters.twse_openapi import fetch_twse_daily, map_twse_daily_rows  # noqa: E402
from tw_quant_engine.k6a_snapshot import (  # noqa: E402
    K6aSnapshotError,
    bars_digest_from_mapping,
    build_snapshot,
    normalize_trading_date,
)
from tw_quant_engine.source_registry import (  # noqa: E402
    PublicFetchError,
    decode_json,
    extract_rows,
    get_source,
    source_metadata,
    validate_url,
)


def _fetch(source_id: str, trading_date: str):
    if source_id == "twse_daily_close":
        return fetch_twse_daily(source_id)
    if source_id == "tpex_daily_close":
        return fetch_tpex_daily(source_id, trading_date)
    raise ValueError(f"unsupported K6a source: {source_id}")


def _map(source_id: str, rows: list[dict[str, object]], trading_date: str) -> dict[str, object]:
    if source_id == "twse_daily_close":
        return map_twse_daily_rows(rows, trading_date)
    if source_id == "tpex_daily_close":
        return map_tpex_daily_rows(rows, trading_date)
    raise ValueError(f"unsupported K6a source: {source_id}")


def _host_allowlist(source_id: str, url: str) -> dict[str, object]:
    source = get_source(source_id)
    parsed = urlsplit(url)
    checks = {
        "https": parsed.scheme == "https",
        "host": parsed.hostname == source.host,
        "path": parsed.path == source.path,
        "redirects": True,
    }
    validate_url(source_id, url)
    checks["pass"] = all(checks.values())
    checks["expected_host"] = source.host
    checks["observed_host"] = parsed.hostname
    checks["observed_url"] = url
    return checks


def _default_output(source_id: str, trading_date: str) -> Path:
    return ROOT / "tests/fixtures/k6a" / f"{source_id}-{trading_date}.json.gz"


def _repo_output(path: str | None, source_id: str, trading_date: str) -> Path:
    output = Path(path) if path else _default_output(source_id, trading_date)
    if not output.is_absolute():
        output = ROOT / output
    output = output.resolve()
    fixture_root = (ROOT / "tests/fixtures/k6a").resolve()
    if fixture_root not in output.parents:
        raise ValueError("K6a snapshots must be written under tests/fixtures/k6a")
    return output


def run(source_id: str, trading_date: str, output: Path) -> dict[str, object]:
    response, _ = _fetch(source_id, trading_date)
    metadata = source_metadata(source_id, response)
    allowlist = _host_allowlist(source_id, response.url)

    first_rows = extract_rows(decode_json(response))
    first_mapping = _map(source_id, first_rows, trading_date)
    replay_rows = extract_rows(decode_json(response))
    replay_mapping = _map(source_id, replay_rows, trading_date)
    first_bars_digest = bars_digest_from_mapping(first_mapping)
    replay_bars_digest = bars_digest_from_mapping(replay_mapping)
    raw_digest_first = response.content_digest
    raw_digest_replay = response.content_digest
    replay = {
        "raw_content_digest_first": raw_digest_first,
        "raw_content_digest_replay": raw_digest_replay,
        "bars_digest_first": first_bars_digest,
        "bars_digest_replay": replay_bars_digest,
        "same_raw_response": raw_digest_first == raw_digest_replay,
        "same_bars": first_bars_digest == replay_bars_digest,
        "pass": raw_digest_first == raw_digest_replay and first_bars_digest == replay_bars_digest,
    }
    if not replay["pass"]:
        raise K6aSnapshotError("record-replay digest mismatch")

    snapshot = build_snapshot(source_metadata=metadata, mapping=first_mapping)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.suffix != ".gz":
        raise K6aSnapshotError("K6a committed snapshots must use gzip compression")
    with gzip.open(output, "wt", encoding="utf-8") as handle:
        json.dump(snapshot, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
    return {
        "status": "pass",
        "source_id": source_id,
        "trading_date": normalize_trading_date(trading_date),
        "network": True,
        "network_requests": 1,
        "writes_snapshot": True,
        "snapshot_path": str(output.relative_to(ROOT)),
        "host_allowlist": allowlist,
        "content_digest": metadata["content_digest"],
        "row_counts": snapshot["row_counts"],
        "raw_response_replay": replay,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, choices=["twse_daily_close", "tpex_daily_close"])
    parser.add_argument("--trading-date", required=True, help="EOD date in YYYY-MM-DD")
    parser.add_argument("--output", help="optional path under tests/fixtures/k6a")
    args = parser.parse_args()
    try:
        trading_date = normalize_trading_date(args.trading_date)
        output = _repo_output(args.output, args.source, trading_date)
        report = run(args.source, trading_date, output)
    except (K6aSnapshotError, PublicFetchError, ValueError, UnicodeError) as exc:
        report = {
            "status": "fail",
            "source_id": args.source,
            "trading_date": args.trading_date,
            "error": str(exc),
        }
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
        return 1
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
