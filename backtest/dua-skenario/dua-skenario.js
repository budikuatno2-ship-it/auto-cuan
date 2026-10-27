'use strict';
/**
 * DUA SKENARIO — proyeksi analog berbasis riwayat (pure function, tanpa network / Date.now()).
 *
 * Ide: cari momen di masa lalu yang polanya paling mirip dengan 20 bar terakhir,
 * lihat apa yang terjadi H bar sesudahnya, lalu ringkas jadi 2 skenario (naik / turun).
 * Proyeksi HANYA dikeluarkan bila analognya cukup banyak DAN cukup mirip.
 *
 * Semua parameter ditetapkan di DEFAULTS sebelum evaluasi (pre-registered). Jangan disetel
 * berdasarkan hasil backtest — ubah hanya dengan alasan yang ditulis, lalu uji ulang penuh.
 */

const DEFAULTS = {
  L: 20,            // panjang pola yang dicocokkan (bar)
  H: 10,            // horizon proyeksi (bar)
  K: 30,            // jumlah analog yang diambil
  minGap: 10,       // jarak minimum antar-analog (bar) agar tidak menghitung episode yang sama dua kali
  warmup: 60,       // bar minimum sebelum fitur valid (SMA50, ATR14)
  minCandidates: 250, // riwayat minimum yang boleh dicari
  ctxWeight: 0.5,   // bobot fitur konteks terhadap bentuk harga
  minQuality: 0.35, // kualitas analog minimum (0..1) agar proyeksi ditampilkan
  minAnalogs: 15,   // analog sah minimum
};

// ---------- util ----------
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
function wquantile(vals, ws, q) {
  const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
  const tot = ws.reduce((s, x) => s + x, 0); let acc = 0;
  for (const i of idx) { acc += ws[i]; if (acc >= q * tot) return vals[i]; }
  return vals[idx[idx.length - 1]];
}
/** Fraksi harga IDX (papan utama/pengembangan). */
function tick(p) { return p < 200 ? 1 : p < 500 ? 2 : p < 2000 ? 5 : p < 5000 ? 10 : 25; }
function roundTick(p) { const t = tick(p); return Math.round(p / t) * t; }

// ---------- fitur per bar (hanya memakai data <= bar itu) ----------
function features(c) {
  const n = c.length, F = new Array(n).fill(null);
  const tr = c.map((b, i) => i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - c[i - 1].close), Math.abs(b.low - c[i - 1].close)));
  let atr = null;
  for (let i = 0; i < n; i++) {
    if (i === 13) atr = mean(tr.slice(0, 14)); else if (i > 13) atr = (atr * 13 + tr[i]) / 14; // Wilder
    if (i < DEFAULTS.warmup) continue;
    const sma50 = mean(c.slice(i - 49, i + 1).map(b => b.close));
    let mfv = 0, vol = 0;
    for (let j = i - 19; j <= i; j++) { const b = c[j], r = b.high - b.low; mfv += (r > 0 ? ((b.close - b.low) - (b.high - b.close)) / r : 0) * b.volume; vol += b.volume; }
    const turn = (j) => c[j].volume * c[j].close;
    const rot = (j) => { const w = []; for (let k = j - 19; k <= j; k++) w.push(turn(k)); w.sort((a, b) => a - b); const med = (w[9] + w[10]) / 2; return Math.log(turn(j) / med); };
    let rot5 = 0; for (let j = i - 4; j <= i; j++) rot5 += rot(j); rot5 /= 5;
    F[i] = {
      atrPct: atr / c[i].close,
      cmf: vol > 0 ? mfv / vol : 0,
      rot5,
      dist50: (c[i].close - sma50) / atr,
    };
  }
  return F;
}

function shape(c, e, L) {
  const p = []; for (let k = e - L + 1; k <= e; k++) p.push(Math.log(c[k].close / c[e].close));
  const m = mean(p), s = sd(p) || 1e-9; return p.map(x => (x - m) / s);
}

