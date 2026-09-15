'use strict';
// READ-ONLY forensic probe #2:
//  (a) price provenance for suspicious tickers (VPS bridge VWAP vs OHLCV cache vs baked index)
//  (b) whether timeframe ranges actually change the returned stock set
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.VPS_DATA_API_BASE || 'https://wishing-challenged-deeper-crown.trycloudflare.com';
const HOST = 'https://auto-cuan.vercel.app';
const TICKERS = ['CUAN', 'PSAB', 'TKIM', 'PTRO'];
const RANGES = ['1d', '5d', '7d', '14d', '30d', '60d'];

async function getJson(url, timeout) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout || 20000);
    const res = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) { return null; }
  } catch (_) { return null; }
}

function vwapFromSummary(js) {
  if (!js || !Array.isArray(js.brokers)) return null;
  let v = 0, q = 0;
  for (const b of js.brokers) {
    const bval = Number(b.bval || 0), bvol = Number(b.bvol || 0);
    if (bval > 0 && bvol > 0) { v += bval; q += bvol; }
  }
  return q > 0 ? Math.round(v / q) : null;
}

async function priceSection() {
  console.log('\n########## PRICE PROVENANCE ##########');
  const baked = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'bandarmologi-intel-indexes', 'latest_7d.json'), 'utf8'));
  const bakedS1 = (baked.indexes && baked.indexes.harga_di_bawah_modal_bandar) || [];

  for (const t of TICKERS) {
    const bridgeLatest = await getJson(`${BASE}/api/broker-summary?ticker=${t}&date=latest`, 12000);
    const bridgeToday = await getJson(`${BASE}/api/broker-summary?ticker=${t}&date=2026-09-14`, 12000);
    const ohlcvPath = path.join(__dirname, '..', 'data', 'daytrade-ohlcv-cache', `${t}.json`);
    let ohlcv = null;
    if (fs.existsSync(ohlcvPath)) {
      const j = JSON.parse(fs.readFileSync(ohlcvPath, 'utf8'));
      const c = (j.candles || [])[j.candles.length - 1];
      ohlcv = { updated_at: j.updated_at, last_date: c && c.date, last_close: c && c.close };
    }
    const b = bakedS1.find(x => x.ticker === t);
    console.log(`\n-- ${t}`);
    console.log('   bridge latest: start=', bridgeLatest && bridgeLatest.broker_start_date, 'end=', bridgeLatest && bridgeLatest.broker_end_date, 'VWAP=', vwapFromSummary(bridgeLatest));
    console.log('   bridge 2026-09-14: start=', bridgeToday && bridgeToday.broker_start_date, 'VWAP=', vwapFromSummary(bridgeToday));
    console.log('   local OHLCV cache:', JSON.stringify(ohlcv));
    console.log('   baked intel 7d: current_price=', b && b.current_price, 'bandar_avg_buy=', b && b.bandar_avg_buy);
  }
}

async function rangeSection() {
  console.log('\n########## TIMEFRAME IDENTITY ##########');
  for (const host of [HOST]) {
    for (const r of RANGES) {
      const j = await getJson(`${host}/api/sector-hot?action=bandarmologi-intel&range=${r}`, 25000);
      const idx = (j && j.indexes) || {};
      const s1 = (idx.harga_di_bawah_modal_bandar || []).map(x => x.ticker);
      const s2 = (idx.silent_foreign_accumulation || []).map(x => x.ticker);
      console.log(`${host} intel range=${r} updated_at=${j && j.updated_at} counts=${j && JSON.stringify(j.summary)}`);
      console.log(`    S1 first8=${JSON.stringify(s1.slice(0, 8))}`);
      console.log(`    S2=${JSON.stringify(s2)}`);
    }
  }
  for (const r of RANGES) {
    const j = await getJson(`${HOST}/api/sector-hot?action=bandarmologi&ticker=BBCA&range=${r}`, 25000);
    console.log(`prod bandarmologi range=${r} -> date="${j && j.date}" bs.date="${j && j.broker_summary && j.broker_summary.date}" avail=${j && Array.isArray(j.available_dates) ? j.available_dates.length : null} headers=${j && j.broker_summary && Array.isArray(j.broker_summary.date_headers) ? j.broker_summary.date_headers.length : null}`);
  }
}

async function main() {
  await priceSection();
  await rangeSection();
}

main().catch(e => console.error('PROBE ERROR', e));
