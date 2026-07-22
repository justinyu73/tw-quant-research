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

import tw_quant_engine.alerts as alerts_module  # noqa: E402
from tw_quant_engine.alerts import (  # noqa: E402
    ALERT_STORE_SCHEMA,
    AlertValidationError,
    evaluate_alerts,
    parse_alert_store,
    serialize_alert_store,
    validate_alert,
)
from tw_quant_engine.desktop_sidecar import create_server, load_catalog  # noqa: E402


FIXTURE_PATH = ROOT / "tests/fixtures/p6/alerts.json"


class P6AlertValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.admitted = cls.fixture["admitted_security_ids"]

    def test_valid_definitions_pass_validation(self) -> None:
        for definition in self.fixture["definitions"]:
            validated = validate_alert(definition, self.admitted)
            self.assertEqual(validated["schema"], "tqe-in-app-alert/v1")
            self.assertEqual(validated["alert_id"], definition["alert_id"])

    def test_invalid_definitions_are_rejected_fail_closed(self) -> None:
        cases = {item["case"] for item in self.fixture["invalid_definitions"]}
        self.assertEqual(
            cases,
            {
                "bad_schema",
                "unknown_condition_type",
                "unknown_indicator",
                "unknown_price_field",
                "target_outside_universe",
                "malformed_dedup",
                "malformed_expiry",
                "external_channel_field",
                "indicator_params_on_fixed_window",
            },
        )
        for item in self.fixture["invalid_definitions"]:
            with self.assertRaises(AlertValidationError, msg=item["case"]):
                validate_alert(item["definition"], self.admitted)

    def test_store_roundtrip_preserves_session_expiry(self) -> None:
        definitions = [validate_alert(item, self.admitted) for item in self.fixture["definitions"]]
        store = serialize_alert_store(definitions)
        self.assertEqual(store["schema"], ALERT_STORE_SCHEMA)
        self.assertEqual(store["version"], 1)
        # Session-expiry definitions persist so a reload within the same
        # session keeps them; the app-side loader drops them when a new
        # session starts (new browser tab or desktop app launch).
        expected_ids = [definition["alert_id"] for definition in definitions]
        self.assertEqual([alert["alert_id"] for alert in store["alerts"]], expected_ids)
        parsed = parse_alert_store(store, self.admitted)
        self.assertEqual([alert["alert_id"] for alert in parsed], expected_ids)

    def test_store_parse_is_fail_closed(self) -> None:
        until_definitions = [
            validate_alert(item, self.admitted)
            for item in self.fixture["definitions"]
            if item["expiry"]["policy"] == "until"
        ]
        store = serialize_alert_store(until_definitions)
        self.assertTrue(store["alerts"])
        for tampered in (
            dict(store, schema="tqe-in-app-alerts/v0"),
            dict(store, version=2),
            dict(store, alerts=store["alerts"] + store["alerts"]),
            {"schema": ALERT_STORE_SCHEMA, "version": 1, "alerts": "not-a-list"},
        ):
            with self.assertRaises(AlertValidationError):
                parse_alert_store(tampered, self.admitted)


