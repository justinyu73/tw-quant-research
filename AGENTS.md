# Agent Instructions — TW Quant Research (TQR)

台股研究資料與人工評估工作台；本機、離線、read-only 的桌面研究 App。
這是唯一的開發 repo（單一開源框架）；個人資料一律存放於 App 本機資料目錄，
不進 repo。

## Build / Test

```sh
python3 -B -m unittest discover -s tests -v
python3 scripts/lh_preflight.py
python3 scripts/p4_research_closure.py
npm run dashboard:browser-smoke
python3 scripts/open_source_audit.py --strict
```

## Desktop App

```sh
cd frontend
npm run tauri:dev        # 桌面開發（WSL 若畫面不更新改用 npm run tauri:dev:wsl）
python3 scripts/serve_dashboard_app.py   # 純瀏覽器預覽（sidecar 固定 8767）
npm run tauri:build      # 打包（需先 python3 ../scripts/build_tqe_sidecar.py --target <triple>）
```

## 邊界

- research-only：無即時行情、無下單、無自動執行、無 provider 常駐呼叫。
- provider 資料只經人工啟動的 bounded ingestion；測試一律 offline fixture。
- 任何新產物（build output、截圖、資料檔）先確認被 .gitignore 才 commit。
