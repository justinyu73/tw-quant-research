"""Offline tests for TWSE/TPEx fundamentals normalization and forward accumulation.

No network, no wall clock. Every assertion replays a committed fixture whose
shape came from a recorded live probe (TQR-FUNDAMENTALS-SOURCE-001).
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.fundamentals import (  # noqa: E402
    BALANCE_SHEET,
    INCOME_STATEMENT,
    MONTHLY_REVENUE,
    OBSERVATION_SCHEMA,
    TPEX,
    TWSE,
    FundamentalsError,
    FundamentalsMappingError,
    attribution_for,
    coverage,
    empty_series,
    merge_observations,
    normalize_balance_sheet_row,
    normalize_income_statement_row,
    normalize_monthly_revenue_row,
    normalize_rows,
    observation_value_digest,
    quarter_period,
    roc_date_to_iso,
    roc_month_to_iso,
    series_for,
)

FIXTURE = json.loads((ROOT / "tests/fixtures/tqr-fundamentals/replay.json").read_text(encoding="utf-8"))


class RocConversionTests(unittest.TestCase):
    def test_period_conversions(self) -> None:
        self.assertEqual(roc_month_to_iso("11506"), "2026-06")
        self.assertEqual(roc_date_to_iso("1150728"), "2026-07-28")
        self.assertEqual(quarter_period("115", "1"), "2026Q1")

    def test_conversions_reject_rather_than_guess(self) -> None:
        for bad in ("", "1150", "115063", None, "11599"):
            with self.assertRaises(FundamentalsError):
                roc_month_to_iso(bad)
        for bad in ("115072", "bad", None):
            with self.assertRaises(FundamentalsError):
                roc_date_to_iso(bad)
        with self.assertRaises(FundamentalsError):
            quarter_period("115", "9")


class NormalizationTests(unittest.TestCase):
    def test_monthly_revenue_ratios_match_the_source_percentages(self) -> None:
        row = FIXTURE["monthly_revenue_capture_2"][0]
        observation = normalize_monthly_revenue_row(row, TWSE)
        self.assertEqual(observation["schema"], OBSERVATION_SCHEMA)
        self.assertEqual(observation["security_id"], "1101")
        self.assertEqual(observation["period"], "2026-06")
        values = observation["values"]
        self.assertAlmostEqual(values["revenue_yoy"], (13382706 - 10107877) / 10107877, places=12)
        self.assertAlmostEqual(values["revenue_mom"], (13382706 - 12612013) / 12612013, places=12)
        self.assertAlmostEqual(values["cumulative_yoy"], (71467332 - 70380916) / 70380916, places=12)

    def test_income_statement_derives_the_three_margins_and_eps(self) -> None:
        observation = normalize_income_statement_row(FIXTURE["income_statement_capture_1"][0], TWSE)
        self.assertEqual(observation["period"], "2026Q1")
        values = observation["values"]
        self.assertAlmostEqual(values["gross_margin"], 6208390.0 / 33168148.0, places=12)
        self.assertAlmostEqual(values["operating_margin"], 2792191.0 / 33168148.0, places=12)
        self.assertAlmostEqual(values["net_margin"], 1204739.0 / 33168148.0, places=12)
        self.assertEqual(values["eps"], 0.10)

    def test_balance_sheet_derives_leverage_and_liquidity(self) -> None:
        observation = normalize_balance_sheet_row(FIXTURE["balance_sheet_capture_1"][0], TWSE)
        self.assertEqual(observation["family"], BALANCE_SHEET)
        self.assertEqual(observation["period"], "2026Q1")
        values = observation["values"]
        self.assertAlmostEqual(values["debt_ratio"], 292869670.0 / 597615286.0, places=12)
        self.assertAlmostEqual(values["current_ratio"], 184722314.0 / 82516661.0, places=12)
        self.assertEqual(values["bvps"], 31.39)

    def test_balance_sheet_missing_denominator_stays_none(self) -> None:
        row = dict(FIXTURE["balance_sheet_capture_1"][0])
        row["資產總額"] = "0"
        values = normalize_balance_sheet_row(row, TWSE)["values"]
        self.assertIsNone(values["debt_ratio"])

    def test_export_date_is_available_at_and_never_published_at(self) -> None:
        observation = normalize_income_statement_row(FIXTURE["income_statement_capture_1"][0], TWSE)
        provenance = observation["provenance"]
        self.assertEqual(provenance["available_at"], "2026-07-28")
        self.assertEqual(provenance["available_at_basis"], "exchange_batch_export_date")
        self.assertIsNone(provenance["published_at"])

    def test_missing_values_stay_none_and_are_never_zero(self) -> None:
        row = dict(FIXTURE["income_statement_capture_1"][0])
        row["營業毛利（毛損）"] = "-"
        values = normalize_income_statement_row(row, TWSE)["values"]
        self.assertIsNone(values["gross_profit"])
        self.assertIsNone(values["gross_margin"])

    def test_invalid_rows_are_dropped_not_partially_admitted(self) -> None:
        rows = FIXTURE["monthly_revenue_capture_1"]
        observations = normalize_rows(rows, MONTHLY_REVENUE, TWSE)
        self.assertEqual(len(rows), 3)
        self.assertEqual(len(observations), 2)
        self.assertEqual({item["security_id"] for item in observations}, {"1101", "2330"})
        self.assertEqual(normalize_rows(FIXTURE["invalid_rows"], INCOME_STATEMENT, TWSE), [])


class TpexNormalizationTests(unittest.TestCase):
    """TPEx renames columns per family, not per exchange. Every expectation here
    is read off the recorded TPEx sample rows, not off the source contract prose.
    """

    def test_monthly_revenue_reuses_the_twse_column_names_verbatim(self) -> None:
        observation = normalize_monthly_revenue_row(FIXTURE["tpex_monthly_revenue_capture_1"][0], TPEX)
        self.assertEqual(observation["security_id"], "1240")
        self.assertEqual(observation["period"], "2026-06")
        self.assertEqual(observation["display_name"], "茂生農經")
        self.assertAlmostEqual(observation["values"]["revenue_yoy"], (270176 - 217592) / 217592, places=12)

    def test_income_statement_reads_the_english_identity_columns(self) -> None:
        observation = normalize_income_statement_row(FIXTURE["tpex_income_statement_capture_1"][0], TPEX)
        self.assertEqual(observation["security_id"], "1240")
        # Year/Season here, 年度/季別 on the same exchange's balance sheet.
        self.assertEqual(observation["period"], "2026Q1")
        values = observation["values"]
        self.assertAlmostEqual(values["gross_margin"], 88237.0 / 689952.0, places=12)
        self.assertEqual(values["eps"], 0.89)

    def test_balance_sheet_totals_are_real_numbers_not_silent_nones(self) -> None:
        """The 總計/總額 split is the one that fails quietly: with the TWSE
        spelling every row still normalizes, and every total comes back None."""
        observation = normalize_balance_sheet_row(FIXTURE["tpex_balance_sheet_capture_1"][0], TPEX)
        self.assertEqual(observation["period"], "2026Q1")
        values = observation["values"]
        for field in ("assets", "liabilities", "equity", "debt_ratio", "current_ratio"):
            self.assertIsNotNone(values[field], field)
        self.assertEqual(values["assets"], 2275463.0)
        self.assertEqual(values["liabilities"], 657490.0)
        self.assertEqual(values["equity"], 1617973.0)
        self.assertAlmostEqual(values["debt_ratio"], 657490.0 / 2275463.0, places=12)
        self.assertAlmostEqual(values["current_ratio"], 1220776.0 / 610593.0, places=12)

    def test_provenance_names_the_right_exchange_and_endpoint(self) -> None:
        provenance = normalize_balance_sheet_row(FIXTURE["tpex_balance_sheet_capture_1"][0], TPEX)["provenance"]
        self.assertEqual(provenance["market"], TPEX)
        self.assertEqual(provenance["source_id"], "tpex_openapi")
        self.assertEqual(provenance["endpoint"], "/openapi/v1/mopsfin_t187ap07_O_ci")
        self.assertEqual(provenance["attribution"], "資料來源：財團法人中華民國證券櫃檯買賣中心")
        # Date, not 出表日期, and still only ever an available_at.
        self.assertEqual(provenance["available_at"], "2026-07-30")
        self.assertIsNone(provenance["published_at"])

    def test_reading_a_tpex_balance_sheet_with_the_twse_mapping_aborts(self) -> None:
        with self.assertRaises(FundamentalsMappingError):
            normalize_rows(FIXTURE["tpex_balance_sheet_capture_1"], BALANCE_SHEET, TWSE)
        with self.assertRaises(FundamentalsMappingError):
            normalize_rows(FIXTURE["balance_sheet_capture_1"], BALANCE_SHEET, TPEX)

    def test_an_empty_response_is_not_a_mapping_defect(self) -> None:
        self.assertEqual(normalize_rows([], BALANCE_SHEET, TPEX), [])

    def test_unknown_market_is_rejected(self) -> None:
        with self.assertRaises(FundamentalsError):
            normalize_rows(FIXTURE["tpex_balance_sheet_capture_1"], BALANCE_SHEET, "TWSE-ish")

    def test_attribution_follows_the_observations_not_the_first_exchange_built(self) -> None:
        twse = normalize_rows(FIXTURE["monthly_revenue_capture_2"], MONTHLY_REVENUE, TWSE)
        tpex = normalize_rows(FIXTURE["tpex_monthly_revenue_capture_1"], MONTHLY_REVENUE, TPEX)
        self.assertEqual(attribution_for(tpex), "資料來源：財團法人中華民國證券櫃檯買賣中心")
        self.assertEqual(attribution_for(twse), "資料來源：臺灣證券交易所")
        self.assertEqual(
            attribution_for(twse + tpex),
            "資料來源：臺灣證券交易所、資料來源：財團法人中華民國證券櫃檯買賣中心",
        )
        self.assertEqual(attribution_for([]), "")

    def test_same_key_from_two_markets_is_a_conflict_not_a_restatement(self) -> None:
        """A TPEx monthly row parses identically under the TWSE mapping, so the
        pair below is the real collision shape, not a synthesized one."""
        rows = FIXTURE["tpex_monthly_revenue_capture_1"]
        series = merge_observations(empty_series(), normalize_rows(rows, MONTHLY_REVENUE, TPEX))
        collided = merge_observations(series, normalize_rows(rows, MONTHLY_REVENUE, TWSE))
        self.assertEqual(collided["last_merge"]["conflicts"], [{
            "key": [MONTHLY_REVENUE, "1240", "2026-06"],
            "kept_market": TPEX,
            "rejected_market": TWSE,
        }])
        self.assertEqual(collided["last_merge"]["restated"], 0)
        kept = series_for(collided, "1240", MONTHLY_REVENUE, 1)[0]
        self.assertEqual(kept["provenance"]["market"], TPEX)
        self.assertEqual(collided["observations"], series["observations"])


class ForwardAccumulationTests(unittest.TestCase):
    def _capture(self, series, key, family):
        return merge_observations(series, normalize_rows(FIXTURE[key], family, TWSE))

    def test_periods_accumulate_forward_across_captures(self) -> None:
        series = self._capture(empty_series(), "monthly_revenue_capture_1", MONTHLY_REVENUE)
        self.assertEqual(series["last_merge"], {"added": 2, "restated": 0, "unchanged": 0, "conflicts": []})
        series = self._capture(series, "monthly_revenue_capture_2", MONTHLY_REVENUE)
        self.assertEqual(series["last_merge"], {"added": 2, "restated": 0, "unchanged": 0, "conflicts": []})
        periods = [item["period"] for item in series_for(series, "1101", MONTHLY_REVENUE, 12)]
        self.assertEqual(periods, ["2026-06", "2026-05"])

    def test_recapturing_an_unchanged_period_is_a_no_op_despite_a_new_export_date(self) -> None:
        series = self._capture(empty_series(), "monthly_revenue_capture_2", MONTHLY_REVENUE)
        before = json.dumps(series["observations"], ensure_ascii=False, sort_keys=True)
        recaptured = self._capture(series, "monthly_revenue_recapture_same_period", MONTHLY_REVENUE)
        self.assertEqual(recaptured["last_merge"], {"added": 0, "restated": 0, "unchanged": 1, "conflicts": []})
        self.assertEqual(json.dumps(recaptured["observations"], ensure_ascii=False, sort_keys=True), before)

    def test_a_genuine_restatement_replaces_values_and_records_the_supersession(self) -> None:
        series = self._capture(empty_series(), "monthly_revenue_capture_2", MONTHLY_REVENUE)
        original = series_for(series, "1101", MONTHLY_REVENUE, 1)[0]
        restated = self._capture(series, "monthly_revenue_restated", MONTHLY_REVENUE)
        self.assertEqual(restated["last_merge"], {"added": 0, "restated": 1, "unchanged": 0, "conflicts": []})
        latest = series_for(restated, "1101", MONTHLY_REVENUE, 1)[0]
        self.assertEqual(latest["values"]["monthly_revenue"], 13400000.0)
        self.assertEqual(latest["supersedes"]["values"], original["values"])
        self.assertEqual(latest["supersedes"]["available_at"], "2026-07-17")

    def test_value_digest_ignores_provenance_so_export_date_alone_never_restates(self) -> None:
        first = normalize_rows(FIXTURE["monthly_revenue_capture_2"], MONTHLY_REVENUE, TWSE)[0]
        again = normalize_rows(FIXTURE["monthly_revenue_recapture_same_period"], MONTHLY_REVENUE, TWSE)[0]
        self.assertNotEqual(first["provenance"]["available_at"], again["provenance"]["available_at"])
        self.assertEqual(observation_value_digest(first), observation_value_digest(again))

    def test_merge_is_order_independent_and_deterministic(self) -> None:
        forward = self._capture(self._capture(empty_series(), "monthly_revenue_capture_1", MONTHLY_REVENUE),
                                "monthly_revenue_capture_2", MONTHLY_REVENUE)
        backward = self._capture(self._capture(empty_series(), "monthly_revenue_capture_2", MONTHLY_REVENUE),
                                 "monthly_revenue_capture_1", MONTHLY_REVENUE)
        self.assertEqual(forward["observations"], backward["observations"])

    def test_three_families_accumulate_independently(self) -> None:
        series = self._capture(empty_series(), "income_statement_capture_1", INCOME_STATEMENT)
        series = self._capture(series, "balance_sheet_capture_1", BALANCE_SHEET)
        series = self._capture(series, "monthly_revenue_capture_2", MONTHLY_REVENUE)
        self.assertEqual(len(series_for(series, "1101", INCOME_STATEMENT, 8)), 1)
        self.assertEqual(len(series_for(series, "1101", BALANCE_SHEET, 8)), 1)
        self.assertEqual(len(series_for(series, "1101", MONTHLY_REVENUE, 12)), 1)
        # Same period, different family: the key must keep them separate.
        self.assertEqual(len(series["observations"]), 6)

    def test_coverage_reports_partial_depth_honestly(self) -> None:
        series = self._capture(empty_series(), "income_statement_capture_1", INCOME_STATEMENT)
        report = coverage(series, "1101", INCOME_STATEMENT, 8)
        self.assertEqual(report, {
            "captured": 1, "expected": 8, "complete": False,
            "label": "1 / 8", "accumulation": "forward_only",
        })

    def test_series_for_never_pads_a_gap(self) -> None:
        series = self._capture(empty_series(), "monthly_revenue_capture_2", MONTHLY_REVENUE)
        rows = series_for(series, "1101", MONTHLY_REVENUE, 12)
        self.assertEqual(len(rows), 1)
        self.assertEqual(series_for(series, "9999", MONTHLY_REVENUE, 12), [])

    def test_series_schema_is_enforced(self) -> None:
        with self.assertRaises(FundamentalsError):
            merge_observations({"schema": "something-else", "observations": []}, [])


class ModuleBoundaryTests(unittest.TestCase):
    def test_module_has_no_network_or_clock_code_path(self) -> None:
        """Normalization is pure: no fetch, no wall clock. A license URL in a
        provenance string is a citation, not a call, so match on call syntax."""
        source = (ROOT / "src/tw_quant_engine/fundamentals.py").read_text(encoding="utf-8")
        for forbidden in (
            "urlopen", "urllib", "import requests", "import socket",
            "http.client", "datetime.now", "time.time", "date.today",
        ):
            self.assertNotIn(forbidden, source, forbidden)


if __name__ == "__main__":
    unittest.main()
