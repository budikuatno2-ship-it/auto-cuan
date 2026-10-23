/* Analisis v2: plan per horizon (HANDOFF §5a "Rencana per horizon").
   Levels come only from the server engines: Scalping from the Day Trade
   screener, Swing from the Swing screeners (Konglo, Non-Konglo). Investor has
   no engine yet and stays empty. Nothing is computed in the browser except
   the lot arithmetic on those levels and the 10-day volatility range. */
(function (root) {
  'use strict';
  var doc = root.document;
  var NIL = '<span class="nil" title="Tidak tersedia di sumber" aria-label="kosong">&mdash;</span>';
  var BUY_FEE = 0.0015, SELL_FEE = 0.0025, CACHE_MS = 10 * 60 * 1000;
  var HZ = {
    scalp: { l: 'Scalping', h: 'hari ini sampai 2 sesi', stop: 'Keluar bila TP1 belum tersentuh dalam 2 sesi', src: 'Level dari engine Day Trade' },
    swing: { l: 'Swing', h: '3 sampai 7 hari bursa', stop: 'Tinjau ulang bila belum bergerak dalam 7 hari bursa', src: 'Level dari engine Swing (Konglo / Non-Konglo)' },
    inv: { l: 'Investor', h: '1 sampai 6 bulan', stop: 'Tinjau ulang setiap laporan keuangan kuartalan', src: 'Belum ada engine Investor di server' }
  };
  // Chart mode -> horizon (Pro keeps the last choice).
  var MODE_HZ = { simpel: 'swing', scalping: 'scalp', swing: 'swing', investor: 'inv' };
  var INDEX_RE = /^(IHSG|COMPOSITE|JKSE|LQ45|IDX30|IDX80|KOMPAS100)$/i;
  var state = { hz: 'swing', lots: 10, ticker: '', plans: {}, loading: null };
  var cache = {};

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function n(v) { var x = Number(v); return v != null && v !== '' && isFinite(x) && x > 0 ? x : null; }
  function fmt(v) { var x = n(v); return x == null ? NIL : x.toLocaleString('id-ID'); }
  function rp(v) { if (v == null || !isFinite(v)) return NIL; var r = Math.round(v); return (r < 0 ? '−' : '') + 'Rp ' + Math.abs(r).toLocaleString('id-ID'); }
  function isIndex(t) { return INDEX_RE.test(String(t || '')); }
  function activeTicker() {
    var b = doc.getElementById('unifiedActiveTickerBadge');
    return String((b && b.textContent) || '').trim().toUpperCase();
  }

  // Server levels from one screener row, through the app's own normaliser.
  function levelsOf(row) {
    if (!row) return null;
    var l = typeof root.normalizeDisplayLevels === 'function' ? root.normalizeDisplayLevels(row) || {} : {};
    var e1 = n(l.e1 || row.entry1 || row.entry_high), e2 = n(l.e2 || row.entry2 || row.entry_low);
    var sl = n(l.sl || row.stop_loss || row.sl), t1 = n(l.t1 || row.tp1), t2 = n(l.t2 || row.tp2);
    if (!e1 || !sl || !t1) return null;
    return { lo: e2 ? Math.min(e1, e2) : e1, hi: e2 ? Math.max(e1, e2) : e1, entry: e1, sl: sl, tp1: t1, tp2: t2, source: row.__src };
  }

  function fetchRows(url) {
    var headers = typeof root.getAuthHeaders === 'function' ? root.getAuthHeaders() : {};
    return fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now(), { headers: headers })
      .then(function (r) { return r.status === 403 ? null : r.json(); })
      .then(function (d) {
        if (!d || d.success === false) return [];
        var rows = [];
        ['results', 'rows', 'data'].forEach(function (k) { if (Array.isArray(d[k])) rows = rows.concat(d[k]); });
        return rows;
      })
      .catch(function () { return []; });
  }
  function findRow(rows, t, src) {
    var hit = (rows || []).find(function (r) { return String((r && r.ticker) || '').toUpperCase().replace(/\.JK$/, '') === t; });
    if (hit) hit.__src = src;
    return hit || null;
  }

  function loadPlans(ticker) {
    var t = String(ticker || '').toUpperCase();
    if (!t || isIndex(t)) return Promise.resolve({ scalp: null, swing: null, inv: null });
    var c = cache[t];
    if (c && Date.now() - c.at < CACHE_MS) return Promise.resolve(c.plans);
    return Promise.all([
      fetchRows('/api/sector-hot?action=screener'),
      fetchRows('/api/sector-hot?action=nk-screener-results'),
      fetchRows('/api/sector-hot?action=daytrade-screener')
    ]).then(function (all) {
      var swingRow = findRow(all[0], t, 'Swing Konglo') || findRow(all[1], t, 'Swing Non-Konglo');
      var plans = { scalp: levelsOf(findRow(all[2], t, 'Day Trade')), swing: levelsOf(swingRow), inv: null };
      cache[t] = { at: Date.now(), plans: plans };
      return plans;
    });
  }

  // Lot arithmetic on server levels: sell half at TP1, the rest at TP2, buy
  // fee 0,15% and sell fee 0,25%; after TP1 the stop moves to entry.
  function calc(plan, lots) {
    lots = Math.max(1, Math.floor(Number(lots) || 0));
    var l1 = Math.floor(lots / 2), l2 = lots - l1, sh = 100;
    var buy = function (q) { return q * sh * plan.entry * (1 + BUY_FEE); };
    var sell = function (q, px) { return q * sh * px * (1 - SELL_FEE); };
    var g1 = l1 ? sell(l1, plan.tp1) - buy(l1) : 0;
    var g2 = plan.tp2 ? sell(l2, plan.tp2) - buy(l2) : null;
    var risk = buy(lots) - sell(lots, plan.sl);
    return { lots: lots, l1: l1, l2: l2, g1: g1, g2: g2, total: g2 == null ? null : g1 + g2, risk: risk };
  }

  // 10-day range: close x e^(+-1,2816 x sigma60 x sqrt(10)), about 8 in 10.
  // A volatility band, not a level; Scalping and Swing only.
  function range10(candles) {
    var closes = (candles || []).map(function (c) { return Number(c && c.close); }).filter(function (v) { return v > 0; });
    if (closes.length < 61) return null;
    var w = closes.slice(-61), r = [];
    for (var i = 1; i < w.length; i++) r.push(Math.log(w[i] / w[i - 1]));
    var mu = r.reduce(function (a, b) { return a + b; }, 0) / r.length;
    var sd = Math.sqrt(r.reduce(function (a, b) { return a + (b - mu) * (b - mu); }, 0) / (r.length - 1));
    if (!(sd > 0)) return null;
    var c0 = closes[closes.length - 1], band = 1.2816 * sd * Math.sqrt(10);
    return { p10: c0 * Math.exp(-band), p90: c0 * Math.exp(band) };
  }
  function rangeCheck(hz, plan, rng) {
    if (hz === 'inv') return { cls: '', v: 'Tidak dipakai', s: 'Rentang 10 hari terlalu pendek untuk horizon 1 sampai 6 bulan' };
    if (!rng) return { cls: '', v: '—', s: 'Rentang belum tersedia (riwayat kurang dari 60 sesi)' };
    var out = plan.tp2 && plan.tp2 > rng.p90 ? 'TP2' : (plan.tp1 > rng.p90 ? 'TP1' : null);
    var s = 'p10 ' + Math.round(rng.p10).toLocaleString('id-ID') + ' – p90 ' + Math.round(rng.p90).toLocaleString('id-ID');
    if (out) s += ' · ' + out + ' ' + (out === 'TP2' ? plan.tp2 : plan.tp1).toLocaleString('id-ID') + ' > p90';
    if (plan.sl < rng.p10) s += ' · SL di bawah p10';
    return { cls: out ? 'w' : 'ok', v: out ? out + ' di luar rentang' : 'Target di dalam rentang', s: s };
  }

  function sheet() { return doc.getElementById('anaPlanSheet'); }
  function hzBar(isIdx) {
    var opts = isIdx ? [['scalp', 'Harian'], ['swing', 'Mingguan'], ['inv', 'Bulanan']] : [['scalp', 'Scalping'], ['swing', 'Swing'], ['inv', 'Investor']];
    var k = opts.map(function (o) { return o[0]; }).indexOf(state.hz);
    return '<div class="segx n3 ana-hz" role="group" aria-label="' + (isIdx ? 'Horizon arah' : 'Rencana untuk') + '"><span class="ind' + (k > 0 ? ' k' + k : '') + '"></span>' +
      opts.map(function (o) { return '<button type="button" class="' + (o[0] === state.hz ? 'on' : '') + '" aria-pressed="' + (o[0] === state.hz) + '" data-hz="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div>';
  }

  function renderStock(el, t) {
    var plan = state.plans[state.hz], h = HZ[state.hz];
    var head = '<div class="ana-hzbar"><span class="ana-hzl">Rencana untuk</span>' + hzBar(false) +
      '<span class="ana-hzm"><b>' + esc(h.h) + '</b> · ' + esc(h.stop) + '</span><span class="ana-hzs">' + esc(plan && plan.source ? h.src + ' · ' + plan.source : h.src) + '</span></div>';
    if (state.loading) { el.innerHTML = head + '<div class="ana-plan-empty">Memuat rencana dari server…</div>'; return; }
    if (!plan) {
      var why = state.hz === 'inv'
        ? 'Belum ada rencana Investor dari server. Level tidak dihitung di layar ini.'
        : 'Belum ada rencana ' + h.l + ' dari server untuk ' + esc(t) + '. Kalkulator muncul setelah sistem mengirim Entry, SL, dan TP. Level tidak pernah dikarang di layar ini.';
      el.innerHTML = head + '<div class="ana-plan-empty">' + why + '</div>';
      return;
    }
    var c = calc(plan, state.lots);
    var rc = rangeCheck(state.hz, plan, range10(root._chartPageData && root._chartPageData.candles));
    el.innerHTML = head + '<div class="ana-calc">' +
      '<div><div class="lbl">Posisi rencana</div><div class="ana-lots"><input id="anaLots" class="num" type="number" min="1" step="1" inputmode="numeric" value="' + c.lots + '" aria-label="Jumlah lot"><span class="mut">lot @ ' + fmt(plan.entry) + '</span></div><div class="sub num">Area entry ' + fmt(plan.lo) + (plan.hi !== plan.lo ? ' – ' + fmt(plan.hi) : '') + ' · SL ' + fmt(plan.sl) + '</div></div>' +
      '<div><div class="lbl">Jual di TP1 (' + fmt(plan.tp1) + ')</div><div class="v num">' + c.l1 + ' lot</div><div class="sub num pos">' + rp(c.g1) + '</div></div>' +
      '<div><div class="lbl">Sisa ke TP2 (' + fmt(plan.tp2) + ')</div><div class="v num">' + c.l2 + ' lot</div><div class="sub num pos">' + (c.g2 == null ? NIL : rp(c.g2)) + '</div></div>' +
      '<div><div class="lbl">Total bersih bertahap 50/50</div><div class="v num pos">' + (c.total == null ? NIL : rp(c.total)) + '</div><div class="sub">setelah biaya beli 0,15% · jual 0,25%</div></div>' +
      '<div><div class="lbl">Setelah TP1 tersentuh</div><div class="v">SL ke entry</div><div class="sub num">sisa ' + c.l2 + ' lot tanpa risiko harga · rugi maks kini ' + rp(c.risk) + '</div></div>' +
      '<div><div class="lbl">Cek rentang wajar 10 hari</div><div class="v ' + rc.cls + '">' + esc(rc.v) + '</div><div class="sub num">' + esc(rc.s) + '</div></div>' +
      '</div>';
  }

  function render() {
    var el = sheet();
    if (!el) return;
    var t = state.ticker;
    if (isIndex(t)) {
      // The index panel ("Potensi arah") is drawn by renderIndex when present.
      if (typeof api.renderIndex === 'function') api.renderIndex(el, t, state.hz, hzBar(true));
      else el.innerHTML = '';
      return;
    }
    renderStock(el, t);
  }

  // Plan lines on the chart: the selected horizon's server levels, or none.
  function drawPlanLines() {
    var reg = root.__chartRegistry || {}, ws = root.AutoCuanChartWorkstation;
    if (!ws || typeof ws.applyPlanPriceLines !== 'function') return;
    Object.keys(reg).forEach(function (id) {
      var e = reg[id];
      if (!e || !e.candleSeries || String(e.ticker || '').toUpperCase() !== state.ticker) return;
      var plan = isIndex(state.ticker) ? null : state.plans[state.hz];
      if (!plan) { ws.clearPlanPriceLines(e.candleSeries); return; }
      ws.applyPlanPriceLines(e.candleSeries, { entry: plan.entry, sl: plan.sl, tp1: plan.tp1, tp2: plan.tp2 });
    });
  }

  function refresh(ticker) {
    var t = String(ticker || activeTicker() || '').toUpperCase();
    if (!t) return Promise.resolve();
    if (t !== state.ticker) { state.ticker = t; state.plans = {}; }
    state.loading = true;
    render();
    return loadPlans(t).then(function (plans) {
      if (state.ticker !== t) return;
      state.plans = plans; state.loading = null;
      render(); drawPlanLines();
      api.drawIndexOverlay();
      api.applyIndexCopy(isIndex(t));
      api.drawConsistency();
      api.syncStar();
    });
  }

  function setHorizon(hz) {
    if (!HZ[hz]) return;
    state.hz = hz;
    render(); drawPlanLines(); api.drawIndexOverlay();
    if (typeof api.onHorizon === 'function') api.onHorizon(hz);
  }

  function bind() {
    doc.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('#anaPlanSheet [data-hz]');
      if (b) setHorizon(b.getAttribute('data-hz'));
    });
    doc.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'anaLots') {
        state.lots = Math.max(1, Math.floor(Number(e.target.value) || 1));
        var pos = e.target.selectionStart;
        render();
        var again = doc.getElementById('anaLots');
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
      }
    });
    // Chart mode picks the horizon (Scalping's forced 1D lives in applyPreset).
    var ws = root.AutoCuanChartWorkstation;
    if (ws && typeof ws.applyPreset === 'function' && !ws.__anaHzWrapped) {
      var orig = ws.applyPreset;
      ws.applyPreset = function (chartId, preset) {
        var out = orig.apply(this, arguments);
        if (MODE_HZ[preset]) setHorizon(MODE_HZ[preset]);
        return out;
      };
      ws.__anaHzWrapped = true;
    }
    // A ticker switch refreshes the sheet even if its chart fails to load.
    var uc = root.UnifiedCockpit;
    if (uc && typeof uc.syncActiveTicker === 'function' && !uc.__anaWrapped) {
      var origSync = uc.syncActiveTicker;
      uc.syncActiveTicker = function (t) { var out = origSync.apply(this, arguments); refresh(t); return out; };
      uc.__anaWrapped = true;
    }
    // Every chart render (ticker or timeframe change) refreshes plan and lines.
    if (typeof root.renderLightweightChart === 'function' && !root.renderLightweightChart.__anaWrapped) {
      var origRender = root.renderLightweightChart;
      root.renderLightweightChart = function (chartId, candles, metrics, ticker) {
        var p = origRender.apply(this, arguments);
        Promise.resolve(p).then(function () { refresh(ticker); });
        return p;
      };
      root.renderLightweightChart.__anaWrapped = true;
    }
  }

  var api = {
    HZ: HZ, MODE_HZ: MODE_HZ, isIndex: isIndex, levelsOf: levelsOf, calc: calc, range10: range10, rangeCheck: rangeCheck,
    loadPlans: loadPlans, refresh: refresh, setHorizon: setHorizon, render: render, drawPlanLines: drawPlanLines,
    state: state
  };

  /* ---------- Indices: "Potensi arah" (HANDOFF 5a, IHSG / COMPOSITE) ----------
     No entry, SL or TP. Bias from price against moving averages per horizon,
     scenarios to pivot levels, and a volatility range. Computed from the
     index's own daily candles. */
  var IHZ = {
    scalp: { l: 'Harian', h: '1 sampai 5 hari bursa', d: 5, ext: 8, lb: 66, ma: 'MA20' },
    swing: { l: 'Mingguan', h: '2 sampai 4 minggu', d: 20, ext: 16, lb: 126, ma: 'MA50' },
    inv: { l: 'Bulanan', h: '1 sampai 3 bulan', d: 60, ext: 24, lb: 250, ma: 'MA200' }
  };
  function dec(v, d) { return Number(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function idxFmt(v) { return v == null || !isFinite(v) ? NIL : dec(v, 2); }

  function potential(candles, hz) {
    var O = (candles || []).filter(function (k) { return k && Number(k.close) > 0; }).map(function (k) { return { c: Number(k.close), h: Number(k.high), l: Number(k.low), t: k.time }; });
    var z = IHZ[hz] || IHZ.swing, L = O.length;
    if (L < 61) return null;
    var CL = O.map(function (k) { return k.c; }), c0 = CL[L - 1];
    var ma = function (p, i) { if (i < p - 1) return null; var s = 0; for (var j = i - p + 1; j <= i; j++) s += CL[j]; return s / p; };
    var rets = []; for (var i = L - 60; i < L; i++) rets.push(Math.log(CL[i] / CL[i - 1]));
    var mu = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
    var sd = Math.sqrt(rets.reduce(function (a, b) { return a + (b - mu) * (b - mu); }, 0) / (rets.length - 1));
    var band = 1.2816 * sd * Math.sqrt(z.d), p90 = c0 * Math.exp(band), p10 = c0 * Math.exp(-band);
    var ag = 0, al = 0;
    for (var k = 1; k < L; k++) { var d = CL[k] - CL[k - 1], g = Math.max(d, 0), lo = Math.max(-d, 0); if (k <= 14) { ag += g / 14; al += lo / 14; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + lo) / 14; } }
    var rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    var m20 = ma(20, L - 1), m20p = ma(20, L - 6), m50 = ma(50, L - 1), m50p = ma(50, L - 11), m200 = ma(200, L - 1);
    var chk, inval;
    if (hz === 'scalp') { chk = [[c0 > m20, 'di atas MA20', 'di bawah MA20'], [m20 > m20p, 'MA20 naik', 'MA20 turun']]; inval = m20; }
    else if (hz === 'inv') {
      if (m200 == null) return { insufficient: 'MA200 butuh 200 sesi; riwayat belum cukup' };
      chk = [[c0 > m200, 'di atas MA200', 'di bawah MA200'], [m50 > m200, 'MA50 di atas MA200', 'MA50 di bawah MA200']]; inval = m200;
    } else { chk = [[c0 > m50, 'di atas MA50', 'di bawah MA50'], [m20 > m50, 'MA20 di atas MA50', 'MA20 di bawah MA50'], [m50 > m50p, 'MA50 naik', 'MA50 turun']]; inval = m50; }
    var sc = chk.filter(function (x) { return x[0]; }).length / chk.length;
    var bias = sc >= 0.66 ? 'up' : (sc <= 0.34 ? 'down' : 'flat');
    var why = chk.map(function (x) { return x[0] ? x[1] : x[2]; }).concat(['RSI14 ' + dec(rsi, 0) + (rsi < 30 ? ' (jenuh jual)' : (rsi > 70 ? ' (jenuh beli)' : ''))]);
    var win = O.slice(Math.max(0, L - z.lb));
    var pv = function (key, pick) { var r = []; for (var i2 = 5; i2 < win.length - 3; i2++) { var w = win.slice(i2 - 5, Math.min(win.length, i2 + 6)).map(function (q) { return q[key]; }); if (win[i2][key] === pick.apply(null, w)) r.push(win[i2][key]); } return r; };
    var uq = function (arr) { var o = []; arr.forEach(function (v) { if (!o.some(function (x) { return Math.abs(x - v) / v < 0.02; })) o.push(v); }); return o; };
    var R = uq(pv('h', Math.max).filter(function (v) { return v > c0 * 1.005; }).sort(function (a, b) { return a - b; })).slice(0, 2);
    var S = uq(pv('l', Math.min).filter(function (v) { return v < c0 * 0.995; }).sort(function (a, b) { return b - a; })).slice(0, 2);
    var upT = R.length ? { v: R[0], k: 'R1' } : { v: p90, k: 'p90', rng: true };
    var dnT = S.length ? { v: S[0], k: 'S1' } : { v: p10, k: 'p10', rng: true };
    return { c0: c0, z: z, sd: sd, p10: p10, p90: p90, rsi: rsi, bias: bias, why: why, R: R, S: S, upT: upT, dnT: dnT, inval: inval, last: O[L - 1] };
  }

  function pct(to, from) { var p = (to - from) / from * 100; return (p > 0 ? '+' : '−') + dec(Math.abs(p), 2) + '%'; }
  api.potential = potential;
  api.renderIndex = function (el, t, hz, bar) {
    var z = IHZ[hz] || IHZ.swing;
    var head = '<div class="ana-hzbar"><span class="ana-hzl">Potensi arah</span>' + bar +
      '<span class="ana-hzm"><b>' + esc(z.h) + '</b> · Indeks tidak dibeli langsung. Ini gambaran arah pasar, bukan sinyal beli atau jual.</span>' +
      '<span class="ana-hzs">Bias dari posisi harga terhadap rata-rata bergerak · level dari pivot ' + z.lb + ' sesi · rentang dari volatilitas 60 hari</span></div>';
    var ix = potential(root._chartPageData && root._chartPageData.candles, hz);
    if (!ix) { el.innerHTML = head + '<div class="ana-plan-empty">Candle indeks belum cukup (butuh minimal 61 sesi) untuk membaca arah.</div>'; return; }
    if (ix.insufficient) { el.innerHTML = head + '<div class="ana-plan-empty">' + esc(ix.insufficient) + '.</div>'; return; }
    var biasTxt = ix.bias === 'up' ? 'Cenderung naik' : (ix.bias === 'down' ? 'Cenderung turun' : 'Mendatar');
    var outUp = ix.upT.v > ix.p90, outDn = ix.dnT.v < ix.p10;
    var upMain = ix.bias === 'up', dnMain = ix.bias === 'down';
    var invalTxt = ix.inval == null ? NIL : (ix.bias === 'down' ? 'Tutup di atas ' : 'Tutup di bawah ') + z.ma + ' ' + idxFmt(ix.inval);
    el.innerHTML = head + '<div class="ana-calc pot">' +
      '<div><div class="lbl">Bias ' + esc(z.l.toLowerCase()) + '</div><div class="v ' + (ix.bias === 'up' ? 'pos' : ix.bias === 'down' ? 'neg' : '') + '">' + biasTxt + '</div><div class="sub">' + esc(ix.why.join(' · ')) + '</div></div>' +
      '<div><div class="lbl">Skenario naik' + (upMain ? ' <em class="ana-ptag">Utama</em>' : '') + '</div><div class="v num pos">▲ ' + esc(ix.upT.k) + ' ' + idxFmt(ix.upT.v) + '</div><div class="sub num">' +
        esc(ix.upT.rng ? 'tidak ada resistance di ' + z.lb + ' sesi terakhir, batas atas rentang' : (ix.R[1] ? 'R2 ' + dec(ix.R[1], 2) + ' bila R1 tembus' : 'belum ada resistance kedua di ' + z.lb + ' sesi')) + ' · ' + pct(ix.upT.v, ix.c0) + (outUp ? ' · di luar rentang, butuh waktu lebih lama' : '') + '</div></div>' +
      '<div><div class="lbl">Skenario turun' + (dnMain ? ' <em class="ana-ptag">Utama</em>' : '') + '</div><div class="v num neg">▼ ' + esc(ix.dnT.k) + ' ' + idxFmt(ix.dnT.v) + '</div><div class="sub num">' +
        esc(ix.dnT.rng ? 'tidak ada support di ' + z.lb + ' sesi terakhir, batas bawah rentang' : (ix.S[1] ? 'S2 ' + dec(ix.S[1], 2) + ' bila S1 jebol' : 'belum ada support kedua di ' + z.lb + ' sesi')) + ' · ' + pct(ix.dnT.v, ix.c0) + (outDn ? ' · di luar rentang, butuh waktu lebih lama' : '') + '</div></div>' +
      '<div><div class="lbl">Rentang ' + esc(z.h) + '</div><div class="v num">' + idxFmt(ix.p10) + ' – ' + idxFmt(ix.p90) + '</div><div class="sub">sekitar 8 dari 10 kemungkinan · volatilitas 60 hari ' + dec(ix.sd * 100, 2) + '% per hari; dihitung dari volatilitas, bukan prediksi arah</div></div>' +
      '<div><div class="lbl">Bias berubah bila</div><div class="v">' + invalTxt + '</div><div class="sub">Ini gambaran arah pasar, bukan sinyal beli atau jual.</div></div>' +
      '</div>';
  };

  // Chart overlay for indices: blue range cone to the right of the last
  // candle, the main scenario arrow solid and the other dashed, R1/R2/S1/S2.
  var overlay = { id: null, series: [], lines: [] };
  function clearOverlay() {
    var reg = (root.__chartRegistry || {})[overlay.id];
    if (reg && reg.mainChart) overlay.series.forEach(function (s) { try { reg.mainChart.removeSeries(s); } catch (_) {} });
    if (reg && reg.candleSeries) overlay.lines.forEach(function (l) { try { reg.candleSeries.removePriceLine(l); } catch (_) {} });
    overlay = { id: null, series: [], lines: [] };
  }
  function futureDays(lastTime, count) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(lastTime || ''));
    if (!m) return [];
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), out = [];
    while (out.length < count) {
      d.setUTCDate(d.getUTCDate() + 1);
      var w = d.getUTCDay();
      if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }
  api.drawIndexOverlay = function () {
    clearOverlay();
    if (!isIndex(state.ticker)) return;
    var reg = root.__chartRegistry || {};
    var id = Object.keys(reg).find(function (k) { var e = reg[k]; return e && e.candleSeries && String(e.ticker || '').toUpperCase() === state.ticker; });
    if (!id) return;
    var e = reg[id], ix = potential(root._chartPageData && root._chartPageData.candles, state.hz);
    if (!ix || ix.insufficient || !e.mainChart) return;
    var cs = getComputedStyle(doc.getElementById(id + '_container') || doc.body);
    var info = String(cs.getPropertyValue('--ac-info') || '').trim() || '#315F9A';
    var pos = String(cs.getPropertyValue('--ac-pos') || '').trim() || '#247A43';
    var neg = String(cs.getPropertyValue('--ac-neg') || '').trim() || '#AD3F52';
    var days = futureDays(ix.last.t, ix.z.ext);
    if (!days.length) return;
    var t0 = ix.last.t, qm = days.length;
    var path = function (target) { return [{ time: t0, value: ix.c0 }].concat(days.map(function (t, q) { var f = Math.sqrt((q + 1) / qm); return { time: t, value: ix.c0 * Math.exp(Math.log(target / ix.c0) * f) }; })); };
    var add = function (opts, data) { var s = e.mainChart.addLineSeries(Object.assign({ priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, opts)); s.setData(data); overlay.series.push(s); return s; };
    add({ color: info, lineWidth: 1, lineStyle: 2 }, path(ix.p90));
    add({ color: info, lineWidth: 1, lineStyle: 2 }, path(ix.p10));
    var upMain = ix.bias === 'up', dnMain = ix.bias === 'down';
    add({ color: pos, lineWidth: upMain ? 3 : 1, lineStyle: upMain ? 0 : 2 }, [{ time: t0, value: ix.c0 }, { time: days[Math.min(days.length - 1, Math.round(days.length * 0.6))], value: ix.upT.v }]);
    add({ color: neg, lineWidth: dnMain ? 3 : 1, lineStyle: dnMain ? 0 : 2 }, [{ time: t0, value: ix.c0 }, { time: days[Math.min(days.length - 1, Math.round(days.length * 0.6))], value: ix.dnT.v }]);
    var short = root.innerWidth < 520;
    var line = function (price, title, color) { try { overlay.lines.push(e.candleSeries.createPriceLine({ price: price, color: color, lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: title })); } catch (_) {} };
    ix.R.forEach(function (v, i) { line(v, (short ? 'R' : '▲ R') + (i + 1), pos); });
    ix.S.forEach(function (v, i) { line(v, (short ? 'S' : '▼ S') + (i + 1), neg); });
    overlay.id = id;
    // Show the cone: open the right edge by the projection length.
    try { var lr = e.mainChart.timeScale().getVisibleLogicalRange(); if (lr) e.mainChart.timeScale().setVisibleLogicalRange({ from: lr.from, to: lr.to + days.length }); } catch (_) {}
  };

  // Index-specific copy: the AI asks where the market goes, not where to buy;
  // header links point to market structure and sector heat.
  api.applyIndexCopy = function (isIdx) {
    var chip = Array.prototype.find.call(doc.querySelectorAll('.unified-prompt-chip'), function (b) { return b.hasAttribute('data-entry-chip') || /Entry di mana\?|Ke mana arahnya\?/.test(b.textContent); });
    if (chip) {
      if (!chip.hasAttribute('data-entry-chip')) { chip.setAttribute('data-entry-chip', chip.getAttribute('onclick') || ''); }
      if (isIdx) { chip.textContent = 'Ke mana arahnya?'; chip.setAttribute('onclick', "UnifiedCockpit.sendQuickPrompt('Ke mana arah indeks ini dalam horizon ini, dan level apa yang membatalkan bias?')"); }
      else { chip.textContent = 'Entry di mana?'; chip.setAttribute('onclick', chip.getAttribute('data-entry-chip')); }
    }
    var links = doc.getElementById('anaHeaderLinks');
    if (links) {
      links.innerHTML = isIdx
        ? '<button type="button" class="vbtn sm" onclick="switchAnalisisTab(\'market-structure\')">Struktur Pasar</button><button type="button" class="vbtn sm" onclick="navigateTo(\'sektor\')">Sektor Hot</button>'
        : '<button type="button" class="vbtn sm" onclick="switchAnalisisTab(\'bandarmologi\')">Bandarmologi</button><button type="button" class="vbtn sm" onclick="switchAnalisisTab(\'financial\')">Financial</button>';
    }
  };

  /* ---------- Broker consistency badge (HANDOFF 5a "Lencana konsistensi bandar") ----------
     The largest net buyer over 20 archived sessions, its net-buy days out of
     the last 10 and its streak, from /api/sector-hot?action=broker-consistency.
     Stocks only, behind the "Konsistensi broker" layer; hidden on phones. */
  var konsCache = {};
  function chartIdFor(t) {
    var reg = root.__chartRegistry || {};
    return Object.keys(reg).find(function (k) { var e = reg[k]; return e && e.candleSeries && String(e.ticker || '').toUpperCase() === t; }) || null;
  }
  function konsOn(id) {
    var ws = root.AutoCuanChartWorkstation, inst = ws && typeof ws.getInstance === 'function' ? ws.getInstance(id) : null;
    return Boolean(inst && inst.state && inst.state.isLayerActive('bandar_kons'));
  }
  function loadConsistency(t) {
    var c = konsCache[t];
    if (c && Date.now() - c.at < CACHE_MS) return Promise.resolve(c.d);
    var headers = typeof root.getAuthHeaders === 'function' ? root.getAuthHeaders() : {};
    return fetch('/api/sector-hot?action=broker-consistency&ticker=' + encodeURIComponent(t), { headers: headers })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (d) { konsCache[t] = { at: Date.now(), d: d }; return d; });
  }
  function konsHtml(d) {
    if (!d || !d.data_available || !d.top_broker || !(d.of_days > 0)) return { html: 'Konsistensi: belum cukup data', title: 'Butuh minimal 5 hari broker summary tersimpan' };
    var k = Math.round(d.days_net_buy / d.of_days * 100);
    return {
      html: '<span class="k-l">Bandar</span><b class="k-b">' + esc(d.top_broker) + '</b><span class="k-t num">net buy ' + d.days_net_buy + '/' + d.of_days + ' hari</span>' +
        '<span class="k-bar" style="--k:' + k + '%" aria-hidden="true"></span><span>' + (d.streak > 0 ? 'beruntun ' + d.streak + ' hari' : 'hari ini tidak net buy') + '</span>',
      title: (d.top_broker_name ? d.top_broker + ' ' + d.top_broker_name + ' · ' : '') + 'pembeli bersih terbesar ' + d.window_days + ' hari · data s.d. ' + d.as_of_date
    };
  }
  api.konsHtml = konsHtml;
  api.drawConsistency = function () {
    Array.prototype.forEach.call(doc.querySelectorAll('.ana-kons'), function (n) { n.remove(); });
    var t = state.ticker;
    if (!t || isIndex(t)) return Promise.resolve();
    var id = chartIdFor(t), host = id && doc.getElementById(id + '_container');
    if (!host || !konsOn(id)) return Promise.resolve();
    var el = doc.createElement('div');
    el.className = 'ana-kons';
    el.setAttribute('role', 'note');
    el.textContent = 'Konsistensi: memuat…';
    try { var w = root.__chartRegistry[id].mainChart.priceScale('right').width(); if (w > 0) el.style.right = (w + 6) + 'px'; } catch (_) {}
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(el);
    return loadConsistency(t).then(function (d) {
      if (state.ticker !== t || !el.isConnected) return;
      var out = konsHtml(d);
      el.innerHTML = out.html;
      el.title = out.title;
    });
  };

  /* ---------- Watchlist + alert star in the header (canvas "Watchlist + alert") ----------
     Saves the ticker through the watchlist API, then opens the price-alert
     form. Indices cannot be saved, so the star hides for them. */
  function watched(t) { var set = root.__AUTOCUAN_WATCHLIST_SET__; return Boolean(set && typeof set.has === 'function' && set.has(t)); }
  api.syncStar = function () {
    var b = doc.getElementById('anaWlStar'), t = state.ticker;
    if (!b) return;
    b.hidden = !t || isIndex(t);
    if (b.hidden) return;
    var on = watched(t);
    b.setAttribute('data-ticker', t);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', (on ? 'Hapus ' : 'Simpan ') + t + (on ? ' dari Watchlist' : ' ke Watchlist dan pasang alert'));
    b.classList.toggle('on-star', on);
    b.classList.toggle('active', on);
    var svg = b.querySelector('svg');
    if (svg) svg.setAttribute('fill', on ? 'currentColor' : 'none');
    var l = b.querySelector('.ana-wl-l');
    if (l) l.textContent = on ? 'Dipantau' : 'Watchlist + alert';
  };
  api.toggleWatch = function (e) {
    var t = state.ticker;
    if (!t || isIndex(t) || typeof root.toggleWatchlistTicker !== 'function') return Promise.resolve();
    var was = watched(t);
    return Promise.resolve(root.toggleWatchlistTicker(t, null, e)).then(function () {
      api.syncStar();
      if (!was && watched(t) && typeof root.openCreateAlertModal === 'function') root.openCreateAlertModal(t);
    });
  };

  root.AutoCuanAnalisisV2 = api;
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind); else bind();
})(window);