/** Siapkan satu seri: fitur + bentuk pola per bar (sekali hitung, dipakai ulang). */
function prepare(c, opt = {}) {
  const o = Object.assign({}, DEFAULTS, opt), F = features(c), S = new Array(c.length).fill(null);
  for (let e = o.warmup + o.L; e < c.length; e++) if (F[e]) S[e] = shape(c, e, o.L);
  return { c, F, S };
}

/**
 * Proyeksi untuk bar t pada seri `target`, mencari analog di `pool` (array seri hasil prepare;
 * boleh hanya seri itu sendiri, atau banyak saham). Analog sah hanya bila hasil H bar-nya sudah
 * diketahui sebelum tanggal t: tanggal bar (e + H) di seri kandidat <= tanggal bar t. Tanpa lookahead.
 */
function project(target, t, pool, opt = {}) {
  const o = Object.assign({}, DEFAULTS, opt), { L, H, K } = o, c = target.c;
  pool = pool || [target];
  const fq = target.F[t], q = target.S[t];
  if (!fq || !q) return { status: 'DATA_KURANG', reason: 'Riwayat sebelum bar ini terlalu pendek' };
  const dt = c[t].date, cands = [];
  pool.forEach((s, si) => { for (let e = o.warmup + L; e + H < s.c.length; e++) { if (!s.F[e] || s.c[e + H].date > dt) continue; if (s === target && e + H > t) continue; cands.push([si, e]); } });
  if (cands.length < o.minCandidates) return { status: 'DATA_KURANG', reason: 'Kandidat riwayat ' + cands.length + ' < ' + o.minCandidates };
  const keys = ['atrPct', 'cmf', 'rot5', 'dist50'], st = {};
  keys.forEach(k => { const v = cands.map(([si, e]) => pool[si].F[e][k]); st[k] = { s: sd(v) || 1 }; });
  const dist = cands.map(([si, e]) => {
    const s = pool[si].S[e], f = pool[si].F[e]; let ds = 0; for (let k = 0; k < L; k++) ds += (s[k] - q[k]) ** 2; ds = Math.sqrt(ds / L);
    let dc = 0; keys.forEach(k => { dc += ((f[k] - fq[k]) / st[k].s) ** 2; }); dc = Math.sqrt(dc / keys.length);
    return { si, e, d: ds + o.ctxWeight * dc };
  });
  const allMed = wquantile(dist.map(x => x.d), dist.map(() => 1), 0.5);
  dist.sort((a, b) => a.d - b.d);
  const pick = [];
  for (const x of dist) { if (pick.every(p => p.si !== x.si || Math.abs(p.e - x.e) >= o.minGap)) pick.push(x); if (pick.length === K) break; }
  const dMed = wquantile(pick.map(x => x.d), pick.map(() => 1), 0.5);
  const quality = Math.max(0, 1 - dMed / allMed);
  const w = pick.map(x => Math.exp(-((x.d / dMed) ** 2)));
  const paths = pick.map(x => { const s = pool[x.si], sc = fq.atrPct / s.F[x.e].atrPct, r = []; for (let h = 1; h <= H; h++) r.push(Math.log(s.c[x.e + h].close / s.c[x.e].close) * sc); return r; });
  const up = paths.map(p => p[H - 1] > 0);
  const wUp = w.reduce((s, x, i) => s + (up[i] ? x : 0), 0), wAll = w.reduce((s, x) => s + x, 0), pUp = wUp / wAll;
  const summarize = (sel) => {
    const ix = paths.map((p, i) => i).filter(sel); if (!ix.length) return null;
    const ws = ix.map(i => w[i]), pr = [], lo = [], hi = [];
    for (let h = 0; h < H; h++) { const v = ix.map(i => paths[i][h]); pr.push(wquantile(v, ws, 0.5)); lo.push(wquantile(v, ws, 0.25)); hi.push(wquantile(v, ws, 0.75)); }
    const P = (r) => r.map(x => roundTick(c[t].close * Math.exp(x)));
    return { n: ix.length, median: P(pr), p25: P(lo), p75: P(hi), endPct: (Math.exp(pr[H - 1]) - 1) * 100 };
  };
  const A = summarize(i => up[i]), B = summarize(i => !up[i]);
  const ok = quality >= o.minQuality && pick.length >= o.minAnalogs, k3 = Math.min(2, H - 1);
  return {
    status: ok ? 'OK' : 'ANALOG_LEMAH',
    reason: ok ? null : 'Kualitas analog ' + quality.toFixed(2) + ' (< ' + o.minQuality + ') atau analog < ' + o.minAnalogs,
    date: dt, close: c[t].close, H, nAnalogs: pick.length, nCandidates: cands.length, quality, pUp, pDown: 1 - pUp,
    scenarioA: A, scenarioB: B, confirmA: A ? A.median[k3] : null, confirmB: B ? B.median[k3] : null,
    analogs: pick.slice(0, 8).map((x, i) => ({ ticker: pool[x.si].ticker || null, date: pool[x.si].c[x.e].date, distance: +x.d.toFixed(3), fwdPct: +((Math.exp(paths[i][H - 1]) - 1) * 100).toFixed(2) })),
  };
}

