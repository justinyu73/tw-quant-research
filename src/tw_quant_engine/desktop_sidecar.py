"""Offline, GET-only loopback catalog for the TQE desktop app."""
from __future__ import annotations

import copy
import gzip
import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import parse_qs, urlsplit

from .k6a_snapshot import K6A_SNAPSHOT_SCHEMA, load_snapshot as load_k6a_snapshot
from .k6b_snapshot import K6B_SNAPSHOT_SCHEMA, load_snapshot as load_k6b_snapshot
from .kline_aggregation import PERIODS, aggregate_dataset
from .kline_contract import KlineFixture
from .kline_view import KLINE_READ_MODEL_SCHEMA, build_kline_read_model


SIDECAR_INSTRUMENTS_SCHEMA = "tw-quant-engine-sidecar-instruments/v1"
SIDECAR_KLINE_SCHEMA = "tw-quant-engine-sidecar-kline/v1"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
PERIOD_ORDER = ("1D", "1W", "M", "Q")


class SidecarContractError(ValueError):
    """Raised when the local sidecar input or bind contract is unsafe."""


def validate_loopback_host(host: str) -> str:
    """Accept only an explicitly loopback bind address."""
    normalized = str(host).strip().lower()
    if normalized not in LOOPBACK_HOSTS:
        raise SidecarContractError(f"sidecar host must be loopback, got {host!r}")
    return normalized


def _digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


def _load_snapshot(path: Path) -> dict[str, Any]:
    opener = gzip.open if path.suffix == ".gz" else open
    try:
        with opener(path, "rt", encoding="utf-8") as handle:
            header = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise SidecarContractError(f"unable to inspect snapshot: {path}") from exc
    schema = header.get("schema") if isinstance(header, Mapping) else None
    if schema == K6A_SNAPSHOT_SCHEMA:
        return load_k6a_snapshot(path)
    if schema == K6B_SNAPSHOT_SCHEMA:
        return load_k6b_snapshot(path)
    raise SidecarContractError(f"unsupported desktop snapshot schema in {path.name!r}")


def _snapshot_paths(fixture_root: Path) -> list[Path]:
    paths = sorted((fixture_root / "k6a").glob("*.json.gz"))
    paths.extend(sorted((fixture_root / "k6b").glob("*.json.gz")))
    if not paths:
        raise SidecarContractError(f"no K6a/K6b snapshots found under {fixture_root}")
    return paths


def _merge_datasets(entries: list[tuple[dict[str, Any], dict[str, Any]]], instrument_id: str) -> dict[str, Any]:
    first = entries[0][1]
    instrument = copy.deepcopy(first["instrument"])
    policies = {str(dataset.get("adjustment_policy") or "") for _, dataset in entries}
    if len(policies) != 1:
        raise SidecarContractError(f"adjustment policy mismatch for {instrument_id}")

    bars: list[dict[str, Any]] = []
    seen_dates: set[tuple[str, str]] = set()
    reasons: set[str] = set()
    statuses: set[str] = set()
    periods_available: set[str] = set()
    unsupported_periods: set[str] = set()
    fixture_ids: set[str] = set()
    as_of_values: list[str] = []
    ingested_values: list[str] = []
    for snapshot, dataset in entries:
        if dataset["instrument"] != instrument:
            raise SidecarContractError(f"instrument metadata mismatch for {instrument_id}")
        statuses.add(str(dataset["quality"]["status"]))
        reasons.update(str(reason) for reason in dataset["quality"]["reason_codes"])
        periods_available.update(str(period) for period in dataset["periods_available"])
        unsupported_periods.update(str(period) for period in dataset["unsupported_periods"])
        fixture_ids.add(str(snapshot["kline_fixture"]["provenance"]["fixture_id"]))
        as_of_values.append(str(snapshot["kline_fixture"]["as_of"]))
        ingested_values.append(str(snapshot["kline_fixture"]["ingested_at"]))
        for bar in dataset["bars"]:
            key = (str(bar["trading_date"]), str(bar["session"]))
            if key in seen_dates:
                raise SidecarContractError(f"duplicate trading session for {instrument_id}: {key[0]}")
            seen_dates.add(key)
            bars.append(copy.deepcopy(bar))

    bars.sort(key=lambda item: (item["trading_date"], item["bar_time"]))
    status = "valid" if statuses == {"valid"} else "partial"
    if not bars:
        status = "unavailable"
        reasons.add("no_data")
    return {
        "dataset_id": f"desktop-sidecar-{instrument_id.replace(':', '-')}",
        "case": "valid" if status == "valid" else "partial",
        "instrument": instrument,
        "periods_available": sorted(periods_available),
        "unsupported_periods": sorted(unsupported_periods),
        "adjustment_policy": next(iter(policies)),
        "quality": {"status": status, "reason_codes": sorted(reasons)},
        "bars": bars,
        "as_of": max(as_of_values),
        "ingested_at": max(ingested_values),
        "source": "offline-fixture",
        "fixture_id": "+".join(sorted(fixture_ids)),
    }


