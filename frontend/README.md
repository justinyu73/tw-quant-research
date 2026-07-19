# TQR desktop shell

This is the Tauri desktop shell for the local, read-only TW Quant Research
application. From `frontend/`, install the local Tauri CLI dependencies and
run:

```sh
npm install
npm run tauri:dev
```

The shell starts the `tqe-sidecar` external binary, which reads only
`tests/fixtures/k6a` and `tests/fixtures/k6b` and binds to `127.0.0.1`.

For a local target-specific bundle, install PyInstaller in the build
environment, build the sidecar, then build Tauri from this directory:

```sh
python3 ../scripts/build_tqe_sidecar.py --target TARGET_TRIPLE
npm run tauri:build -- --target TARGET_TRIPLE
```

Use one of the release target triples in
`config/open-source-release.json`. The tracked Linux development wrapper is
not replaced unless `--force-existing` is explicitly supplied.

The Windows and macOS release matrix is defined in
`.github/workflows/desktop-release.yml`. The app remains research-only:
there is no provider call, live feed, broker route, order placement, or
automatic execution. Version tags create a draft GitHub Release with the
Windows installers, macOS disk images, and clean public source archive; see
`docs/desktop-release.md` for the human install/launch gate.
