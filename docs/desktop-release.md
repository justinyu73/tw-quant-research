# Desktop release and download contract

TW Quant Research is distributed as a local, read-only desktop application.
The public download surface is the GitHub Release for the matching `vX.Y.Z`
tag; the repository source remains the authority for the app and its evidence.

## Release flow

1. Keep `frontend/src-tauri/tauri.conf.json` and the release tag on the same
   version, for example `0.1.3` and `v0.1.3`.
2. Push the version tag. `desktop-release.yml` runs the source audit, unit
   tests, deterministic preflight, and dashboard preview first.
3. The build matrix creates target-specific sidecars and bundles for:
   `x86_64-pc-windows-msvc`, `x86_64-apple-darwin`, and
   `aarch64-apple-darwin`.
4. GitHub creates a draft release containing the Windows installers, macOS
   disk images, and the clean public source archive.
5. A human installs and launches both Windows and macOS artifacts, then
   publishes the draft release if the checks pass.

The download page is:

`https://github.com/justinyu73/tw-quant-research/releases/latest`

## Unsigned terminal download and install

These commands assume the release has been published rather than left as a
draft. Replace `v0.1.3` with the release tag you are installing. The release
contains `SHA256SUMS.txt`; verify it before opening an unsigned installer.

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
$Release = "v0.1.3"
$Download = Join-Path $env:USERPROFILE "Downloads\TQR-$Release"
New-Item -ItemType Directory -Force $Download | Out-Null
gh release download $Release --repo $Repo --pattern "*.msi" --pattern "SHA256SUMS.txt" --dir $Download

$Installer = Get-ChildItem $Download -Filter *.msi | Select-Object -First 1
$Expected = (Select-String -Path (Join-Path $Download "SHA256SUMS.txt") -Pattern ([regex]::Escape($Installer.Name) + '$')).Line.Split()[0]
$Actual = (Get-FileHash -Algorithm SHA256 $Installer.FullName).Hash.ToLowerInvariant()
if ($Actual -ne $Expected.ToLowerInvariant()) { throw "SHA-256 mismatch: $($Installer.Name)" }

Unblock-File -Path $Installer.FullName
Start-Process msiexec.exe -Verb RunAs -Wait -ArgumentList "/i `"$($Installer.FullName)`""
```

If the MSI is unavailable, download and launch the NSIS installer instead:

```powershell
gh release download $Release --repo $Repo --pattern "*-setup.exe" --dir $Download
$Installer = Get-ChildItem $Download -Filter *-setup.exe | Select-Object -First 1
Unblock-File -Path $Installer.FullName
Start-Process -FilePath $Installer.FullName -Verb RunAs -Wait
```

Windows SmartScreen may still warn because the build is unsigned. Only choose
`More info` → `Run anyway` after the SHA-256 check passes and the source tag is
the expected one.

### macOS Terminal: download, verify, and install DMG

Use the Intel pattern on an Intel Mac and the Apple Silicon pattern on an M1+
Mac:

```sh
REPO="justinyu73/tw-quant-research"
RELEASE="v0.1.3"
DOWNLOAD="$HOME/Downloads/tqr-$RELEASE"
mkdir -p "$DOWNLOAD"
cd "$DOWNLOAD"

# Intel Mac:
gh release download "$RELEASE" --repo "$REPO" --pattern '*_x64.dmg' --pattern 'SHA256SUMS.txt'

# Apple Silicon Mac: use this instead of the Intel command above.
# gh release download "$RELEASE" --repo "$REPO" --pattern '*_aarch64.dmg' --pattern 'SHA256SUMS.txt'

DMG="$(find . -maxdepth 1 -name '*.dmg' -print -quit)"
grep -F "  $(basename "$DMG")" SHA256SUMS.txt | shasum -a 256 -c -

MOUNT_POINT="$(hdiutil attach -nobrowse -readonly "$DMG" | sed -n 's#^.*\(/Volumes/.*\)$#\1#p' | head -n 1)"
APP_SOURCE="$(find "$MOUNT_POINT" -maxdepth 1 -name '*.app' -print -quit)"
sudo ditto "$APP_SOURCE" "/Applications/TW Quant Research.app"
hdiutil detach "$MOUNT_POINT"
open "/Applications/TW Quant Research.app"
```

If macOS blocks the unsigned app, first use System Settings → Privacy &
Security → Open Anyway. After the SHA-256 check has passed, the terminal
alternative is:

```sh
sudo xattr -dr com.apple.quarantine "/Applications/TW Quant Research.app"
open "/Applications/TW Quant Research.app"
```

Removing the quarantine attribute is an explicit security exception for this
app; it is not a substitute for verifying `SHA256SUMS.txt`.

## Product boundary

The app reads the committed offline fixtures through a loopback sidecar. It
does not call providers, place orders, connect to a broker, or execute an
automatic strategy. The release workflow does not add signing credentials or
private data. Code signing and notarization are separate release decisions;
unsigned builds may show platform security warnings until those decisions are
approved and configured.

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
