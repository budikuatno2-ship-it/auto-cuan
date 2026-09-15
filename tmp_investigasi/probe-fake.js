'use strict';
// READ-ONLY: are production per-date broker-summary files DISTINCT snapshots?
const HOST = 'https://auto-cuan.vercel.app';
const BRIDGE = 'https://wishing-challenged-deeper-crown.trycloudflare.com';

async function getJson(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 25000);
    const res = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) { return { _raw: text.slice(0, 140) }; }
  } catch (e) { return { _err: String((e && e.message) || e) }; }
}

async function main() {
  const dates = ['2026-09-14', '2026-09-11', '2026-09-10', '2026-09-09', '2026-09-08', '2026-09-07', '2026-09-04', '2026-08-31', '2026-08-03', '2026-07-31', '2026-06-19'];
  const sig = {};
  for (const d of dates) {
    const j = await getJson(`${HOST}/api/sector-hot?action=bandarmologi&ticker=BBCA&range=1d&date=${d}`);
    const bs = j.broker_summary || {};
    const top3 = (bs.top_buyers || []).slice(0, 3).map(b => `${b.broker}:${b.bval}`).join('|');
    sig[d] = `${bs.total_buy_val}|${bs.net_flow}|${top3}|buyers=${(bs.top_buyers || []).length}`;
  }
  const uniq = new Set(Object.values(sig));
  for (const d of dates) console.log(d, sig[d]);
  console.log('\nrequested dates =', dates.length, 'unique payload signatures =', uniq.size);

  const b = await getJson(`${BRIDGE}/api/broker-summary?ticker=BBCA&date=2026-06-19`);
  let v = 0, n = 0;
  for (const x of (b.brokers || [])) { v += Number(x.bval || 0); n++; }
  console.log('\nBRIDGE 2026-06-19: start=', b.broker_start_date, 'start/end=', b.broker_start_date, b.broker_end_date, 'brokers=', n, 'sum_bval=', v);
}

main().catch(e => console.error('PROBE ERROR', e));
