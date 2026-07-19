import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from tw_quant_engine.adapters.tpex_openapi import tpex_mapping  # noqa: E402
from tw_quant_engine.adapters.taifex_openapi import taifex_mapping  # noqa: E402
from tw_quant_engine.adapters.twse_openapi import twse_mapping  # noqa: E402
from tw_quant_engine.source_registry import (  # noqa: E402
    SOURCES,
    PublicResponse,
    SourceBoundaryError,
    build_url,
    source_metadata,
    validate_url,
)


FIXTURE_PATH = ROOT / "tests/fixtures/s3/source-admission.json"


class SourceRegistryTests(unittest.TestCase):
    def test_all_live_sources_are_allowlisted_https_endpoints(self) -> None:
        for source_id, source in SOURCES.items():
            query = {"d": "115/07/15"} if source_id == "tpex_daily_close" else None
            url = build_url(source_id, query=query)
            self.assertTrue(url.startswith("https://"))
            validate_url(source_id, url)

    def test_tpex_daily_close_requires_explicit_backfill_date(self) -> None:
        with self.assertRaises(SourceBoundaryError):
            build_url("tpex_daily_close")
        url = build_url("tpex_daily_close", query={"d": "115/07/15"})
        self.assertIn("d=115%2F07%2F15", url)

    def test_taifex_daily_fut_is_explicit_https_get_allowlist(self) -> None:
        url = build_url("taifex_daily_fut")
        self.assertEqual(url, "https://openapi.taifex.com.tw/v1/DailyMarketReportFut")
        validate_url("taifex_daily_fut", url)

    def test_unlisted_host_is_rejected(self) -> None:
        with self.assertRaises(SourceBoundaryError):
            validate_url("twse_daily_close", "https://example.invalid/v1/exchangeReport/STOCK_DAY_ALL")

    def test_unlisted_path_is_rejected(self) -> None:
        with self.assertRaises(SourceBoundaryError):
            validate_url("twse_daily_close", "https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX")

    def test_source_metadata_redacts_query_credentials(self) -> None:
        response = PublicResponse(
            "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL?apikey=secret-value&symbol=SPY&token=other-secret",
            200,
            "application/json",
            b"{}",
            "2026-07-16T00:00:00Z",
        )

        metadata = source_metadata("twse_daily_close", response)

        self.assertEqual(
            metadata["endpoint"],
            "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL?apikey=REDACTED&symbol=SPY&token=REDACTED",
        )
        self.assertNotIn("secret-value", json.dumps(metadata))
        self.assertNotIn("other-secret", json.dumps(metadata))


class SourceFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    def test_fixture_is_bounded_and_does_not_use_finmind(self) -> None:
        self.assertEqual(self.payload["schema"], "tw-quant-engine-s3-source-admission-fixture/v1")
        self.assertLessEqual(self.payload["network_requests"], 12)
        self.assertFalse(self.payload["finmind_used"])
        self.assertEqual(self.payload["errors"], [])
        self.assertEqual(len(self.payload["fetches"]), 5)

    def test_each_response_has_digest_and_attribution(self) -> None:
        for item in self.payload["fetches"]:
            metadata = item["metadata"]
            self.assertEqual(metadata["http_status"], 200)
            self.assertRegex(metadata["content_digest"], r"^sha256:[0-9a-f]{64}$")
            self.assertTrue(metadata["terms_url"])
            self.assertTrue(metadata["license_ref"])
            self.assertTrue(metadata["attribution"])

    def test_unadmitted_mapping_never_substitutes_retrieval_time(self) -> None:
        for item in self.payload["fetches"]:
            mapping = item["mapping"]
            if mapping["status"] == "unadmitted":
                self.assertNotIn("available_at", mapping)
                self.assertIn("retrieval_at cannot substitute", mapping["reason"])

    def test_field_mapping_is_provider_specific_and_dependency_free(self) -> None:
        twse = twse_mapping(
            "twse_daily_close",
            {"證券代號": "2330", "日期": "2026-07-15", "開盤價": "100", "最高價": "110", "最低價": "99", "收盤價": "108", "成交股數": "1000"},
        )
        tpex = tpex_mapping(
            "tpex_daily_close",
            {"SecuritiesCompanyCode": "6488", "Date": "2026-07-15", "Open": "10", "High": "11", "Low": "9", "Close": "10.5", "TradeVolume": "500"},
        )
        taifex = taifex_mapping(
            "taifex_daily_fut",
            {
                "Date": "20260715",
                "Contract": "TX",
                "ContractMonth(Week)": "202608",
                "Open": "45652",
                "High": "46169",
                "Low": "45406",
                "Last": "46050",
                "Volume": "45252",
                "SettlementPrice": "46066",
                "TradingSession": "一般",
            },
        )
        self.assertEqual(twse["candidate_fields"]["security_id"], "2330")
        self.assertEqual(tpex["candidate_fields"]["security_id"], "6488")
        self.assertEqual(twse["status"], "unadmitted")
        self.assertEqual(tpex["status"], "unadmitted")
        self.assertEqual(taifex["status"], "unadmitted")
        self.assertIn("retrieval_at cannot substitute", taifex["reason"])


if __name__ == "__main__":
    unittest.main()
