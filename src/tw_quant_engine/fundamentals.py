"""TWSE fundamentals normalization and append-only period accumulation.

Encodes the measured findings of TQR-FUNDAMENTALS-SOURCE-001
(docs/tqr-fundamentals-source-contract.md):

- every free endpoint returns a single period, so the local series grows by
  forward accumulation, one human-run capture per publication cycle;
- 出表日期 is the exchange's batch export date, not a company filing time: it is
  admissible as a conservative ``available_at`` and never as ``published_at``;
- that export date moves on every run, so period identity and dedupe key on
  (security_id, period) plus the financial values, never on a response digest;
- missing inputs stay ``None``. Nothing is padded, interpolated, carried forward
  from an adjacent period, or estimated from price.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Iterable, Mapping, Sequence

OBSERVATION_SCHEMA = "tqr-fundamental-observation/v1"
SERIES_SCHEMA = "tqr-fundamental-series/v1"
NORMALIZATION_VERSION = "tqr-fundamentals/v1"
SOURCE_ID = "twse_openapi"
MARKET = "TWSE"
LICENSE_REF = "https://data.gov.tw/license"
ATTRIBUTION = "資料來源：臺灣證券交易所"

MONTHLY_REVENUE = "monthly_revenue"
INCOME_STATEMENT = "income_statement"
BALANCE_SHEET = "balance_sheet"
FAMILIES = (MONTHLY_REVENUE, INCOME_STATEMENT, BALANCE_SHEET)

_SECURITY_ID = re.compile(r"^[0-9A-Z]{4,6}$")
_ROC_YM = re.compile(r"^(\d{3})(\d{2})$")
_ROC_DATE = re.compile(r"^(\d{3})(\d{2})(\d{2})$")


class FundamentalsError(ValueError):
    """Raised when a source row or series payload fails fail-closed validation."""


def _digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def roc_month_to_iso(value: Any) -> str:
    """`11506` -> `2026-06`. Rejects anything else rather than guessing."""
    match = _ROC_YM.match(str(value or "").strip())
    if not match:
        raise FundamentalsError(f"period must be a ROC yyyMM string, got {value!r}")
    year, month = int(match.group(1)) + 1911, int(match.group(2))
    if not 1 <= month <= 12:
        raise FundamentalsError(f"month out of range in {value!r}")
    return f"{year:04d}-{month:02d}"


def roc_date_to_iso(value: Any) -> str:
    """`1150728` -> `2026-07-28`."""
    match = _ROC_DATE.match(str(value or "").strip())
    if not match:
        raise FundamentalsError(f"date must be a ROC yyyMMdd string, got {value!r}")
    year, month, day = int(match.group(1)) + 1911, int(match.group(2)), int(match.group(3))
    if not 1 <= month <= 12 or not 1 <= day <= 31:
        raise FundamentalsError(f"date out of range in {value!r}")
    return f"{year:04d}-{month:02d}-{day:02d}"


def quarter_period(year: Any, quarter: Any) -> str:
    """`115`, `1` -> `2026Q1`."""
    try:
        roc_year = int(str(year).strip())
        quarter_number = int(str(quarter).strip())
    except (TypeError, ValueError) as error:
        raise FundamentalsError(f"year/quarter must be integers, got {year!r}/{quarter!r}") from error
    if not 1 <= quarter_number <= 4:
        raise FundamentalsError(f"quarter must be 1-4, got {quarter!r}")
    return f"{roc_year + 1911:04d}Q{quarter_number}"


def _number(row: Mapping[str, Any], key: str) -> float | None:
    """Absent or non-numeric stays None. A missing datum is never a zero."""
    raw = row.get(key)
    if raw is None:
        return None
    text = str(raw).strip().replace(",", "")
    if not text or text in {"-", "--", "NA", "N/A"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _security_id(row: Mapping[str, Any]) -> str:
    value = str(row.get("公司代號", "")).strip()
    if not _SECURITY_ID.match(value):
        raise FundamentalsError(f"公司代號 must be 4-6 alphanumeric chars, got {value!r}")
    return value


def _ratio(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator is None or denominator == 0:
        return None
    return numerator / denominator


def normalize_monthly_revenue_row(row: Mapping[str, Any]) -> dict[str, Any]:
    """One t187ap05_L row -> one observation. YoY is only derived when the source
    itself supplies last year's same-month figure; it is never inferred."""
    if not isinstance(row, Mapping):
        raise FundamentalsError("row must be an object")
    current = _number(row, "營業收入-當月營收")
    previous = _number(row, "營業收入-上月營收")
    last_year = _number(row, "營業收入-去年當月營收")
    cumulative = _number(row, "累計營業收入-當月累計營收")
    cumulative_last_year = _number(row, "累計營業收入-去年累計營收")
    return {
        "schema": OBSERVATION_SCHEMA,
        "family": MONTHLY_REVENUE,
        "security_id": _security_id(row),
        "display_name": str(row.get("公司名稱", "")).strip() or None,
        "industry": str(row.get("產業別", "")).strip() or None,
        "period": roc_month_to_iso(row.get("資料年月")),
        "values": {
            "monthly_revenue": current,
            "monthly_revenue_previous_month": previous,
            "monthly_revenue_last_year": last_year,
            "cumulative_revenue": cumulative,
            "cumulative_revenue_last_year": cumulative_last_year,
            # Recomputed from the raw figures rather than trusting the source's
            # own percentage column, so the ratio convention is ours and auditable.
            "revenue_mom": _ratio(current - previous, previous) if current is not None and previous is not None else None,
            "revenue_yoy": _ratio(current - last_year, last_year) if current is not None and last_year is not None else None,
            "cumulative_yoy": _ratio(cumulative - cumulative_last_year, cumulative_last_year)
            if cumulative is not None and cumulative_last_year is not None else None,
        },
        "provenance": _provenance(row, "/v1/opendata/t187ap05_L"),
    }


