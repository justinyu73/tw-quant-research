<!-- This file is the single mutable state cursor. History = git log -p CURSOR.md -->
# Cursor

last_commit: 4cb0b5c
branch: chore/dead-code-and-interaction-gates
last_stage: 公司研究拆成「公司財務指標」與「技術指標」兩個分頁；主導覽七個區段
status: PARTIAL
next_action: v0.3.0 Draft 維持不發佈。桌面版複測（新分頁、研究提醒、估值指標磚）
open_questions:
  - sparkline 已實作但畫不出線：各指標只有 1 期，需累積 2 期以上才會出現（刻意不補值）
  - :focus 與 disabled 兩種互動態仍無任何閘覆蓋（hover 已納入 dark-audit）
  - 桌面版（WKWebView）尚未複測這四個修正；瀏覽器預覽 5173 已逐項量到
  - 估值引擎的欄位級拒絕訊息，目前沒有從 UI 可達的無效輸入可以觸發（表單先擋掉了），
    所以「引擎拒絕逐字顯示」這條性質沒有閘覆蓋；alerts smoke 裡那個舊檢查已移除並註明原因
  - styles.css 還有約 100 個沒有 markup 產生的 class 未清（本次只刪掉能證明成對的那些）
  - 「抓不到股票代碼」原因未明：JY 回報 Mac 端 curl 8767 有跑通，所以不是轉埠問題
  - 免費官方是否存在財報歷史序列來源，或 forward accumulation 是唯一路徑
  - 各 endpoint 公告節奏（需跨月實測，不做推論）
  - 轉上市公司是否會同期同時出現在兩邊匯出檔（首次雙市場擷取 0 conflicts）
  - CSS 十個 breakpoint 是否收斂到稽核認得的六個（併錯會改動未受稽核寬度）


## v0.3.0 實測四缺陷：已修（branch `fix/kline-instrument-truth`）

在 5173 逐個動作量測「klineSearchQuery / selectedKlineInstrumentId / 畫布實際標的」
三者。畫布標的的真相來源是 **交給 lightweight-charts 的那份 series**（攔
`createChart → pane.addSeries → series.setData`），不是 DOM——canvas 問不出它在畫誰。

### #1 的判定：是「輸入框謊報」，不是「重繪沒觸發」

量到的事實：下拉點選、topbar 全域搜尋、連點兩次快速切換，三條路徑的重繪都正確，
畫布資料每次都換成新標的。**真正壞掉的是打字這條路**：輸入 `2317` 後

- 按 Enter：沒有任何 handler 處理，state 不動
- 點別處（blur）：`change` 只把文字存進 `klineSearchQuery`，state 不動

而 `klineMarkup()` 用 `klineSearchQuery || selectedId` 當 input value，所以那個
「2317」**會一直留著**，跨越後續每一次 render——輸入框寫 2317、標題與畫布是台積電，
且不會自己恢復。研究工具上這等於掛著別人的代號看線圖。

修法（`ui/dashboard/app.js`）：

- 新增 `selectKlineInstrument()`，下拉點選、全域搜尋、Enter、自選下拉四條路徑
  共用同一個 commit 點，不再各寫一份
- `change`（Enter 與 blur 都會觸發）走 `commitKlineSearch()`：能解析成完整標的就
  選它；解析不出來就**就地**把輸入框改回目前標的，不重繪
- commit 的重繪 `setTimeout(…, 0)` 延後一拍。`change` 發生在 mousedown 與 mouseup
  之間，當場重繪會把使用者正在按的按鈕換掉，click 事件永遠不會成立——第一版就是
  這樣把「打字後點【期間】」的那一下吃掉了

### #2 已在自選的股票被回「找不到符合的商品」

`symbolSearchResults()` 把 `excluded`（自選清單）整個濾掉，濾空之後就印那句話。
改成保留、標「已在自選清單」並 disabled；加入鈕本來就會說「此商品已在目前群組」。
真的不存在的代號仍然回原本那句。

### #3 公司研究沒有自選下拉

K 線工具列新增 `kline-watchlist-select`，列出目前群組的自選標的，沿用
`watchlist-group-select` 的 select + change 模式。空清單時 disabled 並顯示
「自選清單是空的」。

### #4 沒下載資料被講成「服務無法連線」

