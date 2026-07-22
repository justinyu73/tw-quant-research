import inspect
import json
import sys
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import tw_quant_engine.valuation as valuation_module  # noqa: E402
from tw_quant_engine.valuation import (  # noqa: E402
    WORKSHEET_STORE_SCHEMA,
    ValuationValidationError,
    closes_from_bars,
    compute_fair_value,
    compute_indicator,
    evaluate_worksheet,
    evaluate_worksheets,
    parse_worksheet_store,
    serialize_worksheet_store,
    validate_indicator_request,
    validate_worksheet,
)
from tw_quant_engine.desktop_sidecar import create_server, load_catalog  # noqa: E402


FIXTURE_PATH = ROOT / "tests/fixtures/p6/valuation.json"


class P6ValuationValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.admitted = cls.fixture["admitted_security_ids"]

    def test_valid_worksheets_pass_validation(self) -> None:
        for definition in self.fixture["worksheets"]:
            validated = validate_worksheet(definition, self.admitted)
            self.assertEqual(validated["schema"], "tqe-fair-value-worksheet/v1")
            self.assertEqual(validated["worksheet_id"], definition["worksheet_id"])

    def test_invalid_worksheets_are_rejected_fail_closed(self) -> None:
        cases = {item["case"] for item in self.fixture["invalid_worksheets"]}
        self.assertEqual(
            cases,
            {
                "bad_schema",
                "unknown_model_type",
                "missing_model_field",
                "discount_not_greater_than_growth",
                "growth_not_above_minus_one",
                "non_positive_eps",
                "safety_margin_out_of_range",
                "target_outside_universe",
                "peg_growth_product_non_positive",
                "external_fetch_field",
            },
        )
        for item in self.fixture["invalid_worksheets"]:
            with self.assertRaises(ValuationValidationError, msg=item["case"]):
                validate_worksheet(item["definition"], self.admitted)

    def test_store_roundtrip(self) -> None:
        definitions = [validate_worksheet(item, self.admitted) for item in self.fixture["worksheets"]]
        store = serialize_worksheet_store(definitions)
        self.assertEqual(store["schema"], WORKSHEET_STORE_SCHEMA)
        self.assertEqual(store["version"], 1)
        expected_ids = [definition["worksheet_id"] for definition in definitions]
        self.assertEqual([item["worksheet_id"] for item in store["worksheets"]], expected_ids)
        parsed = parse_worksheet_store(store, self.admitted)
        self.assertEqual([item["worksheet_id"] for item in parsed], expected_ids)

    def test_store_parse_is_fail_closed(self) -> None:
        definitions = [validate_worksheet(item, self.admitted) for item in self.fixture["worksheets"]]
        store = serialize_worksheet_store(definitions)
        for tampered in (
            dict(store, schema="tqe-fair-value-worksheets/v0"),
            dict(store, version=2),
            dict(store, worksheets=store["worksheets"] + store["worksheets"]),
            {"schema": WORKSHEET_STORE_SCHEMA, "version": 1, "worksheets": "not-a-list"},
        ):
            with self.assertRaises(ValuationValidationError):
                parse_worksheet_store(tampered, self.admitted)

    def test_indicator_request_validation(self) -> None:
        request = validate_indicator_request({"type": "zscore", "security_id": "2330", "period": 20}, self.admitted)
        self.assertEqual(request, {"type": "zscore", "security_id": "2330", "period": 20})
        for bad in (
            {"type": "rsi", "security_id": "2330", "period": 20},
            {"type": "zscore", "security_id": "9999", "period": 20},
            {"type": "zscore", "security_id": "2330", "period": 0},
            {"type": "zscore", "security_id": "2330", "period": 251},
            {"type": "zscore", "security_id": "2330", "period": 20, "channel": "email"},
        ):
            with self.assertRaises(ValuationValidationError):
                validate_indicator_request(bad, self.admitted)


