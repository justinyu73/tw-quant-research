# Workflow Contract

This directory describes how LH drives the independent engine repo. It is not
an LH plugin directory and it is not a place for copied LH runtime files.

## Current workflow

S1 is a synthetic Qlib integration spike plus the read-only preflight. The
approved S2–S4 work units define the canonical contract, bounded public-source
fixtures, and offline product alignment. The approved S5–S9 package runs the
remaining research-only chain sequentially with `network=false`; each stage
must generate `status: pass` evidence before the next stage may start:

```sh
python3 scripts/run_qlib_spike.py
```

The normal repository preflight remains:

```sh
python3 scripts/lh_preflight.py
```

It validates the repository shape and the driver contract, prints bounded JSON,
and does not write files or fetch market data. The Qlib spike also does not
initialize a provider or fetch data.

## LH invocation

Use `lh-work-unit.example.json` as the target-repo work unit. Copy it into a
caller-owned run directory outside the LH checkout, replace `target_repo` with
this repo's absolute path, and obtain human approval for the exact work-unit
digest before invoking LH's report-only external runner.

The engine itself does not create approvals, evidence ledgers, or retries.
Those remain owned by the driver platform and the human gate.

The human-selected P5 history-admission specification is documented in
[`docs/tqe-p5-history-admission-proposal.md`](../docs/tqe-p5-history-admission-proposal.md)
and its phase/driver amendment is documented in
[`docs/tqe-p5-phase-driver-contract-amendment.md`](../docs/tqe-p5-phase-driver-contract-amendment.md).
The amendment is approved for P5 work-unit preparation but inactive for general
provider runtime; the current L1/report-only contract still governs until the
exact P5 work-unit digest is separately approved.

P5 is registered as the next-phase execution target. The read-only
`p5_0_read_only_contract_preflight` passed; the current step
`p5_2_validate_preapproved_corporate_action_fixture` passed independently,
while P5.1 remains fail-closed at `source_contract_blocked`. Its machine-readable result is
[`workflow/tqe-p5-twse-source-contract.json`](tqe-p5-twse-source-contract.json).
[`scripts/p5_execution_target.py`](../scripts/p5_execution_target.py) reports
the block without fetching data, writing snapshots, or altering the current
driver authority.

The K2-K5 K-line analysis approval package is documented in
[`workflow/k2-k5-approval-package.json`](k2-k5-approval-package.json) with a
human-readable review at
[`docs/k2-k5-approval-package.md`](../docs/k2-k5-approval-package.md). It is
approved for execution and its K2–K5 stage evidence all passed; the
consolidated final acceptance
([`workflow/evidence/k2-k5-final.acceptance.json`](evidence/k2-k5-final.acceptance.json))
was accepted by JY on 2026-07-16 for user-owned K6 review. The package used a
bounded per-stage loop and stopped after three consecutive acceptance
failures. After one human approval before K2, a passing
evidence gate automatically advanced K2 through K5; K5 was followed by one
consolidated human acceptance, and K6 remains user-owned.

## Promotion rule

The workflow still does not authorize live trading, write-capable actions,
deployment, or dashboard-only financial logic. LH remains the external driver;
the target repo owns its source, fixtures, tests, and evidence references.
