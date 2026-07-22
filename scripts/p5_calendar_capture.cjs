#!/usr/bin/env node
/* P5.1 option C official calendar capture (user approved arranging this
 * evidence on 2026-07-22). Bounded: exactly 1 GET of the official
 * holidaySchedule endpoint, same bounded pattern as p5_trial_capture.cjs.
 * Records method/url/timestamp/bytes/sha256 for same-work-unit binding.
 * Raw capture is caller-owned external evidence under outputs/ (gitignored).
 */
const { chromium } = require('playwright-core');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'outputs', 'p5-trial-capture');
const CALENDAR_URL = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule';

function sha256(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
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

  const res = await request.get(CALENDAR_URL, { timeout: 60000 });
  const body = await res.body();
  await browser.close();

  const file = 'holidaySchedule.json';
  fs.writeFileSync(path.join(OUT_DIR, file), body);

  const result = {
    schema: 'tw-quant-engine-p5-calendar-capture-raw/v1',
    approved_by: 'user',
    approval_note:
      '2026-07-22 user approval to arrange the remaining option C pre-activation evidence; exactly 1 calendar GET, same bounded pattern as the 2308 trial capture',
    method: 'GET',
    url: CALENDAR_URL,
    fetched_at: fetchedAt,
    http_status: res.status(),
    content_type: res.headers()['content-type'] || null,
    bytes: body.length,
    sha256: sha256(body),
    raw_file: `outputs/p5-trial-capture/${file}`,
  };
  console.log(JSON.stringify(result, null, 2));
})().catch((err) => {
  console.error('CALENDAR_CAPTURE_FAILED:', err.message);
  process.exit(1);
});
