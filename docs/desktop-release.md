# Desktop release and download contract

TW Quant Research is distributed as a local research desktop application. Its
market and research views are read-only; the only write-capable data action is
the explicit, bounded TWSE local-history update described below.
The public download surface is the GitHub Release for the matching `vX.Y.Z`
tag; the repository source remains the authority for the app and its evidence.

## Release flow

1. Keep `frontend/src-tauri/tauri.conf.json` and the release tag on the same
   version, for example `0.1.8` and `v0.1.8`.
2. Push the version tag. `desktop-release.yml` runs the source audit, unit
   tests, deterministic preflight, and dashboard preview first.
3. The build matrix creates target-specific sidecars and bundles for:
   `x86_64-pc-windows-msvc`, `x86_64-apple-darwin`, and
   `aarch64-apple-darwin`.
4. GitHub creates a draft release containing only the Windows installers, macOS
   disk images, the clean public source archive, and `SHA256SUMS.txt`. Build
   internals such as `.app` contents, icons, scripts, and plist files are not
   published as release downloads.
5. A human installs and launches both Windows and macOS artifacts, then
   publishes the draft release if the checks pass.

The download page is:

`https://github.com/justinyu73/tw-quant-research/releases/latest`

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

The app reads the committed offline fixtures through a loopback sidecar. It
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
