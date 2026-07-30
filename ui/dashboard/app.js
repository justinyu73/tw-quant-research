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
  var VALUATION_LOCAL_STORAGE_KEY = "tqr-scenario-valuation-worksheets.v1";
  var FINANCIAL_REVIEW_LOCAL_STORAGE_KEY = "tw-quant-engine-financial-review.prototype-v1";
  var watchlistModelRequests = {};
  var klineInstrumentsAttempts = 0;
  var KLINE_INSTRUMENTS_MAX_ATTEMPTS = 40;
  var KLINE_INSTRUMENTS_RETRY_MS = 500;
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
  var financialReviewDraft = defaultFinancialReviewDraft();
  var financialReviewSaved = false;
  var dataUpdateInFlight = false;
  var alertsLoadStarted = false;
  var alertsPersistenceAvailable = null;
  var alertEvaluateInFlight = false;
  var THEME_LOCAL_STORAGE_KEY = "tw-quant-engine-theme.v1";
  var appVersion = "";
  var updateStatus = { state: "idle", version: "", message: "" };
  var updateCheckInFlight = false;
  var updateInstallInFlight = false;

  function currentTheme() {
    try {
      var raw = window.localStorage ? window.localStorage.getItem(THEME_LOCAL_STORAGE_KEY) : null;
      return raw === "dark" ? "dark" : "light";
    } catch (error) {
      return "light";
    }
  }

  function applyTheme(theme) {
    var normalized = theme === "dark" ? "dark" : "light";
    if (normalized === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    try {
      if (window.localStorage) window.localStorage.setItem(THEME_LOCAL_STORAGE_KEY, normalized);
    } catch (error) {
      // localStorage unavailable: theme stays session-local only.
    }
  }

  function ensureAppVersion() {
    var tauriApp = window.__TAURI__ && window.__TAURI__.app;
    if (tauriApp && typeof tauriApp.getVersion === "function") {
      tauriApp.getVersion()
        .then(function (version) {
          appVersion = String(version || "");
          if (state.activeSection === "settings") render();
        })
        .catch(function () {});
    }
  }

  function checkAppUpdate() {
    if (updateCheckInFlight || updateInstallInFlight) return;
    updateCheckInFlight = true;
    updateStatus = { state: "checking", version: "", message: "" };
    render();
    tauriInvoke("check_app_update", {})
      .then(function (payload) {
        if (payload && payload.update_available) {
          updateStatus = { state: "available", version: String(payload.version || ""), message: "" };
        } else {
          updateStatus = { state: "latest", version: "", message: "" };
        }
      })
      .catch(function (error) {
        updateStatus = { state: "error", version: "", message: error && error.message ? String(error.message) : "update_check_failed" };
      })
      .then(function () {
        updateCheckInFlight = false;
        render();
      });
  }

  function installAppUpdate() {
    if (updateInstallInFlight) return;
    updateInstallInFlight = true;
    updateStatus = { state: "installing", version: updateStatus.version, message: "" };
    render();
    // A successful install restarts the app, so only the failure path returns.
    tauriInvoke("install_app_update", {})
      .catch(function (error) {
        updateStatus = { state: "error", version: "", message: error && error.message ? String(error.message) : "update_install_failed" };
        updateInstallInFlight = false;
        render();
      });
  }
  var alertDraft = defaultAlertDraft();
  var valuationLoadStarted = false;
  var valuationEvaluateInFlight = false;
  var valuationDraft = defaultValuationDraft();
  var BUY_PLAN_LOCAL_STORAGE_KEY = "tqr-buy-plans.v1";
  var buyPlanDraft = defaultBuyPlanDraft();
  var buyPlansLoaded = false;

  function defaultBuyPlanDraft() {
    return { totalBudget: "", allocFirst: "20", allocSecond: "25", allocSweet: "30", allocReserve: "25", maxPositionPct: "" };
  }

  function buyPlanDraftFrom(plan) {
    return {
      totalBudget: plan.total_budget ? String(plan.total_budget) : "",
      allocFirst: String(plan.allocations.first),
      allocSecond: String(plan.allocations.second),
      allocSweet: String(plan.allocations.sweet),
      allocReserve: String(plan.allocations.reserve),
      maxPositionPct: plan.max_position_pct ? String(plan.max_position_pct) : ""
    };
  }

  function loadBuyPlans() {
    if (buyPlansLoaded) return;
    buyPlansLoaded = true;
    try {
      var raw = window.localStorage.getItem(BUY_PLAN_LOCAL_STORAGE_KEY);
      if (raw) state = core.reduce(state, { type: "LOAD_BUY_PLANS", payload: JSON.parse(raw) });
    } catch (error) {
      // A corrupt or unavailable store leaves the plans empty rather than
      // guessing values the human never entered.
    }
  }

  function persistBuyPlans() {
    try {
      window.localStorage.setItem(BUY_PLAN_LOCAL_STORAGE_KEY, JSON.stringify(core.buyPlanStorePayload(state)));
    } catch (error) {
      // Browser preview without storage still keeps the in-memory plan.
    }
  }

  function saveBuyPlanFromDraft() {
    var instrumentId = state.selectedKlineInstrumentId;
    if (!instrumentId || core.buyPlanFormIssues(buyPlanDraft).length) return;
    state = core.reduce(state, {
      type: "SET_BUY_PLAN",
      instrumentId: instrumentId,
      plan: {
        total_budget: Number(buyPlanDraft.totalBudget),
        allocations: {
          first: Number(buyPlanDraft.allocFirst),
          second: Number(buyPlanDraft.allocSecond),
          sweet: Number(buyPlanDraft.allocSweet),
          reserve: Number(buyPlanDraft.allocReserve)
        },
        max_position_pct: buyPlanDraft.maxPositionPct === "" ? 0 : Number(buyPlanDraft.maxPositionPct)
      }
    });
    persistBuyPlans();
    render();
  }

  function defaultValuationDraft() {
    return {
      label: "",
      bearEps: "", bearPe: "",
      baseEps: "", basePe: "",
      bullEps: "", bullPe: "",
      ratioWatch: "90", ratioFirst: "85", ratioSecond: "80", ratioSweet: "75", ratioExtreme: "65",
      epsPeriod: "", epsKind: "estimate", peRationale: "",
      financialDataDate: "", valuationDate: todayIso(), changeReason: ""
    };
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

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

  // Shared field-level rejection feedback (TQR-FORM-FEEDBACK): whenever a form
  // button is disabled because a rule rejects the input, the issue list must be
  // visible next to the form and name the field plus the expected format.
  function formIssuesMarkup(issues, testId) {
    var list = Array.isArray(issues) ? issues : [];
    return '<ul class="form-issues" data-testid="' + testId + '"' + (list.length ? "" : " hidden") + '>' +
      list.map(function (item) {
        return '<li data-field="' + escapeHtml(item.field) + '">' + text(item.message) + '</li>';
      }).join("") + '</ul>';
  }

  function refreshFormIssues(testId, issues) {
    var nodes = root.querySelectorAll('[data-testid="' + testId + '"]');
    if (!nodes.length) return;
    var markup = formIssuesMarkup(issues, testId);
    nodes.forEach(function (node) { node.outerHTML = markup; });
  }


  function defaultFinancialReviewDraft() {
    return {
      industry: "Other",
      watch_status: "基本面待確認",
      score: "",
      note: ""
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
  }

  function navMarkup() {
    var symbols = { home: "\u2302", watchlist: "\u25a6", company: "\u25a5", valuation: "\u25c8", buyplan: "\u2317", review: "\u2713" };
    return '<div class="nav-section"><div class="nav-label">\u50f9\u503c\u7814\u7a76</div><div class="nav-group">' +
      core.PRIMARY_SECTION_IDS.map(function (id) {
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
    }).join("") + '</div><div class="story-footer"><span>' + links.length + ' 個可追溯證據連結</span><button class="btn btn-outline btn-sm" type="button" data-action="section" data-section="company">開啟追蹤</button></div>', "");
  }



  function financialTrackerMarkup() {
    var quote = selectedQuoteSnapshot();
    var instrument = quote.instrument || {};
    var instrumentLabel = (instrument.symbol || state.selectedKlineInstrumentId || "尚未選取") + " " + (instrument.display_name || "");
    var reviewStatus = financialReviewSaved ? "已儲存至本機 prototype 草稿" : "尚未儲存；不會寫入官方資料";
    return '<section class="financial-tracker" data-testid="financial-tracker"><header class="financial-tracker-header"><div><span class="eyebrow">PERSONAL FUNDAMENTAL TRACKER</span><h2>財務追蹤統計表</h2><p>目前標的：' + text(instrumentLabel) + '。數值欄位只顯示已接入、可追溯的資料；其餘維持未接入。</p></div><span class="status status-' + (financialReviewSaved ? "saved" : "draft") + '" data-testid="financial-review-status">' + text(reviewStatus) + '</span></header><div class="table-responsive"><table class="table financial-tracker-table"><thead><tr><th>營運成長</th><th>獲利品質</th><th>財務品質</th><th>估值</th><th>資料狀態</th></tr></thead><tbody><tr><td><strong>月營收 YoY</strong><small>未接入</small></td><td><strong>毛利率／ROE</strong><small>未接入</small></td><td><strong>自由現金流／負債比</strong><small>未接入</small></td><td><strong>PIT TTM PE／PB</strong><small>未接入</small></td><td>' + statusBadge("unavailable") + '<small>等待免費官方來源與 PIT 契約</small></td></tr></tbody></table></div><div class="financial-review-form" data-testid="financial-review-form"><label><span>產業主線</span><select data-action="financial-review-input" data-field="industry" data-testid="financial-review-industry">' + selectOptionMarkup(["Power Infrastructure", "Server Interconnect", "Passive Components", "Memory", "Edge AI", "Other"], financialReviewDraft.industry) + '</select></label><label><span>觀察狀態</span><select data-action="financial-review-input" data-field="watch_status" data-testid="financial-review-status-select">' + selectOptionMarkup(["核心持續追蹤", "等待合理估值", "等待止跌", "基本面待確認", "暫停觀察", "排除"], financialReviewDraft.watch_status) + '</select></label><label><span>人工基本面評分</span><select data-action="financial-review-input" data-field="score" data-testid="financial-review-score">' + selectOptionMarkup(["", "1", "2", "3", "4", "5"], financialReviewDraft.score) + '</select></label><label class="financial-review-note"><span>人工備註</span><textarea rows="3" maxlength="500" placeholder="支持、反證、一次性收益與下次財報檢查點" data-action="financial-review-input" data-field="note" data-testid="financial-review-note">' + escapeHtml(financialReviewDraft.note) + '</textarea></label><div class="financial-review-actions"><span>這是本機研究草稿，不會改寫官方資料或觸發計算。</span><button class="btn btn-primary" type="button" data-action="financial-review-save" data-testid="financial-review-save">儲存追蹤草稿</button></div></div></section>';
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
    var alertIssues = core.alertFormIssues(alertDraft, { symbol: symbol });
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
      '<button class="btn btn-outline btn-sm" type="button" data-action="alert-add" data-testid="alert-add"' + (alertIssues.length ? " disabled" : "") + '>新增提醒（' + text(symbol || "未選標的") + '）</button>' +
      formIssuesMarkup(alertIssues, "alert-form-issues") + '</div>';
    return card("研究提醒", "本機引擎評估 · 僅研究用途 · 非交易指示", '<div class="alerts-panel" data-testid="alerts-panel">' +
      form + statusLine +
      '<div class="alert-definition-list" data-testid="alert-definition-list">' + definitionRows + '</div>' +
      '<div class="alert-toolbar"><button class="btn btn-primary btn-sm" type="button" data-action="alert-evaluate" data-testid="alert-evaluate"' + (definitions.length && !alertEvaluateInFlight ? "" : " disabled") + '>' + (alertEvaluateInFlight ? "評估中…" : "立即評估") + '</button>' +
      '<button class="btn btn-outline btn-sm" type="button" data-action="alert-clear-events" data-testid="alert-clear-events"' + (events.length ? "" : " disabled") + '>清除事件</button></div>' +
      '<div class="alert-event-list" data-testid="alert-event-list">' + eventRows + '</div>' +
      '<p class="alert-note">提醒定義只保存在本機（tqe-in-app-alerts/v1），由本機引擎對已納入資料評估；結果僅在此工作階段顯示，沒有任何外部遞送，也不提供任何下單或執行功能。</p></div>', "");
  }

  function updateCardMarkup() {
    var desktop = desktopDataUpdateAvailable();
    if (!desktop) {
      return card("應用程式更新", "簽章驗證 · 使用者主動觸發", '<div class="settings-block" data-testid="update-panel">' +
        '<dl class="settings-facts"><div><dt>目前版本</dt><dd data-testid="update-current-version">瀏覽器預覽</dd></div></dl>' +
        '<p class="settings-note">瀏覽器預覽不提供更新；請使用桌面版 TQR。桌面版的更新檢查由本機端對 GitHub 公開 release 發出唯讀請求，下載的更新以 minisign 簽章驗證後才會安裝。</p></div>', "");
    }
    var status = updateStatus || { state: "idle", version: "", message: "" };
    var statusLine = "";
    if (status.state === "checking") statusLine = '<span class="settings-status" data-testid="update-status">正在檢查更新…</span>';
    else if (status.state === "latest") statusLine = '<span class="settings-status success" data-testid="update-status">已是最新版本</span>';
    else if (status.state === "available") statusLine = '<span class="settings-status info" data-testid="update-status">有新版本 ' + text(status.version) + ' 可更新</span>';
    else if (status.state === "installing") statusLine = '<span class="settings-status" data-testid="update-status">正在下載並安裝，完成後會自動重新啟動…</span>';
    else if (status.state === "error") statusLine = '<span class="settings-status error" data-testid="update-status">更新失敗：' + text(status.message || "未知錯誤") + '</span>';
    else statusLine = '<span class="settings-status" data-testid="update-status">尚未檢查</span>';
    var busy = updateCheckInFlight || updateInstallInFlight;
    var installButton = status.state === "available"
      ? '<button class="btn btn-primary" type="button" data-action="update-install" data-testid="update-install"' + (busy ? " disabled" : "") + '>下載並安裝更新</button>'
      : "";
    return card("應用程式更新", "簽章驗證 · 使用者主動觸發", '<div class="settings-block" data-testid="update-panel">' +
      '<dl class="settings-facts"><div><dt>目前版本</dt><dd data-testid="update-current-version">' + text(appVersion || "讀取中…") + '</dd></div><div><dt>更新狀態</dt><dd>' + statusLine + '</dd></div></dl>' +
      '<div class="settings-actions"><button class="btn btn-outline" type="button" data-action="update-check" data-testid="update-check"' + (busy ? " disabled" : "") + '>' + (updateCheckInFlight ? "檢查中…" : "檢查更新") + '</button>' + installButton + '</div>' +
      '<p class="settings-note">更新檢查由本機端對 GitHub 公開 release 發出唯讀請求；下載的更新以 minisign 簽章驗證後才會安裝。安裝期間本機資料服務會短暫停止，失敗時自動恢復。</p></div>', "");
  }

  function themeCardMarkup() {
    var theme = currentTheme();
    return card("外觀主題", "淺色 / 深色 · 本機保存", '<div class="settings-block" data-testid="theme-panel">' +
      '<div class="settings-actions" data-testid="theme-switch">' +
      '<button class="btn ' + (theme === "light" ? "btn-primary" : "btn-outline") + '" type="button" data-action="theme-set" data-theme="light" data-testid="theme-light"' + (theme === "light" ? ' aria-pressed="true"' : "") + '>淺色</button>' +
      '<button class="btn ' + (theme === "dark" ? "btn-primary" : "btn-outline") + '" type="button" data-action="theme-set" data-theme="dark" data-testid="theme-dark"' + (theme === "dark" ? ' aria-pressed="true"' : "") + '>深色</button></div>' +
      '<p class="settings-note">選擇會即時套用並保存在本機瀏覽器儲存；K 線圖配色維持預設。</p></div>', "");
  }

  function settingsMarkup() {
    return pageHeader("設定", "版本 · 更新 · 主題") +
      '<div class="settings-grid" data-testid="settings-view">' + updateCardMarkup() + themeCardMarkup() + '</div>';
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
    var raw = sidecarResolvedUrl || window.__TW_QUANT_SIDECAR_URL__ || "http://127.0.0.1:8767";
    try {
      var parsed = new URL(raw);
      if (parsed.protocol !== "http:" || ["127.0.0.1", "localhost", "[::1]", "::1"].indexOf(parsed.hostname) < 0) return "";
      return parsed.origin;
    } catch (error) {
      return "";
    }
  }

  // Resolve the loopback sidecar URL once at startup: inside the desktop
  // shell the sidecar binds a dynamically reserved port and reports it
  // through the sidecar_url command, so the shell must always ask first;
  // only the plain dev/preview flow (no Tauri) uses the URL pinned via
  // __TW_QUANT_SIDECAR_URL__, and the 8767 fallback keeps the static
  // preview usable.
  function ensureSidecarUrl() {
    if (sidecarUrlPromise) return sidecarUrlPromise;
    if (!desktopDataUpdateAvailable()) {
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

  // Engine/sidecar validation rejections (alerts & valuation evaluation) are
  // shown verbatim: the engine fail-closed messages already name the field and
  // the rule (e.g. "model.discount_rate must be greater than
  // model.growth_rate"), so the status line must not reword them.
  function engineErrorMessage(error) {
    var message = error && error.message ? String(error.message) : "";
    if (!message || /load failed|failed to fetch|networkerror|network request failed/i.test(message)) {
      return "本機資料服務無法連線；請重新啟動 TQR 後再試。";
    }
    return message;
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

  function parseValuationStore(raw) {
    var payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!payload || payload.schema !== core.VALUATION_STORE_SCHEMA || payload.version !== 1 || !Array.isArray(payload.worksheets)) {
      throw new Error("valuation store schema mismatch");
    }
    return payload.worksheets;
  }

  function localValuationWorksheets() {
    try {
      if (!window.localStorage) return [];
      var raw = window.localStorage.getItem(VALUATION_LOCAL_STORAGE_KEY);
      return raw ? parseValuationStore(raw) : [];
    } catch (error) {
      return [];
    }
  }

  function saveLocalValuation(payload) {
    try {
      if (!window.localStorage) return false;
      window.localStorage.setItem(VALUATION_LOCAL_STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch (error) {
      return false;
    }
  }

  // Session-local store owned by the local app, watchlist/alerts style. This
  // slice deliberately uses the browser localStorage path only; a Tauri
  // command pair (load/save fair-value worksheets) is a recorded follow-up,
  // not part of the approved work-unit.
  function ensureValuationRuntime() {
    if (valuationLoadStarted) return;
    valuationLoadStarted = true;
    state = core.reduce(state, { type: "SET_VALUATION_WORKSHEETS", worksheets: localValuationWorksheets() });
  }

  function persistValuation() {
    return saveLocalValuation(core.valuationStorePayload(state));
  }

  function buildWorksheetFromDraft() {
    var instrument = selectedKlineInstrument();
    var symbol = instrument && instrument.symbol;
    if (!symbol || !String(valuationDraft.label || "").trim()) return null;
    function scenario(prefix) {
      var eps = Number(valuationDraft[prefix + "Eps"]);
      var pe = Number(valuationDraft[prefix + "Pe"]);
      if (!(eps > 0) || !(pe > 0)) return null;
      return { eps: eps, pe: pe };
    }
    var bear = scenario("bear");
    var base = scenario("base");
    var bull = scenario("bull");
    if (!bear || !base || !bull) return null;
    function ratio(field) {
      var value = Number(valuationDraft[field]) / 100;
      return value > 0 && value <= 1 ? value : null;
    }
    var ratios = {
      watch: ratio("ratioWatch"), first: ratio("ratioFirst"), second: ratio("ratioSecond"),
      sweet: ratio("ratioSweet"), extreme: ratio("ratioExtreme")
    };
    if (Object.keys(ratios).some(function (key) { return ratios[key] === null; })) return null;
    return {
      schema: core.VALUATION_WORKSHEET_SCHEMA,
      worksheet_id: "tqr-" + symbol + "-" + Date.now(),
      label: String(valuationDraft.label).trim().slice(0, 120),
      target: { security_id: symbol },
      scenarios: { bear: bear, base: base, bull: bull },
      buy_zone_ratios: ratios,
      basis: {
        eps_period: String(valuationDraft.epsPeriod || "").trim().slice(0, 200),
        eps_kind: valuationDraft.epsKind === "actual" ? "actual" : "estimate",
        pe_rationale: String(valuationDraft.peRationale || "").trim().slice(0, 200),
        financial_data_date: String(valuationDraft.financialDataDate || "").trim().slice(0, 200),
        valuation_date: String(valuationDraft.valuationDate || "").trim().slice(0, 200),
        change_reason: String(valuationDraft.changeReason || "").trim().slice(0, 200)
      },
      created_at: new Date().toISOString()
    };
  }

  function addWorksheetFromDraft() {
    var instrument = selectedKlineInstrument();
    var issues = core.valuationFormIssues(valuationDraft, { symbol: instrument && instrument.symbol });
    var definition = issues.length ? null : buildWorksheetFromDraft();
    if (!definition) {
      state = core.reduce(state, {
        type: "VALUATION_ERROR",
        message: issues.length ? formIssueSummary(issues) : "工作表參數未通過檢核；請確認各欄位格式後再試"
      });
      render();
      return;
    }
    state = core.reduce(state, { type: "ADD_VALUATION_WORKSHEET", worksheet: definition });
    valuationDraft = defaultValuationDraft();
    persistValuation();
    render();
  }

  function evaluateValuation() {
    var valuation = state.valuation || {};
    var worksheets = Array.isArray(valuation.worksheets) ? valuation.worksheets : [];
    var instrument = selectedKlineInstrument();
    var symbol = instrument && instrument.symbol;
    if (valuationEvaluateInFlight || !symbol) return;
    if (!worksheets.length) {
      state = core.reduce(state, { type: "VALUATION_ERROR", message: "尚無合理價工作表可計算" });
      render();
      return;
    }
    valuationEvaluateInFlight = true;
    var periods = state.valuationIndicatorPeriods || { zscore: 20, price_percentile: 60, ma_deviation: 20 };
    var indicators = ["zscore", "price_percentile", "ma_deviation"].map(function (type) {
      return { type: type, security_id: symbol, period: periods[type] || 20 };
    });
    var query = "worksheets=" + encodeURIComponent(JSON.stringify(worksheets)) +
      "&indicators=" + encodeURIComponent(JSON.stringify(indicators));
    sidecarFetch("/valuation?" + query)
      .then(function (payload) {
        if (!payload || !payload.data || !payload.data.evaluation) throw new Error("sidecar returned no valuation data");
        state = core.reduce(state, {
          type: "VALUATION_EVALUATED",
          results: payload.data.evaluation.results,
          indicators: payload.data.indicators
        });
      })
      .catch(function (error) {
        state = core.reduce(state, { type: "VALUATION_ERROR", message: engineErrorMessage(error) });
      })
      .then(function () {
        valuationEvaluateInFlight = false;
        render();
      });
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

  function formIssueSummary(issues) {
    return issues.map(function (item) { return item.message; }).join("；");
  }

  function addAlertFromDraft() {
    var instrument = selectedKlineInstrument();
    var issues = core.alertFormIssues(alertDraft, { symbol: instrument && instrument.symbol });
    var definition = issues.length ? null : buildAlertFromDraft();
    if (!definition) {
      state = core.reduce(state, {
        type: "ALERTS_ERROR",
        message: issues.length ? formIssueSummary(issues) : "提醒內容未通過檢核；請確認各欄位格式後再試"
      });
      return;
    }
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
        state = core.reduce(state, { type: "ALERTS_ERROR", message: engineErrorMessage(error) });
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

  // The empty-query guidance doubles as the add-button gate, but showing it
  // as a warning right after a successful add reads like an error. Only
  // surface it while the user is interacting with the search box.
  function visibleWatchlistAddIssues(issues) {
    if (String(watchlistSearchQuery || "").trim() || watchlistSearchFocused) return issues;
    return issues.filter(function (item) { return item.field !== "query"; });
  }

  function refreshWatchlistAddButtons() {
    var instruments = core.klineInstruments(state.view);
    var items = core.watchlistItemsForActiveGroup(state);
    var selected = instrumentForId(watchlistSearchSelection) || resolveSearchSelection(instruments, watchlistSearchQuery);
    var issues = core.watchlistAddIssues({ query: watchlistSearchQuery, selected: selected, items: items });
    root.querySelectorAll('[data-action="watchlist-add"]').forEach(function (button) {
      button.disabled = issues.length > 0;
    });
    var visible = visibleWatchlistAddIssues(issues);
    refreshFormIssues("watchlist-add-issues", visible);
    refreshFormIssues("terminal-watchlist-add-issues", visible);
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
      klineInstrumentsAttempts = 0;
      loadKlineInstruments();
      return;
    }
    if (state.klineRuntimeStatus === "ready") {
      if (state.activeSection === "market" || state.activeSection === "features") requestKlineModel();
      requestWatchlistModels();
    }
  }

  // The desktop shell starts the sidecar at the same moment the webview
  // boots; the python process needs a few seconds to load the full catalog,
  // so the first /instruments fetch can lose that race. Retry with a bounded
  // backoff instead of dropping straight into the unrecoverable error state.
  function loadKlineInstruments() {
    klineRequestInFlight = true;
    if (state.klineRuntimeStatus !== "loading") {
      state = core.reduce(state, { type: "KLINE_LOADING" });
      render();
    }
    sidecarFetch("/instruments")
      .then(function (payload) {
        if (!payload || !Array.isArray(payload.instruments) || !payload.instruments.length) {
          throw new Error("sidecar returned no instruments");
        }
        klineInstrumentsAttempts = 0;
        state = core.reduce(state, { type: "SET_KLINE_INSTRUMENTS", instruments: payload.instruments });
        render();
        klineRequestInFlight = false;
        requestKlineModel();
        requestWatchlistModels();
      })
      .catch(function () {
        klineRequestInFlight = false;
        klineInstrumentsAttempts += 1;
        if (klineInstrumentsAttempts < KLINE_INSTRUMENTS_MAX_ATTEMPTS) {
          setTimeout(loadKlineInstruments, KLINE_INSTRUMENTS_RETRY_MS);
          return;
        }
        klineInstrumentsAttempts = 0;
        state = core.reduce(state, { type: "KLINE_ERROR" });
        render();
      });
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
    return '<section class="terminal-quote-bar" data-testid="quote-bar"><div class="terminal-quote-identity"><span class="terminal-market-tag">' + text(instrument.market || "TWSE") + '</span><div><h2>' + text(instrument.symbol || selectedId || "2330") + ' <small>' + text(instrument.display_name || "台積電") + '</small></h2><span class="mono">' + text(selectedId) + ' · ' + text((instrument.currency || "TWD")) + '</span></div></div><div class="terminal-quote-price"><strong>' + core.formatNumber(latest.close) + '</strong><span class="' + tone + '">' + (quote.change === null ? "—" : (quote.change >= 0 ? "+" : "") + core.formatNumber(quote.change) + " (" + core.formatPercent(quote.changePct) + ")") + '</span></div><dl class="terminal-ohlc"><div><dt>開</dt><dd>' + core.formatNumber(latest.open) + '</dd></div><div><dt>高</dt><dd>' + core.formatNumber(latest.high) + '</dd></div><div><dt>低</dt><dd>' + core.formatNumber(latest.low) + '</dd></div><div><dt>量</dt><dd>' + core.formatNumber(latest.volume) + '</dd></div></dl><div class="terminal-quote-actions"><button class="btn ' + (isWatched ? "btn-outline" : "btn-primary") + '" type="button" data-action="watchlist-toggle" data-testid="quote-watchlist-toggle">' + (isWatched ? "已在自選" : "加入自選") + '</button><button class="btn btn-outline" type="button" data-action="section" data-section="company">記研究筆記</button></div></section>';
  }

  function compactWatchlistMarkup() {
    var instruments = core.klineInstruments(state.view);
    var items = core.watchlistItemsForActiveGroup(state);
    var groups = Array.isArray(state.watchlistGroups) ? state.watchlistGroups : [];
    var activeGroup = groups.find(function (group) { return group.id === state.activeWatchlistGroupId; }) || groups[0];
    var canDeleteGroup = activeGroup && activeGroup.id !== "default";
    var selected = instrumentForId(watchlistSearchSelection) || resolveSearchSelection(instruments, watchlistSearchQuery);
    var terminalAddIssues = core.watchlistAddIssues({ query: watchlistSearchQuery, selected: selected, items: items });
    return '<section class="terminal-watchlist" data-testid="terminal-watchlist"><header class="terminal-panel-heading"><div><span class="eyebrow">我的行情</span><h2>自選清單</h2></div><span class="terminal-count">' + items.length + '</span></header><div class="terminal-watchlist-controls"><div class="symbol-search"><label><span>搜尋代號／名稱</span><input type="search" autocomplete="off" placeholder="例如 2330" value="' + escapeHtml(watchlistSearchQuery) + '" data-action="watchlist-search" data-testid="terminal-watchlist-picker" aria-controls="terminal-watchlist-results"></label>' + symbolSearchResults(instruments, watchlistSearchQuery, items, watchlistSearchSelection, "terminal-watchlist-results", "watchlist-search-pick") + '</div><button class="btn btn-primary btn-sm" type="button" data-action="watchlist-add" data-testid="terminal-watchlist-add"' + (terminalAddIssues.length ? " disabled" : "") + '>加入</button>' + formIssuesMarkup(visibleWatchlistAddIssues(terminalAddIssues), "terminal-watchlist-add-issues") + '</div><div class="terminal-watchlist-group"><label><span>目前群組</span><select data-action="watchlist-group-select" data-testid="terminal-watchlist-group-select">' + groups.map(function (group) { return '<option value="' + escapeHtml(group.id) + '"' + (group.id === state.activeWatchlistGroupId ? ' selected' : '') + '>' + text(group.name) + '</option>'; }).join("") + '</select></label><button class="btn btn-outline btn-sm" type="button" data-action="watchlist-group-delete" data-group-id="' + escapeHtml(activeGroup && activeGroup.id || "default") + '" data-testid="terminal-watchlist-group-delete"' + (canDeleteGroup ? '' : ' disabled') + '>刪除群組</button></div><div class="terminal-watchlist-list">' + (items.length ? items.map(function (instrumentId) {
      var instrument = instrumentForId(instrumentId) || { instrument_id: instrumentId, symbol: instrumentId, display_name: "未在商品清單" };
      var model = core.klineModel(state.view, instrumentId, "1D");
      var bars = model && Array.isArray(model.bars) ? model.bars : [];
      var latest = bars.length ? bars[bars.length - 1] : null;
      var previous = bars.length > 1 ? bars[bars.length - 2] : null;
      var delta = latest && previous ? latest.close - previous.close : null;
      return '<div class="terminal-watchlist-row-wrap"><button class="terminal-watchlist-row' + (instrumentId === state.selectedKlineInstrumentId ? ' active' : '') + '" type="button" data-action="kline-search-pick" data-instrument-id="' + escapeHtml(instrumentId) + '"><span><strong>' + text(instrument.symbol || instrumentId) + '</strong><small>' + text(instrument.display_name) + '</small></span><span class="terminal-watchlist-price"><strong>' + core.formatNumber(latest && latest.close) + '</strong><small class="' + (delta === null ? "" : delta >= 0 ? "positive" : "negative") + '">' + (delta === null ? "—" : (delta >= 0 ? "+" : "") + core.formatNumber(delta)) + '</small></button><button class="terminal-watchlist-remove" type="button" data-action="watchlist-remove" data-instrument-id="' + escapeHtml(instrumentId) + '" aria-label="移除 ' + escapeHtml(instrument.symbol || instrumentId) + '">×</button></div>';
    }).join("") : '<div class="terminal-watchlist-empty"><strong>還沒有自選標的</strong><span>搜尋 2330，加入後就能在右側快速切換。</span></div>') + '</div><footer class="terminal-watchlist-footer"><span>' + text(noteStatus()) + '</span><button class="btn btn-outline btn-sm" type="button" data-action="section" data-section="watchlist">管理自選</button></footer></section>';
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

  function pct(value) {
    return value === null || value === undefined ? "—" : core.formatPercent(value);
  }

  function num(value) {
    return value === null || value === undefined ? "—" : core.formatNumber(value);
  }

  function watchlistFilterMarkup() {
    var f = state.watchlistFilters || {};
    function sel(field, label, options, current) {
      return '<label><span>' + text(label) + '</span><select data-action="watchlist-filter" data-field="' + field + '" data-testid="watchlist-filter-' + field + '">' +
        '<option value="">全部</option>' +
        options.map(function (option) {
          var value = typeof option === "string" ? option : option[0];
          var name = typeof option === "string" ? option : option[1];
          return '<option value="' + escapeHtml(value) + '"' + (current === value ? " selected" : "") + '>' + text(name) + '</option>';
        }).join("") + '</select></label>';
    }
    var stageOptions = ["extreme", "sweet", "second", "first", "near", "watch"].map(function (id) {
      return [id, core.STAGE_LABELS[id]];
    });
    return '<div class="watchlist-filter-bar" data-testid="watchlist-filters">' +
      sel("industry", "產業", core.INDUSTRY_OPTIONS, f.industry) +
      sel("fundamental_state", "基本面", core.FUNDAMENTAL_STATES, f.fundamental_state) +
      sel("thesis_state", "投資假設", core.THESIS_STATES, f.thesis_state) +
      sel("stage", "買進階段", stageOptions, f.stage) +
      sel("held", "持有", [["held", "已持有"], ["not_held", "未持有"]], f.held) +
      '<label><span>排序</span><select data-action="watchlist-sort" data-testid="watchlist-sort">' +
      [["discount", "折價幅度最大"], ["distance", "距離第一買進價最近"], ["updated", "最近更新日期"]].map(function (option) {
        return '<option value="' + option[0] + '"' + (state.watchlistSort === option[0] ? " selected" : "") + '>' + text(option[1]) + '</option>';
      }).join("") + '</select></label></div>';
  }

  function watchlistRows() {
    var all = core.watchlistViewRows(state);
    if (!all.length) {
      return '<div class="empty-state" data-testid="watchlist-empty"><strong>尚未建立追蹤清單</strong><span>從商品選擇器加入股票；草稿需按「儲存自選清單」才會寫入本機 JSON。</span></div>';
    }
    var rows = core.sortWatchlistRows(core.filterWatchlistRows(all, state.watchlistFilters), state.watchlistSort);
    var body = rows.length ? rows.map(function (row) {
      return '<tr data-testid="watchlist-row" data-instrument-id="' + escapeHtml(row.instrument_id) + '">' +
        '<td class="cell-mono cell-strong">' + text(row.symbol) + '</td>' +
        '<td><span class="cell-strong">' + text(row.name) + '</span><small>' + text(row.industry) + '</small></td>' +
        '<td class="cell-mono">' + num(row.price) + '</td>' +
        '<td class="cell-mono" data-testid="watchlist-base-value">' + num(row.base_value) + '</td>' +
        '<td class="cell-mono ' + (row.discount !== null && row.discount < 0 ? "tone-down" : "") + '" data-testid="watchlist-discount">' + pct(row.discount) + '</td>' +
        '<td class="cell-mono">' + num(row.first_price) + '</td>' +
        '<td class="cell-mono">' + num(row.sweet_price) + '</td>' +
        '<td>' + text(row.fundamental_state) + '</td>' +
        '<td>' + text(row.thesis_state) + '</td>' +
        '<td>' + text(row.next_event || "—") + '</td>' +
        '<td data-testid="watchlist-stage">' + text(row.stage_label) + '</td>' +
        '<td class="table-action"><button class="btn btn-outline btn-sm" type="button" data-action="watchlist-remove" data-instrument-id="' + escapeHtml(row.instrument_id) + '">移除</button></td></tr>';
    }).join("") : '<tr><td colspan="12">目前篩選條件下沒有標的。</td></tr>';
    return watchlistFilterMarkup() + '<div class="table-responsive"><table class="table watchlist-table" data-testid="watchlist-table"><thead><tr>' +
      '<th>代號</th><th>公司／產業</th><th>現價</th><th>合理價值</th><th>折價</th><th>第一買進價</th><th>甜蜜價</th><th>基本面</th><th>投資假設</th><th>下一事件</th><th>買進階段</th><th></th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="watchlist-note">合理價值來自你在 Valuation 建立的 Base 工作表；未建立估值的標的，合理價值、折價與買進價一律顯示「—」，不以價格反推。</p>';
  }

  function watchlistMarkup() {
    var instruments = core.klineInstruments(state.view);
    var items = core.watchlistItemsForActiveGroup(state);
    var groups = Array.isArray(state.watchlistGroups) ? state.watchlistGroups : [{ id: "default", name: "我的自選", items: items }];
    var selected = instrumentForId(watchlistSearchSelection) || resolveSearchSelection(instruments, watchlistSearchQuery);
    var saving = state.watchlist && state.watchlist.status === "saving";
    var canSave = state.watchlist && state.watchlist.dirty && !saving && watchlistPersistenceAvailable !== false;
    var activeGroup = groups.find(function (group) { return group.id === state.activeWatchlistGroupId; }) || groups[0];
    var canDeleteGroup = activeGroup && activeGroup.id !== "default";
    var groupNameIssues = core.watchlistGroupNameIssues(watchlistGroupNameQuery);
    var watchlistAddIssueList = core.watchlistAddIssues({ query: watchlistSearchQuery, selected: selected, items: items });
    return card("自選清單", "本機保存 · 明確儲存 · 資料唯讀", '<div class="watchlist-toolbar-shell"><div class="watchlist-toolbar" data-testid="watchlist-toolbar">' +
      '<section class="watchlist-toolbar-grouping" aria-label="自選群組管理"><div class="watchlist-group-control"><label class="watchlist-group-picker"><span>目前群組</span><select data-action="watchlist-group-select" data-testid="watchlist-group-select">' + groups.map(function (group) {
        return '<option value="' + escapeHtml(group.id) + '"' + (group.id === state.activeWatchlistGroupId ? ' selected' : '') + '>' + text(group.name) + ' · ' + group.items.length + '</option>';
      }).join("") + '</select></label><button class="btn btn-outline btn-sm watchlist-group-delete" type="button" data-action="watchlist-group-delete" data-group-id="' + escapeHtml(activeGroup && activeGroup.id || "default") + '" data-testid="watchlist-group-delete"' + (canDeleteGroup ? '' : ' disabled') + '>刪除群組</button></div>' +
      '<div class="watchlist-group-new-control"><label class="watchlist-group-new"><span>新增群組</span><input type="text" maxlength="32" placeholder="例如 半導體" value="' + escapeHtml(watchlistGroupNameQuery) + '" data-action="watchlist-group-name" data-testid="watchlist-group-name"></label>' +
      '<button class="btn btn-outline" type="button" data-action="watchlist-group-create" data-testid="watchlist-group-create"' + (groupNameIssues.length ? ' disabled' : '') + '>建立群組</button>' + formIssuesMarkup(groupNameIssues, "watchlist-group-issues") + '</div></section>' +
      '<section class="watchlist-toolbar-search" aria-label="搜尋並加入商品"><div class="watchlist-picker symbol-search' + (watchlistSearchFocused ? " search-open" : "") + '"><label><span>搜尋商品</span><input type="search" autocomplete="off" placeholder="代號、名稱或市場，例如 2330 / 台積電" value="' + escapeHtml(watchlistSearchQuery) + '" data-action="watchlist-search" data-testid="watchlist-picker" aria-controls="watchlist-symbol-results"></label>' +
      symbolSearchResults(instruments, watchlistSearchQuery, items, watchlistSearchSelection, "watchlist-symbol-results", "watchlist-search-pick") + '</div><button class="btn btn-primary" type="button" data-action="watchlist-add" data-testid="watchlist-add"' + (watchlistAddIssueList.length ? ' disabled' : '') + '>加入自選</button>' + formIssuesMarkup(visibleWatchlistAddIssues(watchlistAddIssueList), "watchlist-add-issues") + '</section>' +
      '<section class="watchlist-toolbar-actions" aria-label="自選清單操作"><button class="btn btn-outline" type="button" data-action="watchlist-clear" data-testid="watchlist-clear"' + (items.length ? '' : ' disabled') + '>清除草稿</button>' +
      '<button class="btn btn-primary" type="button" data-action="watchlist-save" data-testid="watchlist-save"' + (canSave ? '' : ' disabled') + '>儲存自選清單</button></section>' +
      '<span class="watchlist-state" data-testid="watchlist-state">' + text(watchlistStatus()) + '</span></div></div>' +
      watchlistRows() + '<p class="watchlist-note">桌面開發版使用本機 JSON；瀏覽器預覽使用同一資料格式的瀏覽器本機儲存備援。群組是本機工作階段資料。</p>', "");
  }



  function selectOptionMarkup(values, selected) {
    return values.map(function (value) {
      return '<option value="' + escapeHtml(value) + '"' + (value === selected ? ' selected' : '') + '>' + text(value) + '</option>';
    }).join('');
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
      '<div class="kline-provenance"><span>來源：' + text(model && model.source) + '</span><span>資料快照：' + text(model && model.snapshot_digest) + '</span><span>時區：' + text(model && model.timezone) + '</span></div></section>', "");
  }




  function valuationIndicatorTile(type, label, note) {
    var indicators = state.valuation && Array.isArray(state.valuation.indicators) ? state.valuation.indicators : [];
    var periods = state.valuationIndicatorPeriods || {};
    var instrument = selectedKlineInstrument();
    var symbol = instrument && instrument.symbol;
    var found = indicators.find(function (item) { return item.type === type && item.security_id === symbol; });
    var valueText = !found ? "—" : found.status !== "ok" ? "資料不足" : type === "price_percentile" ? core.formatNumber(found.value) + "%" : type === "ma_deviation" ? core.formatPercent(found.value) : core.formatNumber(found.value);
    return '<div class="valuation-indicator" data-testid="valuation-indicator-' + type + '"><span>' + text(label) + '</span><strong>' + text(valueText) + '</strong>' +
      '<label><span>期間 N</span><input type="number" min="1" max="250" step="1" value="' + escapeHtml(String(periods[type] || 20)) + '" data-action="valuation-indicator-period" data-indicator="' + type + '" data-testid="valuation-period-' + type + '"></label>' +
      '<small>' + text(note) + '</small></div>';
  }

  function valuationScenarioField(prefix, label) {
    return '<div class="valuation-scenario" data-testid="valuation-scenario-' + prefix + '"><h4>' + text(label) + '</h4>' +
      '<label><span>EPS</span><input type="number" step="0.01" inputmode="decimal" value="' + escapeHtml(valuationDraft[prefix + "Eps"]) + '" data-action="valuation-ws-input" data-field="' + prefix + 'Eps" data-testid="valuation-ws-' + prefix + '-eps"></label>' +
      '<label><span>合理本益比</span><input type="number" step="0.1" inputmode="decimal" value="' + escapeHtml(valuationDraft[prefix + "Pe"]) + '" data-action="valuation-ws-input" data-field="' + prefix + 'Pe" data-testid="valuation-ws-' + prefix + '-pe"></label>' +
      '</div>';
  }

  function valuationRatioField(field, label, testid) {
    return '<label><span>' + text(label) + '（%）</span><input type="number" min="1" max="100" step="0.5" inputmode="decimal" value="' + escapeHtml(valuationDraft[field]) + '" data-action="valuation-ws-input" data-field="' + field + '" data-testid="' + testid + '"></label>';
  }

  function valuationBasisMarkup() {
    return '<div class="valuation-basis" data-testid="valuation-basis"><h4>估值依據</h4>' +
      '<label><span>使用哪一期 EPS</span><input type="text" maxlength="200" placeholder="例如 2026Q1" value="' + escapeHtml(valuationDraft.epsPeriod) + '" data-action="valuation-ws-input" data-field="epsPeriod" data-testid="valuation-basis-period"></label>' +
      '<label><span>EPS 類型</span><select data-action="valuation-ws-input" data-field="epsKind" data-testid="valuation-basis-kind">' +
      '<option value="actual"' + (valuationDraft.epsKind === "actual" ? " selected" : "") + '>實際值</option>' +
      '<option value="estimate"' + (valuationDraft.epsKind !== "actual" ? " selected" : "") + '>預估值</option></select></label>' +
      '<label><span>PE 選擇理由</span><input type="text" maxlength="200" placeholder="例如 近五年區間中位" value="' + escapeHtml(valuationDraft.peRationale) + '" data-action="valuation-ws-input" data-field="peRationale" data-testid="valuation-basis-rationale"></label>' +
      '<label><span>財報資料日期</span><input type="date" value="' + escapeHtml(valuationDraft.financialDataDate) + '" data-action="valuation-ws-input" data-field="financialDataDate" data-testid="valuation-basis-financial-date"></label>' +
      '<label><span>估值日期</span><input type="date" value="' + escapeHtml(valuationDraft.valuationDate) + '" data-action="valuation-ws-input" data-field="valuationDate" data-testid="valuation-basis-date"></label>' +
      '<label><span>估值修改原因</span><input type="text" maxlength="200" placeholder="例如 季報公布後上調 EPS" value="' + escapeHtml(valuationDraft.changeReason) + '" data-action="valuation-ws-input" data-field="changeReason" data-testid="valuation-basis-reason"></label>' +
      '</div>';
  }

  function valuationResultCard(result) {
    if (result.status !== "ok") {
      return '<article class="valuation-result" data-testid="valuation-result-card"><header><strong>' + text(result.label) + '</strong><span class="status status-draft">資料不足</span></header>' +
        '<p class="valuation-insufficient" data-testid="valuation-insufficient">此標的目前沒有已納入的收盤資料，不做任何推估。</p></article>';
    }
    var values = result.scenario_values || {};
    var zone = result.buy_zone || {};
    var comparison = result.comparison || {};
    var basis = result.basis || {};
    return '<article class="valuation-result" data-testid="valuation-result-card">' +
      '<header><strong>' + text(result.label) + '</strong><span class="status status-draft">' + text(result.security_id) + '</span></header>' +
      '<div class="valuation-scenario-grid">' +
      '<div><span class="detail-label">Bear</span><strong>' + core.formatNumber(values.bear) + '</strong></div>' +
      '<div><span class="detail-label">Base 合理價值</span><strong class="valuation-price" data-testid="valuation-base-value">' + core.formatNumber(values.base) + '</strong></div>' +
      '<div><span class="detail-label">Bull</span><strong>' + core.formatNumber(values.bull) + '</strong></div>' +
      '</div>' +
      '<div class="valuation-zone-grid" data-testid="valuation-zone">' +
      '<div><span class="detail-label">觀察區</span><strong>' + core.formatNumber(zone.watch) + '</strong></div>' +
      '<div><span class="detail-label">第一階段</span><strong data-testid="valuation-zone-first">' + core.formatNumber(zone.first) + '</strong></div>' +
      '<div><span class="detail-label">第二階段</span><strong>' + core.formatNumber(zone.second) + '</strong></div>' +
      '<div><span class="detail-label">甜蜜價</span><strong data-testid="valuation-zone-sweet">' + core.formatNumber(zone.sweet) + '</strong></div>' +
      '<div><span class="detail-label">極端錯價</span><strong>' + core.formatNumber(zone.extreme) + '</strong></div>' +
      '</div>' +
      '<div class="valuation-compare"><span>現價 <strong>' + core.formatNumber(result.current_price) + '</strong></span>' +
      '<span>折價 <strong data-testid="valuation-discount">' + core.formatPercent(comparison.discount_pct) + '</strong></span>' +
      '<span>目前階段 <strong data-testid="valuation-stage">' + text(core.STAGE_LABELS[result.stage]) + '</strong></span></div>' +
      '<small class="valuation-result-params">EPS ' + text(basis.eps_period) + '（' + (basis.eps_kind === "actual" ? "實際值" : "預估值") + '）· PE 理由 ' + text(basis.pe_rationale || "未記錄") +
      ' · 財報日 ' + text(basis.financial_data_date || "未記錄") + ' · 估值日 ' + text(basis.valuation_date) + ' · 公式版本 ' + text(result.formula_version) + '</small></article>';
  }

  function valuationMarkup() {
    var valuation = state.valuation || { worksheets: [], results: [], status: "idle", message: "" };
    var worksheets = Array.isArray(valuation.worksheets) ? valuation.worksheets : [];
    var results = Array.isArray(valuation.results) ? valuation.results : [];
    var instrument = selectedKlineInstrument();
    var symbol = instrument && instrument.symbol;
    var issues = core.valuationFormIssues(valuationDraft, { symbol: symbol });

    var worksheetCards = worksheets.length ? worksheets.map(function (definition) {
      var scenarios = definition.scenarios || {};
      var base = scenarios.base || {};
      return '<article class="valuation-worksheet" data-testid="valuation-worksheet"><div><strong>' + text(definition.label) +
        '</strong><small>' + text(definition.target && definition.target.security_id) + ' · Base ' + core.formatNumber(base.eps) + ' × ' + core.formatNumber(base.pe) +
        ' · ' + text((definition.basis || {}).eps_period) + '</small></div>' +
        '<button class="icon-button" type="button" data-action="valuation-delete" data-worksheet-id="' + escapeHtml(definition.worksheet_id) + '" aria-label="刪除估值工作表">×</button></article>';
    }).join("") : '<div class="alert-empty" data-testid="valuation-empty">尚未建立估值工作表。</div>';

    var statusMarkup = valuation.status === "error"
      ? '<p class="alert-status error" data-testid="valuation-status">' + text(valuation.message || "估值計算失敗") + '</p>'
      : '<p class="alert-status" data-testid="valuation-status">' + text(valuation.message || "使用者假設 · 本機確定性計算") + '</p>';

    return '<section class="valuation-panel" data-testid="valuation-panel">' +
      '<header class="subsection-heading"><div><h2>Bear／Base／Bull 估值工作表</h2><span class="muted">合理價值 = 預估 EPS × 合理本益比；買進區間 = Base 合理價值 × 自訂比例</span></div><span class="status status-draft">' + text(core.VALUATION_WORKSHEET_SCHEMA) + '</span></header>' +
      '<div class="valuation-form" data-testid="valuation-form">' +
      '<label class="valuation-field"><span>工作表名稱</span><input type="text" maxlength="120" placeholder="例如：2330 三情境合理價" value="' + escapeHtml(valuationDraft.label) + '" data-action="valuation-ws-input" data-field="label" data-testid="valuation-ws-label"></label>' +
      '<div class="valuation-scenario-row">' + valuationScenarioField("bear", "Bear 保守") + valuationScenarioField("base", "Base 最合理") + valuationScenarioField("bull", "Bull 樂觀") + '</div>' +
      '<div class="valuation-ratio-row" data-testid="valuation-ratios"><h4>買進區間比例（相對 Base 合理價值）</h4>' +
      valuationRatioField("ratioWatch", "觀察區", "valuation-ratio-watch") +
      valuationRatioField("ratioFirst", "第一階段", "valuation-ratio-first") +
      valuationRatioField("ratioSecond", "第二階段", "valuation-ratio-second") +
      valuationRatioField("ratioSweet", "甜蜜區", "valuation-ratio-sweet") +
      valuationRatioField("ratioExtreme", "極端錯價", "valuation-ratio-extreme") + '</div>' +
      valuationBasisMarkup() +
      '<div class="valuation-actions"><button class="btn btn-primary" type="button" data-action="valuation-add" data-testid="valuation-add"' + (issues.length ? " disabled" : "") + '>加入估值工作表</button>' +
      formIssuesMarkup(issues, "valuation-form-issues") + '</div></div>' +
      '<div class="valuation-worksheet-list" data-testid="valuation-worksheet-list">' + worksheetCards + '</div>' +
      '<div class="alert-toolbar"><button class="btn btn-primary btn-sm" type="button" data-action="valuation-evaluate" data-testid="valuation-evaluate"' + ((worksheets.length && symbol) && !valuationEvaluateInFlight ? "" : " disabled") + '>' + (valuationEvaluateInFlight ? "計算中…" : "計算合理價值與買進區間") + '</button></div>' +
      statusMarkup +
      '<div class="valuation-result-list" data-testid="valuation-result-list">' + results.map(valuationResultCard).join("") + '</div>' +
      '<p class="valuation-note">所有 EPS 與本益比都是使用者假設（draft），不是官方資料、市場共識或法人預估。到價只提示，不給買賣建議；最後決策保留人工。官方基本面欄位仍等待來源准入，不會自動帶入，也不會因股價下跌自動下修 EPS。</p></section>';
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


  function evidenceMarkup(links) {
    var items = Array.isArray(links) ? links : [];
    if (!items.length) return '<div class="empty-state"><strong>沒有證據連結。</strong><span>此資料快照沒有可用的資料脈絡。</span></div>';
    return '<ul class="evidence-list">' + items.map(function (link) {
      return '<li><span class="evidence-mark" aria-hidden="true">↗</span><a href="' + escapeHtml(link) + '">' + text(link) + '</a></li>';
    }).join("") + "</ul>";
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

  function summaryTile(label, value, hint, testid) {
    return '<article data-testid="' + testid + '"><span>' + text(label) + '</span><strong>' + text(value) + '</strong><small>' + text(hint) + '</small></article>';
  }

  function homePageMarkup() {
    var watched = (state.watchlist && state.watchlist.items || []).length;
    var stages = core.buyStageSummary(state);
    return pageHeader("Home", "今天哪些公司接近我的合理買進價格") +
      '<section class="system-command-bar" data-testid="system-command-bar"><div><span class="eyebrow">VALUE RESEARCH WORKSPACE</span><strong>投資摘要</strong><span>本機 EOD · 截止 ' + text(view.as_of || "—") + '</span></div><div class="system-command-actions"><button class="btn btn-primary" type="button" data-action="section" data-section="watchlist">開啟 Watchlist</button><button class="btn btn-outline" type="button" data-action="section" data-section="valuation">估值工作表</button></div></section>' +
      '<div class="system-metric-strip" data-testid="investment-summary">' +
      summaryTile("追蹤標的", watched, "Watchlist 公司數", "summary-tracked") +
      summaryTile("進入買進區", stages.first, "到達第一階段價", "summary-first-stage") +
      summaryTile("進入甜蜜區", stages.sweet, "到達甜蜜價", "summary-sweet") +
      summaryTile("基本面待確認", stages.pending, "需人工覆核", "summary-pending") +
      summaryTile("假設失效", stages.invalid, "Thesis 已破壞", "summary-invalid") +
      '</div>' +
      card("價值機會", "依合理價值折價幅度排序；不使用動能、AI 或情緒分數", opportunityListMarkup(), "") +
      '<div class="row col-8-4"><div>' + card("基本面更新", "只顯示會改變合理價值的變化", fundamentalChangeMarkup(), "") + '</div>' +
      '<div>' + card("買進計畫狀態", "每檔目前位於哪一階段", buyPlanStatusMarkup(), "") + '</div></div>';
  }

  function opportunityListMarkup() {
    var rows = core.opportunityRows(state);
    if (!rows.length) {
      return '<div class="empty-state" data-testid="opportunity-empty"><strong>尚無可排序的價值機會。</strong><span>先在 Valuation 建立 Base 合理價值，這裡才會依折價幅度排序；不以價格推估合理價值。</span></div>';
    }
    return '<div class="table-responsive"><table class="table" data-testid="opportunity-list"><thead><tr><th>股票</th><th>現價</th><th>合理價值</th><th>折價</th><th>狀態</th></tr></thead><tbody>' +
      rows.map(function (row) {
        return '<tr data-testid="opportunity-row"><td><span class="cell-strong">' + text(row.symbol) + '</span><small>' + text(row.name) + '</small></td>' +
          '<td class="cell-mono">' + core.formatNumber(row.price) + '</td>' +
          '<td class="cell-mono">' + core.formatNumber(row.base_value) + '</td>' +
          '<td class="cell-mono ' + (row.discount < 0 ? "tone-down" : "tone-up") + '">' + core.formatPercent(row.discount) + '</td>' +
          '<td>' + text(row.stage_label) + '</td></tr>';
      }).join("") + '</tbody></table></div>';
  }

  function fundamentalChangeMarkup() {
    return '<div class="timeline" data-testid="fundamental-changes"><div><span class="timeline-dot muted-dot"></span><div><strong>基本面來源尚未接入</strong><small>月營收、季報、EPS 與三率等待免費官方來源與 PIT 契約；不以每日股價波動充當基本面警報。</small></div></div></div>';
  }

  function buyPlanStatusMarkup() {
    var rows = core.buyPlanStatusRows(state);
    if (!rows.length) {
      return '<div class="empty-state" data-testid="buyplan-status-empty"><strong>尚未建立買進計畫。</strong><span>在 Buy Plan 設定總預算與分段價格後，這裡會顯示目前階段。</span></div>';
    }
    return '<ul class="buyplan-status-list" data-testid="buyplan-status">' + rows.map(function (row) {
      return '<li><strong>' + text(row.symbol) + '</strong><span>' + text(row.stage_label) + '</span></li>';
    }).join("") + '</ul>';
  }

  function watchlistPageMarkup() {
    return pageHeader("Watchlist", "追蹤清單 · 合理價值 · 折價幅度 · 買進階段") +
      '<div class="data-source-banner"><strong>免費資料本地保存</strong><span>目前顯示已核准的本機資料；未接入付費訂閱、即時行情或券商。</span></div>' +
      dataUpdateMarkup() + watchlistMarkup();
  }

  function companyPageMarkup() {
    return pageHeader("Company", "公司研究工作區 · Thesis · 財報 · 趨勢 · 價格參考") +
      quoteHeaderMarkup() +
      card("Thesis 投資假設", "為什麼研究這家公司；什麼情況代表假設失效", notesMarkup(), "") +
      card("Fundamental Snapshot", "核心財報欄位與人工覆核", financialTrackerMarkup(), "") +
      card("Trend Table", "最近 8 季與最近 12 個月", trendTableMarkup(), "") +
      card("Price Reference", "歷史價格位置 · 前高前低 · 回檔幅度；不參與價值判斷", klineMarkup(), "");
  }

  function trendTableMarkup() {
    return '<div class="empty-state" data-testid="trend-table-empty"><strong>季度與月營收趨勢尚未接入。</strong><span>需要月營收與季報的免費官方來源、正規化與 PIT 契約後才會顯示；缺資料不補 0、不從價格推估。</span></div>';
  }

  function valuationPageMarkup() {
    return pageHeader("Valuation", "Bear／Base／Bull · 合理本益比 · 買進區間") + valuationMarkup();
  }

  function buyPlanAllocField(key, label, testid) {
    var field = "alloc" + key.charAt(0).toUpperCase() + key.slice(1);
    return '<label><span>' + text(label) + '（%）</span><input type="number" min="0" max="100" step="1" inputmode="decimal" value="' + escapeHtml(buyPlanDraft[field]) + '" data-action="buyplan-input" data-field="' + field + '" data-testid="' + testid + '"></label>';
  }

  function buyPlanPageMarkup() {
    var instrument = selectedKlineInstrument();
    var instrumentId = state.selectedKlineInstrumentId;
    var symbol = instrument && instrument.symbol;
    if (!instrumentId || !symbol) {
      return pageHeader("Buy Plan", "總預算 · 分段價格 · 分段比例 · 到價提示") +
        card("分段買進計畫", "先選一家公司", '<div class="empty-state" data-testid="buyplan-no-instrument"><strong>尚未選擇公司。</strong><span>在 Watchlist 或 Company 選定標的後，才能為它建立分段買進計畫。</span></div>', "");
    }
    var issues = core.buyPlanFormIssues(buyPlanDraft);
    var tranches = core.buyPlanTranches(state, instrumentId);
    var hasZone = tranches.some(function (item) { return item.price !== null; });
    var rows = tranches.map(function (item) {
      var reachedLabel = item.reached === null ? "—" : item.reached ? "已到價" : "未到價";
      return '<tr data-testid="buyplan-tranche" data-tranche="' + item.key + '"><td>' + text(item.label) + '</td>' +
        '<td class="cell-mono">' + (item.price === null ? "—" : core.formatNumber(item.price)) + '</td>' +
        '<td class="cell-mono">' + text(item.allocation_pct) + '%</td>' +
        '<td class="cell-mono">' + (item.amount === null ? "—" : core.formatNumber(item.amount)) + '</td>' +
        '<td data-testid="buyplan-reached">' + text(reachedLabel) + '</td></tr>';
    }).join("");

    var reached = tranches.filter(function (item) { return item.reached === true; });
    var prompt = reached.length
      ? '<div class="buyplan-prompt" data-testid="buyplan-prompt"><strong>價格已進入' + text(reached[reached.length - 1].label) + '區間。</strong><span>請確認投資假設是否仍成立，再由你自己決定是否買進。系統不代為判斷。</span></div>'
      : '<div class="buyplan-prompt muted" data-testid="buyplan-prompt-idle"><strong>尚未進入任何分段區間。</strong><span>到價時這裡只會提示你回頭檢查 Thesis。</span></div>';

    return pageHeader("Buy Plan", "總預算 · 分段價格 · 分段比例 · 到價提示") +
      card("分段買進計畫", text(symbol) + " · 價格由 Valuation 的買進區間帶入", 
        '<div class="buyplan-form" data-testid="buyplan-form">' +
        '<label><span>總預算</span><input type="number" min="0" step="1000" inputmode="decimal" value="' + escapeHtml(buyPlanDraft.totalBudget) + '" data-action="buyplan-input" data-field="totalBudget" data-testid="buyplan-budget"></label>' +
        buyPlanAllocField("first", "第一階段", "buyplan-alloc-first") +
        buyPlanAllocField("second", "第二階段", "buyplan-alloc-second") +
        buyPlanAllocField("sweet", "甜蜜區", "buyplan-alloc-sweet") +
        buyPlanAllocField("reserve", "保留資金", "buyplan-alloc-reserve") +
        '<label><span>投資組合上限（%）</span><input type="number" min="0" max="100" step="1" inputmode="decimal" value="' + escapeHtml(buyPlanDraft.maxPositionPct) + '" data-action="buyplan-input" data-field="maxPositionPct" data-testid="buyplan-max-position"></label>' +
        '<div class="buyplan-actions"><button class="btn btn-primary" type="button" data-action="buyplan-save" data-testid="buyplan-save"' + (issues.length ? " disabled" : "") + '>儲存買進計畫</button>' +
        formIssuesMarkup(issues, "buyplan-issues") + '</div></div>', "") +
      card("分段狀態", hasZone ? "價格對照 Valuation 的買進區間" : "尚未建立估值", 
        (hasZone ? "" : '<div class="empty-state" data-testid="buyplan-no-valuation"><strong>此標的尚未建立 Base 合理價值。</strong><span>分段價格一律由估值推導，不從市價或歷史高點回推。</span></div>') +
        '<div class="table-responsive"><table class="table" data-testid="buyplan-table"><thead><tr><th>階段</th><th>價格</th><th>比例</th><th>金額</th><th>到價</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        prompt +
        '<p class="valuation-note">到價只提示你回頭檢查投資假設。這裡不提供、也不會出現「建議買進」「強力買進」或任何信心分數；沒有下單、模擬下單或券商連線。</p>', "");
  }

  function reviewPageMarkup() {
    return pageHeader("Review", "月／季審查 · 假設是否仍成立") +
      card("投資審查", "避免買進後忘記原本理由", '<div class="empty-state" data-testid="review-empty"><strong>Review 尚未建置。</strong><span>這個區塊將在後續節點實作：營收‧EPS‧毛利率‧展望是否符合預期，以及審查結果。</span></div>', "");
  }

  function evidencePageMarkup() {
    return pageHeader("資料來源", "資料脈絡與可重現性") +
      card("證據登錄表", "資料快照識別與來源連結", '<div class="lineage-grid"><div><span class="detail-label">資料格式</span><p>' + text(view.schema) +
        '</p></div><div><span class="detail-label">視圖摘要雜湊</span><p class="mono">' + text(view.view_digest || "未記錄") +
        '</p></div><div><span class="detail-label">資料截至</span><p>' + text(view.as_of) + '</p></div><div><span class="detail-label">證據連結</span>' + evidenceMarkup(view.evidence_links) + '</div></div>', "");
  }

  function mainMarkup() {
    var section = state.activeSection;
    if (section === "watchlist") return watchlistPageMarkup();
    if (section === "company") return companyPageMarkup();
    if (section === "valuation") return valuationPageMarkup();
    if (section === "buyplan") return buyPlanPageMarkup();
    if (section === "review") return reviewPageMarkup();
    if (section === "settings") return settingsMarkup();
    if (section === "evidence") return evidencePageMarkup();
    return homePageMarkup();
  }

  function systemTopbarMarkup() {
    var active = state.activeSection;
    var links = [{ id: "watchlist", label: "自選" }, { id: "company", label: "公司" }, { id: "valuation", label: "估值" }, { id: "buyplan", label: "買進計畫" }, { id: "review", label: "審查" }];
    var instruments = core.klineInstruments(state.view);
    return '<header class="topbar system-topbar"><div class="system-topbar-left"><div class="breadcrumb"><span>VALUE RESEARCH</span><span class="sep">/</span><span class="current">' + text(core.SECTIONS.find(function (item) { return item.id === active; }).label) + '</span></div><nav class="system-quick-nav" aria-label="快速工具">' + links.map(function (link) { return '<button class="system-quick-link' + (active === link.id ? ' active' : '') + '" type="button" data-action="section" data-section="' + link.id + '">' + text(link.label) + '</button>'; }).join('') + '</nav></div><div class="system-topbar-right"><div class="system-global-search symbol-search"><label><span>搜尋標的</span><input type="search" autocomplete="off" placeholder="代號 / 名稱" value="' + escapeHtml(klineSearchQuery || '') + '" data-action="global-search" data-testid="global-search" aria-controls="global-search-results"></label>' + symbolSearchResults(instruments, klineSearchQuery, [], state.selectedKlineInstrumentId, "global-search-results", "global-search-pick") + '</div><span class="system-feed-status"><i></i>EOD · 本機</span><span class="read-only-pill">研究唯讀</span><button class="btn btn-outline btn-sm" type="button" data-action="reset">重設視圖</button></div></header>';
  }

  function render() {
    root.innerHTML = '<div class="app-shell"><aside class="sidebar"><div class="sidebar-brand"><img class="brand-logo" src="./tqr-logo.svg" alt="Value Research Workspace"><span class="brand-name">Value Research <small>台股價值投資研究工作台</small></span></div><nav class="sidebar-nav" aria-label="主導覽">' + navMarkup() + '</nav><div class="sidebar-footer"><div class="sidebar-note"><span class="read-only-icon">唯</span><p><strong>免費優先 · 本機記錄</strong><span>財報決定價值、估值決定買進價格；市場只提供成交機會。</span></p></div></div></aside><main class="main">' + systemTopbarMarkup() + '<div class="page-wrapper" id="main-content" tabindex="-1">' + mainMarkup() + '</div><footer class="footer"><span>資料格式 ' + text(view.schema) + '</span><span>本機資料 · 人工估值 · 最後決策保留人工</span></footer></main></div>' + detailDialog();
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
    if (action === "valuation-add") addWorksheetFromDraft();
    if (action === "valuation-delete") {
      state = core.reduce(state, { type: "DELETE_VALUATION_WORKSHEET", worksheetId: target.getAttribute("data-worksheet-id") });
      persistValuation();
    }
    if (action === "valuation-evaluate") evaluateValuation();
    if (action === "buyplan-save") {
      saveBuyPlanFromDraft();
      return;
    }
    if (action === "theme-set") applyTheme(target.getAttribute("data-theme"));
    if (action === "update-check") {
      checkAppUpdate();
      return;
    }
    if (action === "update-install") {
      installAppUpdate();
      return;
    }
    if (action === "financial-review-save") {
      financialReviewSaved = savePrototypeDraft(FINANCIAL_REVIEW_LOCAL_STORAGE_KEY, financialReviewDraft);
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
    if (target.getAttribute("data-action") === "financial-review-input") {
      financialReviewDraft[target.getAttribute("data-field")] = target.value;
      financialReviewSaved = false;
      return;
    }
    if (target.getAttribute("data-action") === "alert-input") {
      alertDraft[target.getAttribute("data-field")] = target.value;
      var alertIssuesOnChange = core.alertFormIssues(alertDraft, { symbol: (selectedKlineInstrument() || {}).symbol });
      var alertAddButtonOnChange = root.querySelector('[data-testid="alert-add"]');
      if (alertAddButtonOnChange) alertAddButtonOnChange.disabled = alertIssuesOnChange.length > 0;
      refreshFormIssues("alert-form-issues", alertIssuesOnChange);
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
      var groupNameIssuesNow = core.watchlistGroupNameIssues(watchlistGroupNameQuery);
      var createGroupButton = root.querySelector('[data-testid="watchlist-group-create"]');
      if (createGroupButton) createGroupButton.disabled = groupNameIssuesNow.length > 0;
      refreshFormIssues("watchlist-group-issues", groupNameIssuesNow);
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
    if (target.getAttribute("data-action") === "buyplan-input") {
      buyPlanDraft[target.getAttribute("data-field")] = target.value;
      render();
      return;
    }
    if (target.getAttribute("data-action") === "watchlist-filter") {
      state = core.reduce(state, { type: "SET_WATCHLIST_FILTER", field: target.getAttribute("data-field"), value: target.value });
      render();
      return;
    }
    if (target.getAttribute("data-action") === "watchlist-sort") {
      state = core.reduce(state, { type: "SET_WATCHLIST_SORT", value: target.value });
      render();
      return;
    }
    if (target.getAttribute("data-action") === "note-input") {
      state = core.reduce(state, { type: "SET_NOTE_DRAFT", field: target.getAttribute("data-field"), value: target.value });
      return;
    }
    if (target.getAttribute("data-action") === "financial-review-input") {
      financialReviewDraft[target.getAttribute("data-field")] = target.value;
      financialReviewSaved = false;
      return;
    }
    if (target.getAttribute("data-action") === "alert-input") {
      alertDraft[target.getAttribute("data-field")] = target.value;
      var alertIssuesNow = core.alertFormIssues(alertDraft, { symbol: (selectedKlineInstrument() || {}).symbol });
      var alertAddButton = root.querySelector('[data-testid="alert-add"]');
      if (alertAddButton) alertAddButton.disabled = alertIssuesNow.length > 0;
      refreshFormIssues("alert-form-issues", alertIssuesNow);
      return;
    }
    if (target.getAttribute("data-action") === "valuation-ws-input") {
      var field = target.getAttribute("data-field");
      valuationDraft[field] = target.value;
      if (field === "model") {
        render();
        return;
      }
      var valuationIssuesNow = core.valuationFormIssues(valuationDraft, { symbol: (selectedKlineInstrument() || {}).symbol });
      var valuationAddButton = root.querySelector('[data-testid="valuation-add"]');
      if (valuationAddButton) valuationAddButton.disabled = valuationIssuesNow.length > 0;
      refreshFormIssues("valuation-form-issues", valuationIssuesNow);
      return;
    }
    if (target.getAttribute("data-action") === "valuation-indicator-period") {
      state = core.reduce(state, {
        type: "SET_VALUATION_INDICATOR_PERIOD",
        indicator: target.getAttribute("data-indicator"),
        period: target.value
      });
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
  loadBuyPlans();
  ensureNotesRuntime();
  ensureAlertsRuntime();
  ensureValuationRuntime();
  applyTheme(currentTheme());
  ensureAppVersion();
  ensureSidecarUrl().then(function () {
    render();
  });
}());
