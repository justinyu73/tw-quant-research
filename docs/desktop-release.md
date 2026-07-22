# Desktop release and download contract

TW Quant Research is distributed as a local research desktop application. Its
market and research views are read-only; the only write-capable data action is
the explicit, bounded TWSE local-history update described below.
The public download surface is the GitHub Release for the matching `vX.Y.Z`
tag; the repository source remains the authority for the app and its evidence.

## Release flow

1. Keep `frontend/src-tauri/tauri.conf.json` and the release tag on the same
   version, for example `0.2.0` and `v0.2.0`.
2. Push the version tag. `desktop-release.yml` runs the source audit, unit
   tests, deterministic preflight, and dashboard preview first.
3. The build matrix creates target-specific sidecars and bundles for:
   `x86_64-pc-windows-msvc`, `x86_64-apple-darwin`, and
   `aarch64-apple-darwin`. Bundles are minisign-signed when the
   `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   repository secrets are configured (required for in-app updates).
4. GitHub creates a draft release containing the Windows installers, macOS
   disk images, the signed updater payloads (`*-setup.exe` + `.sig`,
   `*.app.tar.gz` + `.sig`), `latest.json`, the clean public source archive,
   and `SHA256SUMS.txt`. Build internals such as unpacked `.app` contents,
   icons, scripts, and plist files are not published as release downloads.
5. A human installs and launches both Windows and macOS artifacts, then
   publishes the draft release if the checks pass.

The download page is:

`https://github.com/justinyu73/tw-quant-research/releases/latest`

## In-app updates

Since 0.2.0 the desktop app can update itself: Settings → 應用程式更新 →
檢查更新. The mechanism is intentionally narrow:

- The check runs in the Rust shell (`check_app_update` /
  `install_app_update` commands, tauri-plugin-updater), never in the browser
  bundle — the loopback-only research surface is unchanged. It is a
  user-triggered, anonymous, read-only request to the public GitHub release
  listed in `plugins.updater.endpoints` (`releases/latest` → `latest.json`).
- Update payloads are minisign-signed at build time; the app verifies the
  signature against the public key embedded in `tauri.conf.json` before
  installing, then restarts. The bundled sidecar is stopped during install
  (Windows file locking) and revived if the install fails.
- Signing requires the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The private key and its password live
  outside the repository and must never be committed.
- The release job assembles `latest.json` (per-platform asset API URLs plus
  signatures for `windows-x86_64`, `darwin-x86_64`, `darwin-aarch64`) and
  uploads it to the draft release after the installers.
- Browser preview shows 瀏覽器預覽不提供更新; updates are a desktop-only
  feature.

## Unsigned terminal download and install

These commands assume the release has been published rather than left as a
draft. Replace `v0.1.8` with the release tag you are installing. The release
contains `SHA256SUMS.txt`; verify it before opening an unsigned installer.

The macOS Finder message `TW Quant Research 已損毀，無法打開` can be caused by
Gatekeeper quarantining an unsigned or non-notarized app; it does not by itself
prove that the DMG is corrupt. Do not remove quarantine until the checksum
matches the published `SHA256SUMS.txt`.

### Prerequisites

Install GitHub CLI and authenticate once:

```sh
# macOS
brew install gh

# Windows PowerShell (run separately from the macOS command)
winget install --id GitHub.cli

gh auth login
```

### Windows PowerShell: download, verify, and install MSI

