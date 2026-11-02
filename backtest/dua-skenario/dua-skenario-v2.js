'use strict';
/**
 * DUA SKENARIO v2 — proyeksi analog untuk SEMUA saham (pure function, tanpa network / Date.now()).
 *
 * Perubahan dari v1 (alasan tertulis, bukan hasil menyetel):
 *  1. Bar volume 0 / harga tidak valid / tanggal ganda dibuang. Di v1, volume 0 membuat log(0) = -Infinity
 *     sehingga Brier menjadi NaN (tercatat null / "0,0%" di laporan) dan kualitas analog bisa palsu = 1.
 *  2. Fitur yang tidak finite membuat bar itu tidak dipakai (bukan diisi 0).
 *  3. Pola datar (saham disuspensi, harga tidak bergerak 20 hari) tidak dipakai sebagai query maupun analog.
 *  4. Saringan likuiditas: analog dan query hanya dari bar dengan median nilai transaksi 60 hari >= minTurnover.
 *  5. Baseline Brier = proporsi "naik" dari SEMUA jendela riwayat yang hasilnya sudah diketahui sebelum
 *     tanggal query (bukan dihitung ulang per subset). Di v1 baseline di-reset per subset sehingga skill per
 *     tahun / OOS bisa tampak lebih bagus dari seharusnya.
 *  6. Indeks typed-array + seleksi top-M agar mampu ~1.000 saham × 12 tahun.
 *  7. Gerbang tampil diputuskan SEKALI untuk seluruh bursa (sampel acak saham-tanggal), bukan per saham,
 *     untuk menghindari memilih saham yang kebetulan lolos.
 */

const DEFAULTS = {
  L: 20, H: 10, K: 30, minGap: 10, warmup: 60,
  ctxWeight: 0.5, minQuality: 0.35, minAnalogs: 15,
  minTurnover: 1e9,     // Rp 1 miliar/hari (median 60 hari) — di bawah ini dianggap tidak likuid
  topM: 600,            // kandidat terdekat yang disimpan sebelum seleksi minGap
  minCandidates: 250,
};
const CTX = ['atrPct', 'cmf', 'rot5', 'dist50'];

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
function wquantile(vals, ws, q) {
  const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
  const tot = ws.reduce((s, x) => s + x, 0); let acc = 0;
  for (const i of idx) { acc += ws[i]; if (acc >= q * tot) return vals[i]; }
  return vals[idx[idx.length - 1]];
}
function tick(p) { return p < 200 ? 1 : p < 500 ? 2 : p < 2000 ? 5 : p < 5000 ? 10 : 25; }
function roundTick(p) { const t = tick(p); return Math.round(p / t) * t; }
const dnum = (d) => +d.slice(0, 4) * 10000 + +d.slice(5, 7) * 100 + +d.slice(8, 10);

/** Bersihkan bar: urut tanggal, buang ganda, volume 0, OHLC tidak valid. */
function clean(bars) {
  const out = []; let last = '';
  bars.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).forEach(b => {
    if (!b || b.date === last) return;
    const o = +b.open, h = +b.high, l = +b.low, c = +b.close, v = +b.volume;
    if (![o, h, l, c, v].every(isNum) || c <= 0 || l <= 0 || h < l || v <= 0) return;
    out.push({ date: String(b.date).slice(0, 10), open: o, high: h, low: l, close: c, volume: v }); last = b.date;
  });
  return out;
}

