'use strict';
// READ-ONLY: exact response shape for a ticker with NO shipped snapshot (CUAN)
// vs one WITH a snapshot (BBCA).
const HOST = 'https://auto-cuan.vercel.app';

async function getJson(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 25000);
    const res = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) { return { _raw: text.slice(0, 200) }; }
  } catch (e) { return { _err: String((e && e.message) || e) }; }
}

async function main() {
  for (const t of ['BBCA', 'CUAN']) {
    const j = await getJson(`${HOST}/api/sector-hot?action=bandarmologi&ticker=${t}&range=1d`);
    console.log(`\n=== ${t} ===`);
    console.log('success=', j.success, 'from_disk=', j.from_disk, 'is_empty=', j.is_empty,
      'status=', j.status, 'is_offline=', j.is_offline, 'demo_reason=', j.demo_reason);
    console.log('date=', j.date, 'range=', j.range);
    console.log('available_dates len=', (j.available_dates || []).length,
      'head=', JSON.stringify((j.available_dates || []).slice(0, 5)));
    console.log('bs.date=', j.broker_summary && j.broker_summary.date,
      'top_buyers=', ((j.broker_summary && j.broker_summary.top_buyers) || []).length);
  }
}
main().catch(e => console.error('PROBE ERROR', e));