```powershell
$Repo = "justinyu73/tw-quant-research"
$Release = "v0.1.8"
$Download = Join-Path $env:USERPROFILE "Downloads\TQR-$Release"
New-Item -ItemType Directory -Force $Download | Out-Null
gh release download $Release --repo $Repo --pattern "TQR-Windows-x64.msi" --pattern "SHA256SUMS.txt" --dir $Download

$Installer = Get-ChildItem $Download -Filter *.msi | Select-Object -First 1
$Expected = (Select-String -Path (Join-Path $Download "SHA256SUMS.txt") -Pattern ([regex]::Escape($Installer.Name) + '$')).Line.Split()[0]
$Actual = (Get-FileHash -Algorithm SHA256 $Installer.FullName).Hash.ToLowerInvariant()
if ($Actual -ne $Expected.ToLowerInvariant()) { throw "SHA-256 mismatch: $($Installer.Name)" }

Unblock-File -Path $Installer.FullName
Start-Process msiexec.exe -Verb RunAs -Wait -ArgumentList "/i `"$($Installer.FullName)`""
```

If the MSI is unavailable, download and launch the NSIS installer instead:

```powershell
gh release download $Release --repo $Repo --pattern "TQR-Windows-x64-setup.exe" --dir $Download
$Installer = Get-ChildItem $Download -Filter *-setup.exe | Select-Object -First 1
Unblock-File -Path $Installer.FullName
Start-Process -FilePath $Installer.FullName -Verb RunAs -Wait
```

Windows SmartScreen may still warn because the build is unsigned. Only choose
`More info` → `Run anyway` after the SHA-256 check passes and the source tag is
the expected one.

### macOS Terminal: download, verify, install, and clear quarantine

The command below selects Intel or Apple Silicon automatically. It verifies the
DMG before copying the app and then clears the quarantine attribute that causes
the Finder “damaged” message on an unsigned build:

```sh
REPO="justinyu73/tw-quant-research"
RELEASE="v0.1.8"
DOWNLOAD="$HOME/Downloads/tqr-$RELEASE"
mkdir -p "$DOWNLOAD"
case "$(uname -m)" in
  arm64) ASSET="TQR-macOS-Apple-Silicon.dmg" ;;
  x86_64) ASSET="TQR-macOS-Intel.dmg" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

gh release download "$RELEASE" --repo "$REPO" \
  --pattern "$ASSET" --pattern 'SHA256SUMS.txt' --dir "$DOWNLOAD"
DMG="$DOWNLOAD/$ASSET"
grep -F "  $ASSET" "$DOWNLOAD/SHA256SUMS.txt" | shasum -a 256 -c -

MOUNT_POINT="$(hdiutil attach -nobrowse -readonly "$DMG" | sed -n 's#^.*\(/Volumes/.*\)$#\1#p' | head -n 1)"
APP_SOURCE="$(find "$MOUNT_POINT" -maxdepth 1 -name '*.app' -print -quit)"
APP_PATH="/Applications/TW Quant Research.app"
sudo ditto "$APP_SOURCE" "$APP_PATH"
hdiutil detach "$MOUNT_POINT"
sudo xattr -dr com.apple.quarantine "$APP_PATH"
open "$APP_PATH"
```

If you prefer the GUI, after the checksum passes open the app once, then use
System Settings → Privacy & Security → Open Anyway. Removing the quarantine
attribute is an explicit security exception for this app; it is not a
substitute for verifying `SHA256SUMS.txt`.

## Desktop local-data update

After launching the desktop app:

1. Add one or more listed TWSE stocks to `我的自選`.
2. On `市場首頁`, find `更新台股資料` and choose `全部自選` or `目前個股`.
3. Select `近 1 年`, `近 2 年`, or `近 3 年`, then press the matching update
   button.
4. Review the per-stock result list, then return to `行情` to confirm the K-line
   history and technical indicators use the updated local snapshot.

This action is manual and limited to the explicit watchlist or selected TWSE
listed equity. Raw responses are kept under the app data directory's
`raw/twse/<symbol>/`, while normalized daily snapshots are kept under `k6a/`;
browser preview has no download capability. TPEx, full-market, real-time, and
background refresh are not enabled by this button.

## Product boundary

The app reads the committed offline fixtures through a loopback sidecar. At
startup the desktop shell binds `127.0.0.1:0` to reserve a free port, passes it
to the sidecar via `TQE_SIDECAR_PORT`, and the front end discovers the actual
URL through the `sidecar_url` command, so a fixed port clash with another
local app cannot break the desktop build (dev/preview flows still pin the port
via `TQE_SIDECAR_URL`). It
does not refresh providers in the background, place orders, connect to a broker,
or execute an automatic strategy. In the desktop app, a human can explicitly
download the selected TWSE listed equity for 1, 2, or 3 trailing years; raw
responses and normalized K6a snapshots are saved in the app data directory.
Browser preview remains fixture-only, and TPEx/full-market download is not
enabled. The release workflow does not add signing credentials or private data.
Code signing and notarization are separate release decisions; unsigned builds
may show platform security warnings until those decisions are approved and
configured.

## Local verification

From the repository root:

```sh
python3 -B -m unittest discover -s tests -v
python3 scripts/lh_preflight.py
python3 scripts/run_dashboard_preview.py
```

For a local target build, install PyInstaller and run from `frontend/`:

```sh
python3 ../scripts/build_tqe_sidecar.py --target TARGET_TRIPLE
npm run tauri:build -- --target TARGET_TRIPLE
```
