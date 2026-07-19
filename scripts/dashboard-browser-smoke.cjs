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
  overview: "f0a9a38c2b4e21d4e17cf8e8658f73f831ad4b8f60ef0f807ee4f5b4dd6ce79a",
  market_valid: "df5cf03d85b373484768eb2b497adbc763bec7800883bcde888636e5f4dc2fc8",
  market_partial: "f1449a3eca7c35cf23f0baa1c7e6804dc6a6eb7b98dcbac239e86a5a73e800f1",
  market_future: "56d98b46b4b0fe15f605ba2f842d77e9f7f6381228f15943ac0f5c21cd9ce662",
  products: "5417174af5c98d424a6fe02b63fa24d3bf0894a90bde7579752aca5816707c8e",
  detail_dialog: "44d10f53497858afdd99380d818cc3aad369090cfc9f0926a4bb7a2710951987",
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
    assert.equal(await page.locator(".table").count() > 0, true);
    assert.equal(await page.locator(".read-only-pill").innerText(), "資料唯讀");
    assert.equal(await page.locator(".page-title").innerText(), "研究駕駛艙");
    const overviewText = await page.locator("#app").innerText();
    assert.doesNotMatch(overviewText, /READ ONLY|Research modules|admitted rows|unadmitted|Instrument/);
    assert.equal(await page.evaluate(() => typeof window.LightweightCharts), "object");

    await settle(page);
    screenshots.overview = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "overview.png"),
      fullPage: true,
      animations: "disabled",
    }));

    await page.locator('[data-action="section"][data-section="market"]').first().click();
    assert.equal(await page.locator(".page-title").innerText(), "個股分析");
    await page.locator('[data-testid="kline-chart"]').waitFor();
    assert.equal(await page.locator('[data-testid="kline-period-label"]').innerText(), "1D");
    assert.equal(await page.locator('[data-testid="kline-chart"] canvas').count() > 0, true);
    assert.equal(await page.locator('[data-testid="kline-instrument"]').inputValue(), "TWSE:2330");
    assert.equal(await page.locator('[data-testid="stock-quote"] .stock-quote-price strong').innerText(), "2,440");
    assert.match(await page.locator('[data-testid="kline-coverage"]').innerText(), /360 \/ 交易日 360/);
    assert.match(await page.locator('[data-testid="kline-coverage"]').innerText(), /EMA 可用/);
    assert.notEqual(await page.locator('[data-testid="technical-value-ema-20-"]').innerText(), "—");
    await settle(page);
    screenshots.market_valid = screenshotHash(await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "market-valid.png"),
      fullPage: true,
      animations: "disabled",
    }));

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
    assert.equal(await page.locator('[data-testid="research-status"]').innerText(), "目前顯示 1 筆已納入資料");
    await page.locator('[data-action="research-add-group"]').first().click();
    assert.equal(await page.locator('[data-action="research-add-group"]').first().innerText(), "已在群組");
    await page.locator('[data-testid="research-market"]').fill("TWSE");
    await page.locator('[data-testid="research-apply"]').click();
    assert.equal(await page.locator('[data-testid="research-results"] tbody tr').count(), 1);
    assert.match(await page.locator('[data-testid="screen-spec"]').innerText(), /TWSE/);
    assert.match(await page.locator('[data-testid="strategy-spec"]').innerText(), /research_only/);

    await page.locator('[data-action="section"][data-section="products"]').first().click();
    await page.locator(".page-title").waitFor();
    assert.equal(await page.locator(".page-title").innerText(), "市場資料");
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
    assert.equal(await page.locator(".page-title").innerText(), "研究駕駛艙");
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
