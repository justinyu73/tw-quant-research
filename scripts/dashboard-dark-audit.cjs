// Dark-theme contrast audit for the TQR dashboard (gate, not a diagnostic).
//
// Walks every primary view with [data-theme="dark"] applied and reports:
//   1. light-background leaks — elements whose effective (alpha-blended)
//      background is lighter than the dark surfaces, i.e. a hardcoded literal
//      that never flipped with the token layer.
//   2b. hover states that paint a light fill (HOVER_PROBES) — walking the DOM
//      cannot see them, so they are driven explicitly.
//   2c. focus states, driven with real Tab presses because :focus-visible does
//      not match programmatic focus on buttons. Two failures: a light fill, and
//      a focused control with no visible indicator at all — a keyboard user
//      cannot see where they are, and nothing else in this repo checks it.
//   2d. disabled controls (DISABLED_PROBES) for light fills only. Their
//      contrast is exempt; a hardcoded light background is not.
//   2. text below WCAG AA against its effective background (4.5:1, or 3:1 for
//      large text per WCAG: >=24px, or >=18.66px at weight >=700).
//
// Disabled controls are exempt from contrast (WCAG 1.4.3 exempts inactive UI
// components).
// Anything else that must stay below threshold goes in ALLOWED with a reason;
// an empty reason is not accepted.
//
// Exit code is 1 when either count is non-zero, so a red gate is visible
// without reading the JSON. Output: stdout + outputs/dashboard-dark-audit.json.
// Reuses an existing server at 127.0.0.1:5173 when reachable; otherwise spawns
// `python3 scripts/serve_dashboard_app.py --port 5200 --sidecar-port 8771`.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT_FILE = path.join(ROOT, "outputs", "dashboard-dark-audit.json");
const REUSE_URL = "http://127.0.0.1:5173";
const SPAWN_PORT = 5200;
const SPAWN_SIDECAR_PORT = 8771;
const THEME_KEY = "tw-quant-engine-theme.v1";
const VIEWPORT = { width: 1440, height: 900 };

// Same section ids and order as dashboard-rwd-audit.cjs VIEWS.
const VIEWS = [
  { id: "home", label: "首頁" },
  { id: "watchlist", label: "自選清單" },
  { id: "company", label: "公司財務指標", ready: '[data-testid="fundamental-snapshot"]' },
  { id: "technical", label: "技術指標", ready: '[data-testid="kline-chart"]' },
  { id: "valuation", label: "估值", ready: '[data-testid="valuation-panel"]' },
  { id: "buyplan", label: "買進計畫" },
  { id: "review", label: "投資審查" },
  { id: "evidence", label: "資料來源" },
  { id: "settings", label: "設定" },
];

// Interaction states are not reachable by walking the DOM: :hover has to be
// driven. Every selector here is verified to render in that view — a probe
// that matches nothing throws, because a no-op probe reads as a pass.
const HOVER_PROBES = [
  { view: "company", selector: "table.table tbody tr" },
  { view: "technical", selector: ".period-button" },
  { view: "company", selector: ".btn-outline" },
  { view: "watchlist", selector: ".btn-outline" },
  { view: "home", selector: ".btn-outline" },
  { view: "review", selector: ".btn-outline" },
];

// Disabled controls only render in the state the audit's own flow produces:
// the watchlist is empty here, so save/clear and the K-line watchlist picker
// are all disabled. A probe matching an enabled element is a broken probe.
const DISABLED_PROBES = [
  { view: "watchlist", selector: '[data-testid="watchlist-save"]' },
  { view: "watchlist", selector: '[data-testid="watchlist-clear"]' },
  { view: "technical", selector: '[data-testid="kline-watchlist-select"]' },
  { view: "technical", selector: '[data-testid="kline-drawing-clear"]' },
];

// How many Tab presses to walk per view. The top nav alone eats ~11, so this
// has to be well past it or only the nav ever gets measured.
const FOCUS_TAB_STEPS = 40;

