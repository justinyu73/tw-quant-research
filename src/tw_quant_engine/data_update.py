"""Human-triggered, bounded download of free official TWSE stock history."""
from __future__ import annotations

import gzip
import hashlib
import json
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .k6a_snapshot import build_snapshot, map_eod_rows


TWSE_STOCK_DAY_ENDPOINT = "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY"
TWSE_TERMS_URL = "https://www.twse.com.tw/"
DATA_MANIFEST_SCHEMA = "tw-quant-engine-local-data-manifest/v1"
TAIWAN_DATA_LICENSE = "https://data.gov.tw/license"
MAX_YEARS = 3
MAX_WATCHLIST_INSTRUMENTS = 100


class DataUpdateError(ValueError):
    """Raised when a user-triggered local data update cannot be admitted."""


Fetcher = Callable[[Request], tuple[bytes, int, str]]


def _digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _safe_component(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(value))


def _parse_twse_date(value: Any) -> str:
    match = re.fullmatch(r"(\d{2,3})/(\d{1,2})/(\d{1,2})", str(value).strip())
    if not match:
        raise DataUpdateError(f"unsupported TWSE date: {value!r}")
    year, month, day = (int(part) for part in match.groups())
    try:
        return date(year + 1911, month, day).isoformat()
    except ValueError as exc:
        raise DataUpdateError(f"invalid TWSE date: {value!r}") from exc


def _month_range(today: date, years: int) -> list[str]:
    if years not in (1, 2, 3):
        raise DataUpdateError("years must be 1, 2, or 3")
    start_index = (today.year - years) * 12 + today.month - 1
    end_index = today.year * 12 + today.month - 1
    return [f"{index // 12:04d}-{index % 12 + 1:02d}" for index in range(start_index, end_index + 1)]


def _default_fetcher(request: Request) -> tuple[bytes, int, str]:
    with urlopen(request, timeout=20) as response:  # nosec B310 - explicit official TWSE endpoint
        return response.read(), int(response.status), str(response.headers.get("Content-Type") or "")


def _fetch_month(symbol: str, month: str, fetcher: Fetcher) -> dict[str, Any]:
    year, month_number = month.split("-")
    query = urlencode({"date": f"{year}{month_number}01", "stockNo": symbol, "response": "json"})
    url = f"{TWSE_STOCK_DAY_ENDPOINT}?{query}"
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "TQR human-run research capture/1.0"})
    raw, http_status, content_type = fetcher(request)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DataUpdateError(f"TWSE response is not JSON for {month}") from exc
    if not isinstance(payload, Mapping) or payload.get("stat") != "OK":
        status = payload.get("stat") if isinstance(payload, Mapping) else None
        raise DataUpdateError(f"TWSE returned non-OK status for {month}: {status!r}")
    fields = payload.get("fields")
    data = payload.get("data")
    if not isinstance(fields, list) or not isinstance(data, list):
        raise DataUpdateError(f"TWSE response shape invalid for {month}")
    rows: list[dict[str, Any]] = []
    for raw_row in data:
        if not isinstance(raw_row, list) or len(raw_row) != len(fields):
            continue
        row = {str(key): value for key, value in zip(fields, raw_row)}
        row["證券代號"] = symbol
        rows.append(row)
    return {
        "month": month,
        "url": url,
        "payload": payload,
        "rows": rows,
        "raw": raw,
        "http_status": http_status,
        "content_type": content_type or "application/json",
        "response_bytes": len(raw),
        "content_digest": _digest(payload),
    }


def _write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(content)
    temporary.replace(path)


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    content = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    _write_bytes(path, content)


