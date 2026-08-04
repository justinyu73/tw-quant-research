"""Offline tests for the explicit desktop fundamentals update boundary."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.fundamentals import BALANCE_SHEET, INCOME_STATEMENT, MONTHLY_REVENUE, TPEX, TWSE, empty_series  # noqa: E402
from tw_quant_engine.fundamentals_update import (  # noqa: E402
    FUNDAMENTALS_ENDPOINTS,
    FundamentalsUpdateError,
    update_fundamentals_scope,
)


REPLAY = json.loads((ROOT / "tests/fixtures/tqr-fundamentals/replay.json").read_text(encoding="utf-8"))


def _watchlist(*symbols: str) -> list[dict[str, str]]:
    return [
        {"instrument_id": f"TWSE:{symbol}", "symbol": symbol, "market": "TWSE", "display_name": symbol}
        for symbol in symbols
    ]


class FundamentalsUpdateTests(unittest.TestCase):
    def _fetcher(self, *, tpex: bool = False):
        if tpex:
            payloads = {
                FUNDAMENTALS_ENDPOINTS[(TPEX, MONTHLY_REVENUE)]: REPLAY["tpex_monthly_revenue_capture_1"],
                FUNDAMENTALS_ENDPOINTS[(TPEX, INCOME_STATEMENT)]: REPLAY["tpex_income_statement_capture_1"],
                FUNDAMENTALS_ENDPOINTS[(TPEX, BALANCE_SHEET)]: REPLAY["tpex_balance_sheet_capture_1"],
            }
        else:
            payloads = {
                FUNDAMENTALS_ENDPOINTS[(TWSE, MONTHLY_REVENUE)]: REPLAY["monthly_revenue_capture_1"],
                FUNDAMENTALS_ENDPOINTS[(TWSE, INCOME_STATEMENT)]: REPLAY["income_statement_capture_1"],
                FUNDAMENTALS_ENDPOINTS[(TWSE, BALANCE_SHEET)]: REPLAY["balance_sheet_capture_1"],
            }

        def fetch(url: str):
            return payloads[url]

        return fetch

    def test_selected_twse_scope_filters_full_market_rows_and_writes_all_families(self) -> None:
        with TemporaryDirectory(prefix="tqr-fundamentals-update-") as directory:
            result = update_fundamentals_scope(directory, _watchlist("2330"), fetcher=self._fetcher())
            self.assertEqual(result["status"], "success")
            self.assertEqual(result["requested_count"], 1)
            self.assertEqual(result["updated_count"], 1)
            self.assertEqual(result["observations_added"], 3)
            self.assertEqual(result["results"][0]["status"], "success")
            self.assertEqual(set(result["captures"]), {"TWSE/monthly_revenue", "TWSE/income_statement", "TWSE/balance_sheet"})
            payload = json.loads((Path(directory) / "fundamentals-series.json").read_text(encoding="utf-8"))
            self.assertEqual({item["security_id"] for item in payload["observations"]}, {"2330"})

    def test_watchlist_scope_keeps_requested_companies_separate(self) -> None:
        with TemporaryDirectory(prefix="tqr-fundamentals-update-") as directory:
            result = update_fundamentals_scope(directory, _watchlist("1101", "2330"), fetcher=self._fetcher())
            self.assertEqual([item["status"] for item in result["results"]], ["success", "success"])
            payload = json.loads((Path(directory) / "fundamentals-series.json").read_text(encoding="utf-8"))
            self.assertEqual({item["security_id"] for item in payload["observations"]}, {"1101", "2330"})

    def test_tpex_scope_uses_only_tpex_endpoints_and_preserves_market_provenance(self) -> None:
        instrument = {"instrument_id": "TPEx:1240", "symbol": "1240", "market": "TPEx", "display_name": "茂生農經"}
        with TemporaryDirectory(prefix="tqr-fundamentals-update-") as directory:
            result = update_fundamentals_scope(directory, [instrument], fetcher=self._fetcher(tpex=True))
            self.assertEqual(result["results"][0]["status"], "success")
            payload = json.loads((Path(directory) / "fundamentals-series.json").read_text(encoding="utf-8"))
            self.assertEqual({item["provenance"]["market"] for item in payload["observations"]}, {TPEX})

    def test_unsupported_instrument_is_reported_without_fetching(self) -> None:
        calls = []

        def fetch(url: str):
            calls.append(url)
            return []

        with TemporaryDirectory(prefix="tqr-fundamentals-update-") as directory:
            result = update_fundamentals_scope(
                directory,
                [{"instrument_id": "TAIFEX:TX:202608", "symbol": "TX", "market": "TAIFEX", "display_name": "台指期"}],
                fetcher=fetch,
            )
            self.assertEqual(result["status"], "partial")
            self.assertEqual(result["results"][0]["status"], "unsupported")
            self.assertEqual(calls, [])

    def test_missing_requested_company_is_unavailable_and_top_level_is_partial(self) -> None:
        with TemporaryDirectory(prefix="tqr-fundamentals-update-") as directory:
            result = update_fundamentals_scope(directory, _watchlist("9999"), fetcher=self._fetcher())
            self.assertEqual(result["status"], "partial")
            self.assertEqual(result["updated_count"], 0)
            self.assertEqual(result["unavailable_count"], 1)
            self.assertEqual(result["results"][0]["status"], "unavailable")

    def test_source_failure_does_not_replace_existing_series(self) -> None:
        with TemporaryDirectory(prefix="tqr-fundamentals-update-") as directory:
            path = Path(directory) / "fundamentals-series.json"
            path.write_text(json.dumps(empty_series(), ensure_ascii=False), encoding="utf-8")

            calls = 0

            def failing_fetch(url: str):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise FundamentalsUpdateError("source unavailable")
                return REPLAY["monthly_revenue_capture_1"]

            before = path.read_text(encoding="utf-8")
            with self.assertRaises(FundamentalsUpdateError):
                update_fundamentals_scope(directory, _watchlist("2330"), fetcher=failing_fetch)
            self.assertEqual(path.read_text(encoding="utf-8"), before)


if __name__ == "__main__":
    unittest.main()
