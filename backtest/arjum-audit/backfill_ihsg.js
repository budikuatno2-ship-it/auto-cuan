'use strict';
const fs = require('fs');
const path = require('path');

// Load environment variables (.env / .env.local)
try {
  const envCandidates = [
    '/home/ubuntu/auto-cuan-runner/.env',
    '/home/ubuntu/auto-cuan/.env',
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '.env.local')
  ];
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq > 0) {
          const k = t.slice(0, eq).trim();
          let v = t.slice(eq + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
          if (!process.env[k]) process.env[k] = v;
        }
      }
    }
  }
} catch (_) {}

const arjumClient = require('/home/ubuntu/auto-cuan/lib/arjum-client');

async function run() {
  console.log('=== BACKFILL IHSG (500 BARS) ===');
  const endpoint = '/api/history/IHSG?limit=500&frame=daily';
  const res = await arjumClient.fetchArjum(endpoint, { fresh: true, forceLive: true, noFallback: true });

  console.log('HTTP Status:', res.status, 'ok:', res.ok);
  if (!res.ok || !res.data) {
    console.error('Failed to fetch IHSG history:', res.error);
    process.exit(1);
  }

  const rawRows = Array.isArray(res.data) ? res.data : (res.data.rows || res.data.candles || res.data.history || []);
  console.log('Raw rows received:', rawRows.length);

  // Normalize: oldest-first, handle nulls for volume and value if empty
  const candles = [];
  const dateSet = new Set();
  let duplicateDates = 0;
  let ohlcViolations = 0;

  for (const r of rawRows) {
    const d = String(r.date || r.t || r.time || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;

    if (dateSet.has(d)) {
      duplicateDates++;
      continue;
    }
    dateSet.add(d);

    const o = Number(r.open != null ? r.open : r.o);
    const h = Number(r.high != null ? r.high : r.h);
    const l = Number(r.low != null ? r.low : r.l);
    const c = Number(r.close != null ? r.close : r.c);

    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;

    // L <= O, C <= H, L <= H
    if (l > o || l > c || h < o || h < c || l > h) {
      ohlcViolations++;
    }

    const rawVol = r.volume != null ? r.volume : r.v;
    const volNum = Number(rawVol);
    const volume = (rawVol != null && String(rawVol).trim() !== '' && Number.isFinite(volNum)) ? volNum : null;

    const rawVal = r.value != null ? r.value : r.val;
    const valNum = Number(rawVal);
    const value = (rawVal != null && String(rawVal).trim() !== '' && Number.isFinite(valNum)) ? valNum : null;

    const row = {
      date: d,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: volume
    };
    if (value != null) row.value = value;
    if (r.freq != null && Number.isFinite(Number(r.freq))) row.frequency = Number(r.freq);

    candles.push(row);
  }

  // Sort oldest first
  candles.sort((a, b) => a.date.localeCompare(b.date));

  const firstDate = candles.length ? candles[0].date : null;
  const lastDate = candles.length ? candles[candles.length - 1].date : null;

  console.log('Quality check:');
  console.log({
    totalCandles: candles.length,
    firstDate,
    lastDate,
    duplicateDates,
    ohlcViolations,
    lastCandleIs16Oct: lastDate === '2026-10-16',
    sampleLastCandle: candles[candles.length - 1]
  });

  const payload = {
    ticker: 'IHSG',
    symbol: 'IHSG',
    source: 'arjum',
    range: `${candles.length}d`,
    interval: 'daily',
    candles
  };

  const targetPath = '/home/ubuntu/auto-cuan/data/daily-candles/IHSG.json';
  fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Saved IHSG candle history to: ${targetPath} (${fs.statSync(targetPath).size} bytes)`);
}

run().catch(console.error);
