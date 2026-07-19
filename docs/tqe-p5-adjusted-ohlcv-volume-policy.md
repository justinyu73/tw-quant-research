# TQE adjusted OHLCV and volume policy v1

This policy is defined before P5.4 so the later TWSE normalization step has no
hidden adjustment fork. It does not admit a provider or relax the P5.1 source
contract.

## Canonical rule

For each bar and each corporate action visible at `as_of`:

- Apply the action only when `trading_date < ex_date`.
- Keep raw `open`, `high`, `low`, `close`, and `volume` unchanged.
- Emit adjusted fields separately with price and volume factors, policy
  version, and contributing action snapshot IDs.
- An action with `available_at > as_of` is invisible and contributes no factor.
- Multiple visible actions compose in deterministic source order by
  `(ex_date, snapshot_id)`.

## Action and volume semantics

| Action class | Price rule before ex-date | Volume rule before ex-date | Admission requirement |
| --- | --- | --- | --- |
| `split`, `reverse_split`, `bonus_issue` | `price *= factor` | `volume /= factor` | Positive factor and explicit share-count semantics |
| `cash_dividend` | `price *= factor` | volume unchanged | Positive price factor and explicit cash amount/currency |
| Any other action type | Not derived | Not derived | `unadmitted` until a new policy is approved |

The split rule preserves traded-value scale: `adjusted_price * adjusted_volume`
equals `raw_price * raw_volume` for the price/volume fields affected by the
same action. A factor must be finite and strictly positive. Zero, negative,
missing, ambiguous, or conflicting factors fail closed.

## Output contract

The normalized bar remains raw. A separate derived result must contain:

```json
{
  "raw_ohlcv": {"open": 100, "high": 101, "low": 99, "close": 100, "volume": 1000},
  "adjusted_ohlcv": {"open": 50, "high": 50.5, "low": 49.5, "close": 50, "volume": 2000},
  "price_adjustment_factor": 0.5,
  "volume_adjustment_factor": 2.0,
  "adjustment_policy": "tqe-adjusted-ohlcv-volume/v1",
  "action_snapshot_ids": ["s5-action-snapshot"]
}
```

The derived result is not admitted when source provenance, action visibility,
factor semantics, currency, or the contributing snapshot digest is missing.
No forward fill, inferred action, retrieval-time substitution, or silent
mutation of raw OHLCV is permitted.

## P5 boundary

P5.2 validates the independent action fixture against this policy. P5.4 may
apply it after the exact TWSE bulk source, calendar binding, raw evidence, and
work-unit digest are admitted. This policy does not make P5.1 pass.
