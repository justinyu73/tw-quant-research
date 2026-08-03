const assert = require("node:assert/strict");
const core = require("../ui/dashboard/dashboard-core.js");

const view = {
  schema: "tw-quant-engine-read-only-product-view/v1",
  read_only: true,
  as_of: "2026-01-07T23:59:59Z",
  products: [
    {
      record_type: "price_bar",
      instrument: { security_id: "2330", market: "TWSE" },
      quality: { admission_status: "admitted", reason_codes: [] },
      bar: { trading_date: "2026-01-05", close_raw: 110 },
    },
  ],
  quality: { status_counts: { admitted: 1, unadmitted: 0, invalid: 0 } },
};

let state = core.createInitialState(view);
assert.equal(state.activeSection, "home");
assert.equal(state.dialogOpen, false);
assert.deepEqual(state.watchlist, { items: [], status: "idle", dirty: false, message: "" });
assert.deepEqual(state.dataUpdate, { scope: "watchlist", years: 1, status: "idle", message: "", results: [] });
state = core.reduce(state, { type: "SET_DATA_UPDATE_SCOPE", scope: "selected" });
assert.equal(state.dataUpdate.scope, "selected");
state = core.reduce(state, { type: "SET_DATA_UPDATE_SCOPE", scope: "watchlist" });
assert.equal(state.dataUpdate.scope, "watchlist");
state = core.reduce(state, { type: "SET_DATA_UPDATE_YEARS", years: "3" });
assert.equal(state.dataUpdate.years, 3);
state = core.reduce(state, { type: "DATA_UPDATE_START" });
assert.equal(state.dataUpdate.status, "loading");
state = core.reduce(state, { type: "DATA_UPDATE_SUCCESS", status: "success", message: "本機資料已更新", results: [{ instrument_id: "TWSE:2330", status: "success" }] });
assert.equal(state.dataUpdate.message, "本機資料已更新");
assert.equal(state.dataUpdate.results[0].status, "success");
state = core.reduce(state, { type: "SET_WATCHLIST", items: ["TWSE:2330", "TAIFEX:TX:202608", "TWSE:2330", "bad id"] });
assert.deepEqual(state.watchlist.items, ["TWSE:2330", "TAIFEX:TX:202608"]);
state = core.reduce(state, { type: "CREATE_WATCHLIST_GROUP", name: "半導體" });
assert.notEqual(state.activeWatchlistGroupId, "default");
const customGroupId = state.activeWatchlistGroupId;
state = core.reduce(state, { type: "ADD_TO_WATCHLIST_GROUP", instrumentId: "TWSE:2330" });
assert.deepEqual(core.watchlistItemsForActiveGroup(state), ["TWSE:2330"]);
state = core.reduce(state, { type: "DELETE_WATCHLIST_GROUP", groupId: customGroupId });
assert.equal(state.activeWatchlistGroupId, "default");
assert.equal(state.watchlistGroups.some((group) => group.id === customGroupId), false);
const stateAfterDefaultDelete = core.reduce(state, { type: "DELETE_WATCHLIST_GROUP", groupId: "default" });
assert.deepEqual(stateAfterDefaultDelete.watchlistGroups, state.watchlistGroups);
assert.deepEqual(core.screenProducts(view, { quality: "admitted", market: "TWSE", max_rows: 20 }).map((row) => row.instrument.security_id), ["2330"]);
state = core.reduce(state, { type: "SELECT_WATCHLIST_GROUP", groupId: "default" });
state = core.reduce(state, { type: "TOGGLE_WATCHLIST", instrumentId: "TPEx:006201" });
assert.equal(state.watchlist.dirty, true);
assert.equal(state.watchlist.items.includes("TPEx:006201"), true);
assert.deepEqual(core.watchlistPayload(state), {
  schema: "tw-quant-engine-watchlist/v1",
  version: 1,
  items: ["TWSE:2330", "TAIFEX:TX:202608", "TPEx:006201"]
});
state = core.reduce(state, { type: "WATCHLIST_SAVED" });
assert.equal(state.watchlist.dirty, false);
state = core.reduce(state, { type: "SET_VALUATION_INPUT", field: "eps", value: "10.00" });
assert.deepEqual(state.notes, []);
state = core.reduce(state, { type: "SET_NOTE_DRAFT", field: "title", value: "2330 研究觀察" });
state = core.reduce(state, { type: "SET_NOTE_DRAFT", field: "body", value: "等待下一次財報核對" });
state = core.reduce(state, { type: "ADD_NOTE", note: { id: "note-1", instrument_id: "TWSE:2330", title: state.noteDraft.title, body: state.noteDraft.body } });
assert.equal(state.notes[0].title, "2330 研究觀察");
assert.deepEqual(state.noteDraft, { title: "", body: "", tags: "" });
state = core.reduce(state, { type: "DELETE_NOTE", noteId: "note-1" });
assert.deepEqual(state.notes, []);
state = core.reduce(state, { type: "SELECT_SECTION", section: "watchlist" });
assert.equal(state.activeSection, "watchlist");
state = core.reduce(state, { type: "OPEN_PRODUCT_DETAIL", index: 0 });
assert.equal(state.dialogOpen, true);
assert.equal(core.selectedProduct(state).instrument.security_id, "2330");
state = core.reduce(state, { type: "CLOSE_DIALOG" });
assert.equal(state.dialogOpen, false);
state = core.reduce(state, { type: "OPEN_PRODUCT_DETAIL", index: 99 });
assert.equal(state.dialogOpen, false);
state = core.reduce(state, { type: "SELECT_SECTION", section: "orders" });
assert.equal(state.activeSection, "watchlist");
state = core.reduce(state, { type: "RESET" });
assert.equal(state.activeSection, "home");
assert.equal(state.view.read_only, true);
assert.deepEqual(state.watchlist.items, ["TWSE:2330", "TAIFEX:TX:202608", "TPEx:006201"]);

