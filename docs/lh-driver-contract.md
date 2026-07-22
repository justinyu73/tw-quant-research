# LH Driver Contract

## Boundary

`tw-quant-engine` is the target project. Loop-Hybrid is the external driver
platform that supplies bounded work and runs an approved check. LH does not
copy, cache, or own this repository's source files.

The current contract is L1/report-only:

- the target repository remains the execution authority;
- the work unit, approval, evidence, and attempt ledger are caller-owned;
- the only declared operation is the deterministic read-only preflight;
- no provider invocation, data download, patch, commit, promotion, or order
  placement is authorized;
- a passing preflight does not mean the framework choice or product is accepted.

## Declared entrypoint

From an external caller-owned run directory, create a work unit based on
`workflow/lh-work-unit.example.json` and set `target_repo` to the absolute path
of this repository. The currently allowed check is:

```json
{
  "id": "engine-preflight",
  "argv": ["python3", "scripts/lh_preflight.py"],
  "timeout_seconds": 60,
  "read_only": true
}
```

The LH runner must receive the work unit, exact human approval, existing
evidence, and append-only attempt ledger through its external paths. The LH
runner is invoked from the LH checkout, while all input and ledger files stay
outside the LH checkout and outside this repo's source tree.

## Workflow states

```text
requested
  -> human_approved
  -> preflight_passed
  -> awaiting_framework_review
  -> framework_selected      (human decision required)
  -> data_contract_admitted  (separate approved work unit)
```

Historical note (pre-S1): the repository was intentionally stopped at
`framework_selection_pending` until the comparison documents were complete,
and no workflow file silently promoted either state. That stop has since
been cleared through the approved stage gates: as of 2026-07-22 all S1–S9
and K2–K6 acceptance evidence records status pass (`workflow/evidence/`),
and `workflow/engine-manifest.json` records `current_phase:
p5_history_admission`. Every state transition went through its own human
gate; none was a silent promotion.

## Evidence shape

`scripts/lh_preflight.py` prints one JSON object to stdout and writes nothing.
The output is suitable for the caller to hash and place in its evidence
artifact. The output only proves repository-shape and contract checks; it does
not prove data quality, investment performance, or framework suitability.

## P5 amendment status

The human-selected P5 phase/driver amendment is documented in
[`docs/tqe-p5-phase-driver-contract-amendment.md`](tqe-p5-phase-driver-contract-amendment.md).
It is approved for P5 work-unit preparation but does not activate general
provider runtime or change the current L1 authority. P5.1 is currently
`source_contract_blocked`; the exact source result is recorded in
[`workflow/tqe-p5-twse-source-contract.json`](../workflow/tqe-p5-twse-source-contract.json).
P5 still requires an exact official bounded bulk contract, work-unit digest,
and host-egress admission before any public EOD request can occur.
