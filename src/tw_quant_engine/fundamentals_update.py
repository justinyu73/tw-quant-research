"""Explicit, bounded capture of the latest fundamentals for selected equities.

The source endpoints publish one full-market snapshot per family.  This module
fetches only the markets represented by the user's explicit scope, filters the
normalized observations to the requested security IDs, and atomically merges
those observations into the local append-only series.  It is deliberately not
called by the K-line history updater and has no background or scheduled path.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from urllib.request import Request, urlopen

from .fundamentals import (
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


FUNDAMENTALS_ENDPOINTS = {
    (TWSE, MONTHLY_REVENUE): "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
    (TWSE, INCOME_STATEMENT): "https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci",
    (TWSE, BALANCE_SHEET): "https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ci",
    (TPEX, MONTHLY_REVENUE): "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O",
    (TPEX, INCOME_STATEMENT): "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_ci",
    (TPEX, BALANCE_SHEET): "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap07_O_ci",
}
FUNDAMENTALS_USER_AGENT = "tqr-fundamentals-capture"
FUNDAMENTALS_TIMEOUT_SECONDS = 60
MAX_FUNDAMENTALS_INSTRUMENTS = 100
_EQUITY_ID = re.compile(r"^(TWSE|TPEX):([0-9A-Z]{4,6})$", re.IGNORECASE)


class FundamentalsUpdateError(ValueError):
    """Raised when an explicit fundamentals update cannot be admitted."""


Fetcher = Callable[[str], Sequence[Mapping[str, Any]]]


def load_series(path: str | Path) -> dict[str, Any]:
    """Load the local series, treating a missing file as an empty series."""
    series_path = Path(path).expanduser().resolve()
    if not series_path.exists():
        return empty_series()
    try:
        payload = json.loads(series_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FundamentalsUpdateError("本機財務指標資料無法讀取") from exc
    if not isinstance(payload, dict) or payload.get("schema") != SERIES_SCHEMA:
        raise FundamentalsUpdateError("本機財務指標資料 schema 不相容")
    if not isinstance(payload.get("observations"), list):
        raise FundamentalsUpdateError("本機財務指標資料 observations 不相容")
    return payload


def fetch_fundamentals_rows(url: str) -> list[Mapping[str, Any]]:
    """Fetch one official JSON row array after an explicit user action."""
    request = Request(url, headers={"Accept": "application/json", "User-Agent": FUNDAMENTALS_USER_AGENT})
    try:
        with urlopen(request, timeout=FUNDAMENTALS_TIMEOUT_SECONDS) as response:  # nosec B310 - fixed official endpoints
            if int(response.status) != 200:
                raise FundamentalsUpdateError(f"官方財務來源回應 HTTP {response.status}")
            payload = json.loads(response.read().decode("utf-8"))
    except FundamentalsUpdateError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FundamentalsUpdateError("官方財務來源無法連線或回應格式錯誤") from exc
    if not isinstance(payload, list):
        raise FundamentalsUpdateError("官方財務來源不是資料列陣列")
    return payload


def _target(instrument: Mapping[str, Any]) -> tuple[str, str, str] | None:
    instrument_id = str(instrument.get("instrument_id") or "").strip().upper()
    match = _EQUITY_ID.fullmatch(instrument_id)
    if not match:
        return None
    market = TWSE if match.group(1) == TWSE else TPEX
    symbol = match.group(2)
    canonical_id = f"{market}:{symbol}"
    return canonical_id, market, symbol


def _write_series(path: Path, series: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(series, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def update_fundamentals_scope(
    data_dir: str | Path,
    instruments: Sequence[Mapping[str, Any]],
    *,
    fetcher: Fetcher | None = None,
    captured_at: str | None = None,
) -> dict[str, Any]:
    """Capture the latest admitted periods for the explicit instrument scope.

    Network and mapping errors fail closed before the series file is replaced.
    A source row missing a requested company is not an error: that instrument
    receives an honest ``unavailable``/``partial`` result and the other rows
    remain usable.
    """
    selected = list(instruments)
    if not selected:
        raise FundamentalsUpdateError("財務指標更新需要至少一個標的")
    if len(selected) > MAX_FUNDAMENTALS_INSTRUMENTS:
        raise FundamentalsUpdateError(f"財務指標更新最多 {MAX_FUNDAMENTALS_INSTRUMENTS} 檔")

    results: list[dict[str, Any]] = []
    target_by_market: dict[str, set[str]] = {market: set() for market in MARKETS}
    seen: set[str] = set()
    for instrument in selected:
        original_id = str(instrument.get("instrument_id") or "").strip()
        resolved = _target(instrument)
        result = {
            "instrument_id": original_id,
            "symbol": str(instrument.get("symbol") or ""),
            "market": str(instrument.get("market") or ""),
            "display_name": str(instrument.get("display_name") or instrument.get("symbol") or original_id),
            "status": "unsupported",
            "families": {},
            "observations": 0,
            "errors": [],
        }
        if resolved is None:
            result["message"] = "目前只支援 TWSE／TPEx 上市櫃股票"
        else:
            canonical_id, market, symbol = resolved
            if canonical_id in seen:
                raise FundamentalsUpdateError(f"財務指標更新標的重複：{canonical_id}")
            seen.add(canonical_id)
            result["instrument_id"] = canonical_id
            result["market"] = market
            result["symbol"] = symbol
            result["status"] = "pending"
            target_by_market[market].add(symbol)
        results.append(result)

    series_path = Path(data_dir).expanduser().resolve() / "fundamentals-series.json"
    series = load_series(series_path)
    fetch = fetcher or fetch_fundamentals_rows
    captures: dict[str, Any] = {}
    total_merge = {"added": 0, "restated": 0, "unchanged": 0}

    for market in MARKETS:
        target_symbols = target_by_market[market]
        if not target_symbols:
            continue
        for family in FAMILIES:
            url = FUNDAMENTALS_ENDPOINTS[(market, family)]
            try:
                rows = list(fetch(url))
                observations = normalize_rows(rows, family, market)
            except FundamentalsUpdateError:
                raise
            except Exception as exc:  # noqa: BLE001 - convert source/mapping failures to one safe boundary
                raise FundamentalsUpdateError(f"{market} {family} 財務資料無法驗證") from exc

            selected_observations = [
                observation for observation in observations
                if str(observation.get("security_id") or "") in target_symbols
            ]
            try:
                merged = merge_observations(series, selected_observations)
            except (KeyError, TypeError, ValueError) as exc:
                raise FundamentalsUpdateError("本機財務指標資料無法安全合併") from exc
            conflicts = merged.get("last_merge", {}).get("conflicts", [])
            if conflicts:
                raise FundamentalsUpdateError("財務資料出現跨市場同代號衝突，已拒絕寫入")
            series = merged
            merge = merged["last_merge"]
            for key in total_merge:
                total_merge[key] += int(merge.get(key) or 0)
            captures[f"{market}/{family}"] = {
                "source_rows": len(rows),
                "normalized": len(observations),
                "selected": len(selected_observations),
                "periods": sorted({str(item["period"]) for item in selected_observations}),
                "merge": merge,
            }

            by_symbol = {
                str(item["security_id"]): item
                for item in selected_observations
            }
            for result in results:
                if result["status"] == "unsupported" or result["market"] != market:
                    continue
                observation = by_symbol.get(str(result["symbol"]))
                result["families"][family] = {
                    "status": "captured" if observation else "unavailable",
                    "period": observation.get("period") if observation else None,
                }
                if observation:
                    result["observations"] += 1

    for result in results:
        if result["status"] == "unsupported":
            continue
        captured_count = int(result["observations"])
        if captured_count == len(FAMILIES):
            result["status"] = "success"
            result["message"] = "月營收、季報與財務品質資料已更新"
        elif captured_count:
            result["status"] = "partial"
            result["message"] = f"已更新 {captured_count}/{len(FAMILIES)} 類，其他資料目前 unavailable"
        else:
            result["status"] = "unavailable"
            result["message"] = "官方最新一期尚無此標的資料"

    _write_series(series_path, series)
    supported = [result for result in results if result["status"] != "unsupported"]
    result_status = "success" if all(
        result["status"] == "success" for result in results
    ) else "partial"
    return {
        "scope": "fundamentals",
        "status": result_status,
        "captured_at": captured_at or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "requested_count": len(results),
        "updated_count": sum(result["status"] in {"success", "partial"} for result in results),
        "unavailable_count": sum(result["status"] == "unavailable" for result in results),
        "unsupported_count": sum(result["status"] == "unsupported" for result in results),
        "supported_count": len(supported),
        "observations_added": total_merge["added"],
        "observations_restated": total_merge["restated"],
        "observations_unchanged": total_merge["unchanged"],
        "captures": captures,
        "results": results,
    }


__all__ = [
    "FUNDAMENTALS_ENDPOINTS",
    "FUNDAMENTALS_TIMEOUT_SECONDS",
    "MAX_FUNDAMENTALS_INSTRUMENTS",
    "FundamentalsUpdateError",
    "fetch_fundamentals_rows",
    "load_series",
    "update_fundamentals_scope",
]
