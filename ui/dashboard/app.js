(function () {
  "use strict";

  var root = document.getElementById("app");
  var view = window.__TW_QUANT_VIEW__;
  var core = window.TWQuantDashboard;
  if (!root || !view || !core) return;

  var state = core.createInitialState(view);
  var chartInstance = null;
  var chartResizeObserver = null;
  var klineRequestInFlight = false;
  var klineRequestKey = null;
  var watchlistLoadStarted = false;
  var watchlistPersistenceAvailable = null;
  var watchlistSaveInFlight = false;
  var WATCHLIST_LOCAL_STORAGE_KEY = "tw-quant-engine-watchlist.v1";
  var NOTES_LOCAL_STORAGE_KEY = "tw-quant-engine-research-notes.v1";
  var ALERTS_LOCAL_STORAGE_KEY = "tqe-in-app-alerts.v1";
  var ALERTS_SESSION_STORAGE_KEY = "tqe-in-app-alerts.session";
  var FINANCIAL_REVIEW_LOCAL_STORAGE_KEY = "tw-quant-engine-financial-review.prototype-v1";
  var BACKTEST_SETTINGS_LOCAL_STORAGE_KEY = "tw-quant-engine-backtest-settings.prototype-v1";
  var watchlistModelRequests = {};
  var notesLoadStarted = false;
  var notesPersistenceAvailable = null;
  var watchlistSearchQuery = "";
  var watchlistSearchSelection = null;
  var watchlistSearchFocused = false;
  var watchlistGroupNameQuery = "";
  var klineSearchQuery = state.selectedKlineInstrumentId || "";
  var klineSearchFocused = false;
  var chartDrawingMode = false;
  var chartDrawings = [];
  var chartDrawingModelKey = null;
  var chartTemplateName = "default";
  var screenConditions = [];
  var formulaRows = [defaultFormulaRow("rule-1")];
  var financialReviewDraft = defaultFinancialReviewDraft();
  var financialReviewSaved = false;
  var backtestSettingsDraft = defaultBacktestSettingsDraft();
  var backtestSettingsSaved = false;
  var dataUpdateInFlight = false;
  var alertsLoadStarted = false;
  var alertsPersistenceAvailable = null;
  var alertEvaluateInFlight = false;
  var alertDraft = defaultAlertDraft();

  function defaultAlertDraft() {
    return {
      label: "",
      conditionType: "price_threshold",
      indicator: "ma",
      op: ">=",
      value: "",
      dedupPolicy: "once_per_session",
      cooldownSeconds: "3600",
      expiryPolicy: "session",
      until: ""
    };
  }

  function chartTemplateLabel(name) {
    return name === "research" ? "研究模板" : "預設模板";
  }

  function recordTypeLabel(value) {
    var labels = {
      price_bar: "價格 K 線",
      fundamental_observation: "財報觀測",
      feature_row: "技術因子",
      screen_result: "篩選結果"
    };
    return labels[value] || value;
  }

  function formulaLabel(value) {
    var labels = {
      "simple moving average of close": "收盤價簡單移動平均",
      "exponential moving average of close": "收盤價指數移動平均"
    };
    return labels[value] || value;
  }

  function adjustmentPolicyLabel(value) {
    var labels = { unadjusted: "未調整", adjusted: "已調整" };
    return labels[value] || value;
  }

  var STATUS_LABELS = {
    admitted: "已納入",
    unadmitted: "未納入",
    valid: "有效",
    partial: "部分可用",
    invalid: "無效",
    unavailable: "不可用",
    unsupported_period: "不支援期間",
    loading: "載入中",
    error: "錯誤",
    ready: "已載入",
    saved: "已儲存",
    saving: "儲存中",
    draft: "草稿",
    idle: "等待載入",
    available: "可用",
    empty: "無資料",
    not_admitted: "未納入",
    applied: "已套用"
  };

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function text(value) {
    return escapeHtml(value === null || value === undefined || value === "" ? "—" : value);
  }

  function statusBadge(status) {
    var safe = escapeHtml(status || "invalid");
    return '<span class="status status-' + safe + '"><span class="status-dot"></span>' + text(STATUS_LABELS[status] || status || "invalid") + "</span>";
  }

  function defaultFormulaRow(id) {
    return {
      id: id,
      enabled: true,
      category: "基本面",
      field: "毛利率 QoQ",
      operator: ">=",
      value_type: "固定數值",
      value: "0%",
      period: "最近一季"
    };
  }

  function defaultFinancialReviewDraft() {
    return {
      industry: "Other",
      watch_status: "基本面待確認",
      score: "",
      note: ""
    };
  }

  function defaultBacktestSettingsDraft() {
    return {
      universe: "目前自選",
      signal_time: "收盤後",
      fill_time: "次日開盤",
      rebalance: "每月",
      max_positions: "10"
    };
  }

  function loadPrototypeDraft(key, defaults) {
    try {
      if (!window.localStorage) return defaults;
      var raw = window.localStorage.getItem(key);
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
      return Object.keys(defaults).reduce(function (next, field) {
        next[field] = typeof parsed[field] === "string" ? parsed[field] : defaults[field];
        return next;
      }, {});
    } catch (error) {
      return defaults;
    }
  }

  function savePrototypeDraft(key, draft) {
    try {
      if (!window.localStorage) return false;
      window.localStorage.setItem(key, JSON.stringify(draft));
      return true;
    } catch (error) {
      return false;
    }
  }

  function loadPrototypeDrafts() {
    financialReviewDraft = loadPrototypeDraft(FINANCIAL_REVIEW_LOCAL_STORAGE_KEY, defaultFinancialReviewDraft());
    backtestSettingsDraft = loadPrototypeDraft(BACKTEST_SETTINGS_LOCAL_STORAGE_KEY, defaultBacktestSettingsDraft());
  }

  function navMarkup() {
    var groups = [
      { label: "行情", ids: ["overview", "market", "products", "features"] },
      { label: "研究計畫", ids: ["research", "fundamentals", "backtest"] },
      { label: "記錄", ids: ["stories", "evidence"] }
    ];
    var symbols = { overview: "⌂", market: "⌁", products: "▦", features: "▤", research: "◈", fundamentals: "▥", backtest: "↗", stories: "✦", evidence: "≡" };
    return groups.map(function (group) {
      return '<div class="nav-section"><div class="nav-label">' + text(group.label) + '</div><div class="nav-group">' + group.ids.map(function (id) {
        var item = core.SECTIONS.find(function (section) { return section.id === id; });
        var active = item && item.id === state.activeSection;
        return '<button class="nav-link' + (active ? " active" : "") +
          '" type="button" data-action="section" data-section="' + id +
          '" aria-current="' + (active ? "page" : "false") + '">' +
          '<span class="nav-symbol" aria-hidden="true">' + symbols[id] + "</span>" +
          '<span class="nav-text">' + text(item && item.label) + "</span>" +
          (active ? '<span class="nav-active-mark" aria-hidden="true"></span>' : "") +
          "</button>";
      }).join("") + '</div></div>';
    }).join("");
  }

  function pageHeader(title, pretitle) {
    var versions = Array.isArray(view.formula_versions) && view.formula_versions.length
      ? view.formula_versions.join(", ") : "未記錄";
    return '<header class="page-header"><div class="page-header-row"><div>' +
      '<div class="page-pretitle">' + text(pretitle) + "</div>" +
      '<h1 class="page-title">' + text(title) + '</h1></div><div class="page-actions">' +
      '<span class="meta-chip">視圖截至<strong>' + text(view.as_of) + "</strong></span>" +
      '<span class="meta-chip">公式版本<strong>' + text(versions) + "</strong></span>" +
      "</div></div></header>";
  }

  function qualityCards() {
    var summary = core.summary(view);
    return '<div class="row col-4 quality-row" aria-label="資料品質摘要">' +
      [['admitted', summary.admitted, "已納入資料筆數", "teal"],
       ['unadmitted', summary.unadmitted, "未納入資料筆數", "yellow"],
       ['invalid', summary.invalid, "無效資料筆數", "red"],
       ['backtest', summary.backtestStatus, "回測狀態", "blue"]].map(function (item) {
        return '<article class="card stat stat-' + item[0] + '">' +
          '<span class="stat-icon ' + item[3] + '" aria-hidden="true">' +
          (item[0] === "backtest" ? "↗" : item[0] === "admitted" ? "✓" : item[0] === "invalid" ? "!" : "~") +
          '</span><div class="stat-content"><div class="stat-label">' + item[2] +
          '</div><div class="stat-value">' + text(item[1]) + "</div></div></article>";
      }).join("") + "</div>";
  }

  function latestAdmittedPriceRow() {
    var rows = Array.isArray(view.products) ? view.products.filter(function (row) {
      return row && row.record_type === "price_bar" && row.quality && row.quality.admission_status === "admitted" && row.bar && row.bar.close_raw !== null && row.bar.close_raw !== undefined;
    }) : [];
    rows.sort(function (left, right) {
      return String((right.bar || {}).trading_date || "").localeCompare(String((left.bar || {}).trading_date || ""));
    });
    return rows[0] || null;
  }

  function stockQuoteMarkup() {
    var row = latestAdmittedPriceRow();
    var instrument = row && row.instrument || { security_id: "2330", market: "TWSE" };
    var bar = row && row.bar || {};
    var dailyReturn = bar.daily_return_1d;
    var kline = core.selectedKline(state);
    var klineBars = kline && Array.isArray(kline.bars) ? kline.bars : [];
    var klineBar = klineBars.length ? klineBars[klineBars.length - 1] : null;
    if (klineBar) {
      instrument = kline.instrument || instrument;
      bar = { close_raw: klineBar.close, trading_date: klineBar.trading_date, volume_shares: klineBar.volume };
      dailyReturn = null;
      row = { instrument: instrument, bar: bar, quality: { admission_status: kline.quality && kline.quality.status || "unavailable" }, provenance: { source_id: kline.source } };
    }
    var symbol = instrument.security_id || instrument.symbol || "2330";
    return '<div class="stock-quote" data-testid="stock-quote"><div class="stock-quote-symbol"><span class="eyebrow">目前選取</span><strong>' + text(instrument.market + ":" + symbol) + '</strong><span>' + text(row ? "台積電 · 本地資料" : "尚未選取有效行情") + '</span></div>' +
      '<div class="stock-quote-price"><strong>' + core.formatNumber(bar.close_raw) + '</strong><span class="' + (dailyReturn >= 0 ? "positive" : "negative") + '">' + (dailyReturn === null || dailyReturn === undefined ? "—" : core.formatPercent(dailyReturn)) + '</span></div>' +
      '<dl class="quote-grid"><div><dt>交易日</dt><dd>' + text(bar.trading_date) + '</dd></div><div><dt>成交量</dt><dd>' + core.formatNumber(bar.volume_shares) + '</dd></div><div><dt>資料品質</dt><dd>' + statusBadge(row && row.quality && row.quality.admission_status || "unavailable") + '</dd></div><div><dt>資料來源</dt><dd class="mono">' + text(row && row.provenance && row.provenance.source_id) + '</dd></div></dl></div>';
  }

  function storyTrackerMarkup() {
    var links = Array.isArray(view.evidence_links) ? view.evidence_links : [];
    var stories = [
      ["財報", "營收、EPS、現金流與期間", "等待免費官方來源", "unavailable"],
      ["事件", "公告、除權息、產業變化", "人工建立證據", "draft"],
      ["假說", "支持、反證、下次檢查日", "尚未建立", "idle"]
    ];
    return card("故事追蹤", "XQ 式研究欄位與人工筆記", '<div class="story-list" data-testid="story-tracker">' + stories.map(function (item) {
      return '<article class="story-item"><span class="story-kind">' + text(item[0]) + '</span><div><strong>' + text(item[1]) + '</strong><small>' + text(item[2]) + '</small></div>' + statusBadge(item[3]) + '</article>';
    }).join("") + '</div><div class="story-footer"><span>' + links.length + ' 個可追溯證據連結</span><button class="btn btn-outline btn-sm" type="button" data-action="section" data-section="stories">開啟追蹤</button></div>', "");
  }

  function researchModulesMarkup() {
    return '<div class="research-module-grid"><button class="research-module" type="button" data-action="section" data-section="market"><span class="module-icon module-chart">⌁</span><span><strong>技術面</strong><small>K 線、成交量、指標、標記</small></span><span class="module-arrow">→</span></button>' +
      '<button class="research-module" type="button" data-action="section" data-section="fundamentals"><span class="module-icon module-finance">▤</span><span><strong>財務追蹤</strong><small>統計、人工覆核與資料可用性</small></span><span class="module-arrow">→</span></button>' +
      '<button class="research-module" type="button" data-action="section" data-section="research"><span class="module-icon module-screen">◈</span><span><strong>因子與公式</strong><small>條件、篩選與人工審查</small></span><span class="module-arrow">→</span></button>' +
      '<button class="research-module" type="button" data-action="section" data-section="stories"><span class="module-icon module-story">✦</span><span><strong>故事與證據</strong><small>事件、假說、支持與反證</small></span><span class="module-arrow">→</span></button></div>';
  }

  function cockpitMarkup() {
    var summary = core.summary(view);
    return pageHeader("市場首頁", "我的自選 · 個股行情 · 研究工具") +
      '<section class="system-command-bar" data-testid="system-command-bar"><div><span class="eyebrow">TQR MARKET SYSTEM</span><strong>我的市場</strong><span>本機 EOD · 截止 ' + text(view.as_of || "—") + '</span></div><div class="system-command-actions"><button class="btn btn-primary" type="button" data-action="section" data-section="market">開啟行情</button><button class="btn btn-outline" type="button" data-action="section" data-section="research">設定研究規則</button><button class="btn btn-outline" type="button" data-action="section" data-section="stories">新增筆記</button></div></section>' +
      '<div class="system-metric-strip" data-testid="cockpit-stats"><article><span>自選</span><strong>' + text((state.watchlist && state.watchlist.items || []).length) + '</strong><small>我的行情</small></article><article><span>可用資料</span><strong>' + text(summary.admitted) + '</strong><small>已納入資料列</small></article><article><span>筆記</span><strong>' + text((state.notes || []).length) + '</strong><small>本機保存</small></article><article><span>資料狀態</span><strong>唯讀</strong><small>' + text((view.as_of || "—").slice(0, 10)) + '</small></article></div>' +
      dataUpdateMarkup() + '<div class="terminal-home-grid"><section class="terminal-home-main">' + card("我的行情", "XQ 式自選報價與快速切換", watchlistMarkup(), "") + card("研究工具列", "TradingView 圖表 · XQ 選股 · FinLab 報告 · MultiCharts 指標", researchModulesMarkup(), "") + '</section><aside class="terminal-home-side">' + card("目前標的", "價格、K 線與自選連動", stockQuoteMarkup(), "") + card("研究捷徑", "從一個標的開始", '<div class="analysis-check-list"><button type="button" class="analysis-check" data-action="section" data-section="market"><span>01</span><strong>看 K 線與技術線</strong><small>價格、成交量、指標</small></button><button type="button" class="analysis-check" data-action="section" data-section="stories"><span>02</span><strong>記錄研究筆記</strong><small>支持、反證、待確認</small></button><button type="button" class="analysis-check" data-action="section" data-section="fundamentals"><span>03</span><strong>核對財報</strong><small>期間、來源、可用性</small></button></div>', "") + '</aside></div>';
  }

  function financialTrackerMarkup() {
    var quote = selectedQuoteSnapshot();
    var instrument = quote.instrument || {};
    var instrumentLabel = (instrument.symbol || state.selectedKlineInstrumentId || "尚未選取") + " " + (instrument.display_name || "");
    var reviewStatus = financialReviewSaved ? "已儲存至本機 prototype 草稿" : "尚未儲存；不會寫入官方資料";
    return '<section class="financial-tracker" data-testid="financial-tracker"><header class="financial-tracker-header"><div><span class="eyebrow">PERSONAL FUNDAMENTAL TRACKER</span><h2>財務追蹤統計表</h2><p>目前標的：' + text(instrumentLabel) + '。數值欄位只顯示已接入、可追溯的資料；其餘維持未接入。</p></div><span class="status status-' + (financialReviewSaved ? "saved" : "draft") + '" data-testid="financial-review-status">' + text(reviewStatus) + '</span></header><div class="table-responsive"><table class="table financial-tracker-table"><thead><tr><th>營運成長</th><th>獲利品質</th><th>財務品質</th><th>估值</th><th>資料狀態</th></tr></thead><tbody><tr><td><strong>月營收 YoY</strong><small>未接入</small></td><td><strong>毛利率／ROE</strong><small>未接入</small></td><td><strong>自由現金流／負債比</strong><small>未接入</small></td><td><strong>PIT TTM PE／PB</strong><small>未接入</small></td><td>' + statusBadge("unavailable") + '<small>等待免費官方來源與 PIT 契約</small></td></tr></tbody></table></div><div class="financial-review-form" data-testid="financial-review-form"><label><span>產業主線</span><select data-action="financial-review-input" data-field="industry" data-testid="financial-review-industry">' + selectOptionMarkup(["Power Infrastructure", "Server Interconnect", "Passive Components", "Memory", "Edge AI", "Other"], financialReviewDraft.industry) + '</select></label><label><span>觀察狀態</span><select data-action="financial-review-input" data-field="watch_status" data-testid="financial-review-status-select">' + selectOptionMarkup(["核心持續追蹤", "等待合理估值", "等待止跌", "基本面待確認", "暫停觀察", "排除"], financialReviewDraft.watch_status) + '</select></label><label><span>人工基本面評分</span><select data-action="financial-review-input" data-field="score" data-testid="financial-review-score">' + selectOptionMarkup(["", "1", "2", "3", "4", "5"], financialReviewDraft.score) + '</select></label><label class="financial-review-note"><span>人工備註</span><textarea rows="3" maxlength="500" placeholder="支持、反證、一次性收益與下次財報檢查點" data-action="financial-review-input" data-field="note" data-testid="financial-review-note">' + escapeHtml(financialReviewDraft.note) + '</textarea></label><div class="financial-review-actions"><span>這是本機研究草稿，不會改寫官方資料或觸發計算。</span><button class="btn btn-primary" type="button" data-action="financial-review-save" data-testid="financial-review-save">儲存追蹤草稿</button></div></div></section>';
  }

  function fundamentalsMarkup() {
    var rows = Array.isArray(view.products) ? view.products.filter(function (row) { return row && row.record_type === "fundamental_observation"; }) : [];
    var body = rows.length ? rows.map(function (row) {
      var metric = row.fundamental || {};
      return '<tr><td class="cell-strong">' + text((row.instrument || {}).market + ":" + (row.instrument || {}).security_id) + '</td><td>' + text(metric.metric) + '</td><td class="cell-mono">' + core.formatNumber(metric.monthly_revenue) + '</td><td>' + text(metric.unit) + '</td><td>' + statusBadge(core.qualityLabel(row)) + '</td><td class="mono">' + text((row.provenance || {}).source_id) + '</td></tr>';
    }).join("") : '<tr><td colspan="6">目前沒有已接入的財報觀測資料；不以價格推估。</td></tr>';
    return pageHeader("財務追蹤", "財報統計 · 人工覆核 · 來源與期間") +
      '<div class="fundamental-banner"><strong>財報資料只接受有期間、公告時間與來源的觀測。</strong><span>目前月營收案例未通過品質門檻，維持未納入；這是品質訊號，不是可用數值。</span></div>' +
      '<div class="fundamental-metric-grid"><article class="fundamental-metric"><span>EPS</span><strong>—</strong><small>尚未接入免費官方來源</small></article><article class="fundamental-metric"><span>ROE</span><strong>—</strong><small>等待季報 PIT 資料</small></article><article class="fundamental-metric"><span>營收 YoY</span><strong>—</strong><small>衝突資料不推估</small></article><article class="fundamental-metric"><span>現金流</span><strong>—</strong><small>等待期間化資料</small></article></div>' +
      card("個股財務追蹤", "統計欄位與人工覆核分開保存", financialTrackerMarkup(), "") +
      card("基本面觀測表", "每一列都要能回到 source / period / available_at", '<div class="table-responsive"><table class="table fundamental-table"><thead><tr><th>標的</th><th>指標</th><th>數值</th><th>單位</th><th>品質</th><th>來源</th></tr></thead><tbody>' + body + '</tbody></table></div>', "") +
      card("人工檢查規則", "每次資料更新後由人為覆核", '<div class="review-prompt-grid"><div><strong>支持故事</strong><span>哪些數據支持目前產業假說？</span></div><div><strong>反證與異常</strong><span>一次性收益、財報更正與來源衝突都需列出。</span></div><div><strong>下次檢查</strong><span>記錄下個財報／月營收公告後的覆核時間。</span></div></div>', "");
  }

  function notesMarkup() {
    var notes = Array.isArray(state.notes) ? state.notes : [];
    var draft = state.noteDraft || { title: "", body: "", tags: "" };
    var selected = selectedQuoteSnapshot().instrument || {};
    var noteCards = notes.length ? notes.map(function (note) {
      return '<article class="note-card" data-testid="note-card"><header><div><span class="note-symbol">' + text(note.instrument_id || "未指定標的") + '</span><h3>' + text(note.title) + '</h3></div><button class="icon-button" type="button" data-action="note-delete" data-note-id="' + escapeHtml(note.id) + '" aria-label="刪除筆記">×</button></header><p>' + text(note.body) + '</p><footer><span>' + text(note.tags || "無標籤") + '</span><time>' + text(note.created_at || "") + '</time></footer></article>';
    }).join("") : '<div class="note-empty" data-testid="note-empty"><span class="story-empty-icon">✎</span><strong>還沒有個人研究筆記</strong><p>把你對 2330 的觀察、財報假說或下一次檢查點直接記下來；筆記只保存在本機。</p></div>';
    return '<section class="note-composer" data-testid="note-composer"><header class="subsection-heading"><div><h2>新增研究筆記</h2><span class="muted">目前標的：' + text(selected.symbol || state.selectedKlineInstrumentId || "未選取") + ' · ' + text(noteStatus()) + '</span></div><span class="status status-saved" data-testid="note-count">已記錄 ' + notes.length + ' 筆 · 可記錄</span></header><form data-note-form="true"><div class="note-form-grid"><label><span>標題</span><input type="text" maxlength="80" placeholder="例如：AI 伺服器需求仍在加速" value="' + escapeHtml(draft.title) + '" data-action="note-input" data-field="title" data-testid="note-title"></label><label><span>標籤</span><input type="text" maxlength="80" placeholder="例如：營收／產業／待確認" value="' + escapeHtml(draft.tags) + '" data-action="note-input" data-field="tags" data-testid="note-tags"></label></div><label class="note-body-field"><span>觀察內容</span><textarea rows="5" maxlength="2000" placeholder="記錄支持、反證、來源與下一個檢查點……" data-action="note-input" data-field="body" data-testid="note-body">' + escapeHtml(draft.body) + '</textarea></label><div class="note-composer-footer"><span>不自動生成結論；只保存你輸入的研究脈絡。</span><button class="btn btn-primary" type="button" data-action="note-submit" data-testid="note-submit">保存筆記</button></div></form><div class="note-list" data-testid="note-list">' + noteCards + '</div></section>';
  }

  function storiesMarkup() {
    return pageHeader("研究筆記", "個人觀察 · 故事假說 · 可回看的記錄") +
      '<div class="story-board"><section class="story-board-main">' + card("我的研究記錄", "像 XQ 的自訂追蹤欄位，也保留 FinLab 的研究脈絡", notesMarkup(), "") + card("事件時間線", "公告／財報／除權息／產業變化", '<div class="timeline"><div><span class="timeline-dot"></span><div><strong>等待免費官方事件來源</strong><small>尚未抓取；不以新聞摘要代替原始證據。</small></div></div><div><span class="timeline-dot muted-dot"></span><div><strong>人為新增下一個檢查點</strong><small>保存日期、來源、觀察與結論。</small></div></div></div>', "") + '</section><aside class="story-board-rail">' + card("筆記欄位", "個人研究工具", '<div class="story-field-list"><div><span>標的</span><strong>目前行情標的</strong></div><div><span>支持</span><strong>財報與公開公告</strong></div><div><span>反證</span><strong>數據衰退或來源衝突</strong></div><div><span>狀態</span><strong>本機草稿 · 人工審查</strong></div></div>', "") + card("資料規則", "免費資料本地保存", '<p class="research-boundary">行情、財報與筆記分開保存；筆記不會改寫官方資料，也不會被當成回測輸入。每一筆記錄都保留建立時間與目前標的。</p>', "") + '</aside></div>';
  }

  function alertSelectOptions(pairs, selected) {
    return pairs.map(function (pair) {
      return '<option value="' + escapeHtml(pair[0]) + '"' + (pair[0] === selected ? ' selected' : '') + '>' + text(pair[1]) + '</option>';
    }).join("");
  }

  function alertDedupLabel(dedup) {
    if (dedup && dedup.policy === "cooldown_seconds") return "冷卻 " + text(dedup.cooldown_seconds) + " 秒";
    return "每工作階段一次";
  }

  function alertExpiryLabel(expiry) {
    if (expiry && expiry.policy === "until") return "有效至 " + text(expiry.until);
    return "本工作階段";
  }

  function alertsMarkup() {
    var alerts = state.alerts || { definitions: [], events: [], status: "idle", message: "" };
    var definitions = Array.isArray(alerts.definitions) ? alerts.definitions : [];
    var events = Array.isArray(alerts.events) ? alerts.events : [];
    var instrument = selectedKlineInstrument();
    var symbol = instrument && instrument.symbol;
    var definitionRows = definitions.length ? definitions.map(function (definition) {
      return '<article class="alert-definition" data-testid="alert-definition"><div><strong>' + text(definition.label) + '</strong><small>' + text(definition.target && definition.target.security_id) + ' · ' + alertConditionSummary(definition) + ' · ' + alertDedupLabel(definition.dedup) + ' · ' + alertExpiryLabel(definition.expiry) + '</small></div><button class="icon-button" type="button" data-action="alert-delete" data-alert-id="' + escapeHtml(definition.alert_id) + '" aria-label="刪除研究提醒">×</button></article>';
    }).join("") : '<div class="alert-empty" data-testid="alert-empty">尚未建立研究提醒。</div>';
    var eventRows = events.length ? events.map(function (item) {
      return '<article class="alert-event" data-testid="alert-event"><span class="alert-event-badge">研究註記</span><div><strong>' + text(item.label) + '</strong><small>' + text(item.security_id) + ' 觀察值 ' + core.formatNumber(item.observed_value) + ' ' + text(item.op) + ' 門檻 ' + core.formatNumber(item.threshold) + ' · ' + text(item.fired_at) + '</small></div></article>';
    }).join("") : '<div class="alert-empty" data-testid="alert-event-empty">本工作階段尚無觸發事件。</div>';
    var statusLine = alerts.status === "error"
      ? '<p class="alert-status error" data-testid="alert-status">' + text(alerts.message || "研究提醒評估失敗") + '</p>'
      : "";
    var form = '<div class="alert-form" data-testid="alert-form">' +
      '<label><span>名稱</span><input type="text" maxlength="120" placeholder="例如：收盤突破近期高點" value="' + escapeHtml(alertDraft.label) + '" data-action="alert-input" data-field="label" data-testid="alert-label"></label>' +
      '<label><span>條件</span><select data-action="alert-input" data-field="conditionType" data-testid="alert-condition-type">' + alertSelectOptions([["price_threshold", "收盤價門檻"], ["indicator_threshold", "指標門檻"]], alertDraft.conditionType) + '</select></label>' +
      '<label><span>指標</span><select data-action="alert-input" data-field="indicator" data-testid="alert-indicator">' + selectOptionMarkup(["ma", "ema", "rsi", "macd", "kd", "atr"], alertDraft.indicator) + '</select></label>' +
      '<label><span>比較</span><select data-action="alert-input" data-field="op" data-testid="alert-op">' + alertSelectOptions([[">=", ">="], ["<=", "<="]], alertDraft.op) + '</select></label>' +
      '<label><span>門檻值</span><input type="number" step="any" placeholder="數值" value="' + escapeHtml(alertDraft.value) + '" data-action="alert-input" data-field="value" data-testid="alert-value"></label>' +
      '<label><span>重複觸發</span><select data-action="alert-input" data-field="dedupPolicy" data-testid="alert-dedup">' + alertSelectOptions([["once_per_session", "每工作階段一次"], ["cooldown_seconds", "冷卻秒數"]], alertDraft.dedupPolicy) + '</select></label>' +
      '<label><span>冷卻秒數</span><input type="number" min="1" step="1" value="' + escapeHtml(alertDraft.cooldownSeconds) + '" data-action="alert-input" data-field="cooldownSeconds" data-testid="alert-cooldown"></label>' +
      '<label><span>有效期限</span><select data-action="alert-input" data-field="expiryPolicy" data-testid="alert-expiry">' + alertSelectOptions([["session", "本工作階段"], ["until", "直到指定時間"]], alertDraft.expiryPolicy) + '</select></label>' +
      '<label><span>到期時間</span><input type="datetime-local" value="' + escapeHtml(alertDraft.until) + '" data-action="alert-input" data-field="until" data-testid="alert-until"></label>' +
      '<button class="btn btn-outline btn-sm" type="button" data-action="alert-add" data-testid="alert-add"' + (symbol && String(alertDraft.label || "").trim() && alertDraft.value !== "" ? "" : " disabled") + '>新增提醒（' + text(symbol || "未選標的") + '）</button></div>';
    return card("研究提醒", "本機引擎評估 · 僅研究用途 · 非交易指示", '<div class="alerts-panel" data-testid="alerts-panel">' +
      form + statusLine +
      '<div class="alert-definition-list" data-testid="alert-definition-list">' + definitionRows + '</div>' +
      '<div class="alert-toolbar"><button class="btn btn-primary btn-sm" type="button" data-action="alert-evaluate" data-testid="alert-evaluate"' + (definitions.length && !alertEvaluateInFlight ? "" : " disabled") + '>' + (alertEvaluateInFlight ? "評估中…" : "立即評估") + '</button>' +
      '<button class="btn btn-outline btn-sm" type="button" data-action="alert-clear-events" data-testid="alert-clear-events"' + (events.length ? "" : " disabled") + '>清除事件</button></div>' +
      '<div class="alert-event-list" data-testid="alert-event-list">' + eventRows + '</div>' +
      '<p class="alert-note">提醒定義只保存在本機（tqe-in-app-alerts/v1），由本機引擎對已納入資料評估；結果僅在此工作階段顯示，沒有任何外部遞送，也不提供任何下單或執行功能。</p></div>', "");
  }

  function marketTerminalMarkup() {
    return pageHeader("行情分析", "TradingView / MultiCharts 型個人市場終端") +
      quoteHeaderMarkup() +
      '<nav class="terminal-tabs" aria-label="標的分析分頁"><button class="terminal-tab active" type="button" data-action="section" data-section="market">行情</button><button class="terminal-tab" type="button" data-action="section" data-section="features">技術指標</button><button class="terminal-tab" type="button" data-action="section" data-section="fundamentals">財報</button><button class="terminal-tab" type="button" data-action="section" data-section="stories">研究筆記</button></nav>' +
      '<div class="market-terminal-layout"><main class="market-terminal-chart">' + klineMarkup() + '</main><aside class="market-terminal-side">' + compactWatchlistMarkup() + alertsMarkup() + card("快速記錄", "把目前畫面留下來", '<div class="quick-record"><p>看完價格、成交量與技術線後，直接留下你的觀察。</p><button class="btn btn-primary" type="button" data-action="section" data-section="stories">新增研究筆記</button></div>', "") + '</aside></div>';
  }

  function analysisRailMarkup() {
    return '<aside class="stock-analysis-rail">' + card("標的摘要", "行情與自選清單連動", stockQuoteMarkup(), "") + card("研究檢查", "圖表、財報與證據連動", '<div class="analysis-check-list"><button type="button" class="analysis-check" data-action="section" data-section="fundamentals"><span>01</span><strong>看財報</strong><small>期間與來源</small></button><button type="button" class="analysis-check" data-action="section" data-section="stories"><span>02</span><strong>寫故事</strong><small>支持與反證</small></button><button type="button" class="analysis-check" data-action="section" data-section="evidence"><span>03</span><strong>看證據</strong><small>摘要雜湊與品質</small></button></div>', "") + storyTrackerMarkup() + '</aside>';
  }

  function selectedKlineInstrument() {
    return core.klineInstruments(state.view).find(function (instrument) {
      return instrument.instrument_id === state.selectedKlineInstrumentId;
    }) || null;
  }

  function klineLabel(model, instrument) {
    var selected = (model && model.instrument) || instrument;
    if (!selected) return "尚未選擇商品";
    return (selected.display_name || selected.symbol || "商品") +
      " · " + (selected.market || "未知市場");
  }

  function klineStatus(model) {
    if (state.klineRuntimeStatus === "loading") return "loading";
    if (state.klineRuntimeStatus === "error") return "unavailable";
    return model && model.quality ? model.quality.status : "unavailable";
  }

  function tauriInvoke(command, args) {
    var globalTauri = window.__TAURI__;
    if (globalTauri && globalTauri.core && typeof globalTauri.core.invoke === "function") {
      return globalTauri.core.invoke(command, args || {});
    }
    if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function") {
      return window.__TAURI_INTERNALS__.invoke(command, args || {});
    }
    return Promise.reject(new Error("Tauri shell API unavailable"));
  }

  function desktopDataUpdateAvailable() {
    return Boolean(
      (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function") ||
      (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function")
    );
  }

  var sidecarResolvedUrl = null;
  var sidecarUrlPromise = null;

  function sidecarBaseUrl() {
    var raw = window.__TW_QUANT_SIDECAR_URL__ || sidecarResolvedUrl || "http://127.0.0.1:8767";
    try {
      var parsed = new URL(raw);
      if (parsed.protocol !== "http:" || ["127.0.0.1", "localhost", "[::1]", "::1"].indexOf(parsed.hostname) < 0) return "";
      return parsed.origin;
    } catch (error) {
      return "";
    }
  }

  // Resolve the loopback sidecar URL once at startup: the dev/preview flow
  // pins it via __TW_QUANT_SIDECAR_URL__, the desktop shell picks a free port
  // dynamically and reports it through the sidecar_url command, and the 8767
  // fallback keeps the plain static preview usable.
  function ensureSidecarUrl() {
    if (sidecarUrlPromise) return sidecarUrlPromise;
    if (window.__TW_QUANT_SIDECAR_URL__ || !desktopDataUpdateAvailable()) {
      sidecarUrlPromise = Promise.resolve(sidecarBaseUrl());
      return sidecarUrlPromise;
    }
    sidecarUrlPromise = tauriInvoke("sidecar_url", {})
      .then(function (url) {
        sidecarResolvedUrl = typeof url === "string" ? url : "";
        return sidecarBaseUrl();
      })
      .catch(function () {
        return sidecarBaseUrl();
      });
    return sidecarUrlPromise;
  }

  function sidecarRequest(path, options) {
    var base = sidecarBaseUrl();
    if (!base) return Promise.reject(new Error("sidecar must use loopback HTTP"));
    var request = Object.assign({ method: "GET", cache: "no-store" }, options || {});
    return fetch(base + path, request).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) throw new Error(payload.error || ("sidecar request failed: " + response.status));
        return payload;
      });
    });
  }

  function sidecarErrorMessage(error) {
    var message = error && error.message ? String(error.message) : "";
    if (!message || /load failed|failed to fetch|networkerror|network request failed/i.test(message)) {
      return "本機資料服務無法連線；請重新啟動 TQR 後再試。";
    }
    if (message === "data_update_unavailable_in_preview") {
      return "瀏覽器預覽不提供下載；請使用桌面版 TQR。";
    }
    if (message === "instrument_not_found") {
      return "找不到這個自選標的，請重新載入商品清單。";
    }
    if (/^TWSE (returned|response)/i.test(message)) {
      return "官方 TWSE 資料回應失敗：" + message;
    }
    return "本機資料更新失敗：" + message;
  }

  function sidecarFetch(path) {
    return sidecarRequest(path);
  }

  function parseWatchlist(raw) {
    var payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!payload || payload.schema !== "tw-quant-engine-watchlist/v1" || payload.version !== 1 || !Array.isArray(payload.items)) {
      throw new Error("watchlist schema mismatch");
    }
    return payload.items;
  }

  function watchlistStatus() {
    var status = state.watchlist && state.watchlist.status ? state.watchlist.status : "idle";
    if (watchlistPersistenceAvailable === "browser" && status === "draft") {
      return "瀏覽器預覽草稿；按儲存寫入本機瀏覽器儲存";
    }
    if (watchlistPersistenceAvailable === "browser" && status === "saved") {
      return "已儲存至瀏覽器預覽本機儲存";
    }
    if (watchlistPersistenceAvailable === false && status === "draft") {
      return "預覽草稿；請用桌面開發版儲存本機 JSON";
    }
    if (status === "error" && state.watchlist.message === "Tauri shell API unavailable") {
      return "預覽模式不可寫入；請用桌面開發版儲存本機 JSON";
    }
    if (status === "error") return "本機自選清單讀寫失敗：" + (state.watchlist.message || "未知錯誤");
    return STATUS_LABELS[status] || status;
  }

  function localWatchlistItems() {
    try {
      if (!window.localStorage) return [];
      var raw = window.localStorage.getItem(WATCHLIST_LOCAL_STORAGE_KEY);
      return raw ? parseWatchlist(raw) : [];
    } catch (error) {
      return [];
    }
  }

  function saveLocalWatchlist(items) {
    try {
      if (!window.localStorage) return false;
      window.localStorage.setItem(WATCHLIST_LOCAL_STORAGE_KEY, JSON.stringify({
        schema: "tw-quant-engine-watchlist/v1",
        version: 1,
        items: items
      }));
      return true;
    } catch (error) {
      return false;
    }
  }

  function ensureWatchlistRuntime() {
    if (watchlistLoadStarted) return;
    watchlistLoadStarted = true;
    tauriInvoke("load_watchlist", {})
      .then(function (raw) {
        watchlistPersistenceAvailable = true;
        state = core.reduce(state, { type: "SET_WATCHLIST", items: parseWatchlist(raw) });
        render();
        requestWatchlistModels();
      })
      .catch(function (error) {
        // Browser preview has no Tauri bridge. Keep the same schema and make
        // the dev path usable with localStorage; Tauri remains the production
        // persistence authority when the desktop shell is present.
        watchlistPersistenceAvailable = "browser";
        state = core.reduce(state, { type: "SET_WATCHLIST", items: localWatchlistItems() });
        render();
        requestWatchlistModels();
      });
  }

  function persistWatchlist() {
    if (watchlistPersistenceAvailable === false || watchlistSaveInFlight || !state.watchlist || !state.watchlist.dirty) return;
    if (watchlistPersistenceAvailable === "browser") {
      if (saveLocalWatchlist(core.watchlistPayload(state).items)) {
        state = core.reduce(state, { type: "WATCHLIST_SAVED" });
      } else {
        state = core.reduce(state, { type: "WATCHLIST_SAVE_ERROR", message: "browser storage unavailable" });
      }
      render();
      return;
    }
    watchlistSaveInFlight = true;
    state = core.reduce(state, { type: "WATCHLIST_SAVING" });
    render();
    tauriInvoke("save_watchlist", { content: JSON.stringify(core.watchlistPayload(state)) })
      .then(function () {
        state = core.reduce(state, { type: "WATCHLIST_SAVED" });
      })
      .catch(function (error) {
        state = core.reduce(state, { type: "WATCHLIST_SAVE_ERROR", message: error.message || "save_failed" });
      })
      .then(function () {
        watchlistSaveInFlight = false;
        render();
      });
  }

  function parseNotes(raw) {
    var payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(payload)) throw new Error("notes schema mismatch");
    return payload.filter(function (note) {
      return note && typeof note.id === "string" && typeof note.title === "string" && typeof note.body === "string";
    }).slice(0, 200);
  }

  function localNotes() {
    try {
      if (!window.localStorage) return [];
      var raw = window.localStorage.getItem(NOTES_LOCAL_STORAGE_KEY);
      return raw ? parseNotes(raw) : [];
    } catch (error) {
      return [];
    }
  }

  function saveLocalNotes(notes) {
    try {
      if (!window.localStorage) return false;
      window.localStorage.setItem(NOTES_LOCAL_STORAGE_KEY, JSON.stringify(notes || []));
      return true;
    } catch (error) {
      return false;
    }
  }

  function ensureNotesRuntime() {
    if (notesLoadStarted) return;
    notesLoadStarted = true;
    notesPersistenceAvailable = "browser";
    state = core.reduce(state, { type: "SET_NOTES", notes: localNotes() });
  }

  function persistNotes() {
    if (notesPersistenceAvailable !== "browser") return false;
    return saveLocalNotes(state.notes || []);
  }

  function parseAlertStore(raw) {
    var payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!payload || payload.schema !== core.ALERT_STORE_SCHEMA || payload.version !== 1 || !Array.isArray(payload.alerts)) {
      throw new Error("alert store schema mismatch");
    }
    return payload.alerts;
  }

  function localAlertDefinitions() {
    try {
      if (!window.localStorage) return [];
      var raw = window.localStorage.getItem(ALERTS_LOCAL_STORAGE_KEY);
      return raw ? parseAlertStore(raw) : [];
    } catch (error) {
      return [];
    }
  }

  function saveLocalAlerts(payload) {
    try {
      if (!window.localStorage) return false;
      window.localStorage.setItem(ALERTS_LOCAL_STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch (error) {
      return false;
    }
  }

  // Session boundary for session-expiry alerts: a page session is tracked with
  // a sessionStorage marker. Reloading the tab (F5) keeps the marker, so
  // session-expiry definitions survive; a new tab or a desktop app launch
  // starts without it, so the definitions are dropped from the loaded store
  // and the pruned store is persisted. If sessionStorage is unreadable the
  // load is treated as a new session (fail-closed toward dropping).
  function beginAlertsSession() {
    try {
      if (!window.sessionStorage) return true;
      if (window.sessionStorage.getItem(ALERTS_SESSION_STORAGE_KEY)) return false;
      window.sessionStorage.setItem(ALERTS_SESSION_STORAGE_KEY, String(Date.now()));
      return true;
    } catch (error) {
      return true;
    }
  }

  function loadAlertDefinitions(definitions, newSession) {
    var kept = newSession ? core.dropSessionAlertDefinitions(definitions) : definitions;
    state = core.reduce(state, { type: "SET_ALERTS", definitions: kept });
    if (newSession && kept.length !== definitions.length) persistAlerts();
    render();
  }

  function ensureAlertsRuntime() {
    if (alertsLoadStarted) return;
    alertsLoadStarted = true;
    // Session-local store owned by the local app: the desktop shell keeps the
    // tqe-in-app-alerts/v1 flat JSON via Tauri commands; the browser preview
    // uses the same format in localStorage (watchlist-style dual path).
    var newSession = beginAlertsSession();
    tauriInvoke("load_alerts", {})
      .then(function (raw) {
        alertsPersistenceAvailable = true;
        loadAlertDefinitions(parseAlertStore(raw), newSession);
      })
      .catch(function () {
        alertsPersistenceAvailable = "browser";
        loadAlertDefinitions(localAlertDefinitions(), newSession);
      });
  }

  function persistAlerts() {
    var payload = core.alertStorePayload(state);
    if (alertsPersistenceAvailable === true) {
      tauriInvoke("save_alerts", { content: JSON.stringify(payload) }).catch(function () {
        alertsPersistenceAvailable = "browser";
        saveLocalAlerts(payload);
      });
      return true;
    }
    return saveLocalAlerts(payload);
  }

  function alertConditionSummary(definition) {
    var condition = definition && definition.condition ? definition.condition : {};
    if (condition.type === "price_threshold") return "收盤價 " + text(condition.op) + " " + core.formatNumber(condition.value);
    if (condition.type === "indicator_threshold") {
      var params = condition.params && condition.params.period ? "(" + condition.params.period + ")" : "";
      return text(String(condition.indicator || "").toUpperCase() + params) + " " + text(condition.op) + " " + core.formatNumber(condition.value);
    }
    return "未知條件";
  }

  function buildAlertFromDraft() {
    var instrument = selectedKlineInstrument();
    var symbol = instrument && instrument.symbol;
    var value = Number(alertDraft.value);
    if (!symbol || !String(alertDraft.label || "").trim() || !Number.isFinite(value)) return null;
    var condition = alertDraft.conditionType === "indicator_threshold"
      ? { type: "indicator_threshold", indicator: alertDraft.indicator, params: {}, op: alertDraft.op, value: value }
      : { type: "price_threshold", field: "close", op: alertDraft.op, value: value };
    var dedup = alertDraft.dedupPolicy === "cooldown_seconds"
      ? { policy: "cooldown_seconds", cooldown_seconds: Math.max(1, Math.round(Number(alertDraft.cooldownSeconds) || 3600)) }
      : { policy: "once_per_session" };
    var expiry = { policy: "session" };
    if (alertDraft.expiryPolicy === "until" && alertDraft.until) {
      var until = new Date(alertDraft.until);
      if (isNaN(until.getTime())) return null;
      expiry = { policy: "until", until: until.toISOString() };
    }
    return {
      schema: "tqe-in-app-alert/v1",
      alert_id: "alert-" + Date.now(),
      label: String(alertDraft.label).trim().slice(0, 120),
      enabled: true,
      target: { security_id: symbol },
      condition: condition,
      dedup: dedup,
      expiry: expiry,
      created_at: new Date().toISOString()
    };
  }

  function addAlertFromDraft() {
    var definition = buildAlertFromDraft();
    if (!definition) return;
    state = core.reduce(state, { type: "ADD_ALERT", alert: definition });
    alertDraft = defaultAlertDraft();
    persistAlerts();
  }

  function evaluateAlerts() {
    var definitions = state.alerts && Array.isArray(state.alerts.definitions) ? state.alerts.definitions : [];
    if (alertEvaluateInFlight) return;
    if (!definitions.length) {
      state = core.reduce(state, { type: "ALERTS_ERROR", message: "尚無研究提醒可評估" });
      render();
      return;
    }
    alertEvaluateInFlight = true;
    var query = "definitions=" + encodeURIComponent(JSON.stringify(definitions)) +
      "&state=" + encodeURIComponent(JSON.stringify(state.alertSessionState || {}));
    sidecarFetch("/alerts?" + query)
      .then(function (payload) {
        if (!payload || !payload.data) throw new Error("sidecar returned no alerts data");
        state = core.reduce(state, {
          type: "ALERTS_EVALUATED",
          fired: payload.data.fired,
          sessionState: payload.data.session_state
        });
      })
      .catch(function (error) {
        state = core.reduce(state, { type: "ALERTS_ERROR", message: sidecarErrorMessage(error) });
      })
      .then(function () {
        alertEvaluateInFlight = false;
        render();
      });
  }

  function noteStatus() {
    return notesPersistenceAvailable === "browser" ? "本機記錄" : "未啟用記錄";
  }

  function addNoteFromDraft() {
    var draft = state.noteDraft || {};
    if (!String(draft.title || "").trim() || !String(draft.body || "").trim()) return false;
    var quote = selectedQuoteSnapshot();
    state = core.reduce(state, {
      type: "ADD_NOTE",
      note: {
        id: "note-" + Date.now(),
        instrument_id: (quote.instrument && quote.instrument.instrument_id) || state.selectedKlineInstrumentId || "",
        title: String(draft.title).trim(),
        body: String(draft.body).trim(),
        tags: String(draft.tags || "").trim(),
        created_at: new Date().toISOString().slice(0, 16).replace("T", " ")
      }
    });
    persistNotes();
    return true;
  }

  function instrumentForId(instrumentId) {
    return core.klineInstruments(state.view).find(function (instrument) {
      return instrument.instrument_id === instrumentId;
    }) || null;
  }

  function symbolSearchText(instrument) {
    return [instrument.instrument_id, instrument.symbol, instrument.display_name, instrument.market]
      .filter(Boolean).join(" ").toLowerCase();
  }

  function resolveSearchSelection(instruments, query) {
    var normalizedQuery = String(query || "").trim().toLowerCase();
    if (!normalizedQuery) return null;
    return instruments.find(function (instrument) {
      return [instrument.instrument_id, instrument.symbol, instrument.display_name]
        .filter(Boolean).some(function (value) { return String(value).toLowerCase() === normalizedQuery; });
    }) || null;
  }

  function symbolSearchResults(instruments, query, excluded, selectedId, testId, action) {
    var normalizedQuery = String(query || "").trim().toLowerCase();
    var blocked = excluded || [];
    var matches = instruments.filter(function (instrument) {
      if (blocked.indexOf(instrument.instrument_id) >= 0) return false;
      return !normalizedQuery || symbolSearchText(instrument).indexOf(normalizedQuery) >= 0;
    });
    matches.sort(function (left, right) {
      var leftExact = left.instrument_id.toLowerCase() === normalizedQuery || String(left.symbol || "").toLowerCase() === normalizedQuery;
      var rightExact = right.instrument_id.toLowerCase() === normalizedQuery || String(right.symbol || "").toLowerCase() === normalizedQuery;
      if (leftExact !== rightExact) return leftExact ? -1 : 1;
      return String(left.instrument_id).localeCompare(String(right.instrument_id));
    });
    matches = matches.slice(0, 8);
    return '<div class="symbol-search-results" role="listbox" data-testid="' + testId + '">' +
      (matches.length ? matches.map(function (instrument) {
        var selected = instrument.instrument_id === selectedId;
        return '<button class="symbol-search-result' + (selected ? " selected" : "") + '" type="button" role="option" aria-selected="' + (selected ? "true" : "false") +
          '" data-action="' + action + '" data-instrument-id="' + escapeHtml(instrument.instrument_id) + '">' +
          '<span class="symbol-search-result-main"><strong>' + text(instrument.symbol || instrument.instrument_id) + '</strong><span>' + text(instrument.display_name) + '</span><small>' + text(instrument.instrument_id) + '</small></span>' +
          '<span class="symbol-search-result-market">' + text(instrument.market) + '</span></button>';
      }).join("") : '<span class="symbol-search-empty">找不到符合的商品；請改用代號、名稱或市場搜尋。</span>') +
      '</div>';
  }

  function refreshSearchResults(testId, markup) {
    var current = root.querySelector('[data-testid="' + testId + '"]');
    if (current) current.outerHTML = markup;
  }

  function refreshWatchlistAddButtons() {
    var instruments = core.klineInstruments(state.view);
    var items = core.watchlistItemsForActiveGroup(state);
    var selected = instrumentForId(watchlistSearchSelection) || resolveSearchSelection(instruments, watchlistSearchQuery);
    var enabled = Boolean(selected && items.indexOf(selected.instrument_id) < 0);
    root.querySelectorAll('[data-action="watchlist-add"]').forEach(function (button) {
      button.disabled = !enabled;
    });
  }

  function requestWatchlistModels() {
    if (state.klineRuntimeStatus !== "ready") return;
    (state.watchlist && state.watchlist.items || []).forEach(function (instrumentId) {
      var key = instrumentId + "\n1D";
      if (!instrumentForId(instrumentId) || core.klineModel(state.view, instrumentId, "1D") || watchlistModelRequests[key]) return;
      watchlistModelRequests[key] = true;
      sidecarFetch("/kline?instrument=" + encodeURIComponent(instrumentId) + "&period=1D")
        .then(function (payload) {
          if (!payload || !payload.data) throw new Error("sidecar returned no watchlist data");
          state = core.reduce(state, { type: "SET_KLINE_MODEL", model: payload.data });
          render();
        })
        .catch(function () { return null; })
        .then(function () { delete watchlistModelRequests[key]; });
    });
  }

  function requestKlineModel() {
    if (!state.selectedKlineInstrumentId || !state.selectedKlinePeriod) return;
    var selectedId = state.selectedKlineInstrumentId;
    var selectedPeriod = state.selectedKlinePeriod;
    if (core.selectedKline(state)) return;
    var requestKey = selectedId + "\n" + selectedPeriod;
    if (klineRequestKey === requestKey) return;
    klineRequestKey = requestKey;
    klineRequestInFlight = true;
    state = core.reduce(state, { type: "KLINE_LOADING" });
    render();
    sidecarFetch("/kline?instrument=" + encodeURIComponent(selectedId) + "&period=" + encodeURIComponent(selectedPeriod))
      .then(function (payload) {
        if (!payload || !payload.data) throw new Error("sidecar returned no K-line data");
        state = core.reduce(state, { type: "SET_KLINE_MODEL", model: payload.data });
      })
      .catch(function () {
        if (klineRequestKey === requestKey) state = core.reduce(state, { type: "KLINE_ERROR" });
      })
      .then(function () {
        if (klineRequestKey === requestKey) {
          klineRequestKey = null;
          klineRequestInFlight = false;
        }
        render();
      });
  }

  function ensureKlineRuntime() {
    if (!view.kline || !view.kline.runtime_fetch) return;
    ensureWatchlistRuntime();
    if (state.klineRuntimeStatus === "idle") {
      klineRequestInFlight = true;
      state = core.reduce(state, { type: "KLINE_LOADING" });
      render();
      sidecarFetch("/instruments")
        .then(function (payload) {
          if (!payload || !Array.isArray(payload.instruments) || !payload.instruments.length) {
            throw new Error("sidecar returned no instruments");
          }
          state = core.reduce(state, { type: "SET_KLINE_INSTRUMENTS", instruments: payload.instruments });
          render();
          klineRequestInFlight = false;
          requestKlineModel();
          requestWatchlistModels();
        })
        .catch(function () {
          klineRequestInFlight = false;
          state = core.reduce(state, { type: "KLINE_ERROR" });
          render();
        });
      return;
    }
    if (state.klineRuntimeStatus === "ready") {
      if (state.activeSection === "market" || state.activeSection === "features") requestKlineModel();
      requestWatchlistModels();
    }
  }

  function dataUpdateTargetIds() {
    var update = state.dataUpdate || {};
    if (update.scope === "selected") {
      var selected = selectedKlineInstrument();
      return selected ? [selected.instrument_id] : [];
    }
    return state.watchlist && Array.isArray(state.watchlist.items) ? state.watchlist.items.slice() : [];
  }

  function dataUpdateResultMarkup(results) {
    if (!Array.isArray(results) || !results.length) return "";
    var labels = { success: "完成", partial: "部分完成", error: "失敗", unsupported: "未支援" };
    return '<div class="data-update-results" data-testid="data-update-results">' + results.map(function (result) {
      var instrument = instrumentForId(result.instrument_id) || {};
      var name = instrument.symbol || result.symbol || result.instrument_id || "未指定標的";
      var detail = result.bars_downloaded ? "K 線 " + result.bars_downloaded + " 筆" : (result.errors && result.errors[0] && (result.errors[0].error || result.errors[0].message)) || "沒有新增資料";
      return '<div class="data-update-result"><span><strong>' + text(name) + '</strong><small>' + text(instrument.display_name || result.display_name || result.instrument_id) + '</small></span><span class="data-update-result-status status-' + escapeHtml(result.status || "error") + '">' + text(labels[result.status] || result.status || "失敗") + '</span><small class="data-update-result-detail">' + text(detail) + '</small></div>';
    }).join("") + '</div>';
  }

  function requestDataUpdate() {
    if (dataUpdateInFlight) return;
    var update = state.dataUpdate || { scope: "watchlist", years: 1 };
    var instrumentIds = dataUpdateTargetIds();
    if (!instrumentIds.length) {
      state = core.reduce(state, { type: "DATA_UPDATE_ERROR", message: update.scope === "selected" ? "請先選取一個個股" : "請先加入自選標的" });
      render();
      return;
    }
    dataUpdateInFlight = true;
    state = core.reduce(state, { type: "DATA_UPDATE_START" });
    render();
    var years = update.years || 1;
    var body = { scope: update.scope || "watchlist", instrument_ids: instrumentIds, years: years };
    if (update.scope === "selected") body.instrument_id = instrumentIds[0];
    sidecarRequest("/data/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (payload) {
      var result = payload && payload.data || {};
      var message = update.scope === "watchlist"
        ? "自選更新：" + (result.updated_count || 0) + "/" + (result.requested_count || instrumentIds.length) + " 檔，K 線 " + (result.bars_downloaded || 0) + " 筆"
        : "目前個股：K 線 " + (result.bars_downloaded || 0) + " 筆";
      state = core.reduce(state, { type: "DATA_UPDATE_SUCCESS", status: result.status || "success", message: message, results: result.results || [result] });
      if (Array.isArray(payload.instruments)) {
        state = core.reduce(state, { type: "SET_KLINE_INSTRUMENTS", instruments: payload.instruments });
      }
      klineRequestKey = null;
      watchlistModelRequests = {};
    }).catch(function (error) {
      state = core.reduce(state, { type: "DATA_UPDATE_ERROR", message: sidecarErrorMessage(error) });
    }).then(function () {
      dataUpdateInFlight = false;
      render();
      requestKlineModel();
      requestWatchlistModels();
    });
  }

  function selectedQuoteSnapshot() {
    var model = core.selectedKline(state);
    var instrument = (model && model.instrument) || selectedKlineInstrument() || { instrument_id: state.selectedKlineInstrumentId || "TWSE:2330", symbol: "2330", display_name: "台積電", market: "TWSE" };
    var bars = model && Array.isArray(model.bars) ? model.bars : [];
    var latest = bars.length ? bars[bars.length - 1] : null;
    var previous = bars.length > 1 ? bars[bars.length - 2] : null;
    var change = latest && previous && previous.close ? latest.close - previous.close : null;
    var changePct = change !== null && previous && previous.close ? change / previous.close : null;
    return { model: model, instrument: instrument, latest: latest, change: change, changePct: changePct };
  }

  function quoteHeaderMarkup() {
    var quote = selectedQuoteSnapshot();
    var instrument = quote.instrument || {};
    var latest = quote.latest || {};
    var selectedId = instrument.instrument_id || state.selectedKlineInstrumentId;
    var isWatched = (state.watchlist && state.watchlist.items || []).indexOf(selectedId) >= 0;
    var tone = quote.change === null ? "" : quote.change >= 0 ? "positive" : "negative";
    return '<section class="terminal-quote-bar" data-testid="quote-bar"><div class="terminal-quote-identity"><span class="terminal-market-tag">' + text(instrument.market || "TWSE") + '</span><div><h2>' + text(instrument.symbol || selectedId || "2330") + ' <small>' + text(instrument.display_name || "台積電") + '</small></h2><span class="mono">' + text(selectedId) + ' · ' + text((instrument.currency || "TWD")) + '</span></div></div><div class="terminal-quote-price"><strong>' + core.formatNumber(latest.close) + '</strong><span class="' + tone + '">' + (quote.change === null ? "—" : (quote.change >= 0 ? "+" : "") + core.formatNumber(quote.change) + " (" + core.formatPercent(quote.changePct) + ")") + '</span></div><dl class="terminal-ohlc"><div><dt>開</dt><dd>' + core.formatNumber(latest.open) + '</dd></div><div><dt>高</dt><dd>' + core.formatNumber(latest.high) + '</dd></div><div><dt>低</dt><dd>' + core.formatNumber(latest.low) + '</dd></div><div><dt>量</dt><dd>' + core.formatNumber(latest.volume) + '</dd></div></dl><div class="terminal-quote-actions"><button class="btn ' + (isWatched ? "btn-outline" : "btn-primary") + '" type="button" data-action="watchlist-toggle" data-testid="quote-watchlist-toggle">' + (isWatched ? "已在自選" : "加入自選") + '</button><button class="btn btn-outline" type="button" data-action="section" data-section="stories">記研究筆記</button></div></section>';
  }

  function compactWatchlistMarkup() {
    var instruments = core.klineInstruments(state.view);
    var items = core.watchlistItemsForActiveGroup(state);
    var groups = Array.isArray(state.watchlistGroups) ? state.watchlistGroups : [];
    var activeGroup = groups.find(function (group) { return group.id === state.activeWatchlistGroupId; }) || groups[0];
    var canDeleteGroup = activeGroup && activeGroup.id !== "default";
    var selected = instrumentForId(watchlistSearchSelection) || resolveSearchSelection(instruments, watchlistSearchQuery);
    var canAdd = Boolean(selected && items.indexOf(selected.instrument_id) < 0);
    return '<section class="terminal-watchlist" data-testid="terminal-watchlist"><header class="terminal-panel-heading"><div><span class="eyebrow">我的行情</span><h2>自選清單</h2></div><span class="terminal-count">' + items.length + '</span></header><div class="terminal-watchlist-controls"><div class="symbol-search"><label><span>搜尋代號／名稱</span><input type="search" autocomplete="off" placeholder="例如 2330" value="' + escapeHtml(watchlistSearchQuery) + '" data-action="watchlist-search" data-testid="terminal-watchlist-picker" aria-controls="terminal-watchlist-results"></label>' + symbolSearchResults(instruments, watchlistSearchQuery, items, watchlistSearchSelection, "terminal-watchlist-results", "watchlist-search-pick") + '</div><button class="btn btn-primary btn-sm" type="button" data-action="watchlist-add" data-testid="terminal-watchlist-add"' + (canAdd ? "" : " disabled") + '>加入</button></div><div class="terminal-watchlist-group"><label><span>目前群組</span><select data-action="watchlist-group-select" data-testid="terminal-watchlist-group-select">' + groups.map(function (group) { return '<option value="' + escapeHtml(group.id) + '"' + (group.id === state.activeWatchlistGroupId ? ' selected' : '') + '>' + text(group.name) + '</option>'; }).join("") + '</select></label><button class="btn btn-outline btn-sm" type="button" data-action="watchlist-group-delete" data-group-id="' + escapeHtml(activeGroup && activeGroup.id || "default") + '" data-testid="terminal-watchlist-group-delete"' + (canDeleteGroup ? '' : ' disabled') + '>刪除群組</button></div><div class="terminal-watchlist-list">' + (items.length ? items.map(function (instrumentId) {
      var instrument = instrumentForId(instrumentId) || { instrument_id: instrumentId, symbol: instrumentId, display_name: "未在商品清單" };
      var model = core.klineModel(state.view, instrumentId, "1D");
      var bars = model && Array.isArray(model.bars) ? model.bars : [];
      var latest = bars.length ? bars[bars.length - 1] : null;
      var previous = bars.length > 1 ? bars[bars.length - 2] : null;
      var delta = latest && previous ? latest.close - previous.close : null;
      return '<div class="terminal-watchlist-row-wrap"><button class="terminal-watchlist-row' + (instrumentId === state.selectedKlineInstrumentId ? ' active' : '') + '" type="button" data-action="kline-search-pick" data-instrument-id="' + escapeHtml(instrumentId) + '"><span><strong>' + text(instrument.symbol || instrumentId) + '</strong><small>' + text(instrument.display_name) + '</small></span><span class="terminal-watchlist-price"><strong>' + core.formatNumber(latest && latest.close) + '</strong><small class="' + (delta === null ? "" : delta >= 0 ? "positive" : "negative") + '">' + (delta === null ? "—" : (delta >= 0 ? "+" : "") + core.formatNumber(delta)) + '</small></button><button class="terminal-watchlist-remove" type="button" data-action="watchlist-remove" data-instrument-id="' + escapeHtml(instrumentId) + '" aria-label="移除 ' + escapeHtml(instrument.symbol || instrumentId) + '">×</button></div>';
    }).join("") : '<div class="terminal-watchlist-empty"><strong>還沒有自選標的</strong><span>搜尋 2330，加入後就能在右側快速切換。</span></div>') + '</div><footer class="terminal-watchlist-footer"><span>' + text(noteStatus()) + '</span><button class="btn btn-outline btn-sm" type="button" data-action="section" data-section="products">管理自選</button></footer></section>';
  }

  function dataUpdateMarkup() {
    var update = state.dataUpdate || { scope: "watchlist", years: 1, status: "idle", message: "", results: [] };
    var instrument = selectedKlineInstrument();
    var targetIds = dataUpdateTargetIds();
    var isWatchlist = update.scope !== "selected";
    var desktopAvailable = desktopDataUpdateAvailable();
    var enabled = targetIds.length > 0 && desktopAvailable && !dataUpdateInFlight;
    var targetLabel = isWatchlist
      ? "全部自選（" + targetIds.length + " 檔）"
      : instrument ? (instrument.market + ":" + instrument.symbol + " · " + instrument.display_name) : "尚未選取個股";
    var statusText = !desktopAvailable
      ? "瀏覽器預覽不下載；請使用桌面版"
      : targetIds.length === 0 ? (isWatchlist ? "請先加入自選標的" : "請先選取個股")
      : update.status === "idle" ? "尚未更新；只下載目前範圍的個股" : (update.message || STATUS_LABELS[update.status] || update.status);
    return '<section class="data-update-panel" data-testid="data-update-panel"><div class="data-update-heading"><div><span class="eyebrow">官方免費來源 → 本機保存</span><h2>更新台股資料</h2><p>更新範圍：' + text(targetLabel) + '</p></div><span class="data-update-status status-' + escapeHtml(update.status) + '" data-testid="data-update-status">' + text(statusText) + '</span></div><div class="data-update-controls"><label><span>更新範圍</span><select data-action="data-update-scope" data-testid="data-update-scope"><option value="watchlist"' + (isWatchlist ? ' selected' : '') + '>全部自選（' + targetIds.length + ' 檔）</option><option value="selected"' + (isWatchlist ? '' : ' selected') + '>目前個股</option></select></label><label><span>歷史範圍</span><select data-action="data-update-years" data-testid="data-update-years"><option value="1"' + (update.years === 1 ? ' selected' : '') + '>近 1 年</option><option value="2"' + (update.years === 2 ? ' selected' : '') + '>近 2 年</option><option value="3"' + (update.years === 3 ? ' selected' : '') + '>近 3 年</option></select></label><button class="btn btn-primary" type="button" data-action="data-update" data-testid="data-update-button"' + (enabled ? '' : ' disabled') + '>' + (dataUpdateInFlight ? '更新中…' : (isWatchlist ? '下載並更新自選資料' : '下載並更新目前個股')) + '</button></div><small class="data-update-note">目前提供 TWSE 上市個股；只處理目前範圍，不下載全市場。資料保存於本機 raw 與 K 線快照，不是即時行情；瀏覽器預覽僅展示介面。</small>' + dataUpdateResultMarkup(update.results) + '</section>';
  }

  function watchlistRows() {
    var items = core.watchlistItemsForActiveGroup(state);
    if (!items.length) {
      return '<div class="empty-state" data-testid="watchlist-empty"><strong>尚未建立自選清單</strong><span>從商品選擇器加入股票、ETF 或 TAIFEX TX；草稿需按「儲存自選清單」才會寫入本機 JSON。</span></div>';
    }
    return '<div class="table-responsive"><table class="table watchlist-table" data-testid="watchlist-table"><thead><tr>' +
      '<th>代號</th><th>名稱</th><th>市場</th><th>收盤</th><th>漲跌</th><th>漲幅</th><th>成交量</th><th>PE</th><th>EPS</th><th>月營收年增</th><th>最新財報期</th><th></th>' +
      '</tr></thead><tbody>' + items.map(function (instrumentId) {
        var instrument = instrumentForId(instrumentId) || { instrument_id: instrumentId, symbol: instrumentId, display_name: "商品未在目前 catalog", market: "—" };
        var model = core.klineModel(state.view, instrumentId, "1D");
        var bars = model && Array.isArray(model.bars) ? model.bars : [];
        var latest = bars.length ? bars[bars.length - 1] : null;
        return '<tr><td class="cell-mono cell-strong">' + text(instrument.symbol || instrumentId) + '</td>' +
          '<td><span class="cell-strong">' + text(instrument.display_name) + '</span><small>' + text(instrumentId) + '</small></td>' +
          '<td>' + text(instrument.market) + '</td><td class="cell-mono">' + core.formatNumber(latest && latest.close) + '</td>' +
          '<td>—</td><td>—</td><td class="cell-mono">' + core.formatNumber(latest && latest.volume) + '</td>' +
          '<td>—</td><td>—</td><td>—</td><td>—</td>' +
          '<td class="table-action"><button class="btn btn-outline btn-sm" type="button" data-action="watchlist-remove" data-instrument-id="' + escapeHtml(instrumentId) + '">移除</button></td></tr>';
      }).join("") + '</tbody></table></div>';
  }

  function watchlistMarkup() {
    var instruments = core.klineInstruments(state.view);
    var items = core.watchlistItemsForActiveGroup(state);
    var groups = Array.isArray(state.watchlistGroups) ? state.watchlistGroups : [{ id: "default", name: "我的自選", items: items }];
    var selected = instrumentForId(watchlistSearchSelection) || resolveSearchSelection(instruments, watchlistSearchQuery);
    var canAdd = Boolean(selected && items.indexOf(selected.instrument_id) < 0);
    var saving = state.watchlist && state.watchlist.status === "saving";
    var canSave = state.watchlist && state.watchlist.dirty && !saving && watchlistPersistenceAvailable !== false;
    var activeGroup = groups.find(function (group) { return group.id === state.activeWatchlistGroupId; }) || groups[0];
    var canDeleteGroup = activeGroup && activeGroup.id !== "default";
    return card("自選清單", "本機保存 · 明確儲存 · 資料唯讀", '<div class="watchlist-toolbar-shell"><div class="watchlist-toolbar" data-testid="watchlist-toolbar">' +
      '<section class="watchlist-toolbar-grouping" aria-label="自選群組管理"><div class="watchlist-group-control"><label class="watchlist-group-picker"><span>目前群組</span><select data-action="watchlist-group-select" data-testid="watchlist-group-select">' + groups.map(function (group) {
        return '<option value="' + escapeHtml(group.id) + '"' + (group.id === state.activeWatchlistGroupId ? ' selected' : '') + '>' + text(group.name) + ' · ' + group.items.length + '</option>';
      }).join("") + '</select></label><button class="btn btn-outline btn-sm watchlist-group-delete" type="button" data-action="watchlist-group-delete" data-group-id="' + escapeHtml(activeGroup && activeGroup.id || "default") + '" data-testid="watchlist-group-delete"' + (canDeleteGroup ? '' : ' disabled') + '>刪除群組</button></div>' +
      '<div class="watchlist-group-new-control"><label class="watchlist-group-new"><span>新增群組</span><input type="text" maxlength="32" placeholder="例如 半導體" value="' + escapeHtml(watchlistGroupNameQuery) + '" data-action="watchlist-group-name" data-testid="watchlist-group-name"></label>' +
      '<button class="btn btn-outline" type="button" data-action="watchlist-group-create" data-testid="watchlist-group-create"' + (watchlistGroupNameQuery.trim() ? '' : ' disabled') + '>建立群組</button></div></section>' +
      '<section class="watchlist-toolbar-search" aria-label="搜尋並加入商品"><div class="watchlist-picker symbol-search' + (watchlistSearchFocused ? " search-open" : "") + '"><label><span>搜尋商品</span><input type="search" autocomplete="off" placeholder="代號、名稱或市場，例如 2330 / 台積電" value="' + escapeHtml(watchlistSearchQuery) + '" data-action="watchlist-search" data-testid="watchlist-picker" aria-controls="watchlist-symbol-results"></label>' +
      symbolSearchResults(instruments, watchlistSearchQuery, items, watchlistSearchSelection, "watchlist-symbol-results", "watchlist-search-pick") + '</div><button class="btn btn-primary" type="button" data-action="watchlist-add" data-testid="watchlist-add"' + (canAdd ? '' : ' disabled') + '>加入自選</button></section>' +
      '<section class="watchlist-toolbar-actions" aria-label="自選清單操作"><button class="btn btn-outline" type="button" data-action="watchlist-clear" data-testid="watchlist-clear"' + (items.length ? '' : ' disabled') + '>清除草稿</button>' +
      '<button class="btn btn-primary" type="button" data-action="watchlist-save" data-testid="watchlist-save"' + (canSave ? '' : ' disabled') + '>儲存自選清單</button></section>' +
      '<span class="watchlist-state" data-testid="watchlist-state">' + text(watchlistStatus()) + '</span></div></div>' +
      watchlistRows() + '<p class="watchlist-note">桌面開發版使用本機 JSON；瀏覽器預覽使用同一資料格式的瀏覽器本機儲存備援。群組目前是本機工作階段資料；PE、EPS、月營收年增與最新財報期目前顯示「—」，代表基本面快照尚未接入；不以 K 線資料推估。成交量取自來源資料欄位。</p>', "");
  }

  function researchInstrumentId(row) {
    var instrument = row && row.instrument || {};
    if (!instrument.market || !instrument.security_id) return "";
    return instrument.market + ":" + instrument.security_id;
  }

  function screenConditionBuilderMarkup() {
    var groups = [
      { id: "price", label: "價量", items: [["close_above_ma20", "股價站上月線", "收盤價 > MA20"], ["volume_above_ma20", "成交量放大", "成交量 > 20 日均量"], ["new_high_20", "創 20 日新高", "收盤價 = 20 日最高"]] },
      { id: "technical", label: "技術", items: [["rsi_strong", "RSI 動能偏強", "RSI(14) > 50"], ["macd_cross", "MACD 黃金交叉", "MACD > Signal"], ["trend_up", "均線多頭排列", "MA5 > MA20"]] },
      { id: "fundamental", label: "財務", items: [["revenue_growth", "營收年增", "月營收 YoY > 10%"], ["roe_positive", "ROE 為正", "ROE > 0%"], ["eps_growth", "EPS 成長", "本期 EPS > 去年同期"]] },
      { id: "chip", label: "籌碼", items: [["foreign_buy", "外資連續買超", "外資買賣超 > 0"], ["trust_buy", "投信買超", "投信買賣超 > 0"], ["margin_down", "融資減少", "融資餘額低於前期"]] }
    ];
    var selected = screenConditions.map(function (id) { return groups.reduce(function (found, group) { return found || group.items.find(function (item) { return item[0] === id; }); }, null); }).filter(Boolean);
    return '<section class="screen-builder" data-testid="screen-builder"><header class="screen-builder-header"><div><span class="eyebrow">XQ STYLE SCREENER</span><h2>條件選股</h2><p>先選條件，再套用目前可用的本地資料快照；未接入欄位會明確標示。</p></div><span class="screen-condition-count">已選 ' + selected.length + '</span></header><div class="screen-condition-groups">' + groups.map(function (group) {
      return '<section class="screen-condition-group"><h3>' + text(group.label) + '</h3><div>' + group.items.map(function (item) {
        var active = screenConditions.indexOf(item[0]) >= 0;
        return '<button class="screen-condition' + (active ? ' active' : '') + '" type="button" data-action="screen-condition" data-condition-id="' + item[0] + '" aria-pressed="' + (active ? 'true' : 'false') + '"><strong>' + text(item[1]) + '</strong><small>' + text(item[2]) + '</small></button>';
      }).join('') + '</div></section>';
    }).join('') + '</div><div class="screen-selected">' + (selected.length ? selected.map(function (item) { return '<span class="screen-chip">' + text(item[1]) + '<button type="button" data-action="screen-condition" data-condition-id="' + item[0] + '" aria-label="移除條件">×</button></span>'; }).join('') : '<span>尚未選擇條件；可以先用市場與資料品質快速篩選。</span>') + '</div></section>';
  }

  function selectOptionMarkup(values, selected) {
    return values.map(function (value) {
      return '<option value="' + escapeHtml(value) + '"' + (value === selected ? ' selected' : '') + '>' + text(value) + '</option>';
    }).join('');
  }

  function formulaBuilderMarkup() {
    var categories = ["價格", "報酬", "均線", "動能", "波動", "成交量", "基本面", "估值", "市場", "Regime", "人工欄位"];
    var fields = ["毛利率 QoQ", "PE 5年百分位", "Z-score", "市場 Regime", "人工基本面評分"];
    var operators = [">", ">=", "<", "<=", "=", "!=", "Between", "Cross Above", "Cross Below", "Is True", "Is False", "Is Null"];
    var valueTypes = ["固定數值", "另一個欄位", "歷史平均", "歷史中位數", "歷史百分位", "產業平均", "大盤數值", "前一期數值"];
    var periods = ["最近一季", "最近一月", "20日", "60日", "120日", "自訂"];
    return '<section class="formula-builder" data-testid="formula-builder"><header class="formula-builder-header"><div><span class="eyebrow">TRADINGVIEW STYLE SETTINGS</span><h2>公式與條件草稿</h2><p>每列是人為設定，不會自動執行、下單或把未接入資料補成數值。</p></div><button class="btn btn-outline" type="button" data-action="formula-add" data-testid="formula-add">新增條件</button></header><div class="formula-rule-list">' + formulaRows.map(function (rule, index) {
      return '<article class="formula-rule" data-testid="formula-rule" data-rule-id="' + escapeHtml(rule.id) + '"><div class="formula-rule-number">' + String(index + 1).padStart(2, "0") + '</div><label class="formula-switch"><span>啟用</span><input type="checkbox" data-action="formula-input" data-rule-id="' + escapeHtml(rule.id) + '" data-field="enabled"' + (rule.enabled ? ' checked' : '') + '></label><label><span>資料分類</span><select data-action="formula-input" data-rule-id="' + escapeHtml(rule.id) + '" data-field="category">' + selectOptionMarkup(categories, rule.category) + '</select></label><label><span>欄位</span><select data-action="formula-input" data-rule-id="' + escapeHtml(rule.id) + '" data-field="field">' + selectOptionMarkup(fields, rule.field) + '</select></label><label><span>運算子</span><select data-action="formula-input" data-rule-id="' + escapeHtml(rule.id) + '" data-field="operator">' + selectOptionMarkup(operators, rule.operator) + '</select></label><label><span>比較值</span><select data-action="formula-input" data-rule-id="' + escapeHtml(rule.id) + '" data-field="value_type">' + selectOptionMarkup(valueTypes, rule.value_type) + '</select></label><label><span>輸入值</span><input type="text" data-action="formula-input" data-rule-id="' + escapeHtml(rule.id) + '" data-field="value" value="' + escapeHtml(rule.value) + '"></label><label><span>期間</span><select data-action="formula-input" data-rule-id="' + escapeHtml(rule.id) + '" data-field="period">' + selectOptionMarkup(periods, rule.period) + '</select></label><button class="icon-button formula-remove" type="button" data-action="formula-remove" data-rule-id="' + escapeHtml(rule.id) + '" aria-label="移除第 ' + (index + 1) + ' 個條件"' + (formulaRows.length === 1 ? ' disabled' : '') + '>×</button></article>';
    }).join('') + '</div><footer class="formula-builder-footer"><span>邏輯群組：AND / OR / NOT 與巢狀群組已納入規格，計算引擎仍需 PIT 資料與人為啟動。</span><span class="status status-draft">設定草稿</span></footer></section>';
  }

  function researchMarkup() {
    var spec = state.screenSpec || {};
    var groupItems = core.watchlistItemsForActiveGroup(state);
    var rows = state.screenSpecStatus === "applied" ? core.screenProducts(view, spec) : [];
    var specJson = JSON.stringify(spec, null, 2);
    var strategyJson = JSON.stringify(state.strategySpec, null, 2);
    var resultBody = rows.length ? '<div class="table-responsive"><table class="table" data-testid="research-results"><thead><tr><th>商品</th><th>日期</th><th>收盤</th><th>品質</th><th></th></tr></thead><tbody>' + rows.map(function (row) {
      var instrumentId = researchInstrumentId(row);
      var alreadyAdded = instrumentId && groupItems.indexOf(instrumentId) >= 0;
      return '<tr><td><span class="cell-strong">' + text(core.productLabel(row)) + '</span><small>' + text(recordTypeLabel(row.record_type)) + '</small></td><td>' + text(row.bar && row.bar.trading_date) + '</td><td class="cell-mono">' + core.formatNumber(row.bar && row.bar.close_raw) + '</td><td>' + statusBadge(core.qualityLabel(row)) + '</td><td class="table-action"><button class="btn btn-outline btn-sm" type="button" data-action="research-add-group" data-instrument-id="' + escapeHtml(instrumentId) + '"' + (alreadyAdded ? ' disabled' : '') + '>' + (alreadyAdded ? '已在群組' : '加入群組') + '</button></td></tr>';
    }).join("") + '</tbody></table></div>' : '<div class="empty-state" data-testid="research-results-empty"><strong>' + (state.screenSpecStatus === "applied" ? "沒有符合的已納入商品。" : "尚未套用篩選規格。") + '</strong><span>篩選只讀取目前已核准的市場資料快照；不補佔位值，也不從 K 線推估。</span></div>';
    return pageHeader("因子與公式", "條件設定 · 人工篩選 · 結果加入觀察池") + formulaBuilderMarkup() + screenConditionBuilderMarkup() +
      '<div class="row col-8-4"><div>' + card("連動篩選器", "目前資料快照的篩選結果", '<div class="research-toolbar"><label><span>品質</span><select data-action="screen-input" data-field="quality" data-testid="research-quality"><option value="admitted"' + (spec.quality === "admitted" ? ' selected' : '') + '>已納入</option><option value="unadmitted"' + (spec.quality === "unadmitted" ? ' selected' : '') + '>未納入</option><option value="invalid"' + (spec.quality === "invalid" ? ' selected' : '') + '>無效</option><option value=""' + (!spec.quality ? ' selected' : '') + '>全部</option></select></label><label><span>市場</span><input type="text" placeholder="TWSE / TPEx / US" value="' + escapeHtml(spec.market) + '" data-action="screen-input" data-field="market" data-testid="research-market"></label><label><span>最多筆數</span><input type="number" min="1" max="100" value="' + text(spec.max_rows) + '" data-action="screen-input" data-field="max_rows" data-testid="research-max-rows"></label><button class="btn btn-primary" type="button" data-action="screen-apply" data-testid="research-apply">套用篩選</button><span class="research-status" data-testid="research-status">' + (state.screenSpecStatus === "applied" ? '目前顯示 ' + rows.length + ' 筆已納入資料' : '篩選草稿；尚未套用') + '</span></div>' + resultBody, "") + '</div>' +
      '<div>' + card("篩選規格", "可檢查的選股條件", '<pre class="spec-block" data-testid="screen-spec">' + escapeHtml(specJson) + '</pre>' + card("策略規格", "僅供研究交接", '<pre class="spec-block" data-testid="strategy-spec">' + escapeHtml(strategyJson) + '</pre>', ""), "") + '</div></div>' +
      card("研究邊界", "選股不等於執行", '<p class="research-boundary">結果可以加入目前工作階段群組，並可供人工審查；策略規格的進出場條件尚未納入，沒有回測提交、即時警示、券商連線或自動下單。</p>', "");
  }

  function latestIndicatorValue(model, indicatorName, valuesKey) {
    var indicator = model && model.indicators && model.indicators[indicatorName];
    var key = valuesKey || "values";
    var values = indicator && Array.isArray(indicator[key]) ? indicator[key] : [];
    for (var index = values.length - 1; index >= 0; index -= 1) {
      if (values[index] && values[index].value !== null && values[index].value !== undefined) return values[index].value;
    }
    return null;
  }

  function technicalSnapshotMarkup(model) {
    var items = [
      ["MA(5)", latestIndicatorValue(model, "ma"), "短期均線"],
      ["EMA(20)", latestIndicatorValue(model, "ema"), "趨勢均線"],
      ["RSI(14)", latestIndicatorValue(model, "rsi"), "動能"],
      ["MACD", latestIndicatorValue(model, "macd"), "趨勢動能"]
    ];
    return '<section class="technical-snapshot" data-testid="technical-snapshot"><header class="subsection-heading"><div><h2>技術讀值</h2><span class="muted">同一份資料模型計算；瀏覽器只呈現</span></div><span class="status status-valid">可驗證</span></header><div class="technical-reading-grid">' +
      items.map(function (item) {
        var testId = item[0].replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
        return '<div class="technical-reading"><span>' + text(item[0]) + '</span><strong data-testid="technical-value-' + testId + '">' + (item[1] === null ? "—" : core.formatNumber(item[1])) + '</strong><small>' + text(item[2]) + (item[1] === null ? " · 歷史窗口不足" : " · 已納入資料") + '</small></div>';
      }).join("") + '</div><p class="technical-snapshot-note">若顯示「—」，代表該期間沒有足夠歷史窗口，不以填值或插值掩蓋資料不足。</p></section>';
  }

  function klineMarkup() {
    var model = core.selectedKline(state);
    var instrument = selectedKlineInstrument();
    var instruments = core.klineInstruments(state.view);
    var selectedId = state.selectedKlineInstrumentId;
    var selectedPeriod = state.selectedKlinePeriod;
    var periods = ["1D", "1W", "M", "Q"];
    var status = klineStatus(model);
    var bars = model && Array.isArray(model.bars) ? model.bars : [];
    var periodButtons = periods.map(function (period) {
      var available = core.klinePeriods(state.view, selectedId).indexOf(period) >= 0;
      return '<button class="period-button' + (period === selectedPeriod ? " active" : "") + '" type="button"' +
        ' data-action="kline-period" data-period="' + period + '" data-testid="kline-period-' + period + '"' +
        (available ? "" : " disabled") + '>' + period + '</button>';
    }).join("");
    var indicatorButtons = ["ma", "ema", "rsi", "macd", "kd", "atr", "volume"].map(function (indicator) {
      var active = state.activeKlineIndicator === indicator;
      return '<button class="indicator-button' + (active ? " active" : "") + '" type="button"' +
        ' data-action="kline-indicator" data-indicator="' + indicator + '" data-testid="kline-indicator-' + indicator + '"' +
      ' aria-pressed="' + (active ? "true" : "false") + '">' + indicator.toUpperCase() + '</button>';
    }).join("");
    var qualityReasons = model && model.quality && model.quality.reason_codes ? model.quality.reason_codes.join(", ") : "沒有資料";
    var missingSessions = model && model.quality && model.quality.missing_sessions ? model.quality.missing_sessions.join(", ") : "";
    var coverage = model && model.coverage ? model.coverage : {};
    var indicatorReady = coverage.indicator_ready || {};
    var coverageCalendar = coverage.calendar_status === "complete" ? "完整" : coverage.calendar_status === "partial" ? "缺少交易日" : "未提供交易日曆";
    var coverageDepth = coverage.depth_status === "ready" ? "足夠" : coverage.depth_status === "insufficient" ? "不足" : coverage.depth_status === "empty" ? "無資料" : "—";
    var qualityBody = '<div class="kline-quality-grid"><div><span class="detail-label">狀態</span><p data-testid="kline-state">' +
      statusBadge(status) + '</p></div><div><span class="detail-label">原因代碼</span><p>' + text(qualityReasons) +
      '</p></div><div><span class="detail-label">資料截至</span><p class="mono">' + text(model && model.as_of) +
      '</p></div><div><span class="detail-label">可用時間</span><p class="mono">' + text(model && model.available_at) +
      '</p></div></div>' + (missingSessions ? '<div class="kline-missing">缺少交易日：' + text(missingSessions) + '</div>' : "");
    var coverageBody = '<div class="kline-coverage" data-testid="kline-coverage"><div><span class="detail-label">歷史範圍</span><p class="mono">' + text(coverage.first_trading_date) + ' → ' + text(coverage.last_trading_date) +
      '</p></div><div><span class="detail-label">可用 K 線</span><p>' + text(coverage.bar_count) + ' / 交易日 ' + text(coverage.observed_session_count) +
      '</p></div><div><span class="detail-label">指標窗口</span><p>MA ' + (indicatorReady.ma ? "可用" : "不足") + ' · EMA ' + (indicatorReady.ema ? "可用" : "不足") +
      '</p></div><div><span class="detail-label">資料深度與交易日曆</span><p>' + text(coverageDepth) + ' · ' + text(coverageCalendar) +
      '</p></div></div>';
    var chartBody = state.klineRuntimeStatus === "loading" && !model
      ? '<div class="empty-state kline-empty" data-testid="kline-loading"><strong>載入中。</strong><span>正在從本機資料服務載入已納入的 K6a/K6b 資料。</span></div>'
      : bars.length
      ? '<div class="kline-chart-frame" data-testid="kline-chart"><div class="kline-chart-canvas"></div><div class="kline-tooltip" data-testid="kline-tooltip" hidden></div></div>'
      : '<div class="empty-state kline-empty" data-testid="kline-empty"><strong>' + text(STATUS_LABELS[status] || status) + '。</strong><span>此商品與期間沒有已納入的 K 線；不替換成其他期間。</span></div>';
    var indicatorSummary = model && model.indicators && model.indicators[state.activeKlineIndicator];
    return card("行情與 K 線", "收盤資料 · 截止日快照 · 唯讀分析", '<div class="kline-toolbar" data-testid="kline-toolbar">' +
      '<div class="kline-control symbol-search' + (klineSearchFocused ? " search-open" : "") + '"><label><span>搜尋商品</span><input type="search" autocomplete="off" placeholder="代號、名稱或市場" value="' + escapeHtml(klineSearchQuery || selectedId || "") + '" data-action="kline-search" data-testid="kline-instrument" aria-controls="kline-symbol-results"></label>' +
      symbolSearchResults(instruments, klineSearchQuery || selectedId || "", [], selectedId, "kline-symbol-results", "kline-search-pick") + '</div>' +
      '<div class="kline-control"><span>期間</span><div class="period-buttons">' + periodButtons + '</div></div>' +
      '<div class="kline-control"><span>指標</span><div class="indicator-buttons">' + indicatorButtons + '</div></div>' +
      '<div class="kline-control chart-tools"><span>圖表工具</span><div class="chart-tool-buttons">' +
      '<button class="chart-tool-button" type="button" data-action="kline-fit" data-testid="kline-fit">適應範圍</button>' +
      '<button class="chart-tool-button" type="button" data-action="kline-zoom" data-direction="in" data-testid="kline-zoom-in">＋放大</button>' +
      '<button class="chart-tool-button" type="button" data-action="kline-zoom" data-direction="out" data-testid="kline-zoom-out">－縮小</button>' +
      '<button class="chart-tool-button' + (chartDrawingMode ? " active" : "") + '" type="button" data-action="kline-drawing" data-testid="kline-drawing" aria-pressed="' + (chartDrawingMode ? "true" : "false") + '">標記</button>' +
      '<button class="chart-tool-button" type="button" data-action="kline-drawing-clear" data-testid="kline-drawing-clear"' + (chartDrawings.length ? "" : " disabled") + '>清除</button>' +
      '<button class="chart-tool-button" type="button" data-action="kline-template" data-testid="kline-template">' + chartTemplateLabel(chartTemplateName) + '</button>' +
      '</div></div>' +
      '<button class="btn btn-outline" type="button" data-action="watchlist-toggle" data-testid="kline-watchlist-toggle">' +
      ((state.watchlist && state.watchlist.items || []).indexOf(selectedId) >= 0 ? "移出自選" : "加入自選") + '</button>' +
      '</div><div class="kline-context"><div><strong data-testid="kline-instrument-label">' + text(klineLabel(model, instrument)) + '</strong><span>' +
      text((model && model.instrument || instrument) && (model && model.instrument || instrument).instrument_id) + ' · ' + text((model && model.instrument || instrument) && (model && model.instrument || instrument).currency) +
      '</span></div><div class="kline-context-right"><span class="meta-chip">週期 <strong data-testid="kline-period-label">' + text(model && model.period) +
      '</strong></span><span class="meta-chip">調整政策 <strong>' + text(adjustmentPolicyLabel(model && model.adjustment_policy)) + '</strong></span></div></div>' +
      '<div class="kline-chart-wrap">' + chartBody + '</div>' +
      '<div class="kline-summary"><span>目前顯示：' + text(formulaLabel(indicatorSummary && indicatorSummary.formula)) + '</span><span>' + bars.length + ' 根 K 線</span></div>' +
      technicalSnapshotMarkup(model) +
      '<section class="kline-quality" data-testid="kline-quality"><header class="subsection-heading"><h2>資料品質與來源</h2><span class="muted">不在瀏覽器重新推導</span></header>' + qualityBody +
      coverageBody +
      '<div class="kline-provenance"><span>來源：' + text(model && model.source) + '</span><span>資料快照：' + text(model && model.snapshot_digest) + '</span><span>時區：' + text(model && model.timezone) + '</span></div></section>' + valuationMarkup(), "");
  }

  function valuationMarkup() {
    var inputs = state.valuationInputs || {};
    var currentPrice = core.latestKlineClose(state);
    var value = function (field) { return escapeHtml(inputs[field] || ""); };
    return '<section class="valuation-panel" data-testid="valuation-panel"><header class="subsection-heading"><div><h2>個人合理區間試算</h2><span class="muted">自訂輸入 · 統計量化公式待另行設計</span></div><span class="status status-unavailable">未計算</span></header>' +
      '<div class="valuation-grid"><label class="valuation-field"><span>EPS 基準（元）</span><input type="number" min="0" step="0.01" inputmode="decimal" placeholder="例如 10.00" value="' + value("eps") + '" data-action="valuation-input" data-field="eps" data-testid="valuation-eps"></label>' +
      '<label class="valuation-field"><span>合理 PE 下限</span><input type="number" min="0" step="0.1" inputmode="decimal" placeholder="例如 12" value="' + value("peLow") + '" data-action="valuation-input" data-field="peLow" data-testid="valuation-pe-low"></label>' +
      '<label class="valuation-field"><span>合理 PE 上限</span><input type="number" min="0" step="0.1" inputmode="decimal" placeholder="例如 18" value="' + value("peHigh") + '" data-action="valuation-input" data-field="peHigh" data-testid="valuation-pe-high"></label>' +
      '<label class="valuation-field"><span>安全邊際（%）</span><input type="number" min="0" max="100" step="0.1" inputmode="decimal" placeholder="例如 15" value="' + value("safetyMargin") + '" data-action="valuation-input" data-field="safetyMargin" data-testid="valuation-safety-margin"></label></div>' +
      '<div class="valuation-reference"><div><span class="detail-label">目前 K 線收盤價</span><strong class="valuation-price" data-testid="valuation-current-price">' + text(currentPrice === null ? "—" : core.formatNumber(currentPrice)) + '</strong></div><div><span class="detail-label">判斷結果</span><span data-testid="valuation-result">尚未套用個人計算規則</span></div></div>' +
      '<p class="valuation-note">此區塊只保留個人輸入與目前價格參照；不提供網路預設合理價、不自動推導估值，也不會寫入本機資料服務。</p></section>';
  }

  function renderKlineChart() {
    if (chartResizeObserver) chartResizeObserver.disconnect();
    chartResizeObserver = null;
    if (chartInstance) {
      chartInstance.remove();
      chartInstance = null;
    }
    var frame = root.querySelector('[data-testid="kline-chart"]');
    var model = core.selectedKline(state);
    if (!frame || !model || !model.bars || !model.bars.length) return;
    var modelKey = state.selectedKlineInstrumentId + "\n" + state.selectedKlinePeriod;
    if (chartDrawingModelKey !== modelKey) {
      chartDrawingModelKey = modelKey;
      chartDrawings = [];
    }
    var api = window.LightweightCharts;
    var canvas = frame.querySelector(".kline-chart-canvas");
    if (!api || !canvas) {
      canvas.textContent = "圖表元件不可用。";
      return;
    }
    var colorType = api.ColorType && api.ColorType.Solid ? api.ColorType.Solid : "solid";
    var chart = api.createChart(canvas, {
      width: Math.max(canvas.clientWidth || 640, 240),
      height: 340,
      layout: { background: { type: colorType, color: "#ffffff" }, textColor: "#596273" },
      grid: { vertLines: { color: "#edf0f2" }, horzLines: { color: "#edf0f2" } },
      rightPriceScale: { borderColor: "#dfe3e8" },
      timeScale: { borderColor: "#dfe3e8", timeVisible: false },
      crosshair: { mode: api.CrosshairMode ? api.CrosshairMode.Normal : 0 }
    });
    var mainPane = chart.panes()[0];
    var studyPane = null;
    var volumePane = null;
    if (["ma", "ema", "volume"].indexOf(state.activeKlineIndicator) < 0) {
      studyPane = chart.addPane();
      studyPane.setStretchFactor(0.34);
    }
    volumePane = chart.addPane();
    volumePane.setStretchFactor(0.22);
    var candleSeries = mainPane.addSeries(api.CandlestickSeries, {
      upColor: "#d94b4b", downColor: "#0b8f70", borderVisible: false,
      wickUpColor: "#d94b4b", wickDownColor: "#0b8f70"
    });
    candleSeries.setData(model.bars.map(function (bar) {
      return { time: bar.trading_date, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
    }));
    var volumeSeries = volumePane.addSeries(api.HistogramSeries, {
      color: "rgba(41, 98, 255, 0.3)", priceFormat: { type: "volume" }
    });
    volumeSeries.setData(model.bars.map(function (bar) { return { time: bar.trading_date, value: bar.volume, color: "rgba(41, 98, 255, 0.3)" }; }));
    var markers = api.createSeriesMarkers ? api.createSeriesMarkers(candleSeries, chartDrawings) : null;
    var indicator = model.indicators && model.indicators[state.activeKlineIndicator];
    var indicatorPane = studyPane || mainPane;
    function lineData(values) {
      return (values || []).map(function (item, index) {
        var bar = model.bars[index];
        if (!bar || item.value === null) return null;
        return { time: bar.trading_date, value: item.value };
      }).filter(Boolean);
    }
    function addIndicatorLine(values, color, title) {
      var series = indicatorPane.addSeries(api.LineSeries, { color: color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: title });
      series.setData(lineData(values));
      return series;
    }
    if (indicator && ["ma", "ema", "rsi", "atr"].indexOf(state.activeKlineIndicator) >= 0) {
      addIndicatorLine(indicator.values, state.activeKlineIndicator === "ma" ? "#2962ff" : state.activeKlineIndicator === "ema" ? "#c38300" : "#0b8f70", state.activeKlineIndicator.toUpperCase());
    }
    if (indicator && state.activeKlineIndicator === "macd") {
      addIndicatorLine(indicator.values, "#2962ff", "MACD");
      addIndicatorLine(indicator.signal_values, "#c38300", "Signal");
    }
    if (indicator && state.activeKlineIndicator === "kd") {
      addIndicatorLine(indicator.values, "#2962ff", "K");
      addIndicatorLine(indicator.d_values, "#c38300", "D");
    }
    chart.timeScale().fitContent();
    var tooltip = frame.querySelector('[data-testid="kline-tooltip"]');
    chart.subscribeCrosshairMove(function (param) {
      if (!tooltip || !param.point || !param.time || param.point.x < 0 || param.point.y < 0) {
        if (tooltip) tooltip.hidden = true;
        return;
      }
      var candle = param.seriesData.get(candleSeries);
      if (!candle) return;
      tooltip.textContent = String(param.time) + " · O " + candle.open + " H " + candle.high + " L " + candle.low + " C " + candle.close;
      tooltip.hidden = false;
    });
    chart.subscribeClick(function (param) {
      if (!chartDrawingMode || !markers || !param.time) return;
      var bar = model.bars.find(function (item) { return item.trading_date === param.time; });
      if (!bar) return;
      chartDrawings = chartDrawings.filter(function (item) { return item.time !== param.time; });
      chartDrawings.push({ time: param.time, position: "aboveBar", color: "#2962ff", shape: "circle", text: "標記", size: 1 });
      markers.setMarkers(chartDrawings);
      var clearButton = root.querySelector('[data-testid="kline-drawing-clear"]');
      if (clearButton) clearButton.disabled = false;
    });
    chartInstance = chart;
    if (window.ResizeObserver) {
      chartResizeObserver = new ResizeObserver(function () {
        chart.applyOptions({ width: Math.max(canvas.clientWidth || 640, 240) });
      });
      chartResizeObserver.observe(canvas);
    }
  }

  function productRows(products, limit) {
    var rows = Array.isArray(products) ? products.slice(0, limit || products.length) : [];
    if (!rows.length) return '<div class="empty-state"><strong>此資料快照沒有商品資料列。</strong><span>資料模型為空；不插入佔位值。</span></div>';
    return '<div class="table-responsive"><table class="table"><thead><tr><th>商品</th><th>日期</th><th>收盤</th><th>品質</th><th></th></tr></thead><tbody>' +
      rows.map(function (row, index) {
        var bar = row.bar || {};
        var date = bar.trading_date || (row.fundamental || {}).period_end;
      return '<tr><td><span class="cell-strong">' + text(core.productLabel(row)) +
          '</span><small>' + text(recordTypeLabel(row.record_type)) + '</small></td><td>' + text(date) +
          '</td><td class="cell-mono">' + core.formatNumber(bar.close_raw) +
          '</td><td>' + statusBadge(core.qualityLabel(row)) +
          '</td><td class="table-action"><button class="btn btn-outline btn-sm" type="button" data-action="product" data-index="' + index + '">詳情</button></td></tr>';
      }).join("") + "</tbody></table></div>";
  }

  function evidenceMarkup(links) {
    var items = Array.isArray(links) ? links : [];
    if (!items.length) return '<div class="empty-state"><strong>沒有證據連結。</strong><span>此資料快照沒有可用的資料脈絡。</span></div>';
    return '<ul class="evidence-list">' + items.map(function (link) {
      return '<li><span class="evidence-mark" aria-hidden="true">↗</span><a href="' + escapeHtml(link) + '">' + text(link) + '</a></li>';
    }).join("") + "</ul>";
  }

  function featureMarkup() {
    var rows = Array.isArray(view.features) ? view.features : [];
    if (!rows.length) return '<div class="empty-state"><strong>此資料快照沒有因子資料列。</strong><span>不從商品資料列推導因子值。</span></div>';
    return '<div class="table-responsive"><table class="table"><thead><tr><th>商品</th><th>交易日</th><th>因子值</th><th>資料截至</th></tr></thead><tbody>' +
      rows.map(function (row) {
        var values = row.features || {};
        var labels = Object.keys(values).map(function (key) {
          return '<span class="value-chip">' + text(key) + ': ' + core.formatNumber(values[key].value) + '</span>';
        }).join("");
        return '<tr><td class="cell-strong">' + text(row.security_id || row.instrument || "—") +
          '</td><td>' + text(row.trading_date) + '</td><td><div class="value-chips">' +
          (labels || "—") + '</div></td><td>' + text(row.as_of) + '</td></tr>';
      }).join("") + "</tbody></table></div>";
  }

  function featuresMarkup() {
    return pageHeader("技術指標", "均線 · 動能 · 趨勢 · 成交量") +
      '<div class="feature-workbench" data-testid="feature-workbench">' +
      technicalSnapshotMarkup(core.selectedKline(state)) +
      '</div>' +
      card("技術因子快照", "同一份 K 線資料的可追溯計算結果", featureMarkup());
  }

  function backtestSettingsMarkup() {
    var savedLabel = backtestSettingsSaved ? "已儲存至本機 prototype 草稿" : "尚未儲存；不會啟動回測";
    return '<section class="backtest-settings" data-testid="backtest-settings"><header class="backtest-settings-header"><div><span class="eyebrow">RESEARCH VALIDATION SETTINGS</span><h2>驗證設定草稿</h2><p>先固定資料、訊號與成交時間，再由人為決定是否執行可重播研究。</p></div><span class="status status-' + (backtestSettingsSaved ? "saved" : "draft") + '" data-testid="backtest-settings-status">' + text(savedLabel) + '</span></header><div class="backtest-settings-grid"><label><span>股票母體</span><select data-action="backtest-setting-input" data-field="universe" data-testid="backtest-universe">' + selectOptionMarkup(["目前自選", "目前群組", "人工指定清單"], backtestSettingsDraft.universe) + '</select></label><label><span>訊號計算時間</span><select data-action="backtest-setting-input" data-field="signal_time" data-testid="backtest-signal-time">' + selectOptionMarkup(["收盤後"], backtestSettingsDraft.signal_time) + '</select></label><label><span>成交時間</span><select data-action="backtest-setting-input" data-field="fill_time" data-testid="backtest-fill-time">' + selectOptionMarkup(["次日開盤", "次日 VWAP", "次日收盤"], backtestSettingsDraft.fill_time) + '</select></label><label><span>再平衡頻率</span><select data-action="backtest-setting-input" data-field="rebalance" data-testid="backtest-rebalance">' + selectOptionMarkup(["每週", "每月", "每季"], backtestSettingsDraft.rebalance) + '</select></label><label><span>最大持股數</span><input type="number" min="1" max="100" data-action="backtest-setting-input" data-field="max_positions" data-testid="backtest-max-positions" value="' + escapeHtml(backtestSettingsDraft.max_positions) + '"></label></div><div class="backtest-settings-footer"><span>禁止使用今日收盤資料、又以今日收盤成交；所有正式結果仍需 PIT、成本與資料品質檢查。</span><button class="btn btn-primary" type="button" data-action="backtest-settings-save" data-testid="backtest-settings-save">儲存設定草稿</button></div></section>';
  }

  function backtestMarkup() {
    var backtest = view.backtest || {};
    if (backtest.status !== "available" || !backtest.result) {
      return '<div class="empty-state"><strong>回測狀態為 ' + text(backtest.status || "無資料") + '。</strong><span>在資料截至日確認可用前，不顯示結果。</span></div>';
    }
    var result = backtest.result;
    var metrics = result.metrics || {};
    var cards = [['cumulative_return', core.formatPercent(metrics.cumulative_return), "teal"],
      ['annualized_return', core.formatPercent(metrics.annualized_return), "green"],
      ['max_drawdown', core.formatPercent(metrics.max_drawdown), "red"],
      ['turnover', core.formatNumber(metrics.turnover), "blue"],
      ['trade_count', core.formatNumber(metrics.trade_count), "yellow"]];
    var curve = Array.isArray(result.equity_curve) ? result.equity_curve : [];
    return '<div class="row col-3 compact-metrics">' + cards.map(function (item) {
      return '<article class="card metric-card"><span class="stat-icon ' + item[2] + '" aria-hidden="true">•</span><div><div class="stat-label">' +
        text(item[0]) + '</div><div class="metric-value">' + text(item[1]) + '</div></div></article>';
    }).join("") + '</div><div class="subsection"><div class="subsection-heading"><h2>資產曲線</h2><span class="muted">來源結果 · 唯讀</span></div>' +
      (curve.length ? '<div class="table-responsive"><table class="table"><thead><tr><th>日期</th><th>資產</th><th>部位</th></tr></thead><tbody>' + curve.map(function (point) {
        return '<tr><td>' + text(point.date || point.trading_date) + '</td><td class="cell-mono">' + core.formatNumber(point.equity) +
          '</td><td>' + text(point.position) + '</td></tr>';
      }).join("") + '</tbody></table></div>' : '<div class="empty-state">沒有資產曲線資料點。</div>') + '</div>';
  }

  function card(title, subtitle, body, action) {
    return '<section class="card"><header class="card-header"><div><h2 class="card-title">' + text(title) +
      '</h2><div class="card-subtitle">' + text(subtitle) + '</div></div>' +
      (action || "") + '</header><div class="card-body">' + body + '</div></section>';
  }

  function detailDialog() {
    var row = core.selectedProduct(state);
    if (!state.dialogOpen || !row) return "";
    var quality = row.quality || {};
    var provenance = row.provenance || {};
    return '<div class="dialog-layer" role="presentation"><div class="dialog-backdrop" data-action="close-dialog"></div><section class="detail-dialog modal" role="dialog" aria-modal="true" aria-labelledby="detail-title">' +
      '<header class="dialog-header"><div><div class="page-pretitle">唯讀資料列詳情</div><h2 id="detail-title">' + text(core.productLabel(row)) +
      '</h2></div><button class="icon-button" type="button" data-action="close-dialog" aria-label="關閉對話框">×</button></header>' +
      '<div class="detail-grid"><div><span class="detail-label">品質</span><p>' + statusBadge(core.qualityLabel(row)) +
      '</p></div><div><span class="detail-label">資料類型</span><p>' + text(recordTypeLabel(row.record_type)) +
      '</p></div><div><span class="detail-label">原因代碼</span><p>' + text((quality.reason_codes || []).join(", ") || "無") +
      '</p></div><div><span class="detail-label">來源快照</span><p class="mono">' + text(provenance.snapshot_id) +
      '</p></div><div><span class="detail-label">可用時間</span><p>' + text(provenance.available_at) +
      '</p></div><div><span class="detail-label">公式版本</span><p>' + text(row.formula_version) + "</p></div></div>" +
      '<footer class="dialog-footer"><span>值來自 S8 資料快照。</span><button class="btn btn-primary" type="button" data-action="close-dialog">關閉</button></footer></section></div>';
  }

  function mainMarkup() {
    var section = state.activeSection;
    if (section === "market") return marketTerminalMarkup();
    if (section === "products") return pageHeader("我的自選", "自選清單 · 報價欄位 · 快速切換") + '<div class="data-source-banner"><strong>免費資料本地保存</strong><span>目前顯示已核准的本地資料；未接入付費訂閱、即時行情或券商。</span></div>' + watchlistMarkup() + card("資料快照", "目前可供研究的原始／標準化列", productRows(view.products));
    if (section === "features") return featuresMarkup();
    if (section === "research") return researchMarkup();
    if (section === "fundamentals") return fundamentalsMarkup();
    if (section === "stories") return storiesMarkup();
    if (section === "backtest") return pageHeader("驗證報告", "回測設定 · 研究結果 · 資料品質") + backtestSettingsMarkup() + '<div class="report-command-bar"><div><strong>研究報告快照</strong><span>只讀取已保存的回測結果；不自動執行。</span></div><div class="report-tabs"><button class="report-tab active" type="button">績效</button><button class="report-tab" type="button">風險</button><button class="report-tab" type="button">持倉</button><button class="report-tab" type="button">交易</button></div></div><div class="calculation-boundary"><strong>這裡只保存人為啟動的研究計算結果。</strong><span>不代表即時策略、不會送單，也不會自動升格為投資決策。</span></div>' + card("回測報告快照", "可重播的研究結果，不是交易執行", backtestMarkup());
    if (section === "evidence") return pageHeader("資料與證據", "資料脈絡與可重現性") + card("證據登錄表", "資料快照識別與來源連結", '<div class="lineage-grid"><div><span class="detail-label">資料格式</span><p>' + text(view.schema) +
      '</p></div><div><span class="detail-label">視圖摘要雜湊</span><p class="mono">' + text(view.view_digest || "未記錄") +
      '</p></div><div><span class="detail-label">資料截至</span><p>' + text(view.as_of) + '</p></div><div><span class="detail-label">證據連結</span>' + evidenceMarkup(view.evidence_links) + '</div></div>');
    return cockpitMarkup();
  }

  function systemTopbarMarkup() {
    var active = state.activeSection;
    var links = [{ id: "market", label: "行情" }, { id: "products", label: "自選" }, { id: "research", label: "因子" }, { id: "backtest", label: "驗證" }, { id: "stories", label: "筆記" }];
    var instruments = core.klineInstruments(state.view);
    return '<header class="topbar system-topbar"><div class="system-topbar-left"><div class="breadcrumb"><span>TQR / MARKET</span><span class="sep">/</span><span class="current">' + text(core.SECTIONS.find(function (item) { return item.id === active; }).label) + '</span></div><nav class="system-quick-nav" aria-label="快速工具">' + links.map(function (link) { return '<button class="system-quick-link' + (active === link.id ? ' active' : '') + '" type="button" data-action="section" data-section="' + link.id + '">' + text(link.label) + '</button>'; }).join('') + '</nav></div><div class="system-topbar-right"><div class="system-global-search symbol-search"><label><span>搜尋標的</span><input type="search" autocomplete="off" placeholder="代號 / 名稱" value="' + escapeHtml(klineSearchQuery || '') + '" data-action="global-search" data-testid="global-search" aria-controls="global-search-results"></label>' + symbolSearchResults(instruments, klineSearchQuery, [], state.selectedKlineInstrumentId, "global-search-results", "global-search-pick") + '</div><span class="system-feed-status"><i></i>EOD · 本機</span><span class="read-only-pill">研究唯讀</span><button class="btn btn-outline btn-sm" type="button" data-action="reset">重設視圖</button></div></header>';
  }

  function render() {
    root.innerHTML = '<div class="app-shell"><aside class="sidebar"><div class="sidebar-brand"><img class="brand-logo" src="./tqr-logo.svg" alt="TQR"><span class="brand-name">TQR <small>個人台股研究終端</small></span></div><nav class="sidebar-nav" aria-label="主導覽">' + navMarkup() + '</nav><div class="sidebar-footer"><div class="sidebar-note"><span class="read-only-icon">唯</span><p><strong>免費優先 · 本機記錄</strong><span>行情、筆記與資料唯讀；不含即時、下單或自動交易。</span></p></div></div></aside><main class="main">' + systemTopbarMarkup() + '<div class="page-wrapper" id="main-content" tabindex="-1">' + mainMarkup() + '</div><footer class="footer"><span>資料格式 ' + text(view.schema) + '</span><span>本機行情 · 自選 · 筆記</span></footer></main></div>' + detailDialog();
    renderKlineChart();
    ensureKlineRuntime();
  }

  root.addEventListener("click", function (event) {
    var target = event.target.closest("[data-action]");
    if (!target) return;
    // A click on a form control must not re-render the shell. Replacing the
    // input/select immediately after the browser focuses it makes typing and
    // native dropdown selection require holding the mouse button down.
    if (target.matches("input, select, textarea")) return;
    var action = target.getAttribute("data-action");
    if (action === "note-delete") {
      if (window.confirm("確定刪除這筆本機研究筆記？")) {
        state = core.reduce(state, { type: "DELETE_NOTE", noteId: target.getAttribute("data-note-id") });
        persistNotes();
      }
    }
    if (action === "note-submit") addNoteFromDraft();
    if (action === "alert-add") addAlertFromDraft();
    if (action === "alert-delete") {
      state = core.reduce(state, { type: "DELETE_ALERT", alertId: target.getAttribute("data-alert-id") });
      persistAlerts();
    }
    if (action === "alert-evaluate") evaluateAlerts();
    if (action === "alert-clear-events") state = core.reduce(state, { type: "CLEAR_ALERT_EVENTS" });
    if (action === "screen-condition") {
      var conditionId = target.getAttribute("data-condition-id");
      var conditionIndex = screenConditions.indexOf(conditionId);
      if (conditionIndex >= 0) screenConditions.splice(conditionIndex, 1);
      else if (conditionId) screenConditions.push(conditionId);
    }
    if (action === "formula-add") {
      formulaRows.push(defaultFormulaRow("rule-" + Date.now()));
    }
    if (action === "formula-remove") {
      var removeRuleId = target.getAttribute("data-rule-id");
      if (formulaRows.length > 1) formulaRows = formulaRows.filter(function (rule) { return rule.id !== removeRuleId; });
    }
    if (action === "financial-review-save") {
      financialReviewSaved = savePrototypeDraft(FINANCIAL_REVIEW_LOCAL_STORAGE_KEY, financialReviewDraft);
    }
    if (action === "backtest-settings-save") {
      backtestSettingsSaved = savePrototypeDraft(BACKTEST_SETTINGS_LOCAL_STORAGE_KEY, backtestSettingsDraft);
    }
    if (action === "kline-fit" && chartInstance) {
      chartInstance.timeScale().fitContent();
      return;
    }
    if (action === "kline-zoom" && chartInstance) {
      var range = chartInstance.timeScale().getVisibleLogicalRange();
      if (range) {
        var center = (range.from + range.to) / 2;
        var span = Math.max(range.to - range.from, 1);
        var factor = target.getAttribute("data-direction") === "in" ? 0.7 : 1.35;
        var nextSpan = Math.max(span * factor, 1);
        chartInstance.timeScale().setVisibleLogicalRange({ from: center - nextSpan / 2, to: center + nextSpan / 2 });
      }
      return;
    }
    if (action === "watchlist-save") {
      persistWatchlist();
      return;
    }
    if (action === "data-update") {
      requestDataUpdate();
      return;
    }
    if (action === "watchlist-group-create") {
      state = core.reduce(state, { type: "CREATE_WATCHLIST_GROUP", name: watchlistGroupNameQuery });
      watchlistGroupNameQuery = "";
    }
    if (action === "watchlist-group-delete") {
      var groupId = target.getAttribute("data-group-id") || state.activeWatchlistGroupId;
      var group = (state.watchlistGroups || []).find(function (item) { return item.id === groupId; });
      if (group && group.id !== "default" && window.confirm("確定刪除群組「" + group.name + "」？群組內個股不會從其他群組移除。")) {
        state = core.reduce(state, { type: "DELETE_WATCHLIST_GROUP", groupId: group.id });
      }
    }
    if (action === "section") state = core.reduce(state, { type: "SELECT_SECTION", section: target.getAttribute("data-section") });
    if (action === "product") state = core.reduce(state, { type: "OPEN_PRODUCT_DETAIL", index: Number(target.getAttribute("data-index")) });
    if (action === "kline-period") state = core.reduce(state, { type: "SELECT_KLINE_PERIOD", period: target.getAttribute("data-period") });
    if (action === "kline-indicator") state = core.reduce(state, { type: "TOGGLE_KLINE_INDICATOR", indicator: target.getAttribute("data-indicator") });
    if (action === "watchlist-search-pick") {
      watchlistSearchSelection = target.getAttribute("data-instrument-id");
      watchlistSearchQuery = watchlistSearchSelection;
      watchlistSearchFocused = false;
    }
    if (action === "kline-search-pick") {
      klineSearchQuery = target.getAttribute("data-instrument-id");
      klineSearchFocused = false;
      state = core.reduce(state, { type: "SELECT_KLINE_INSTRUMENT", instrumentId: klineSearchQuery });
    }
    if (action === "global-search-pick") {
      klineSearchQuery = target.getAttribute("data-instrument-id");
      klineSearchFocused = false;
      state = core.reduce(state, { type: "SELECT_KLINE_INSTRUMENT", instrumentId: klineSearchQuery });
    }
    if (action === "kline-drawing") chartDrawingMode = !chartDrawingMode;
    if (action === "kline-drawing-clear") chartDrawings = [];
    if (action === "kline-template") {
      chartTemplateName = chartTemplateName === "default" ? "research" : "default";
      chartDrawingMode = false;
      state = core.reduce(state, { type: "TOGGLE_KLINE_INDICATOR", indicator: chartTemplateName === "research" ? "ma" : "ema" });
    }
    if (action === "watchlist-add") {
      var exactSelection = resolveSearchSelection(core.klineInstruments(state.view), watchlistSearchQuery);
      var addInstrumentId = watchlistSearchSelection || (exactSelection && exactSelection.instrument_id);
      if (addInstrumentId) {
        state = core.reduce(state, { type: "TOGGLE_WATCHLIST", instrumentId: addInstrumentId });
        watchlistSearchSelection = null;
        watchlistSearchQuery = "";
        watchlistSearchFocused = false;
      }
    }
    if (action === "watchlist-toggle" && state.selectedKlineInstrumentId) {
      state = core.reduce(state, { type: "TOGGLE_WATCHLIST", instrumentId: state.selectedKlineInstrumentId });
    }
    if (action === "research-add-group") {
      state = core.reduce(state, { type: "ADD_TO_WATCHLIST_GROUP", instrumentId: target.getAttribute("data-instrument-id") });
    }
    if (action === "screen-apply") state = core.reduce(state, { type: "APPLY_SCREEN_SPEC" });
    if (action === "watchlist-remove") {
      state = core.reduce(state, { type: "REMOVE_WATCHLIST", instrumentId: target.getAttribute("data-instrument-id") });
      if (watchlistSearchSelection === target.getAttribute("data-instrument-id")) watchlistSearchSelection = null;
      watchlistSearchFocused = false;
    }
    if (action === "watchlist-clear") {
      if (window.confirm("確定清除目前自選草稿？要同步到本機 JSON，仍需再按「儲存自選清單」。")) {
        state = core.reduce(state, { type: "CLEAR_WATCHLIST" });
      }
    }
    if (action === "close-dialog") state = core.reduce(state, { type: "CLOSE_DIALOG" });
    if (action === "reset") {
      if (!state.watchlist || !state.watchlist.dirty || window.confirm("目前自選草稿尚未儲存；確定只重設視圖、不清除本機自選清單？")) {
        state = core.reduce(state, { type: "RESET" });
        watchlistSearchSelection = null;
        watchlistSearchQuery = "";
        watchlistSearchFocused = false;
        klineSearchQuery = state.selectedKlineInstrumentId || "";
        klineSearchFocused = false;
        chartDrawingMode = false;
        chartDrawings = [];
        chartDrawingModelKey = null;
        chartTemplateName = "default";
        screenConditions = [];
      }
    }
    render();
    if (action === "kline-period" || action === "kline-search-pick" || action === "global-search-pick") requestKlineModel();
    if (action === "watchlist-add" || action === "watchlist-toggle") requestWatchlistModels();
  });

  root.addEventListener("change", function (event) {
    var target = event.target;
    if (!target) return;
    if (target.getAttribute("data-action") === "kline-search") {
      klineSearchQuery = target.value;
      return;
    }
    if (target.getAttribute("data-action") === "watchlist-group-select") {
      state = core.reduce(state, { type: "SELECT_WATCHLIST_GROUP", groupId: target.value });
      render();
      return;
    }
    if (target.getAttribute("data-action") === "data-update-years") {
      state = core.reduce(state, { type: "SET_DATA_UPDATE_YEARS", years: target.value });
      render();
      return;
    }
    if (target.getAttribute("data-action") === "data-update-scope") {
      state = core.reduce(state, { type: "SET_DATA_UPDATE_SCOPE", scope: target.value });
      render();
      return;
    }
    if (target.getAttribute("data-action") === "screen-input") {
      state = core.reduce(state, { type: "SET_SCREEN_SPEC", field: target.getAttribute("data-field"), value: target.value });
      return;
    }
    if (target.getAttribute("data-action") === "formula-input") {
      formulaRows = formulaRows.map(function (rule) {
        if (rule.id !== target.getAttribute("data-rule-id")) return rule;
        var next = Object.assign({}, rule);
        next[target.getAttribute("data-field")] = target.type === "checkbox" ? String(target.checked) : target.value;
        if (target.type === "checkbox") next.enabled = target.checked;
        return next;
      });
      return;
    }
    if (target.getAttribute("data-action") === "financial-review-input") {
      financialReviewDraft[target.getAttribute("data-field")] = target.value;
      financialReviewSaved = false;
      return;
    }
    if (target.getAttribute("data-action") === "backtest-setting-input") {
      backtestSettingsDraft[target.getAttribute("data-field")] = target.value;
      backtestSettingsSaved = false;
    }
    if (target.getAttribute("data-action") === "alert-input") {
      alertDraft[target.getAttribute("data-field")] = target.value;
      var alertAddButtonOnChange = root.querySelector('[data-testid="alert-add"]');
      var alertInstrumentOnChange = selectedKlineInstrument();
      if (alertAddButtonOnChange) {
        alertAddButtonOnChange.disabled = !(alertInstrumentOnChange && alertInstrumentOnChange.symbol && String(alertDraft.label || "").trim() && alertDraft.value !== "");
      }
    }
  });

  root.addEventListener("input", function (event) {
    var target = event.target;
    if (!target) return;
    if (target.getAttribute("data-action") === "watchlist-search") {
      watchlistSearchQuery = target.value;
      watchlistSearchSelection = null;
      watchlistSearchFocused = true;
      var watchlistResults = symbolSearchResults(core.klineInstruments(state.view), watchlistSearchQuery, core.watchlistItemsForActiveGroup(state), null, "watchlist-symbol-results", "watchlist-search-pick");
      refreshSearchResults("watchlist-symbol-results", watchlistResults);
      refreshSearchResults("terminal-watchlist-results", symbolSearchResults(core.klineInstruments(state.view), watchlistSearchQuery, core.watchlistItemsForActiveGroup(state), null, "terminal-watchlist-results", "watchlist-search-pick"));
      refreshWatchlistAddButtons();
      return;
    }
    if (target.getAttribute("data-action") === "watchlist-group-name") {
      watchlistGroupNameQuery = target.value;
      var createGroupButton = root.querySelector('[data-testid="watchlist-group-create"]');
      if (createGroupButton) createGroupButton.disabled = !watchlistGroupNameQuery.trim();
      return;
    }
    if (target.getAttribute("data-action") === "kline-search") {
      klineSearchQuery = target.value;
      klineSearchFocused = true;
      refreshSearchResults("kline-symbol-results", symbolSearchResults(core.klineInstruments(state.view), klineSearchQuery, [], state.selectedKlineInstrumentId, "kline-symbol-results", "kline-search-pick"));
      return;
    }
    if (target.getAttribute("data-action") === "global-search") {
      klineSearchQuery = target.value;
      refreshSearchResults("global-search-results", symbolSearchResults(core.klineInstruments(state.view), klineSearchQuery, [], state.selectedKlineInstrumentId, "global-search-results", "global-search-pick"));
      return;
    }
    if (target.getAttribute("data-action") === "screen-input") {
      state = core.reduce(state, { type: "SET_SCREEN_SPEC", field: target.getAttribute("data-field"), value: target.value });
      return;
    }
    if (target.getAttribute("data-action") === "note-input") {
      state = core.reduce(state, { type: "SET_NOTE_DRAFT", field: target.getAttribute("data-field"), value: target.value });
      return;
    }
    if (target.getAttribute("data-action") === "formula-input") {
      formulaRows = formulaRows.map(function (rule) {
        if (rule.id !== target.getAttribute("data-rule-id")) return rule;
        var next = Object.assign({}, rule);
        next[target.getAttribute("data-field")] = target.value;
        return next;
      });
      return;
    }
    if (target.getAttribute("data-action") === "financial-review-input") {
      financialReviewDraft[target.getAttribute("data-field")] = target.value;
      financialReviewSaved = false;
      return;
    }
    if (target.getAttribute("data-action") === "backtest-setting-input") {
      backtestSettingsDraft[target.getAttribute("data-field")] = target.value;
      backtestSettingsSaved = false;
      return;
    }
    if (target.getAttribute("data-action") === "alert-input") {
      alertDraft[target.getAttribute("data-field")] = target.value;
      var alertAddButton = root.querySelector('[data-testid="alert-add"]');
      var alertInstrument = selectedKlineInstrument();
      if (alertAddButton) {
        alertAddButton.disabled = !(alertInstrument && alertInstrument.symbol && String(alertDraft.label || "").trim() && alertDraft.value !== "");
      }
      return;
    }
    if (target.getAttribute("data-action") !== "valuation-input") return;
    state = core.reduce(state, {
      type: "SET_VALUATION_INPUT",
      field: target.getAttribute("data-field"),
      value: target.value
    });
  });

  root.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || form.getAttribute("data-note-form") !== "true") return;
    event.preventDefault();
    var draft = state.noteDraft || {};
    if (!String(draft.title || "").trim() || !String(draft.body || "").trim()) return;
    var quote = selectedQuoteSnapshot();
    state = core.reduce(state, {
      type: "ADD_NOTE",
      note: {
        id: "note-" + Date.now(),
        instrument_id: (quote.instrument && quote.instrument.instrument_id) || state.selectedKlineInstrumentId || "",
        title: String(draft.title).trim(),
        body: String(draft.body).trim(),
        tags: String(draft.tags || "").trim(),
        created_at: new Date().toISOString().slice(0, 16).replace("T", " ")
      }
    });
    persistNotes();
    render();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.dialogOpen) {
      state = core.reduce(state, { type: "CLOSE_DIALOG" });
      render();
    }
  });

  loadPrototypeDrafts();
  ensureNotesRuntime();
  ensureAlertsRuntime();
  ensureSidecarUrl().then(function () {
    render();
  });
}());
