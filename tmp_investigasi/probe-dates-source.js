'use strict';
// READ-ONLY: distinguish "only latest.json exists" from "dated files exist".
// If a ticker has real dated files, explicit-date requests must return DIFFERENT payloads.
const HOST = 'https://auto-cuan.vercel.app';

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

function sig(bs) {
  if (!bs) return 'null';
  return `${bs.total_buy_val}|${bs.net_flow}|${(bs.top_buyers || []).length}`;
}

async function probeTicker(t) {
  const ad = await getJson(`${HOST}/api/sector-hot?action=available-dates&ticker=${t}`);
  const dates = (ad.dates || []);
  const picks = dates.slice(0, 4);
  const sigs = [];
  for (const d of picks) {
    const j = await getJson(`${HOST}/api/sector-hot?action=bandarmologi&ticker=${t}&range=1d&date=${d}`);
    sigs.push(`${d}=>${sig(j.broker_summary)}`);
  }
  const uniq = new Set(sigs.map(s => s.split('=>')[1]));
  console.log(`\n${t}: available-dates=${dates.length} head=${JSON.stringify(picks)}`);
  sigs.forEach(s => console.log('   ', s));
  console.log(`   unique payloads among ${picks.length} dates = ${uniq.size}`);
}

async function main() {
  for (const t of ['BBCA', 'CUAN', 'PTRO', 'TLKM', 'ASII']) {
    await probeTicker(t);
  }
}
main().catch(e => console.error('PROBE ERROR', e));
