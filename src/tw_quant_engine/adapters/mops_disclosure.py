"""MOPS public disclosure adapter; no login or form submission is allowed."""
from __future__ import annotations

from typing import Any

from tw_quant_engine.source_registry import fetch_public, source_metadata


def fetch_mops_sample() -> dict[str, Any]:
    response = fetch_public("mops_landing")
    body_text = response.body.decode("utf-8", errors="replace")
    title_marker = "<title>"
    title = ""
    if title_marker in body_text.lower():
        lower = body_text.lower()
        start = lower.find(title_marker) + len(title_marker)
        end = lower.find("</title>", start)
        if end > start:
            title = body_text[start:end].strip()
    return {
        "metadata": source_metadata("mops_landing", response),
        "html_title": title,
        "has_html": "<html" in body_text.lower(),
        "mapping": {
            "status": "unadmitted",
            "reason": "landing page has no source-published observation timestamp; retrieval_at cannot substitute",
            "candidate_record_type": "disclosure_context",
        },
    }


__all__ = ["fetch_mops_sample"]
