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
state = core.reduce(state, { type: "SET_WATCHLIST", items: ["TWSE:2330", "TAIFEX:TX:202608", "TWSE:2330", "bad id"] });
assert.deepEqual(state.watchlist.items, ["TWSE:2330", "TAIFEX:TX:202608"]);
state = core.reduce(state, { type: "CREATE_WATCHLIST_GROUP", name: "半導體" });
assert.notEqual(state.activeWatchlistGroupId, "default");
state = core.reduce(state, { type: "ADD_TO_WATCHLIST_GROUP", instrumentId: "TWSE:2330" });
assert.deepEqual(core.watchlistItemsForActiveGroup(state), ["TWSE:2330"]);
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

console.log(JSON.stringify({ status: "pass", checks: ["navigation", "detail-dialog", "close-dialog", "valuation-inputs", "watchlist-payload", "invalid-index-fail-closed", "reset"] }));