def normalize_income_statement_row(row: Mapping[str, Any]) -> dict[str, Any]:
    """One t187ap06_L_ci row -> one observation with the three margins and EPS."""
    if not isinstance(row, Mapping):
        raise FundamentalsError("row must be an object")
    revenue = _number(row, "營業收入")
    gross = _number(row, "營業毛利（毛損）")
    operating = _number(row, "營業利益（損失）")
    net = _number(row, "本期淨利（淨損）")
    return {
        "schema": OBSERVATION_SCHEMA,
        "family": INCOME_STATEMENT,
        "security_id": _security_id(row),
        "display_name": str(row.get("公司名稱", "")).strip() or None,
        "period": quarter_period(row.get("年度"), row.get("季別")),
        "values": {
            "revenue": revenue,
            "gross_profit": gross,
            "operating_income": operating,
            "net_income": net,
            "eps": _number(row, "基本每股盈餘（元）"),
            "gross_margin": _ratio(gross, revenue),
            "operating_margin": _ratio(operating, revenue),
            "net_margin": _ratio(net, revenue),
        },
        "provenance": _provenance(row, "/v1/opendata/t187ap06_L_ci"),
    }


def normalize_balance_sheet_row(row: Mapping[str, Any]) -> dict[str, Any]:
    """One t187ap07_L_ci row -> one observation with leverage and liquidity."""
    if not isinstance(row, Mapping):
        raise FundamentalsError("row must be an object")
    assets = _number(row, "資產總額")
    liabilities = _number(row, "負債總額")
    equity = _number(row, "權益總額")
    current_assets = _number(row, "流動資產")
    current_liabilities = _number(row, "流動負債")
    return {
        "schema": OBSERVATION_SCHEMA,
        "family": BALANCE_SHEET,
        "security_id": _security_id(row),
        "display_name": str(row.get("公司名稱", "")).strip() or None,
        "period": quarter_period(row.get("年度"), row.get("季別")),
        "values": {
            "assets": assets,
            "liabilities": liabilities,
            "equity": equity,
            "current_assets": current_assets,
            "current_liabilities": current_liabilities,
            "bvps": _number(row, "每股參考淨值"),
            "debt_ratio": _ratio(liabilities, assets),
            "current_ratio": _ratio(current_assets, current_liabilities),
        },
        "provenance": _provenance(row, "/v1/opendata/t187ap07_L_ci"),
    }


def _provenance(row: Mapping[str, Any], endpoint: str) -> dict[str, Any]:
    export_date = roc_date_to_iso(row.get("出表日期"))
    return {
        "source_id": SOURCE_ID,
        "market": MARKET,
        "endpoint": endpoint,
        "license_ref": LICENSE_REF,
        "attribution": ATTRIBUTION,
        # 出表日期 is the exchange's batch export date. It is later than the real
        # filing date, so it is a conservative available_at; published_at stays
        # null until a per-company filing timestamp source is admitted.
        "available_at": export_date,
        "available_at_basis": "exchange_batch_export_date",
        "published_at": None,
        "normalization_version": NORMALIZATION_VERSION,
    }


