# TQE P5 phase/driver contract amendment

Status: `approved_for_p5_work_unit_preparation`, `provider_capability_not_active`

This amendment records the human-approved P5 boundary. It does not activate
the separate general provider-runtime workstream selected as 7B.

## P5 capability

The P5 work-unit may bind only:

- one active TWSE three-year bulk EOD slice;
- one official calendar GET in the same work-unit;
- a minimum of two named public GETs: `bulk_history` and `official_calendar`;
- a separately preapproved corporate-action fixture as an input, not an
  automatically fetched source;
- caller-owned raw evidence and repository-owned normalized fixture/digests;
- offline P1-P4 replay after capture.

The exact source endpoints, terms, calendar version, corporate-action fixture,
request parameters, and work-unit digest remain mandatory before host-egress
admission.

## Separate 7B workstream

General provider runtime is explicitly outside P5. It requires a separate
contract, capability matrix, credential boundary, egress policy, and acceptance
package. No P5 file or work-unit may promote it implicitly.

## Approval and evidence chain

1. Freeze exact source contracts and the corporate-action fixture reference.
2. Create the caller-owned work unit with the named GET purposes.
3. Hash the work unit and obtain approval for that exact digest.
4. Obtain host-egress admission and record the host receipt.
5. Preserve external raw evidence and repository normalized evidence.
6. Run offline P1-P4 gates.
7. Obtain human acceptance before the TPEx slice or 7B workstream.

The current L1 contract remains the authority for all capabilities not
explicitly admitted by this bounded P5 chain.
