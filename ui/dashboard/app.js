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
  var watchlistModelRequests = {};
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

  function navMarkup() {
    return core.SECTIONS.map(function (item, index) {
      var active = item.id === state.activeSection;
      var symbols = ["⌂", "⌁", "▦", "▤", "◈", "▥", "✦", "↗", "≡"];
      return '<button class="nav-link' + (active ? " active" : "") +
        '" type="button" data-action="section" data-section="' + item.id +
        '" aria-current="' + (active ? "page" : "false") + '">' +
        '<span class="nav-symbol" aria-hidden="true">' + symbols[index] + "</span>" +
        '<span class="nav-text">' + item.label + "</span>" +
        (active ? '<span class="nav-active-mark" aria-hidden="true"></span>' : "") +
        "</button>";
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
      '<button class="research-module" type="button" data-action="section" data-section="fundamentals"><span class="module-icon module-finance">▤</span><span><strong>財報基本面</strong><small>期間、來源、衝突與不可用狀態</small></span><span class="module-arrow">→</span></button>' +
      '<button class="research-module" type="button" data-action="section" data-section="research"><span class="module-icon module-screen">◈</span><span><strong>市場篩選</strong><small>TWSE／TPEx 條件與人工審查</small></span><span class="module-arrow">→</span></button>' +
      '<button class="research-module" type="button" data-action="section" data-section="stories"><span class="module-icon module-story">✦</span><span><strong>故事與證據</strong><small>事件、假說、支持與反證</small></span><span class="module-arrow">→</span></button></div>';
  }

  function cockpitMarkup() {
    var summary = core.summary(view);
    return pageHeader("研究駕駛艙", "免費優先的台股研究工作區") +
      '<section class="cockpit-hero" data-testid="cockpit-hero"><div class="cockpit-hero-copy"><span class="eyebrow">台股研究工作台 · 人為導向</span><h2>從市場，走到一個可驗證的故事。</h2><p>用免費公開資料建立本地證據，再由人為檢查財報、價格、事件與假說。這裡不是即時下單，也不替你做投資決策。</p><div class="cockpit-actions"><button class="btn btn-primary" type="button" data-action="section" data-section="market">開始看個股</button><button class="btn btn-outline" type="button" data-action="section" data-section="research">開啟市場篩選</button></div></div><div class="cockpit-hero-state"><span class="eyebrow">研究狀態</span><strong>本地資料 · 唯讀</strong><span>資料截至 ' + text(view.as_of) + '</span><span class="free-first-tag">免費優先 · 不含券商</span></div></section>' +
      '<div class="cockpit-stat-grid" data-testid="cockpit-stats"><article class="cockpit-stat"><span class="stat-kicker">自選觀察</span><strong>' + text((state.watchlist && state.watchlist.items || []).length) + '</strong><span>本機草稿中的標的數</span></article><article class="cockpit-stat"><span class="stat-kicker">已納入資料</span><strong>' + text(summary.admitted) + '</strong><span>通過品質門檻的資料列</span></article><article class="cockpit-stat"><span class="stat-kicker">資料品質</span><strong>' + text(summary.invalid) + ' 筆無效</strong><span>不自動修補</span></article><article class="cockpit-stat"><span class="stat-kicker">下一步</span><strong>人工評估</strong><span>財報 · 事件 · 故事</span></article></div>' +
      '<div class="cockpit-layout"><div class="cockpit-main-column">' + watchlistMarkup() + card("市場快照", "台股標的與資料品質", productRows(view.products, 4), '<button class="btn btn-outline btn-sm" type="button" data-action="section" data-section="products">查看市場資料</button>') + card("研究模組", "整合四個參考網站的工作方式", researchModulesMarkup(), "") + '</div><aside class="cockpit-rail">' + card("目前標的", "行情、圖表與自選清單連動", stockQuoteMarkup(), "") + storyTrackerMarkup() + card("資料策略", "資料先保存，證據可追溯", '<div class="policy-list"><div><span>來源</span><strong>免費官方／公開</strong></div><div><span>保存</span><strong>原始 + 標準化</strong></div><div><span>計算</span><strong>人為啟動</strong></div><div><span>交易</span><strong>明確排除</strong></div></div>', "") + '</aside></div>';
  }

  function fundamentalsMarkup() {
    var rows = Array.isArray(view.products) ? view.products.filter(function (row) { return row && row.record_type === "fundamental_observation"; }) : [];
    var body = rows.length ? rows.map(function (row) {
      var metric = row.fundamental || {};
      return '<tr><td class="cell-strong">' + text((row.instrument || {}).market + ":" + (row.instrument || {}).security_id) + '</td><td>' + text(metric.metric) + '</td><td class="cell-mono">' + core.formatNumber(metric.monthly_revenue) + '</td><td>' + text(metric.unit) + '</td><td>' + statusBadge(core.qualityLabel(row)) + '</td><td class="mono">' + text((row.provenance || {}).source_id) + '</td></tr>';
    }).join("") : '<tr><td colspan="6">目前沒有已接入的財報觀測資料；不以價格推估。</td></tr>';
    return pageHeader("財報基本面", "期間化資料 · 來源優先 · 可回溯") +
      '<div class="fundamental-banner"><strong>財報資料只接受有期間與來源的觀測。</strong><span>目前本地資料只有一筆月營收衝突案例，狀態維持未納入；這是品質訊號，不是可用數值。</span></div>' +
      '<div class="fundamental-metric-grid"><article class="fundamental-metric"><span>EPS</span><strong>—</strong><small>尚未接入免費官方來源</small></article><article class="fundamental-metric"><span>ROE</span><strong>—</strong><small>尚未接入免費官方來源</small></article><article class="fundamental-metric"><span>營收 YoY</span><strong>—</strong><small>衝突資料不推估</small></article><article class="fundamental-metric"><span>現金流</span><strong>—</strong><small>等待期間化資料</small></article></div>' +
      card("基本面觀測表", "每一列都要能回到 source / period / as-of", '<div class="table-responsive"><table class="table fundamental-table"><thead><tr><th>標的</th><th>指標</th><th>數值</th><th>單位</th><th>品質</th><th>來源</th></tr></thead><tbody>' + body + '</tbody></table></div>', "") +
      card("人工評估欄", "協助整理下一次人工檢查", '<div class="review-prompt-grid"><div><strong>支持故事</strong><span>哪些財報欄位支持目前假說？</span></div><div><strong>反證</strong><span>哪些期間或來源衝突需要暫停結論？</span></div><div><strong>下次檢查</strong><span>下一個財報／營收公布後再更新。</span></div></div>', "");
  }

  function storiesMarkup() {
    return pageHeader("故事追蹤", "公司故事 · 事件 · 證據審查") +
      '<div class="story-board"><section class="story-board-main">' + card("研究故事卡", "一家公司一條可追蹤假說", '<div class="story-empty"><span class="story-empty-icon">✦</span><strong>目前沒有已保存的公司故事</strong><p>先從個股分析或市場篩選選一個標的，再由人為建立「支持／反證／待確認」內容。系統不自動生成投資敘事。</p><button class="btn btn-primary" type="button" data-action="section" data-section="market">選擇個股</button></div>', "") + card("事件時間線", "公告／財報／除權息／產業變化", '<div class="timeline"><div><span class="timeline-dot"></span><div><strong>等待免費官方事件來源</strong><small>尚未抓取；不以新聞摘要代替原始證據。</small></div></div><div><span class="timeline-dot muted-dot"></span><div><strong>人為新增下一個檢查點</strong><small>保存日期、來源、觀察與結論。</small></div></div></div>', "") + '</section><aside class="story-board-rail">' + card("故事欄位", "XQ 式研究詞彙", '<div class="story-field-list"><div><span>主題</span><strong>產品／競爭／資本配置</strong></div><div><span>支持</span><strong>財報與公開公告</strong></div><div><span>反證</span><strong>數據衰退或來源衝突</strong></div><div><span>狀態</span><strong>草稿 · 人工審查</strong></div></div>', "") + card("證據規則", "FinLab 式資料脈絡", '<p class="research-boundary">每一個故事結論都必須附上來源、期間、可用時間與摘要雜湊。缺少任何一項就維持待確認，不自動升格。</p>', "") + '</aside></div>';
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

  function sidecarBaseUrl() {
    var raw = window.__TW_QUANT_SIDECAR_URL__ || "http://127.0.0.1:8766";
    try {
      var parsed = new URL(raw);
      if (parsed.protocol !== "http:" || ["127.0.0.1", "localhost", "[::1]", "::1"].indexOf(parsed.hostname) < 0) return "";
      return parsed.origin;
    } catch (error) {
      return "";
    }
  }

  function sidecarFetch(path) {
    var base = sidecarBaseUrl();
    if (!base) return Promise.reject(new Error("sidecar must use loopback HTTP"));
    return fetch(base + path, { method: "GET", cache: "no-store" }).then(function (response) {
      if (!response.ok) throw new Error("sidecar request failed: " + response.status);
      return response.json();
    });
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

  function instrumentForId(instrumentId) {
    return core.klineInstruments(state.view).find(function (instrument) {
      return instrument.instrument_id === instrumentId;
    }) || null;
  }

  function symbolSearchText(instrument) {
    return [instrument.instrument_id, instrument.symbol, instrument.display_name, instrument.market]
      .filter(Boolean).join(" ").toLowerCase();
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
      if (state.activeSection === "market") requestKlineModel();
      requestWatchlistModels();
    }
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
    var selected = instrumentForId(watchlistSearchSelection);
    var canAdd = Boolean(selected && items.indexOf(selected.instrument_id) < 0);
    var saving = state.watchlist && state.watchlist.status === "saving";
    var canSave = state.watchlist && state.watchlist.dirty && !saving && watchlistPersistenceAvailable !== false;
    return card("自選清單", "本機保存 · 明確儲存 · 資料唯讀", '<div class="watchlist-toolbar" data-testid="watchlist-toolbar">' +
      '<label class="watchlist-group-picker"><span>群組</span><select data-action="watchlist-group-select" data-testid="watchlist-group-select">' + groups.map(function (group) {
        return '<option value="' + escapeHtml(group.id) + '"' + (group.id === state.activeWatchlistGroupId ? ' selected' : '') + '>' + text(group.name) + ' · ' + group.items.length + '</option>';
      }).join("") + '</select></label>' +
      '<label class="watchlist-group-new"><span>新增群組</span><input type="text" maxlength="32" placeholder="例如 半導體" value="' + escapeHtml(watchlistGroupNameQuery) + '" data-action="watchlist-group-name" data-testid="watchlist-group-name"></label>' +
      '<button class="btn btn-outline" type="button" data-action="watchlist-group-create" data-testid="watchlist-group-create"' + (watchlistGroupNameQuery.trim() ? '' : ' disabled') + '>建立群組</button>' +
      '<div class="watchlist-picker symbol-search' + (watchlistSearchFocused ? " search-open" : "") + '"><label><span>搜尋商品</span><input type="search" autocomplete="off" placeholder="代號、名稱或市場，例如 2330 / 台積電" value="' + escapeHtml(watchlistSearchQuery) + '" data-action="watchlist-search" data-testid="watchlist-picker" aria-controls="watchlist-symbol-results"></label>' +
      symbolSearchResults(instruments, watchlistSearchQuery, items, watchlistSearchSelection, "watchlist-symbol-results", "watchlist-search-pick") + '</div>' +
      '<button class="btn btn-primary" type="button" data-action="watchlist-add" data-testid="watchlist-add"' + (canAdd ? '' : ' disabled') + '>加入自選</button>' +
      '<button class="btn btn-outline" type="button" data-action="watchlist-clear" data-testid="watchlist-clear"' + (items.length ? '' : ' disabled') + '>清除草稿</button>' +
      '<button class="btn btn-primary" type="button" data-action="watchlist-save" data-testid="watchlist-save"' + (canSave ? '' : ' disabled') + '>儲存自選清單</button>' +
      '<span class="watchlist-state" data-testid="watchlist-state">' + text(watchlistStatus()) + '</span></div>' +
      watchlistRows() + '<p class="watchlist-note">桌面開發版使用本機 JSON；瀏覽器預覽使用同一資料格式的瀏覽器本機儲存備援。群組目前是本機工作階段資料；PE、EPS、月營收年增與最新財報期目前顯示「—」，代表基本面快照尚未接入；不以 K 線資料推估。成交量取自來源資料欄位。</p>', "");
  }

  function researchInstrumentId(row) {
    var instrument = row && row.instrument || {};
    if (!instrument.market || !instrument.security_id) return "";
    return instrument.market + ":" + instrument.security_id;
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
    return pageHeader("篩選研究", "篩選規格 → 群組自選 → 研究策略規格") +
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
      width: Math.max(canvas.clientWidth || 640, 320),
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
        chart.applyOptions({ width: Math.max(canvas.clientWidth || 640, 320) });
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
    if (section === "market") return pageHeader("個股分析", "圖表工作區 · 收盤資料 · 截止日快照") + '<div class="stock-analysis-layout"><div class="stock-analysis-main">' + klineMarkup() + '</div>' + analysisRailMarkup() + '</div>';
    if (section === "products") return pageHeader("市場資料", "來源對齊的市場資料列") + '<div class="data-source-banner"><strong>免費資料本地保存</strong><span>目前顯示已核准的本地資料；未接入付費訂閱、即時行情或券商。</span></div>' + card("市場資料列", "原始價格／財報觀測與品質狀態", productRows(view.products));
    if (section === "features") return pageHeader("技術因子", "避免未來資料滲入的因子資料模型") + card("技術因子快照", "保留資料截至日與公式脈絡；由人為啟動研究", featureMarkup());
    if (section === "research") return researchMarkup();
    if (section === "fundamentals") return fundamentalsMarkup();
    if (section === "stories") return storiesMarkup();
    if (section === "backtest") return pageHeader("研究計算", "人為啟動的計算 · 不代表自動執行") + '<div class="calculation-boundary"><strong>這裡只保存人為啟動的研究計算結果。</strong><span>不代表即時策略、不會送單，也不會自動升格為投資決策。</span></div>' + card("研究計算快照", "可重播的研究結果，不是交易執行", backtestMarkup());
    if (section === "evidence") return pageHeader("資料與證據", "資料脈絡與可重現性") + card("證據登錄表", "資料快照識別與來源連結", '<div class="lineage-grid"><div><span class="detail-label">資料格式</span><p>' + text(view.schema) +
      '</p></div><div><span class="detail-label">視圖摘要雜湊</span><p class="mono">' + text(view.view_digest || "未記錄") +
      '</p></div><div><span class="detail-label">資料截至</span><p>' + text(view.as_of) + '</p></div><div><span class="detail-label">證據連結</span>' + evidenceMarkup(view.evidence_links) + '</div></div>');
    return cockpitMarkup();
  }

  function render() {
    root.innerHTML = '<div class="app-shell"><aside class="sidebar"><div class="sidebar-brand"><img class="brand-logo" src="./tqr-logo.svg" alt="TQR"><span class="brand-name">TQR <small>台股研究工作台</small></span></div><nav class="sidebar-nav" aria-label="主導覽"><div class="nav-label">研究模組</div><div class="nav-group">' + navMarkup() + '</div></nav><div class="sidebar-footer"><div class="sidebar-note"><span class="read-only-icon">唯</span><p><strong>免費優先 · 資料唯讀</strong><span>資料先保存，評估由人為確認；不含即時、下單或自動交易。</span></p></div></div></aside><main class="main"><header class="topbar"><div class="topbar-left"><div class="breadcrumb"><span>台股研究</span><span class="sep">/</span><span class="current">' + text(core.SECTIONS.find(function (item) { return item.id === state.activeSection; }).label) + '</span></div></div><div class="topbar-right"><span class="read-only-pill">資料唯讀</span><span class="free-first-topbar">免費優先</span><span class="snapshot">資料截至 ' + text(view.as_of) + '</span><button class="btn btn-outline btn-sm" type="button" data-action="reset">重設視圖</button></div></header><div class="page-wrapper" id="main-content" tabindex="-1">' + mainMarkup() + '</div><footer class="footer"><span>資料格式 ' + text(view.schema) + '</span><span>本機生成 · 免費資料／本機服務</span></footer></main></div>' + detailDialog();
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
    if (action === "watchlist-group-create") {
      state = core.reduce(state, { type: "CREATE_WATCHLIST_GROUP", name: watchlistGroupNameQuery });
      watchlistGroupNameQuery = "";
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
    if (action === "kline-drawing") chartDrawingMode = !chartDrawingMode;
    if (action === "kline-drawing-clear") chartDrawings = [];
    if (action === "kline-template") {
      chartTemplateName = chartTemplateName === "default" ? "research" : "default";
      chartDrawingMode = false;
      state = core.reduce(state, { type: "TOGGLE_KLINE_INDICATOR", indicator: chartTemplateName === "research" ? "ma" : "ema" });
    }
    if (action === "watchlist-add") {
      if (watchlistSearchSelection) {
        state = core.reduce(state, { type: "TOGGLE_WATCHLIST", instrumentId: watchlistSearchSelection });
        watchlistSearchSelection = null;
        watchlistSearchQuery = "";
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
    if (action === "kline-period" || action === "kline-search-pick") requestKlineModel();
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
    if (target.getAttribute("data-action") === "screen-input") {
      state = core.reduce(state, { type: "SET_SCREEN_SPEC", field: target.getAttribute("data-field"), value: target.value });
    }
  });

  root.addEventListener("input", function (event) {
    var target = event.target;
    if (!target) return;
    if (target.getAttribute("data-action") === "watchlist-search") {
      watchlistSearchQuery = target.value;
      watchlistSearchSelection = null;
      watchlistSearchFocused = true;
      refreshSearchResults("watchlist-symbol-results", symbolSearchResults(core.klineInstruments(state.view), watchlistSearchQuery, core.watchlistItemsForActiveGroup(state), null, "watchlist-symbol-results", "watchlist-search-pick"));
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
    if (target.getAttribute("data-action") === "screen-input") {
      state = core.reduce(state, { type: "SET_SCREEN_SPEC", field: target.getAttribute("data-field"), value: target.value });
      return;
    }
    if (target.getAttribute("data-action") !== "valuation-input") return;
    state = core.reduce(state, {
      type: "SET_VALUATION_INPUT",
      field: target.getAttribute("data-field"),
      value: target.value
    });
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.dialogOpen) {
      state = core.reduce(state, { type: "CLOSE_DIALOG" });
      render();
    }
  });

  render();
}());
