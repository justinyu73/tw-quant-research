# TQE P0 acceptance

P0 closes the current desktop interaction gap without adding a market-data
provider or inventing historical bars.

## Included

- The watchlist and K-line instrument controls use the same local Symbol Search
  pattern. Search accepts instrument id, symbol, display name, or market and
  returns a bounded result list instead of rendering the full catalog as a
  native select.
- Adding a symbol is an explicit two-step action: choose a search result, then
  click `加入自選`. The existing local JSON contract remains schema v1 and
  save remains an explicit user action.
- The Tauri watchlist writer validates before writing and commits through a
  temporary file plus rename. Rust tests cover a successful write and
  preservation of the previous file after validation failure.

## Local verification

From the repository root:

```sh
python3 -B -m unittest discover -s tests -v
python3 scripts/lh_preflight.py
node tests/dashboard-core.test.cjs
node --check ui/dashboard/app.js
cargo test --manifest-path frontend/src-tauri/Cargo.toml
```

For the desktop-only bridge acceptance, run from `frontend/` on a machine with
the Tauri shell available:

```sh
npm run tauri:dev
```

Then search for `2330`, choose the result, add it to the watchlist, click
`儲存自選清單`, restart the app, and confirm the row is restored. The browser
preview intentionally reports that it is not persistence-capable and disables
the save button; it must not be treated as Tauri bridge evidence.

## Boundary

P0 does not claim that the current fixture has sufficient K-line history. The
existing quality state and provenance fields remain authoritative until P1
admits a deeper historical read model.
