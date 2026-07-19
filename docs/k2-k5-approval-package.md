# K2～K5 K 線分析審批包

狀態：`approved_for_execution`；K2～K5 階段機械 gate 已完成，最終人工
acceptance 等待使用者決定。本文件是供人工審閱的版本；機讀規則位於
[`workflow/k2-k5-approval-package.json`](../workflow/k2-k5-approval-package.json)。

最終機械檢查 evidence：
[`workflow/evidence/k2-k5-final.acceptance.json`](../workflow/evidence/k2-k5-final.acceptance.json)。
其中 `status=awaiting_human_review`、`final_review.decision=null` 是刻意保留的
人工決策狀態，不代表 agent 已自行 acceptance。

## 總 goal

建立一條離線、可重播、可追溯、不可寫入的 EOD/as-of K 線分析路徑：

```text
K1 OHLCV fixture
      ↓
K2 1D/1W/M/Q aggregation
      ↓
K3 read-only K-line view model
      ↓
K4 bundled K-line UI block
      ↓
K5 real Chromium/Playwright validation
      ↓
one final K2-K5 acceptance
      ↓
K6 user-owned decision
```

產品仍是量化分析儀表板，不是即時看盤或交易終端。K2～K5 不包含 provider、
即時/延遲 feed、auth、CRUD、broker、下單、桌面打包或 release promotion。

## LOOP 執行規則

使用者批准審批包後，K2 的 loop 可以複製到 K3、K4、K5；每一階段仍然
隔離，但不需要在階段之間停下等待人工審批：

1. 先確認該 stage 的 intake contract 清楚。
2. 只實作該 stage 宣告的 scope。
3. 做真實 acceptance checks。
4. 留下 append-only evidence。
5. 若本階段的機械驗證通過且 evidence 已寫入，立即自動進入下一階段。
6. K5 完成後停止自動串行，進行一次整體 K2～K5 最終人工驗收。

每個 stage 的實測 acceptance 連續失敗 3 次後立即停止。遇到市場日曆、
月/季邊界、調整政策、期貨契約、UI 行為或 evidence 意義不明時，不繞路、
不自行假設，立即停下詢問。任何 network/provider、look-ahead、非決定性、
寫入面或 scope fork 都是 hard stop。

Agent/test harness 可以記錄原始結果，但不能自我核准、自我 acceptance，
也不能把階段通過測試寫成產品或 release 已接受。K2～K5 的階段 pass
只代表機械 gate 通過，可解鎖下一階段；K5 後的整體 acceptance 才交由人為
決策。

## Stage goal 與驗收標準

| Stage | Goal / contract | 必要驗收 | Evidence |
| --- | --- | --- | --- |
| K2 | `tw-quant-engine-kline-aggregation/v1`；從 K1 EOD bars 產生 `1D/1W/M/Q` | OHLCV 聚合正確；市場時區/session 不混用；M/Q 不完整時顯式不可用；`as_of` 不洩漏；digest 可重播 | `workflow/evidence/k2-period-aggregation.acceptance.json` |
| K3 | `tw-quant-engine-kline-read-model/v1`；封裝 instrument、period、as-of、provenance、quality、bars、indicator metadata | valid/partial/empty/unsupported/invalid 狀態分明；GET-only；未來資料隱藏；無 browser 財務推導；digest 穩定 | `workflow/evidence/k3-kline-read-model.acceptance.json` |
| K4 | `tw-quant-engine-dashboard-kline-block/v1`；npm bundled K 線 UI | 價格/成交量、period、MA/EMA、品質狀態、空態與不可用態可顯示；無 CDN、無外部 fetch、無寫入控制項 | `workflow/evidence/k4-kline-ui.acceptance.json` |
| K5 | `tw-quant-engine-dashboard-kline-browser-evidence/v1`；真實 Chromium evidence | V1～V7 matrix 全通過；DOM/互動、console、network、PNG/SHA-256、responsive smoke 均有證據 | `workflow/evidence/k5-browser-design-validation.acceptance.json` |

## K2 詳細 contract

- `1D`：每個 market session 一根。
- `1W`：依該市場 trading calendar 聚合完整交易週。
- `M`：完整市場月份；不完整只能是 `partial` 或 `unavailable`。
- `Q`：完整季度；不完整不得產生 accepted 季線。
- OHLCV：`open:first`、`high:max`、`low:min`、`close:last`、`volume:sum`。
- 必須保留 `trading_date/bar_time`、`timezone`、`session`、`available_at`、
  `ingested_at`、`as_of`、`source`、`adjustment_policy`。

## K3 詳細 contract

Read model 至少包含：

```text
instrument, period, as_of, timezone, session,
available_at, ingested_at, source, adjustment_policy,
bars, indicators, quality
```

Route 必須維持 GET-only；POST/PUT/PATCH/DELETE fail closed。任何 provenance
遺失、look-ahead 或把財務計算搬到 browser 都停止。

## K4 詳細 contract

UI block 必須提供：

- instrument/market 與 `READ ONLY` context；
- `as_of`、`available_at`、quality reason；
- `1D/1W/M/Q` period selector；
- OHLCV candlestick、volume、MA/EMA toggle；
- valid、partial、empty、unsupported、invalid state；
- detail、Escape、reset；
- npm bundled library，零 CDN、零 provider request、零 write/order control。

## K5 實測標準

固定 Chromium、1440×900、DPR 1，並保留：

- DOM 與互動 assertion；
- console error capture；
- external request audit；
- PNG screenshot 與 SHA-256；
- 1024×768 與窄視窗 responsive smoke。

必測 V1～V7：overview、四種 period、TWSE/US/TAIFEX 切換、unsupported M/Q、
empty/partial、detail/Escape/reset、responsive。`browser_errors=[]`、
`external_requests=[]`、pixel hashes 一致且所有 controls 可操作，才算 K5 pass。

## Evidence 最小格式

每個 stage 一份 append-only JSON，至少包含：

```text
schema
package_id
stage_id / goal_id
attempt / status
captured_at
contract_checks
commands: argv, exit_code, stdout_digest, stderr_digest,
          network_observed, write_observed
evidence_files
changed_files
failure_budget
stage_gate: mechanical_pass, evidence_complete, auto_advanced_to, stop_trigger
```

只有 K5 後的最終驗收 artifact 需要另外記錄：

```text
final_review: review_required_after_k5, reviewed_by, decision, reviewed_at, notes
```

`pass` 只表示該次實測結果符合 contract，並可在沒有停止條件時解鎖下一
階段；不是投資績效、即時 readiness、資料完整性、production acceptance，
也不是 K6 核准。K5 後另留一份
`workflow/evidence/k2-k5-final.acceptance.json`，由使用者完成最終驗收。

## 停止與 K6 邊界

- 同一 stage 連續 3 次 acceptance fail：停止並等待使用者指示。
- 語境不明確：立即停止並詢問，不採替代方案繞過。
- network/provider/look-ahead/non-determinism/write/scope fork：立即停止。
- K2～K5 之間不因人工檢閱而停下；只要機械 gate pass 且 evidence 完整，
  就自動複製 LOOP 到下一階段。
- K5 完成後必須做一次整體 K2～K5 最終人工驗收；未通過不得交給 K6。
- K6 只保留給使用者：provider、授權、delayed/realtime、連續期貨、
  release/打包與任何 promotion 不在本審批包授權內。
