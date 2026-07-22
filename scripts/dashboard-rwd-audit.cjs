// RWD overflow audit for the TQR dashboard (read-only diagnostic).
//
// Walks every primary view at six breakpoints and reports:
//   1. page-level horizontal overflow (documentElement.scrollWidth > innerWidth)
//   2. elements whose content overflows their box (scrollWidth > clientWidth + 1)
//      or whose bounding rect escapes the viewport (per view, top 10 worst)
//   3. tables that scroll horizontally without a .table-responsive wrapper
//      (TQR-WIREFRAME-002: tables may only scroll inside .table-responsive)
//
// Output: JSON on stdout and outputs/dashboard-rwd-audit.json.
// Reuses an existing server at 127.0.0.1:5173 when reachable; otherwise spawns
// `python3 scripts/serve_dashboard_app.py --port 5199 --sidecar-port 8770`.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT_FILE = path.join(ROOT, "outputs", "dashboard-rwd-audit.json");
const REUSE_URL = "http://127.0.0.1:5173";
const SPAWN_PORT = 5199;
const SPAWN_SIDECAR_PORT = 8770;

const BREAKPOINTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 820, height: 768 },
  { width: 720, height: 768 },
  { width: 390, height: 844 },
];

// Sidebar sections in dashboard-core.js SECTIONS order (user-facing list).
// `title` is the rendered .page-title text; it differs from the nav label for
// the evidence section (nav 資料來源 → title 資料與證據, see app.js mainMarkup).
const VIEWS = [
  { id: "overview", label: "市場首頁" },
  { id: "market", label: "行情分析", ready: '[data-testid="kline-chart"]' },
  { id: "products", label: "我的自選" },
  { id: "features", label: "技術指標" },
  { id: "research", label: "因子與公式" },
  { id: "fundamentals", label: "財務追蹤" },
  { id: "backtest", label: "驗證報告" },
  { id: "stories", label: "研究筆記" },
  { id: "evidence", label: "資料來源", title: "資料與證據" },
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

async function settle(page, extraMs = 150) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (extraMs) await page.waitForTimeout(extraMs);
}

// In-page measurement. Runs in browser context.
//
// Classification per flagged element:
//   - intentional-scroller: the element itself is overflow-x auto/scroll and
//     its content is wider than its box (by design, e.g. .table-responsive).
//   - scrolled-content: element sits inside such a scroller, so its rect
//     legitimately extends past the viewport (not an RWD failure).
//   - clipped: scrollWidth > clientWidth + 1 with overflow-x hidden.
//   - container-overflow: scrollWidth > clientWidth + 1 with overflow-x
//     visible (content spills into surrounding layout).
//   - viewport-escape: bounding rect escapes the viewport horizontally while
//     no intentional scroller contains it.
// Only the last three count as RWD failures. `rootOffender` marks failures
// whose ancestors are not themselves flagged, i.e. the layout culprits whose
// children merely cascade.
function auditInPage() {
  const vw = window.innerWidth;
  window.scrollTo(0, 0);
  const doc = document.documentElement;
  const round = (n) => Math.round(n * 10) / 10;
  const flagged = [];
  const flaggedSet = new Set();
  for (const el of document.querySelectorAll("body *")) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const scrollOverflow = el.scrollWidth - el.clientWidth;
    const viewportOverflow = rect.right - vw;
    const leftOverflow = -rect.left;
    const over = Math.max(
      scrollOverflow > 1 ? scrollOverflow : 0,
      viewportOverflow > 1 ? viewportOverflow : 0,
      leftOverflow > 1 ? leftOverflow : 0
    );
    if (over <= 0) continue;
    let scroller = null;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      if ((pcs.overflowX === "auto" || pcs.overflowX === "scroll") && p.scrollWidth > p.clientWidth + 1) {
        scroller = p;
        break;
      }
    }
    const isScroller = (cs.overflowX === "auto" || cs.overflowX === "scroll") && scrollOverflow > 1;
    let kind;
    if (isScroller) kind = "intentional-scroller";
    else if (scroller) kind = "scrolled-content";
    else if (scrollOverflow > 1 && cs.overflowX === "hidden") kind = "clipped";
    else if (scrollOverflow > 1) kind = "container-overflow";
    else kind = "viewport-escape";
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean).slice(0, 4).join(" ") : "";
    const item = {
      el,
      kind,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      testid: el.getAttribute("data-testid"),
      classes: cls || null,
      overflowPx: round(over),
      scrollOverflowPx: scrollOverflow > 1 ? round(scrollOverflow) : 0,
      viewportOverflowPx: viewportOverflow > 1 ? round(viewportOverflow) : 0,
      leftOverflowPx: leftOverflow > 1 ? round(leftOverflow) : 0,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      rectLeft: round(rect.left),
      rectRight: round(rect.right),
      overflowX: cs.overflowX,
      text: el.children.length === 0 ? (el.textContent || "").trim().slice(0, 30) : null,
    };
    flagged.push(item);
    flaggedSet.add(el);
  }
  for (const item of flagged) {
    let root = true;
    for (let p = item.el.parentElement; p; p = p.parentElement) {
      if (flaggedSet.has(p)) { root = false; break; }
    }
    item.rootOffender = root;
    delete item.el;
  }
  const failures = flagged.filter((i) => i.kind !== "intentional-scroller" && i.kind !== "scrolled-content");
  failures.sort((a, b) => b.overflowPx - a.overflowPx);
  const roots = failures.filter((i) => i.rootOffender);
  const tables = [];
  for (const t of document.querySelectorAll("table")) {
    const rect = t.getBoundingClientRect();
    const inResponsive = Boolean(t.closest(".table-responsive"));
    let scroller = null;
    for (let p = t.parentElement; p; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      if ((pcs.overflowX === "auto" || pcs.overflowX === "scroll") && p.scrollWidth > p.clientWidth + 1) {
        scroller = typeof p.className === "string" ? p.className.split(/\s+/).filter(Boolean).slice(0, 3).join(" ") : p.tagName;
        break;
      }
    }
    const scrollOverflow = t.scrollWidth - t.clientWidth;
    const exceedsViewport = rect.right > vw + 1;
    // Contract: tables may only scroll inside .table-responsive. A table whose
    // own content is wider than its box without a .table-responsive wrapper is
    // a true violation. A table that merely escapes the viewport because an
    // ancestor overflows (e.g. Lightweight Charts' internal layout table) is
    // informational only — the ancestor is already in the element failures.
    if (!inResponsive && (scrollOverflow > 1 || exceedsViewport)) {
      tables.push({
        testid: t.getAttribute("data-testid") || (t.closest("[data-testid]") && t.closest("[data-testid]").getAttribute("data-testid")),
        classes: typeof t.className === "string" ? t.className : null,
        scrollOverflowPx: round(scrollOverflow),
        exceedsViewport,
        inheritedOnly: scrollOverflow <= 1,
        rectRight: round(rect.right),
        scrollerClass: scroller,
      });
    }
  }
  return {
    pageOverflow: doc.scrollWidth > vw,
    docScrollWidth: doc.scrollWidth,
    innerWidth: vw,
    flaggedCount: flagged.length,
    scrolledContentCount: flagged.length - failures.length - flagged.filter((i) => i.kind === "intentional-scroller").length,
    failureCount: failures.length,
    rootOffenderCount: roots.length,
    elements: failures.slice(0, 10),
    tables,
  };
}

