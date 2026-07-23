#!/usr/bin/env node
/* P5.1 option B trial capture: STOCK_DAY_ALL forward-accumulation source
 * (user selected option B on 2026-07-22). Bounded: exactly 1 GET of the
 * official OpenAPI daily snapshot. Records timestamp/bytes/sha256/
 * content-type/encoding and probes the schema and latest-day semantics.
 * Raw capture is caller-owned external evidence under outputs/ (gitignored).
 */
const { chromium } = require('playwright-core');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'outputs', 'p5-trial-capture');
const URL = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';

function sha256(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function probeEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8-bom';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf-8';
  } catch {
    return 'not-utf-8';
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    locale: 'zh-TW',
  });
  const request = context.request;
  const fetchedAt = new Date().toISOString();

  const res = await request.get(URL, { timeout: 60000 });
  const body = await res.body();
  await browser.close();

  const dateTag = fetchedAt.slice(0, 10).replace(/-/g, '');
  const file = `STOCK_DAY_ALL_${dateTag}.json`;
  fs.writeFileSync(path.join(OUT_DIR, file), body);

  // Schema and latest-day semantics probe.
  let probe = { parse_ok: false };
  try {
    const rows = JSON.parse(new TextDecoder('utf-8').decode(body));
    if (Array.isArray(rows) && rows.length > 0) {
      const keys = Object.keys(rows[0]);
      const dateKeys = keys.filter((k) => /日期|date/i.test(k));
      probe = {
        parse_ok: true,
        row_count: rows.length,
        keys,
        date_field_present: dateKeys.length > 0 ? dateKeys : null,
        date_values_sample: dateKeys.length
          ? [...new Set(rows.map((r) => r[dateKeys[0]]))].slice(0, 5)
          : null,
        sample_row: rows.find((r) => String(r[keys[0]]).trim() === '2308') || rows[0],
      };
    }
  } catch (err) {
    probe = { parse_ok: false, error: err.message };
  }

  const result = {
    schema: 'tw-quant-engine-p5-stock-day-all-capture-raw/v1',
    approved_by: 'user',
    approval_note:
      '2026-07-22 user selection of option B (forward accumulation); exactly 1 bounded GET of the official daily snapshot, same pattern as the 2308 trial capture',
    method: 'GET',
    url: URL,
    fetched_at: fetchedAt,
    http_status: res.status(),
    content_type: res.headers()['content-type'] || null,
    bytes: body.length,
    sha256: sha256(body),
    encoding_probe: probeEncoding(body),
    raw_file: `outputs/p5-trial-capture/${file}`,
    probe,
  };
  console.log(JSON.stringify(result, null, 2));
})().catch((err) => {
  console.error('STOCK_DAY_ALL_CAPTURE_FAILED:', err.message);
  process.exit(1);
});
