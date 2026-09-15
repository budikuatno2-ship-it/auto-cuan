'use strict';
// READ-ONLY: does prod return the SAME payload for different requested dates (latest.json fallback)?
const HOST = 'https://auto-cuan.vercel.app';
const BRIDGE = 'https://wishing-challenged-deeper-crown.trycloudflare.com';

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

function fp(bs) {
  if (!bs) return null;
  const top = (bs.top_buyers || []).slice(0, 3).map(b => `${b.broker}:${b.bval}`).join(',');
  return { date: bs.date, total_buy_val: bs.total_buy_val, net_flow: bs.net_flow, top3: top };
}

async function main() {
  console.log('--- PROD BBCA per-date payload fingerprints ---');
  const dates = ['2026-09-14', '2026-09-11', '2026-09-10', '2026-08-31', '2026-07-31'];
  const prints = {};
  for (const d of dates) {
    const j = await getJson(`${HOST}/api/sector-hot?action=bandarmologi&ticker=BBCA&range=1d&date=${d}`);
    prints[d] = fp(j.broker_summary);
    console.log(d, JSON.stringify(prints[d]));
  }
  const allSame = dates.every(d => prints[d] && prints['2026-09-14'] &&
    prints[d].total_buy_val === prints['2026-09-14'].total_buy_val);
  console.log('ALL DATES IDENTICAL PAYLOAD =', allSame);

  console.log('\n--- VPS BRIDGE BBCA reference (true per-date data) ---');
  for (const d of ['2026-09-14', '2026-09-11', '2026-09-10']) {
    const j = await getJson(`${BRIDGE}/api/broker-summary?ticker=BBCA&date=${d}`);
    let v = 0;
    for (const b of (j.brokers || [])) { v += Number(b.bval || 0); }
    console.log(d, 'start=', j.broker_start_date, 'sum_bval=', v);
  }

  console.log('\n--- PROD intel: Emiten Aktif (ticker) vs Market Scanner (scanner) same range ---');
  const tickerForm = await getJson(`${HOST}/api/sector-hot?action=bandarmologi-intel&range=7d&ticker=CUAN`);
  const s1 = tickerForm.result && tickerForm.result.signals && tickerForm.result.signals.harga_di_bawah_modal_bandar;
  console.log('ticker=CUAN 7d -> current_price=', s1 && s1.current_price, 'bandar_avg_buy=', s1 && s1.bandar_avg_buy,
    'discount_pct=', s1 && s1.discount_pct);
  const scan = await getJson(`${HOST}/api/sector-hot?action=bandarmologi-intel&range=7d`);
  const row = ((scan.indexes && scan.indexes.harga_di_bawah_modal_bandar) || []).find(x => x.ticker === 'CUAN');
  console.log('scanner 7d CUAN -> current_price=', row && row.current_price, 'bandar_avg_buy=', row && row.bandar_avg_buy,
    'discount_pct=', row && row.discount_pct);
  console.log('SAME TICKER, SAME RANGE, DIFFERENT VIEW -> price equal =',
    s1 && row && s1.current_price === row.current_price);

  const tickerPTRO = await getJson(`${HOST}/api/sector-hot?action=bandarmologi-intel&range=7d&ticker=PTRO`);
  const p1 = tickerPTRO.result && tickerPTRO.result.signals && tickerPTRO.result.signals.harga_di_bawah_modal_bandar;
  const rowP = ((scan.indexes && scan.indexes.harga_di_bawah_modal_bandar) || []).find(x => x.ticker === 'PTRO');
  console.log('PTRO ticker-form price=', p1 && p1.current_price, 'vs scanner price=', rowP && rowP.current_price);
}

main().catch(e => console.error('PROBE ERROR', e));