async function main() {
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

  const playwright = require("playwright-core");
  const executablePath = findChromium(playwright);
  if (!executablePath) throw new Error("Chromium executable not found; set CHROMIUM_EXECUTABLE_PATH");
  const browser = await playwright.chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
  const browserErrors = [];
  try {
    const page = await browser.newPage({ viewport: BREAKPOINTS[0], deviceScaleFactor: 1 });
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    const response = await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
    if (!response || response.status() !== 200) throw new Error(`dashboard did not load: ${response && response.status()}`);
    await page.locator("#app .app-shell").waitFor();

    // Select TWSE:2330 once at desktop width so 行情分析 renders chart + side panels
    // at every breakpoint (selection persists in SPA state across section switches).
    await page.locator('[data-testid="global-search"]').fill("2330");
    await page.locator('[data-testid="global-search-results"] .symbol-search-result').filter({ hasText: "2330" }).first().click();
    await page.locator('[data-testid="kline-chart"]').waitFor();

    const results = [];
    for (const bp of BREAKPOINTS) {
      await page.setViewportSize(bp);
      for (const view of VIEWS) {
        const expectedTitle = view.title || view.label;
        process.stderr.write(`[audit] ${bp.width}px ${view.id}\n`);
        try {
          await page.locator(`.sidebar-nav [data-action="section"][data-section="${view.id}"]`).first().click();
          await page.waitForFunction((title) => {
            const el = document.querySelector(".page-title");
            return el && el.textContent.trim() === title;
          }, expectedTitle, { timeout: 8000 });
          if (view.ready) await page.locator(view.ready).waitFor({ timeout: 8000 });
          await settle(page, view.id === "market" ? 250 : 120);
          const audit = await page.evaluate(auditInPage);
          results.push({ view: view.id, label: view.label, width: bp.width, height: bp.height, ...audit });
        } catch (error) {
          results.push({ view: view.id, label: view.label, width: bp.width, height: bp.height, error: String(error.message || error).split("\n")[0] });
        }
      }
    }

    const summary = VIEWS.map((view) => {
      const row = { view: view.id, label: view.label };
      let total = 0;
      for (const bp of BREAKPOINTS) {
        const r = results.find((item) => item.view === view.id && item.width === bp.width);
        if (r.error) {
          row[`w${bp.width}`] = { error: r.error };
          continue;
        }
        const tableViolations = r.tables.filter((t) => !t.inheritedOnly).length;
        const count = r.failureCount + tableViolations;
        row[`w${bp.width}`] = {
          failures: r.failureCount,
          roots: r.rootOffenderCount,
          scrolled: r.scrolledContentCount,
          tables: tableViolations,
          pageOverflow: r.pageOverflow,
        };
        total += count;
      }
      row.total = total;
      return row;
    });
    const worst = [];
    for (const r of results) {
      if (r.error) continue;
      for (const el of r.elements) {
        worst.push({ view: r.view, label: r.label, width: r.width, ...el });
      }
    }
    worst.sort((a, b) => b.overflowPx - a.overflowPx);

    const report = {
      generated_at: new Date().toISOString(),
      base_url: baseUrl,
      server: serverMode,
      browser: await browser.version(),
      breakpoints: BREAKPOINTS.map((b) => b.width),
      views: VIEWS,
      results,
      summary,
      worst_top10: worst.slice(0, 10),
      browser_errors: browserErrors,
    };
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    if (serverProc) serverProc.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