`/kline` 404 時 `requestKlineModel` 的 catch 直接丟 `KLINE_ERROR` 而且**沒帶
message**，於是套用預設字串「本機資料服務無法連線；請重新啟動 TQR」，還把
`klineRuntimeStatus` 整個翻成 error——單一標的沒資料害整個 runtime 被判死。

改成分流：`kline_not_found` / `unsupported_period` / `instrument_not_found` 走新的
`KLINE_DATA_MISSING`，runtime 維持 ready、topbar 不出錯誤條，空狀態說「這個標的與
期間還沒有已下載的 K 線資料；請用『更新本機資料』下載後再看」。真的連不上或逾時
才走 `KLINE_ERROR`，而且現在會把 `sidecarErrorMessage(error)` 帶進去（原本逾時也
被講成無法連線）。

### 閘：畫布 == 標題 == 輸入框

`scripts/dashboard-browser-smoke.cjs` 的 `assertChartIdentity()`，CI 有跑、assert
會讓它 exit 1（阻擋）。四個切換點各驗一次：開頁、Enter commit、下拉點選、切回。
比對的是畫布 series 的根數與最後一根日期／收盤，對上 sidecar 該標的的 model。
也順帶擋「state 換了但完全沒重繪」——動作前清空記錄，等不到新的 candles 就紅。

**已證明它會紅**：把 #1 的修正還原後跑 smoke，停在
`after committing 2317 with Enter`，exit 1。

`company` / `company_dark` 兩張 pixel 基準線因為多了自選下拉而重釘，其餘十張逐位元
不變——證明視覺改動只落在公司研究頁。**這兩張要 JY 親眼看過**：
`outputs/dashboard-browser/company.png`、`company-dark.png`。

### 這一段學到的

`page.addInitScript` 包 `window.LightweightCharts` 時，**用 `=` 賦值會靜靜失敗**：
UMD 匯出的屬性是 non-writable，sloppy mode 下對繼承屬性賦值不報錯也不生效，於是
hook 一筆都沒錄到、圖卻照畫，看起來像「圖表根本沒重繪」。全部改走
`Object.defineProperty` 才錄得到。


## 死碼清除與互動態閘（branch `chore/dead-code-and-interaction-gates`）

### 刪了什麼，怎麼證明是死的

app.js 掃「定義了但全檔只出現一次」的函式，逐輪迭代（刪掉之後會冒出新的孤兒）：

`buyPlanDraftFrom` / `loadPrototypeDraft` / `savePrototypeDraft` / `qualityCards` /
`stockQuoteMarkup` / `storyTrackerMarkup` / `compactWatchlistMarkup` / `pct` /
`latestAdmittedPriceRow`，共 9 個；連帶兩行指向已消失元素的 `refreshSearchResults`
／`refreshFormIssues`；styles.css 少 76 行。

**證明**：browser-smoke 的十二張 pixel 基準線全部逐位元不變。刪的是死碼。

### CSS 沒有全清，而且不該全清

用「class 沒出現在任何 markup 來源」掃出 137 個候選，但其中 `status-admitted` /
`status-error` / `status-loading` …這一整族是 **執行期組出來的**
（`"status status-" + safe`），照掃描結果刪會刪掉活的樣式。所以本次只刪「產生它的
函式剛好也一起刪掉」的那幾族，其餘留在 open_questions。

### focus / disabled 閘（dark-audit）

- **focus** 用真的 Tab 走訪，不是 `element.focus()`——`:focus-visible` 對按鈕的
  程式化 focus 不成立，用 `.focus()` 量到的是使用者看不到的 ring。每個 view 走 40 步、
  跨 8 頁共量到 176 個控件。兩種失敗：亮色填底、以及**焦點完全看不見**
  （outline 與 box-shadow 都沒有），後者是鍵盤使用者的實際障礙，全 repo 之前沒人檢查。
- **disabled** 只查亮色填底，不查對比——WCAG 1.4.3 本來就豁免停用控件的對比，這一點
  稽核檔頭原本就寫了。四個探針各自斷言「有比對到」且「真的是 disabled」。
- 加 `focus_visited_total`：**零發現配零量測就是假綠**，任何一頁 Tab 走訪碰不到控件就 throw。

**已證明會紅**：把 `:focus-visible` 的 outline 拿掉並重建 → 176 個裡有 170 個被抓，
`pass: false`，exit 1。

