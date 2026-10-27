'use strict';
/**
 * Runner Dua Skenario v2 — seluruh bursa.
 *   node run-v2.js <folder_data> [jumlah_sampel=3000] [seed=42]
 * <folder_data>: satu file <TICKER>.json per saham, isi array {date, open, high, low, close, volume}.
 * Output:
 *   hasil-v2-evaluasi.json  — skor seluruh bursa (semua & out-of-sample), kalibrasi, per tahun, per kelompok likuiditas, gerbang
 *   hasil-v2-proyeksi.json  — proyeksi terbaru SETIAP saham + status tampil (ini yang dipakai job harian)
 */
const fs = require('fs'), path = require('path');
const DS = require('./dua-skenario-v2.js');
const [, , dir, nArg, seedArg] = process.argv;
if (!dir) { console.error('Pakai: node run-v2.js <folder_data> [sampel] [seed]'); process.exit(1); }
const t0 = Date.now(), log = (...a) => console.log('[' + ((Date.now() - t0) / 1000).toFixed(0) + 's]', ...a);

const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json'));
const series = [], skipped = [];
for (const f of files) {
  const tk = f.replace(/\.json$/i, '').toUpperCase();
  try { const s = DS.prepareSeries(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), tk); if (s.c.length >= 300) series.push(s); else skipped.push(tk + ' (' + s.c.length + ' bar bersih)'); }
  catch (e) { skipped.push(tk + ' (gagal dibaca: ' + e.message + ')'); }
}
log('Saham dipakai:', series.length, '| dilewati:', skipped.length);
const ix = DS.buildIndex(series); log('Indeks jendela:', ix.N.toLocaleString('id-ID'));

const rows = DS.evaluateSample(ix, { samples: Number(nArg || 3000), seed: Number(seedArg || 42) }); log('Sampel dievaluasi:', rows.length);
const dates = rows.map(r => r.date).sort(), cut = dates[Math.floor(dates.length * 0.7)];
const all = DS.score(rows), oos = DS.score(rows.filter(r => r.date >= cut)), g = DS.gate(oos);
const byYear = {}; rows.forEach(r => (byYear[r.date.slice(0, 4)] = byYear[r.date.slice(0, 4)] || []).push(r));
const liqOf = (r) => { const s = series.find(x => x.ticker === r.ticker); return s.liq[r.t]; };
const buckets = { '1–10 M': [], '10–100 M': [], '>100 M': [] };
rows.forEach(r => { const l = liqOf(r) / 1e9; (l < 10 ? buckets['1–10 M'] : l < 100 ? buckets['10–100 M'] : buckets['>100 M']).push(r); });
const ev = { generatedFrom: dir, stocks: series.length, skipped, windows: ix.N, params: ix.opt, samples: rows.length, cutOOS: cut, all, oos, gate: g,
  byYear: Object.fromEntries(Object.entries(byYear).sort().map(([y, rs]) => { const s = DS.score(rs); return [y, { n: s.n, hitRate: s.hitRate, brierSkill: s.brierSkill }]; })),
  byLiquidity: Object.fromEntries(Object.entries(buckets).map(([k, rs]) => { const s = DS.score(rs); return [k, { n: s.n, brierSkill: s.brierSkill, skillCI95: s.skillCI95 }]; })) };
fs.writeFileSync('hasil-v2-evaluasi.json', JSON.stringify(ev, null, 1));
log('SEMUA  n', all.n, 'skill', all.brierSkill, 'CI95', JSON.stringify(all.skillCI95), 'hit', all.hitRate, 'p10–p90', all.range10_90);
log('OOS≥' + cut, 'n', oos.n, 'skill', oos.brierSkill, 'CI95', JSON.stringify(oos.skillCI95), 'hit', oos.hitRate, 'p10–p90', oos.range10_90);
log('Kalibrasi OOS', JSON.stringify(oos.calibration));
log('GERBANG', JSON.stringify(g));

// Proyeksi terbaru untuk SETIAP saham (mode job harian)
const latest = series.map((s, si) => {
  const p = DS.project(ix, si, s.c.length - 1);
  p.display = p.status !== 'OK' ? 'SEMBUNYIKAN' : (g.directionAllowed ? 'DUA_SKENARIO' : (g.rangeAllowed ? 'RENTANG_SAJA' : 'SEMBUNYIKAN'));
  return p;
});
fs.writeFileSync('hasil-v2-proyeksi.json', JSON.stringify({ asOf: latest.map(p => p.date).sort().pop(), gate: g, items: latest }, null, 1));
const cnt = {}; latest.forEach(p => { cnt[p.display] = (cnt[p.display] || 0) + 1; });
log('Proyeksi terbaru:', JSON.stringify(cnt), '→ hasil-v2-proyeksi.json');