const pickerView = {
  kline: {
    default_instrument_id: "TWSE:2330",
    default_period: "1D",
    instruments: [
      { instrument_id: "TWSE:2330", market: "TWSE", symbol: "2330", display_name: "台積電", periods: ["1D"] }
    ],
    models: []
  }
};
let pickerState = core.createInitialState(pickerView);
pickerState = core.reduce(pickerState, { type: "SELECT_SECTION", section: "watchlist" });
pickerState = core.reduce(pickerState, { type: "SELECT_KLINE_INSTRUMENT", instrumentId: "TWSE:2330" });
assert.equal(pickerState.activeSection, "watchlist");
pickerState = core.reduce(pickerState, { type: "SELECT_KLINE_INSTRUMENT", instrumentId: "TPEx:5289" });
assert.equal(pickerState.activeSection, "watchlist");
assert.equal(pickerState.selectedKlineInstrumentId, "TPEx:5289");
pickerState = core.reduce(pickerState, { type: "SELECT_SECTION", section: "home" });
pickerState = core.reduce(pickerState, { type: "SELECT_KLINE_INSTRUMENT", instrumentId: "TWSE:2330" });
assert.equal(pickerState.activeSection, "company");

// P6 in-app alerts: session-local definitions, flat store payload, in-app events only
const alertDef = {
  schema: "tqe-in-app-alert/v1",
  alert_id: "alert-test-1",
  label: "2330 收盤門檻",
  enabled: true,
  target: { security_id: "2330" },
  condition: { type: "price_threshold", field: "close", op: ">=", value: 100 },
  dedup: { policy: "once_per_session" },
  expiry: { policy: "session" },
  created_at: "2026-07-22T00:00:00Z"
};
state = core.reduce(state, { type: "ADD_ALERT", alert: alertDef });
assert.equal(state.alerts.definitions.length, 1);
state = core.reduce(state, { type: "ADD_ALERT", alert: alertDef });
assert.equal(state.alerts.definitions.length, 1);
// Session-expiry definitions persist within the session so a reload (F5) keeps them...
assert.deepEqual(core.alertStorePayload(state), { schema: "tqe-in-app-alerts/v1", version: 1, alerts: [alertDef] });
// ...and a new session drops them at load time.
assert.deepEqual(core.dropSessionAlertDefinitions(core.alertStorePayload(state).alerts), []);
const untilAlert = Object.assign({}, alertDef, { alert_id: "alert-test-2", expiry: { policy: "until", until: "2026-12-31T00:00:00Z" } });
state = core.reduce(state, { type: "ADD_ALERT", alert: untilAlert });
assert.deepEqual(core.alertStorePayload(state).alerts.map((alert) => alert.alert_id), ["alert-test-1", "alert-test-2"]);
assert.deepEqual(core.dropSessionAlertDefinitions(core.alertStorePayload(state).alerts).map((alert) => alert.alert_id), ["alert-test-2"]);
const firedEvent = { schema: "tqe-in-app-alert-event/v1", alert_id: "alert-test-1", label: "2330 收盤門檻", security_id: "2330", condition_type: "price_threshold", observed_value: 101, op: ">=", threshold: 100, fired_at: "2026-07-22T01:00:00Z", channel: "in_app", research_only: true };
state = core.reduce(state, { type: "ALERTS_EVALUATED", fired: [firedEvent, firedEvent], sessionState: { "alert-test-1": { fired_count: 1, last_fired_at: "2026-07-22T01:00:00Z" } } });
assert.equal(state.alerts.events.length, 1);
assert.equal(state.alerts.events[0].channel, "in_app");
assert.equal(state.alertSessionState["alert-test-1"].fired_count, 1);
const externalEvent = Object.assign({}, firedEvent, { alert_id: "alert-test-2", channel: "webhook", fired_at: "2026-07-22T02:00:00Z" });
state = core.reduce(state, { type: "ALERTS_EVALUATED", fired: [externalEvent], sessionState: state.alertSessionState });
assert.equal(state.alerts.events.length, 1);
state = core.reduce(state, { type: "DELETE_ALERT", alertId: "alert-test-2" });
assert.deepEqual(state.alerts.definitions.map((alert) => alert.alert_id), ["alert-test-1"]);
state = core.reduce(state, { type: "CLEAR_ALERT_EVENTS" });
assert.deepEqual(state.alerts.events, []);
assert.deepEqual(state.alertSessionState, {});
state = core.reduce(state, { type: "SET_ALERTS", definitions: [alertDef, { alert_id: "bad" }] });
assert.equal(state.alerts.definitions.length, 1);