/** Siapkan satu saham: fitur per bar (hanya data <= bar itu) + bentuk pola. */
function prepareSeries(rawBars, ticker, opt = {}) {
  const o = Object.assign({}, DEFAULTS, opt), c = clean(rawBars), n = c.length;
  const F = new Array(n).fill(null), S = new Array(n).fill(null), liq = new Float64Array(n);
  const turn = c.map(b => b.volume * b.close);
  let atr = null;
  for (let i = 0; i < n; i++) {
    const tr = i === 0 ? c[i].high - c[i].low : Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    if (i < 14) atr = (atr === null ? tr : atr + tr); if (i === 13) atr /= 14; else if (i > 13) atr = (atr * 13 + tr) / 14;
    if (i >= 59) { const w = turn.slice(i - 59, i + 1).sort((a, b) => a - b); liq[i] = (w[29] + w[30]) / 2; }
    if (i < o.warmup || i < o.L - 1 || !(atr > 0)) continue;
    let sma50 = 0; for (let j = i - 49; j <= i; j++) sma50 += c[j].close; sma50 /= 50;
    let mfv = 0, vol = 0;
    for (let j = i - 19; j <= i; j++) { const b = c[j], r = b.high - b.low; mfv += (r > 0 ? ((b.close - b.low) - (b.high - b.close)) / r : 0) * b.volume; vol += b.volume; }
    let rot5 = 0;
    for (let j = i - 4; j <= i; j++) { const w = turn.slice(j - 19, j + 1).sort((a, b) => a - b), med = (w[9] + w[10]) / 2; rot5 += Math.log(turn[j] / med); }
    rot5 /= 5;
    const f = { atrPct: atr / c[i].close, cmf: mfv / vol, rot5, dist50: (c[i].close - sma50) / atr };
    if (!CTX.every(k => isNum(f[k]))) continue;
    const p = []; for (let k = i - o.L + 1; k <= i; k++) p.push(Math.log(c[k].close / c[i].close));
    const m = mean(p), sd = Math.sqrt(p.reduce((s, x) => s + (x - m) ** 2, 0) / (p.length - 1));
    if (!(sd > 1e-4)) continue; // pola datar: tidak informatif
    F[i] = f; S[i] = p.map(x => (x - m) / sd);
  }
  return { ticker, c, F, S, liq, dn: c.map(b => dnum(b.date)) };
}

/** Bangun indeks semua jendela analog (typed arrays). Skala fitur konteks = simpangan baku global (skala saja, tanpa hasil). */
function buildIndex(series, opt = {}) {
  const o = Object.assign({}, DEFAULTS, opt), { L, H } = o;
  let N = 0; series.forEach(s => { for (let e = 0; e + H < s.c.length; e++) if (s.F[e]) N++; });
  const SH = new Float32Array(N * L), CX = new Float32Array(N * 4), FW = new Float32Array(N * H);
  const endD = new Int32Array(N), outD = new Int32Array(N), sid = new Int32Array(N), eix = new Int32Array(N), liq = new Float64Array(N), atrP = new Float32Array(N);
  let k = 0;
  series.forEach((s, si) => { for (let e = 0; e + H < s.c.length; e++) { if (!s.F[e]) continue;
    for (let j = 0; j < L; j++) SH[k * L + j] = s.S[e][j];
    CX[k * 4] = s.F[e].atrPct; CX[k * 4 + 1] = s.F[e].cmf; CX[k * 4 + 2] = s.F[e].rot5; CX[k * 4 + 3] = s.F[e].dist50;
    for (let h = 1; h <= H; h++) FW[k * H + h - 1] = Math.log(s.c[e + h].close / s.c[e].close);
    endD[k] = s.dn[e]; outD[k] = s.dn[e + H]; sid[k] = si; eix[k] = e; liq[k] = s.liq[e]; atrP[k] = s.F[e].atrPct; k++; } });
  const sdv = [0, 1, 2, 3].map(j => { let m = 0, q = 0; for (let i = 0; i < N; i++) m += CX[i * 4 + j]; m /= N; for (let i = 0; i < N; i++) q += (CX[i * 4 + j] - m) ** 2; return Math.sqrt(q / Math.max(1, N - 1)) || 1; });
  // baseline: proporsi naik dari jendela likuid, kumulatif menurut tanggal hasil diketahui
  const ord = Array.from({ length: N }, (_, i) => i).filter(i => liq[i] >= o.minTurnover).sort((a, b) => outD[a] - outD[b]);
  const baseD = new Int32Array(ord.length), baseUp = new Float64Array(ord.length); let ups = 0;
  ord.forEach((i, j) => { if (FW[i * H + H - 1] > 0) ups++; baseD[j] = outD[i]; baseUp[j] = ups / (j + 1); });
  return { series, N, L, H, SH, CX, FW, endD, outD, sid, eix, liq, atrP, sdv, baseD, baseUp, opt: o };
}

