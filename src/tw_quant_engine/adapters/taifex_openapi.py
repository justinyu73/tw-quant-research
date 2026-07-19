"""TAIFEX OAS adapter for the bounded K6b TX daily-session slice."""
from __future__ import annotations

from typing import Any

from tw_quant_engine.k6b_snapshot import map_taifex_rows
from tw_quant_engine.source_registry import PublicResponse, decode_json, extract_rows, fetch_public, pick, source_metadata


def fetch_taifex_daily(source_id: str) -> tuple[PublicResponse, list[dict[str, Any]]]:
    if source_id != "taifex_daily_fut":
        raise ValueError(f"not a TAIFEX K6b source: {source_id}")
    response = fetch_public(source_id)
    return response, extract_rows(decode_json(response))


def taifex_mapping(source_id: str, row: dict[str, Any]) -> dict[str, Any]:
    """Expose a bounded sample mapping without substituting retrieval time."""
    if source_id != "taifex_daily_fut":
        raise ValueError(f"not a TAIFEX K6b source: {source_id}")
    mapped = {
        "trading_date": pick(row, "Date", "日期"),
        "contract": pick(row, "Contract", "契約"),
        "contract_month": pick(row, "ContractMonth(Week)", "到期月份(週別)", "到期月份"),
        "open": pick(row, "Open", "開盤價"),
        "high": pick(row, "High", "最高價"),
        "low": pick(row, "Low", "最低價"),
        "close": pick(row, "Last", "最後成交價"),
        "volume": pick(row, "Volume", "合計成交量"),
        "settlement": pick(row, "SettlementPrice", "結算價"),
        "session": pick(row, "TradingSession", "交易時段"),
    }
    return {
        "status": "unadmitted",
        "reason": "available_at is declared by K6b calendar policy; retrieval_at cannot substitute",
        "candidate_record_type": "futures_price_bar",
        "candidate_fields": mapped,
    }


def map_taifex_daily_rows(
    rows: list[dict[str, Any]],
    trading_date: str,
    contract_month: str,
) -> dict[str, Any]:
    return map_taifex_rows(rows, trading_date=trading_date, contract_month=contract_month)


__all__ = ["fetch_taifex_daily", "map_taifex_daily_rows", "taifex_mapping"]
