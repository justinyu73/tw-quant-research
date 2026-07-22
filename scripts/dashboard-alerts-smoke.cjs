const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PREVIEW_DIR = path.join(ROOT, "outputs", "dashboard-preview");

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

async function main() {
  const checks = [];
  const record = async (name, fn) => {
    try {
      const detail = await fn();
      checks.push({ name, status: "pass", detail: detail === undefined ? "" : String(detail) });
    } catch (error) {
      checks.push({ name, status: "fail", detail: error.message });
      throw error;
    }
  };

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

  const playwright = require("playwright-core");
  const executablePath = findChromium(playwright);
  assert.ok(executablePath, "Chromium executable not found; set CHROMIUM_EXECUTABLE_PATH");
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("request", (request) => {
    if (!request.url().startsWith(baseUrl) && !request.url().startsWith(sidecarBaseUrl)) externalRequests.push(request.url());
  });

  try {
    const response = await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
    assert.equal(response.status(), 200);

    // TQR-FORM-FEEDBACK (products page): disabled watchlist buttons must show
    // field-level hints naming the field and the expected format.
    await page.locator('[data-action="section"][data-section="products"]').first().click();
    await page.locator('[data-testid="watchlist-toolbar"]').waitFor();

    await record("watchlist_form_issues_visible_when_disabled", async () => {
      const groupIssues = page.locator('[data-testid="watchlist-group-issues"]');
      assert.equal(await groupIssues.isVisible(), true);
      assert.match(await groupIssues.innerText(), /群組名稱不可空白/);
      assert.equal(await page.locator('[data-testid="watchlist-group-create"]').isDisabled(), true);
      const addIssues = page.locator('[data-testid="watchlist-add-issues"]');
      assert.equal(await addIssues.isVisible(), true);
      assert.match(await addIssues.innerText(), /請先輸入代號或名稱/);
      assert.equal(await page.locator('[data-testid="watchlist-add"]').isDisabled(), true);
    });

    await page.locator('[data-testid="watchlist-group-name"]').fill("半導體");
    await record("watchlist_group_issues_hidden_when_valid", async () => {
      assert.equal(await page.locator('[data-testid="watchlist-group-issues"]').isVisible(), false);
      assert.equal(await page.locator('[data-testid="watchlist-group-create"]').isDisabled(), false);
    });
    await page.locator('[data-testid="watchlist-group-name"]').fill("");

    await page.locator('[data-testid="watchlist-picker"]').fill("2330");
    await record("watchlist_add_issues_hidden_when_selected", async () => {
      assert.equal(await page.locator('[data-testid="watchlist-add-issues"]').isVisible(), false);
      assert.equal(await page.locator('[data-testid="watchlist-add"]').isDisabled(), false);
    });
    await page.locator('[data-testid="watchlist-picker"]').fill("");

    // Navigate to the market section where the alerts panel lives.
    await page.locator('[data-action="section"][data-section="market"]').first().click();
    await page.locator('[data-testid="kline-chart"]').waitFor();
    const panel = page.locator('[data-testid="alerts-panel"]');
    await panel.waitFor();

    await record("panel_rendered", async () => assert.equal(await panel.count(), 1));

    const panelText = await panel.innerText();
    const cardText = await page.locator(".card", { has: page.locator('[data-testid="alerts-panel"]') }).innerText();
    await record("research_only_label", async () => {
      assert.match(cardText, /僅研究用途/);
      assert.match(cardText, /非交易指示/);
    });

    await record("no_order_affordance_in_dom", async () => {
      const haystack = panelText.toLowerCase();
      for (const token of ["/orders", "order ticket", "position sizing", "broker"]) {
        assert.equal(haystack.includes(token), false, `panel contains forbidden token: ${token}`);
      }
      const scan = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        const hits = ["/orders", "order ticket", "position sizing"].filter((token) => text.includes(token));
        const controls = Array.from(document.querySelectorAll("button, a, input, select"))
          .filter((element) => /buy|sell|下單|委託|broker/i.test(`${element.id} ${element.name} ${element.getAttribute("data-action") || ""}`));
        return { text_hits: hits, control_hits: controls.length };
      });
      assert.deepEqual(scan.text_hits, []);
      assert.equal(scan.control_hits, 0);
    });

    // TQR-FORM-FEEDBACK (market page): disabled alert/valuation/watchlist
    // buttons must show field-level hints; hints clear as fields become valid.
    await record("alert_form_issues_visible_when_disabled", async () => {
      assert.equal(await page.locator('[data-testid="alert-add"]').isDisabled(), true);
      const issues = page.locator('[data-testid="alert-form-issues"]');
      assert.equal(await issues.isVisible(), true);
      const issueText = await issues.innerText();
      assert.match(issueText, /名稱不可空白/);
      assert.match(issueText, /門檻值需為數字/);
      const fields = await issues.locator("li").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-field")));
      assert.ok(fields.includes("label") && fields.includes("value"), `issue items must carry data-field, got ${fields}`);
    });

    await page.locator('[data-testid="alert-label"]').fill("2330 收盤站上 1");
    await record("alert_form_issues_narrow_as_fields_fix", async () => {
      assert.equal(await page.locator('[data-testid="alert-add"]').isDisabled(), true);
      const issueText = await page.locator('[data-testid="alert-form-issues"]').innerText();
      assert.match(issueText, /門檻值需為數字/);
      assert.equal(/名稱不可空白/.test(issueText), false, "fixed field must drop out of the issue list");
    });

    await page.locator('[data-testid="alert-value"]').fill("1");
    await record("alert_form_issues_hidden_when_valid", async () => {
      assert.equal(await page.locator('[data-testid="alert-add"]').isDisabled(), false);
      assert.equal(await page.locator('[data-testid="alert-form-issues"]').isVisible(), false);
    });

    await record("valuation_form_issues_visible_when_disabled", async () => {
      assert.equal(await page.locator('[data-testid="valuation-add"]').isDisabled(), true);
      const issues = page.locator('[data-testid="valuation-form-issues"]');
      assert.equal(await issues.isVisible(), true);
      const issueText = await issues.innerText();
      assert.match(issueText, /工作表名稱不可空白/);
      assert.match(issueText, /預估 EPS 需為大於 0/);
    });

    await record("terminal_watchlist_add_issues_visible", async () => {
      assert.equal(await page.locator('[data-testid="terminal-watchlist-add"]').isDisabled(), true);
      const issues = page.locator('[data-testid="terminal-watchlist-add-issues"]');
      assert.equal(await issues.isVisible(), true);
      assert.match(await issues.innerText(), /請先輸入代號或名稱/);
    });

    // Add a valid alert definition through the panel form.
    await page.locator('[data-testid="alert-label"]').fill("2330 收盤站上 1");
    await page.locator('[data-testid="alert-value"]').fill("1");
    const addButton = page.locator('[data-testid="alert-add"]');
    assert.equal(await addButton.isDisabled(), false);
    await addButton.click();
    await page.locator('[data-testid="alert-definition"]').waitFor();

    await record("alert_added", async () => assert.equal(await page.locator('[data-testid="alert-definition"]').count(), 1));

    await record("stored_schema_valid", async () => {
      const raw = await page.evaluate(() => window.localStorage.getItem("tqe-in-app-alerts.v1"));
      assert.ok(raw, "alerts store missing from localStorage");
      const store = JSON.parse(raw);
      assert.equal(store.schema, "tqe-in-app-alerts/v1");
      assert.equal(store.version, 1);
      // Session-expiry definitions persist within the session so a reload keeps them.
      assert.equal(store.alerts.length, 1);
      assert.equal(store.alerts[0].expiry.policy, "session");
      return "session-expiry alert persists in the store within the session";
    });

    // Persist an until-expiry alert so the reload check has durable content.
    await page.locator('[data-testid="alert-expiry"]').selectOption("until");
    await page.locator('[data-testid="alert-until"]').fill("2026-12-31T00:00");
    await page.locator('[data-testid="alert-label"]').fill("2330 收盤站上 1（持久）");
    await page.locator('[data-testid="alert-value"]').fill("1");
    await addButton.click();

    await record("until_alert_added", async () => assert.equal(await page.locator('[data-testid="alert-definition"]').count(), 2));

    // Evaluate against the loopback sidecar; 2330 close is well above 1.
    await page.locator('[data-testid="alert-evaluate"]').click();
    await page.locator('[data-testid="alert-event"]').first().waitFor();

    await record("evaluation_events_rendered", async () => {
      const count = await page.locator('[data-testid="alert-event"]').count();
      assert.equal(count >= 1, true, `expected fired events, got ${count}`);
      const text = await page.locator('[data-testid="alert-event-list"]').innerText();
      assert.match(text, /研究註記/);
      return `${count} event(s)`;
    });

    await record("evaluation_stays_loopback", async () => assert.deepEqual(externalRequests, []));

    // Reload in the same tab session (F5): sessionStorage survives, so both
    // the session-expiry and the until-expiry alert are kept.
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('[data-action="section"][data-section="market"]').first().click();
    await page.locator('[data-testid="alerts-panel"]').waitFor();

    await record("persistence_after_reload", async () => {
      const count = await page.locator('[data-testid="alert-definition"]').count();
      assert.equal(count, 2, "reload within the same session keeps both alerts");
    });

    await record("no_browser_errors", async () => assert.deepEqual(browserErrors, []));

    // Fail-closed: an invalid definition is rejected by the engine route.
    // The deliberate 400 shows up as a console resource message afterwards.
    await record("invalid_definition_rejected", async () => {
      const status = await page.evaluate(async (base) => {
        const invalid = [{
          schema: "tqe-in-app-alert/v1",
          alert_id: "bad-1",
          label: "非法提醒",
          enabled: true,
          target: { security_id: "9999" },
          condition: { type: "price_threshold", field: "close", op: ">=", value: 1 },
          dedup: { policy: "once_per_session" },
          expiry: { policy: "session" },
          created_at: "2026-07-22T00:00:00Z",
        }];
        const response = await fetch(`${base}/alerts?definitions=${encodeURIComponent(JSON.stringify(invalid))}`);
        return response.status;
      }, sidecarBaseUrl);
      assert.equal(status, 400);
    });

    await record("only_expected_400_console_message", async () => {
      const unexpected = browserErrors.filter((message) => !/status of 400/.test(message));
      assert.deepEqual(unexpected, []);
    });

    // TQR-FORM-FEEDBACK: an engine-side rejection discovered only at evaluation
    // time (r <= g slips past the store normalizer) must surface verbatim in the
    // panel status line, naming the field and the rule.
    await record("engine_rejection_shown_verbatim", async () => {
      await page.evaluate(() => {
        const store = {
          schema: "tqe-fair-value-worksheets/v1",
          version: 1,
          worksheets: [{
            schema: "tqe-fair-value-worksheet/v1",
            worksheet_id: "ws-bad-r-g",
            label: "r<=g 測試",
            target: { security_id: "2330" },
            model: { type: "dividend_discount_simple", dps: 5, growth_rate: 0.08, discount_rate: 0.03 },
            safety_margin: 0.1,
            assumption_notes: "測試",
            created_at: "2026-07-22T00:00:00Z",
          }],
        };
        window.localStorage.setItem("tqe-fair-value-worksheets.v1", JSON.stringify(store));
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.locator('[data-action="section"][data-section="market"]').first().click();
      await page.locator('[data-testid="valuation-panel"]').waitFor();
      await page.locator('[data-testid="valuation-evaluate"]').click();
      const status = page.locator('[data-testid="valuation-status"]');
      await status.waitFor();
      assert.match(await status.innerText(), /model\.discount_rate must be greater than model\.growth_rate/);
      await page.evaluate(() => window.localStorage.removeItem("tqe-fair-value-worksheets.v1"));
      return "status line shows the engine field+rule message verbatim";
    });

    // New browser session (new tab in the same profile): sessionStorage starts
    // empty, so the loader drops session-expiry definitions and persists the
    // pruned store; the until-expiry alert survives.
    const freshPage = await context.newPage();
    freshPage.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    freshPage.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
    });
    freshPage.on("request", (request) => {
      if (!request.url().startsWith(baseUrl) && !request.url().startsWith(sidecarBaseUrl)) externalRequests.push(request.url());
    });

    await record("new_session_drops_session_alerts", async () => {
      await freshPage.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
      await freshPage.locator('[data-action="section"][data-section="market"]').first().click();
      await freshPage.locator('[data-testid="alerts-panel"]').waitFor();
      await freshPage.locator('[data-testid="alert-definition"]').waitFor();
      const count = await freshPage.locator('[data-testid="alert-definition"]').count();
      assert.equal(count, 1, "new session keeps only the until-expiry alert");
      const store = JSON.parse(await freshPage.evaluate(() => window.localStorage.getItem("tqe-in-app-alerts.v1")));
      assert.deepEqual(store.alerts.map((alert) => alert.expiry.policy), ["until"]);
      const unexpected = browserErrors.filter((message) => !/status of 400/.test(message));
      assert.deepEqual(unexpected, []);
      assert.deepEqual(externalRequests, []);
    });

    const report = {
      status: "pass",
      browser: await browser.version(),
      executable: executablePath,
      base_url: baseUrl,
      checks,
      browser_errors: browserErrors,
      external_requests: externalRequests,
    };
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      status: "fail",
      error: error.stack || String(error),
      checks,
      browser_errors: browserErrors,
      external_requests: externalRequests,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
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