/** Proporsi naik historis yang sudah diketahui sebelum/sama dengan tanggal d (baseline konstan). */
function baseRate(ix, d) { let lo = 0, hi = ix.baseD.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (ix.baseD[m] <= d) { r = m; lo = m + 1; } else hi = m - 1; } return r < 0 ? 0.5 : ix.baseUp[r]; }

/** Proyeksi untuk saham ix.series[si] pada bar t. Analog sah hanya bila hasilnya diketahui <= tanggal t. */
function project(ix, si, t, opt = {}) {
  const o = Object.assign({}, ix.opt, opt), { L, H, K } = o, s = ix.series[si], c = s.c;
  if (!s.F[t]) return { ticker: s.ticker, date: c[t] && c[t].date, status: 'DATA_KURANG', reason: 'Fitur belum valid (riwayat < 60 bar, pola datar, atau data bolong)' };
  if (s.liq[t] < o.minTurnover) return { ticker: s.ticker, date: c[t].date, status: 'ILIKUID', reason: 'Median nilai transaksi 60 hari di bawah Rp ' + (o.minTurnover / 1e9) + ' M' };
  const d = s.dn[t], q = s.S[t], f = s.F[t], fq = [f.atrPct, f.cmf, f.rot5, f.dist50], w4 = ix.sdv;
  const M = o.topM, bestD = new Float64Array(M).fill(Infinity), bestI = new Int32Array(M).fill(-1);
  let worst = 0, nC = 0, sampleSum = [], step = 0;
  for (let i = 0; i < ix.N; i++) {
    if (ix.outD[i] > d || ix.liq[i] < o.minTurnover) continue;
    nC++;
    let ds = 0; const b = i * L; for (let j = 0; j < L; j++) { const z = ix.SH[b + j] - q[j]; ds += z * z; }
    let dc = 0; const cb = i * 4; for (let j = 0; j < 4; j++) { const z = (ix.CX[cb + j] - fq[j]) / w4[j]; dc += z * z; }
    const dist = Math.sqrt(ds / L) + o.ctxWeight * Math.sqrt(dc / 4);
    if ((step++ % 97) === 0) sampleSum.push(dist);
    if (dist < bestD[worst]) { bestD[worst] = dist; bestI[worst] = i; let w = 0; for (let m = 1; m < M; m++) if (bestD[m] > bestD[w]) w = m; worst = w; }
  }
  if (nC < o.minCandidates) return { ticker: s.ticker, date: c[t].date, status: 'DATA_KURANG', reason: 'Kandidat ' + nC + ' < ' + o.minCandidates };
  const cand = []; for (let m = 0; m < M; m++) if (bestI[m] >= 0) cand.push({ i: bestI[m], d: bestD[m] });
  cand.sort((a, b) => a.d - b.d);
  const pick = [];
  for (const x of cand) {
    if (pick.every(p => ix.sid[p.i] !== ix.sid[x.i] || Math.abs(ix.eix[p.i] - ix.eix[x.i]) >= o.minGap)) pick.push(x);
    if (pick.length === K) break;
  }
  const allMed = wquantile(sampleSum, sampleSum.map(() => 1), 0.5);
  const dMed = Math.max(1e-9, wquantile(pick.map(x => x.d), pick.map(() => 1), 0.5));
  const quality = Math.max(0, Math.min(1, 1 - dMed / allMed));
  const w = pick.map(x => Math.exp(-((x.d / dMed) ** 2)));
  const paths = pick.map(x => { const sc = f.atrPct / ix.atrP[x.i], r = []; for (let h = 0; h < H; h++) r.push(ix.FW[x.i * H + h] * sc); return r; });
  const up = paths.map(p => p[H - 1] > 0);
  const wAll = w.reduce((a, b) => a + b, 0), pUp = w.reduce((a, x, i) => a + (up[i] ? x : 0), 0) / wAll;
  const summarize = (sel) => {
    const ixs = paths.map((p, i) => i).filter(sel); if (!ixs.length) return null;
    const ws = ixs.map(i => w[i]), pr = [], lo = [], hi = [];
    for (let h = 0; h < H; h++) { const v = ixs.map(i => paths[i][h]); pr.push(wquantile(v, ws, 0.5)); lo.push(wquantile(v, ws, 0.25)); hi.push(wquantile(v, ws, 0.75)); }
    const P = (r) => r.map(x => roundTick(c[t].close * Math.exp(x)));
    return { n: ixs.length, median: P(pr), p25: P(lo), p75: P(hi), endPct: +((Math.exp(pr[H - 1]) - 1) * 100).toFixed(2) };
  };
  const A = summarize(i => up[i]), B = summarize(i => !up[i]);
  // rentang netral (tanpa arah): p10–p90 semua analog di hari ke-H
  const endAll = paths.map(p => p[H - 1]);
  const range = { p10: roundTick(c[t].close * Math.exp(wquantile(endAll, w, 0.1))), p50: roundTick(c[t].close * Math.exp(wquantile(endAll, w, 0.5))), p90: roundTick(c[t].close * Math.exp(wquantile(endAll, w, 0.9))) };
  const ok = isNum(pUp) && quality >= o.minQuality && pick.length >= o.minAnalogs, k3 = Math.min(2, H - 1);
  return {
    ticker: s.ticker, date: c[t].date, close: c[t].close, H,
    status: ok ? 'OK' : 'ANALOG_LEMAH', reason: ok ? null : 'Kualitas ' + quality.toFixed(2) + ' (< ' + o.minQuality + ') atau analog < ' + o.minAnalogs,
    nCandidates: nC, nAnalogs: pick.length, quality: +quality.toFixed(3), pUp: +pUp.toFixed(4), pDown: +(1 - pUp).toFixed(4), base: +baseRate(ix, d).toFixed(4),
    scenarioA: A, scenarioB: B, confirmA: A ? A.median[k3] : null, confirmB: B ? B.median[k3] : null, range,
    analogs: pick.slice(0, 8).map((x, j) => ({ ticker: ix.series[ix.sid[x.i]].ticker, date: ix.series[ix.sid[x.i]].c[ix.eix[x.i]].date, distance: +x.d.toFixed(3), fwdPct: +((Math.exp(paths[j][H - 1]) - 1) * 100).toFixed(2) })),
  };
}

