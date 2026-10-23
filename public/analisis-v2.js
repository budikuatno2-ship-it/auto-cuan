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
    });
  }

  function setHorizon(hz) {
    if (!HZ[hz]) return;
    state.hz = hz;
    render(); drawPlanLines();
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
  root.AutoCuanAnalisisV2 = api;
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind); else bind();
})(window);
