'use strict';
// READ-ONLY: CUAN has 172 dated files — are explicit-date responses distinct?
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

async function main() {
  const dates = ['2026-09-14', '2026-09-11', '2026-09-10', '2026-09-09', '2026-09-08'];
  for (const d of dates) {
    const j = await getJson(`${HOST}/api/sector-hot?action=bandarmologi&ticker=CUAN&range=1d&date=${d}`);
    const bs = j.broker_summary || {};
    console.log(`${d}: from_disk=${j.from_disk} bs.date=${bs.date} buyers=${(bs.top_buyers || []).length} top=${((bs.top_buyers || [])[0] || {}).broker} bval=${((bs.top_buyers || [])[0] || {}).bval} net_flow=${bs.net_flow}`);
  }
  console.log('\n--- CUAN multi-day ---');
  for (const r of ['1d', '5d', '7d', '30d']) {
    const j = await getJson(`${HOST}/api/sector-hot?action=bandarmologi&ticker=CUAN&range=${r}`);
    const bs = j.broker_summary || {};
    console.log(`${r}: bs.date=${bs.date} total_buy_val=${bs.total_buy_val} headers=${(bs.date_headers || []).length} buyers=${(bs.top_buyers || []).length}`);
  }
}
main().catch(e => console.error('PROBE ERROR', e));