### 兩個稽核之前根本沒有人在讀

`dashboard:dark-audit` 與 `dashboard:rwd-audit` **都不在 CI 裡**，只有人手動跑才會執行。
更糟的是 rwd-audit **從來不設 exit code**——48 格全爆它也 exit 0。

- rwd-audit 補 `pass` 與 exit 1，並加 `measured_cells` / `expected_cells`：量到的格數
  不足 48 也算失敗（沿用上次「SUM failures = 0 其實是什麼都沒量到」的教訓）
- 兩個稽核都進 `ci.yml` 的 dashboard-browser job

**已證明會紅**：塞一條 `.kline-toolbar { min-width: 2400px }` 重建 → failures 146，exit 1。

### 稽核在讀舊 bundle

focus 閘第一次「證明會紅」失敗了：拿掉 outline 之後稽核照樣 pass。原因是兩個稽核
**沿用 5173 上跑著的 dev server**，而它服務的是 `outputs/dashboard-preview/`——我改的是
`ui/dashboard/`，沒重建。稽核量的是舊碼。

兩個稽核都補上 bundle 指紋比對：抓 `styles.css` / `app.js` / `dashboard-core.js`，
sha256 對不上 repo 來源就直接 throw，並把指紋寫進報告。這跟先前「閘看起來上線了、
讀它的那一端沒接上」是同一個形狀，只是這次是**閘自己讀錯了對象**。


## 孤兒功能接回（`chore/dead-code-and-interaction-gates`）

JY 決定：兩個都接回，不刪。

### 確認方式：直接跑那支從來沒人跑的 smoke

`scripts/dashboard-alerts-smoke.cjs` 卡在 `[data-section="products"]`——IA 改版裁掉的頁面。
所以警示 UI 不是沒寫完，是**整套寫完了、頁面被刪掉**：JS 16 + 6 個函式、6 個 reducer 事件、
19 條 CSS、`src-tauri/src/alerts.rs` 172 行與兩個註冊指令、sidecar `/alerts`、
`tests/test_p6_in_app_alerts.py` 229 行、`dashboard-core.test.cjs` 的 in-app-alerts 段——
全都活著，只差一個掛的地方。刪要動四層千餘行，接回只要幾行。

- **研究提醒**掛回 `companyPageMarkup()`：表單本來就是對「目前選取的個股」建條件，
  公司研究頁是它的語意歸屬。不動 IA 的六個主要區段，導覽契約不變。
- **估值指標磚**（Z 分數／價格分位／MA 乖離）插回 `valuationMarkup()`。這三個值
  **本來每次按「計算」都在算**，只是算完沒有任何地方顯示——來回跑完整趟然後丟掉。

實測：建立提醒 → 1 筆定義；按「立即評估」→ 觸發 1 筆事件；零 console error。

### alerts smoke 腐爛的四個地方

它從來沒進 CI，所以對著三次產品變更爛了四處：

1. `products` / `market` 兩個已裁掉的區段選擇器 → 改指 `watchlist` / `company` / `valuation`
2. 自選加入提示「按鈕 disabled 時就要可見」——現行行為是**刻意**改成「使用者碰了搜尋框才顯示」
   （成功加入後立刻跳警告讀起來像錯誤）。改成斷言兩段：到站時隱藏、碰過搜尋框後出現
3. `預估 EPS` 的錯誤字串已變成 Bear／Base／Bull 三情境
4. `terminal-watchlist-add` 檢查的是本段刪掉的死碼 → 移除

`engine_rejection_shown_verbatim` **移除並註明原因**：它 seed 的是股利折現模型
（discount_rate／growth_rate），估值早就換成情境模型，等於在斷言一個不存在的契約。
現行 UI 沒有可達的無效輸入能觸發引擎端拒絕（表單先擋掉了），列為 open question，
不留一個假綠的檢查。

### 這支 smoke 會砸掉 5173 的 dev bundle

它把預覽建進 `outputs/dashboard-preview/`，並把**自己那次的隨機 sidecar 埠**烤進
index.html。跑完之後 JY 開著的 5173 就指向一個已經關掉的埠，畫面看起來像 sidecar 掛了。
本段除錯時就中招一次：所有搜尋都回「找不到符合的商品」。改成建進 `mkdtempSync` 暫存目錄——
`dashboard-browser-smoke.cjs` 早就有這個註解與作法，這支沒跟上。