@dataclass(frozen=True)
class KlineCatalog:
    """Deterministic read-only models derived from committed K6 snapshots."""

    instruments: tuple[dict[str, Any], ...]
    models: dict[tuple[str, str], dict[str, Any]]
    digest: str

    def instruments_response(self) -> dict[str, Any]:
        return {
            "schema": SIDECAR_INSTRUMENTS_SCHEMA,
            "read_only": True,
            "instruments": copy.deepcopy(list(self.instruments)),
            "digest": self.digest,
        }

    def kline_response(self, instrument_id: str, period: str) -> tuple[int, dict[str, Any]]:
        if instrument_id not in {item["instrument_id"] for item in self.instruments}:
            return 404, {"error": "instrument_not_found"}
        if period not in PERIODS:
            return 400, {"error": "unsupported_period"}
        model = self.models.get((instrument_id, period))
        if model is None:
            return 404, {"error": "kline_not_found"}
        return 200, {
            "schema": SIDECAR_KLINE_SCHEMA,
            "read_only": True,
            "data": copy.deepcopy(model),
            "digest": model["snapshot_digest"],
        }


def load_catalog(fixture_root: str | Path) -> KlineCatalog:
    """Load K6a/K6b gzip snapshots and build all period read models offline."""
    root = Path(fixture_root).resolve()
    grouped: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = defaultdict(list)
    for path in _snapshot_paths(root):
        snapshot = _load_snapshot(path)
        fixture = KlineFixture.from_payload(snapshot["kline_fixture"])
        for dataset in fixture.datasets:
            instrument_id = dataset["instrument"]["instrument_id"]
            grouped[instrument_id].append((snapshot, dataset))

    models: dict[tuple[str, str], dict[str, Any]] = {}
    instrument_rows: list[dict[str, Any]] = []
    for instrument_id in sorted(grouped):
        dataset = _merge_datasets(grouped[instrument_id], instrument_id)
        periods = [period for period in PERIOD_ORDER if period not in dataset["unsupported_periods"]]
        for period in periods:
            aggregation = aggregate_dataset(dataset, period=period, as_of=dataset["as_of"])
            models[(instrument_id, period)] = build_kline_read_model(aggregation)
        instrument = copy.deepcopy(dataset["instrument"])
        instrument["periods"] = periods
        instrument_rows.append(instrument)

    digest_payload = {
        "instruments": instrument_rows,
        "models": [models[key] for key in sorted(models)],
    }
    return KlineCatalog(tuple(instrument_rows), models, _digest(digest_payload))


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: Mapping[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


def _request_handler(catalog: KlineCatalog) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

        def _method_not_allowed(self) -> None:
            _json_response(self, 405, {"error": "read_only", "allow": ["GET"]})

        def do_POST(self) -> None:  # noqa: N802
            self._method_not_allowed()

        def do_PUT(self) -> None:  # noqa: N802
            self._method_not_allowed()

        def do_PATCH(self) -> None:  # noqa: N802
            self._method_not_allowed()

        def do_DELETE(self) -> None:  # noqa: N802
            self._method_not_allowed()

        def do_HEAD(self) -> None:  # noqa: N802
            self._method_not_allowed()

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlsplit(self.path)
            if parsed.path == "/instruments":
                if parsed.query:
                    _json_response(self, 400, {"error": "unexpected_query"})
                    return
                _json_response(self, 200, catalog.instruments_response())
                return
            if parsed.path != "/kline":
                _json_response(self, 404, {"error": "unknown_route"})
                return

            query = parse_qs(parsed.query, keep_blank_values=True)
            if set(query) != {"instrument", "period"} or any(len(values) != 1 or not values[0] for values in query.values()):
                _json_response(self, 400, {"error": "instrument_and_period_required"})
                return
            status, payload = catalog.kline_response(query["instrument"][0], query["period"][0])
            _json_response(self, status, payload)

    return Handler


def create_server(catalog: KlineCatalog, *, host: str = "127.0.0.1", port: int = 8766) -> ThreadingHTTPServer:
    """Create a loopback-only HTTP server; the caller owns its lifecycle."""
    validate_loopback_host(host)
    handler = _request_handler(catalog)
    return ThreadingHTTPServer((host, int(port)), handler)


__all__ = [
    "KlineCatalog",
    "LOOPBACK_HOSTS",
    "SIDECAR_INSTRUMENTS_SCHEMA",
    "SIDECAR_KLINE_SCHEMA",
    "SidecarContractError",
    "create_server",
    "load_catalog",
    "validate_loopback_host",
]
