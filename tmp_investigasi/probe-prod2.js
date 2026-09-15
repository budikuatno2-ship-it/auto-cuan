'use strict';
// READ-ONLY: production provenance flags + raw date sources.
const HOST = 'https://auto-cuan.vercel.app';

async function getJson(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 25000);
    const res = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    const text = await res.text();
    try { return { json: JSON.parse(text), text }; } catch (_) { return { json: null, text }; }
  } catch (e) { return { error: String((e && e.message) || e) }; }
}

async function main() {
  const r = await getJson(`${HOST}/api/sector-hot?action=bandarmologi&ticker=BBCA&range=1d`);
  if (r.error) return console.log('ERR', r.error);
  const j = r.json;
  console.log('top-level keys:', JSON.stringify(Object.keys(j)));
  console.log('flags: success=', j.success, 'from_disk=', j.from_disk, 'from_cache=', j.from_cache,
    'live=', j.live, 'from_vps_tunnel=', j.from_vps_tunnel, 'is_empty=', j.is_empty,
    'is_offline=', j.is_offline, 'is_demo=', j.is_demo, 'demo_reason=', j.demo_reason);
  console.log('date=', j.date, '| range=', j.range);
  console.log('available_dates=', JSON.stringify(j.available_dates));
  console.log('broker_summary keys:', JSON.stringify(Object.keys(j.broker_summary || {})));
  console.log('bs.date=', j.broker_summary && j.broker_summary.date);
  console.log('bs.date_headers=', JSON.stringify((j.broker_summary && j.broker_summary.date_headers) || []));
  console.log('bs.total_buy_val=', j.broker_summary && j.broker_summary.total_buy_val,
    'bs.net_flow=', j.broker_summary && j.broker_summary.net_flow,
    'bs.top_buyers=', (j.broker_summary && j.broker_summary.top_buyers || []).length);
  console.log('broker_accumulation.series len=', ((j.broker_accumulation && j.broker_accumulation.series) || []).length);
  console.log('insiders len=', (j.insiders || []).length);

  const d = await getJson(`${HOST}/api/sector-hot?action=bandarmologi&ticker=BBCA&range=1d&date=2026-09-11`);
  console.log('\nPROBE date=2026-09-11 -> avail=', JSON.stringify(d.json && d.json.available_dates),
    'date=', d.json && d.json.date, 'bs.date=', d.json && d.json.broker_summary && d.json.broker_summary.date);

  const ad = await getJson(`${HOST}/api/sector-hot?action=available-dates&ticker=CUAN`);
  console.log('\navailable-dates CUAN ->', JSON.stringify(ad.json));
  const ad2 = await getJson(`${HOST}/api/sector-hot?action=available-dates&ticker=BBCA`);
  console.log('available-dates BBCA ->', JSON.stringify(ad2.json));
}

main().catch(e => console.error('PROBE ERROR', e));