### 四個瀏覽器閘現在都在 CI

`browser-smoke` / `dark-audit` / `rwd-audit` / `alerts-smoke`。
company 與 valuation 四張 pixel 基準線因為多了兩塊 UI 而重釘，其餘八張逐位元不變。


## 公司研究拆頁（JY 指定）

### 動線

原本順序是投資假設 → 研究筆記 → 基本面快照 → 研究狀態 → 趨勢表，**判斷排在資料前面**。
JY 指定倒過來：先看公司自己的數字，再看建立在上面的判斷。

- **公司財務指標**（原公司研究，改名）：報價列 → 基本面快照 → 研究狀態 → 趨勢表 →
  投資假設 → 研究筆記
- **技術指標**（新增，第 7 個主導覽區段）：報價列 → 價格參考（K 線）→ 研究提醒

IA 從六個區段變七個。`PRIMARY_SECTION_IDS` 與 browser-smoke 的「恰好六個、順序固定」
斷言同步改成七個。

### 拆頁暴露出來的三個問題

1. **換股票會把你踢出圖表頁**。`SELECT_KLINE_INSTRUMENT` 寫死 `activeSection: "company"`，
   拆頁之後在技術指標頁按 Enter 換股，畫面會跳回公司財務指標、圖表消失。改成
   「本來就在技術指標就留著，其他地方進來才落在公司財務指標」。
2. **一個死條件被我改活之後變成無限重試**。`ensureKlineRuntime` 裡的
   `activeSection === "market" || "features"` 指的是早就裁掉的區段，永遠不成立；
   我把它改成 `"technical"` 之後，`/kline` 404 → `KLINE_DATA_MISSING` → render →
   ensureKlineRuntime → 再打一次，實測 3 秒內打了 290 次。`requestKlineModel` 補上
   「已標記為沒有資料的選擇不再重打」。**改活一個死條件跟新增一條路徑一樣要驗**。
3. **`技術指標` 這五個字原本在退場清單裡**。browser-smoke 禁止任何按鈕／連結文字出現
   `下單|送單|回測|因子|驗證報告|技術指標|AI 信心|強力買進|建議立即`。JY 指定的頁名撞到它，
   已把 `技術指標` 從清單移除並註明：留下的禁令是關於「照訊號行動」，不是關於「顯示訊號」。
   其餘八個詞不動。

### 基準線

十四張 pixel 基準線**全部**重釘——導覽多一個項目，每一頁的頁首都變了。這次的重釘沒有
「其餘逐位元不變」可以當佐證，只能靠 RWD 54/54、dark-audit 0 洩漏、以及人眼。

---

## 視覺風格改版（2026-08-01 完成，v0.3.0）

JY 決定：**深色為主要外觀**（不是可選主題），暖中性紙感、不全黑，紫色強調。
理由是「淺色＋藍色按鈕重複性過高」。參考來源為三張 Dribbble 截圖與他自己的
zibaldone app。

### 定案 token（單一來源在 `ui/dashboard/styles.css` 的 `:root` 與 `[data-theme="dark"]`）

深色三層 `#211f1d` / `#2a2724` / `#33302c`，導航 `#171512`；
文字 `#f0ece6` / `#c4bcb2` / `#a69d92`；
強調 `--primary #8b7cf6`（填色）／`--primary-dk #b9abff`（面上文字）／
`--on-primary #1a1714`（按鈕字，因白字壓在此紫上只有 3.3:1）；
漲跌 `--red #ff7a6b` / `--green #3fc99a`。**沒有 `--blue`**，紫是唯一強調色。

### 這一段學到的三件事

1. **token 改了不代表生效**：`.btn-primary` 在 styles.css 後段被寫死成
   `#2962ff`，靠 source order 蓋過 token，換色兩輪都沒進去。
2. **對比閘擋不住「顏色錯但看得清」**：藍底白字對比是過的。這一類只有人眼抓得到。
3. **hover 不在稽核範圍**：`tr:hover` 寫死近白 `#fbfcfd`，深色下滑過整列會閃白，
   是改表格時順手看到的，不是閘抓到的。

### 治理更正（重要）

