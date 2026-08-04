# S1 — Qlib integration spike

## Scope

S1 proves that the project can call a pinned Qlib evaluation API with a fixed
synthetic return fixture. It does not initialize a Qlib market-data provider,
download public data, select a Taiwan data source, or define the canonical data
contract. Those decisions remain outside the approved S1 boundary.

The project owns the adapter boundary and the fixture contract. Qlib is a
replaceable research engine dependency, not the source of truth for Taiwan
point-in-time data.

## Pin decision

The current package index did not provide the initially considered `pyqlib`
`0.9.3`; it provided `0.9.6` and `0.9.7` during this S1 run. S1 therefore pins
`pyqlib==0.9.7` in the optional `qlib` dependency group. This is an observed
environment decision, not permission to follow future floating releases.

## Reproduction

```sh
python3.12 -m venv /tmp/tqr-qlib-0.9.7-replay
/tmp/tqr-qlib-0.9.7-replay/bin/python -m pip install --disable-pip-version-check --no-input -r workflow/qlib-replay-python312.lock
/tmp/tqr-qlib-0.9.7-replay/bin/python -m pip check
PYTHONNOUSERSITE=1 PYTHONPATH=src /tmp/tqr-qlib-0.9.7-replay/bin/python scripts/run_qlib_spike.py
```

The replay interpreter is fixed by the explicit Python 3.12 environment path
and the exact `pyqlib==0.9.7` requirement. The S9 runner accepts
`TQR_QLIB_PYTHON` for an equivalent isolated path and records `python -VV`,
`pip check`, and the complete `pip freeze --all` digest in its evidence. It
does not install dependencies or contact a provider during S9.

The command must emit one JSON object with:

- `schema: tw-quant-engine-s1-qlib-spike/v1`
- `status: pass`
- `qlib_version: 0.9.7`
- `provider_initialized: false`
- `network_used: false`
- stable `fixture_digest`
- Qlib `risk_metrics` including `max_drawdown`

## S1 acceptance boundary

Pass requires the pinned package to import, the synthetic fixture digest to be
stable, the Qlib evaluation call to complete, and the existing dependency-free
preflight/tests to remain green. A pass does not approve S2 data contracts,
Taiwan data sources, strategy logic, backtesting claims, or product acceptance.

## Live evidence

The S1 digest assertion was corrected from an incorrect expected value by
running the S1 command and capturing its actual JSON result. The live capture
is recorded in
`workflow/evidence/s1-qlib-spike.acceptance.json`; it includes exit codes,
stdout digests, stderr digests, and the parsed command result. The correction
belongs to S1 and is not an S2 scope exception.
