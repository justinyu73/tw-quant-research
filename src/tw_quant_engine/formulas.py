"""Deterministic, guarded product formulas for S4."""
from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any


FORMULA_VERSION = "s4-v1"


@dataclass(frozen=True)
class FormulaResult:
    value: float | None
    reason: str | None = None

    @property
    def status(self) -> str:
        return "ok" if self.reason is None else "unadmitted"


def _decimal(value: Any) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def daily_return_1d(current_close: Any, previous_close: Any, *, both_admitted: bool) -> FormulaResult:
    if not both_admitted:
        return FormulaResult(None, "unadmitted_input")
    current = _decimal(current_close)
    previous = _decimal(previous_close)
    if current is None or previous is None:
        return FormulaResult(None, "missing_or_invalid_close")
    if previous == 0:
        return FormulaResult(None, "missing_or_zero_prior_close")
    return FormulaResult(float(current / previous - Decimal("1")))


def revenue_mom(current: Any, previous_calendar_month: Any) -> FormulaResult:
    current_value = _decimal(current)
    previous_value = _decimal(previous_calendar_month)
    if current_value is None or previous_value is None:
        return FormulaResult(None, "missing_or_invalid_revenue")
    if previous_value == 0:
        return FormulaResult(None, "missing_or_zero_previous_revenue")
    return FormulaResult(float(current_value / previous_value - Decimal("1")))


def revenue_yoy(current: Any, same_month_previous_year: Any) -> FormulaResult:
    current_value = _decimal(current)
    previous_value = _decimal(same_month_previous_year)
    if current_value is None or previous_value is None:
        return FormulaResult(None, "missing_or_invalid_revenue")
    if previous_value == 0:
        return FormulaResult(None, "missing_or_zero_previous_year_revenue")
    return FormulaResult(float(current_value / previous_value - Decimal("1")))


def previous_calendar_month(period_end: date) -> date:
    year, month = period_end.year, period_end.month
    if month == 1:
        year, month = year - 1, 12
    else:
        month -= 1
    return date(year, month, calendar.monthrange(year, month)[1])


def same_month_previous_year(period_end: date) -> date:
    year = period_end.year - 1
    return date(year, period_end.month, calendar.monthrange(year, period_end.month)[1])


__all__ = [
    "FORMULA_VERSION",
    "FormulaResult",
    "daily_return_1d",
    "revenue_mom",
    "revenue_yoy",
    "previous_calendar_month",
    "same_month_previous_year",
]
