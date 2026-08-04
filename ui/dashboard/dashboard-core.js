(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TWQuantDashboard = factory();
  }
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  var SECTIONS = Object.freeze([
    { id: "home", label: "首頁" },
    { id: "watchlist", label: "自選清單" },
    { id: "company", label: "公司財務指標" },
    { id: "technical", label: "技術指標" },
    { id: "valuation", label: "估值" },
    { id: "buyplan", label: "買進計畫" },
    { id: "review", label: "投資審查" },
    { id: "evidence", label: "資料來源" },
    { id: "settings", label: "設定" }
  ]);
  // Only the first six are primary navigation; evidence/settings stay reachable
  // from inside a page so provenance is never lost.
  var PRIMARY_SECTION_IDS = Object.freeze(["home", "watchlist", "company", "technical", "valuation", "buyplan", "review"]);

  var WATCHLIST_SCHEMA = "tw-quant-engine-watchlist/v1";
  var ALERT_STORE_SCHEMA = "tqe-in-app-alerts/v1";
  var VALUATION_STORE_SCHEMA = "tqr-scenario-valuation-worksheets/v1";
  var VALUATION_WORKSHEET_SCHEMA = "tqr-scenario-valuation-worksheet/v1";
  var VALUATION_FORMULA_VERSION = "tqr-scenario-valuation/v1";
  var MAX_ALERTS = 50;
  var MAX_WORKSHEETS = 50;
  var VALUATION_SCENARIOS = ["bear", "base", "bull"];
  var BUY_ZONE_ORDER = ["watch", "first", "second", "sweet", "extreme"];
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
      activeSection: "home",
      selectedProductIndex: null,
      dialogOpen: false,
      selectedKlineInstrumentId: kline.default_instrument_id || null,
      selectedKlinePeriod: kline.default_period || "1D",
      activeKlineIndicator: "ma",
      klineRuntimeStatus: kline.runtime_fetch ? "idle" : "ready",
      klineSelectionMessage: null,
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
      valuationIndicatorPeriods: { zscore: 20, price_percentile: 60, ma_deviation: 20 },
      companyResearch: {},
      watchlistFilters: { industry: "", fundamental_state: "", thesis_state: "", stage: "", held: "" },
      watchlistSort: "discount",
      buyPlans: {},
      theses: {},
      reviews: {}
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
      var id = definition.worksheet_id;
      if (typeof id !== "string" || !id || id.length > 64 || !/^[A-Za-z0-9:_.-]+$/.test(id) || seen[id]) return false;
      if (!definition.target || typeof definition.target.security_id !== "string") return false;
      if (definition.schema !== VALUATION_WORKSHEET_SCHEMA) return false;
      if (!definition.scenarios || VALUATION_SCENARIOS.some(function (name) {
        var entry = definition.scenarios[name];
        return !entry || !(entry.eps > 0) || !(entry.pe > 0);
      })) return false;
      if (!definition.basis || typeof definition.basis.eps_period !== "string" || !definition.basis.eps_period) return false;
      var ratios = definition.buy_zone_ratios;
      if (!ratios || BUY_ZONE_ORDER.some(function (key) { return !(ratios[key] > 0 && ratios[key] <= 1); })) return false;
      seen[id] = true;
      return true;
    }).map(function (definition) { return clone(definition); }).slice(0, MAX_WORKSHEETS);
  }

  function normalizeValuationResults(results) {
    if (!Array.isArray(results)) return [];
    return results.filter(function (result) {
      return result && typeof result === "object" && typeof result.worksheet_id === "string" &&
        result.formula_version === VALUATION_FORMULA_VERSION && result.research_only === true &&
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
    if (event.type === "SET_WATCHLIST_FILTER") {
      var filters = Object.assign({}, current.watchlistFilters);
      filters[event.field] = typeof event.value === "string" ? event.value : "";
      return Object.assign({}, current, { watchlistFilters: filters });
    }
    if (event.type === "SET_WATCHLIST_SORT") {
      return Object.assign({}, current, { watchlistSort: event.value });
    }
    if (event.type === "SET_COMPANY_RECORD" && companyFieldAccepts(event.field, event.value)) {
      var records = Object.assign({}, current.companyResearch);
      var record = Object.assign(defaultCompanyRecord(event.instrumentId), records[event.instrumentId] || {});
      record[event.field] = event.value;
      record.updated_at = event.now || record.updated_at;
      records[event.instrumentId] = record;
      return Object.assign({}, current, { companyResearch: records });
    }
    if (event.type === "SET_BUY_PLAN") {
      var plans = Object.assign({}, current.buyPlans);
      plans[event.instrumentId] = Object.assign(defaultBuyPlan(event.instrumentId), event.plan, {
        instrument_id: event.instrumentId
      });
      return Object.assign({}, current, { buyPlans: plans });
    }
    if (event.type === "LOAD_BUY_PLANS") {
      return Object.assign({}, current, { buyPlans: normalizeBuyPlans(event.payload) });
    }
    if (event.type === "SET_THESIS_FIELD") {
      var theses = Object.assign({}, current.theses);
      var thesis = Object.assign(defaultThesis(), theses[event.instrumentId] || {});
      thesis[event.field] = typeof event.value === "string" ? event.value.slice(0, 2000) : "";
      theses[event.instrumentId] = thesis;
      return Object.assign({}, current, { theses: theses });
    }
    if (event.type === "LOAD_COMPANY_RESEARCH") {
      return Object.assign({}, current, { companyResearch: normalizeCompanyResearch(event.payload) });
    }
    if (event.type === "LOAD_THESES") {
      return Object.assign({}, current, { theses: normalizeThesisStore(event.payload) });
    }
    if (event.type === "ADD_REVIEW") {
      var reviews = Object.assign({}, current.reviews);
      var list = Array.isArray(reviews[event.instrumentId]) ? reviews[event.instrumentId].slice() : [];
      list.unshift(clone(event.review));
      reviews[event.instrumentId] = list.slice(0, 50);
      return Object.assign({}, current, { reviews: reviews });
    }
    if (event.type === "LOAD_REVIEWS") {
      return Object.assign({}, current, { reviews: normalizeReviewStore(event.payload) });
    }
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
          activeSection: "watchlist",
          selectedProductIndex: event.index,
          dialogOpen: true
        });
      }
    }
    if (event.type === "SELECT_KLINE_INSTRUMENT") {
      var instrumentPeriods = klinePeriods(current.view, event.instrumentId);
      // A valid Taiwan equity watchlist entry may be newly added before its
      // first local K-line snapshot exists. Keep it selectable so the bounded
      // data-update command can classify/fetch it; missing bars are a data gap,
      // not a navigation jump.
      var updateableTaiwanEquity = /^(TWSE|TPEX):[1-9][0-9]{3}$/.test(String(event.instrumentId || "").trim().toUpperCase());
      if (instrumentPeriods.length || updateableTaiwanEquity) {
        var periodExists = instrumentPeriods.indexOf(current.selectedKlinePeriod) >= 0;
        return Object.assign({}, current, {
          // Keep a stock selection inside the current work surface. The home
          // page is the one intentional exception: its shared picker opens the
          // company's numbers so the selection has an immediate read model.
          activeSection: current.activeSection === "home" ? "company" : current.activeSection,
          selectedKlineInstrumentId: event.instrumentId,
          selectedKlinePeriod: periodExists ? current.selectedKlinePeriod : (instrumentPeriods[0] || "1D"),
          klineSelectionMessage: null
        });
      }
    }
    if (event.type === "SELECT_KLINE_PERIOD") {
      if (klinePeriods(current.view, current.selectedKlineInstrumentId).indexOf(event.period) >= 0) {
        return Object.assign({}, current, { activeSection: "technical", selectedKlinePeriod: event.period, klineSelectionMessage: null });
      }
    }
    if (event.type === "TOGGLE_KLINE_INDICATOR" && ["ma", "ema", "rsi", "macd", "kd", "atr", "volume"].indexOf(event.indicator) >= 0) {
      return Object.assign({}, current, { activeSection: "technical", activeKlineIndicator: event.indicator });
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
    if (event.type === "UPDATE_VALUATION_WORKSHEET" && event.worksheet && typeof event.worksheet === "object" && typeof event.worksheet.worksheet_id === "string") {
      var existingWorksheets = current.valuation && Array.isArray(current.valuation.worksheets) ? current.valuation.worksheets : [];
      if (!existingWorksheets.some(function (definition) { return definition.worksheet_id === event.worksheet.worksheet_id; })) return current;
      var updatedWorksheets = normalizeValuationWorksheets(existingWorksheets.map(function (definition) {
        return definition.worksheet_id === event.worksheet.worksheet_id ? event.worksheet : definition;
      }));
      if (updatedWorksheets.length !== existingWorksheets.length) return current;
      return Object.assign({}, current, {
        valuation: Object.assign({}, current.valuation, {
          worksheets: updatedWorksheets,
          results: (current.valuation && Array.isArray(current.valuation.results) ? current.valuation.results : []).filter(function (result) { return result.worksheet_id !== event.worksheet.worksheet_id; }),
          status: "ready",
          message: ""
        })
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
      return Object.assign({}, current, { klineRuntimeStatus: "loading", klineSelectionMessage: null });
    }
    if (event.type === "KLINE_ERROR") {
      return Object.assign({}, current, {
        klineRuntimeStatus: "error",
        klineRuntimeMessage: event.message || "本機資料服務無法連線；請重新啟動 TQR 後再試。"
      });
    }
    // One instrument with nothing downloaded says nothing about the service,
    // so the runtime stays ready and only this selection reports the gap.
    if (event.type === "KLINE_DATA_MISSING") {
      return Object.assign({}, current, {
        klineRuntimeStatus: "ready",
        klineRuntimeMessage: null,
        klineSelectionMessage: event.message || "這個標的與期間還沒有已下載的 K 線資料。"
      });
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
        klineRuntimeStatus: "ready",
        klineSelectionMessage: null
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
      productCount: Array.isArray(view && view.products) ? view.products.length : 0
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
    if (!symbol) issues.push(issue("target", "尚未選擇標的；請先在 Company 頁選擇公司"));
    if (!String(data.label || "").trim()) issues.push(issue("label", "工作表名稱不可空白（120 字以內）"));
    [["bear", "Bear"], ["base", "Base"], ["bull", "Bull"]].forEach(function (pair) {
      var epsField = pair[0] + "Eps";
      var peField = pair[0] + "Pe";
      if (!numberTextIsFinite(data[epsField]) || numberText(data[epsField]) <= 0) {
        issues.push(issue(epsField, pair[1] + " EPS 需為大於 0 的數字，例如 10"));
      }
      if (!numberTextIsFinite(data[peField]) || numberText(data[peField]) <= 0) {
        issues.push(issue(peField, pair[1] + " 合理本益比需為大於 0 的數字，例如 15"));
      }
    });
    var ratioFields = ["ratioWatch", "ratioFirst", "ratioSecond", "ratioSweet", "ratioExtreme"];
    var ratios = ratioFields.map(function (field) { return numberText(data[field]); });
    ratioFields.forEach(function (field, index) {
      if (!numberTextIsFinite(data[field]) || ratios[index] <= 0 || ratios[index] > 100) {
        issues.push(issue(field, "買進區間比例需為 0 到 100 之間的數字（%）"));
      }
    });
    if (ratios.every(function (value) { return isFinite(value); })) {
      for (var i = 1; i < ratios.length; i += 1) {
        if (ratios[i] > ratios[i - 1]) {
          issues.push(issue(ratioFields[i], "買進區間比例需由觀察區往極端錯價遞減"));
          break;
        }
      }
    }
    if (!String(data.epsPeriod || "").trim()) issues.push(issue("epsPeriod", "需記錄使用哪一期 EPS，例如 2026Q1"));
    if (["actual", "estimate"].indexOf(data.epsKind) < 0) issues.push(issue("epsKind", "需標示 EPS 為實際值或預估值"));
    if (!String(data.valuationDate || "").trim()) issues.push(issue("valuationDate", "需記錄估值日期"));
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


  // Buy-zone ladder per the value-investing spec: every band is a ratio of the
  // Base fair value, never of a price high, momentum score, or market signal.
  var DEFAULT_BUY_ZONE_RATIOS = Object.freeze({ watch: 0.90, first: 0.85, second: 0.80, sweet: 0.75, extreme: 0.65 });

  function buyZoneRatios(state) {
    var custom = state && state.buyZoneRatios;
    return custom ? Object.assign({}, DEFAULT_BUY_ZONE_RATIOS, custom) : DEFAULT_BUY_ZONE_RATIOS;
  }

  function buyZonePrices(baseValue, ratios) {
    var r = ratios || DEFAULT_BUY_ZONE_RATIOS;
    return {
      watch: baseValue * r.watch,
      first: baseValue * r.first,
      second: baseValue * r.second,
      sweet: baseValue * r.sweet,
      extreme: baseValue * r.extreme
    };
  }

  function stageForPrice(price, baseValue, ratios) {
    if (!isFiniteNumber(price) || !isFiniteNumber(baseValue) || baseValue <= 0) return "unknown";
    var zone = buyZonePrices(baseValue, ratios);
    if (price <= zone.extreme) return "extreme";
    if (price <= zone.sweet) return "sweet";
    if (price <= zone.second) return "second";
    if (price <= zone.first) return "first";
    if (price <= zone.watch) return "near";
    return "watch";
  }

  var STAGE_LABELS = Object.freeze({
    extreme: "極端錯價", sweet: "甜蜜區", second: "第二階段",
    first: "第一階段", near: "接近買進區", watch: "觀察", unknown: "未定"
  });

  function isFiniteNumber(value) {
    return typeof value === "number" && isFinite(value);
  }

  function valuationResults(state) {
    var valuation = state && state.valuation;
    return valuation && Array.isArray(valuation.results) ? valuation.results : [];
  }

  function opportunityRows(state) {
    var ratios = buyZoneRatios(state);
    return valuationResults(state).filter(function (result) {
      return result && result.status === "ok" && isFiniteNumber(result.base_value) && isFiniteNumber(result.current_price);
    }).map(function (result) {
      var stage = result.stage || stageForPrice(result.current_price, result.base_value, ratios);
      return {
        symbol: result.security_id,
        name: result.label || "",
        price: result.current_price,
        base_value: result.base_value,
        discount: (result.current_price - result.base_value) / result.base_value,
        stage: stage,
        stage_label: STAGE_LABELS[stage]
      };
    }).sort(function (a, b) { return a.discount - b.discount; });
  }

  function buyStageSummary(state) {
    var rows = watchlistViewRows(state);
    return {
      first: rows.filter(function (row) { return row.stage === "first" || row.stage === "second"; }).length,
      sweet: rows.filter(function (row) { return row.stage === "sweet" || row.stage === "extreme"; }).length,
      pending: rows.filter(function (row) { return row.thesis_state === "待確認" || row.fundamental_state === "轉弱"; }).length,
      invalid: rows.filter(function (row) { return row.thesis_state === "失效"; }).length
    };
  }

  function buyPlanStatusRows(state) {
    return opportunityRows(state).map(function (row) {
      return { symbol: row.symbol, stage: row.stage, stage_label: row.stage_label };
    });
  }


  // Per-company research record: the human's own thesis/status fields. Kept in
  // one store keyed by instrument so a company page reads one object.
  var COMPANY_RESEARCH_SCHEMA = "tqr-company-research/v1";
  var INDUSTRY_OPTIONS = Object.freeze(["Power Infrastructure", "Server Interconnect", "Passive Components", "Memory", "Edge AI", "Other"]);
  var FUNDAMENTAL_STATES = Object.freeze(["成長", "穩定", "轉弱", "未評估"]);
  var THESIS_STATES = Object.freeze(["成立", "待確認", "失效", "未評估"]);
  var POSITION_STATES = Object.freeze(["觀察", "買進", "持有", "暫停"]);

  function defaultCompanyRecord(instrumentId) {
    return {
      instrument_id: instrumentId,
      industry: "Other",
      fundamental_state: "未評估",
      thesis_state: "未評估",
      position_state: "觀察",
      next_event: "",
      held: false,
      score: "",
      note: "",
      updated_at: ""
    };
  }

  // Enum fields accept only their declared vocabulary; free-text fields accept a
  // bounded string. Anything else leaves the record untouched.
  function companyFieldAccepts(field, value) {
    var vocabularies = {
      industry: INDUSTRY_OPTIONS,
      fundamental_state: FUNDAMENTAL_STATES,
      thesis_state: THESIS_STATES,
      position_state: POSITION_STATES,
      score: ["", "1", "2", "3", "4", "5"]
    };
    if (vocabularies[field]) return vocabularies[field].indexOf(value) >= 0;
    if (field === "next_event") return typeof value === "string" && value.length <= 120;
    if (field === "note") return typeof value === "string" && value.length <= 500;
    if (field === "held") return value === true || value === false;
    return false;
  }

  function companyRecord(state, instrumentId) {
    var store = state && state.companyResearch ? state.companyResearch : {};
    return Object.assign(defaultCompanyRecord(instrumentId), store[instrumentId] || {});
  }

  function normalizeCompanyResearch(payload) {
    if (!payload || payload.schema !== COMPANY_RESEARCH_SCHEMA || !payload.records || typeof payload.records !== "object") return {};
    var out = {};
    Object.keys(payload.records).forEach(function (key) {
      if (typeof key !== "string" || !/^[A-Za-z0-9:_.-]{1,64}$/.test(key)) return;
      var record = payload.records[key];
      if (!record || typeof record !== "object") return;
      var merged = defaultCompanyRecord(key);
      if (INDUSTRY_OPTIONS.indexOf(record.industry) >= 0) merged.industry = record.industry;
      if (FUNDAMENTAL_STATES.indexOf(record.fundamental_state) >= 0) merged.fundamental_state = record.fundamental_state;
      if (THESIS_STATES.indexOf(record.thesis_state) >= 0) merged.thesis_state = record.thesis_state;
      if (POSITION_STATES.indexOf(record.position_state) >= 0) merged.position_state = record.position_state;
      if (typeof record.next_event === "string") merged.next_event = record.next_event.slice(0, 120);
      if (["", "1", "2", "3", "4", "5"].indexOf(record.score) >= 0) merged.score = record.score;
      if (typeof record.note === "string") merged.note = record.note.slice(0, 500);
      merged.held = record.held === true;
      if (typeof record.updated_at === "string") merged.updated_at = record.updated_at.slice(0, 40);
      out[key] = merged;
    });
    return out;
  }

  function companyResearchPayload(state) {
    return { schema: COMPANY_RESEARCH_SCHEMA, version: 1, records: (state && state.companyResearch) || {} };
  }


  function baseValueFor(state, securityId) {
    var hit = valuationResults(state).find(function (result) {
      return result && result.security_id === securityId && result.status === "ok" && isFiniteNumber(result.base_value);
    });
    return hit ? hit.base_value : null;
  }

  function latestCloseFor(state, instrumentId) {
    var model = klineModel(state && state.view, instrumentId, "1D");
    var bars = model && Array.isArray(model.bars) ? model.bars : [];
    var latest = bars.length ? bars[bars.length - 1] : null;
    return latest && isFiniteNumber(latest.close) ? latest.close : null;
  }

  // One watchlist row = market price + the human's own valuation + the human's
  // own status fields. Nothing here is derived from price momentum.
  function watchlistViewRows(state) {
    var ratios = buyZoneRatios(state);
    var instruments = klineInstruments(state && state.view);
    return watchlistItemsForActiveGroup(state).map(function (instrumentId) {
      var instrument = instruments.find(function (item) { return item.instrument_id === instrumentId; }) || {};
      var securityId = instrumentId.indexOf(":") >= 0 ? instrumentId.split(":")[1] : instrumentId;
      var price = latestCloseFor(state, instrumentId);
      var baseValue = baseValueFor(state, securityId);
      var zone = isFiniteNumber(baseValue) ? buyZonePrices(baseValue, ratios) : null;
      var stage = zone ? stageForPrice(price, baseValue, ratios) : "unknown";
      var record = companyRecord(state, instrumentId);
      return {
        instrument_id: instrumentId,
        symbol: instrument.symbol || securityId,
        name: instrument.display_name || "",
        industry: record.industry,
        price: price,
        base_value: baseValue,
        discount: isFiniteNumber(price) && isFiniteNumber(baseValue) ? (price - baseValue) / baseValue : null,
        first_price: zone ? zone.first : null,
        sweet_price: zone ? zone.sweet : null,
        distance_to_first: zone && isFiniteNumber(price) ? (price - zone.first) / zone.first : null,
        fundamental_state: record.fundamental_state,
        thesis_state: record.thesis_state,
        position_state: record.position_state,
        next_event: record.next_event,
        held: record.held,
        updated_at: record.updated_at,
        stage: stage,
        stage_label: STAGE_LABELS[stage]
      };
    });
  }

  function filterWatchlistRows(rows, filters) {
    var f = filters || {};
    return rows.filter(function (row) {
      if (f.industry && row.industry !== f.industry) return false;
      if (f.fundamental_state && row.fundamental_state !== f.fundamental_state) return false;
      if (f.thesis_state && row.thesis_state !== f.thesis_state) return false;
      if (f.stage && row.stage !== f.stage) return false;
      if (f.held === "held" && !row.held) return false;
      if (f.held === "not_held" && row.held) return false;
      return true;
    });
  }

  // Nulls always sort last: an unvalued company must never look like the best
  // opportunity just because it has no number yet.
  function sortWatchlistRows(rows, sortKey) {
    var key = { discount: "discount", distance: "distance_to_first", updated: "updated_at" }[sortKey] || "discount";
    return rows.slice().sort(function (a, b) {
      var left = a[key];
      var right = b[key];
      var leftMissing = left === null || left === undefined || left === "";
      var rightMissing = right === null || right === undefined || right === "";
      if (leftMissing && rightMissing) return 0;
      if (leftMissing) return 1;
      if (rightMissing) return -1;
      if (key === "updated_at") return left < right ? 1 : left > right ? -1 : 0;
      return left - right;
    });
  }


  var BUY_PLAN_SCHEMA = "tqr-buy-plans/v1";
  var ALLOCATION_KEYS = ["first", "second", "sweet", "reserve"];

  function defaultBuyPlan(instrumentId) {
    return {
      instrument_id: instrumentId,
      total_budget: 0,
      allocations: { first: 20, second: 25, sweet: 30, reserve: 25 },
      max_position_pct: 0
    };
  }

  function buyPlan(state, instrumentId) {
    var store = state && state.buyPlans ? state.buyPlans : {};
    var stored = store[instrumentId];
    if (!stored) return defaultBuyPlan(instrumentId);
    return Object.assign(defaultBuyPlan(instrumentId), stored, {
      allocations: Object.assign(defaultBuyPlan(instrumentId).allocations, stored.allocations || {})
    });
  }

  function buyPlanFormIssues(draft) {
    var data = draft || {};
    var issues = [];
    if (!numberTextIsFinite(data.totalBudget) || numberText(data.totalBudget) <= 0) {
      issues.push(issue("totalBudget", "總預算需為大於 0 的數字"));
    }
    var total = 0;
    ALLOCATION_KEYS.forEach(function (key) {
      var field = "alloc" + key.charAt(0).toUpperCase() + key.slice(1);
      if (!numberTextIsFinite(data[field]) || numberText(data[field]) < 0 || numberText(data[field]) > 100) {
        issues.push(issue(field, "分段比例需為 0 到 100 之間的數字（%）"));
      } else {
        total += numberText(data[field]);
      }
    });
    if (issues.length === 0 && Math.abs(total - 100) > 1e-9) {
      issues.push(issue("allocFirst", "分段比例與保留資金合計需為 100%，目前為 " + total + "%"));
    }
    if (data.maxPositionPct !== "" && data.maxPositionPct !== undefined &&
        (!numberTextIsFinite(data.maxPositionPct) || numberText(data.maxPositionPct) < 0 || numberText(data.maxPositionPct) > 100)) {
      issues.push(issue("maxPositionPct", "投資組合上限需為 0 到 100 之間的數字（%）"));
    }
    return issues;
  }

  // A tranche is "reached" purely by price vs the valuation ladder. Reaching it
  // is a prompt to re-check the thesis, never an instruction to buy.
  function buyPlanTranches(state, instrumentId) {
    var plan = buyPlan(state, instrumentId);
    var rows = watchlistViewRows(state);
    var row = rows.find(function (item) { return item.instrument_id === instrumentId; });
    var ratios = buyZoneRatios(state);
    var zone = row && isFiniteNumber(row.base_value) ? buyZonePrices(row.base_value, ratios) : null;
    var price = row ? row.price : null;
    return [
      { key: "first", label: "第一階段", price: zone ? zone.first : null },
      { key: "second", label: "第二階段", price: zone ? zone.second : null },
      { key: "sweet", label: "甜蜜區", price: zone ? zone.sweet : null }
    ].map(function (tranche) {
      var pct = plan.allocations[tranche.key];
      return Object.assign({}, tranche, {
        allocation_pct: pct,
        amount: plan.total_budget > 0 ? plan.total_budget * pct / 100 : null,
        reached: isFiniteNumber(price) && isFiniteNumber(tranche.price) ? price <= tranche.price : null
      });
    }).concat([{
      key: "reserve",
      label: "保留資金",
      price: null,
      allocation_pct: plan.allocations.reserve,
      amount: plan.total_budget > 0 ? plan.total_budget * plan.allocations.reserve / 100 : null,
      reached: null
    }]);
  }

  function buyPlanStorePayload(state) {
    return { schema: BUY_PLAN_SCHEMA, version: 1, plans: (state && state.buyPlans) || {} };
  }

  function normalizeBuyPlans(payload) {
    if (!payload || payload.schema !== BUY_PLAN_SCHEMA || !payload.plans || typeof payload.plans !== "object") return {};
    var out = {};
    Object.keys(payload.plans).forEach(function (key) {
      if (!/^[A-Za-z0-9:_.-]{1,64}$/.test(key)) return;
      var plan = payload.plans[key];
      if (!plan || typeof plan !== "object") return;
      var merged = defaultBuyPlan(key);
      if (typeof plan.total_budget === "number" && plan.total_budget >= 0) merged.total_budget = plan.total_budget;
      if (typeof plan.max_position_pct === "number" && plan.max_position_pct >= 0 && plan.max_position_pct <= 100) {
        merged.max_position_pct = plan.max_position_pct;
      }
      if (plan.allocations && typeof plan.allocations === "object") {
        ALLOCATION_KEYS.forEach(function (name) {
          var value = plan.allocations[name];
          if (typeof value === "number" && value >= 0 && value <= 100) merged.allocations[name] = value;
        });
      }
      out[key] = merged;
    });
    return out;
  }


  var THESIS_FIELDS = Object.freeze([
    ["summary", "投資摘要"],
    ["growth_driver", "成長驅動"],
    ["moat", "競爭優勢"],
    ["industry_position", "產業位置"],
    ["risk", "風險"],
    ["invalidation", "Thesis 失效條件"]
  ]);
  var REVIEW_SCHEMA = "tqr-reviews/v1";
  var REVIEW_QUESTIONS = Object.freeze([
    ["revenue", "營收是否符合預期？"],
    ["eps", "EPS 是否符合預期？"],
    ["margin", "毛利率是否改變？"],
    ["outlook", "公司展望是否改變？"],
    ["thesis", "原始投資假設是否仍成立？"]
  ]);
  var REVIEW_ANSWERS = Object.freeze(["符合", "偏離", "待確認"]);
  var REVIEW_OUTCOMES = Object.freeze(["維持估值", "上調合理價值", "下調合理價值", "暫停買進", "投資假設失效"]);

  function defaultThesis() {
    var out = { last_checked: "" };
    THESIS_FIELDS.forEach(function (pair) { out[pair[0]] = ""; });
    return out;
  }

  function thesisFor(state, instrumentId) {
    var store = state && state.theses ? state.theses : {};
    return Object.assign(defaultThesis(), store[instrumentId] || {});
  }

  function reviewsFor(state, instrumentId) {
    var store = state && state.reviews ? state.reviews : {};
    var list = store[instrumentId];
    return Array.isArray(list) ? list : [];
  }

  function reviewFormIssues(draft) {
    var data = draft || {};
    var issues = [];
    REVIEW_QUESTIONS.forEach(function (pair) {
      if (REVIEW_ANSWERS.indexOf(data[pair[0]]) < 0) issues.push(issue(pair[0], pair[1] + "尚未回答"));
    });
    if (REVIEW_OUTCOMES.indexOf(data.outcome) < 0) issues.push(issue("outcome", "尚未選擇審查結果"));
    if (!String(data.review_date || "").trim()) issues.push(issue("review_date", "需記錄審查日期"));
    return issues;
  }

  function normalizeReviewStore(payload) {
    if (!payload || payload.schema !== REVIEW_SCHEMA || !payload.reviews || typeof payload.reviews !== "object") return {};
    var out = {};
    Object.keys(payload.reviews).forEach(function (key) {
      if (!/^[A-Za-z0-9:_.-]{1,64}$/.test(key)) return;
      var list = payload.reviews[key];
      if (!Array.isArray(list)) return;
      out[key] = list.filter(function (entry) {
        return entry && typeof entry === "object" && REVIEW_OUTCOMES.indexOf(entry.outcome) >= 0 &&
          typeof entry.review_date === "string" && entry.review_date;
      }).map(function (entry) { return clone(entry); }).slice(0, 50);
    });
    return out;
  }

  function reviewStorePayload(state) {
    return { schema: REVIEW_SCHEMA, version: 1, reviews: (state && state.reviews) || {} };
  }

  function thesisStorePayload(state) {
    return { schema: "tqr-theses/v1", version: 1, theses: (state && state.theses) || {} };
  }

  function normalizeThesisStore(payload) {
    if (!payload || payload.schema !== "tqr-theses/v1" || !payload.theses || typeof payload.theses !== "object") return {};
    var out = {};
    Object.keys(payload.theses).forEach(function (key) {
      if (!/^[A-Za-z0-9:_.-]{1,64}$/.test(key)) return;
      var entry = payload.theses[key];
      if (!entry || typeof entry !== "object") return;
      var merged = defaultThesis();
      THESIS_FIELDS.forEach(function (pair) {
        if (typeof entry[pair[0]] === "string") merged[pair[0]] = entry[pair[0]].slice(0, 2000);
      });
      if (typeof entry.last_checked === "string") merged.last_checked = entry.last_checked.slice(0, 40);
      out[key] = merged;
    });
    return out;
  }

  return Object.freeze({
    SECTIONS: SECTIONS,
    PRIMARY_SECTION_IDS: PRIMARY_SECTION_IDS,
    COMPANY_RESEARCH_SCHEMA: COMPANY_RESEARCH_SCHEMA,
    INDUSTRY_OPTIONS: INDUSTRY_OPTIONS,
    FUNDAMENTAL_STATES: FUNDAMENTAL_STATES,
    THESIS_STATES: THESIS_STATES,
    POSITION_STATES: POSITION_STATES,
    defaultCompanyRecord: defaultCompanyRecord,
    companyRecord: companyRecord,
    companyFieldAccepts: companyFieldAccepts,
    normalizeCompanyResearch: normalizeCompanyResearch,
    companyResearchPayload: companyResearchPayload,
    watchlistViewRows: watchlistViewRows,
    filterWatchlistRows: filterWatchlistRows,
    sortWatchlistRows: sortWatchlistRows,
    BUY_PLAN_SCHEMA: BUY_PLAN_SCHEMA,
    ALLOCATION_KEYS: ALLOCATION_KEYS,
    defaultBuyPlan: defaultBuyPlan,
    buyPlan: buyPlan,
    buyPlanFormIssues: buyPlanFormIssues,
    buyPlanTranches: buyPlanTranches,
    buyPlanStorePayload: buyPlanStorePayload,
    normalizeBuyPlans: normalizeBuyPlans,
    THESIS_FIELDS: THESIS_FIELDS,
    REVIEW_QUESTIONS: REVIEW_QUESTIONS,
    REVIEW_ANSWERS: REVIEW_ANSWERS,
    REVIEW_OUTCOMES: REVIEW_OUTCOMES,
    defaultThesis: defaultThesis,
    thesisFor: thesisFor,
    reviewsFor: reviewsFor,
    reviewFormIssues: reviewFormIssues,
    reviewStorePayload: reviewStorePayload,
    normalizeReviewStore: normalizeReviewStore,
    thesisStorePayload: thesisStorePayload,
    normalizeThesisStore: normalizeThesisStore,
    DEFAULT_BUY_ZONE_RATIOS: DEFAULT_BUY_ZONE_RATIOS,
    buyZonePrices: buyZonePrices,
    stageForPrice: stageForPrice,
    STAGE_LABELS: STAGE_LABELS,
    opportunityRows: opportunityRows,
    buyStageSummary: buyStageSummary,
    buyPlanStatusRows: buyPlanStatusRows,
    ALERT_STORE_SCHEMA: ALERT_STORE_SCHEMA,
    VALUATION_STORE_SCHEMA: VALUATION_STORE_SCHEMA,
    VALUATION_WORKSHEET_SCHEMA: VALUATION_WORKSHEET_SCHEMA,
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
