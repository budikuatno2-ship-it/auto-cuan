'use strict';
// READ-ONLY: which broker-summary dates actually EXIST in the production cache dir?
const HOST = 'https://auto-cuan.vercel.app';
const TICKERS = ['BBCA', 'CUAN', 'PTRO', 'PSAB', 'TKIM', 'TLKM', 'ASII'];
const DATES = ['2026-09-14', '2026-09-11', '2026-09-10', '2026-09-09', '2026-09-08', '2026-08-31', '2026-07-31'];

async function getJson(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 25000);
    const res = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) { return { _raw: text.slice(0, 120) }; }
  } catch (e) { return { _err: String((e && e.message) || e) }; }
}

async function main() {
  console.log('--- available-dates count per ticker (production) ---');
  for (const t of TICKERS) {
    const j = await getJson(`${HOST}/api/sector-hot?action=available-dates&ticker=${t}`);
    console.log(`${t}: count=${j && Array.isArray(j.dates) ? j.dates.length : 'n/a'} first6=${JSON.stringify((j.dates || []).slice(0, 6))}`);
  }

  console.log('\n--- broker-summary per explicit date (BBCA) ---');
  for (const d of DATES) {
    const j = await getJson(`${HOST}/api/sector-hot?action=bandarmologi&ticker=BBCA&range=1d&date=${d}`);
    console.log(`${d}: from_disk=${j.from_disk} is_empty=${j.is_empty} bs.date=${j.broker_summary && j.broker_summary.date} buyers=${(j.broker_summary && j.broker_summary.top_buyers || []).length} avail=${JSON.stringify(j.available_dates)}`);
  }

  console.log('\n--- broker-summary per explicit date (PTRO) ---');
  for (const d of ['2026-09-14', '2026-09-11', '2026-09-10']) {
    const j = await getJson(`${HOST}/api/sector-hot?action=bandarmologi&ticker=PTRO&range=1d&date=${d}`);
    console.log(`${d}: from_disk=${j.from_disk} is_empty=${j.is_empty} bs.date=${j.broker_summary && j.broker_summary.date} buyers=${(j.broker_summary && j.broker_summary.top_buyers || []).length}`);
  }

  console.log('\n--- repeated available-dates BBCA (instance drift check) ---');
  for (let i = 0; i < 3; i++) {
    const j = await getJson(`${HOST}/api/sector-hot?action=available-dates&ticker=BBCA&_n=${i}${Date.now()}`);
    console.log(`run${i}: count=${j && Array.isArray(j.dates) ? j.dates.length : 'n/a'} dates=${JSON.stringify((j.dates || []).slice(0, 8))}`);
  }
}

main().catch(e => console.error('PROBE ERROR', e));
