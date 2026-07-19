# Open-source release scope

This is the publication boundary for the TW Quant Research application. The
repository is licensed under MIT; publication still requires the strict audit
and the human platform launch checks to pass.

## Public product

The public product is a local research application with a Tauri desktop shell,
a Python sidecar, bundled local fixtures, a read-only loopback API, and a
local watchlist file. The app does not provide live quotes, broker access,
order placement, automatic execution, credentials, or a provider runtime.

The Windows and macOS artifacts are built from the target-specific sidecar
outputs listed in `config/open-source-release.json`. The sidecar contains only
the committed K6 fixtures used by the research preview.

## Excluded from the source publication

The public source package excludes `AGENTS.md` and the design-production
records listed in the release manifest. Those files describe internal agent
authority, visual exploration, requirements review, UI/UX planning, or
implementation slicing; they are not required to run, test, or understand the
released product boundary.

The exclusion list is machine-checked by:

```sh
python3 scripts/open_source_audit.py
```

The actual clean source archive is generated with:

```sh
python3 scripts/export_open_source_source.py
```

It uses the same manifest, so excluded records are absent from the archive
rather than merely undocumented.

## Release blockers

The strict audit checks that `LICENSE`, `LICENSE.md`, or `COPYING` is present.
A passing local functional test does not replace the source and platform
release checks.

The final release also requires human launch checks for one Windows artifact
and one macOS artifact. CI can build and inspect the bundles, but it cannot
replace those platform checks.