/** Evaluasi walk-forward: tiap bar t diproyeksikan hanya dari data sebelum t. `stride` untuk mempercepat. */
function walkForward(target, pool, opt = {}) {
  const o = Object.assign({ stride: 1 }, DEFAULTS, opt), c = target.c, rows = [];
  for (let t = 0; t < c.length - o.H; t += o.stride) {
    const r = project(target, t, pool, o); if (r.status === 'DATA_KURANG') continue;
    const real = Math.log(c[t + o.H].close / c[t].close), endC = c[t + o.H].close;
    const inBand = (s) => s ? (endC >= s.p25[o.H - 1] && endC <= s.p75[o.H - 1]) : null;
    rows.push({ t, date: c[t].date, status: r.status, quality: r.quality, pUp: r.pUp, up: real > 0, flat: real === 0, realPct: (Math.exp(real) - 1) * 100,
      band: real > 0 ? inBand(r.scenarioA) : inBand(r.scenarioB) });
  }
  return rows;
}

/** Ringkasan skill: hit rate, Brier vs tebakan konstan (proporsi naik masa lalu), kalibrasi per kelompok. */
function score(rows, H = DEFAULTS.H) {
  const S = rows.filter(r => r.status === 'OK'); if (!S.length) return { n: 0 };
  let brier = 0, brierBase = 0, hit = 0, ups = 0, seen = 0;
  const sorted = S.slice().sort((a, b) => a.t - b.t);
  sorted.forEach(r => {
    const known = sorted.filter(x => x.t + H <= r.t), base = known.length ? known.filter(x => x.up).length / known.length : 0.5;
    brier += (r.pUp - (r.up ? 1 : 0)) ** 2; brierBase += (base - (r.up ? 1 : 0)) ** 2; if ((r.pUp > 0.5) === r.up) hit++;
  });
  const bins = [[0, .35], [.35, .45], [.45, .55], [.55, .65], [.65, 1.01]].map(([a, b]) => { const g = S.filter(r => r.pUp >= a && r.pUp < b); return g.length ? { range: a + '-' + b, n: g.length, predicted: +(g.reduce((s, r) => s + r.pUp, 0) / g.length).toFixed(3), actual: +(g.filter(r => r.up).length / g.length).toFixed(3) } : null; }).filter(Boolean);
  const bandRows = S.filter(r => r.band !== null);
  return { n: S.length, effectiveN: sorted.reduce((acc, r) => { if (acc.last === null || r.t - acc.last >= H) { acc.n++; acc.last = r.t; } return acc; }, { n: 0, last: null }).n, hitRate: hit / S.length, brier: brier / S.length, brierBase: brierBase / S.length,
    brierSkill: 1 - brier / brierBase, band25_75: bandRows.filter(r => r.band).length / bandRows.length, calibration: bins };
}

module.exports = { DEFAULTS, features, prepare, project, walkForward, score, tick, roundTick };
