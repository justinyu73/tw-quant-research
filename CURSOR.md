<!-- This file is the single mutable state cursor. History = git log -p CURSOR.md -->
# Cursor

last_commit: 105250c
branch: feat/top-nav-type-system
last_stage: UI 重新定義——字級比例、上方導航取代左側導航、全中文化
status: PARTIAL
next_action: 逐張看過 outputs/dashboard-browser/*.png 確認每個 diff 都是有意的，再更新 smoke 的 EXPECTED_SCREENSHOTS 雜湊並重跑到 pass
open_questions:
  - 免費官方是否存在財報歷史序列來源，或 forward accumulation 是唯一路徑
  - 各 endpoint 公告節奏（需跨月實測，不做推論）
  - 轉上市公司是否會同期同時出現在兩邊匯出檔（已設 conflict 防線，需 live 才能退場）
  - CSS 十個 breakpoint 是否收斂到稽核認得的六個（併錯會改變未受稽核寬度的版面）

---

## UI 段落現況（branch `feat/top-nav-type-system`，未開 PR）

四個 commit：

| hash | 內容 |
|---|---|
| `3ec8128` | 字級三重定義收斂、刪死碼。**六張 screenshot hash 逐位元不變**，證明刪的是死碼 |
| `5311509` | RWD 稽核 VIEWS 改看現行六頁——原本停在改版前十頁，八個視圖已刪除，等於空跑 |
| `920aa05` | 字級比例重訂 + 上方深色導航取代左側 rail + 摘要磚與 topbar 高度修正 |
| `a62d10f` | 導航與頁面標題全中文化 + 自選清單三欄位頂端對齊 |
| `105250c` | 估值比例改 auto-fit + canonical 三處同步 |

字級階梯（單一來源在 `ui/dashboard/styles.css` 唯一的 `:root`）：
H1 28 / H2 19 / H3 15 / 導航 15 / 內文與輸入值 14 / label 12 / 徽章 11。
11px 是中文可讀下限。圖示與數值讀數依資料尺寸，不套標題階梯。

已量測通過：topbar 58px＝`--topnav-h`、首頁摘要 5 磚 1 列、自選清單三欄位
label 頂端皆 549、六頁 1440 的 scrollWidth 均等於 innerWidth、headless 零 JS 錯誤。

### 未完成（下個 session 從這裡接）

1. **稽核已通過，且是真的 0**。六頁 × 六斷點 = 36 筆結果全部量到，
   `SUM failures = 0`、無 ERR、`browser_errors` 0。改動前的三個缺陷都消失：
   820px `.system-topbar-left` 溢出 15px（topbar 重建）、company@390
   `.kline-chart-wrap` 截斷 8px 與 `.fundamental-metric-grid` 溢出 3px
   （拿掉 236px 左側 rail 後寬度還給圖表）。

   **中途出過兩次假綠，下個 session 要記得這個形狀**：
   (a) 稽核的點擊選擇器還寫著 `.sidebar-nav`，左側 rail 刪掉後每頁都點不進去，
       它回報 `SUM failures = 0`——那個 0 是「什麼都沒量到」。判斷 0 之前
       先確認 summary 裡沒有 ERR、且 results 有 36 筆。
   (b) 我為了縮短 topbar 高度加的 sr-only span（`width:1px; overflow:hidden`）
       讓 `scrollWidth(48) > clientWidth(1)`，稽核分不出視覺隱藏與真截斷，
       六頁 × 六斷點各報一個假失敗。改用 `aria-label`，元素不存在就沒有假陽性。
2. **smoke 截圖基線未更新**，停在 `functional_pass_baseline_required`。
   依 `uiux-review` 規定必須逐張看過 PNG 確認每個 diff 都是有意的才能更新雜湊。
   我只看過首頁、估值、自選清單三張，其餘三張未看，所以沒有更新雜湊。

3. **evidence／settings 兩個區塊全站無入口**。`data-section="evidence"`／
   `"settings"` 在 app.js 出現 0 次，但 SECTIONS 有它們、頁面也渲染得出來。
   這是既有漂移不是本次造成（舊左側導航也只渲染六個 primary）。
   `TQR-UIUX-001` 仍寫著它們 "stay reachable from inside a page"。
   已暫時移出稽核清單並在腳本註解記錄，補上入口後要放回去。
4. **breakpoint 未收斂**（見 open question）。

### 驗證方式

轉埠（VS Code PORTS / ssh -L）一直不通，已放棄該路線。改為 headless 渲染後直接貼圖：

```sh
python3 scripts/serve_dashboard_app.py --data-dir ~/.local/share/io.github.justinyu73.twquantengine
# 另一個終端機，用 playwright-core 對 127.0.0.1:5173 截圖到 outputs/ui-review/
```

`serve_dashboard_app.py` **只在啟動時建一次預覽包**——改完 CSS/JS 必須重啟，
否則量到的是舊碼（這個坑本 session 踩過一次）。

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

## PR #21（已合併，main = cf9c804）

修兩個實機發現的缺陷：
1. 溢價被顯示為折價（價格 2,440 / 合理價值 800 顯示「折價 205%」，語意反轉）
2. 未追蹤公司記錄研究狀態後無處顯示且無提示

第三項「browser smoke 覆寫 dev server 的預覽包」的修正（`c66cc7b`）commit
時間晚於 PR #21 合併，不在該 PR 內，隨下一個 PR 一起進 main。

## D-OPEN-1：Valuation 兩步流程無聲失敗（已修，`73f8992`）

「計算合理價值與買進區間」原本在缺工作表或缺標的時是灰的按鈕，
且 `evaluateValuation()` 在 `!symbol` 時靜默 `return`，按了沒有任何回饋。

改為按鈕恆可按（僅計算中停用），阻擋原因由 `valuationEvaluateBlocker()`
單一來源產生，同時顯示為按鈕旁提示（`valuation-evaluate-hint`）與按下後的
`valuation-status` 訊息。

gate 已接上：smoke 補了「未加入工作表就按計算」的路徑斷言。
反向對照做過——抽掉 app.js 的修正後 smoke exit 1
（`valuation-evaluate-hint` locator timeout），確認不是空綠。

## TPEx 基本面（`e04b160`，offline 完成）

欄名映射改為 per (market, family)，依實抓 fixture 而非契約敘述。契約 Finding 4
原本的描述對損益表正確、對另外兩個 family 錯誤，已一併修正。

最關鍵的一項：TPEx 資產負債表三個總計是 `資產總計`/`負債總計`/`權益總計`，
TWSE 是 `總額`。照抄會靜默失敗——每列正規化成功、零丟棄、count 漂亮，但
assets/liabilities/equity/debt_ratio/current_ratio 全是 None。已把「映射欄位
整份回應都不存在」升級為 `FundamentalsMappingError` 中止擷取。

反向對照做過：把映射改回 `資產總額` 拼法，
`test_balance_sheet_totals_are_real_numbers_not_silent_nones` 轉紅（assets is None）。

**live capture 未跑**——TPEx 的 row count、distinct periods、drop count 目前
全部未測，契約沒有宣稱它們。這是這段唯一的缺口。

### Op-Demo（要 JY 親自跑）

```sh
python3 scripts/capture_fundamentals.py --market TPEx --dry-run
```

看 `captures` 三個 family 的 `source_rows` / `normalized` / `dropped`，
`dropped` 應為 0、`periods` 各只有一期。確認後拿掉 `--dry-run` 實際寫入，
再開 App 找一支上櫃股（例如 1240 茂生農經）看負債比／流動比是否有數字。

## 未完成

### 續押項目

- **公告節奏 + Watchlist「下一個事件」自動帶入**：需跨月實測發布時間，
  刻意不做推論，避免產生看似確定實為猜測的欄位
- **TPEx 基本面**：待 TWSE 正規化契約驗證後再加

## alignment miss 清單（供後續警惕）

五項全數已修，共同形狀是**驗存在而非驗語意／驗因果**：

1. 公司研究欄位只接了讀取端沒接寫入端，Watchlist 五欄永遠是預設值 → 已修
2. smoke 只斷言欄位有值，讓「溢價顯示為折價」的語意反轉出貨 → 已修
3. smoke 在斷言前自動加入自選，把「必須先追蹤」的前提藏起來 → 已修
4. smoke 覆寫共用預覽目錄，打爛使用者正在看的 dev server → 已修（根因）
5. smoke 只走 happy path，沒測「直接按計算」→ 已修（D-OPEN-1）

## 本機環境陷阱（每個新 clone 都要確認）

本 clone 的 `remote.origin.fetch` 曾被設成單一分支 refspec，`git fetch`
因此永遠不更新 `origin/main`——本機顯示落後 30+ commits 是假象，
`git log origin/main..HEAD` 會列出一堆早已合併的 commit。已改回
`+refs/heads/*:refs/remotes/origin/*`。判斷合併狀態前先 `git ls-remote origin main` 對真值。

## Gate 指令

```sh
python3 -B -m unittest discover -s tests        # 193 tests
python3 scripts/dashboard-rwd-audit.cjs 前先確認 summary 無 ERR 且 results 有 36 筆
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
