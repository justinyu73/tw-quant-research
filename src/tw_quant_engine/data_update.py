"""Human-triggered, bounded download of free official TWSE/TPEx history."""
from __future__ import annotations

import gzip
import hashlib
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .k6a_snapshot import build_snapshot, map_eod_rows


TWSE_STOCK_DAY_ENDPOINT = "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY"
TWSE_TERMS_URL = "https://www.twse.com.tw/"
TPEX_DAILY_QUOTES_ENDPOINT = "https://www.tpex.org.tw/www/en-us/afterTrading/dailyQuotes"
TPEX_TERMS_URL = "https://www.tpex.org.tw/"
DATA_MANIFEST_SCHEMA = "tw-quant-engine-local-data-manifest/v1"
TAIWAN_DATA_LICENSE = "https://data.gov.tw/license"
TWSE_ATTRIBUTION = "資料來源：臺灣證券交易所"
TPEX_ATTRIBUTION = "資料來源：財團法人中華民國證券櫃檯買賣中心"
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


def _weekday_range(today: date, years: int) -> list[str]:
    """Return the bounded weekday request dates for the same month window."""
    months = _month_range(today, years)
    start = date.fromisoformat(f"{months[0]}-01")
    current = start
    dates: list[str] = []
    while current <= today:
        if current.weekday() < 5:
            dates.append(current.isoformat())
        current += timedelta(days=1)
    return dates


def _default_fetcher(request: Request) -> tuple[bytes, int, str]:
    with urlopen(request, timeout=20) as response:  # nosec B310 - explicit official exchange endpoint
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


def _parse_tpex_date(value: Any) -> str:
    """Parse the Gregorian date envelope returned by TPEx dailyQuotes."""
    text = str(value or "").strip()
    match = re.fullmatch(r"(\d{4})(\d{2})(\d{2})", text)
    if match:
        year, month, day = (int(part) for part in match.groups())
    else:
        match = re.fullmatch(r"(\d{3,4})/(\d{1,2})/(\d{1,2})", text)
        if not match:
            match = re.fullmatch(r"(\d{3})(\d{2})(\d{2})", text)
        if not match:
            raise DataUpdateError(f"unsupported TPEx date: {value!r}")
        year, month, day = (int(part) for part in match.groups())
        if year < 1911:
            year += 1911
    try:
        return date(year, month, day).isoformat()
    except ValueError as exc:
        raise DataUpdateError(f"invalid TPEx date: {value!r}") from exc