def _write_snapshot(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with gzip.open(temporary, "wb", compresslevel=9) as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    temporary.replace(path)


def _manifest_path(data_dir: Path) -> Path:
    return data_dir / "manifest.json"


def read_manifest(data_dir: str | Path) -> dict[str, Any]:
    path = _manifest_path(Path(data_dir).expanduser().resolve())
    if not path.is_file():
        return {"schema": DATA_MANIFEST_SCHEMA, "downloads": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DataUpdateError("local data manifest is unreadable") from exc
    if not isinstance(payload, dict) or payload.get("schema") != DATA_MANIFEST_SCHEMA:
        raise DataUpdateError("local data manifest schema mismatch")
    if not isinstance(payload.get("downloads"), list):
        raise DataUpdateError("local data manifest downloads must be a list")
    return payload


def _build_day_snapshot(
    *,
    instrument: Mapping[str, Any],
    trading_date: str,
    row: Mapping[str, Any],
    source: Mapping[str, Any],
    retrieved_at: str,
) -> dict[str, Any]:
    symbol = str(instrument["symbol"])
    mapping = map_eod_rows(
        [row],
        source_id="twse_stock_day",
        market="TWSE",
        trading_date=trading_date,
        field_names={
            "security_id": ("證券代號",),
            "trading_date": ("日期",),
            "open": ("開盤價",),
            "high": ("最高價",),
            "low": ("最低價",),
            "close": ("收盤價",),
            "volume": ("成交股數",),
            "display_name": ("display_name",),
        },
    )
    if not mapping["datasets"]:
        raise DataUpdateError(f"TWSE row failed OHLCV admission for {symbol} on {trading_date}")
    mapping["datasets"][0]["instrument"]["display_name"] = str(instrument.get("display_name") or symbol)
    snapshot = build_snapshot(
        source_metadata={
            "source_id": "twse_stock_day",
            "endpoint": source["url"],
            "terms_url": TWSE_TERMS_URL,
            "license_ref": TAIWAN_DATA_LICENSE,
            "attribution": "資料來源：臺灣證券交易所",
            "retrieved_at": retrieved_at,
            "http_status": source["http_status"],
            "content_type": source["content_type"],
            "response_bytes": source["response_bytes"],
            "content_digest": source["content_digest"],
            "symbol": symbol,
            "month": source["month"],
        },
        mapping=mapping,
    )
    snapshot["kline_fixture"]["provenance"] = {
        "source": "official-user-download",
        "fixture_id": f"download-twse-stock-day-{symbol}-{trading_date}",
        "network": True,
        "provider_calls": True,
    }
    snapshot["snapshot_digest"] = _digest(snapshot)
    return snapshot


def update_twse_history(
    data_dir: str | Path,
    instrument: Mapping[str, Any],
    years: int,
    *,
    today: date | None = None,
    fetcher: Fetcher | None = None,
) -> dict[str, Any]:
    """Download one selected TWSE stock for one to three trailing years.

    The operation is intentionally per-selected-symbol, bounded to at most 37
    monthly official requests, and writes raw responses plus normalized K6a
    snapshots only after each response passes the OHLCV admission rules.
    """
    instrument_id = str(instrument.get("instrument_id") or "")
    market = str(instrument.get("market") or "")
    symbol = str(instrument.get("symbol") or "").strip()
    if market != "TWSE" or not re.fullmatch(r"[1-9][0-9]{3}", symbol):
        raise DataUpdateError("目前本機更新先支援 TWSE 四位數上市個股")
    if instrument_id != f"TWSE:{symbol}":
        raise DataUpdateError("instrument identity mismatch")
    data_root = Path(data_dir).expanduser().resolve()
    data_root.mkdir(parents=True, exist_ok=True)
    current_day = today or date.today()
    months = _month_range(current_day, int(years))
    request_fetcher = fetcher or _default_fetcher
    retrieved_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    downloaded_months: list[str] = []
    downloaded_bars = 0
    errors: list[dict[str, str]] = []

    for month in months:
        try:
            source = _fetch_month(symbol, month, request_fetcher)
            raw_path = data_root / "raw" / "twse" / symbol / f"{month}.json"
            _write_json(raw_path, {
                "schema": "tw-quant-engine-raw-official-response/v1",
                "source_id": "twse_stock_day",
                "instrument_id": instrument_id,
                "retrieved_at": retrieved_at,
                "request_url": source["url"],
                "http_status": source["http_status"],
                "content_type": source["content_type"],
                "content_digest": source["content_digest"],
                "payload": source["payload"],
            })
            by_date: dict[str, list[Mapping[str, Any]]] = {}
            for row in source["rows"]:
                try:
                    trading_date = _parse_twse_date(row.get("日期"))
                except (DataUpdateError, TypeError, ValueError):
                    continue
                normalized_row = dict(row)
                normalized_row["日期"] = trading_date
                by_date.setdefault(trading_date, []).append(normalized_row)
            if not by_date:
                raise DataUpdateError(f"TWSE returned no admitted trading dates for {month}")
            for trading_date, rows in sorted(by_date.items()):
                snapshot = _build_day_snapshot(
                    instrument=instrument,
                    trading_date=trading_date,
                    row=rows[0],
                    source=source,
                    retrieved_at=retrieved_at,
                )
                snapshot_path = data_root / "k6a" / f"twse_stock_day-{symbol}-{trading_date}.json.gz"
                _write_snapshot(snapshot_path, snapshot)
                downloaded_bars += 1
            downloaded_months.append(month)
        except (DataUpdateError, OSError, ValueError) as exc:
            errors.append({"month": month, "error": str(exc)})

    manifest = read_manifest(data_root)
    record = {
        "instrument_id": instrument_id,
        "symbol": symbol,
        "market": market,
        "years": int(years),
        "months_requested": months,
        "months_downloaded": downloaded_months,
        "bars_downloaded": downloaded_bars,
        "errors": errors,
        "updated_at": retrieved_at,
        "source_id": "twse_stock_day",
        "terms_url": TWSE_TERMS_URL,
        "license_ref": TAIWAN_DATA_LICENSE,
    }
    manifest["last_update"] = record
    downloads = [item for item in manifest.get("downloads", []) if not (
        isinstance(item, Mapping) and item.get("instrument_id") == instrument_id
    )]
    downloads.append(record)
    manifest["downloads"] = downloads[-100:]
    _write_json(_manifest_path(data_root), manifest)
    status = "success" if not errors else ("partial" if downloaded_bars else "error")
    return {
        "status": status,
        "instrument_id": instrument_id,
        "years": int(years),
        "months_requested": len(months),
        "months_downloaded": len(downloaded_months),
        "bars_downloaded": downloaded_bars,
        "errors": errors,
        "updated_at": retrieved_at,
    }


def update_twse_watchlist(
    data_dir: str | Path,
    instruments: list[Mapping[str, Any]],
    years: int,
    *,
    today: date | None = None,
    fetcher: Fetcher | None = None,
) -> dict[str, Any]:
    """Update only the caller-provided watchlist, one instrument at a time.

    The caller must provide the explicit watchlist identities; this function
    never discovers or downloads the full market universe. Unsupported
    instruments remain visible as per-instrument results instead of aborting
    the other selected stocks.
    """
    current_day = today or date.today()
    requested_years = int(years)
    _month_range(current_day, requested_years)
    selected = list(instruments)
    if len(selected) > MAX_WATCHLIST_INSTRUMENTS:
        raise DataUpdateError(f"watchlist update is limited to {MAX_WATCHLIST_INSTRUMENTS} instruments")
    if not selected:
        return {
            "scope": "watchlist",
            "status": "empty",
            "years": requested_years,
            "requested_count": 0,
            "updated_count": 0,
            "bars_downloaded": 0,
            "results": [],
        }

    results: list[dict[str, Any]] = []
    for instrument in selected:
        instrument_id = str(instrument.get("instrument_id") or "")
        try:
            result = update_twse_history(
                data_dir,
                instrument,
                requested_years,
                today=current_day,
                fetcher=fetcher,
            )
        except (DataUpdateError, OSError, ValueError, TypeError) as exc:
            market = str(instrument.get("market") or "")
            symbol = str(instrument.get("symbol") or "")
            unsupported = market != "TWSE" or not re.fullmatch(r"[1-9][0-9]{3}", symbol)
            result = {
                "status": "unsupported" if unsupported else "error",
                "instrument_id": instrument_id,
                "symbol": symbol,
                "market": market,
                "years": requested_years,
                "months_requested": len(_month_range(current_day, requested_years)),
                "months_downloaded": 0,
                "bars_downloaded": 0,
                "errors": [{"error": str(exc)}],
            }
        result["display_name"] = str(instrument.get("display_name") or result.get("symbol") or instrument_id)
        results.append(result)

    updated = [result for result in results if result["status"] in {"success", "partial"}]
    status = "success" if len(updated) == len(results) else "partial" if updated else "error"
    return {
        "scope": "watchlist",
        "status": status,
        "years": requested_years,
        "requested_count": len(results),
        "updated_count": len(updated),
        "bars_downloaded": sum(int(result.get("bars_downloaded") or 0) for result in results),
        "results": results,
    }


__all__ = [
    "DATA_MANIFEST_SCHEMA",
    "DataUpdateError",
    "MAX_WATCHLIST_INSTRUMENTS",
    "TWSE_STOCK_DAY_ENDPOINT",
    "read_manifest",
    "update_twse_history",
    "update_twse_watchlist",
]