`.agents/skills/uiux-review/SKILL.md` 的 `Color principles (de-AI)` 一節
（禁亮紫／霓虹／漸層／重陰影／大圓角）**是 Codex 寫的，JY 從未提供或批准**。
他只給過口頭大略描述與「不喜歡 AI 風格」，並自認太抽象。已在該節與
`TQR-UIUX-001` 標明出處：agent-authored working assumption，遇到 JY 的
指示就讓位，**不可再當成他自己的約束引用回去**。

唯一不動的硬約束：**台股紅漲綠跌**（市場慣例，非風格偏好）。參考圖多為
西方綠漲紅跌，不跟。

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

### 已全部通過（本段收尾狀態）

RWD 稽核 8 視圖 × 6 斷點 = 48 格全部量到，failures 0 / ERR 0 / browser_errors 0。
browser smoke `status: pass`。193 unittest OK。dashboard-core.test.cjs pass。
lh_preflight / p4_research_closure / open_source_audit --strict 全 pass。

### 人為 smoke 回報並已修（`dd57f5f`、`f69aefa`）

1. 公司研究頁八個欄位擠成一排——`.company-status-grid` 在 CSS 裡**完全沒有規則**。
   補 auto-fit 後實測 3 列、最窄控件 212px、備註跨滿列。
2. 三個卡片標題仍英文 → 基本面快照／趨勢表／價格參考。順帶清 Thesis 前綴與
   VALUE RESEARCH WORKSPACE eyebrow。
3. **估值永遠停在「計算中…」**：`sidecarRequest` 用沒有逾時的裸 fetch，連線
   停滯時 promise 永不 settle、in-flight 旗標卡住、無訊息無法重試。加
   `AbortSignal.timeout(15s)`，並在 `sidecarErrorMessage` 與 `engineErrorMessage`
   **兩處**都加中文逾時訊息（估值走的是後者，只改前者等於沒修）。
4. sidecar 不可達時 `loadKlineInstruments` 的 `.catch` 把 error 整個丟棄，
   介面只是搜尋框空著。改為帶進 `klineRuntimeMessage` 顯示在搜尋框下方。

### 仍未完成

0. **「抓不到股票代碼」未解**。JY 回報 Mac 端 `curl 8767` 有跑通，所以不是
   轉埠。原因未知，下個 session 要重新查——不要沿用「8767 沒轉」這個已被
   否證的假設。

1. ~~稽核~~ 已通過（見上）。原始說明：六頁 × 六斷點 = 36 筆結果全部量到，
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
2. ~~smoke 截圖基線未更新~~ 已更新，`status: pass`。**但最後一輪（dd57f5f
   之後）的視覺確認是用量測代替肉眼**，因為回合預算擋掉圖片讀取；逐張目視
   仍欠一次。
3. ~~evidence／settings 無入口~~ 已補（`685eceb`），入口在導航列右側工具區，
   兩頁已放回稽核清單並通過。
4. **breakpoint 未收斂**（見 open question）——四件事裡唯一沒做的。

### 驗證方式

本 session 大半時間轉埠不通，改用 headless 渲染貼圖。**但 JY 最後回報 Mac 端
`curl 8767` 有跑通**，所以「轉埠不通」這個假設已被否證，不要再沿用。
兩種方式都可用：

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

本機已擷取 **5,831** 筆觀測（TWSE 3,174 + TPEx 2,657），
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

**live capture JY 已跑**。本機量得 TPEx 月營收 891 / 損益表 883 /
資產負債表 883，各只有一個期別，`supersedes` 0、`conflicts` 0。契約已回寫
（`docs/tqr-fundamentals-source-contract.md`）；`source_rows` 與 `dropped`
未被擷取過程保留，契約明文不宣稱。

仍未由人眼確認：上櫃股（例如 1240 茂生農經）的負債比／流動比是否真的有數字、
來源是否標成櫃買中心而非證交所。

## 未完成

### 續押項目

- **公告節奏 + Watchlist「下一個事件」自動帶入**：需跨月實測發布時間，
  刻意不做推論。產品邊界禁止常駐 provider 呼叫，只能靠 JY 每月手動跑
  `scripts/capture_fundamentals.py` 累積——這是操作者任務，不是寫程式能收的。
- ~~TPEx 基本面~~ 已完成並 live 驗證（PR #23 已合併）。

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
