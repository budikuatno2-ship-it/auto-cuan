'use strict';
// READ-ONLY: is the repo's data/ folder actually deployed and publicly served?
const HOST = 'https://auto-cuan.vercel.app';
const PATHS = [
  '/data/bandarmologi-intel-indexes/latest_7d.json',
  '/data/broker-hunter-indexes/AK_7d.json',
  '/data/arjum-data/broker-summary/BBCA/2026-09-14.json',
  '/data/arjum-data/broker-summary/BBCA/latest.json',
  '/data/arjum-data/broker-summary/CUAN/2026-09-11.json',
  '/data/arjum-data/broker-summary/BBCA/',
  '/data/daytrade-ohlcv-cache/CUAN.json',
  '/vercel.json',
  '/.gitignore',
  '/package.json'
];

async function head(p) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 20000);
    const res = await fetch(HOST + p, { signal: c.signal });
    clearTimeout(t);
    const body = await res.text();
    return { status: res.status, len: body.length, sniff: body.slice(0, 90).replace(/\n/g, ' ') };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

async function main() {
  for (const p of PATHS) {
    const r = await head(p);
    console.log(p, '->', JSON.stringify(r));
  }
}
main().catch(e => console.error('PROBE ERROR', e));
