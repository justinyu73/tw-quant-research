# TQE P4 research-only runtime boundary

P4 closes the currently approved research surface and records the seam for
future runtime packages.

## Current capability matrix

| Capability | Current status | Boundary |
| --- | --- | --- |
| Offline K6 read model | available | committed fixtures and loopback GET only |
| Chart cockpit and drawings | available | session-local UI; no provider or cloud sync |
| Grouped watchlist / ScreenSpec | available | session-local group; flat v1 watchlist save only |
| Research StrategySpec | visible, not admitted | human review; no execution semantics |
| Realtime or delayed provider feed | deferred | separate data-source approval and evidence |
| Alerts / notifications | deferred | separate event and delivery contract |
| News / social / cloud workspace | deferred | separate source, privacy, and persistence approval |
| Paper trading / broker connector | deferred | separate credential and order authority gate |
| Automatic order placement | prohibited in this phase | no route, command, or UI control exists |

The audit command is deterministic and repository-read-only:

```sh
python3 scripts/p4_research_closure.py
```

It checks the manifest, browser transport restrictions, sidecar GET-only
surface, Tauri command scope, and the StrategySpec `not_admitted` status. A
passing audit is mechanical boundary evidence; it is not human approval for a
provider, alert, broker, or write-capable workflow.

## Promotion rule

P5 must begin with a new contract and human approval for the exact runtime
capability. It must not be enabled by changing a frontend button or by
interpreting a research backtest as an order authorization.
