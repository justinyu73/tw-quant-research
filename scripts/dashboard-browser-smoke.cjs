const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PREVIEW_DIR = path.join(ROOT, "outputs", "dashboard-preview");
const SCREENSHOT_DIR = path.join(ROOT, "outputs", "dashboard-browser");
const EXPECTED_SCREENSHOTS = {
  home: "07c16dbb6b1411fd529f410541c83b4d1069476262758722125f79eae4edcbbb",
  company: "5802050e62c15d11a4bd82e674897997adef79eb335fa23d3021e687707a8291",
  watchlist: "09d0c02d6f94a1cf45c49a8da468b93ec8cea67fe1c1ace9fb7957a6839f1804",
  buyplan: "5efc6f4a62054c4f3bdf933a31541cf070f7d624687639f3755300e569141a54",
  review: "cdc1dfeb3b714540946638615b2b0c48703439fcdd4d74f02b63d5a2e26461e8",
  valuation: "77005bb848f3da2559480e1508b1a3cab5d0405af2fc3f6829cbda7e8ed70439",
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForSidecar(baseUrl) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/instruments`);
      if (response.ok) return response.json();
    } catch (error) {
      // The catalog is built before the server starts accepting requests.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`sidecar did not become ready: ${baseUrl}`);
}

function assertOk(condition, message) {
  assert.equal(Boolean(condition), true, message);
}

function findChromium(playwright) {
  const candidates = [];
  if (playwright && playwright.chromium) candidates.push(playwright.chromium.executablePath());
  if (process.env.CHROMIUM_EXECUTABLE_PATH) candidates.push(process.env.CHROMIUM_EXECUTABLE_PATH);
  const cache = "/home/jy/.cache/ms-playwright";
  if (fs.existsSync(cache)) {
    for (const name of fs.readdirSync(cache).sort().reverse()) {
      if (!name.startsWith("chromium-")) continue;
      candidates.push(path.join(cache, name, "chrome-linux64", "chrome"));
      candidates.push(path.join(cache, name, "chrome-linux", "chrome"));
    }
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function mimeType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function startServer() {
  const server = http.createServer((request, response) => {
    const requested = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (requested === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const relative = requested === "/" ? "index.html" : decodeURIComponent(requested.slice(1));
    const file = path.resolve(PREVIEW_DIR, relative);
    if (!file.startsWith(`${path.resolve(PREVIEW_DIR)}${path.sep}`)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        response.writeHead(error.code === "ENOENT" ? 404 : 500);
        response.end(error.code === "ENOENT" ? "not found" : "server error");
        return;
      }
      response.writeHead(200, { "Content-Type": mimeType(file), "Cache-Control": "no-store" });
      response.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function screenshotHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Ensure fonts loaded and the canvas/DOM paint has flushed before a pixel capture,
// so screenshots are deterministic across runs (Lightweight Charts repaints on rAF).
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertNoOverlap(page, selectors, label) {
  const rectangles = await page.evaluate((items) => items.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) return { selector, missing: true };
    const box = element.getBoundingClientRect();
    return { selector, left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
  }), selectors);
  rectangles.forEach((box) => assert.equal(Boolean(box.missing), false, `${label}: ${box.selector} missing`));
  for (let left = 0; left < rectangles.length; left += 1) {
    for (let right = left + 1; right < rectangles.length; right += 1) {
      const a = rectangles[left];
      const b = rectangles[right];
      const overlaps = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      assert.equal(overlaps, false, `${label}: ${a.selector} overlaps ${b.selector}`);
    }
  }
}

async function main() {
  const sidecarPort = await freePort();
  const sidecarBaseUrl = `http://127.0.0.1:${sidecarPort}`;
  // Give the sidecar a data dir holding the committed fundamentals series, so
  // the smoke exercises the populated path as well as the empty one. Offline:
  // the series is a fixture, never a live capture.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tqr-smoke-"));
  fs.copyFileSync(
    path.join(ROOT, "tests/fixtures/tqr-fundamentals/series.fixture.json"),
    path.join(dataDir, "fundamentals-series.json"),
  );
  const sidecar = spawn("python3", ["scripts/tqe_sidecar.py", "--host", "127.0.0.1", "--port", String(sidecarPort), "--data-dir", dataDir], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.on("exit", () => sidecar.kill());
  await waitForSidecar(sidecarBaseUrl);
  const build = spawnSync("python3", ["scripts/build_dashboard_preview.py"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TQE_SIDECAR_URL: sidecarBaseUrl },
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const playwright = require("playwright-core");
  const executablePath = findChromium(playwright);
  assertOk(executablePath, "Chromium executable not found; set CHROMIUM_EXECUTABLE_PATH");
  const server = await startServer();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const browserErrors = [];
  const externalRequests = [];
  const browser = await playwright.chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  // Valuation date and thesis last-checked default to today, so an unpinned
  // clock would drift the pixel baselines every calendar day.
  await page.clock.setFixedTime(new Date("2026-07-22T04:00:00Z"));
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("request", (request) => {
    if (!request.url().startsWith(baseUrl) && !request.url().startsWith(sidecarBaseUrl)) externalRequests.push(request.url());
  });

  const screenshots = {};
  try {
    const response = await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
    assert.equal(response.status(), 200);
    assert.equal(await page.locator("#app .app-shell").count(), 1);
    assert.equal(await page.locator(".sidebar").count(), 1);
    assert.equal(await page.locator(".card").count() > 0, true);
    assert.equal(await page.locator(".read-only-pill").innerText(), "研究唯讀");

    // IA contract: exactly the six primary value-research sections, in order.
    assert.equal(await page.locator(".sidebar .nav-link").count(), 6);
    assert.deepEqual(
      await page.locator(".sidebar .nav-link .nav-text").allInnerTexts(),
      ["Home", "Watchlist", "Company", "Valuation", "Buy Plan", "Review"],
    );
    for (const removed of ["research", "backtest", "features", "products", "market", "fundamentals", "stories", "overview"]) {
      assert.equal(await page.locator(`.sidebar [data-section="${removed}"]`).count(), 0, `retired section still in nav: ${removed}`);
    }

    assert.equal(await page.locator(".page-title").innerText(), "Home");
    assert.equal(await page.locator('[data-testid="investment-summary"] article').count(), 5);
    assert.match(await page.locator('[data-testid="summary-tracked"]').innerText(), /追蹤標的/);
    assert.equal(await page.locator('[data-testid="opportunity-empty"]').count(), 1);
    assert.equal(await page.locator('[data-testid="buyplan-status-empty"]').count(), 1);
    assert.equal(await page.locator('[data-testid="fundamental-changes"]').count(), 1);
    assert.equal(await page.evaluate(() => typeof window.LightweightCharts), "object");
    await settle(page);
    screenshots.home = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "home.png"),
      fullPage: true,
      animations: "disabled",
    }));

    // Company: quote, thesis, fundamental snapshot, trend table, price reference.
    const globalSearch = page.locator('[data-testid="global-search"]');
    await globalSearch.fill("2330");
    await page.locator('[data-testid="global-search-results"] .symbol-search-result').filter({ hasText: "2330" }).first().click();
    assert.equal(await page.locator(".page-title").innerText(), "Company");
    await page.locator('[data-testid="kline-chart"]').waitFor();
    assert.equal(await page.locator('[data-testid="kline-period-label"]').innerText(), "1D");
    assert.equal(await page.locator('[data-testid="kline-chart"] canvas').count() > 0, true);
    assert.equal(await page.locator('[data-testid="kline-instrument"]').inputValue(), "TWSE:2330");
    assert.equal(await page.locator('[data-testid="quote-bar"] .terminal-quote-price strong').innerText(), "2,440");
    assert.equal(await page.locator('[data-testid="note-composer"]').count(), 1);
    assert.equal(await page.locator('[data-testid="thesis-form"]').count(), 1);
    for (const field of ["summary", "growth_driver", "moat", "industry_position", "risk", "invalidation"]) {
      assert.equal(await page.locator(`[data-testid="thesis-${field}"]`).count(), 1, `thesis field missing: ${field}`);
    }
    await page.locator('[data-testid="thesis-invalidation"]').fill("連續兩季營收年增轉負");
    await page.locator('[data-testid="thesis-check"]').click();
    assert.doesNotMatch(await page.locator('[data-testid="thesis-last-checked"]').innerText(), /尚未檢查/);
    // Fundamentals come from the locally accumulated series, with honest depth.
    await page.locator('[data-testid="fundamental-snapshot"]').waitFor();
    assert.equal(await page.locator('[data-testid="fundamental-eps"] strong').innerText(), "15.42");
    assert.equal(await page.locator('[data-testid="fundamental-gross-margin"] strong').innerText(), "60.00%");
    assert.equal(await page.locator('[data-testid="fundamental-revenue-yoy"] strong').innerText(), "47.62%");
    assert.match(await page.locator('[data-testid="fundamental-provenance"]').innerText(), /非公司公告時間/);
    assert.equal(await page.locator('[data-testid="trend-coverage-quarters"]').innerText(), "1 / 8");
    assert.equal(await page.locator('[data-testid="trend-coverage-months"]').innerText(), "2 / 12");
    assert.equal(await page.locator('[data-testid="trend-coverage-balance"]').innerText(), "1 / 8");
    // Balance-sheet ratios are derived, not read: 2,000,000 / 8,000,000 = 25%.
    assert.equal(await page.locator('[data-testid="fundamental-debt-ratio"] strong').innerText(), "25.00%");
    assert.equal(await page.locator('[data-testid="fundamental-current-ratio"] strong').innerText(), "3");
    assert.equal(await page.locator('[data-testid="fundamental-bvps"] strong').innerText(), "150");
    assert.equal(await page.locator('[data-testid="trend-balance-row"]').count(), 1);
    assert.equal(await page.locator('[data-testid="trend-quarter-row"]').count(), 1);
    // Only captured periods appear; the table must not pad to 12 rows.
    assert.equal(await page.locator('[data-testid="trend-month-row"]').count(), 2);
    assert.match(await page.locator('[data-testid="kline-coverage"]').innerText(), /360 \/ 交易日 360/);

    await page.locator('[data-testid="note-title"]').fill("2330 研究觀察");
    await page.locator('[data-testid="note-body"]').fill("價格與技術線先記錄，等待下一次財報核對。");
    await page.locator('[data-testid="note-submit"]').click();
    assert.equal(await page.locator('[data-testid="note-card"]').count(), 1);
    assert.match(await page.locator('[data-testid="note-card"]').innerText(), /2330 研究觀察/);

    // Company research status: the human's own judgement fields. These must
    // reach Watchlist columns, Watchlist filters, and the Home counters —
    // rendering them is not enough, they have to be writable and to propagate.
    await page.locator('[data-testid="company-status"]').waitFor();
    // Not tracked yet: the page must say the judgement will not surface anywhere,
    // instead of silently recording into a view the human never sees.
    assert.equal(await page.locator('[data-testid="company-tracking-missing"]').count(), 1);
    assert.equal(await page.locator('[data-testid="company-track-add"]').count(), 1);
    await page.locator('[data-testid="company-industry"]').selectOption("Memory");
    await page.locator('[data-testid="company-fundamental-state"]').selectOption("轉弱");
    await page.locator('[data-testid="company-thesis-state"]').selectOption("待確認");
    await page.locator('[data-testid="company-position-state"]').selectOption("持有");
    await page.locator('[data-testid="company-score"]').selectOption("4");
    await page.locator('[data-testid="company-next-event"]').fill("8 月營收公布");
    await page.locator('[data-testid="company-note"]').fill("等待下一次公告，確認毛利率與庫存。");
    assert.doesNotMatch(await page.locator('[data-testid="company-status-updated"]').innerText(), /尚未更新/);
    await settle(page);
    screenshots.company = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "company.png"),
      fullPage: true,
      animations: "disabled",
    }));

    // Watchlist: the primary work surface.
    await page.locator('[data-action="section"][data-section="watchlist"]').first().click();
    assert.equal(await page.locator(".page-title").innerText(), "Watchlist");
    await page.locator('[data-testid="watchlist-toolbar"]').waitFor();
    assert.equal(await page.locator('[data-testid="watchlist-empty"]').count(), 1);
    assert.equal(await page.locator('[data-testid="data-update-panel"]').count(), 1);
    assert.equal(await page.locator('[data-testid="data-update-scope"]').inputValue(), "watchlist");
    assert.equal(await page.locator('[data-testid="data-update-button"]').isDisabled(), true);
    assert.match(await page.locator('[data-testid="data-update-status"]').innerText(), /瀏覽器預覽不下載/);

    const watchlistPicker = page.locator('[data-testid="watchlist-picker"]');
    await watchlistPicker.click();
    assert.equal(await watchlistPicker.evaluate((element) => document.activeElement === element), true);
    await watchlistPicker.type("2330");
    await page.locator('[data-testid="watchlist-symbol-results"] .symbol-search-result').filter({ hasText: "2330" }).first().click();
    await page.locator('[data-testid="watchlist-add"]').click();
    await page.locator('[data-testid="watchlist-table"]').waitFor();
    assert.equal(await page.locator('[data-testid="watchlist-table"] tbody tr').count(), 1);
    assert.deepEqual(
      await page.locator('[data-testid="watchlist-table"] thead th').allInnerTexts(),
      ["代號", "公司／產業", "現價", "合理價值", "折／溢價", "第一買進價", "甜蜜價", "基本面", "投資假設", "下一事件", "買進階段", ""],
    );
    assert.equal(await page.locator('[data-testid="watchlist-filters"]').count(), 1);
    assert.equal(await page.locator('[data-testid="watchlist-sort"]').inputValue(), "discount");
    // No valuation yet: value-derived columns must be em dashes, never inferred.
    assert.equal(await page.locator('[data-testid="watchlist-base-value"]').first().innerText(), "—");
    assert.equal(await page.locator('[data-testid="watchlist-discount"]').first().innerText(), "—");
    await watchlistPicker.fill("2308");
    assert.equal(await page.locator('[data-testid="watchlist-add"]').isDisabled(), false);
    await page.locator('[data-testid="watchlist-add"]').click();
    assert.equal(await page.locator('[data-testid="watchlist-table"] tbody tr').count(), 2);
    await page.locator('[data-action="watchlist-remove"][data-instrument-id="TWSE:2308"]').click();
    assert.equal(await page.locator('[data-testid="watchlist-table"] tbody tr').count(), 1);
    await page.locator('[data-testid="watchlist-save"]').click();
    assert.match(await page.locator('[data-testid="watchlist-state"]').innerText(), /已儲存至瀏覽器預覽/);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('[data-action="section"][data-section="watchlist"]').first().click();
    await page.locator('[data-testid="watchlist-table"]').waitFor();
    assert.equal(await page.locator('[data-testid="watchlist-table"] tbody tr').count(), 1);

    // The judgement fields set on Company must appear on this row, not defaults.
    const firstRow = page.locator('[data-testid="watchlist-row"]').first();
    assert.match(await firstRow.innerText(), /Memory/);
    assert.match(await firstRow.innerText(), /轉弱/);
    assert.match(await firstRow.innerText(), /待確認/);
    assert.match(await firstRow.innerText(), /8 月營收公布/);

    // ...and they must actually drive the filters, not just render.
    await page.locator('[data-testid="watchlist-filter-thesis_state"]').selectOption("待確認");
    assert.equal(await page.locator('[data-testid="watchlist-row"]').count(), 1);
    await page.locator('[data-testid="watchlist-filter-thesis_state"]').selectOption("成立");
    assert.equal(await page.locator('[data-testid="watchlist-row"]').count(), 0);
    await page.locator('[data-testid="watchlist-filter-thesis_state"]').selectOption("");
    await page.locator('[data-testid="watchlist-filter-industry"]').selectOption("Power Infrastructure");
    assert.equal(await page.locator('[data-testid="watchlist-row"]').count(), 0);
    await page.locator('[data-testid="watchlist-filter-industry"]').selectOption("");
    assert.equal(await page.locator('[data-testid="watchlist-row"]').count(), 1);

    // ...and reach the Home summary, which was structurally stuck at 0 before.
    await page.locator('[data-action="section"][data-section="home"]').first().click();
    assert.equal(await page.locator('[data-testid="summary-pending"] strong').innerText(), "1");
    await page.locator('[data-action="section"][data-section="watchlist"]').first().click();
    await page.locator('[data-testid="watchlist-table"]').waitFor();

    await page.locator('[data-testid="watchlist-group-name"]').fill("半導體");
    await page.locator('[data-testid="watchlist-group-create"]').click();
    assert.notEqual(await page.locator('[data-testid="watchlist-group-select"]').inputValue(), "default");
    const watchlistGroupDelete = page.locator('[data-testid="watchlist-toolbar"] [data-testid="watchlist-group-delete"]');
    assert.equal(await watchlistGroupDelete.isDisabled(), false);
    page.once("dialog", (dialog) => dialog.accept());
    await watchlistGroupDelete.click();
    assert.equal(await page.locator('[data-testid="watchlist-group-select"]').inputValue(), "default");
    assert.equal(await watchlistGroupDelete.isDisabled(), true);
    await settle(page);
    screenshots.watchlist = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "watchlist.png"),
      fullPage: true,
      animations: "disabled",
    }));

    // Valuation is now its own page, not a card buried under the chart.
    await page.locator('[data-action="section"][data-section="valuation"]').first().click();
    assert.equal(await page.locator(".page-title").innerText(), "Valuation");
    await page.locator('[data-testid="valuation-panel"]').waitFor();
    assert.equal(await page.locator('[data-testid="valuation-empty"]').count(), 1);
    await page.locator('[data-testid="valuation-ws-label"]').fill("2330 三情境合理價");
    await page.locator('[data-testid="valuation-ws-bear-eps"]').fill("30");
    await page.locator('[data-testid="valuation-ws-bear-pe"]').fill("15");
    await page.locator('[data-testid="valuation-ws-base-eps"]').fill("40");
    await page.locator('[data-testid="valuation-ws-base-pe"]').fill("20");
    await page.locator('[data-testid="valuation-ws-bull-eps"]').fill("50");
    await page.locator('[data-testid="valuation-ws-bull-pe"]').fill("25");
    // The basis fields are required: a valuation with no recorded EPS period
    // must not be addable.
    assert.equal(await page.locator('[data-testid="valuation-add"]').isDisabled(), true);
    await page.locator('[data-testid="valuation-basis-period"]').fill("2026Q1");
    await page.locator('[data-testid="valuation-basis-rationale"]').fill("近五年本益比區間中位");
    assert.equal(await page.locator('[data-testid="valuation-add"]').isDisabled(), false);
    await page.locator('[data-testid="valuation-add"]').click();
    assert.equal(await page.locator('[data-testid="valuation-worksheet"]').count(), 1);
    await page.locator('[data-testid="valuation-evaluate"]').click();
    await page.locator('[data-testid="valuation-result-card"]').first().waitFor();
    assert.equal(await page.locator('[data-testid="valuation-base-value"]').first().innerText(), "800");
    // Buy ladder = Base x 85% / 75%, computed by the engine, not the browser.
    assert.equal(await page.locator('[data-testid="valuation-zone-first"]').first().innerText(), "680");
    assert.equal(await page.locator('[data-testid="valuation-zone-sweet"]').first().innerText(), "600");
    assert.equal(await page.locator('[data-testid="valuation-stage"]').first().innerText(), "觀察");
    // 2,440 against a base of 800 is a premium, on this page too.
    const valGap = await page.locator('[data-testid="valuation-discount"]').first().innerText();
    assert.match(valGap, /^溢價 /, `valuation premium rendered as: ${valGap}`);
    await settle(page);
    screenshots.valuation = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "valuation.png"),
      fullPage: true,
      animations: "disabled",
    }));

    // Valuation feeds Watchlist and Home: the discount ladder must appear only
    // once the human has supplied a fair value.
    await page.locator('[data-action="section"][data-section="watchlist"]').first().click();
    await page.locator('[data-testid="watchlist-table"]').waitFor();
    assert.equal(await page.locator('[data-testid="watchlist-base-value"]').first().innerText(), "800");
    assert.equal(await page.locator('[data-testid="watchlist-stage"]').first().innerText(), "觀察");
    // 2,440 against a base of 800 is a premium. It must never read as a discount.
    const wlGap = await page.locator('[data-testid="watchlist-discount"]').first().innerText();
    assert.match(wlGap, /^溢價 /, `premium rendered as: ${wlGap}`);
    assert.doesNotMatch(wlGap, /折價/);

    await page.locator('[data-action="section"][data-section="home"]').first().click();
    await page.locator('[data-testid="opportunity-list"]').waitFor();
    assert.equal(await page.locator('[data-testid="opportunity-row"]').count(), 1);
    assert.match(await page.locator('[data-testid="opportunity-discount"]').first().innerText(), /^溢價 /);
    assert.equal(await page.locator('[data-testid="buyplan-status"] li').count(), 1);

    // Buy Plan and Review are declared but not yet built; they must say so
    // rather than render a fake surface.
    await page.locator('[data-action="section"][data-section="buyplan"]').first().click();
    assert.equal(await page.locator(".page-title").innerText(), "Buy Plan");
    await page.locator('[data-testid="buyplan-form"]').waitFor();
    // Tranche prices come from the valuation ladder, not from the market price.
    assert.equal(await page.locator('[data-testid="buyplan-tranche"]').count(), 4);
    assert.equal(await page.locator('[data-tranche="first"] td').nth(1).innerText(), "680");
    assert.equal(await page.locator('[data-tranche="sweet"] td').nth(1).innerText(), "600");
    assert.equal(await page.locator('[data-testid="buyplan-prompt-idle"]').count(), 1);
    // Allocations must total 100% before the plan can be saved.
    await page.locator('[data-testid="buyplan-budget"]').fill("1000000");
    await page.locator('[data-testid="buyplan-alloc-reserve"]').fill("20");
    assert.equal(await page.locator('[data-testid="buyplan-save"]').isDisabled(), true);
    await page.locator('[data-testid="buyplan-alloc-reserve"]').fill("25");
    assert.equal(await page.locator('[data-testid="buyplan-save"]').isDisabled(), false);
    await page.locator('[data-testid="buyplan-save"]').click();
    assert.equal(await page.locator('[data-tranche="first"] td').nth(3).innerText(), "200,000");
    assert.equal(await page.locator('[data-tranche="sweet"] td').nth(3).innerText(), "300,000");
    await settle(page);
    screenshots.buyplan = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "buyplan.png"),
      fullPage: true,
      animations: "disabled",
    }));
    await page.locator('[data-action="section"][data-section="review"]').first().click();
    assert.equal(await page.locator(".page-title").innerText(), "Review");
    await page.locator('[data-testid="review-form"]').waitFor();
    assert.equal(await page.locator('[data-testid="review-history-empty"]').count(), 1);
    // Every question must be answered before a review can be recorded.
    assert.equal(await page.locator('[data-testid="review-save"]').isDisabled(), true);
    for (const field of ["revenue", "eps", "margin", "outlook", "thesis"]) {
      await page.locator(`[data-testid="review-${field}"]`).selectOption("符合");
    }
    assert.equal(await page.locator('[data-testid="review-save"]').isDisabled(), true);
    await page.locator('[data-testid="review-outcome-select"]').selectOption("維持估值");
    assert.equal(await page.locator('[data-testid="review-save"]').isDisabled(), false);
    await page.locator('[data-testid="review-save"]').click();
    await page.locator('[data-testid="review-history"]').waitFor();
    assert.equal(await page.locator('[data-testid="review-row"]').count(), 1);
    assert.equal(await page.locator('[data-testid="review-outcome"]').first().innerText(), "維持估值");
    await settle(page);
    screenshots.review = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "review.png"),
      fullPage: true,
      animations: "disabled",
    }));

    // No trading, ranking, or factor-mining affordance may survive. Checked on
    // actionable controls only: a disclaimer that names 下單 is the opposite of
    // an affordance and must not fail this gate.
    const controlLabels = await page.locator("#app button, #app a").allInnerTexts();
    for (const label of controlLabels) {
      assert.doesNotMatch(label, /下單|送單|回測|因子|驗證報告|技術指標|AI 信心|強力買進|建議立即買進/, `retired affordance: ${label}`);
    }

    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('[data-action="reset"]').click();
    assert.equal(await page.locator(".page-title").innerText(), "Home");

    // The watchlist command area owns the responsive contract, so measure it on
    // its own page rather than on Home.
    await page.locator('[data-action="section"][data-section="watchlist"]').first().click();
    await page.locator('[data-testid="watchlist-toolbar"]').waitFor();

    const responsive = [];
    for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 820, height: 768 }, { width: 720, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await assertNoOverlap(page, [
        '[data-testid="watchlist-toolbar"] .watchlist-toolbar-grouping',
        '[data-testid="watchlist-toolbar"] .watchlist-toolbar-search',
        '[data-testid="watchlist-toolbar"] .watchlist-toolbar-actions',
        '[data-testid="watchlist-state"]',
      ], `watchlist toolbar at ${size.width}px`);
      responsive.push({
        width: size.width,
        height: size.height,
        scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth),
        innerWidth: await page.evaluate(() => window.innerWidth),
      });
      assert.equal(responsive[responsive.length - 1].scrollWidth <= responsive[responsive.length - 1].innerWidth, true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.deepEqual(browserErrors, []);
    assert.deepEqual(externalRequests, []);

    const viewport = await page.evaluate(() => ({
      devicePixelRatio: window.devicePixelRatio,
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    const pixelMismatches = Object.entries(EXPECTED_SCREENSHOTS)
      .filter(([key, expected]) => expected !== screenshots[key])
      .map(([key]) => key);
    const responsivePass = responsive.every((item) => item.scrollWidth <= item.innerWidth);
    const functionalPass = browserErrors.length === 0 && externalRequests.length === 0 && responsivePass;
    const visualBaselinePass = Object.values(EXPECTED_SCREENSHOTS).every(Boolean) && pixelMismatches.length === 0;
    const report = {
      status: visualBaselinePass ? "pass" : functionalPass ? "functional_pass_baseline_required" : "fail",
      functional_pass: functionalPass,
      visual_baseline_pass: visualBaselinePass,
      browser: await browser.version(),
      executable: executablePath,
      base_url: baseUrl,
      viewport,
      browser_errors: browserErrors,
      external_requests: externalRequests,
      responsive,
      screenshots,
      expected_screenshots: EXPECTED_SCREENSHOTS,
      pixel_mismatches: pixelMismatches,
      screenshot_dir: SCREENSHOT_DIR,
    };
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "fail") process.exitCode = 2;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    sidecar.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