/** Generator acak deterministik. */
function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }

/**
 * Evaluasi walk-forward pada sampel acak (saham, tanggal) dari SELURUH bursa.
 * Hanya bar likuid dengan fitur valid dan hasil H bar ke depan diketahui.
 */
function evaluateSample(ix, opt = {}) {
  const o = Object.assign({ samples: 3000, seed: 42, fromDate: '2017-01-01' }, ix.opt, opt), r = rng(o.seed), H = o.H, from = dnum(o.fromDate);
  const pool = [];
  ix.series.forEach((s, si) => { for (let t = 0; t + H < s.c.length; t++) if (s.F[t] && s.dn[t] >= from && s.liq[t] >= o.minTurnover) pool.push([si, t]); });
  const rows = [];
  for (let k = 0; k < o.samples && pool.length; k++) {
    const [si, t] = pool[Math.floor(r() * pool.length)], s = ix.series[si];
    const p = project(ix, si, t, o); if (p.status === 'DATA_KURANG' || p.status === 'ILIKUID') continue;
    const real = Math.log(s.c[t + H].close / s.c[t].close), endC = s.c[t + H].close;
    const inBand = (sc) => sc ? (endC >= sc.p25[H - 1] && endC <= sc.p75[H - 1]) : null;
    rows.push({ ticker: s.ticker, t, date: s.c[t].date, status: p.status, quality: p.quality, pUp: p.pUp, base: p.base, up: real > 0, realPct: +((Math.exp(real) - 1) * 100).toFixed(2),
      band: real > 0 ? inBand(p.scenarioA) : inBand(p.scenarioB), inRange: endC >= p.range.p10 && endC <= p.range.p90 });
  }
  return rows;
}