// { selector, reason } — reason is mandatory and asserted non-empty below.
const ALLOWED = [
  {
    selector: ".status-dot",
    reason: "8px 狀態指示點：填色是 --green/--red 語意色本身，不是未翻轉的面板底色。",
  },
];

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

async function isReachable(url) {
  try {
    const response = await fetch(`${url}/index.html`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function waitForServer(url, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    if (await isReachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not become ready: ${url}`);
}

async function settle(page, extraMs = 200) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (extraMs) await page.waitForTimeout(extraMs);
}

// In-page measurement. Runs in browser context.
function auditInPage(allowed) {
  const parse = (value) => {
    const parts = (value || "").match(/[\d.]+/g);
    if (!parts) return null;
    const [r, g, b, a] = parts.map(Number);
    return { r, g, b, a: a === undefined ? 1 : a };
  };
  const luminance = ({ r, g, b }) => {
    const channel = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const ratio = (a, b) => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  // Effective background = every translucent layer from <html> down composited
  // in paint order. Walking to the first opaque ancestor alone would miss the
  // tints that sit between it and the element.
  const effectiveBg = (el) => {
    const chain = [];
    for (let node = el; node; node = node.parentElement) chain.push(node);
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    for (const node of chain.reverse()) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) acc = over(bg, acc);
    }
    return acc;
  };
  const describe = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    const testid = el.getAttribute("data-testid");
    return el.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : "") + (testid ? `[data-testid="${testid}"]` : "");
  };
  const isAllowed = (el) => allowed.some((rule) => el.matches(rule.selector));
  const isDisabled = (el) => !!el.closest("[disabled], [aria-disabled='true']");

  const lightBg = [];
  const lowContrast = [];
  const seen = new Set();

  for (const el of document.querySelectorAll("#app *, .topnav *")) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    if (isAllowed(el)) continue;

    const own = parse(cs.backgroundColor);
    if (own && own.a > 0.5) {
      const painted = over(own, effectiveBg(el.parentElement || document.body));
      if (luminance(painted) > 0.45) {
        lightBg.push({ el: describe(el), background: cs.backgroundColor, luminance: +luminance(painted).toFixed(3) });
      }
    }

    const text = el.textContent && el.textContent.trim();
    if (!text || el.childElementCount > 0) continue;
    if (isDisabled(el)) continue;
    const key = describe(el) + "|" + text.slice(0, 24);
    if (seen.has(key)) continue;
    seen.add(key);

    const fg = parse(cs.color);
    if (!fg || fg.a === 0) continue;
    const bg = effectiveBg(el);
    const blended = fg.a < 1 ? over(fg, bg) : fg;
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const threshold = large ? 3 : 4.5;
    const value = ratio(blended, bg);
    if (value < threshold) {
      lowContrast.push({
        el: describe(el),
        text: text.slice(0, 24),
        ratio: +value.toFixed(2),
        threshold,
        color: cs.color,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
      });
    }
  }
  return { lightBg, lowContrast };
}

// One alpha-blended background reader for every interaction probe; a second
// copy would drift from the one the DOM walk already uses.
function paintedState(el) {
  const parse = (value) => {
    const parts = (value || "").match(/[\d.]+/g);
    if (!parts) return null;
    const [r, g, b, a] = parts.map(Number);
    return { r, g, b, a: a === undefined ? 1 : a };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  let acc = { r: 255, g: 255, b: 255, a: 1 };
  const chain = [];
  for (let node = el; node; node = node.parentElement) chain.push(node);
  for (const node of chain.reverse()) {
    const bg = parse(getComputedStyle(node).backgroundColor);
    if (bg && bg.a > 0) acc = over(bg, acc);
  }
  const channel = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const style = getComputedStyle(el);
  return {
    background: style.backgroundColor,
    luminance: 0.2126 * channel(acc.r) + 0.7152 * channel(acc.g) + 0.0722 * channel(acc.b),
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    boxShadow: style.boxShadow,
    tag: el.tagName.toLowerCase(),
    testid: el.getAttribute("data-testid") || "",
    label: (el.textContent || "").trim().slice(0, 24),
    isBody: el === document.body || el === document.documentElement,
  };
}

async function main() {
  for (const rule of ALLOWED) {
    if (!rule.reason || !rule.reason.trim()) throw new Error(`ALLOWED entry without a reason: ${rule.selector}`);
  }

  let serverProc = null;
  let baseUrl = REUSE_URL;
  let serverMode = "reused";
  if (!(await isReachable(REUSE_URL))) {
    serverMode = "spawned";
    baseUrl = `http://127.0.0.1:${SPAWN_PORT}`;
    serverProc = spawn("python3", ["scripts/serve_dashboard_app.py", "--port", String(SPAWN_PORT), "--sidecar-port", String(SPAWN_SIDECAR_PORT)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.on("exit", () => serverProc && serverProc.kill());
    await waitForServer(baseUrl);
  }

  // Reusing a dev server means grading whatever bundle it happens to be
  // serving. A stale one turns every check into a measurement of old code and
  // still reports pass, so refuse to grade it.
  const servedBundle = [];
  for (const name of ["styles.css", "app.js", "dashboard-core.js"]) {
    const response = await fetch(`${baseUrl}/${name}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`served bundle is missing ${name}`);
    const servedHash = crypto.createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
    const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "ui", "dashboard", name))).digest("hex");
    servedBundle.push({ name, served: servedHash.slice(0, 12), source: sourceHash.slice(0, 12) });
    if (servedHash !== sourceHash) {
      throw new Error(`${baseUrl} serves a stale ${name} (${servedHash.slice(0, 12)} != source ${sourceHash.slice(0, 12)}); run python3 scripts/build_dashboard_preview.py`);
    }
  }

  const playwright = require("playwright-core");
  const executablePath = findChromium(playwright);
  if (!executablePath) throw new Error("Chromium executable not found; set CHROMIUM_EXECUTABLE_PATH");
  const browser = await playwright.chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
  const browserErrors = [];
  const views = [];
  const hoverLeaks = [];
  const focusLeaks = [];
  const focusInvisible = [];
  const disabledLeaks = [];
  const focusVisited = [];

  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));

    // Theme is persisted before the first paint so no view is measured light.
    await page.addInitScript(([key]) => {
      try { window.localStorage.setItem(key, "dark"); } catch (error) { /* storage blocked */ }
    }, [THEME_KEY]);

    const response = await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
    if (!response || response.status() !== 200) throw new Error(`dashboard did not load: ${response && response.status()}`);
    await page.locator("#app .app-shell").waitFor();

    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    if (theme !== "dark") throw new Error(`dark theme did not apply: data-theme=${theme}`);

    // Select TWSE:2330 once so company/valuation/buyplan render with data
    // rather than their empty states, which would hide most of the surface.
    await page.locator('[data-testid="global-search"]').fill("2330");
    await page.locator('[data-testid="global-search-results"] .symbol-search-result').filter({ hasText: "2330" }).first().click();

    for (const view of VIEWS) {
      const link = page.locator(`[data-action="section"][data-section="${view.id}"]`).first();
      if (!(await link.count())) {
        views.push({ id: view.id, label: view.label, skipped: "no section control" });
        continue;
      }
      await link.click();
      if (view.ready) await page.locator(view.ready).waitFor({ timeout: 30000 }).catch(() => {});
      await settle(page);

      for (const probe of HOVER_PROBES.filter((item) => item.view === view.id)) {
        const target = page.locator(probe.selector).first();
        // A probe that matches nothing is a broken probe, not a pass: silently
        // skipping is how this gate first went green without testing anything.
        if (!(await target.count())) throw new Error(`hover probe matched nothing: ${probe.view} ${probe.selector}`);
        await target.hover().catch(() => {});
        await page.waitForTimeout(120);
        const painted = await target.evaluate(paintedState);
        if (painted.luminance > 0.45) {
          hoverLeaks.push({ view: view.id, selector: probe.selector, background: painted.background, luminance: +painted.luminance.toFixed(3) });
        }
      }
      await page.mouse.move(0, 0);
      await page.waitForTimeout(80);

      for (const probe of DISABLED_PROBES.filter((item) => item.view === view.id)) {
        const target = page.locator(probe.selector).first();
        if (!(await target.count())) throw new Error(`disabled probe matched nothing: ${probe.view} ${probe.selector}`);
        if (!(await target.isDisabled())) throw new Error(`disabled probe is not disabled: ${probe.view} ${probe.selector}`);
        const painted = await target.evaluate(paintedState);
        if (painted.luminance > 0.45) {
          disabledLeaks.push({ view: view.id, selector: probe.selector, background: painted.background, luminance: +painted.luminance.toFixed(3) });
        }
      }

      // Real Tab presses: :focus-visible does not match programmatic focus on
      // buttons, so page.focus() would measure a ring the user never sees.
      await page.evaluate(() => document.body.focus());
      const seen = new Set();
      for (let step = 0; step < FOCUS_TAB_STEPS; step += 1) {
        await page.keyboard.press("Tab");
        const handle = await page.evaluateHandle(() => document.activeElement);
        const painted = await handle.evaluate(paintedState);
        await handle.dispose();
        if (painted.isBody) break;
        const key = `${view.id}|${painted.tag}|${painted.testid}|${painted.label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        focusVisited.push({ view: view.id, tag: painted.tag, testid: painted.testid, label: painted.label });
        const ringed = (painted.outlineStyle !== "none" && parseFloat(painted.outlineWidth) > 0) || painted.boxShadow !== "none";
        if (!ringed) {
          focusInvisible.push({ view: view.id, tag: painted.tag, testid: painted.testid, label: painted.label });
        }
        if (painted.luminance > 0.45) {
          focusLeaks.push({ view: view.id, tag: painted.tag, testid: painted.testid, background: painted.background, luminance: +painted.luminance.toFixed(3) });
        }
      }
      // Zero findings from zero measurements is the failure this repo keeps
      // hitting; a view whose tab walk reached nothing is a broken walk.
      if (!focusVisited.some((item) => item.view === view.id)) {
        throw new Error(`focus walk reached no control on view: ${view.id}`);
      }

      const result = await page.evaluate(auditInPage, ALLOWED);
      views.push({
        id: view.id,
        label: view.label,
        lightBgCount: result.lightBg.length,
        lowContrastCount: result.lowContrast.length,
        lightBg: result.lightBg.slice(0, 20),
        lowContrast: result.lowContrast.slice(0, 20),
      });
    }
  } finally {
    await browser.close();
    if (serverProc) serverProc.kill();
  }

  const lightBgTotal = views.reduce((sum, v) => sum + (v.lightBgCount || 0), 0);
  const hoverLeakTotal = hoverLeaks.length;
  const lowContrastTotal = views.reduce((sum, v) => sum + (v.lowContrastCount || 0), 0);
  const report = {
    schema: "tqr-dashboard-dark-audit/v1",
    server_mode: serverMode,
    served_bundle: servedBundle,
    base_url: baseUrl,
    viewport: VIEWPORT,
    standard: "WCAG 2.1 AA — 4.5:1, or 3:1 for large text (>=24px, or >=18.66px at weight >=700)",
    allowed: ALLOWED,
    light_bg_total: lightBgTotal,
    hover_leak_total: hoverLeakTotal,
    hover_leaks: hoverLeaks,
    focus_visited_total: focusVisited.length,
    focus_visited: focusVisited,
    focus_leak_total: focusLeaks.length,
    focus_leaks: focusLeaks,
    focus_invisible_total: focusInvisible.length,
    focus_invisible: focusInvisible,
    disabled_leak_total: disabledLeaks.length,
    disabled_leaks: disabledLeaks,
    low_contrast_total: lowContrastTotal,
    pass: lightBgTotal === 0 && lowContrastTotal === 0 && hoverLeakTotal === 0
      && focusLeaks.length === 0 && focusInvisible.length === 0 && disabledLeaks.length === 0
      && browserErrors.length === 0,
    views,
    browser_errors: browserErrors,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