def _fetch_tpex_day(trading_date: str, fetcher: Fetcher) -> dict[str, Any]:
    """Fetch one official TPEx full-market day and retain selectable rows."""
    requested = date.fromisoformat(trading_date)
    form = urlencode({
        "date": requested.strftime("%Y/%m/%d"),
        "response": "json",
    }).encode("utf-8")
    request = Request(
        TPEX_DAILY_QUOTES_ENDPOINT,
        data=form,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": "TQR human-run research capture/1.0",
            "X-Requested-With": "XMLHttpRequest",
        },
    )
    raw, http_status, content_type = fetcher(request)
    if http_status != 200:
        raise DataUpdateError(f"TPEx returned HTTP {http_status} for {trading_date}")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DataUpdateError(f"TPEx response is not JSON for {trading_date}") from exc
    if not isinstance(payload, Mapping) or str(payload.get("stat") or "").strip().lower() != "ok":
        status = payload.get("stat") if isinstance(payload, Mapping) else None
        raise DataUpdateError(f"TPEx returned non-OK status for {trading_date}: {status!r}")
    response_date = _parse_tpex_date(payload.get("date"))
    if response_date != trading_date:
        raise DataUpdateError(f"TPEx response date mismatch for {trading_date}: {response_date}")
    tables = payload.get("tables")
    if not isinstance(tables, list):
        raise DataUpdateError(f"TPEx response shape invalid for {trading_date}")

    required_fields = {"Code", "Open", "High", "Low", "Close", "Trading Shares"}
    selected_table: tuple[list[str], list[Any]] | None = None
    for table in tables:
        if not isinstance(table, Mapping):
            continue
        fields = table.get("fields")
        data = table.get("data")
        if not isinstance(fields, list) or not isinstance(data, list):
            continue
        field_names = [str(field) for field in fields]
        if required_fields.issubset(field_names):
            selected_table = (field_names, data)
            break
    if selected_table is None:
        raise DataUpdateError(f"TPEx response fields invalid for {trading_date}")

    fields, data = selected_table
    rows: list[dict[str, Any]] = []
    rows_by_symbol: dict[str, dict[str, Any]] = {}
    for raw_row in data:
        if not isinstance(raw_row, list) or len(raw_row) != len(fields):
            continue
        row = {field: value for field, value in zip(fields, raw_row)}
        row["Date"] = trading_date
        row["display_name"] = row.get("Name")
        code = str(row.get("Code") or "").strip()
        if not code:
            continue
        rows.append(row)
        rows_by_symbol.setdefault(code, row)
    return {
        "date": trading_date,
        "url": TPEX_DAILY_QUOTES_ENDPOINT,
        "payload": payload,
        "fields": fields,
        "rows": rows,
        "rows_by_symbol": rows_by_symbol,
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
    source_id: str,
    market: str,
    terms_url: str,
    attribution: str,
    field_names: Mapping[str, tuple[str, ...]],
) -> dict[str, Any]:
    symbol = str(instrument["symbol"])
    mapping = map_eod_rows(
        [row],
        source_id=source_id,
        market=market,
        trading_date=trading_date,
        field_names=field_names,
    )
    if not mapping["datasets"]:
        raise DataUpdateError(f"{market} row failed OHLCV admission for {symbol} on {trading_date}")
    display_name = str(instrument.get("display_name") or "").strip()
    if not display_name or display_name in {symbol, "尚未下載"}:
        for key in field_names["display_name"]:
            candidate = str(row.get(key) or "").strip()
            if candidate:
                display_name = candidate
                break
    mapping["datasets"][0]["instrument"]["display_name"] = display_name or symbol
    source_metadata = {
        "source_id": source_id,
        "endpoint": source["url"],
        "terms_url": terms_url,
        "license_ref": TAIWAN_DATA_LICENSE,
        "attribution": attribution,
        "retrieved_at": retrieved_at,
        "http_status": source["http_status"],
        "content_type": source["content_type"],
        "response_bytes": source["response_bytes"],
        "content_digest": source["content_digest"],
        "symbol": symbol,
        "trading_date": trading_date,
    }
    if source.get("month"):
        source_metadata["month"] = source["month"]
    snapshot = build_snapshot(
        source_metadata=source_metadata,
        mapping=mapping,
    )
    snapshot["kline_fixture"]["provenance"] = {
        "source": "official-user-download",
        "fixture_id": f"download-{source_id}-{symbol}-{trading_date}",
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
    instrument_id = str(instrument.get("instrument_id") or "").strip()
    market = str(instrument.get("market") or "").strip().upper()
    symbol = str(instrument.get("symbol") or "").strip()
    if market != "TWSE" or not re.fullmatch(r"[1-9][0-9]{3}", symbol):
        if market == "TPEX":
            raise DataUpdateError("TPEx 歷史資料請由 watchlist 更新路徑分流至 TPEx dailyQuotes")
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
                    source_id="twse_stock_day",
                    market="TWSE",
                    terms_url=TWSE_TERMS_URL,
                    attribution=TWSE_ATTRIBUTION,
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
    status = "success" if not errors else ("partial" if downloaded_bars else "error")
    record["status"] = status
    manifest["last_update"] = record
    downloads = [item for item in manifest.get("downloads", []) if not (
        isinstance(item, Mapping) and item.get("instrument_id") == instrument_id
    )]
    downloads.append(record)
    manifest["downloads"] = downloads[-100:]
    _write_json(_manifest_path(data_root), manifest)
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


TPEX_FIELD_NAMES: dict[str, tuple[str, ...]] = {
    "security_id": ("Code", "SecuritiesCompanyCode"),
    "trading_date": ("Date",),
    "open": ("Open",),
    "high": ("High",),
    "low": ("Low",),
    "close": ("Close",),
    "volume": ("Trading Shares",),
    "display_name": ("display_name", "Name"),
}


def _write_tpex_selected_raw(
    data_root: Path,
    instrument: Mapping[str, Any],
    trading_date: str,
    row: Mapping[str, Any],
    source: Mapping[str, Any],
    retrieved_at: str,
) -> None:
    """Persist only the requested TPEx row and full-response provenance.

    TPEx dailyQuotes is a full-market response. Keeping the selected row avoids
    copying unrelated market data into a user's local application directory;
    the response digest/size remains bound to every normalized snapshot.
    """
    fields = [str(field) for field in source["fields"]]
    selected_payload = {
        "stat": source["payload"].get("stat"),
        "date": source["payload"].get("date"),
        "fields": fields,
        "data": [[row.get(field) for field in fields]],
    }
    symbol = str(instrument["symbol"])
    instrument_id = str(instrument["instrument_id"])
    _write_json(data_root / "raw" / "tpex" / symbol / f"{trading_date}.json", {
        "schema": "tw-quant-engine-raw-official-response/v1",
        "source_id": "tpex_daily_quotes",
        "instrument_id": instrument_id,
        "retrieved_at": retrieved_at,
        "request_date": trading_date,
        "request_url": source["url"],
        "http_status": source["http_status"],
        "content_type": source["content_type"],
        "response_bytes": source["response_bytes"],
        "content_digest": source["content_digest"],
        "capture_scope": "selected_instrument_row_from_full_market_response",
        "payload": selected_payload,
    })


def update_tpex_history(
    data_dir: str | Path,
    instrument: Mapping[str, Any],
    years: int,
    *,
    today: date | None = None,
    fetcher: Fetcher | None = None,
    source_cache: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Download one selected TPEx equity for one to three trailing years.

    TPEx exposes the required share-count volume on a date-scoped full-market
    endpoint. Requests are limited to weekdays in the selected month window;
    a caller-owned cache lets one watchlist run reuse each daily response for
    every selected TPEx instrument.
    """
    instrument_id = str(instrument.get("instrument_id") or "").strip()
    market = str(instrument.get("market") or "").strip().upper()
    symbol = str(instrument.get("symbol") or "").strip().upper()
    if market != "TPEX" or not re.fullmatch(r"[0-9A-Z]{4,6}", symbol):
        raise DataUpdateError("目前本機更新支援 TPEx 四至六碼個股代號")
    if instrument_id != f"TPEx:{symbol}":
        raise DataUpdateError("instrument identity mismatch")
    data_root = Path(data_dir).expanduser().resolve()
    data_root.mkdir(parents=True, exist_ok=True)
    current_day = today or date.today()
    requested_years = int(years)
    months = _month_range(current_day, requested_years)
    session_dates = _weekday_range(current_day, requested_years)
    request_fetcher = fetcher or _default_fetcher
    cache = source_cache if source_cache is not None else {}
    retrieved_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    failed_dates: set[str] = set()
    no_data_dates: list[str] = []
    sessions_with_data = 0
    downloaded_bars = 0
    errors: list[dict[str, str]] = []

    for trading_date in session_dates:
        try:
            source = cache.get(trading_date)
            if source is None:
                source = _fetch_tpex_day(trading_date, request_fetcher)
                cache[trading_date] = source
            row = source["rows_by_symbol"].get(symbol)
            if row is None:
                no_data_dates.append(trading_date)
                continue
            _write_tpex_selected_raw(data_root, instrument, trading_date, row, source, retrieved_at)
            snapshot = _build_day_snapshot(
                instrument=instrument,
                trading_date=trading_date,
                row=row,
                source=source,
                retrieved_at=retrieved_at,
                source_id="tpex_daily_quotes",
                market="TPEx",
                terms_url=TPEX_TERMS_URL,
                attribution=TPEX_ATTRIBUTION,
                field_names=TPEX_FIELD_NAMES,
            )
            snapshot_path = data_root / "k6a" / f"tpex_daily_quotes-{symbol}-{trading_date}.json.gz"
            _write_snapshot(snapshot_path, snapshot)
            sessions_with_data += 1
            downloaded_bars += 1
        except (DataUpdateError, OSError, ValueError, TypeError) as exc:
            failed_dates.add(trading_date)
            errors.append({"date": trading_date, "error": str(exc)})

    downloaded_months = [
        month for month in months
        if all(trading_date not in failed_dates for trading_date in session_dates if trading_date.startswith(month))
    ]
    manifest = read_manifest(data_root)
    record = {
        "instrument_id": instrument_id,
        "symbol": symbol,
        "market": "TPEx",
        "years": requested_years,
        "months_requested": months,
        "months_downloaded": downloaded_months,
        "sessions_requested": len(session_dates),
        "sessions_with_data": sessions_with_data,
        "no_data_dates": no_data_dates,
        "bars_downloaded": downloaded_bars,
        "errors": errors,
        "updated_at": retrieved_at,
        "source_id": "tpex_daily_quotes",
        "terms_url": TPEX_TERMS_URL,
        "license_ref": TAIWAN_DATA_LICENSE,
    }
    status = "success" if not errors else ("partial" if downloaded_bars else "error")
    record["status"] = status
    manifest["last_update"] = record
    downloads = [item for item in manifest.get("downloads", []) if not (
        isinstance(item, Mapping) and item.get("instrument_id") == instrument_id
    )]
    downloads.append(record)
    manifest["downloads"] = downloads[-100:]
    _write_json(_manifest_path(data_root), manifest)
    return {
        "status": status,
        "instrument_id": instrument_id,
        "years": requested_years,
        "months_requested": len(months),
        "months_downloaded": len(downloaded_months),
        "sessions_requested": len(session_dates),
        "sessions_with_data": sessions_with_data,
        "no_data_sessions": len(no_data_dates),
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
    """Update only the caller-provided TWSE/TPEx watchlist.

    The caller must provide the explicit watchlist identities; this function
    never discovers or downloads the full market universe. Unsupported
    instruments remain visible as per-instrument results instead of aborting
    the other selected stocks. TPEx daily responses are shared within this
    invocation so each requested date is fetched once per watchlist.
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
    manifest = read_manifest(data_dir)
    required_months = set(_month_range(current_day, requested_years))
    tpex_source_cache: dict[str, dict[str, Any]] = {}

    def existing_result(instrument: Mapping[str, Any]) -> dict[str, Any] | None:
        instrument_id = str(instrument.get("instrument_id") or "").strip()
        records = [
            item for item in manifest.get("downloads", [])
            if isinstance(item, Mapping) and str(item.get("instrument_id") or "").strip() == instrument_id
        ]
        if not records:
            return None
        record = records[-1]
        downloaded_months = {str(month) for month in record.get("months_downloaded", []) if month}
        if (
            str(record.get("status") or "success") == "success"
            and int(record.get("years") or 0) >= requested_years
            and required_months.issubset(downloaded_months)
        ):
            return {
                "status": "pass",
                "instrument_id": instrument_id,
                "symbol": str(instrument.get("symbol") or ""),
                "market": str(instrument.get("market") or ""),
                "years": requested_years,
                "months_requested": len(required_months),
                "months_downloaded": len(downloaded_months),
                "bars_downloaded": 0,
                "errors": [],
                "message": "已有符合範圍的本機資料",
            }
        return None

    for instrument in selected:
        instrument_id = str(instrument.get("instrument_id") or "")
        cached = existing_result(instrument)
        if cached is not None:
            cached["display_name"] = str(instrument.get("display_name") or cached.get("symbol") or instrument_id)
            results.append(cached)
            continue
        try:
            market = str(instrument.get("market") or "").strip().upper()
            if market == "TPEX":
                result = update_tpex_history(
                    data_dir,
                    instrument,
                    requested_years,
                    today=current_day,
                    fetcher=fetcher,
                    source_cache=tpex_source_cache,
                )
            else:
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
            market_upper = market.strip().upper()
            valid_symbol = (
                re.fullmatch(r"[1-9][0-9]{3}", symbol.strip())
                if market_upper == "TWSE"
                else re.fullmatch(r"[0-9A-Z]{4,6}", symbol.strip().upper())
                if market_upper == "TPEX"
                else None
            )
            unsupported = market_upper not in {"TWSE", "TPEX"} or valid_symbol is None
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
                "message": str(exc),
            }
        result["display_name"] = str(instrument.get("display_name") or result.get("symbol") or instrument_id)
        results.append(result)

    updated = [result for result in results if result["status"] in {"success", "partial"}]
    passed = [result for result in results if result["status"] == "pass"]
    ready = updated + passed
    status = "success" if len(ready) == len(results) else "partial" if ready else "error"
    return {
        "scope": "watchlist",
        "status": status,
        "years": requested_years,
        "requested_count": len(results),
        "updated_count": len(updated),
        "passed_count": len(passed),
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
