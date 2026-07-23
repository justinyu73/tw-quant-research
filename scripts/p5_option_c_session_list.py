#!/usr/bin/env python3
"""Generate the P5 option C session list from the captured official calendar.

Read-only against the repository: reads the caller-owned raw calendar capture
under outputs/ and rewrites workflow/tqe-p5-option-c-session-list.json.
Fails closed: it never invents sessions for calendar years the capture does
not cover, and it refuses to emit a list above the session cap.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW_CALENDAR = ROOT / "outputs/p5-trial-capture/holidaySchedule.json"
CAPTURE_RECORD = ROOT / "outputs/p5-trial-capture/holidaySchedule.capture.json"
OUT_PATH = ROOT / "workflow/tqe-p5-option-c-session-list.json"

WINDOW_START = dt.date(2023, 7, 20)
WINDOW_END = dt.date(2026, 7, 19)
SESSION_CAP = 750


def roc_to_iso(raw: str) -> str:
    return f"{int(raw[:3]) + 1911}-{raw[3:5]}-{raw[5:7]}"


def classify(entries: list[dict]) -> tuple[set[str], set[str], set[str]]:
    holidays, trading_markers, settlement_only = set(), set(), set()
    for entry in entries:
        iso = roc_to_iso(entry["Date"])
        name = entry.get("Name", "")
        if "開始交易日" in name or "最後交易日" in name:
            trading_markers.add(iso)
        elif "無交易" in name:
            settlement_only.add(iso)
        else:
            holidays.add(iso)
    return holidays, trading_markers, settlement_only


def weekday_sessions(start: dt.date, end: dt.date, closed: set[str]) -> list[str]:
    sessions = []
    day = start
    while day <= end:
        iso = day.isoformat()
        if day.weekday() < 5 and iso not in closed:
            sessions.append(iso)
        day += dt.timedelta(days=1)
    return sessions


def main() -> int:
    raw_bytes = RAW_CALENDAR.read_bytes()
    digest = "sha256:" + hashlib.sha256(raw_bytes).hexdigest()
    capture = json.loads(CAPTURE_RECORD.read_text(encoding="utf-8"))
    if capture["sha256"] != digest:
        print("calendar raw file digest does not match the capture record", file=sys.stderr)
        return 1

    entries = json.loads(raw_bytes.decode("utf-8"))
    holidays, trading_markers, settlement_only = classify(entries)
    covered_years = sorted({roc_to_iso(e["Date"])[:4] for e in entries})

    covered_start = max(WINDOW_START, dt.date(int(covered_years[0]), 1, 1))
    covered_end = min(WINDOW_END, dt.date(int(covered_years[-1]), 12, 31))
    closed = holidays | settlement_only
    sessions = weekday_sessions(covered_start, covered_end, closed)

    uncovered_weekdays = len(weekday_sessions(WINDOW_START, covered_start - dt.timedelta(days=1), set()))
    estimated_total = len(sessions) + uncovered_weekdays - 42  # ~17 holidays/full year, ~8 in 2023 H2

    payload = {
        "schema": "tw-quant-engine-p5-option-c-session-list/v1",
        "status": "partial_calendar_coverage_pending_full_window_enumeration",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "window": {"start": str(WINDOW_START), "end": str(WINDOW_END)},
        "session_count_cap": SESSION_CAP,
        "calendar": {
            "endpoint": capture["url"],
            "method": capture["method"],
            "fetched_at": capture["fetched_at"],
            "http_status": capture["http_status"],
            "response_bytes": capture["bytes"],
            "response_sha256": digest,
            "raw_file": capture["raw_file"],
            "roc_year_format": "Date is ROC calendar year (e.g. 1150101 = 2026-01-01); converted by adding 1911",
            "covered_gregorian_years": covered_years,
            "coverage_limitation": (
                "The official holidaySchedule endpoint returns only the current ROC year "
                f"({covered_years}); it does not cover 2023-2025. The window segment "
                "2023-07-20..2025-12-31 cannot be enumerated from this capture."
            ),
            "classification_rule": (
                "sessions = weekdays (Mon-Fri) minus entries whose Name is a holiday "
                "(依規定放假) minus 市場無交易 settlement-only days; 開始交易日/最後交易日 "
                "entries are trading-day markers, not closures"
            ),
        },
        "enumerated_segment": {
            "start": str(covered_start),
            "end": str(covered_end),
            "session_count": len(sessions),
            "sessions": sessions,
        },
        "uncovered_segment": {
            "start": str(WINDOW_START),
            "end": str(covered_start - dt.timedelta(days=1)),
            "weekday_count": uncovered_weekdays,
            "estimated_sessions_after_holidays": uncovered_weekdays - 42,
            "estimate_note": "Estimate only: assumes ~17 closed weekdays per full year and ~8 in 2023 H2, matching the 2026 official calendar density. Not an enumeration.",
        },
        "estimated_total_sessions": estimated_total,
        "cap_check": {
            "cap": SESSION_CAP,
            "enumerated_count": len(sessions),
            "estimated_total_at_or_below_cap": estimated_total <= SESSION_CAP,
            "rule": "Final activation requires the fully enumerated session list for the whole window with count <= cap; the estimate is not proof.",
        },
        "coverage_gap_handling_options": [
            {
                "option": "per_year_official_calendar_captures",
                "detail": "Capture the official calendar for each of 2023, 2024, 2025 from an official surface that exposes historical year schedules (extra GETs, not executed by this record; requires user approval).",
            },
            {
                "option": "official_historical_schedule_publications",
                "detail": "Bind the official yearly market-schedule announcements (TWSE publishes each year's trading calendar in advance) as caller-owned evidence with per-year digests, recorded in the work-unit.",
            },
            {
                "option": "reject_and_re_scope",
                "detail": "If no official historical calendar can be bound, the uncovered segment stays unadmitted; inferring sessions from observed bars is prohibited by the P5 hard stops.",
            },
        ],
    }
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"sessions_enumerated": len(sessions), "estimated_total": estimated_total}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
