# Recommended Architecture

Status: recommendation prepared; human confirmation required before Phase 2
Decision style: modular composition, no framework fork yet

## Recommendation

Keep `tw-quant-engine` as the product and data-contract authority. Do not fork
a monolithic framework in Phase 1. Run a bounded proof of concept with the
following candidate composition:

```text
                    tw-quant-engine
             canonical data + strategy contracts
                         |
       +-----------------+------------------+
       |                 |                  |
       v                 v                  v
   Qlib adapter     factor validation    portfolio/risk
   (primary)        Alphalens-reloaded   skfolio
                    (TOP5 component)     or Cvxportfolio*
       |                 |                  |
       +-----------------+------------------+
                         v
                 backtest + fixed reports

* Cvxportfolio remains conditional on GPL-3.0 acceptance.
```

VectorBT is a parallel candidate for high-throughput research sweeps, not a
required core dependency. Its Commons Clause must be resolved before use in a
product workflow.

## Role decisions

| Candidate | Proposed use | Why | Boundary |
|---|---|---|---|
| Qlib | Primary research-platform candidate | Broad data/workflow/model/backtest/analysis chain and custom workflow APIs | Consume our canonical data adapter; do not let Qlib's raw format define Taiwan provenance |
| VectorBT | Fast research/backtest candidate | Parameter sweeps, signal tooling, portfolio analytics, walk-forward utilities | License review; use for reproducible research jobs, not live trading |
| Alphalens-reloaded | Factor validation library | Direct support for IC, quantile, grouped, turnover and factor tear sheets | Receives point-in-time factor data; does not own labels or price adjustments |
| Skfolio | Preferred portfolio/risk component | BSD-3, scikit-learn API, constraints, transaction costs, walk-forward and purged CV | Portfolio layer only; not the data loader or market-regime authority |
| Cvxportfolio | Alternative portfolio/backtest component | Causal multi-period optimization and transaction-cost modeling | GPL-3.0 legal gate; do not install until approved |
| QuantStats / Empyrical-reloaded | Optional reporting metrics | Useful Sharpe, Sortino, drawdown, alpha/beta and report helpers | Reporting only; metrics must be independently cross-checked |
| Zipline-reloaded | Event-driven fallback | Apache-2.0 and mature event-driven model | Use only if the strategy needs event simulation that the selected research path cannot provide |

## Internal contracts that remain ours

The external libraries must not decide these product semantics:

1. **Point-in-time data** — every fundamental and estimate record carries an
   availability timestamp, source, revision, and digest.
2. **Corporate actions** — split, dividend, share-count, and adjusted-price
   policies are explicit and tested.
3. **EPS and valuation** — trailing/forward EPS, one-off earnings, fair PE,
   conservative PE, and safety margin use a versioned formula contract.
4. **Regime** — market regime features and labels are calculated without
   future information and remain separate from the factor library.
5. **Signal probability** — the target is a conditional outcome over fixed
   horizons; a single Z-score or moving-average event cannot trigger a buy.
6. **Portfolio limits** — single-name, sector, cash, liquidity, drawdown,
   overnight gap, and data-anomaly controls are enforced outside third-party
   optimizers.
7. **Evidence and reports** — every result records dataset revision, code
   revision, config digest, sample count, and failure attribution.

## Proposed Phase 2 proof of concept

Only after human confirmation:

1. Create a small, synthetic, point-in-time fixture covering prices,
   fundamentals, corporate actions, market index, and regime labels.
2. Build one `DataFrame`-level canonical adapter and provenance record.
3. Implement one factor-validation path using Alphalens-reloaded.
4. Run the same deterministic toy factor through Qlib and VectorBT adapters.
5. Run portfolio constraints through Skfolio; compare Cvxportfolio only if the
   GPL gate is approved.
6. Compare Rank IC, quantile spread, hit rate, Sharpe, Sortino, maximum
   drawdown, turnover, and sample counts across the paths.
7. Record integration cost, mismatch, and failure causes in a report.

The proof must not fetch live data, submit orders, build a Dashboard, or
promote a framework automatically.

## Data-source plan

The engine should expose adapters rather than hard-code one vendor:

```text
raw source -> immutable snapshot -> normalized table -> point-in-time view
          -> factor inputs -> regime inputs -> signal labels -> backtest
```

Initial adapter boundaries:

- Taiwan daily prices and volume;
- corporate actions and adjusted-price history;
- monthly revenue and quarterly fundamentals;
- consensus/forward EPS with revision timestamps;
- Taiwan weighted index and market breadth;
- margin, foreign futures positioning, volatility and external risk inputs.

No source is accepted merely because a framework can download it. The adapter
must preserve source attribution, availability time, request parameters, and
the raw snapshot digest.

## Human decision required

Please confirm these choices before Phase 2:

- Qlib as the primary platform candidate for the first POC;
- Alphalens-reloaded as the factor-validation candidate;
- Skfolio as the default portfolio/risk candidate;
- whether VectorBT's Commons Clause is acceptable for this project;
- whether Cvxportfolio's GPL-3.0 is acceptable for this project;
- whether the POC should include the Zipline-reloaded fallback.

Until that confirmation, the repository remains at
`awaiting_framework_review`; this document is an evidence-backed proposal,
not an adoption decision.
