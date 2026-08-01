#!/usr/bin/env python3
"""Probe the candidate free fundamentals endpoints for a P5.1-style source contract.

Human-run only.  The dashboard and sidecar never call these endpoints; this
utility answers the admission questions the spec requires before any field can
stop being ``unavailable``:

- does one unauthenticated GET return a bounded, parseable body?
- which of the minimum fundamental fields does it actually carry?
- does it carry an explicit publication date usable as ``available_at``?
- is it a latest-period snapshot or a historical series?

It writes a decision record; it does not admit a source, create a normalized
fixture, or enable any field.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "workflow" / "tqr-fundamentals-source-contract.json"
SAMPLE_DIR = ROOT / "tests" / "fixtures" / "tqr-fundamentals"
USER_AGENT = "tqr-source-contract-research"
TIMEOUT = 30

CANDIDATES = [
    ("twse_monthly_revenue", "https://openapi.twse.com.tw/v1/opendata/t187ap05_L", "monthly_revenue"),
    ("twse_income_statement", "https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci", "income_statement"),
    ("twse_balance_sheet", "https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ci", "balance_sheet"),
    ("tpex_monthly_revenue", "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O", "monthly_revenue"),
    ("tpex_income_statement", "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_ci", "income_statement"),
    ("tpex_balance_sheet", "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap07_O_ci", "balance_sheet"),
]

# Minimum fields the value-investing spec needs. Each entry is a group of
# accepted aliases: TWSE and TPEx publish the same datum under different column
# names, and that difference is a normalization contract, not a missing field.
NEEDED = {
    "monthly_revenue": [
        ["當月營收"], ["去年同月營收", "去年同月"], ["資料年月"],
        ["公司代號", "SecuritiesCompanyCode"], ["出表日期", "Date"],
    ],
    "income_statement": [
        ["營業收入"], ["營業利益"], ["本期淨利"], ["每股盈餘"],
        ["年度", "Year"], ["季別", "Season"],
        ["公司代號", "SecuritiesCompanyCode"], ["出表日期", "Date"],
    ],
    "balance_sheet": [
        ["資產總", "資產總計"], ["負債總", "負債總計"], ["權益總", "權益總計"],
        ["年度", "Year"], ["季別", "Season"],
        ["公司代號", "SecuritiesCompanyCode"], ["出表日期", "Date"],
    ],
}
PERIOD_KEYS = ["資料年月", "年度", "季別", "Year", "Season"]

# The admission state that the probe measurements now support. Kept here so a
# re-probe reproduces it instead of silently reverting the committed record.
IMPLEMENTATION = {
    "normalization": "src/tw_quant_engine/fundamentals.py",
    "capture": "scripts/capture_fundamentals.py",
    "markets": {"TWSE": "live_proven", "TPEx": "live_proven"},
    "families": ["monthly_revenue", "income_statement", "balance_sheet"],
    "column_mapping_is_per_family": True,
    "tpex_balance_sheet_totals": {"資產總計": "assets", "負債總計": "liabilities", "權益總計": "equity"},
    "absent_mapped_column": "FundamentalsMappingError_aborts_capture",
    "observation_key_excludes_market": True,
    "cross_market_same_key": "reported_as_conflict_and_refused",
}


def digest(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def probe(source_id: str, url: str, family: str) -> dict:
    record: dict = {
        "source_id": source_id,
        "endpoint": url,
        "family": family,
        "method": "GET",
        "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }
    try:
        response = urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=TIMEOUT)
        body = response.read()
        record["http_status"] = response.status
        record["content_type"] = response.headers.get("Content-Type")
        record["bytes"] = len(body)
        record["content_digest"] = digest(body)
    except (HTTPError, URLError, TimeoutError) as error:
        record["http_status"] = getattr(error, "code", None)
        record["error"] = f"{type(error).__name__}: {error}"
        record["admission"] = "rejected"
        record["reason"] = "endpoint_not_reachable_unauthenticated"
        return record

    try:
        rows = json.loads(body)
    except json.JSONDecodeError as error:
        record["admission"] = "rejected"
        record["reason"] = f"body_not_json: {error}"
        return record

    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        record["admission"] = "rejected"
        record["reason"] = "body_is_not_a_non_empty_row_array"
        return record

    fields = sorted(rows[0].keys())
    record["row_count"] = len(rows)
    record["fields"] = fields

    joined = "".join(fields)
    missing = []
    resolved = {}
    for group in NEEDED[family]:
        hit = next((alias for alias in group if alias in joined), None)
        if hit is None:
            missing.append(group[0])
        else:
            resolved[group[0]] = hit
    record["missing_minimum_fields"] = missing
    record["field_aliases"] = resolved

    # Period spread tells us whether this is a latest-period snapshot or a series.
    periods = Counter()
    for row in rows:
        key = tuple(str(row.get(name, "")) for name in PERIOD_KEYS if name in row)
        if any(key):
            periods[key] += 1
    record["distinct_periods"] = len(periods)
    record["period_examples"] = ["/".join(k) for k, _ in periods.most_common(5)]
    record["coverage"] = "latest_period_snapshot" if len(periods) <= 2 else "multi_period"

    published = [name for name in fields if "出表日期" in name or "公告" in name or name == "Date"]
    record["publication_date_fields"] = published
    record["available_at_candidate"] = bool(published)

    id_key = "公司代號" if "公司代號" in fields else "SecuritiesCompanyCode"
    securities = {str(row.get(id_key, "")) for row in rows if row.get(id_key)}
    record["distinct_securities"] = len(securities)
    record["sample_row"] = rows[0]

    if missing:
        record["admission"] = "rejected"
        record["reason"] = "minimum_fields_missing: " + ", ".join(missing)
    elif not published:
        record["admission"] = "rejected"
        record["reason"] = "no_explicit_publication_date_so_available_at_would_be_guessed"
    else:
        record["admission"] = "candidate_admitted_pending_human_approval"
        record["reason"] = "bounded_unauthenticated_get_with_minimum_fields_and_publication_date"
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-samples", action="store_true", help="retain one bounded sample row per source")
    args = parser.parse_args()

    records = [probe(*candidate) for candidate in CANDIDATES]
    contract = {
        "schema": "tqr-fundamentals-source-contract/v1",
        "status": "twse_and_tpex_live_proven_forward_accumulation",
        "purpose": "Record what the candidate endpoints measurably return. Admission and enablement decisions live in the doc this points at.",
        "license": {
            "id": "government-data-open-license-v1",
            "url": "https://data.gov.tw/license",
            "attribution_text": "資料來源：臺灣證券交易所、財團法人中華民國證券櫃檯買賣中心",
            "per_observation_attribution": True,
        },
        "spec": {"path": "docs/tqr-research-platform-spec.md", "decision": "TQR-IA-003"},
        "implementation": IMPLEMENTATION,
        "probed_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "sources": records,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if args.write_samples:
        SAMPLE_DIR.mkdir(parents=True, exist_ok=True)
        for record in records:
            if "sample_row" not in record:
                continue
            path = SAMPLE_DIR / f"{record['source_id']}.sample.json"
            path.write_text(
                json.dumps(
                    {
                        "source_id": record["source_id"],
                        "endpoint": record["endpoint"],
                        "retrieved_at": record["retrieved_at"],
                        "content_digest": record["content_digest"],
                        "license_ref": "https://data.gov.tw/license",
                        "row": record["sample_row"],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

    print(json.dumps({"output": str(OUTPUT.relative_to(ROOT)), "sources": [
        {k: record.get(k) for k in ("source_id", "http_status", "row_count", "distinct_periods", "coverage", "available_at_candidate", "admission", "reason")}
        for record in records
    ]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
