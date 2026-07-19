# Phase 1 — Framework Selection

## Objective

Choose a maintainable research/backtesting base for the Taiwan stock strategy
engine before implementing factors or a dashboard.

## Required comparison

Compare at least 15 public repositories and record, for each candidate:

- license clarity and compatibility;
- recent maintenance activity;
- Python support;
- factor research and portfolio construction;
- walk-forward and out-of-sample support;
- custom Taiwan data-source adapters;
- report and chart output;
- import or fork cost;
- known look-ahead, survivorship, corporate-action, and data-lineage risks.

Exclude pure dashboards, pure technical-indicator libraries, abandoned
projects, and repositories with unclear licensing.

## Decision output

The phase must produce:

- `docs/quant-framework-comparison.md`
- `docs/recommended-architecture.md`

Each TOP5 candidate must be classified as one of:

- direct fork;
- library dependency;
- reference selected modules only;
- do not adopt.

## Stop condition

After the two documents are complete, stop and request human confirmation.
No Dashboard, real-money order path, or broad strategy implementation belongs
in this phase.
