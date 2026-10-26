'use strict';
/**
 * Runner uji Dua Skenario. Pemakaian:
 *   node run-dua-skenario.js <target.json> [folder_universe] [stride]
 * target.json  : array bar {date:'YYYY-MM-DD', open, high, low, close, volume}, urut naik.
 * folder_universe (opsional): folder berisi <TICKER>.json format sama, sebagai kolam analog.
 * Hasil: dua-skenario-hasil.json di folder kerja + ringkasan di konsol.
 */
const fs = require('fs'), path = require('path');
const DS = require('./dua-skenario.js');

const [, , targetFile, uniDir, strideArg] = process.argv;
if (!targetFile) { console.error('Pakai: node run-dua-skenario.js <target.json> [folder_universe] [stride]'); process.exit(1); }
const stride = Number(strideArg || 1);
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).filter(b => b && b.close > 0 && b.high >= b.low && b.volume >= 0).sort((a, b) => a.date < b.date ? -1 : 1);

const tName = path.basename(targetFile).replace(/\.json$/i, '').toUpperCase();
const T = DS.prepare(load(targetFile)); T.ticker = tName;
let pool = [T];
if (uniDir) {
  for (const f of fs.readdirSync(uniDir).filter(f => f.endsWith('.json'))) {
    const tk = f.replace(/\.json$/i, '').toUpperCase(); if (tk === tName) continue;
    const c = load(path.join(uniDir, f)); if (c.length < 300) continue;
    const s = DS.prepare(c); s.ticker = tk; pool.push(s);
  }
}

function report(label, rows) {
  const c = T.c, cut = c[Math.floor(c.length * 0.7)].date;
  const all = DS.score(rows), oos = DS.score(rows.filter(r => r.date >= cut));
  const years = {}; rows.forEach(r => { (years[r.date.slice(0, 4)] = years[r.date.slice(0, 4)] || []).push(r); });
  const byYear = Object.fromEntries(Object.entries(years).map(([y, rs]) => { const s = DS.score(rs); return [y, s.n ? { n: s.n, hitRate: +s.hitRate.toFixed(3), brierSkill: +s.brierSkill.toFixed(3) } : { n: 0 }]; }));
  // gerbang pre-registered: proyeksi arah hanya boleh tampil di aplikasi bila semua terpenuhi pada out-of-sample
  const cal = oos.calibration || [];
  const lowBin = cal.find(b => b.range.startsWith('0-')), highBin = cal.find(b => b.range.startsWith('0.65'));
  const gate = {
    brierSkillPositive: oos.n > 0 && oos.brierSkill > 0,
    enoughIndependent: (oos.effectiveN || 0) >= 30,
    calibrationMonotone: !!(lowBin && highBin && highBin.actual > lowBin.actual),
  };
  gate.pass = gate.brierSkillPositive && gate.enoughIndependent && gate.calibrationMonotone;
  console.log('\n== ' + label + ' ==');
  console.log('Semua      n', all.n, '≈indep', all.effectiveN, 'hit', (all.hitRate * 100).toFixed(1) + '%', 'Brier skill', (all.brierSkill * 100).toFixed(1) + '%', 'band25-75', (all.band25_75 * 100).toFixed(0) + '%');
  console.log('OOS ≥' + cut + ' n', oos.n, '≈indep', oos.effectiveN, 'hit', oos.n ? (oos.hitRate * 100).toFixed(1) + '%' : '—', 'Brier skill', oos.n ? (oos.brierSkill * 100).toFixed(1) + '%' : '—');
  console.log('Kalibrasi OOS', JSON.stringify(cal));
  console.log('Gerbang tampil:', JSON.stringify(gate));
  return { label, cutOOS: cut, all, oos, byYear, gate };
}

const out = { target: tName, bars: T.c.length, from: T.c[0].date, to: T.c[T.c.length - 1].date, poolTickers: pool.length, params: DS.DEFAULTS, stride, runs: [] };
console.log(tName, T.c.length, 'bar', out.from, 's.d.', out.to, '| kolam analog:', pool.length, 'seri');
out.runs.push(report('Hanya ' + tName, DS.walkForward(T, [T], { stride })));
if (pool.length > 1) out.runs.push(report('Kolam ' + pool.length + ' saham', DS.walkForward(T, pool, { stride })));
out.latestSelf = DS.project(T, T.c.length - 1, [T]);
if (pool.length > 1) out.latestPool = DS.project(T, T.c.length - 1, pool);
fs.writeFileSync('dua-skenario-hasil.json', JSON.stringify(out, null, 1));
console.log('\nTersimpan: dua-skenario-hasil.json');
