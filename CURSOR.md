<!-- This file is the single mutable state cursor. History = git log -p CURSOR.md -->
# Cursor

last_commit: 0d94ae3
branch: fix/premium-label-and-tracking
last_stage: 價值投資工作台改寫 + TWSE 基本面接入 + 實機缺陷修正
status: PARTIAL
next_action: 修 Valuation 兩步流程的無聲失敗（填完 EPS×PE 直接按「計算」沒反應），再合併 PR #21
open_questions:
  - 免費官方是否存在財報歷史序列來源，或 forward accumulation 是唯一路徑
  - 各 endpoint 公告節奏（需跨月實測，不做推論）
  - TPEx 何時納入（待 TWSE 正規化契約驗證後）

---

## 產品定位

台股**價值投資**研究工作台（Value Research Workspace）。只回答三個問題：
基本面是否持續成長、合理價值多少、現價在哪個買進區間。
不是量化平台、不是回測系統、不是 AI 選股。

Canonical spec: `docs/tqr-research-platform-spec.md`（`TQR-IA-003`）

## 已完成（PR #20 已合併進 main，13 commits）

- IA 10 頁 → 6 頁：Home / Watchlist / Company / Valuation / Buy Plan / Review
- 因子與公式、驗證報告（回測）、技術指標頁：程式碼與測試已刪除
- 估值改為 Bear/Base/Bull 三情境（`合理價值 = 情境 EPS × 情境 PE`）
- 買進階梯：Base × 90/85/80/75/65%，可自訂、必須遞減、邊界含端點
- 估值依據六個必填欄位（EPS 期別／實際或預估／PE 理由／財報日／估值日／修改原因）
- Buy Plan：總預算、分段比例（合計必須 100%）、到價只提示不建議
- Company Thesis 六欄 + Review 五題審查
- TWSE 基本面 ingestion：月營收 / 損益表 / 資產負債表三個 family

## 基本面資料現況

Source contract: `docs/tqr-fundamentals-source-contract.md`（`TQR-FUNDAMENTALS-SOURCE-001`）

本機已擷取 3,174 筆觀測（月營收 1,082 / 損益表 1,046 / 資產負債表 1,046），
位置 `~/.local/share/io.github.justinyu73.twquantengine/fundamentals-series.json`

四個實測發現已編碼成不可繞過的行為：
1. 每個 endpoint 只回單一期別 → forward accumulation，深度誠實顯示 `n/8`、`n/12`
2. `出表日期` 是整批匯出日非申報日 → 作保守 `available_at`，`published_at` 恆為 null
3. 匯出日前進使回應 digest 每日變動 → 去重鍵為 `(family, 代號, 期別) + 財務值`
4. TPEx 欄名不同屬正規化對應，非欄位缺失

**趨勢表深度目前為 1 期**。這是來源只發布單期的必然，不是缺陷。

## PR #21（開啟中，CI 綠）

https://github.com/justinyu73/tw-quant-research/pull/21

修三個實機發現的缺陷：
1. 溢價被顯示為折價（價格 2,440 / 合理價值 800 顯示「折價 205%」，語意反轉）
2. 未追蹤公司記錄研究狀態後無處顯示且無提示
3. browser smoke 覆寫 dev server 的預覽包，導致搜尋不到任何股票代號

## 未完成

### D-OPEN-1：Valuation 兩步流程無聲失敗（使用者已回報，未修）

**現象**：填完 EPS × PE 後點「計算合理價值與買進區間」沒反應。

**根因**：估值是兩步流程但介面沒說明。
必須先按「加入估值工作表」建立 worksheet，「計算」按鈕才會啟用
（`app.js` 的 disabled 條件為 `worksheets.length && symbol`）。
使用者直接按第二顆時按鈕是灰的，沒有任何說明。
另外 `evaluateValuation()` 在 `!symbol` 時是靜默 `return`（`app.js:1049`），
同樣無使用者回饋。

**為什麼 gate 沒擋住**：smoke 每次都先按「加入估值工作表」，
從未測試「直接按計算」這條路徑。

**建議修法**：合併成一顆按鈕，或在停用狀態下顯示原因
（例如「請先加入估值工作表」），並移除靜默 return。
修完要補 smoke 斷言：未加入工作表時按計算必須看到說明文字。

### 續押項目

- **公告節奏 + Watchlist「下一個事件」自動帶入**：需跨月實測發布時間，
  刻意不做推論，避免產生看似確定實為猜測的欄位
- **TPEx 基本面**：待 TWSE 正規化契約驗證後再加

## 本次 session 的 alignment miss（供後續警惕）

四個已修、一個未修，共同形狀是**驗存在而非驗語意／驗因果**：

1. 公司研究欄位只接了讀取端沒接寫入端，Watchlist 五欄永遠是預設值 → 已修
2. smoke 只斷言欄位有值，讓「溢價顯示為折價」的語意反轉出貨 → 已修
3. smoke 在斷言前自動加入自選，把「必須先追蹤」的前提藏起來 → 已修
4. smoke 覆寫共用預覽目錄，打爛使用者正在看的 dev server → 已修（根因）
5. smoke 只走 happy path，沒測「直接按計算」→ **未修，見 D-OPEN-1**

## Gate 指令

```sh
python3 -B -m unittest discover -s tests        # 184 tests
python3 scripts/lh_preflight.py
python3 scripts/p4_research_closure.py
python3 scripts/open_source_audit.py --strict
node scripts/dashboard-browser-smoke.cjs        # Playwright
```

## Dev server

```sh
python3 scripts/serve_dashboard_app.py --data-dir ~/.local/share/io.github.justinyu73.twquantengine
```

瀏覽器開 **5173**（8767 是後端 sidecar，不要開那個）。
`--data-dir` 是必要的，否則基本面會顯示空狀態。
