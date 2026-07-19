"""TPEx OpenAPI adapters for S3 probes and K6a full-day EOD ingestion."""
from __future__ import annotations

from typing import Any

from tw_quant_engine.k6a_snapshot import map_eod_rows, roc_trading_date
from tw_quant_engine.source_registry import PublicResponse, decode_json, extract_rows, fetch_public, pick, source_metadata


def fetch_tpex_sample(source_id: str, *, trading_date: str | None = None) -> dict[str, Any]:
    if source_id not in {"tpex_daily_close", "tpex_monthly_revenue"}:
        raise ValueError(f"not a TPEx source: {source_id}")
    query = {"d": roc_trading_date(trading_date)} if source_id == "tpex_daily_close" and trading_date else None
    response = fetch_public(source_id, query=query)
    payload = decode_json(response)
    rows = extract_rows(payload)
    row = rows[0] if rows else None
    return {
        "metadata": source_metadata(source_id, response),
        "row_count": len(rows),
        "sample_row": row,
        "sample_keys": sorted(row) if row else [],
        "mapping": tpex_mapping(source_id, row) if row else {"status": "unadmitted", "reason": "empty response"},
    }


def tpex_mapping(source_id: str, row: dict[str, Any]) -> dict[str, Any]:
    if source_id == "tpex_daily_close":
        mapped = {
            "security_id": pick(row, "SecuritiesCompanyCode", "證券代號", "Code", "股票代號"),
            "trading_date": pick(row, "Date", "日期", "交易日期"),
            "open": pick(row, "Open", "開盤價", "OpeningPrice"),
            "high": pick(row, "High", "最高價", "HighestPrice"),
            "low": pick(row, "Low", "最低價", "LowestPrice"),
            "close": pick(row, "Close", "收盤價", "ClosingPrice"),
            "volume": pick(row, "TradeVolume", "成交股數", "Volume", "成交量"),
        }
        metric = "price_bar"
    else:
        mapped = {
            "security_id": pick(row, "公司代號", "公司代碼", "SecuritiesCompanyCode", "Code"),
            "period_end": pick(row, "資料年月", "資料日期", "Date"),
            "metric": "monthly_revenue",
            "value": pick(row, "當月營收", "當月營業收入", "Revenue"),
            "unit": "TWD",
        }
        metric = "fundamental_observation"
    availability = pick(row, "available_at", "published_at", "publication_time", "發布時間", "發佈時間")
    if not isinstance(availability, str) or "T" not in availability:
        return {
            "status": "unadmitted",
            "reason": "response has no reliable publication timestamp; retrieval_at cannot substitute",
            "candidate_record_type": metric,
            "candidate_fields": mapped,
        }
    return {"status": "candidate", "candidate_record_type": metric, "candidate_fields": mapped, "available_at": availability}


def fetch_tpex_daily(source_id: str, trading_date: str) -> tuple[PublicResponse, list[dict[str, Any]]]:
    if source_id != "tpex_daily_close":
        raise ValueError(f"not a TPEx K6a source: {source_id}")
    response = fetch_public(source_id, query={"d": roc_trading_date(trading_date)})
    return response, extract_rows(decode_json(response))


def map_tpex_daily_rows(rows: list[dict[str, Any]], trading_date: str) -> dict[str, Any]:
    return map_eod_rows(
        rows,
        source_id="tpex_daily_close",
        market="TPEx",
        trading_date=trading_date,
        field_names={
            "security_id": ("SecuritiesCompanyCode", "證券代號", "Code", "股票代號"),
            "trading_date": ("Date", "日期", "交易日期"),
            "display_name": ("CompanyName", "公司名稱", "Name"),
            "open": ("Open", "開盤價", "OpeningPrice"),
            "high": ("High", "最高價", "HighestPrice"),
            "low": ("Low", "最低價", "LowestPrice"),
            "close": ("Close", "收盤價", "ClosingPrice"),
            "volume": ("TradingShares", "TradeVolume", "成交股數", "Volume", "成交量"),
        },
    )


__all__ = ["fetch_tpex_daily", "fetch_tpex_sample", "map_tpex_daily_rows", "tpex_mapping"]
