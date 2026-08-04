const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
// Built into a throwaway dir: writing into outputs/dashboard-preview would
// overwrite a running dev server's bundle with this run's random sidecar
// port, silently breaking it until the next restart.
const PREVIEW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tqr-preview-"));
const SCREENSHOT_DIR = path.join(ROOT, "outputs", "dashboard-browser");
const EXPECTED_SCREENSHOTS = {
  home: "d12325a029de0038d22c0152efde557c5ace47561b757bd825d615d73bc4f407",
  company: "7847ca4f45738c0d4c92c042688aa1ec0fd9ea9907995bfd122a1764e94731ac",
  technical: "4f810a213fef4a463b3c47e63bb2ed1519ca859882f26b7ae071079b6927db82",
  watchlist: "cf4e31bf40de1640a02ab8630942bc3d6fba0caeb09ed4cdf80d0b0fcef45d6d",
  buyplan: "7aac161b9905ff5188409ca153e411668c00f60e12d7bd1549d9d2d4788a5c08",
  review: "abab9cb0446cb5a839252dd8cb7bd241c59e9cb97c63f5de3985a1867e0b99ce",
  valuation: "918dadc022a43f7321bdb28614e88404c7d686cd55a27041be05dc070eaf60de",
  // Dark is the primary appearance and carries its own baselines; an empty
  // value here keeps the gate red until a human has looked at the capture.
  home_dark: "e674d860fbcefd6827a7fa5c571c8f44b41172147094c7bf4bb38631e152c6ba",
  watchlist_dark: "116601e44247c618094329d43af3714574731229fcda200ec600213ec710b8c4",
  company_dark: "81f11e4c4bff197d1dbab72cc89b986acf09d0c96f0825358cefddd7aefbd640",
  technical_dark: "3a5289fb47fb132fe9212dc6db741f40c7d5f2babeb59f250b17dd3f6310c105",
  valuation_dark: "44ae0155faaec56973229d16468a67295f282ac4c1e220f5e7db694e56ad2927",
  buyplan_dark: "90ee9e5c2bb681c4f2d61e84fe9f60b80a3daf21ecc19f754c0f4822fd2c33e4",
  review_dark: "cfcc3c65ee3f11691316e0e784935e1e64e04f010522ca23da5294bf2e2f7fbb",
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

// The chart is a canvas: no DOM query can say which instrument it is drawing,
// so the box could claim one stock while the chart drew another and every
// existing check still passed. Recording the series handed to
// lightweight-charts is the only ground truth available to the gate.
const CHART_PAINT_HOOK = `
window.__chartPaint = [];
(function () {
  var real = null;
  function define(target, name, value) {
    Object.defineProperty(target, name, { value: value, writable: true, configurable: true, enumerable: true });
  }
  function wrapPane(pane, api) {
    if (!pane || pane.__paintWrapped) return pane;
    var origAdd = pane.addSeries.bind(pane);
    define(pane, "addSeries", function (definition, options) {
      var series = origAdd(definition, options);
      var kind = definition === api.CandlestickSeries ? "candles" : definition === api.HistogramSeries ? "volume" : "line";
      var origSet = series.setData.bind(series);
      define(series, "setData", function (data) {
        window.__chartPaint.push({ kind: kind, count: data.length, last: data[data.length - 1] || null });
        return origSet(data);
      });
      return series;
    });
    define(pane, "__paintWrapped", true);
    return pane;
  }
  function wrap(api) {
    if (!api || api.__paintWrapped) return api;
    // The library's exports are non-writable, so a plain assignment on a
    // derived object fails silently and the hook records nothing.
    var proxy = Object.create(api);
    define(proxy, "__paintWrapped", true);
    define(proxy, "createChart", function (container, options) {
      var chart = api.createChart(container, options);
      var origPanes = chart.panes.bind(chart);
      var origAddPane = chart.addPane.bind(chart);
      define(chart, "panes", function () { return origPanes().map(function (pane) { return wrapPane(pane, api); }); });
      define(chart, "addPane", function () { return wrapPane(origAddPane(), api); });
      return chart;
    });
    return proxy;
  }
  Object.defineProperty(window, "LightweightCharts", {
    configurable: true,
    get: function () { return real; },
    set: function (value) { real = wrap(value); }
  });
})();
`;

// The chart, the title and the search box must all name the same instrument.
async function assertChartIdentity(page, sidecarBaseUrl, instruments, expectedId, label) {
  // Callers clear the recording before acting, so this also fails the switch
  // that changes the state and never repaints.
  await page.waitForFunction(() => (window.__chartPaint || []).some((entry) => entry.kind === "candles"));
  const period = await page.locator('[data-testid="kline-period-label"]').innerText();
  const response = await fetch(`${sidecarBaseUrl}/kline?instrument=${encodeURIComponent(expectedId)}&period=${encodeURIComponent(period)}`);
  assertOk(response.ok, `${label}: sidecar has no ${expectedId}/${period} model to compare against`);
  const bars = (await response.json()).data.bars;
  const expectedBar = bars[bars.length - 1];
  const instrument = instruments.find((item) => item.instrument_id === expectedId);
  assertOk(instrument, `${label}: ${expectedId} missing from the instrument catalog`);

  const painted = await page.evaluate(() => {
    const candles = (window.__chartPaint || []).filter((entry) => entry.kind === "candles");
    return candles.length ? candles[candles.length - 1] : null;
  });
  assertOk(painted, `${label}: nothing was painted onto the chart canvas`);
  assert.equal(painted.count, bars.length, `${label}: canvas is drawing ${painted.count} bars, ${expectedId} has ${bars.length}`);
  assert.equal(painted.last.time, expectedBar.trading_date, `${label}: canvas last date does not belong to ${expectedId}`);
  assert.equal(painted.last.close, expectedBar.close, `${label}: canvas last close does not belong to ${expectedId}`);
  assert.equal(await page.locator('[data-testid="kline-instrument"]').inputValue(), expectedId, `${label}: search box names a different instrument than the canvas`);
  assert.match(
    await page.locator('[data-testid="kline-instrument-label"]').innerText(),
    new RegExp(instrument.display_name),
    `${label}: chart title names a different instrument than the canvas`,
  );
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
  // Assertions on below-the-fold elements leave the page scrolled, and a
  // fullPage capture then paints the sticky top nav at that scroll offset
  // instead of the document top: the baseline would encode how far the run
  // happened to scroll rather than what the page looks like.
  await page.evaluate(() => window.scrollTo(0, 0));
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
  const catalog = await waitForSidecar(sidecarBaseUrl);
  const build = spawnSync("python3", ["scripts/build_dashboard_preview.py"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TQE_SIDECAR_URL: sidecarBaseUrl, TQE_PREVIEW_OUTPUT: PREVIEW_DIR },
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
  await page.addInitScript(CHART_PAINT_HOOK);
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
    assert.equal(await page.locator(".topbar .topnav").count(), 1);
    // The retired left rail must not come back alongside the top nav.
    assert.equal(await page.locator(".sidebar").count(), 0);
    assert.equal(await page.locator(".card").count() > 0, true);
    assert.equal(await page.locator(".read-only-pill").innerText(), "研究唯讀");

    // IA contract: exactly the seven primary value-research sections, in order.
    assert.equal(await page.locator(".topnav .nav-link").count(), 7);
    assert.deepEqual(
      await page.locator(".topnav .nav-link").allInnerTexts(),
      ["首頁", "自選清單", "公司財務指標", "技術指標", "估值", "買進計畫", "投資審查"],
    );
    for (const removed of ["research", "backtest", "features", "products", "market", "fundamentals", "stories", "overview"]) {
      assert.equal(await page.locator(`.topnav [data-section="${removed}"]`).count(), 0, `retired section still in nav: ${removed}`);
    }

    assert.equal(await page.locator(".page-title").innerText(), "首頁");
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

    // 公司財務指標: quote, the company's own numbers, then the judgements built
    // on them. The chart and the alerts panel are on 技術指標.
    const instrumentSearch = page.locator('[data-testid="kline-instrument"]');
    await instrumentSearch.fill("2330");
    await page.locator('[data-testid="kline-symbol-results"] .symbol-search-result').filter({ hasText: "2330" }).first().click();
    assert.equal(await page.locator(".page-title").innerText(), "公司財務指標");
    // Reading order is the point of the split: data before judgement.
    assert.deepEqual(
      (await page.locator(".page-wrapper .card > header h2").allInnerTexts()).slice(0, 5),
      ["基本面快照", "研究狀態", "趨勢表", "投資假設", "研究筆記"],
    );
    assert.equal(await page.locator('[data-testid="kline-chart"]').count(), 0);
    assert.equal(await page.locator('[data-testid="alerts-panel"]').count(), 0);
    // One shared picker in the shell, so every page can switch stock.
    assert.equal(await page.locator('[data-testid="instrument-picker"]').count(), 1);
    assert.equal(await page.locator('[data-testid="instrument-picker"] [data-testid="kline-instrument"]').count(), 1);
    assert.equal(await page.locator('[data-testid="instrument-picker"] [data-testid="kline-watchlist-select"]').count(), 1);
    assert.match(await page.locator('[data-testid="instrument-bar-current"]').innerText(), /台積電/);
    await page.locator('[data-testid="kline-instrument"]').fill("2317");
    await page.locator('[data-testid="kline-instrument"]').press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-testid="quote-bar"]').textContent.includes("鴻海"));
    assert.equal(await page.locator(".page-title").innerText(), "公司財務指標");
    await page.locator('[data-testid="kline-instrument"]').fill("2330");
    await page.locator('[data-testid="kline-instrument"]').press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-testid="quote-bar"]').textContent.includes("台積電"));
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
    for (const testid of ["fundamental-revenue-yoy", "fundamental-revenue-mom", "fundamental-eps", "fundamental-bvps"]) {
      assert.match(await page.locator(`[data-testid="${testid}"] strong`).getAttribute("class"), /\bfundamental-key\b/);
    }
    for (const testid of ["fundamental-gross-margin", "fundamental-operating-margin", "fundamental-net-margin", "fundamental-debt-ratio", "fundamental-current-ratio"]) {
      assert.match(await page.locator(`[data-testid="${testid}"] strong`).getAttribute("class"), /\bfundamental-neutral\b/);
    }
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
    assert.match(await page.locator('[data-testid="trend-quarter-row"] td').nth(1).getAttribute("class"), /\bfundamental-key\b/);
    assert.match(await page.locator('[data-testid="trend-quarter-row"] td').nth(5).getAttribute("class"), /\bfundamental-key\b/);
    assert.match(await page.locator('[data-testid="trend-month-row"] td').nth(1).getAttribute("class"), /\bfundamental-key\b/);
    assert.match(await page.locator('[data-testid="trend-balance-row"] td').nth(3).getAttribute("class"), /\bfundamental-key\b/);

    // 技術指標: chart, technical readings, alerts.
    await page.locator('[data-action="section"][data-section="technical"]').first().click();
    assert.equal(await page.locator(".page-title").innerText(), "技術指標");
    await page.locator('[data-testid="kline-chart"]').waitFor();
    assert.equal(await page.locator('[data-testid="kline-period-label"]').innerText(), "1D");
    assert.equal(await page.locator('[data-testid="kline-chart"] canvas').count() > 0, true);
    assert.equal(await page.locator('[data-testid="kline-instrument"]').inputValue(), "TWSE:2330");
    assert.equal(await page.locator('[data-testid="alerts-panel"]').count(), 1);
    assert.match(await page.locator('[data-testid="kline-coverage"]').innerText(), /360 \/ 交易日 360/);

    // Instrument switching: canvas == title == search box, after every commit
    // path. A research tool drawing the previous stock under the new stock's
    // name is the worst failure mode this UI has.
    await assertChartIdentity(page, sidecarBaseUrl, catalog.instruments, "TWSE:2330", "opening the technical page");

    // Keyboard commit. Typing a code and pressing Enter used to change nothing
    // but the box, which then kept claiming 2317 over 2330's chart.
    await page.evaluate(() => { window.__chartPaint = []; });
    await page.locator('[data-testid="kline-instrument"]').fill("2317");
    await page.locator('[data-testid="kline-instrument"]').press("Enter");
    await page.locator('[data-testid="kline-chart"]').waitFor();
    await settle(page);
    await assertChartIdentity(page, sidecarBaseUrl, catalog.instruments, "TWSE:2317", "after committing 2317 with Enter");

    // Result-list commit, from a query that does not resolve on its own: the
    // blur handler must not repaint the list out from under the click.
    await page.evaluate(() => { window.__chartPaint = []; });
    await page.locator('[data-testid="kline-instrument"]').fill("台積");
    await page.locator('[data-testid="kline-symbol-results"] button[data-instrument-id="TWSE:2330"]').click();
    await page.locator('[data-testid="kline-chart"]').waitFor();
    await settle(page);
    await assertChartIdentity(page, sidecarBaseUrl, catalog.instruments, "TWSE:2330", "after picking 2330 from the result list");

    // An uncommitted query may differ from the chart while the user types, but
    // it must not survive the next interaction as a claim about the chart.
    await page.locator('[data-testid="kline-instrument"]').fill("2317");
    await page.locator('[data-testid="kline-period-1W"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="kline-period-label"]').textContent === "1W");
    assert.equal(await page.locator('[data-testid="kline-instrument"]').inputValue(), "TWSE:2317");

    // Leave the page on the instrument the rest of the smoke expects.
    await page.evaluate(() => { window.__chartPaint = []; });
    await page.locator('[data-testid="kline-instrument"]').fill("2330");
    await page.locator('[data-testid="kline-instrument"]').press("Enter");
    await page.locator('[data-testid="kline-period-1D"]').click();
    await page.locator('[data-testid="kline-chart"]').waitFor();
    await settle(page);
    await assertChartIdentity(page, sidecarBaseUrl, catalog.instruments, "TWSE:2330", "after returning to 2330");
    assert.equal(await page.locator('[data-testid^="technical-value-"][class*="valuation-"]').count(), 0);

    // The curated watchlist has to be reachable from the chart, not only by
    // typing a code from memory.
    assert.equal(await page.locator('[data-testid="kline-watchlist-select"]').count(), 1);
    await settle(page);
    screenshots.technical = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "technical.png"),
      fullPage: true,
      animations: "disabled",
    }));

    await page.locator('[data-action="section"][data-section="company"]').first().click();
    await page.locator('[data-testid="note-composer"]').waitFor();
    await page.locator('[data-testid="note-title"]').fill("2330 研究觀察");
    await page.locator('[data-testid="note-body"]').fill("價格與技術線先記錄，等待下一次財報核對。");
    await page.locator('[data-testid="note-submit"]').click();
    assert.equal(await page.locator('[data-testid="note-card"]').count(), 1);
    assert.match(await page.locator('[data-testid="note-card"]').innerText(), /2330 研究觀察/);

    // Company research status: the human's own judgement fields. These must
    // reach Watchlist columns, Watchlist filters, and the Home counters —
    // rendering them is not enough, they have to be writable and to propagate.
    await page.locator('[data-testid="company-status"]').waitFor();
    assert.equal(await page.locator('[data-testid="fundamental-snapshot"] .fundamental-metric strong[class*="valuation-"]').count(), 0);
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
    assert.equal(await page.locator(".page-title").innerText(), "自選清單");
    await page.locator('[data-testid="watchlist-toolbar"]').waitFor();
    assert.equal(await page.locator('[data-testid="watchlist-empty"]').count(), 1);
    assert.equal(await page.locator('[data-testid="data-update-panel"]').count(), 1);
    assert.equal(await page.locator('[data-testid="data-update-scope"]').inputValue(), "watchlist");
    assert.equal(await page.locator('[data-testid="data-update-button"]').isDisabled(), true);
    assert.match(await page.locator('[data-testid="data-update-status"]').innerText(), /瀏覽器預覽不下載/);

    // Symbol search is owned by the shared instrument bar. Watchlist keeps
    // group/save controls and the bar supplies the contextual add action.
    assert.equal(await page.locator('[data-testid="watchlist-picker"]').count(), 0);
    const watchlistPicker = page.locator('[data-testid="kline-instrument"]');
    await watchlistPicker.click();
    assert.equal(await watchlistPicker.evaluate((element) => document.activeElement === element), true);
    await watchlistPicker.fill("2330");
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="kline-symbol-results"] .symbol-search-result').length > 0);
    await page.locator('[data-testid="kline-symbol-results"] .symbol-search-result').filter({ hasText: "2330" }).first().click();
    await page.locator('[data-testid="instrument-add-to-watchlist"]').click();
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
    assert.match(await page.locator('[data-testid="watchlist-discount"]').first().getAttribute("class"), /\bvaluation-neutral\b/);
    // A stock that is already tracked remains searchable in the shared picker;
    // the contextual add action is the only disabled state.
    await watchlistPicker.fill("2330");
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="kline-symbol-results"] .symbol-search-result').length > 0);
    assert.equal(await page.locator('[data-testid="kline-symbol-results"] .symbol-search-empty').count(), 0);
    const trackedResult = page.locator('[data-testid="kline-symbol-results"] .symbol-search-result[data-instrument-id="TWSE:2330"]');
    assert.equal(await trackedResult.count(), 1);
    assert.equal(await trackedResult.isDisabled(), false);
    assert.equal(await page.locator('[data-testid="instrument-add-to-watchlist"]').isDisabled(), true);
    assert.match(await page.locator('[data-testid="instrument-add-to-watchlist"]').innerText(), /已在目前群組/);
    // A code that really is absent still says so.
    await watchlistPicker.fill("999999");
    await page.waitForFunction(() => document.querySelector('[data-testid="kline-symbol-results"] .symbol-search-empty') !== null);

    await watchlistPicker.fill("2308");
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="kline-symbol-results"] .symbol-search-result').length > 0);
    await page.locator('[data-testid="kline-symbol-results"] .symbol-search-result[data-instrument-id="TWSE:2308"]').click();
    assert.equal(await page.locator('[data-testid="instrument-add-to-watchlist"]').isDisabled(), false);
    await page.locator('[data-testid="instrument-add-to-watchlist"]').click();
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
    assert.equal(await page.locator(".page-title").innerText(), "估值");
    await page.locator('[data-testid="valuation-panel"]').waitFor();
    assert.equal(await page.locator('[data-testid="valuation-empty"]').count(), 1);
    // Evaluating before a worksheet exists must say why, not do nothing: this
    // is the two-step flow the happy path used to hide.
    assert.match(
      await page.locator('[data-testid="valuation-evaluate-hint"]').innerText(),
      /加入估值工作表/,
    );
    assert.equal(await page.locator('[data-testid="valuation-evaluate"]').isDisabled(), false);
    await page.locator('[data-testid="valuation-evaluate"]').click();
    const blockedStatus = await page.locator('[data-testid="valuation-status"]').innerText();
    assert.match(blockedStatus, /加入估值工作表/, `evaluate-before-worksheet said: ${blockedStatus}`);
    assert.equal(await page.locator('[data-testid="valuation-result-card"]').count(), 0);
    assert.equal(await page.locator('[data-testid="valuation-scenario-panel"]').count(), 1);
    assert.deepEqual(await page.locator('[data-testid="valuation-scenario-panel"] .valuation-scenario-node strong').allInnerTexts(), ["保守", "最合理", "樂觀"]);
    await page.locator('[data-testid="valuation-ws-label"]').fill("2330 三情境合理價");
    await page.locator('[data-testid="valuation-ws-bear-eps"]').fill("30");
    await page.locator('[data-testid="valuation-ws-bear-pe"]').fill("15");
    await page.locator('[data-testid="valuation-ws-base-eps"]').fill("40");
    await page.locator('[data-testid="valuation-ws-base-pe"]').fill("20");
    await page.locator('[data-testid="valuation-ws-bull-eps"]').fill("50");
    await page.locator('[data-testid="valuation-ws-bull-pe"]').fill("25");
    assert.equal(await page.locator('[data-testid="valuation-draft-bear-value"]').innerText(), "450");
    assert.equal(await page.locator('[data-testid="valuation-draft-base-value"]').innerText(), "800");
    assert.equal(await page.locator('[data-testid="valuation-draft-bull-value"]').innerText(), "1,250");
    // The basis fields are required: a valuation with no recorded EPS period
    // must not be addable.
    assert.equal(await page.locator('[data-testid="valuation-add"]').isDisabled(), true);
    await page.locator('[data-testid="valuation-basis-period"]').fill("2026Q1");
    await page.locator('[data-testid="valuation-basis-rationale"]').fill("近五年本益比區間中位");
    assert.equal(await page.locator('[data-testid="valuation-add"]').isDisabled(), false);
    await page.locator('[data-testid="valuation-add"]').click();
    assert.equal(await page.locator('[data-testid="valuation-worksheet"]').count(), 1);
    assert.equal(await page.locator('[data-testid="valuation-worksheet-ruler"]').count(), 1);
    const worksheetRulerText = await page.locator('[data-testid="valuation-worksheet-ruler"]').innerText();
    assert.match(worksheetRulerText, /Bear\s*450/);
    assert.match(worksheetRulerText, /Base\s*800/);
    assert.match(worksheetRulerText, /Bull\s*1,250/);
    await page.locator('[data-testid="valuation-worksheet"] [data-action="valuation-edit"]').click();
    assert.equal(await page.locator('[data-testid="valuation-editing-state"]').count(), 1);
    assert.equal(await page.locator('[data-testid="valuation-ws-label"]').inputValue(), "2330 三情境合理價");
    assert.equal(await page.locator('[data-testid="valuation-ws-base-pe"]').inputValue(), "20");
    assert.equal(await page.locator('[data-testid="valuation-add"]').innerText(), "更新估值範本");
    await page.locator('[data-testid="valuation-add"]').click();
    assert.equal(await page.locator('[data-testid="valuation-editing-state"]').count(), 0);
    assert.equal(await page.locator('[data-testid="valuation-worksheet"]').count(), 1);
    await page.locator('[data-testid="valuation-evaluate"]').click();
    await page.locator('[data-testid="valuation-result-card"]').first().waitFor();
    assert.equal(await page.locator('[data-testid="valuation-rail"]').count(), 1);
    assert.equal(await page.locator('[data-testid="valuation-rail-bands"] .valuation-rail-band').count(), 5);
    assert.equal(await page.locator('[data-testid^="valuation-rail-ruler-tick-"]').count(), 3);
    assert.match(await page.locator('[data-testid="valuation-current-marker"]').getAttribute("class"), /\bvaluation-premium\b/);
    assert.equal(await page.locator('.valuation-rail-header [data-testid="valuation-current-marker"]').count(), 0);
    assert.equal(await page.locator('.valuation-rail-track [data-testid="valuation-current-marker"]').count(), 1);
    assert.match(await page.locator('.valuation-rail-track [data-testid="valuation-current-marker"]').innerText(), /現價\s*2,440\s*·\s*高於 Bull/);
    assert.match(await page.locator('[data-testid="valuation-current-marker"]').getAttribute("class"), /\bvaluation-outside-high\b/);
    assert.match(await page.locator('[data-testid="valuation-current-marker"]').getAttribute("style"), /left:100\.00%/);
    assert.equal(await page.locator('[data-testid="valuation-range-warning"]').count(), 1);
    const valuationRangeWarning = await page.locator('[data-testid="valuation-range-warning"]').innerText();
    assert.match(valuationRangeWarning, /重估 Bear～Bull/);
    assert.match(valuationRangeWarning, /事件|基本面|假設|計算方式/);
    assert.equal(await page.locator('[data-testid="valuation-base-value"]').first().innerText(), "800");
    assert.equal(await page.locator('[data-testid="valuation-current-price"]').first().innerText(), "2,440");
    // Buy ladder = Base x 85% / 75%, computed by the engine, not the browser.
    assert.equal(await page.locator('[data-testid="valuation-zone-first"]').first().innerText(), "680");
    assert.equal(await page.locator('[data-testid="valuation-zone-sweet"]').first().innerText(), "600");
    assert.equal(await page.locator('[data-testid="valuation-stage"]').first().innerText(), "觀察");
    // 2,440 against a base of 800 is a premium, on this page too.
    const valGap = await page.locator('[data-testid="valuation-discount"]').first().innerText();
    assert.match(valGap, /^溢價 /, `valuation premium rendered as: ${valGap}`);
    assert.match(await page.locator('[data-testid="valuation-discount"]').first().getAttribute("class"), /\bvaluation-premium\b/);
    assert.match(await page.locator('[data-testid="valuation-discount-cell"]').first().getAttribute("class"), /\bvaluation-premium\b/);
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
    assert.match(await page.locator('[data-testid="watchlist-discount"]').first().getAttribute("class"), /\bvaluation-premium\b/);

    await page.locator('[data-action="section"][data-section="home"]').first().click();
    await page.locator('[data-testid="opportunity-list"]').waitFor();
    assert.equal(await page.locator('[data-testid="opportunity-row"]').count(), 1);
    assert.match(await page.locator('[data-testid="opportunity-discount"]').first().innerText(), /^溢價 /);
    assert.match(await page.locator('[data-testid="opportunity-discount"]').first().getAttribute("class"), /\bvaluation-premium\b/);
    assert.equal(await page.locator('[data-testid="buyplan-status"] li').count(), 1);

    // Buy Plan and Review are declared but not yet built; they must say so
    // rather than render a fake surface.
    await page.locator('[data-action="section"][data-section="buyplan"]').first().click();
    assert.equal(await page.locator(".page-title").innerText(), "買進計畫");
    await page.locator('[data-testid="buyplan-form"]').waitFor();
    // Tranche prices come from the valuation ladder, not from the market price.
    assert.equal(await page.locator('[data-testid="buyplan-tranche"]').count(), 4);
    assert.equal(await page.locator('[data-tranche="first"] td').nth(1).innerText(), "680");
    assert.equal(await page.locator('[data-tranche="sweet"] td').nth(1).innerText(), "600");
    assert.match(await page.locator('[data-testid="buyplan-valuation-position-value"]').innerText(), /^溢價 /);
    assert.match(await page.locator('[data-testid="buyplan-valuation-position-value"]').getAttribute("class"), /\bvaluation-premium\b/);
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
    assert.equal(await page.locator(".page-title").innerText(), "投資審查");
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
    // 技術指標 was on this list and is not any more: JY named a read-only page
    // that shows K 線 and technical readings. The prohibitions that remain are
    // the ones about acting on a signal, not about displaying one.
    const controlLabels = await page.locator("#app button, #app a").allInnerTexts();
    for (const label of controlLabels) {
      assert.doesNotMatch(label, /下單|送單|回測|因子|驗證報告|AI 信心|強力買進|建議立即買進/, `retired affordance: ${label}`);
    }

    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('[data-action="reset"]').click();
    assert.equal(await page.locator(".page-title").innerText(), "首頁");

    // The watchlist command area owns the responsive contract, so measure it on
    // its own page rather than on Home.
    await page.locator('[data-action="section"][data-section="watchlist"]').first().click();
    await page.locator('[data-testid="watchlist-toolbar"]').waitFor();

    const responsive = [];
    for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 820, height: 768 }, { width: 720, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await assertNoOverlap(page, [
        '[data-testid="watchlist-toolbar"] .watchlist-toolbar-grouping',
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

    // Dark is the primary appearance, so it carries its own pixel baseline:
    // the contrast audit checks colour and cannot see layout breaking.
    await page.locator('[data-action="section"][data-section="evidence"]').first().click();
    assert.equal(await page.locator(".page-title").innerText(), "資料來源");
    assert.equal(await page.locator(".lineage-grid").count(), 1);
    await page.locator('[data-action="section"][data-section="settings"]').first().click();
    assert.equal(await page.locator(".page-title").innerText(), "設定");
    assert.equal(await page.locator('[data-testid="theme-panel"]').count(), 1);
    await page.locator('[data-testid="theme-dark"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
    for (const section of ["home", "watchlist", "company", "technical", "valuation", "buyplan", "review"]) {
      await page.locator(`[data-action="section"][data-section="${section}"]`).first().click();
      await settle(page);
      screenshots[`${section}_dark`] = screenshotHash(await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${section}-dark.png`),
        fullPage: true,
        animations: "disabled",
      }));
    }
    await page.locator('[data-action="section"][data-section="settings"]').first().click();
    await page.locator('[data-testid="theme-light"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), null);

    // A stock with nothing downloaded yet must not be reported as a dead
    // sidecar: that message sent the user off to restart a service that was
    // running fine. Runs last so the served bundle is untouched beforehand.
    // A watchlist download runs for minutes; the 15s read limit used to abort it
    // and then tell the user the service had stopped responding. The button is
    // desktop-only, so this runs on its own page with a minimal Tauri stub —
    // checking it on the preview page would silently skip (the button is always
    // disabled there) and read as a pass.
    const desktopPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await desktopPage.addInitScript(([sidecar]) => {
      const watchlist = JSON.stringify({ schema: "tw-quant-engine-watchlist/v1", version: 1, items: ["TWSE:2330"] });
      window.__TAURI__ = {
        core: {
          invoke: (command) => {
            if (command === "sidecar_url") return Promise.resolve(sidecar);
            if (command === "load_watchlist") return Promise.resolve(watchlist);
            if (command === "save_watchlist") return Promise.resolve(null);
            return Promise.reject(new Error("unstubbed command: " + command));
          },
        },
      };
    }, [sidecarBaseUrl]);
    let updateHeld = 0;
    await desktopPage.route(/\/data\/update/, async (route) => {
      updateHeld += 1;
      await new Promise((resolve) => setTimeout(resolve, 17000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { status: "success", updated_count: 1, requested_count: 1, bars_downloaded: 0, results: [] } }),
      });
    });
    await desktopPage.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
    await desktopPage.locator('[data-action="section"][data-section="watchlist"]').first().click();
    await desktopPage.locator('[data-testid="data-update-panel"]').waitFor();
    const desktopUpdateButton = desktopPage.locator('[data-testid="data-update-button"]');
    // A disabled button here means the stub did not take and nothing was measured.
    assertOk(!(await desktopUpdateButton.isDisabled()), "data update button never enabled: the desktop stub did not take");
    await desktopUpdateButton.click();
    await desktopPage.waitForTimeout(16500);
    // Behaviour, not wording: past the old 15s limit the download must still be
    // running. Asserting on the error text instead would pass for any reworded
    // failure.
    const midFlight = await desktopPage.locator('[data-testid="data-update-status"]').innerText();
    assert.match(midFlight, /正在下載/, `download already gave up before 16.5s: ${midFlight}`);
    await desktopPage.waitForFunction(
      () => !/更新中/.test(document.querySelector('[data-testid="data-update-status"]').textContent),
      null,
      { timeout: 30000 },
    );
    assert.doesNotMatch(await desktopPage.locator('[data-testid="data-update-status"]').innerText(), /逾時/);
    assert.equal(updateHeld, 1, "the download request was never issued");
    await desktopPage.close();

    const errorsBeforeDataGap = browserErrors.length;
    await page.route(`${sidecarBaseUrl}/kline?instrument=${encodeURIComponent("TWSE:2317")}*`, (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "kline_not_found" }) }));
    await page.locator('[data-action="section"][data-section="technical"]').first().click();
    await page.locator('[data-testid="kline-instrument"]').fill("2317");
    await page.locator('[data-testid="kline-instrument"]').press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-testid="kline-empty"]') !== null);
    assert.match(await page.locator('[data-testid="kline-empty"]').innerText(), /還沒有已下載的 K 線資料/);
    assert.equal(await page.locator('[data-testid="topnav-runtime-error"]').count(), 0);
    await page.unroute(`${sidecarBaseUrl}/kline?instrument=${encodeURIComponent("TWSE:2317")}*`);
    // The simulated 404 is the subject of this check, not a defect in the page.
    const dataGapNoise = browserErrors.splice(errorsBeforeDataGap);
    assert.equal(
      dataGapNoise.every((entry) => entry.includes("404")),
      true,
      `unexpected browser errors during the data-gap check: ${JSON.stringify(dataGapNoise)}`,
    );

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