// P6 valuation & analysis: session-local worksheets, flat store payload, research-only results
const worksheetDef = {
  schema: "tqr-scenario-valuation-worksheet/v1",
  worksheet_id: "ws-test-1",
  label: "2330 三情境合理價",
  target: { security_id: "2330" },
  scenarios: { bear: { eps: 8, pe: 12 }, base: { eps: 10, pe: 15 }, bull: { eps: 12, pe: 18 } },
  buy_zone_ratios: { watch: 0.9, first: 0.85, second: 0.8, sweet: 0.75, extreme: 0.65 },
  basis: {
    eps_period: "2026Q1",
    eps_kind: "estimate",
    pe_rationale: "近五年區間中位",
    financial_data_date: "2026-05-15",
    valuation_date: "2026-07-22",
    change_reason: ""
  },
  created_at: "2026-07-22T00:00:00Z"
};
assert.deepEqual(state.valuation, { worksheets: [], results: [], indicators: [], status: "idle", message: "" });
assert.deepEqual(state.valuationIndicatorPeriods, { zscore: 20, price_percentile: 60, ma_deviation: 20 });
state = core.reduce(state, { type: "ADD_VALUATION_WORKSHEET", worksheet: worksheetDef });
assert.equal(state.valuation.worksheets.length, 1);
assert.equal(state.valuation.status, "ready");
state = core.reduce(state, { type: "ADD_VALUATION_WORKSHEET", worksheet: worksheetDef });
assert.equal(state.valuation.worksheets.length, 1);
assert.deepEqual(core.valuationStorePayload(state), { schema: "tqr-scenario-valuation-worksheets/v1", version: 1, worksheets: [worksheetDef] });
const badWorksheet = Object.assign({}, worksheetDef, { worksheet_id: "ws-bad", scenarios: { bear: { eps: 8, pe: 12 }, base: { eps: 0, pe: 15 }, bull: { eps: 12, pe: 18 } } });
state = core.reduce(state, { type: "ADD_VALUATION_WORKSHEET", worksheet: badWorksheet });
assert.equal(state.valuation.worksheets.length, 1);
const valuationResult = {
  worksheet_id: "ws-test-1",
  label: "2330 三情境合理價",
  security_id: "2330",
  scenario_values: { bear: 96, base: 150, bull: 216 },
  base_value: 150,
  buy_zone: { watch: 135, first: 127.5, second: 120, sweet: 112.5, extreme: 97.5 },
  buy_zone_ratios: worksheetDef.buy_zone_ratios,
  scenarios: worksheetDef.scenarios,
  basis: worksheetDef.basis,
  formula_version: "tqr-scenario-valuation/v1",
  assumption_source: "user_supplied_assumption",
  data_status: "draft",
  research_only: true,
  status: "ok",
  current_price: 100,
  price_as_of: "2026-07-21",
  price_basis: "close",
  stage: "sweet",
  comparison: { vs_base_value: "below", discount_pct: -1 / 3, gap_to_first_pct: -0.2156862745098039, gap_to_sweet_pct: -1 / 9, research_comparison_only: true }
};
const zscoreResult = { schema: "tqe-price-volume-indicator/v1", type: "zscore", period: 20, price_basis: "close", std_convention: "population", research_only: true, status: "ok", value: 1.41, security_id: "2330" };
state = core.reduce(state, { type: "VALUATION_EVALUATED", results: [valuationResult, { worksheet_id: "ws-foreign", formula_version: "v0" }], indicators: [zscoreResult, { type: "rsi" }] });
assert.equal(state.valuation.results.length, 1);
assert.equal(state.valuation.results[0].formula_version, "tqr-scenario-valuation/v1");
assert.equal(state.valuation.results[0].stage, "sweet");
assert.equal(state.valuation.results[0].comparison.research_comparison_only, true);
assert.equal(state.valuation.indicators.length, 1);
assert.equal(state.valuation.indicators[0].std_convention, "population");
state = core.reduce(state, { type: "SET_VALUATION_INDICATOR_PERIOD", indicator: "zscore", period: "60" });
assert.equal(state.valuationIndicatorPeriods.zscore, 60);
state = core.reduce(state, { type: "SET_VALUATION_INDICATOR_PERIOD", indicator: "zscore", period: "0" });
assert.equal(state.valuationIndicatorPeriods.zscore, 60);
state = core.reduce(state, { type: "VALUATION_ERROR", message: "工作表參數不完整" });
assert.equal(state.valuation.status, "error");
state = core.reduce(state, { type: "DELETE_VALUATION_WORKSHEET", worksheetId: "ws-test-1" });
assert.equal(state.valuation.worksheets.length, 0);
assert.equal(state.valuation.results.length, 0);
state = core.reduce(state, { type: "SET_VALUATION_WORKSHEETS", worksheets: [worksheetDef, { worksheet_id: "bad" }] });
assert.equal(state.valuation.worksheets.length, 1);
state = core.reduce(state, { type: "RESET" });
assert.equal(state.valuation.worksheets.length, 1);
assert.equal(state.valuation.results.length, 0);

