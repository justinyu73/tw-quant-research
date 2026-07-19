"""Allowlisted public-source registry and fail-closed HTTP boundary for S3."""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


LICENSE_REF = "https://data.gov.tw/license"
ATTRIBUTION = "資料來源：臺灣證券交易所、財團法人中華民國證券櫃檯買賣中心"
_SECRET_QUERY_KEYS = frozenset(
    {
        "api_key",
        "apikey",
        "api_secret",
        "access_token",
        "auth_token",
        "secret",
        "token",
    }
)


@dataclass(frozen=True)
class SourceDefinition:
    source_id: str
    host: str
    base_url: str
    path: str
    terms_url: str
    attribution: str
    license_ref: str = LICENSE_REF


SOURCES: dict[str, SourceDefinition] = {
    "twse_daily_close": SourceDefinition(
        "twse_daily_close",
        "openapi.twse.com.tw",
        "https://openapi.twse.com.tw/v1",
        "/v1/exchangeReport/STOCK_DAY_ALL",
        "https://openapi.twse.com.tw/",
        "資料來源：臺灣證券交易所",
    ),
    "twse_monthly_revenue": SourceDefinition(
        "twse_monthly_revenue",
        "openapi.twse.com.tw",
        "https://openapi.twse.com.tw/v1",
        "/v1/opendata/t187ap05_L",
        "https://openapi.twse.com.tw/",
        "資料來源：臺灣證券交易所",
    ),
    "tpex_daily_close": SourceDefinition(
        "tpex_daily_close",
        "www.tpex.org.tw",
        "https://www.tpex.org.tw/openapi/v1",
        "/openapi/v1/tpex_mainboard_daily_close_quotes",
        "https://www.tpex.org.tw/openapi/",
        "資料來源：財團法人中華民國證券櫃檯買賣中心",
    ),
    "tpex_monthly_revenue": SourceDefinition(
        "tpex_monthly_revenue",
        "www.tpex.org.tw",
        "https://www.tpex.org.tw/openapi/v1",
        "/openapi/v1/mopsfin_t187ap05_O",
        "https://www.tpex.org.tw/openapi/",
        "資料來源：財團法人中華民國證券櫃檯買賣中心",
    ),
    "taifex_daily_fut": SourceDefinition(
        "taifex_daily_fut",
        "openapi.taifex.com.tw",
        "https://openapi.taifex.com.tw/v1",
        "/v1/DailyMarketReportFut",
        "https://www.taifex.com.tw/cht/edu/userTerms",
        "資料來源：臺灣期貨交易所",
    ),
    "mops_landing": SourceDefinition(
        "mops_landing",
        "mops.twse.com.tw",
        "https://mops.twse.com.tw/mops",
        "/mops/",
        "https://mops.twse.com.tw/mops/",
        "資料來源：公開資訊觀測站（證交所／櫃買中心）",
    ),
}


class SourceBoundaryError(ValueError):
    """Raised before a request can leave the approved source boundary."""


class PublicFetchError(RuntimeError):
    """Raised when an approved public request is not a successful GET."""


@dataclass(frozen=True)
class PublicResponse:
    url: str
    status: int
    content_type: str
    body: bytes
    retrieved_at: str

    @property
    def content_digest(self) -> str:
        return f"sha256:{hashlib.sha256(self.body).hexdigest()}"


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request: Request, *args: Any, **kwargs: Any) -> None:
        raise PublicFetchError("redirect is outside the bounded S3 request contract")


def get_source(source_id: str) -> SourceDefinition:
    try:
        return SOURCES[source_id]
    except KeyError as exc:
        raise SourceBoundaryError(f"source is not admitted: {source_id}") from exc


def build_url(source_id: str, query: Mapping[str, str] | None = None) -> str:
    source = get_source(source_id)
    params = dict(query or {})
    if source_id in {"twse_daily_close", "twse_monthly_revenue"}:
        params.setdefault("response", "json")
    if source_id == "tpex_daily_close":
        if not re.fullmatch(r"\d{3}/\d{2}/\d{2}", str(params.get("d", ""))):
            raise SourceBoundaryError("tpex_daily_close requires explicit ROC d=YYY/MM/DD")
        params.setdefault("l", "zh-tw")
        params.setdefault("s", "0,asc,0")
    query_string = urlencode(sorted(params.items()))
    url = urlunsplit(("https", source.host, source.path, query_string, ""))
    validate_url(source_id, url)
    return url


