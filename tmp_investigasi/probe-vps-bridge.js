'use strict';
// READ-ONLY: inspect what the VPS HTTP bridge actually serves (no writes).
const BASE = process.env.VPS_DATA_API_BASE || 'https://wishing-challenged-deeper-crown.trycloudflare.com';

async function getJson(path) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const res = await fetch(BASE + path, { signal: c.signal });
    clearTimeout(t);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, ok: res.ok, len: text.length, json, head: text.slice(0, 200) };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

async function main() {
  console.log('BASE =', BASE);

  const dates = await getJson('/api/available-dates?ticker=BBCA');
  if (dates.error) return console.log('available-dates ERROR:', dates.error);
  const list = (dates.json && dates.json.dates) || [];
  console.log('available-dates status=', dates.status, 'count=', list.length);
  console.log('  first5=', JSON.stringify(list.slice(0, 5)));
  console.log('  last3=', JSON.stringify(list.slice(-3)));
  console.log('  contains latest =', list.includes('latest'));

  const latest = await getJson('/api/broker-summary?ticker=BBCA&date=latest');
  if (latest.error) return console.log('broker-summary ERROR:', latest.error);
  console.log('broker-summary(latest) status=', latest.status, 'keys=', latest.json ? Object.keys(latest.json) : null);
  if (latest.json) {
    console.log('  date=', latest.json.date, '| broker_start_date=', latest.json.broker_start_date,
      '| stock_code=', latest.json.stock_code, '| brokers=', Array.isArray(latest.json.brokers) ? latest.json.brokers.length : null);
  }

  const d11 = await getJson('/api/broker-summary?ticker=BBCA&date=2026-09-11');
  console.log('broker-summary(2026-09-11) status=', d11.status, 'keys=', d11.json ? Object.keys(d11.json) : null,
    'date=', d11.json && d11.json.date);
}

main().catch(e => console.error('PROBE ERROR', e));
