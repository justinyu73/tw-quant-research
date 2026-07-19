#!/usr/bin/env python3
"""Capture a bounded official TWSE STOCK_DAY history into a local K6a snapshot.

This is a human-run acquisition utility.  The dashboard and sidecar never call
this endpoint; they only replay the generated local snapshot.  The output is
intentionally limited to one symbol and an explicit month range so that the
operator can inspect the provenance before retaining it.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
from datetime import date, datetime, time, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
import sys

if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from tw_quant_engine.k6a_snapshot import build_snapshot  # noqa: E402


TAIPEI = ZoneInfo("Asia/Taipei")
ENDPOINT = "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY"
SOURCE_ID = "twse_stock_day"
SOURCE_TERMS = "https://www.twse.com.tw/"


def canonical_digest(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def month_range(start: str, end: str) -> list[str]:
    if not re.fullmatch(r"\d{4}-\d{2}", start) or not re.fullmatch(r"\d{4}-\d{2}", end):
        raise ValueError("months must use YYYY-MM")
    start_year, start_month = (int(part) for part in start.split("-"))
    end_year, end_month = (int(part) for part in end.split("-"))
    if not 1 <= start_month <= 12 or not 1 <= end_month <= 12:
        raise ValueError("month must be between 01 and 12")
    start_index = start_year * 12 + start_month - 1
    end_index = end_year * 12 + end_month - 1
    if end_index < start_index or end_index - start_index > 36:
        raise ValueError("month range must be ordered and no longer than 37 months")
    return [f"{index // 12:04d}-{index % 12 + 1:02d}" for index in range(start_index, end_index + 1)]


def number(value: object) -> int | float:
    text = str(value).strip().replace(",", "")
    if text in {"", "-", "--", "N/A"}:
        raise ValueError("missing numeric field")
    parsed = float(text)
    return int(parsed) if parsed.is_integer() else parsed


def parse_roc_date(value: object) -> str:
    match = re.fullmatch(r"(\d{2,3})/(\d{1,2})/(\d{1,2})", str(value).strip())
    if not match:
        raise ValueError(f"unsupported TWSE date: {value!r}")
    year, month, day = (int(part) for part in match.groups())
    return date(year + 1911, month, day).isoformat()


def bar_from_row(row: list[object]) -> dict[str, object]:
    if len(row) < 7:
        raise ValueError("TWSE STOCK_DAY row has fewer than seven fields")
    trading_date = parse_roc_date(row[0])
    trading_day = date.fromisoformat(trading_date)
    return {
        "trading_date": trading_date,
        "bar_time": datetime.combine(trading_day, time(13, 30), tzinfo=TAIPEI).isoformat(),
        "timezone": "Asia/Taipei",
        "session": "regular",
        "available_at": datetime.combine(trading_day, time(15, 0), tzinfo=TAIPEI).isoformat(),
        "open": number(row[3]),
        "high": number(row[4]),
        "low": number(row[5]),
        "close": number(row[6]),
        "volume": number(row[1]),
    }


def fetch_month(stock_no: str, month: str) -> tuple[dict[str, object], bytes]:
    year, month_number = month.split("-")
    # STOCK_DAY expects a concrete date; using the first day makes the
    # requested month explicit instead of silently falling back to current.
    query = f"?date={year}{month_number}01&stockNo={stock_no}&response=json"
    url = ENDPOINT + query
    request = Request(url, headers={"User-Agent": "TQE human-run research capture/1.0"})
    with urlopen(request, timeout=20) as response:  # nosec B310 - explicit official endpoint
        raw = response.read()
        payload = json.loads(raw.decode("utf-8"))
    if payload.get("stat") != "OK":
        raise RuntimeError(f"TWSE returned non-OK status for {month}: {payload.get('stat')!r}")
    fields = payload.get("fields")
    rows = payload.get("data")
    if not isinstance(fields, list) or not isinstance(rows, list):
        raise ValueError(f"TWSE response shape invalid for {month}")
    return {
        "month": month,
        "url": url,
        "http_status": 200,
        "response_bytes": len(raw),
        "content_digest": canonical_digest(payload),
        "row_count": len(rows),
        "fields": fields,
        "rows": rows,
    }, raw


def build_2330_snapshot(stock_no: str, months: list[str], fetched: list[dict[str, object]], *, retrieved_at: str) -> dict[str, object]:
    bars: list[dict[str, object]] = []
    seen_dates: set[str] = set()
    for month in fetched:
        for row in month["rows"]:
            bar = bar_from_row(row)
            trading_date = str(bar["trading_date"])
            if trading_date in seen_dates:
                raise ValueError(f"duplicate trading date across months: {trading_date}")
            seen_dates.add(trading_date)
            bars.append(bar)
    bars.sort(key=lambda item: str(item["trading_date"]))
    if not bars:
        raise ValueError("TWSE returned no bars in the requested range")
    last_date = str(bars[-1]["trading_date"])
    digest_input = [{key: month[key] for key in ("month", "content_digest", "row_count")} for month in fetched]
    digest = canonical_digest(digest_input)
    dataset = {
        "dataset_id": f"{SOURCE_ID}-{stock_no}-{months[0]}-{months[-1]}",
        "case": "valid",
        "instrument": {
            "instrument_id": f"TWSE:{stock_no}",
            "market": "TWSE",
            "symbol": stock_no,
            "display_name": "台積電",
            "asset_class": "equity",
            "currency": "TWD",
            "contract_month": None,
            "expiry": None,
        },
        "periods_available": ["1D"],
        "unsupported_periods": [],
        "adjustment_policy": "unadjusted",
        "quality": {"status": "valid", "reason_codes": []},
        "bars": bars,
    }
    source_metadata = {
        "source_id": SOURCE_ID,
        "endpoint": ENDPOINT,
        "terms_url": SOURCE_TERMS,
        "license_ref": "https://data.gov.tw/license",
        "attribution": "資料來源：臺灣證券交易所",
        "retrieved_at": retrieved_at,
        "http_status": 200,
        "content_type": "application/json",
        "response_bytes": sum(int(month["response_bytes"]) for month in fetched),
        "content_digest": digest,
        "symbol": stock_no,
        "months": months,
        "source_months": [
            {key: month[key] for key in ("month", "url", "http_status", "response_bytes", "content_digest", "row_count")}
            for month in fetched
        ],
    }
    return build_snapshot(
        source_metadata=source_metadata,
        mapping={
            "trading_date": last_date,
            "row_count": sum(int(month["row_count"]) for month in fetched),
            "admitted_count": 1,
            "unadmitted_count": 0,
            "admitted_by_asset_class": {"equity": 1},
            "excluded_by_reason": {},
            "datasets": [dataset],
        },
    )


def write_gzip(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=9) as handle:
        json.dump(payload, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stock-no", default="2330")
    parser.add_argument("--start", default="2025-01")
    parser.add_argument("--end", default="2026-06")
    parser.add_argument("--output", type=Path, default=ROOT / "tests/fixtures/k6a/twse_2330_history-2025-2026.json.gz")
    args = parser.parse_args(argv)
    months = month_range(args.start, args.end)
    fetched = []
    for month in months:
        payload, _raw = fetch_month(args.stock_no, month)
        fetched.append(payload)
    retrieved_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    snapshot = build_2330_snapshot(args.stock_no, months, fetched, retrieved_at=retrieved_at)
    write_gzip(args.output, snapshot)
    print(json.dumps({
        "output": str(args.output),
        "schema": snapshot["schema"],
        "snapshot_id": snapshot["snapshot_id"],
        "bars": len(snapshot["kline_fixture"]["datasets"][0]["bars"]),
        "first_date": snapshot["kline_fixture"]["datasets"][0]["bars"][0]["trading_date"],
        "last_date": snapshot["trading_date"],
        "source": ENDPOINT,
        "network_at_runtime": False,
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
