# TQE 節點驗收後優化項目 — 驗收審查表

Date: 2026-07-22
Scope: 已完成節點驗收（S1–S9、K2–K6、P5.0/P5.2）後盤點出的 5 項待優化設計與節點。

| # | 項目 | 目標產出 | 驗收標準 | Evidence | 狀態 |
|---|------|----------|----------|----------|------|
| 1 | P5.1 TWSE source contract `source_contract_blocked` | 來源契約決議紀錄（解阻塞或具體 amendment 選項） | `docs/tqe-p5-source-contract-research.md` 候選全部重新驗證；`workflow/tqe-p5-twse-source-contract.json` 狀態有明確決議與下一步 | `workflow/evidence/p5.1-source-contract-decision.acceptance.json` | blocked（2026-07-22 人工選定選項 C；啟動前證據 2/7 完成，`p5.1-trial-capture-2308` pass；fresh P5.1 pass pending） |
| 2 | TQR wireframe 六斷點無驗收證據 | 瀏覽器 smoke 覆蓋 1440/1280/1024/820/720/390px 並存證 | 六斷點全部無水平溢出；evidence 記錄指令、exit code、各斷點結果 | `workflow/evidence/tqr-wireframe-rwd.acceptance.json` | pass（六斷點全 pass，browser smoke exit 0） |
| 3 | TQR unavailable 欄位（財務、Adjusted Close、市場廣度等）無 pending 契約 | 每類 unavailable 欄位有對應 pending 來源契約檔 | 契約檔列出欄位、所需來源、啟用條件；與 `docs/tqr-research-platform-spec.md` 的 unavailable 清單一致 | `workflow/evidence/tqr-unavailable-field-contracts.acceptance.json` | pass（12 類 contract，26 條 spec cross-check 全對齊） |
| 4 | P4 deferred 能力（provider feed、alerts、news、paper trading）與 7B runtime | 啟動提案文件（human gate，不直接實作） | 提案逐項列出能力、前置契約、風險與批准條件；不違反 `docs/tqe-p4-runtime-boundary.md` 的自動下單 prohibited | `workflow/evidence/p4-deferred-capability-proposal.acceptance.json` | approved_activation_order_3_5_2（能力 3 implemented_pending_human_acceptance；能力 5、2 approved_next；1、4、6 暫緩） |
| 5 | 文件狀態漂移 | `engine-manifest.json`、`workflow/README.md`、`k2-k5-final.acceptance.json` 狀態與實際證據一致 | `current_phase` 不再為 `s1_qlib_integration`；README 不再寫 K2-K5 pending；K2-K5 final 頂層狀態反映 JY 已 accepted | `workflow/evidence/doc-state-drift-fix.acceptance.json` | pass（三處對齊，138 tests OK） |

## 驗收結果（2026-07-22）

- 五份 evidence JSON 全部建立並通過解析，狀態如上表。
- 回歸：`python3 -B -m unittest discover -s tests` → 138 tests OK (skipped=1)；`python3 scripts/lh_preflight.py` → status pass, errors []。
- 待人工決定：項目 1 的 decision_options（A 付費訂閱 / B 縮短歷史深度 / C bounded 逐日擷取迴圈 / D 維持 blocked）；項目 4 各能力的啟動批准。

## 人工決議（2026-07-22，user）

- **項目 1（P5.1）：選擇選項 C** — bounded 逐交易日擷取迴圈（MI_INDEX CSV，約 750 sessions / 751 GET 上限）。
  - 已記錄：`workflow/tqe-p5-twse-source-contract.json` 的 `decision.user_selection`；頂層 `status` 維持 `source_contract_blocked`（fresh P5.1 pass 未完成前不解阻塞）。
  - 已產出：`workflow/tqe-p5-twse-work-unit.option-c.draft.json`（bounded loop、8 條 fail-closed、`draft_not_runnable`）、`workflow/evidence/p5.1-option-c-selection.acceptance.json`。
  - 啟動前仍缺 7 項證據：首筆人工試擷取 digest、日曆 digest 綁定、逐 session 清單、fixture 留存政策批准、逐 session work-unit digest 人工批准、編碼/schema 探測、端點使用條款審查。
- **項目 4（P6）：批准啟動順序 3 → 5 → 2；1、4、6 暫緩**。
  - 提案狀態改為 `approved_activation_order_3_5_2`（`docs/tqe-p6-deferred-capability-activation-proposal.md` Approval record）。
  - 能力 3 in-app alerts 契約已定義：`docs/tqe-p6-in-app-alerts-contract.md` + `workflow/tqe-p6-in-app-alerts.work-unit.draft.json`（`draft_not_runnable`，待 work-unit digest 人工核准後實作）；外部遞送通道未批准，自動下單維持 prohibited。
  - 能力 5、2 標為 `approved_next`，契約待能力 3 完成後再議。
- 決議後回歸：138 tests OK；`p4_research_closure.py` pass；`lh_preflight.py` pass；`p5_execution_target.py` 維持 fail-closed（provider_calls=0）。

## 驗收方式

每項完成後：
1. 產出對應 evidence JSON（`status: pass` 或 `blocked_*` 並附原因與下一步）。
2. 能跑測試的項目（2、5）附上測試/指令 exit code。
3. 全部完成後回歸：`python3 -B -m unittest discover -s tests` 與 `python3 scripts/lh_preflight.py` 必須維持 pass。
4. 本表「狀態」欄更新為 pass / blocked（含原因）。
