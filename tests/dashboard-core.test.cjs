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
  features: [],
  backtest: { status: "empty" },
  quality: { status_counts: { admitted: 1, unadmitted: 0, invalid: 0 } },
};

let state = core.createInitialState(view);
assert.equal(state.activeSection, "overview");
assert.equal(state.dialogOpen, false);
assert.deepEqual(state.valuationInputs, { eps: "", peLow: "", peHigh: "", safetyMargin: "" });
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
assert.equal(state.valuationInputs.eps, "10.00");
assert.equal(state.valuationInputs.peLow, "");
assert.deepEqual(state.notes, []);
state = core.reduce(state, { type: "SET_NOTE_DRAFT", field: "title", value: "2330 研究觀察" });
state = core.reduce(state, { type: "SET_NOTE_DRAFT", field: "body", value: "等待下一次財報核對" });
state = core.reduce(state, { type: "ADD_NOTE", note: { id: "note-1", instrument_id: "TWSE:2330", title: state.noteDraft.title, body: state.noteDraft.body } });
assert.equal(state.notes[0].title, "2330 研究觀察");
assert.deepEqual(state.noteDraft, { title: "", body: "", tags: "" });
state = core.reduce(state, { type: "DELETE_NOTE", noteId: "note-1" });
assert.deepEqual(state.notes, []);
state = core.reduce(state, { type: "SELECT_SECTION", section: "products" });
assert.equal(state.activeSection, "products");
state = core.reduce(state, { type: "OPEN_PRODUCT_DETAIL", index: 0 });
assert.equal(state.dialogOpen, true);
assert.equal(core.selectedProduct(state).instrument.security_id, "2330");
state = core.reduce(state, { type: "CLOSE_DIALOG" });
assert.equal(state.dialogOpen, false);
state = core.reduce(state, { type: "OPEN_PRODUCT_DETAIL", index: 99 });
assert.equal(state.dialogOpen, false);
state = core.reduce(state, { type: "SELECT_SECTION", section: "orders" });
assert.equal(state.activeSection, "products");
state = core.reduce(state, { type: "RESET" });
assert.equal(state.activeSection, "overview");
assert.equal(state.view.read_only, true);
assert.deepEqual(state.valuationInputs, { eps: "", peLow: "", peHigh: "", safetyMargin: "" });
assert.deepEqual(state.watchlist.items, ["TWSE:2330", "TAIFEX:TX:202608", "TPEx:006201"]);

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
assert.deepEqual(core.alertStorePayload(state), { schema: "tqe-in-app-alerts/v1", version: 1, alerts: [] });
const untilAlert = Object.assign({}, alertDef, { alert_id: "alert-test-2", expiry: { policy: "until", until: "2026-12-31T00:00:00Z" } });
state = core.reduce(state, { type: "ADD_ALERT", alert: untilAlert });
assert.deepEqual(core.alertStorePayload(state).alerts.map((alert) => alert.alert_id), ["alert-test-2"]);
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

console.log(JSON.stringify({ status: "pass", checks: ["navigation", "detail-dialog", "close-dialog", "valuation-inputs", "watchlist-payload", "personal-notes", "invalid-index-fail-closed", "reset", "in-app-alerts"] }));
