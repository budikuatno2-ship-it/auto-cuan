'use strict';
// READ-ONLY: detect DEPLOYMENT DRIFT — is production serving HEAD?
const fs = require('node:fs');
const path = require('node:path');
const HOST = 'https://auto-cuan.vercel.app';

async function text(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 30000);
    const res = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return { status: res.status, body: await res.text() };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

const local = fs.readFileSync(path.join(__dirname, '..', 'public', 'bandarmologi-runtime.js'), 'utf8');
const probes = [
  'PR2 fix: safeTicker MUST be declared before any use',
  'PR3 fix: the range MUST be part of the cache key',
  'collectAvailableDateOptions',
  'latest_' + "${'bandarIntelRange'}"
];

async function main() {
  const r = await text(`${HOST}/bandarmologi-runtime.js`);
  if (r.error) return console.log('ERR', r.error);
  console.log('prod bandarmologi-runtime.js status=', r.status, 'bytes=', r.body.length, 'local bytes=', local.length);
  for (const p of ['PR2 fix: safeTicker', 'PR3 fix: the range MUST be part of the cache key', 'collectAvailableDateOptions', 'function renderBrokerDateSelectHtml', 'initBrokerDateSelect']) {
    console.log(`prod contains "${p}" =`, r.body.includes(p), '| local =', local.includes(p));
  }
  // did prod frontend ever pass range to the API?
  const i = r.body.indexOf('/api/sector-hot?action=bandarmologi-intel&range=');
  console.log('prod intel URL builder snippet:', JSON.stringify(r.body.slice(i, i + 260)));

  const idx = r.body.indexOf('?action=available-dates');
  console.log('prod available-dates snippet:', JSON.stringify(r.body.slice(idx - 260, idx + 160)));

  const appJson = await text(`${HOST}/api/sector-hot?action=available-dates&ticker=BBCA`);
  console.log('\nprod available-dates BBCA:', appJson.body);
}

main().catch(e => console.error('PROBE ERROR', e));
