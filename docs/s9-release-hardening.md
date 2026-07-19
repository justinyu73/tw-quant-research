# S9 — Release hardening and final acceptance

S9 is the final offline gate for the approved S5–S9 chain. It validates the
S1–S8 evidence artifacts, checks that their stage IDs and statuses agree, and
requires zero observed network calls. It also audits for credential/private
artifact names and oversized raw artifacts, checks that the active source
registry does not admit FinMind, and verifies the research-only manifest.

The runner replays the local fixtures and read models twice for stable file and
normalized JSON digests. `captured_at` and subprocess output digest fields are
explicitly excluded from normalized evidence digests; all financial/product
values remain included. It runs the dependency-free test matrix, the existing
Qlib 0.9.7 synthetic matrix when its already-installed local environment is
available, and the write-free LH preflight. S9 does not install dependencies,
fetch data, commit, push, deploy, or claim live-trading or investment
performance readiness.