class P6AlertEvaluationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.definitions = [
            validate_alert(item, cls.fixture["admitted_security_ids"])
            for item in cls.fixture["definitions"]
        ]

    def evaluate(self, session_state=None):
        return evaluate_alerts(
            self.definitions,
            self.fixture["market_data"],
            now=self.fixture["now"],
            session_state=session_state if session_state is not None else self.fixture["session_state"],
        )

    def test_exact_fired_set_and_skip_reasons(self) -> None:
        result = self.evaluate()
        self.assertEqual(
            [event["alert_id"] for event in result["fired"]],
            self.fixture["expected"]["fired_alert_ids"],
        )
        skipped = {item["alert_id"]: item["reason"] for item in result["skipped"]}
        self.assertEqual(skipped, self.fixture["expected"]["skipped"])

    def test_evaluation_is_deterministic(self) -> None:
        self.assertEqual(self.evaluate(), self.evaluate())

    def test_fired_events_are_in_app_research_only(self) -> None:
        result = self.evaluate()
        self.assertEqual(result["channels"], ["in_app"])
        for event in result["fired"]:
            self.assertEqual(event["schema"], "tqe-in-app-alert-event/v1")
            self.assertEqual(event["channel"], "in_app")
            self.assertIs(event["research_only"], True)
            self.assertEqual(event["fired_at"], "2026-07-22T01:00:00.000000Z")
        price_event = next(event for event in result["fired"] if event["alert_id"] == "p6-price-fire")
        self.assertEqual(price_event["observed_value"], 100.0)
        indicator_event = next(event for event in result["fired"] if event["alert_id"] == "p6-indicator-fire")
        self.assertEqual(indicator_event["observed_value"], 98.0)

    def test_dedup_replay_after_firing(self) -> None:
        first = self.evaluate(session_state={})
        fired_ids = {event["alert_id"] for event in first["fired"]}
        self.assertIn("p6-dedup-once", fired_ids)
        self.assertIn("p6-dedup-cooldown-blocked", fired_ids)
        second = self.evaluate(session_state=first["session_state"])
        skipped = {item["alert_id"]: item["reason"] for item in second["skipped"]}
        self.assertEqual(skipped["p6-dedup-once"], "dedup_once_per_session")
        self.assertEqual(skipped["p6-dedup-cooldown-blocked"], "dedup_cooldown")
        self.assertNotIn("p6-dedup-once", {event["alert_id"] for event in second["fired"]})

    def test_expiry_until_boundary(self) -> None:
        definitions = [
            alert for alert in self.definitions if alert["alert_id"] == "p6-expired"
        ]
        at_boundary = evaluate_alerts(definitions, self.fixture["market_data"], now="2026-07-21T00:00:00Z")
        self.assertEqual(at_boundary["skipped"][0]["reason"], "expired")
        before_boundary = evaluate_alerts(definitions, self.fixture["market_data"], now="2026-07-20T23:59:59Z")
        self.assertEqual([event["alert_id"] for event in before_boundary["fired"]], ["p6-expired"])

    def test_delivery_stub_has_no_external_channel_code_path(self) -> None:
        source = inspect.getsource(alerts_module).lower()
        for token in ("smtp", "webhook", "requests", "urllib", "http://", "https://", "socket"):
            self.assertNotIn(token, source)


class P6SidecarAlertsRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = load_catalog(ROOT / "tests" / "fixtures")
        cls.server = create_server(cls.catalog, port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.definition = {
            "schema": "tqe-in-app-alert/v1",
            "alert_id": "p6-sidecar-2330",
            "label": "2330 收盤門檻",
            "enabled": True,
            "target": {"security_id": "2330"},
            "condition": {"type": "price_threshold", "field": "close", "op": ">=", "value": 1},
            "dedup": {"policy": "once_per_session"},
            "expiry": {"policy": "until", "until": "2026-12-31T00:00:00Z"},
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

    def test_alerts_route_evaluates_over_real_read_model(self) -> None:
        query = "definitions=" + quote(json.dumps([self.definition])) + "&now=" + quote("2026-07-22T01:00:00Z")
        status, payload = self._get(f"/alerts?{query}")
        self.assertEqual(status, 200)
        self.assertEqual(payload["schema"], "tw-quant-engine-sidecar-alerts/v1")
        self.assertTrue(payload["read_only"])
        self.assertEqual(payload["channels"], ["in_app"])
        data = payload["data"]
        self.assertEqual([event["alert_id"] for event in data["fired"]], ["p6-sidecar-2330"])
        event = data["fired"][0]
        self.assertEqual(event["observed_value"], float(self.catalog.models[("TWSE:2330", "1D")]["bars"][-1]["close"]))
        self.assertEqual(event["channel"], "in_app")
        replay_query = query + "&state=" + quote(json.dumps(data["session_state"]))
        status, replay = self._get(f"/alerts?{replay_query}")
        self.assertEqual(status, 200)
        self.assertEqual(replay["data"]["fired"], [])
        self.assertEqual(replay["data"]["skipped"][0]["reason"], "dedup_once_per_session")

    def test_alerts_route_rejects_invalid_definition_fail_closed(self) -> None:
        invalid = dict(self.definition, target={"security_id": "9999"})
        query = "definitions=" + quote(json.dumps([invalid]))
        with self.assertRaises(HTTPError) as caught:
            self._get(f"/alerts?{query}")
        self.assertEqual(caught.exception.code, 400)

    def test_alerts_route_requires_definitions(self) -> None:
        with self.assertRaises(HTTPError) as caught:
            self._get("/alerts")
        self.assertEqual(caught.exception.code, 400)

    def test_alerts_route_is_read_only(self) -> None:
        request = Request(f"{self.base}/alerts", data=b"{}", method="POST")
        with self.assertRaises(HTTPError) as caught:
            urlopen(request, timeout=5)  # nosec B310 - test server is loopback-only
        self.assertEqual(caught.exception.code, 405)


if __name__ == "__main__":
    unittest.main()
