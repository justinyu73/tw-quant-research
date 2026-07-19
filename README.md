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
python3 scripts/export_open_source_source.py
```

Windows/macOS 桌面 build 由
[`desktop-release.yml`](.github/workflows/desktop-release.yml) 以 target-specific
sidecar 產生；公開 release 前仍須人為選定軟體授權並完成兩個平台的實機啟動驗收。

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
