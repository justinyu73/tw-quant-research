# Quant Framework Comparison

Status: prepared for human confirmation
Snapshot: 2026-07-15
Scope: Taiwan-stock fundamental + valuation + factor + market-regime research and backtesting

## Decision summary

No single candidate cleanly covers Taiwan data provenance, fundamental and
valuation factors, regime classification, factor validation, portfolio risk,
walk-forward testing, and fixed-format reporting. The best fit is a modular
composition with `tw-quant-engine` retaining the canonical data and strategy
contracts.

The current TOP5 are:

1. [microsoft/qlib](https://github.com/microsoft/qlib) — primary research-platform candidate.
2. [polakowo/vectorbt](https://github.com/polakowo/vectorbt) — high-throughput research and portfolio-backtest candidate; license gate required.
3. [skfolio/skfolio](https://github.com/skfolio/skfolio) — portfolio/risk and walk-forward component.
4. [stefan-jansen/alphalens-reloaded](https://github.com/stefan-jansen/alphalens-reloaded) — factor IC, quantile, turnover, and tear-sheet component.
5. [cvxgrp/cvxportfolio](https://github.com/cvxgrp/cvxportfolio) — causality-aware portfolio backtest and transaction-cost component; GPL gate required.

TOP5 means retained for the next human-reviewed proof of concept. It does not
authorize a dependency, fork, data download, or production use.

## Evaluation method

Scores are engineering judgments for this project, not upstream claims. The
score considers:

- research fit for fundamentals, valuation, factors, and regime conditions;
- portfolio backtest, walk-forward, and out-of-sample support;
- risk and position-control extensibility;
- replaceable Taiwan data sources and data-lineage control;
- maintenance signal, license clarity, and integration cost.

`last push` is used as the maintenance signal because GitHub's `updated_at`
also changes for non-code metadata. Stars and forks are context only, not a
quality guarantee.

## Candidate matrix

| Repo | Primary role | License | Stars / forks | Last push | Fit / relevant capability | Decision | Score |
|---|---|---:|---:|---|---|---|---:|
| [microsoft/qlib](https://github.com/microsoft/qlib) | Quant research platform | MIT | 46,257 / 7,369 | 2026-04-22 | Data layer, workflow, models, backtest, portfolio analysis; modular components and custom workflows | TOP5 — Library, primary candidate | 88 |
| [polakowo/vectorbt](https://github.com/polakowo/vectorbt) | Fast research and portfolio backtest | Fair-code Apache 2.0 + Commons Clause; API SPDX is `NOASSERTION` | 8,316 / 1,077 | 2026-07-14 | Large parameter sweeps, portfolio analytics, signal/ranking tools, walk-forward support | TOP5 — Library after license review | 84 |
| [skfolio/skfolio](https://github.com/skfolio/skfolio) | Portfolio optimization and risk | BSD-3-Clause | 2,044 / 213 | 2026-07-15 | Scikit-learn API, risk measures, constraints, transaction costs, walk-forward and purged CV | TOP5 — Library component | 82 |
| [stefan-jansen/alphalens-reloaded](https://github.com/stefan-jansen/alphalens-reloaded) | Factor validation | Apache-2.0 | 609 / 135 | 2025-12-15 | Returns, IC, turnover, grouped/quantile analysis, factor tear sheets | TOP5 — Library component | 80 |
| [cvxgrp/cvxportfolio](https://github.com/cvxgrp/cvxportfolio) | Causal portfolio backtest and optimization | GPL-3.0 | 1,239 / 291 | 2026-04-27 | Multi-period optimization, transaction costs, causal forecasters, backtesting, parameter sweeps | TOP5 — Library after GPL review | 78 |
| [stefan-jansen/zipline-reloaded](https://github.com/stefan-jansen/zipline-reloaded) | Event-driven backtesting | Apache-2.0 | 1,836 / 310 | 2026-01-06 | Event-driven backtest, pandas/PyData integration, Python >=3.9, extensible data bundles | Fallback — Library/reference | 75 |
| [PyPortfolio/PyPortfolioOpt](https://github.com/PyPortfolio/PyPortfolioOpt) | Portfolio optimization | MIT | 5,853 / 1,146 | 2026-07-07 | Efficient frontier, Black-Litterman, HRP, CVaR/semivariance, constraints | Library component | 73 |
| [dcajasn/Riskfolio-Lib](https://github.com/dcajasn/Riskfolio-Lib) | Portfolio risk and optimization | BSD-3-Clause | 4,353 / 685 | 2026-06-22 | Broad risk measures, drawdown, factor-risk contribution, uncertainty sets, reports | Library component | 72 |
| [pmorissette/bt](https://github.com/pmorissette/bt) | Flexible strategy backtesting | MIT | 2,913 / 490 | 2026-07-03 | Composable Algo stacks, tree strategies, charts, statistics; README still labels it alpha | Reference only | 68 |
| [QuantConnect/Lean](https://github.com/QuantConnect/Lean) | Full trading engine | Apache-2.0 | 20,536 / 5,044 | 2026-07-14 | Event-driven backtest/live engine, Python and C#, CLI, broad asset and data ecosystem | Reference only — too broad for current scope | 66 |
| [ranaroussi/quantstats](https://github.com/ranaroussi/quantstats) | Portfolio analytics and reports | Apache-2.0 | 7,445 / 1,216 | 2026-06-19 | Sharpe, Sortino, drawdown, plots and reports; not a strategy/data engine | Library component if report needs justify it | 62 |
| [AI4Finance-Foundation/FinRL-Meta](https://github.com/AI4Finance-Foundation/FinRL-Meta) | Dataset and market environments | MIT | 1,908 / 752 | 2026-07-13 | Data processors and environments, useful CN/TW adapter references; RL-oriented | Reference modules only | 58 |
| [AI4Finance-Foundation/FinRL](https://github.com/AI4Finance-Foundation/FinRL) | Financial reinforcement learning | MIT | 15,734 / 3,431 | 2026-07-13 | Market environments, DRL agents, applications, several data sources including Taiwan examples | Reference only; not the current statistical-factor core | 55 |
| [mementum/backtrader](https://github.com/mementum/backtrader) | Event-driven backtesting | GPL-3.0 | 22,453 / 5,202 | 2024-08-19 | Mature strategy/backtest API and large community; weak fit for factor research and older code activity | Do not adopt as primary | 53 |
| [stefan-jansen/empyrical-reloaded](https://github.com/stefan-jansen/empyrical-reloaded) | Return and risk metrics | Apache-2.0 | 116 / 39 | 2025-12-12 | Alpha/beta, VaR, Sharpe/Sortino, rolling drawdown metrics | Reference/library only | 50 |
| [nautechsystems/nautilus_trader](https://github.com/nautechsystems/nautilus_trader) | Production event-driven trading engine | LGPL-3.0 | 24,708 / 3,169 | 2026-07-15 | Rust core, deterministic event model, research/live parity, multi-venue and live execution | Do not adopt in research MVP | 48 |
| [tensortrade-org/tensortrade](https://github.com/tensortrade-org/tensortrade) | Reinforcement-learning trading | Apache-2.0 | 6,567 / 1,261 | 2026-02-19 | Composable RL environments, action/reward/data-feed components, walk-forward tutorials | Do not adopt; RL is outside current core | 44 |
| [quantopian/alphalens](https://github.com/quantopian/alphalens) | Original factor analysis | Apache-2.0 | 4,380 / 1,330 | 2024-02-12 | IC, returns, turnover, grouped analysis; latest release shown as 2020 | Do not adopt; use reloaded fork instead | 40 |
| [quantopian/zipline](https://github.com/quantopian/zipline) | Original event-driven backtesting | Apache-2.0 | 19,978 / 5,015 | 2024-02-13 | Historical event-driven engine; successor exists and is maintained separately | Do not adopt; use zipline-reloaded only as fallback | 35 |

## Key findings

### 1. Qlib is the strongest primary candidate, not an automatic fork

Qlib is the only candidate in this list that natively presents a broad chain
from data processing and model training through backtesting, alpha research,
risk modeling, portfolio optimization, and execution. Its components are
designed to be loosely coupled, and it supports custom research workflows.

The cost is that Qlib's data representation and ML-oriented workflow are
substantial. Taiwan corporate actions, point-in-time fundamentals, EPS
definitions, and provenance must remain under our own canonical contracts;
Qlib should consume an adapter rather than become the authority for raw data.

### 2. VectorBT is highly useful but has a real license gate

VectorBT is attractive for rapid factor/parameter sweeps and portfolio
analytics. Its repository README describes the community edition as
fair-code Apache 2.0 with Commons Clause, including a restriction on selling
products or services primarily consisting of the software. This is not the
same operational decision as plain MIT or Apache-2.0, so it remains TOP5 only
pending a license decision.

### 3. Factor validation should be a first-class component

Alphalens-reloaded maps directly to the required Rank IC, IC mean, turnover,
grouped returns, and quantile-spread checks. It is not a backtesting engine;
it should receive a canonical factor-data contract from this repo.

### 4. Portfolio optimization and backtesting are separate concerns

Skfolio, Cvxportfolio, PyPortfolioOpt, and Riskfolio-Lib are strong portfolio
components but do not replace the engine's Taiwan data layer or factor
research contract. Cvxportfolio has the closest fit for causal multi-period
portfolio backtesting and transaction costs, but its GPL-3.0 license requires
an explicit legal/product decision.

### 5. RL and live-trading engines are out of scope for this phase

FinRL, FinRL-Meta, TensorTrade, Lean, and NautilusTrader are valuable
references for environments, execution, or production systems. They do not
match the immediate requirement to validate fundamental/valuation factors and
conditioned probability signals before enabling live or automatic trading.

## Exclusion record

- Pure dashboard projects were not retained as framework candidates.
- Pure technical-indicator libraries were not retained as primary candidates.
- The original Quantopian Alphalens and Zipline repositories were not retained
  because their current code/release activity is materially older than their
  maintained successors.
- No candidate with an unclear license is promoted to dependency status.

## Sources

The metadata table was collected from the official GitHub REST repository
metadata on 2026-07-15. Capability statements were checked against the
official repository README or project documentation. Links in the table are
the source records and should be rechecked before dependency installation.
