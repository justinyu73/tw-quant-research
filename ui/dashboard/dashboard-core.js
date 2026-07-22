(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TWQuantDashboard = factory();
  }
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  var SECTIONS = Object.freeze([
    { id: "overview", label: "市場首頁" },
    { id: "market", label: "行情分析" },
    { id: "products", label: "我的自選" },
    { id: "features", label: "技術指標" },
    { id: "research", label: "因子與公式" },
    { id: "fundamentals", label: "財務追蹤" },
    { id: "stories", label: "研究筆記" },
    { id: "backtest", label: "驗證報告" },
    { id: "evidence", label: "資料來源" },
    { id: "settings", label: "設定" }
  ]);

  var WATCHLIST_SCHEMA = "tw-quant-engine-watchlist/v1";
  var ALERT_STORE_SCHEMA = "tqe-in-app-alerts/v1";
  var VALUATION_STORE_SCHEMA = "tqe-fair-value-worksheets/v1";
  var MAX_ALERTS = 50;
  var MAX_WORKSHEETS = 50;
  var VALUATION_MODEL_TYPES = ["pe_multiple", "dividend_discount_simple", "growth_adjusted_pe"];
  var VALUATION_INDICATOR_TYPES = ["zscore", "price_percentile", "ma_deviation"];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function sectionExists(section) {
    return SECTIONS.some(function (item) { return item.id === section; });
  }

  function createInitialState(view) {
    var kline = view && view.kline ? view.kline : {};
    return {
      view: clone(view || {}),
      activeSection: "overview",
      selectedProductIndex: null,
      dialogOpen: false,
      selectedKlineInstrumentId: kline.default_instrument_id || null,
      selectedKlinePeriod: kline.default_period || "1D",
      activeKlineIndicator: "ma",
      klineRuntimeStatus: kline.runtime_fetch ? "idle" : "ready",
      watchlist: {
        items: [],
        status: "idle",
        dirty: false,
        message: ""
      },
      watchlistGroups: [{ id: "default", name: "我的自選", items: [] }],
      activeWatchlistGroupId: "default",
      dataUpdate: {
        scope: "watchlist",
        years: 1,
        status: "idle",
        message: "",
        results: []
      },
      screenSpec: {
        schema: "tw-quant-engine-screen-spec/v1",
        universe: "s8.product_rows",
        quality: "admitted",
        market: "",
        max_rows: 20
      },
      screenSpecStatus: "applied",
      strategySpec: {
        schema: "tw-quant-engine-strategy-spec/v1",
        id: "screen-review-v1",
        universe: "screen_spec",
        entry: "human_review_required",
        exit: "not_configured",
        execution: "research_only",
        status: "not_admitted"
      },
      valuationInputs: {
        eps: "",
        peLow: "",
        peHigh: "",
        safetyMargin: ""
      },
      notes: [],
      noteDraft: { title: "", body: "", tags: "" },
      alerts: {
        definitions: [],
        events: [],
        status: "idle",
        message: ""
      },
      alertSessionState: {},
      valuation: {
        worksheets: [],
        results: [],
        indicators: [],
        status: "idle",
        message: ""
      },
      valuationIndicatorPeriods: { zscore: 20, price_percentile: 60, ma_deviation: 20 }
    };
  }

  function klineModels(view) {
    return view && view.kline && Array.isArray(view.kline.models) ? view.kline.models : [];
  }

  function selectedKline(state) {
    var models = klineModels(state && state.view);
    var instrumentId = state && state.selectedKlineInstrumentId;
    var period = state && state.selectedKlinePeriod;
    return models.find(function (model) {
      return model.instrument && model.instrument.instrument_id === instrumentId && model.period === period;
    }) || null;
  }

  function klineInstruments(view) {
    if (view && view.kline && Array.isArray(view.kline.instruments)) {
      return view.kline.instruments;
    }
    var seen = {};
    return klineModels(view).filter(function (model) {
      var id = model.instrument && model.instrument.instrument_id;
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    }).map(function (model) { return model.instrument; });
  }

  function klinePeriods(view, instrumentId) {
    var instrument = klineInstruments(view).find(function (item) {
      return item.instrument_id === instrumentId;
    });
    if (instrument && Array.isArray(instrument.periods)) return instrument.periods.slice();
    return klineModels(view).filter(function (model) {
      return model.instrument && model.instrument.instrument_id === instrumentId;
    }).map(function (model) { return model.period; });
  }

  function klineModel(view, instrumentId, period) {
    return klineModels(view).find(function (model) {
      return model.instrument && model.instrument.instrument_id === instrumentId && model.period === period;
    }) || null;
  }

  function normalizeWatchlist(items) {
    if (!Array.isArray(items)) return [];
    var seen = {};
    return items.filter(function (item) {
      if (typeof item !== "string" || !item || item.length > 64 || !/^[A-Za-z0-9:_.-]+$/.test(item) || seen[item]) return false;
      seen[item] = true;
      return true;
    }).slice(0, 100);
  }

  function normalizeGroupItems(items, allItems) {
    var allowed = normalizeWatchlist(allItems || []);
    return normalizeWatchlist(items).filter(function (item) { return allowed.indexOf(item) >= 0; });
  }

  function watchlistGroupsFor(state) {
    var allItems = state && state.watchlist ? state.watchlist.items : [];
    var groups = state && Array.isArray(state.watchlistGroups) ? state.watchlistGroups : [];
    if (!groups.length) return [{ id: "default", name: "我的自選", items: normalizeWatchlist(allItems) }];
    return groups.map(function (group) {
      return { id: group.id, name: group.name, items: normalizeGroupItems(group.items, allItems) };
    });
  }

  function updateGroups(groups, instrumentId, mode, activeId) {
    return groups.map(function (group) {
      var items = group.items.slice();
      if (mode === "remove" || (mode === "add" && group.id === activeId)) {
        var index = items.indexOf(instrumentId);
        if (mode === "remove" && index >= 0) items.splice(index, 1);
        if (mode === "add" && index < 0) items.push(instrumentId);
      }
      return Object.assign({}, group, { items: items });
    });
  }

  function normalizeAlertDefinitions(definitions) {
    if (!Array.isArray(definitions)) return [];
    var seen = {};
    return definitions.filter(function (definition) {
      if (!definition || typeof definition !== "object") return false;
      if (definition.schema !== "tqe-in-app-alert/v1") return false;
      var id = definition.alert_id;
      if (typeof id !== "string" || !id || id.length > 64 || !/^[A-Za-z0-9:_.-]+$/.test(id) || seen[id]) return false;
      if (!definition.target || typeof definition.target.security_id !== "string") return false;
      if (!definition.condition || typeof definition.condition !== "object") return false;
      seen[id] = true;
      return true;
    }).map(function (definition) { return clone(definition); }).slice(0, MAX_ALERTS);
  }

  function normalizeAlertEvents(events) {
    if (!Array.isArray(events)) return [];
    return events.filter(function (event) {
      return event && typeof event === "object" && event.schema === "tqe-in-app-alert-event/v1" &&
        event.channel === "in_app" && typeof event.alert_id === "string" && typeof event.fired_at === "string";
    }).map(function (event) { return clone(event); }).slice(0, 200);
  }

  function mergeAlertEvents(existing, fired) {
    var merged = normalizeAlertEvents(existing);
    var keys = {};
    merged.forEach(function (event) { keys[event.alert_id + "@" + event.fired_at] = true; });
    normalizeAlertEvents(fired).forEach(function (event) {
      var key = event.alert_id + "@" + event.fired_at;
      if (!keys[key]) {
        keys[key] = true;
        merged.unshift(event);
      }
    });
    return merged.slice(0, 200);
  }

  function normalizeValuationWorksheets(definitions) {
    if (!Array.isArray(definitions)) return [];
    var seen = {};
    return definitions.filter(function (definition) {
      if (!definition || typeof definition !== "object") return false;
      if (definition.schema !== "tqe-fair-value-worksheet/v1") return false;
      var id = definition.worksheet_id;
      if (typeof id !== "string" || !id || id.length > 64 || !/^[A-Za-z0-9:_.-]+$/.test(id) || seen[id]) return false;
      if (!definition.target || typeof definition.target.security_id !== "string") return false;
      if (!definition.model || VALUATION_MODEL_TYPES.indexOf(definition.model.type) < 0) return false;
      if (typeof definition.safety_margin !== "number" || !(definition.safety_margin >= 0 && definition.safety_margin < 1)) return false;
      seen[id] = true;
      return true;
    }).map(function (definition) { return clone(definition); }).slice(0, MAX_WORKSHEETS);
  }

  function normalizeValuationResults(results) {
    if (!Array.isArray(results)) return [];
    return results.filter(function (result) {
      return result && typeof result === "object" && typeof result.worksheet_id === "string" &&
        result.formula_version === "tqe-fair-value/v1" && result.research_only === true &&
        (result.status === "ok" || result.status === "insufficient_data");
    }).map(function (result) { return clone(result); }).slice(0, MAX_WORKSHEETS);
  }

  function normalizeValuationIndicators(indicators) {
    if (!Array.isArray(indicators)) return [];
    return indicators.filter(function (indicator) {
      return indicator && typeof indicator === "object" && indicator.schema === "tqe-price-volume-indicator/v1" &&
        VALUATION_INDICATOR_TYPES.indexOf(indicator.type) >= 0 && typeof indicator.security_id === "string" &&
        Number.isInteger(indicator.period) && (indicator.status === "ok" || indicator.status === "insufficient_data");
    }).map(function (indicator) { return clone(indicator); }).slice(0, 50);
  }

  function reduce(state, action) {
    var current = state || createInitialState({});
    var event = action || {};
    if (event.type === "SELECT_SECTION" && sectionExists(event.section)) {
      return Object.assign({}, current, {
        activeSection: event.section,
        selectedProductIndex: null,
        dialogOpen: false
      });
    }
    if (event.type === "OPEN_PRODUCT_DETAIL") {
      var products = Array.isArray(current.view.products) ? current.view.products : [];
      if (Number.isInteger(event.index) && event.index >= 0 && event.index < products.length) {
        return Object.assign({}, current, {
          activeSection: "products",
          selectedProductIndex: event.index,
          dialogOpen: true
        });
      }
    }
    if (event.type === "SELECT_KLINE_INSTRUMENT") {
      var instrumentPeriods = klinePeriods(current.view, event.instrumentId);
      if (instrumentPeriods.length) {
        var periodExists = instrumentPeriods.indexOf(current.selectedKlinePeriod) >= 0;
        return Object.assign({}, current, {
          activeSection: "market",
          selectedKlineInstrumentId: event.instrumentId,
          selectedKlinePeriod: periodExists ? current.selectedKlinePeriod : instrumentPeriods[0]
        });
      }
    }
    if (event.type === "SELECT_KLINE_PERIOD") {
      if (klinePeriods(current.view, current.selectedKlineInstrumentId).indexOf(event.period) >= 0) {
        return Object.assign({}, current, { activeSection: "market", selectedKlinePeriod: event.period });
      }
    }
    if (event.type === "TOGGLE_KLINE_INDICATOR" && ["ma", "ema", "rsi", "macd", "kd", "atr", "volume"].indexOf(event.indicator) >= 0) {
      return Object.assign({}, current, { activeSection: "market", activeKlineIndicator: event.indicator });
    }
    if (event.type === "SET_VALUATION_INPUT" && ["eps", "peLow", "peHigh", "safetyMargin"].indexOf(event.field) >= 0) {
      return Object.assign({}, current, {
        valuationInputs: Object.assign({}, current.valuationInputs, {
          [event.field]: typeof event.value === "string" ? event.value : ""
        })
      });
    }
    if (event.type === "SET_NOTE_DRAFT" && ["title", "body", "tags"].indexOf(event.field) >= 0) {
      return Object.assign({}, current, {
        noteDraft: Object.assign({}, current.noteDraft, { [event.field]: typeof event.value === "string" ? event.value : "" })
      });
    }
    if (event.type === "SET_NOTES") {
      return Object.assign({}, current, {
        notes: Array.isArray(event.notes) ? clone(event.notes).slice(0, 200) : []
      });
    }
    if (event.type === "ADD_NOTE" && event.note && typeof event.note === "object") {
      return Object.assign({}, current, {
        notes: [clone(event.note)].concat(Array.isArray(current.notes) ? current.notes : []).slice(0, 200),
        noteDraft: { title: "", body: "", tags: "" }
      });
    }
    if (event.type === "DELETE_NOTE" && typeof event.noteId === "string") {
      return Object.assign({}, current, {
        notes: (Array.isArray(current.notes) ? current.notes : []).filter(function (note) { return note.id !== event.noteId; })
      });
    }
    if (event.type === "SET_ALERTS") {
      return Object.assign({}, current, {
        alerts: { definitions: normalizeAlertDefinitions(event.definitions), events: normalizeAlertEvents(current.alerts && current.alerts.events), status: "ready", message: "" }
      });
    }
    if (event.type === "ADD_ALERT" && event.alert && typeof event.alert === "object") {
      var alertDefinitions = normalizeAlertDefinitions((current.alerts ? current.alerts.definitions : []).concat([event.alert]));
      if (alertDefinitions.length === (current.alerts ? current.alerts.definitions.length : 0)) return current;
      return Object.assign({}, current, {
        alerts: Object.assign({}, current.alerts, { definitions: alertDefinitions, status: "ready", message: "" })
      });
    }
    if (event.type === "DELETE_ALERT" && typeof event.alertId === "string") {
      return Object.assign({}, current, {
        alerts: Object.assign({}, current.alerts, {
          definitions: (current.alerts ? current.alerts.definitions : []).filter(function (definition) { return definition.alert_id !== event.alertId; })
        })
      });
    }
    if (event.type === "ALERTS_EVALUATED") {
      return Object.assign({}, current, {
        alerts: Object.assign({}, current.alerts, {
          events: mergeAlertEvents(current.alerts && current.alerts.events, event.fired),
          status: "ready",
          message: ""
        }),
        alertSessionState: event.sessionState && typeof event.sessionState === "object" ? clone(event.sessionState) : {}
      });
    }
    if (event.type === "ALERTS_ERROR") {
      return Object.assign({}, current, {
        alerts: Object.assign({}, current.alerts, { status: "error", message: event.message || "alerts_evaluation_failed" })
      });
    }
    if (event.type === "CLEAR_ALERT_EVENTS") {
      return Object.assign({}, current, {
        alerts: Object.assign({}, current.alerts, { events: [] }),
        alertSessionState: {}
      });
    }
    if (event.type === "SET_VALUATION_WORKSHEETS") {
      return Object.assign({}, current, {
        valuation: Object.assign({}, current.valuation, {
          worksheets: normalizeValuationWorksheets(event.worksheets),
          status: "ready",
          message: ""
        })
      });
    }
    if (event.type === "ADD_VALUATION_WORKSHEET" && event.worksheet && typeof event.worksheet === "object") {
      var worksheetList = normalizeValuationWorksheets((current.valuation ? current.valuation.worksheets : []).concat([event.worksheet]));
      if (worksheetList.length === (current.valuation ? current.valuation.worksheets.length : 0)) return current;
      return Object.assign({}, current, {
        valuation: Object.assign({}, current.valuation, { worksheets: worksheetList, status: "ready", message: "" })
      });
    }
    if (event.type === "DELETE_VALUATION_WORKSHEET" && typeof event.worksheetId === "string") {
      return Object.assign({}, current, {
        valuation: Object.assign({}, current.valuation, {
          worksheets: (current.valuation ? current.valuation.worksheets : []).filter(function (definition) { return definition.worksheet_id !== event.worksheetId; }),
          results: (current.valuation && Array.isArray(current.valuation.results) ? current.valuation.results : []).filter(function (result) { return result.worksheet_id !== event.worksheetId; })
        })
      });
    }
    if (event.type === "VALUATION_EVALUATED") {
      return Object.assign({}, current, {
        valuation: Object.assign({}, current.valuation, {
          results: normalizeValuationResults(event.results),
          indicators: normalizeValuationIndicators(event.indicators),
          status: "ready",
          message: ""
        })
      });
    }
    if (event.type === "VALUATION_ERROR") {
      return Object.assign({}, current, {
        valuation: Object.assign({}, current.valuation, { status: "error", message: event.message || "valuation_evaluation_failed" })
      });
    }
    if (event.type === "SET_VALUATION_INDICATOR_PERIOD" && VALUATION_INDICATOR_TYPES.indexOf(event.indicator) >= 0) {
      var requestedPeriod = Math.round(Number(event.period));
      if (!Number.isInteger(requestedPeriod) || requestedPeriod < 1 || requestedPeriod > 250) return current;
      return Object.assign({}, current, {
        valuationIndicatorPeriods: Object.assign({}, current.valuationIndicatorPeriods, { [event.indicator]: requestedPeriod })
      });
    }
    if (event.type === "SET_WATCHLIST") {
      return Object.assign({}, current, {
        watchlist: { items: normalizeWatchlist(event.items), status: "ready", dirty: false, message: "" },
        watchlistGroups: [{ id: "default", name: "我的自選", items: normalizeWatchlist(event.items) }],
        activeWatchlistGroupId: "default"
      });
    }
    if (event.type === "WATCHLIST_LOAD_ERROR") {
      return Object.assign({}, current, {
        watchlist: Object.assign({}, current.watchlist, { status: "error", message: event.message || "load_failed" })
      });
    }
    if (event.type === "TOGGLE_WATCHLIST" && typeof event.instrumentId === "string") {
      var currentItems = current.watchlist.items.slice();
      var existingIndex = currentItems.indexOf(event.instrumentId);
      var groups = watchlistGroupsFor(current);
      var activeGroup = groups.find(function (group) { return group.id === current.activeWatchlistGroupId; }) || groups[0];
      var activeHas = activeGroup && activeGroup.items.indexOf(event.instrumentId) >= 0;
      if (existingIndex >= 0 && activeHas) {
        currentItems.splice(existingIndex, 1);
        groups = updateGroups(groups, event.instrumentId, "remove", current.activeWatchlistGroupId);
      } else if (currentItems.length < 100) {
        if (existingIndex < 0) currentItems.push(event.instrumentId);
        groups = updateGroups(groups, event.instrumentId, "add", current.activeWatchlistGroupId);
      }
      else return current;
      return Object.assign({}, current, {
        watchlist: { items: normalizeWatchlist(currentItems), status: "draft", dirty: true, message: "" },
        watchlistGroups: groups
      });
    }
    if (event.type === "REMOVE_WATCHLIST") {
      var remaining = current.watchlist.items.filter(function (item) { return item !== event.instrumentId; });
      return Object.assign({}, current, {
        watchlist: { items: remaining, status: "draft", dirty: true, message: "" },
        watchlistGroups: updateGroups(watchlistGroupsFor(current), event.instrumentId, "remove", current.activeWatchlistGroupId)
      });
    }
    if (event.type === "CLEAR_WATCHLIST") {
      return Object.assign({}, current, {
        watchlist: { items: [], status: "draft", dirty: true, message: "" },
        watchlistGroups: watchlistGroupsFor(current).map(function (group) { return Object.assign({}, group, { items: [] }); })
      });
    }
    if (event.type === "SELECT_WATCHLIST_GROUP" && watchlistGroupsFor(current).some(function (group) { return group.id === event.groupId; })) {
      return Object.assign({}, current, { activeWatchlistGroupId: event.groupId });
    }
    if (event.type === "CREATE_WATCHLIST_GROUP" && typeof event.name === "string") {
      var name = event.name.trim().slice(0, 32);
      if (!name) return current;
      var existingGroups = watchlistGroupsFor(current);
      var baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "group";
      var groupId = baseId;
      var suffix = 2;
      while (existingGroups.some(function (group) { return group.id === groupId; })) groupId = baseId + "-" + suffix++;
      return Object.assign({}, current, {
        watchlistGroups: existingGroups.concat([{ id: groupId, name: name, items: [] }]),
        activeWatchlistGroupId: groupId
      });
    }
    if (event.type === "DELETE_WATCHLIST_GROUP" && typeof event.groupId === "string") {
      var groupsToDelete = watchlistGroupsFor(current);
      var groupToDelete = groupsToDelete.find(function (group) { return group.id === event.groupId; });
      if (!groupToDelete || groupToDelete.id === "default") return current;
      var remainingGroups = groupsToDelete.filter(function (group) { return group.id !== event.groupId; });
      var nextActiveGroupId = current.activeWatchlistGroupId === event.groupId
        ? "default"
        : current.activeWatchlistGroupId;
      return Object.assign({}, current, {
        watchlistGroups: remainingGroups,
        activeWatchlistGroupId: nextActiveGroupId
      });
    }
    if (event.type === "ADD_TO_WATCHLIST_GROUP" && typeof event.instrumentId === "string") {
      var groupList = watchlistGroupsFor(current);
      var targetGroup = groupList.find(function (group) { return group.id === current.activeWatchlistGroupId; });
      if (!targetGroup) return current;
      var nextItems = current.watchlist.items.slice();
      if (nextItems.indexOf(event.instrumentId) < 0) nextItems.push(event.instrumentId);
      var nextGroups = groupList.map(function (group) {
        if (group.id !== targetGroup.id || group.items.indexOf(event.instrumentId) >= 0) return group;
        return Object.assign({}, group, { items: group.items.concat([event.instrumentId]) });
      });
      return Object.assign({}, current, {
        watchlist: { items: normalizeWatchlist(nextItems), status: "draft", dirty: true, message: "" },
        watchlistGroups: nextGroups
      });
    }
    if (event.type === "WATCHLIST_SAVING") {
      return Object.assign({}, current, {
        watchlist: Object.assign({}, current.watchlist, { status: "saving", message: "" })
      });
    }
    if (event.type === "WATCHLIST_SAVED") {
      return Object.assign({}, current, {
        watchlist: { items: normalizeWatchlist(current.watchlist.items), status: "saved", dirty: false, message: "" }
      });
    }
    if (event.type === "SET_DATA_UPDATE_SCOPE" && ["watchlist", "selected"].indexOf(event.scope) >= 0) {
      return Object.assign({}, current, { dataUpdate: Object.assign({}, current.dataUpdate, { scope: event.scope }) });
    }
    if (event.type === "SET_DATA_UPDATE_YEARS") {
      var requestedYears = Number(event.years);
      if ([1, 2, 3].indexOf(requestedYears) < 0) return current;
      return Object.assign({}, current, { dataUpdate: Object.assign({}, current.dataUpdate, { years: requestedYears }) });
    }
    if (event.type === "DATA_UPDATE_START") {
      return Object.assign({}, current, { dataUpdate: Object.assign({}, current.dataUpdate, { status: "loading", message: "正在下載並驗證官方資料…" }) });
    }
    if (event.type === "DATA_UPDATE_SUCCESS") {
      return Object.assign({}, current, { dataUpdate: Object.assign({}, current.dataUpdate, { status: event.status || "success", message: event.message || "本機資料已更新", results: Array.isArray(event.results) ? clone(event.results) : [] }) });
    }
    if (event.type === "DATA_UPDATE_ERROR") {
      return Object.assign({}, current, { dataUpdate: Object.assign({}, current.dataUpdate, { status: "error", message: event.message || "本機資料更新失敗", results: [] }) });
    }
    if (event.type === "SET_SCREEN_SPEC" && ["quality", "market", "max_rows"].indexOf(event.field) >= 0) {
      var nextSpec = Object.assign({}, current.screenSpec);
      nextSpec[event.field] = event.field === "max_rows" ? Math.max(1, Math.min(100, Number(event.value) || 20)) : String(event.value || "");
      return Object.assign({}, current, { screenSpec: nextSpec, screenSpecStatus: "draft" });
    }
    if (event.type === "APPLY_SCREEN_SPEC") return Object.assign({}, current, { screenSpecStatus: "applied" });
    if (event.type === "WATCHLIST_SAVE_ERROR") {
      return Object.assign({}, current, {
        watchlist: Object.assign({}, current.watchlist, { status: "error", dirty: true, message: event.message || "save_failed" })
      });
    }
    if (event.type === "CLOSE_DIALOG") {
      return Object.assign({}, current, { selectedProductIndex: null, dialogOpen: false });
    }
    if (event.type === "RESET") {
      var reset = createInitialState(current.view);
      reset.watchlist = Object.assign({}, current.watchlist, { items: current.watchlist.items.slice() });
      reset.watchlistGroups = watchlistGroupsFor(current);
      reset.activeWatchlistGroupId = current.activeWatchlistGroupId;
      reset.notes = Array.isArray(current.notes) ? current.notes.slice() : [];
      reset.alerts = Object.assign({}, current.alerts, {
        definitions: (current.alerts && Array.isArray(current.alerts.definitions) ? current.alerts.definitions : []).slice(),
        events: (current.alerts && Array.isArray(current.alerts.events) ? current.alerts.events : []).slice()
      });
      reset.alertSessionState = clone(current.alertSessionState || {});
      reset.valuation = Object.assign({}, current.valuation, {
        worksheets: (current.valuation && Array.isArray(current.valuation.worksheets) ? current.valuation.worksheets : []).slice()
      });
      reset.valuationIndicatorPeriods = Object.assign({}, current.valuationIndicatorPeriods);
      return reset;
    }
    if (event.type === "KLINE_LOADING") {
      return Object.assign({}, current, { klineRuntimeStatus: "loading" });
    }
    if (event.type === "KLINE_ERROR") {
      return Object.assign({}, current, { klineRuntimeStatus: "error" });
    }
    if (event.type === "SET_KLINE_INSTRUMENTS") {
      var instruments = Array.isArray(event.instruments) ? clone(event.instruments) : [];
      var selectedId = instruments.some(function (item) { return item.instrument_id === current.selectedKlineInstrumentId; })
        ? current.selectedKlineInstrumentId
        : (instruments.some(function (item) { return item.instrument_id === current.view.kline.default_instrument_id; })
          ? current.view.kline.default_instrument_id
          : (instruments[0] && instruments[0].instrument_id));
      var selectedPeriods = instruments.filter(function (item) { return item.instrument_id === selectedId; })[0];
      var periods = selectedPeriods && Array.isArray(selectedPeriods.periods) ? selectedPeriods.periods : [];
      var selectedPeriod = periods.indexOf(current.selectedKlinePeriod) >= 0
        ? current.selectedKlinePeriod : (periods[0] || "1D");
      var nextKline = Object.assign({}, current.view.kline, {
        instruments: instruments,
        models: [],
        default_instrument_id: selectedId || current.view.kline.default_instrument_id,
        default_period: selectedPeriod
      });
      return Object.assign({}, current, {
        view: Object.assign({}, current.view, { kline: nextKline }),
        selectedKlineInstrumentId: selectedId || null,
        selectedKlinePeriod: selectedPeriod,
        klineRuntimeStatus: "ready"
      });
    }
    if (event.type === "SET_KLINE_MODEL" && event.model && event.model.instrument) {
      var existingModels = klineModels(current.view).filter(function (model) {
        return !(model.instrument && model.instrument.instrument_id === event.model.instrument.instrument_id && model.period === event.model.period);
      });
      existingModels.push(clone(event.model));
      existingModels.sort(function (left, right) {
        return (left.instrument.instrument_id + left.period).localeCompare(right.instrument.instrument_id + right.period);
      });
      return Object.assign({}, current, {
        view: Object.assign({}, current.view, { kline: Object.assign({}, current.view.kline, { models: existingModels }) }),
        klineRuntimeStatus: "ready"
      });
    }
    return current;
  }

  function selectedProduct(state) {
    if (!state || !state.dialogOpen || !Number.isInteger(state.selectedProductIndex)) return null;
    var products = Array.isArray(state.view.products) ? state.view.products : [];
    return products[state.selectedProductIndex] || null;
  }

  function qualityLabel(row) {
    var quality = row && row.quality;
    return quality && typeof quality.admission_status === "string"
      ? quality.admission_status
      : "invalid";
  }

  function productLabel(row) {
    var instrument = row && row.instrument;
    var security = instrument && instrument.security_id;
    var market = instrument && instrument.market;
    return [security || "Unknown security", market || "Unknown market"].join(" · ");
  }

  function summary(view) {
    var quality = view && view.quality ? view.quality : {};
    var counts = quality.status_counts || {};
    return {
      admitted: Number(counts.admitted || 0),
      unadmitted: Number(counts.unadmitted || 0),
      invalid: Number(counts.invalid || 0),
      productCount: Array.isArray(view && view.products) ? view.products.length : 0,
      featureCount: Array.isArray(view && view.features) ? view.features.length : 0,
      backtestStatus: view && view.backtest ? view.backtest.status : "empty"
    };
  }

  function formatNumber(value) {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
  }

  function formatPercent(value) {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
    return (value * 100).toFixed(2) + "%";
  }

  function latestKlineClose(state) {
    var model = selectedKline(state);
    var bars = model && Array.isArray(model.bars) ? model.bars : [];
    if (!bars.length || typeof bars[bars.length - 1].close !== "number") return null;
    return bars[bars.length - 1].close;
  }

  function watchlistPayload(state) {
    return {
      schema: WATCHLIST_SCHEMA,
      version: 1,
      items: normalizeWatchlist(state && state.watchlist ? state.watchlist.items : [])
    };
  }

  // The store keeps session-expiry definitions so they survive a reload
  // within the same session; the app loader drops them when a new session
  // starts via dropSessionAlertDefinitions.
  function alertStorePayload(state) {
    return {
      schema: ALERT_STORE_SCHEMA,
      version: 1,
      alerts: normalizeAlertDefinitions(state && state.alerts ? state.alerts.definitions : [])
    };
  }

  function valuationStorePayload(state) {
    return {
      schema: VALUATION_STORE_SCHEMA,
      version: 1,
      worksheets: normalizeValuationWorksheets(state && state.valuation ? state.valuation.worksheets : [])
    };
  }

  function dropSessionAlertDefinitions(definitions) {
    return normalizeAlertDefinitions(definitions).filter(function (definition) {
      return !(definition.expiry && definition.expiry.policy === "session");
    });
  }

  // Field-level form rejection feedback (TQR-FORM-FEEDBACK): every rule below
  // mirrors the engine fail-closed validators (alerts.py validate_alert /
  // valuation.py validate_worksheet) or the reducer guards, translated to a
  // Chinese message that names the field and the expected format. The UI only
  // displays these; the engine remains the final fail-closed gate.
  function issue(field, message) {
    return { field: field, message: message };
  }

  function numberTextIsFinite(value) {
    var raw = String(value === null || value === undefined ? "" : value).trim();
    return raw !== "" && Number.isFinite(Number(raw));
  }

  function numberText(value) {
    return Number(String(value).trim());
  }

  function alertFormIssues(draft, context) {
    var data = draft || {};
    var symbol = context && context.symbol;
    var issues = [];
    if (!symbol) issues.push(issue("target", "尚未選擇標的；請先在上方行情區選擇商品"));
    if (!String(data.label || "").trim()) issues.push(issue("label", "名稱不可空白（120 字以內）"));
    if (!numberTextIsFinite(data.value)) issues.push(issue("value", "門檻值需為數字，例如 950 或 12.5"));
    if (data.dedupPolicy === "cooldown_seconds") {
      var seconds = String(data.cooldownSeconds === null || data.cooldownSeconds === undefined ? "" : data.cooldownSeconds).trim();
      if (!/^\d+$/.test(seconds) || Number(seconds) < 1) issues.push(issue("cooldownSeconds", "冷卻秒數需為大於 0 的整數，例如 3600"));
    }
    if (data.expiryPolicy === "until") {
      var until = String(data.until || "").trim();
      if (!until || isNaN(new Date(until).getTime())) issues.push(issue("until", "到期時間需為有效的日期時間，例如 2026-12-31T18:00"));
    }
    return issues;
  }

  function valuationFormIssues(draft, context) {
    var data = draft || {};
    var symbol = context && context.symbol;
    var issues = [];
    if (!symbol) issues.push(issue("target", "尚未選擇標的；請先在上方行情區選擇商品"));
    if (!String(data.label || "").trim()) issues.push(issue("label", "工作表名稱不可空白（120 字以內）"));
    var model = data.model || "pe_multiple";
    if (model === "pe_multiple") {
      if (!numberTextIsFinite(data.eps) || numberText(data.eps) <= 0) issues.push(issue("eps", "預估 EPS 需為大於 0 的數字，例如 10"));
      if (!numberTextIsFinite(data.targetPe) || numberText(data.targetPe) <= 0) issues.push(issue("targetPe", "目標本益比需為大於 0 的數字，例如 15"));
    } else if (model === "dividend_discount_simple") {
      if (!numberTextIsFinite(data.dps) || numberText(data.dps) <= 0) issues.push(issue("dps", "預估每股股利需為大於 0 的數字，例如 5"));
      if (!numberTextIsFinite(data.growthRate)) issues.push(issue("growthRate", "股利成長率 g 需為數字（小數），例如 0.03"));
      else if (numberText(data.growthRate) <= -1) issues.push(issue("growthRate", "股利成長率 g 需大於 -1"));
      if (!numberTextIsFinite(data.discountRate) || numberText(data.discountRate) <= 0) issues.push(issue("discountRate", "折現率 r 需為大於 0 的數字（小數），例如 0.08"));
      else if (numberTextIsFinite(data.growthRate) && numberText(data.discountRate) <= numberText(data.growthRate)) issues.push(issue("discountRate", "折現率 r 必須大於股利成長率 g"));
    } else if (model === "growth_adjusted_pe") {
      if (!numberTextIsFinite(data.eps) || numberText(data.eps) <= 0) issues.push(issue("eps", "預估 EPS 需為大於 0 的數字，例如 10"));
      if (!numberTextIsFinite(data.growthPct)) issues.push(issue("growthPct", "預估成長率需為數字（%），例如 12"));
      if (!numberTextIsFinite(data.peg)) issues.push(issue("peg", "PEG 倍數需為數字，例如 1.0"));
      if (numberTextIsFinite(data.growthPct) && numberTextIsFinite(data.peg) && numberText(data.growthPct) * numberText(data.peg) <= 0) {
        issues.push(issue("growthPct", "預估成長率與 PEG 倍數的乘積需為正數"));
      }
    }
    if (!numberTextIsFinite(data.safetyMargin) || numberText(data.safetyMargin) < 0 || numberText(data.safetyMargin) >= 100) {
      issues.push(issue("safetyMargin", "安全邊際需為 0 以上、小於 100 的數字（%），例如 15"));
    }
    return issues;
  }

  function watchlistGroupNameIssues(name) {
    return String(name || "").trim() ? [] : [issue("name", "群組名稱不可空白（32 字以內）")];
  }

  function watchlistAddIssues(context) {
    var data = context || {};
    var query = String(data.query || "").trim();
    var selected = data.selected || null;
    var items = Array.isArray(data.items) ? data.items : [];
    if (!query) return [issue("query", "請先輸入代號或名稱搜尋商品，例如 2330")];
    if (!selected) return [issue("query", "找不到完全相符的商品；請輸入完整代號（例如 2330）或從搜尋結果點選")];
    if (items.indexOf(selected.instrument_id) >= 0) return [issue("selection", "此商品已在目前群組")];
    return [];
  }

  function watchlistItemsForActiveGroup(state) {
    var groups = watchlistGroupsFor(state);
    var active = groups.find(function (group) { return group.id === (state && state.activeWatchlistGroupId); }) || groups[0];
    return active ? active.items.slice() : [];
  }

  function screenProducts(view, spec) {
    var filter = spec || {};
    var products = Array.isArray(view && view.products) ? view.products : [];
    return products.filter(function (row) {
      var market = row.instrument && row.instrument.market;
      var quality = qualityLabel(row);
      return (!filter.market || market === filter.market) && (!filter.quality || quality === filter.quality);
    }).slice(0, Number(filter.max_rows) || 20);
  }

  return Object.freeze({
    SECTIONS: SECTIONS,
    ALERT_STORE_SCHEMA: ALERT_STORE_SCHEMA,
    VALUATION_STORE_SCHEMA: VALUATION_STORE_SCHEMA,
    createInitialState: createInitialState,
    reduce: reduce,
    selectedProduct: selectedProduct,
    qualityLabel: qualityLabel,
    productLabel: productLabel,
    summary: summary,
    formatNumber: formatNumber,
    formatPercent: formatPercent,
    latestKlineClose: latestKlineClose,
    klineModel: klineModel,
    watchlistPayload: watchlistPayload,
    alertStorePayload: alertStorePayload,
    valuationStorePayload: valuationStorePayload,
    normalizeValuationWorksheets: normalizeValuationWorksheets,
    normalizeValuationResults: normalizeValuationResults,
    normalizeValuationIndicators: normalizeValuationIndicators,
    dropSessionAlertDefinitions: dropSessionAlertDefinitions,
    normalizeAlertDefinitions: normalizeAlertDefinitions,
    mergeAlertEvents: mergeAlertEvents,
    alertFormIssues: alertFormIssues,
    valuationFormIssues: valuationFormIssues,
    watchlistGroupNameIssues: watchlistGroupNameIssues,
    watchlistAddIssues: watchlistAddIssues,
    watchlistItemsForActiveGroup: watchlistItemsForActiveGroup,
    screenProducts: screenProducts,
    klineModels: klineModels,
    selectedKline: selectedKline,
    klineInstruments: klineInstruments,
    klinePeriods: klinePeriods
  });
}));
