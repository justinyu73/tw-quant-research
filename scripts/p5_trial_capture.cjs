#!/usr/bin/env node
/* P5.1 option C first trial capture (human-approved 2026-07-22).
 * Bounded: at most 2 market-data GETs (STOCK_DAY 2308 + one MI_INDEX session)
 * plus 1 interactive page load. Records sha256/bytes/encoding/schema probes.
 * Raw captures are caller-owned external evidence under outputs/ (gitignored).
 */
const { chromium } = require('playwright-core');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'outputs', 'p5-trial-capture');
const STOCK_NO = '2308';
const STOCK_DAY_MONTH = '20260701';
const MI_INDEX_DATES = ['20260721', '20260720', '20260717', '20260716', '20260715'];

function sha256(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function probeEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8-bom';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf-8';
  } catch {
    return 'not-utf-8-likely-big5-cp950';
  }
}

function headerLines(buf, enc) {
  if (enc === 'not-utf-8-likely-big5-cp950') return null;
  const text = new TextDecoder('utf-8').decode(buf);
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 5);
}

async function capture(request, url) {
  const res = await request.get(url, { timeout: 60000 });
  const body = await res.body();
  const enc = probeEncoding(body);
  return {
    record: {
      url,
      http_status: res.status(),
      content_type: res.headers()['content-type'] || null,
      bytes: body.length,
      sha256: sha256(body),
      encoding_probe: enc,
      header_lines: headerLines(body, enc),
    },
    body,
  };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    locale: 'zh-TW',
  });
  const page = await context.newPage();
  const request = context.request;
  const fetchedAt = new Date().toISOString();
  const result = {
    schema: 'tw-quant-engine-p5-trial-capture-raw/v1',
    approved_by: 'user',
    approval_note: '2026-07-22 user instruction: playwright verification with stock 2308',
    fetched_at: fetchedAt,
    captures: [],
    interactive_check: null,
  };

  // Interactive surface check: historical stock-day page (human-style entry point).
  const pageRes = await page.goto(
    'https://www.twse.com.tw/zh/trading/historical/stock-day.html',
    { waitUntil: 'domcontentloaded', timeout: 60000 }
  );
  result.interactive_check = {
    url: page.url(),
    http_status: pageRes.status(),
    title: await page.title(),
    reachable: pageRes.ok(),
  };

  // Capture 1: STOCK_DAY CSV for stock 2308, recent month.
  const stockDayUrl = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=csv&date=${STOCK_DAY_MONTH}&stockNo=${STOCK_NO}`;
  const c1 = await capture(request, stockDayUrl);
  const f1 = `STOCK_DAY_${STOCK_NO}_${STOCK_DAY_MONTH}.csv`;
  fs.writeFileSync(path.join(OUT_DIR, f1), c1.body);
  result.captures.push({ kind: 'stock_day_2308', raw_file: `outputs/p5-trial-capture/${f1}`, ...c1.record });

  // Capture 2: one MI_INDEX full-market session (option C endpoint probe).
  let mi = null;
  for (const d of MI_INDEX_DATES) {
    const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=csv&date=${d}&type=ALL`;
    const c = await capture(request, url);
    if (c.record.http_status === 200 && c.record.bytes > 1000) {
      // Store gzipped: raw MI_INDEX CSV exceeds the S9 audit 2 MB artifact cap.
      const f2 = `MI_INDEX_ALL_${d}.csv.gz`;
      fs.writeFileSync(path.join(OUT_DIR, f2), zlib.gzipSync(c.body, { level: 9 }));
      mi = { kind: 'mi_index_all', date: d, raw_file: `outputs/p5-trial-capture/${f2}`, ...c.record };
      break;
    }
  }
  result.captures.push(mi || { kind: 'mi_index_all', error: 'no_recent_session_returned_data' });

  await browser.close();

  const outPath = path.join(OUT_DIR, 'summary.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch((err) => {
  console.error('TRIAL_CAPTURE_FAILED:', err.message);
  process.exit(1);
});