// TQR-FORM-FEEDBACK: field-level form issue helpers mirror the engine validators
const validAlertDraft = { label: "2330 收盤門檻", conditionType: "price_threshold", indicator: "ma", op: ">=", value: "100", dedupPolicy: "once_per_session", cooldownSeconds: "3600", expiryPolicy: "session", until: "" };
assert.deepEqual(core.alertFormIssues(validAlertDraft, { symbol: "2330" }), []);
assert.deepEqual(core.alertFormIssues(validAlertDraft, { symbol: "" }).map((item) => item.field), ["target"]);
assert.equal(core.alertFormIssues(Object.assign({}, validAlertDraft, { label: "  " }), { symbol: "2330" })[0].message, "名稱不可空白（120 字以內）");
assert.equal(core.alertFormIssues(Object.assign({}, validAlertDraft, { value: "" }), { symbol: "2330" })[0].field, "value");
assert.match(core.alertFormIssues(Object.assign({}, validAlertDraft, { value: "abc" }), { symbol: "2330" })[0].message, /門檻值需為數字/);
for (const badSeconds of ["", "0", "-5", "1.5", "abc"]) {
  const cooldownIssues = core.alertFormIssues(Object.assign({}, validAlertDraft, { dedupPolicy: "cooldown_seconds", cooldownSeconds: badSeconds }), { symbol: "2330" });
  assert.equal(cooldownIssues.length, 1);
  assert.equal(cooldownIssues[0].field, "cooldownSeconds");
  assert.match(cooldownIssues[0].message, /冷卻秒數需為大於 0 的整數/);
}
assert.deepEqual(core.alertFormIssues(Object.assign({}, validAlertDraft, { dedupPolicy: "cooldown_seconds", cooldownSeconds: "60" }), { symbol: "2330" }), []);
assert.equal(core.alertFormIssues(Object.assign({}, validAlertDraft, { expiryPolicy: "until", until: "" }), { symbol: "2330" })[0].field, "until");
assert.equal(core.alertFormIssues(Object.assign({}, validAlertDraft, { expiryPolicy: "until", until: "not-a-date" }), { symbol: "2330" })[0].field, "until");
assert.deepEqual(core.alertFormIssues(Object.assign({}, validAlertDraft, { expiryPolicy: "until", until: "2026-12-31T00:00" }), { symbol: "2330" }), []);

