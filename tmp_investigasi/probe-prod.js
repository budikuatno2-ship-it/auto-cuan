'use strict';
// READ-ONLY: probe the DEPLOYED production API responses (GET only).
const HOSTS = ['https://auto-cuan.id', 'https://auto-cuan.vercel.app'];
const PATHS = [
  '/api/sector-hot?action=available-dates&ticker=BBCA',
  '/api/sector-hot?action=bandarmologi&ticker=BBCA&range=1d',
  '/api/sector-hot?action=bandarmologi&ticker=BBCA&range=7d',
  '/api/sector-hot?action=bandarmologi-intel&range=7d'
];

async function grab(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 20000);
    const res = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'audit-readonly' } });
    clearTimeout(t);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, text, json };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

async function main() {
  for (const host of HOSTS) {
    console.log('===== HOST', host);
    for (const p of PATHS) {
      const r = await grab(host + p);
      if (r.error) { console.log(p, 'ERROR', r.error); continue; }
      const j = r.json;
      const summary = {
        status: r.status,
        len: r.text.length,
        success: j && j.success,
        error: j && j.error,
        is_empty: j && j.is_empty,
        is_offline: j && j.is_offline,
        is_demo: j && j.is_demo,
        demo_reason: j && j.demo_reason,
        range: j && j.range,
        date: j && j.date,
        dates_count: j && Array.isArray(j.dates) ? j.dates.length : undefined,
        dates_head: j && Array.isArray(j.dates) ? j.dates.slice(0, 5) : undefined,
        available_dates_count: j && Array.isArray(j.available_dates) ? j.available_dates.length : undefined,
        available_dates_head: j && Array.isArray(j.available_dates) ? j.available_dates.slice(0, 5) : undefined,
        bs_date: j && j.broker_summary && j.broker_summary.date,
        bs_headers: j && j.broker_summary && Array.isArray(j.broker_summary.date_headers) ? j.broker_summary.date_headers.length : undefined,
        updated_at: j && j.updated_at,
        counts: j && j.summary
      };
      console.log('\n--', p);
      console.log(JSON.stringify(summary));
      if (!j) console.log('   RAW HEAD:', r.text.slice(0, 300));
    }
  }
}

main().catch(e => console.error('PROBE ERROR', e));
