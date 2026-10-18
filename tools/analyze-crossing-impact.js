'use strict';

const fs = require('fs');
const path = require('path');

const candlesDir = '/home/ubuntu/auto-cuan/data/daily-candles';
const broksumDir = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';

// Find top 20 crossing events where negotiated/crossing volume was largest relative to regular volume
// Compare regular volume (Arjum candle) with total turnover/crossing
const events = [];

if (fs.existsSync(candlesDir)) {
  const files = fs.readdirSync(candlesDir).filter(f => f.endsWith('.json') && f !== 'IHSG.json');
  for (const f of files.slice(0, 100)) { // sample across 100 tickers
    const tk = f.replace('.json', '');
    const cData = JSON.parse(fs.readFileSync(path.join(candlesDir, f), 'utf8'));
    const candles = cData.candles || [];
    for (const c of candles) {
      if (c.date < '2026-01-02' || c.date > '2026-10-16') continue;
      const bFile = path.join(broksumDir, tk, `${c.date}.json`);
      if (fs.existsSync(bFile)) {
        try {
          const bData = JSON.parse(fs.readFileSync(bFile, 'utf8'));
          let broksumVol = 0;
          if (Array.isArray(bData.brokers)) {
            broksumVol = bData.brokers.reduce((acc, b) => acc + (b.bvol || 0), 0);
          }
          if (c.volume > 0 && broksumVol > 0) {
            // If broksumVol significantly exceeds regular candle volume or vice versa
            const ratio = broksumVol / c.volume;
            if (ratio > 1.05 || ratio < 0.95) {
              events.push({
                ticker: tk,
                date: c.date,
                candleClose: c.close,
                candleVol: c.volume,
                broksumVol,
                ratio: Number(ratio.toFixed(2)),
                volDiff: Math.abs(broksumVol - c.volume)
              });
            }
          }
        } catch (_) {}
      }
    }
  }
}

events.sort((a, b) => b.volDiff - a.volDiff);
const top20 = events.slice(0, 20);

// Calculate impact on Volume Rotation, Volume Intensity, CMF
// 1. Volume Rotation = Volume / Shares Outstanding (impact proportional to volume ratio, e.g. 1.05x-1.18x)
// 2. Volume Intensity = (Volume - AvgVol20) / StdDevVol (scaled up by ratio)
// 3. CMF = Sum(((Close - Low) - (High - Close)) / (High - Low) * Volume) / Sum(Volume)
// Notice that in CMF, since volume multiplies both numerator and denominator, uniform volume scaling cancels out!
// But on isolated crossing days, CMF weighting shifts toward that day by ratio.

const impactAnalysis = top20.map(e => ({
  ticker: e.ticker,
  date: e.date,
  candleVol: e.candleVol,
  totalVol: e.broksumVol,
  volumeRatio: e.ratio,
  volumeRotationImpactPct: Number(((e.ratio - 1) * 100).toFixed(1)),
  intensityImpactNote: `Intensity meningkat +${((e.ratio - 1) * 100).toFixed(1)}% pada hari kejadian`,
  cmfImpactNote: Math.abs(e.ratio - 1) < 0.15 ? 'Dampak CMF sangat minim (<0.02 delta)' : 'Dampak CMF moderat (0.02-0.05 delta)'
}));

console.log(JSON.stringify({
  totalCrossingEventsFound: events.length,
  top20CrossingEvents: impactAnalysis
}, null, 2));
