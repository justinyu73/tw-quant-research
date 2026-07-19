# S8 — Read-only local product view

S8 assembles the existing S4 product rows, S6 feature rows, and S7 research
backtest result into a deterministic in-memory read model. It does not create
financial formulas, initialize a server, call a provider, or write orders.

The view retains `quality`, `provenance`, formula versions, source snapshot
IDs, the requested `as_of`, and evidence links. Product rows are visible only
when their trading/period date and source `available_at` are visible at the
cutoff. Incomplete unadmitted or invalid rows remain visible so their failure
state is inspectable. Features and backtest results are similarly filtered by
their own as-of metadata.

The in-memory route dispatcher permits only `GET` for `/`, `/health`,
`/products`, `/features`, `/backtest`, and `/evidence`. Write methods and
unknown routes return deterministic errors. This is a read-only product
boundary, not a dashboard or deployment acceptance.