/** Skor: Brier vs baseline historis (r.base), kalibrasi, pita, cakupan rentang p10–p90. */
function score(rows) {
  const S = rows.filter(r => r.status === 'OK' && isNum(r.pUp));
  if (!S.length) return { n: 0 };
  let b = 0, bb = 0, hit = 0;
  S.forEach(r => { const y = r.up ? 1 : 0; b += (r.pUp - y) ** 2; bb += (r.base - y) ** 2; if ((r.pUp > 0.5) === r.up) hit++; });
  const bins = [[0, .35], [.35, .45], [.45, .55], [.55, .65], [.65, 1.01]].map(([a, c]) => { const g = S.filter(r => r.pUp >= a && r.pUp < c); return g.length ? { range: a + '-' + c, n: g.length, predicted: +(g.reduce((s, r) => s + r.pUp, 0) / g.length).toFixed(3), actual: +(g.filter(r => r.up).length / g.length).toFixed(3) } : null; }).filter(Boolean);
  const bandR = S.filter(r => r.band !== null), allR = rows.filter(r => r.inRange !== undefined);
  // bootstrap 1000x untuk selang kepercayaan skill (sampel acak saham-tanggal, kira-kira independen)
  const rg = rng(7), skills = [];
  for (let k = 0; k < 1000; k++) { let x = 0, y = 0; for (let j = 0; j < S.length; j++) { const r = S[Math.floor(rg() * S.length)], t = r.up ? 1 : 0; x += (r.pUp - t) ** 2; y += (r.base - t) ** 2; } skills.push(1 - x / y); }
  skills.sort((a, c) => a - c);
  return { n: S.length, okShare: +(S.length / rows.length).toFixed(3), hitRate: +(hit / S.length).toFixed(4), brier: +(b / S.length).toFixed(5), brierBase: +(bb / S.length).toFixed(5),
    brierSkill: +(1 - b / bb).toFixed(4), skillCI95: [+skills[25].toFixed(4), +skills[974].toFixed(4)],
    band25_75: bandR.length ? +(bandR.filter(r => r.band).length / bandR.length).toFixed(3) : null,
    range10_90: allR.length ? +(allR.filter(r => r.inRange).length / allR.length).toFixed(3) : null, calibration: bins };
}

/** Gerbang tampil untuk seluruh bursa (pre-registered). */
function gate(oos) {
  const cal = oos.calibration || [], lo = cal.find(b => b.range.startsWith('0-')), hi = cal.find(b => b.range.startsWith('0.65'));
  const g = {
    skillPositiveCI: !!(oos.skillCI95 && oos.skillCI95[0] > 0),           // batas bawah CI95 skill > 0
    enoughSamples: (oos.n || 0) >= 500,
    calibrationMonotone: !!(lo && hi && lo.n >= 20 && hi.n >= 20 && hi.actual > lo.actual),
  };
  g.directionAllowed = g.skillPositiveCI && g.enoughSamples && g.calibrationMonotone;
  g.rangeAllowed = oos.range10_90 !== null && oos.range10_90 >= 0.7 && oos.range10_90 <= 0.9; // rentang p10–p90 idealnya ~80%
  return g;
}

module.exports = { DEFAULTS, clean, prepareSeries, buildIndex, project, evaluateSample, score, gate, baseRate, tick, roundTick };