def validate_url(source_id: str, url: str) -> None:
    source = get_source(source_id)
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != source.host:
        raise SourceBoundaryError(f"URL host/scheme not allowlisted for {source_id}: {url}")
    if parsed.path != source.path:
        raise SourceBoundaryError(f"URL path not allowlisted for {source_id}: {parsed.path}")
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        if not key or not isinstance(value, str):
            raise SourceBoundaryError(f"invalid query parameter for {source_id}")


def fetch_public(
    source_id: str,
    *,
    query: Mapping[str, str] | None = None,
    timeout_seconds: int = 20,
) -> PublicResponse:
    source = get_source(source_id)
    url = build_url(source_id, query=query)
    request = Request(
        url,
        method="GET",
        headers={"Accept": "application/json, text/html", "User-Agent": "tw-quant-engine-s3/1.0"},
    )
    retrieved_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    opener = build_opener(_NoRedirectHandler())
    try:
        with opener.open(request, timeout=timeout_seconds) as response:
            body = response.read()
            status = int(response.status)
            content_type = response.headers.get("Content-Type", "")
    except HTTPError as exc:
        raise PublicFetchError(f"{source_id} returned HTTP {exc.code}") from exc
    except URLError as exc:
        raise PublicFetchError(f"{source_id} request failed: {exc.reason}") from exc
    if status != 200:
        raise PublicFetchError(f"{source_id} returned HTTP {status}")
    return PublicResponse(url, status, content_type, body, retrieved_at)


def decode_json(response: PublicResponse) -> Any:
    try:
        return json.loads(response.body.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublicFetchError(f"{response.url} did not return valid UTF-8 JSON") from exc


def extract_rows(payload: Any) -> list[dict[str, Any]]:
    """Extract an array of object rows without assuming one provider envelope."""
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in ("data", "records", "result", "aaData", "Data"):
            value = payload.get(key)
            if isinstance(value, list):
                rows = [row for row in value if isinstance(row, dict)]
                if rows:
                    return rows
        for key, value in payload.items():
            if not key.lower().startswith("data") or not isinstance(value, list):
                continue
            rows = [row for row in value if isinstance(row, dict)]
            if rows:
                return rows
            suffix = key[4:]
            fields = payload.get(f"fields{suffix}")
            if isinstance(fields, list) and value and all(isinstance(row, list) for row in value):
                return [dict(zip(fields, row)) for row in value]
    raise PublicFetchError("source JSON has no recognized row array")


def pick(row: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in row and row[key] not in (None, "", "-"):
            return row[key]
    return None


def _redact_url_query(url: str) -> str:
    parsed = urlsplit(url)
    if not parsed.query:
        return url
    redacted_query = [
        (key, "REDACTED" if key.lower() in _SECRET_QUERY_KEYS else value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
    ]
    return urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urlencode(redacted_query), parsed.fragment)
    )


def source_metadata(source_id: str, response: PublicResponse) -> dict[str, Any]:
    source = get_source(source_id)
    return {
        "source_id": source_id,
        "endpoint": _redact_url_query(response.url),
        "terms_url": source.terms_url,
        "license_ref": source.license_ref,
        "attribution": source.attribution,
        "retrieved_at": response.retrieved_at,
        "http_status": response.status,
        "content_type": response.content_type,
        "response_bytes": len(response.body),
        "content_digest": response.content_digest,
    }


__all__ = [
    "ATTRIBUTION",
    "LICENSE_REF",
    "PublicFetchError",
    "PublicResponse",
    "SOURCES",
    "SourceBoundaryError",
    "SourceDefinition",
    "build_url",
    "decode_json",
    "extract_rows",
    "fetch_public",
    "get_source",
    "pick",
    "source_metadata",
    "validate_url",
]