class P6ValuationModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.admitted = cls.fixture["admitted_security_ids"]
        cls.worksheets = [validate_worksheet(item, cls.admitted) for item in cls.fixture["worksheets"]]

    def test_three_model_formulas_exact(self) -> None:
        expected = self.fixture["expected"]["fair_values"]
        for worksheet in self.worksheets:
            self.assertAlmostEqual(
                compute_fair_value(worksheet["model"]),
                expected[worksheet["worksheet_id"]],
                places=9,
                msg=worksheet["worksheet_id"],
            )

    def test_evaluation_derived_outputs_and_comparison(self) -> None:
        worksheet = next(item for item in self.worksheets if item["worksheet_id"] == "p6-pe-2330")
        result = evaluate_worksheet(worksheet, self.fixture["market_data"]["2330"])
        self.assertEqual(result["status"], "ok")
        self.assertAlmostEqual(result["fair_value"], 150.0)
        self.assertAlmostEqual(result["buy_zone_ceiling"], 120.0)
        self.assertEqual(result["current_price"], 100.0)
        self.assertEqual(result["price_as_of"], "2026-07-21")
        self.assertEqual(result["price_basis"], "close")
        self.assertEqual(result["formula_version"], "tqe-fair-value/v1")
        self.assertEqual(result["assumption_source"], "user_supplied_assumption")
        self.assertEqual(result["data_status"], "draft")
        self.assertIs(result["research_only"], True)
        comparison = result["comparison"]
        expected = self.fixture["expected"]["pe_2330_comparison"]
        self.assertEqual(comparison["vs_fair_value"], expected["vs_fair_value"])
        self.assertEqual(comparison["vs_buy_zone_ceiling"], expected["vs_buy_zone_ceiling"])
        self.assertAlmostEqual(comparison["gap_to_fair_value_pct"], expected["gap_to_fair_value_pct"])
        self.assertAlmostEqual(comparison["gap_to_buy_zone_ceiling_pct"], expected["gap_to_buy_zone_ceiling_pct"])
        self.assertIs(comparison["research_comparison_only"], True)

    def test_missing_data_fails_closed_to_insufficient_data(self) -> None:
        worksheet = next(item for item in self.worksheets if item["worksheet_id"] == "p6-ddm-2317")
        result = evaluate_worksheet(worksheet, self.fixture["market_data"]["2317"])
        self.assertEqual(result["status"], "insufficient_data")
        self.assertIsNone(result["current_price"])
        self.assertIsNone(result["comparison"])
        self.assertAlmostEqual(result["fair_value"], 103.0)
        result_none = evaluate_worksheet(worksheet, None)
        self.assertEqual(result_none["status"], "insufficient_data")

    def test_evaluate_worksheets_is_deterministic(self) -> None:
        first = evaluate_worksheets(self.worksheets, self.fixture["market_data"])
        second = evaluate_worksheets(self.worksheets, self.fixture["market_data"])
        self.assertEqual(first, second)
        self.assertEqual(first["schema"], "tqe-fair-value-evaluation/v1")
        self.assertEqual(len(first["results"]), 3)


class P6ValuationIndicatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.closes = cls.fixture["indicator_closes"]

    def test_zscore_population_convention(self) -> None:
        result = compute_indicator("zscore", self.closes, 5)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["price_basis"], "close")
        self.assertEqual(result["std_convention"], "population")
        self.assertEqual(result["period"], 5)
        self.assertAlmostEqual(result["value"], self.fixture["expected"]["zscore_period5"], places=9)

    def test_price_percentile(self) -> None:
        result = compute_indicator("price_percentile", self.closes, 5)
        self.assertEqual(result["status"], "ok")
        self.assertAlmostEqual(result["value"], self.fixture["expected"]["price_percentile_period5"])

    def test_ma_deviation(self) -> None:
        result = compute_indicator("ma_deviation", self.closes, 5)
        self.assertEqual(result["status"], "ok")
        self.assertAlmostEqual(result["value"], self.fixture["expected"]["ma_deviation_period5"], places=12)

    def test_insufficient_history_fails_closed(self) -> None:
        for kind in ("zscore", "price_percentile", "ma_deviation"):
            result = compute_indicator(kind, self.closes, 20)
            self.assertEqual(result["status"], "insufficient_data", msg=kind)
            self.assertIsNone(result["value"])

    def test_flat_series_zscore_is_zero(self) -> None:
        result = compute_indicator("zscore", [50.0, 50.0, 50.0], 3)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["value"], 0.0)

    def test_closes_from_bars_skips_non_numeric(self) -> None:
        bars = [{"close": 100}, {"close": "bad"}, {"close": True}, {"no_close": 1}, {"close": 102.5}]
        self.assertEqual(closes_from_bars(bars), [100.0, 102.5])
        self.assertEqual(closes_from_bars(None), [])

    def test_module_has_no_network_or_delivery_code_path(self) -> None:
        source = inspect.getsource(valuation_module).lower()
        for token in ("smtp", "webhook", "requests", "urllib", "http://", "https://", "socket"):
            self.assertNotIn(token, source)


