const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PREVIEW_DIR = path.join(ROOT, "outputs", "dashboard-preview");
const SCREENSHOT_DIR = path.join(ROOT, "outputs", "dashboard-browser");
const EXPECTED_SCREENSHOTS = {
  overview: "ce694fb51998afd01fd434cd07eecaaa747867d54e22b74586107c11409903a6",
  market_valid: "b84a2b3806c6619accd0d1b466977687c74ab350ea321da0060b85dd8a7b3066",
  market_partial: "d4ef725a23528ec687b87109333061a5d65612103722a44eb1197a4663b9a70e",
  market_future: "8975648c050edcf10d3cee1fb0bb0d2a5cdf78cd1da77fc6c3c66db874426d31",
  products: "e88c2dae9411b022e3ce0457a16aa3c7fb55b7efdae20c53ce4529fe4fa0444a",
  detail_dialog: "f5ed390e8f0328360e663ef85a4a9d752f09dd05c66493b78ca790f337ff4c62",
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

async function main() {
  const sidecarPort = await freePort();
  const sidecarBaseUrl = `http://127.0.0.1:${sidecarPort}`;
  const sidecar = spawn("python3", ["scripts/tqe_sidecar.py", "--host", "127.0.0.1", "--port", String(sidecarPort)], {
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
    assert.equal(await page.locator('[data-testid="watchlist-toolbar"]').count(), 1);
    assert.equal(await page.locator('[data-testid="data-update-panel"]').count(), 1);
    assert.equal(await page.locator('[data-testid="data-update-scope"]').inputValue(), "watchlist");
    assert.equal(await page.locator('[data-testid="data-update-scope"] option').count(), 2);
    assert.equal(await page.locator('[data-testid="data-update-button"]').isDisabled(), true);
    assert.match(await page.locator('[data-testid="data-update-status"]').innerText(), /瀏覽器預覽不下載/);
    assert.equal(await page.locator(".read-only-pill").innerText(), "研究唯讀");
    assert.equal(await page.locator(".page-title").innerText(), "市場首頁");
    const overviewText = await page.locator("#app").innerText();
    assert.doesNotMatch(overviewText, /READ ONLY|Research modules|admitted rows|unadmitted|Instrument/);
    assert.equal(await page.evaluate(() => typeof window.LightweightCharts), "object");

    await settle(page);
    screenshots.overview = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "overview.png"),
      fullPage: true,
      animations: "disabled",
    }));

    const globalSearch = page.locator('[data-testid="global-search"]');
    await globalSearch.fill("2330");
    await page.locator('[data-testid="global-search-results"] .symbol-search-result').filter({ hasText: "2330" }).first().click();
    assert.equal(await page.locator(".page-title").innerText(), "行情分析");

    await page.locator('[data-action="section"][data-section="market"]').first().click();
    assert.equal(await page.locator(".page-title").innerText(), "行情分析");
    await page.locator('[data-testid="kline-chart"]').waitFor();
    assert.equal(await page.locator('[data-testid="kline-period-label"]').innerText(), "1D");
    assert.equal(await page.locator('[data-testid="kline-chart"] canvas').count() > 0, true);
    assert.equal(await page.locator('[data-testid="kline-instrument"]').inputValue(), "TWSE:2330");
    assert.equal(await page.locator('[data-testid="quote-bar"] .terminal-quote-price strong').innerText(), "2,440");
    assert.equal(await page.locator('[data-testid="terminal-watchlist"]').count(), 1);
    assert.match(await page.locator('[data-testid="kline-coverage"]').innerText(), /360 \/ 交易日 360/);
    assert.match(await page.locator('[data-testid="kline-coverage"]').innerText(), /EMA 可用/);
    assert.notEqual(await page.locator('[data-testid="technical-value-ema-20-"]').innerText(), "—");
    await settle(page);
    screenshots.market_valid = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "market-valid.png"),
      fullPage: true,
      animations: "disabled",
    }));

    const terminalWatchlistPicker = page.locator('[data-testid="terminal-watchlist-picker"]');
    await terminalWatchlistPicker.fill("2330");
    const terminalWatchlistResult = page.locator('[data-testid="terminal-watchlist-results"] .symbol-search-result').filter({ hasText: "2330" }).first();
    await terminalWatchlistResult.waitFor();
    await terminalWatchlistResult.click();
    assert.equal(await page.locator('[data-testid="terminal-watchlist-add"]').isDisabled(), false);
    await page.locator('[data-testid="terminal-watchlist-add"]').click();
    assert.equal(await page.locator('[data-testid="terminal-watchlist"] .terminal-watchlist-row').count(), 1);
    assert.equal(await page.locator('[data-testid="kline-watchlist-toggle"]').innerText(), "移出自選");
    await page.locator('[data-testid="kline-watchlist-toggle"]').click();
    assert.equal(await page.locator('[data-testid="kline-watchlist-toggle"]').innerText(), "加入自選");

    // Exact symbol input must be sufficient; selecting a dropdown result is optional.
    await terminalWatchlistPicker.fill("2308");
    assert.equal(await page.locator('[data-testid="terminal-watchlist-add"]').isDisabled(), false);
    await page.locator('[data-testid="terminal-watchlist-add"]').click();
    assert.equal(await page.locator('[data-testid="terminal-watchlist"] .terminal-watchlist-row').count(), 1);
    await page.locator('[data-action="watchlist-remove"][data-instrument-id="TWSE:2308"]').click();
    assert.equal(await page.locator('[data-testid="terminal-watchlist"] .terminal-watchlist-row').count(), 0);

    await page.locator('[data-action="section"][data-section="features"]').first().click();
    await page.locator('[data-testid="feature-workbench"]').waitFor();
    assert.equal(await page.locator('[data-testid="technical-snapshot"]').count(), 1);
    assert.notEqual(await page.locator('[data-testid="technical-value-ema-20-"]').innerText(), "—");
    assert.equal(await page.locator('[data-testid="feature-workbench"] .technical-reading').count(), 4);
    await page.locator('[data-action="section"][data-section="market"]').first().click();
    await page.locator('[data-testid="kline-chart"]').waitFor();

    await page.locator('[data-testid="kline-fit"]').click();
    await page.locator('[data-testid="kline-zoom-in"]').click();
    await page.locator('[data-testid="kline-zoom-out"]').click();
    await page.locator('[data-testid="kline-indicator-rsi"]').click();
    await page.locator('[data-testid="kline-chart"]').waitFor();
    await page.locator('[data-testid="kline-drawing"]').click();
    assert.equal(await page.locator('[data-testid="kline-drawing"]').getAttribute("aria-pressed"), "true");
    const chartBox = await page.locator('[data-testid="kline-chart"]').boundingBox();
    assert.ok(chartBox, "chart frame should have a bounding box");
    await page.mouse.click(chartBox.x + chartBox.width / 2, chartBox.y + 100);
    assert.equal(await page.locator('[data-testid="kline-drawing-clear"]').isDisabled(), false);
    await page.locator('[data-testid="kline-drawing-clear"]').click();
    await page.locator('[data-testid="kline-template"]').click();
    assert.match(await page.locator('[data-testid="kline-template"]').innerText(), /研究模板/);

    await page.locator('[data-testid="kline-period-M"]').click();
    await page.locator('[data-testid="kline-chart"]').waitFor();
    assert.equal(await page.locator('[data-testid="kline-period-label"]').innerText(), "M");
    assert.match(await page.locator('[data-testid="kline-state"]').innerText(), /部分可用/);
    await settle(page);
    screenshots.market_partial = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "market-partial.png"),
      fullPage: true,
      animations: "disabled",
    }));

    await page.locator('[data-testid="kline-instrument"]').fill("TX:202608");
    await page.locator('[data-testid="kline-symbol-results"] .symbol-search-result').filter({ hasText: "TX:202608" }).first().click();
    await page.locator('[data-testid="kline-chart"]').waitFor();
    assert.match(await page.locator('[data-testid="kline-state"]').innerText(), /部分可用/);
    await settle(page);
    screenshots.market_future = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "market-future.png"),
      fullPage: true,
      animations: "disabled",
    }));

    await page.locator('[data-testid="kline-watchlist-toggle"]').click();
    assert.equal(await page.locator('[data-testid="kline-watchlist-toggle"]').innerText(), "移出自選");
    await page.locator('[data-action="section"][data-section="overview"]').first().click();
    await page.locator('[data-testid="watchlist-table"]').waitFor();
    assert.equal(await page.locator('[data-testid="watchlist-table"] tbody tr').count(), 1);
    assert.match(await page.locator('[data-testid="watchlist-state"]').innerText(), /瀏覽器預覽草稿/);
    assert.equal(await page.locator('[data-testid="watchlist-save"]').isDisabled(), false);
    const watchlistPicker = page.locator('[data-testid="watchlist-picker"]');
    await watchlistPicker.click();
    assert.equal(await watchlistPicker.evaluate((element) => document.activeElement === element), true);
    await watchlistPicker.type("2330");
    assert.equal(await watchlistPicker.inputValue(), "2330");
    await page.locator('[data-testid="watchlist-symbol-results"] .symbol-search-result').filter({ hasText: "2330" }).first().click();
    await page.locator('[data-testid="watchlist-add"]').click();
    assert.equal(await page.locator('[data-testid="watchlist-table"] tbody tr').count(), 2);
    await watchlistPicker.fill("2308");
    assert.equal(await page.locator('[data-testid="watchlist-add"]').isDisabled(), false);
    await page.locator('[data-testid="watchlist-add"]').click();
    assert.equal(await page.locator('[data-testid="watchlist-table"] tbody tr').count(), 3);
    await page.locator('[data-action="watchlist-remove"][data-instrument-id="TWSE:2308"]').click();
    assert.equal(await page.locator('[data-testid="watchlist-table"] tbody tr').count(), 2);
    await page.locator('[data-testid="watchlist-save"]').click();
    assert.match(await page.locator('[data-testid="watchlist-state"]').innerText(), /已儲存至瀏覽器預覽/);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('[data-testid="watchlist-table"]').waitFor();
    assert.equal(await page.locator('[data-testid="watchlist-table"] tbody tr').count(), 2);

    await page.locator('[data-testid="watchlist-group-name"]').fill("半導體");
    await page.locator('[data-testid="watchlist-group-create"]').click();
    assert.notEqual(await page.locator('[data-testid="watchlist-group-select"]').inputValue(), "default");
    await page.locator('[data-action="section"][data-section="research"]').first().click();
    await page.locator('[data-testid="research-results"]').waitFor();
    await page.locator('[data-testid="screen-builder"]').waitFor();
    await page.locator('[data-testid="screen-builder"] .screen-condition').first().click();
    assert.match(await page.locator('[data-testid="screen-builder"]').innerText(), /已選 1/);
    assert.equal(await page.locator('[data-testid="research-status"]').innerText(), "目前顯示 1 筆已納入資料");
    await page.locator('[data-action="research-add-group"]').first().click();
    assert.equal(await page.locator('[data-action="research-add-group"]').first().innerText(), "已在群組");
    await page.locator('[data-testid="research-market"]').fill("TWSE");
    await page.locator('[data-testid="research-apply"]').click();
    assert.equal(await page.locator('[data-testid="research-results"] tbody tr').count(), 1);
    assert.match(await page.locator('[data-testid="screen-spec"]').innerText(), /TWSE/);
    assert.match(await page.locator('[data-testid="strategy-spec"]').innerText(), /research_only/);

    await page.locator('[data-action="section"][data-section="stories"]').first().click();
    await page.locator('[data-testid="note-composer"]').waitFor();
    await page.locator('[data-testid="note-title"]').fill("2330 研究觀察");
    await page.locator('[data-testid="note-body"]').fill("價格與技術線先記錄，等待下一次財報核對。");
    await page.locator('[data-testid="note-submit"]').click();
    assert.equal(await page.locator('[data-testid="note-card"]').count(), 1, `note count=${await page.locator('[data-testid="note-count"]').innerText()} title=${await page.locator('[data-testid="note-title"]').inputValue()}`);
    assert.match(await page.locator('[data-testid="note-card"]').innerText(), /2330 研究觀察/);

    await page.locator('[data-action="section"][data-section="products"]').first().click();
    await page.locator(".page-title").waitFor();
    assert.equal(await page.locator(".page-title").innerText(), "我的自選");
    await settle(page);
    screenshots.products = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "products.png"),
      fullPage: true,
      animations: "disabled",
    }));

    await page.locator('[data-action="product"]').first().click();
    await page.locator('[role="dialog"]').waitFor();
    assert.equal(await page.locator('[role="dialog"]').isVisible(), true);
    const dialogText = await page.locator('[role="dialog"]').textContent();
    assert.ok(dialogText.includes("唯讀資料列詳情"), `dialog text: ${dialogText}`);
    await settle(page);
    screenshots.detail_dialog = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "detail-dialog.png"),
      fullPage: true,
      animations: "disabled",
    }));

    await page.keyboard.press("Escape");
    await page.locator('[role="dialog"]').waitFor({ state: "detached" });
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
    await page.locator('[data-action="section"][data-section="backtest"]').first().click();
    const firstEquityDate = await page.locator(".subsection .table tbody tr").first().locator("td").first().innerText();
    assert.notEqual(firstEquityDate, "—", "equity curve date must be rendered from the read model");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('[data-action="reset"]').click();
    assert.equal(await page.locator(".page-title").innerText(), "市場首頁");
    const responsive = [];
    for (const size of [{ width: 1024, height: 768 }, { width: 820, height: 768 }]) {
      await page.setViewportSize(size);
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