def normalize_rows(rows: Sequence[Mapping[str, Any]], family: str) -> list[dict[str, Any]]:
    """Normalize a full-market response. Rows that fail validation are dropped
    rather than partially admitted, and the caller sees the count difference."""
    if family not in FAMILIES:
        raise FundamentalsError(f"unknown family {family!r}")
    normalizer = {
        MONTHLY_REVENUE: normalize_monthly_revenue_row,
        INCOME_STATEMENT: normalize_income_statement_row,
        BALANCE_SHEET: normalize_balance_sheet_row,
    }[family]
    out = []
    for row in rows or []:
        try:
            out.append(normalizer(row))
        except FundamentalsError:
            continue
    return out


def observation_key(observation: Mapping[str, Any]) -> tuple[str, str, str]:
    return (observation["family"], observation["security_id"], observation["period"])


def observation_value_digest(observation: Mapping[str, Any]) -> str:
    """Identity of the *data*, deliberately excluding provenance: the batch export
    date changes on every capture even when nothing was restated."""
    return _digest(observation["values"])


def empty_series() -> dict[str, Any]:
    return {"schema": SERIES_SCHEMA, "version": 1, "observations": []}


def merge_observations(
    series: Mapping[str, Any] | None,
    observations: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    """Append-only accumulation keyed on (family, security_id, period).

    A repeat capture of an unchanged period is a no-op even though its export
    date advanced. A genuine restatement replaces the values and records the
    supersession instead of silently overwriting history.
    """
    current = series if isinstance(series, Mapping) else empty_series()
    if current.get("schema") != SERIES_SCHEMA:
        raise FundamentalsError(f"series schema must be {SERIES_SCHEMA}")
    existing = {observation_key(item): dict(item) for item in current.get("observations", [])}
    added = 0
    restated = 0
    unchanged = 0
    for observation in observations:
        key = observation_key(observation)
        previous = existing.get(key)
        if previous is None:
            existing[key] = dict(observation)
            added += 1
            continue
        if observation_value_digest(previous) == observation_value_digest(observation):
            unchanged += 1
            continue
        replacement = dict(observation)
        replacement["supersedes"] = {
            "values": previous["values"],
            "available_at": previous["provenance"]["available_at"],
        }
        existing[key] = replacement
        restated += 1
    ordered = sorted(existing.values(), key=lambda item: observation_key(item))
    return {
        "schema": SERIES_SCHEMA,
        "version": 1,
        "observations": ordered,
        "last_merge": {"added": added, "restated": restated, "unchanged": unchanged},
    }


def series_for(series: Mapping[str, Any] | None, security_id: str, family: str, limit: int) -> list[dict[str, Any]]:
    """Most recent ``limit`` periods, newest first. Returns only what was actually
    captured; gaps stay gaps."""
    observations = (series or {}).get("observations", []) if isinstance(series, Mapping) else []
    selected = [
        item for item in observations
        if item.get("security_id") == security_id and item.get("family") == family
    ]
    selected.sort(key=lambda item: item.get("period", ""), reverse=True)
    return selected[: max(0, limit)]


def coverage(series: Mapping[str, Any] | None, security_id: str, family: str, expected: int) -> dict[str, Any]:
    """Honest depth report: `n of expected`, never padded to look complete."""
    captured = len(series_for(series, security_id, family, expected))
    return {
        "captured": captured,
        "expected": expected,
        "complete": captured >= expected,
        "label": f"{captured} / {expected}",
        "accumulation": "forward_only",
    }


__all__ = [
    "ATTRIBUTION",
    "FAMILIES",
    "BALANCE_SHEET",
    "INCOME_STATEMENT",
    "LICENSE_REF",
    "MONTHLY_REVENUE",
    "NORMALIZATION_VERSION",
    "OBSERVATION_SCHEMA",
    "SERIES_SCHEMA",
    "FundamentalsError",
    "coverage",
    "empty_series",
    "merge_observations",
    "normalize_balance_sheet_row",
    "normalize_income_statement_row",
    "normalize_monthly_revenue_row",
    "normalize_rows",
    "observation_key",
    "observation_value_digest",
    "quarter_period",
    "roc_date_to_iso",
    "roc_month_to_iso",
    "series_for",
]