class P6SidecarValuationRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = load_catalog(ROOT / "tests" / "fixtures")
        cls.server = create_server(cls.catalog, port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.worksheet = {
            "schema": "tqe-fair-value-worksheet/v1",
            "worksheet_id": "p6-sidecar-2330",
            "label": "2330 本益比合理價",
            "target": {"security_id": "2330"},
            "model": {"type": "pe_multiple", "eps": 10, "target_pe": 15},
            "safety_margin": 0.2,
            "assumption_notes": "",
            "created_at": "2026-07-22T00:00:00Z",
        }

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def _get(self, path: str) -> tuple[int, dict[str, object]]:
        with urlopen(f"{self.base}{path}", timeout=5) as response:  # nosec B310 - test server is loopback-only
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_valuation_route_evaluates_over_real_read_model(self) -> None:
        indicators = [
            {"type": "zscore", "security_id": "2330", "period": 20},
            {"type": "price_percentile", "security_id": "2330", "period": 20},
            {"type": "ma_deviation", "security_id": "2330", "period": 20},
        ]
        query = "worksheets=" + quote(json.dumps([self.worksheet])) + "&indicators=" + quote(json.dumps(indicators))
        status, payload = self._get(f"/valuation?{query}")
        self.assertEqual(status, 200)
        self.assertEqual(payload["schema"], "tw-quant-engine-sidecar-valuation/v1")
        self.assertTrue(payload["read_only"])
        self.assertEqual(payload["mode"], "valuation_analysis_only")
        data = payload["data"]
        result = data["evaluation"]["results"][0]
        self.assertEqual(result["worksheet_id"], "p6-sidecar-2330")
        self.assertEqual(result["status"], "ok")
        self.assertAlmostEqual(result["fair_value"], 150.0)
        self.assertAlmostEqual(result["buy_zone_ceiling"], 120.0)
        latest_bar = self.catalog.models[("TWSE:2330", "1D")]["bars"][-1]
        self.assertEqual(result["current_price"], float(latest_bar["close"]))
        self.assertEqual(result["price_as_of"], latest_bar["trading_date"])
        self.assertEqual(result["assumption_source"], "user_supplied_assumption")
        self.assertEqual(result["data_status"], "draft")
        self.assertEqual([item["type"] for item in data["indicators"]], ["zscore", "price_percentile", "ma_deviation"])
        for item in data["indicators"]:
            self.assertEqual(item["security_id"], "2330")
            self.assertIn(item["status"], ("ok", "insufficient_data"))
            self.assertEqual(item["price_basis"], "close")

    def test_valuation_route_indicators_only(self) -> None:
        query = "indicators=" + quote(json.dumps([{"type": "zscore", "security_id": "2330", "period": 5}]))
        status, payload = self._get(f"/valuation?{query}")
        self.assertEqual(status, 200)
        self.assertEqual(payload["data"]["evaluation"]["results"], [])
        self.assertEqual(len(payload["data"]["indicators"]), 1)

    def test_valuation_route_rejects_invalid_fail_closed(self) -> None:
        invalid = dict(self.worksheet, target={"security_id": "9999"})
        query = "worksheets=" + quote(json.dumps([invalid]))
        with self.assertRaises(HTTPError) as caught:
            self._get(f"/valuation?{query}")
        self.assertEqual(caught.exception.code, 400)
        bad_model = dict(self.worksheet, model={"type": "dividend_discount_simple", "dps": 5, "growth_rate": 0.09, "discount_rate": 0.08})
        query = "worksheets=" + quote(json.dumps([bad_model]))
        with self.assertRaises(HTTPError) as caught:
            self._get(f"/valuation?{query}")
        self.assertEqual(caught.exception.code, 400)

    def test_valuation_route_requires_parameters(self) -> None:
        with self.assertRaises(HTTPError) as caught:
            self._get("/valuation")
        self.assertEqual(caught.exception.code, 400)

    def test_valuation_route_is_read_only(self) -> None:
        request = Request(f"{self.base}/valuation", data=b"{}", method="POST")
        with self.assertRaises(HTTPError) as caught:
            urlopen(request, timeout=5)  # nosec B310 - test server is loopback-only
        self.assertEqual(caught.exception.code, 405)


if __name__ == "__main__":
    unittest.main()
