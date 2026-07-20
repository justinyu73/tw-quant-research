# TW Quant Engine

英文 repo 名稱為 `tw-quant-engine`；產品定位是「台股研究資料與人工評估
工作台」。

本專案先建立免費官方／公開資料抓取、原始與標準化資料本地保存、財報與
公司故事追蹤，以及由人為啟動的可追溯評估計算。Dashboard 是唯讀研究
介面，不是即時看盤、交易或自動量化執行終端；資料不足時明確顯示不可用。
既有回測與指標程式僅作為人為選定資料後的研究元件，不代表自動策略服務。

完整邊界見 [`docs/tqe-product-boundary.md`](docs/tqe-product-boundary.md)。

目前 Dashboard 已可由 Tauri 殼包成桌面 app；開源發布範圍與排除的設計製作
紀錄見 [`docs/open-source-release-scope.md`](docs/open-source-release-scope.md)。

## 下載桌面 APP

桌面版下載頁：[`GitHub Releases`](https://github.com/justinyu73/tw-quant-research/releases/latest)。
版本 tag 觸發 Windows x64、macOS Intel 與 macOS Apple Silicon 打包，先建立
draft release，完成 Windows／macOS 人為安裝與啟動驗收後才公開發布。完整流程
與 unsigned 版本的終端機下載、SHA-256 校驗、安裝指令見
[`docs/desktop-release.md`](docs/desktop-release.md)。

### macOS 未簽章版快速安裝

macOS 若顯示「已損毀，無法打開」，在確認下載檔案的 SHA-256 正確後，使用
下列終端機指令；它會依 Mac 架構下載正確的 DMG、安裝到 `/Applications`，
並移除這個 unsigned app 的 quarantine 標記：

```sh
REPO="justinyu73/tw-quant-research"; RELEASE="v0.1.8"
case "$(uname -m)" in arm64) ASSET="TQR-macOS-Apple-Silicon.dmg";; x86_64) ASSET="TQR-macOS-Intel.dmg";; *) echo "不支援的 Mac 架構"; exit 1;; esac
DOWNLOAD="$HOME/Downloads/tqr-$RELEASE"; mkdir -p "$DOWNLOAD"
gh release download "$RELEASE" --repo "$REPO" --pattern "$ASSET" --pattern 'SHA256SUMS.txt' --dir "$DOWNLOAD"
grep -F "  $ASSET" "$DOWNLOAD/SHA256SUMS.txt" | shasum -a 256 -c -
MOUNT_POINT="$(hdiutil attach -nobrowse -readonly "$DOWNLOAD/$ASSET" | sed -n 's#^.*\(/Volumes/.*\)$#\1#p' | head -n 1)"
APP_PATH="/Applications/TW Quant Research.app"; sudo ditto "$(find "$MOUNT_POINT" -maxdepth 1 -name '*.app' -print -quit)" "$APP_PATH"; hdiutil detach "$MOUNT_POINT"
sudo xattr -dr com.apple.quarantine "$APP_PATH"; open "$APP_PATH"
```

將 `v0.1.8` 換成要安裝的 release tag；需先安裝並登入 GitHub CLI：
`brew install gh`、`gh auth login`。完整說明見
[`docs/desktop-release.md`](docs/desktop-release.md)。

### Windows x64 PowerShell 快速安裝

```powershell
$Repo="justinyu73/tw-quant-research"; $Release="v0.1.8"; $Download="$env:USERPROFILE\Downloads\TQR-$Release"
New-Item -ItemType Directory -Force $Download | Out-Null
gh release download $Release --repo $Repo --pattern "TQR-Windows-x64.msi" --pattern "SHA256SUMS.txt" --dir $Download
$Installer=Get-ChildItem $Download -Filter *.msi | Select-Object -First 1; $Expected=(Select-String (Join-Path $Download "SHA256SUMS.txt") ([regex]::Escape($Installer.Name)+'$')).Line.Split()[0]; $Actual=(Get-FileHash -Algorithm SHA256 $Installer.FullName).Hash.ToLowerInvariant()
if ($Actual -ne $Expected.ToLowerInvariant()) { throw "SHA-256 mismatch" }; Unblock-File $Installer.FullName; Start-Process msiexec.exe -Verb RunAs -Wait -ArgumentList "/i `"$($Installer.FullName)`""
```

## 與 LH 的關係

Loop-Hybrid（LH）是外部驅動／編排載體，角色類似 Hermes driver platform：

```text
LH work-unit + human approval + evidence + attempt ledger
                    |
                    v
        tw-quant-engine read-only workflow
                    |
                    v
       bounded result / evidence reference
```

LH 不保存本 repo 的檔案，也不取得產品接受或自動推進權限。本 repo 保留
自己的 source、config、workflow、tests 與報告契約。

## 目前階段

目前 S1–S8 已依批准包完成並留下可讀 evidence，S9 release hardening 正在
進行；整體仍維持 research-only：

1. Qlib 作為可替換研究引擎，版本固定為 `pyqlib==0.9.7`。
2. S1 只使用合成資料驗證 Qlib evaluation API；Qlib 不擁有台股資料契約。
3. S2–S4 的公開來源只以已批准、可追溯的資料邊界接入；S5–S8 使用
   offline fixture，`network=false`。
4. S9 只做離線 release hardening；不啟用 live trading、下單、部署或
   自動 promotion。

下一階段執行目標是 P5 free reference-data admission：以免費官方／公開來源
抓取 TWSE／TPEx EOD、交易日曆、財報或事件資料，保存 bounded raw/normalized
fixture，讓人為進行財報、估值與故事追蹤評估。付費訂閱、即時 feed、下單與
自動策略執行不在此階段；provider 抓取仍須等 exact source contract、
`as_of`、provenance 與 work-unit digest 的人為批准。

## 本地預檢

本 repo 的研究引擎無第三方 runtime dependency；Dashboard browser gate 的
開發依賴另由 npm lockfile 管理。先執行：

```sh
python3 -B -m unittest discover -s tests -v
python3 scripts/lh_preflight.py
```

開源前審查：

```sh
python3 scripts/open_source_audit.py
python3 scripts/open_source_audit.py --strict
# 在已匯出的 public tree 驗證排除檔案不存在
python3 scripts/open_source_audit.py --strict --public-tree
python3 scripts/export_open_source_source.py
```

Windows/macOS 桌面 build 由
[`desktop-release.yml`](.github/workflows/desktop-release.yml) 以 target-specific
sidecar 產生；公開 release 前仍須完成兩個平台的實機啟動驗收。尚未配置程式
簽章與 macOS notarization，下載的 unsigned build 可能出現平台安全性提示。
Finder 顯示「已損毀」也可能是 Gatekeeper 的 quarantine 提示，請先依
[`docs/desktop-release.md`](docs/desktop-release.md) 驗證 SHA-256，再執行
`sudo xattr -dr com.apple.quarantine "/Applications/TW Quant Research.app"`。

## 目錄

```text
config/      股票池與策略設定
docs/        架構、研究階段與 LH driver 契約
outputs/     可再生報告輸出，不提交原始資料
scripts/     可被 LH 呼叫的窄入口
src/         引擎程式碼
tests/       無網路、可重播測試
workflow/    engine manifest 與 LH work-unit 範本
```