const scenarioDraft = {
  label: "2330 三情境合理價",
  bearEps: "8", bearPe: "12", baseEps: "10", basePe: "15", bullEps: "12", bullPe: "18",
  ratioWatch: "90", ratioFirst: "85", ratioSecond: "80", ratioSweet: "75", ratioExtreme: "65",
  epsPeriod: "2026Q1", epsKind: "estimate", peRationale: "近五年區間中位",
  financialDataDate: "2026-05-15", valuationDate: "2026-07-22", changeReason: ""
};
assert.deepEqual(core.valuationFormIssues(scenarioDraft, { symbol: "2330" }), []);
assert.deepEqual(core.valuationFormIssues(scenarioDraft, { symbol: "" }).map((item) => item.field), ["target"]);
assert.equal(core.valuationFormIssues(Object.assign({}, scenarioDraft, { label: "" }), { symbol: "2330" })[0].message, "工作表名稱不可空白（120 字以內）");
assert.match(core.valuationFormIssues(Object.assign({}, scenarioDraft, { baseEps: "0" }), { symbol: "2330" })[0].message, /Base EPS 需為大於 0/);
assert.match(core.valuationFormIssues(Object.assign({}, scenarioDraft, { bullPe: "-3" }), { symbol: "2330" })[0].message, /Bull 合理本益比需為大於 0/);
// The ladder must stay monotonic: a sweet price above the first-stage price is
// not a valuation, it is a data-entry error.
assert.match(core.valuationFormIssues(Object.assign({}, scenarioDraft, { ratioSweet: "95" }), { symbol: "2330" }).map((i) => i.message).join(), /遞減/);
assert.match(core.valuationFormIssues(Object.assign({}, scenarioDraft, { epsPeriod: "" }), { symbol: "2330" })[0].message, /哪一期 EPS/);
assert.match(core.valuationFormIssues(Object.assign({}, scenarioDraft, { epsKind: "guess" }), { symbol: "2330" })[0].message, /實際值或預估值/);
assert.match(core.valuationFormIssues(Object.assign({}, scenarioDraft, { valuationDate: "" }), { symbol: "2330" })[0].message, /估值日期/);

assert.match(core.watchlistGroupNameIssues("")[0].message, /群組名稱不可空白/);
assert.match(core.watchlistGroupNameIssues("   ")[0].message, /群組名稱不可空白/);
assert.deepEqual(core.watchlistGroupNameIssues("半導體"), []);
assert.match(core.watchlistAddIssues({ query: "", selected: null, items: [] })[0].message, /請先輸入代號或名稱/);
assert.match(core.watchlistAddIssues({ query: "9999", selected: null, items: [] })[0].message, /找不到完全相符的商品/);
assert.match(core.watchlistAddIssues({ query: "2330", selected: { instrument_id: "TWSE:2330" }, items: ["TWSE:2330"] })[0].message, /此商品已在目前群組/);
assert.deepEqual(core.watchlistAddIssues({ query: "2330", selected: { instrument_id: "TWSE:2330" }, items: [] }), []);

console.log(JSON.stringify({ status: "pass", checks: ["navigation", "detail-dialog", "close-dialog", "valuation-inputs", "watchlist-payload", "personal-notes", "invalid-index-fail-closed", "reset", "in-app-alerts", "valuation-analysis", "form-issues"] }));
