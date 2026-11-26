/* Analisis v2: plan per horizon (HANDOFF §5a "Rencana per horizon").
   Levels come only from the server engines: Scalping from the Day Trade
   screener, Swing from the Swing screeners (Konglo, Non-Konglo). Investor has
   no engine yet and stays empty. Nothing is computed in the browser except
   the lot arithmetic on those levels and the 10-day volatility range. */
(function (root) {
  'use strict';
  var doc = root.document;

  /* ---------------------------------------------------------------------- */
  /* BUG-V5-P0-009 — the plan must belong to the ticker it is titled with    */
  /* ---------------------------------------------------------------------- */
  /* This module used to derive the whole trading plan from
   * `root._chartPageData`, a single mutable slot also written by every chart
   * loader. When a slow response for a PREVIOUS ticker landed, the plan was
   * recomputed from that ticker's candles while the card still said the current
   * one: BBCA at 9.860 beside a 1.525 - 1.550 plan.
   *
   * `planCandles()` now returns candles ONLY when the shared guard reports that
   * the snapshot belongs to the ticker this sheet is rendering for. Anything
   * else returns `[]`, which makes the plan degrade to an explicit
   * "not available" state instead of publishing another ticker's levels. */
  var CHART_CATEGORY = 'CHART';

  function chartBus() {
    return root.AutoCuanChartBus || null;
  }

  /** Candles for `ticker` from the identity-checked snapshot bus, or `[]`. */
  function planCandles(ticker) {
    var t = String(ticker || '').trim().toUpperCase().replace(/\.JK$/, '');
    if (!t) return [];
    var bus = chartBus();
    if (!bus || typeof bus.get !== 'function') return [];
    // `get()` returns `null` unless the stored snapshot belongs to exactly this
    // (ticker, category) AND is still the newest write for that category.
    var entry = bus.get(t, CHART_CATEGORY);
    if (!entry || !entry.payload) return [];
    var candles = entry.payload.candles;
    return Array.isArray(candles) ? candles : [];
  }

  /** True when the loaded snapshot belongs to `ticker`. */
  function hasCandlesFor(ticker) {
    return planCandles(ticker).length > 0;
  }
  var NIL = '<span class="nil" title="Tidak tersedia di sumber" aria-label="kosong">&mdash;</span>';
  var BUY_FEE = 0.0015, SELL_FEE = 0.0025, CACHE_MS = 10 * 60 * 1000;
  // BUG-V6-I (Subtask I, temuan BMRI): batas deviasi entry plan vs harga pasar.
  // Satu konstanta dipakai oleh levelsOf() dan enforcePlanFreshness() agar gate
  // di lapisan fetch dan lapisan display tidak bisa berbeda ambang.
  var STALE_DEVIATION_MAX = 0.25;
  var HZ = {
    scalp: { l: 'Scalping', h: 'hari ini sampai 2 sesi', stop: 'Keluar bila TP1 belum tersentuh dalam 2 sesi', src: 'Level dari engine Day Trade' },
    swing: { l: 'Swing', h: '3 sampai 7 hari bursa', stop: 'Tinjau ulang bila belum bergerak dalam 7 hari bursa', src: 'Level dari engine Short Swing & Swing Three-Horizon' },
    inv: { l: 'Investor', h: '1 sampai 6 bulan', stop: 'Tinjau ulang setiap laporan keuangan kuartalan', src: 'Level deterministik valuasi wajar & MA200' }
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

  function snapIdxTick(v, dir) {
    var num = n(v);
    if (!num) return null;
    var tp = root.AutoCuanTradePlan;
    if (tp) {
      if (dir === 'up' && typeof tp.roundUpToIdxTick === 'function') return tp.roundUpToIdxTick(num);
      if (dir === 'down' && typeof tp.roundDownToIdxTick === 'function') return tp.roundDownToIdxTick(num);
      if (typeof tp.roundToIdxTick === 'function') return tp.roundToIdxTick(num);
    }
    return Math.round(num);
  }

  // Server levels from one screener row, through the app's own normaliser.
  // REQ-11 & REQ-12: Validasi keselarasan plan screener dengan tanggal/quote aktif.
  // Jangan gunakan plan usang tanpa tanggal jelas atau jika harga entry menyimpang jauh dari quote/candle terkini.
  function levelsOf(row, currentClose) {
    if (!row) return null;
    var l = typeof root.normalizeDisplayLevels === 'function' ? root.normalizeDisplayLevels(row) || {} : {};
    var e1 = snapIdxTick(l.e1 || row.entry1 || row.entry_high, 'nearest');
    var e2 = snapIdxTick(l.e2 || row.entry2 || row.entry_low, 'down');
    var sl = snapIdxTick(l.sl || row.stop_loss || row.sl, 'down');
    var t1 = snapIdxTick(l.t1 || row.tp1, 'up');
    var t2 = snapIdxTick(l.t2 || row.tp2, 'up');
    if (!e1 || !sl || !t1) return null;

    var planDate = row.date || row.as_of_date || row.trade_date || row.created_at || null;
    var planDateStr = planDate ? (' (' + String(planDate).slice(0, 10) + ')') : '';

    // Cek deviasi harga entry terhadap harga pasar/candle terakhir jika tersedia.
    // ADDENDUM P0 FIX: Jika entry menyimpang > 25%, tandai eksplisit STALE_PLAN_REJECTED / NEEDS_RECALCULATION.
    // Jangan disamarkan menjadi plan actionable seolah-olah valid atau diganti diam-diam.
    if (currentClose && currentClose > 0) {
      var deviasi = Math.abs(e1 - currentClose) / currentClose;
      if (deviasi > STALE_DEVIATION_MAX) {
        var deviasiPct = (deviasi * 100).toFixed(1) + '%';
        return {
          status: 'STALE_PLAN_REJECTED',
          code: 'NEEDS_RECALCULATION',
          reason: 'Deviasi entry (' + fmt(e1) + ') vs harga pasar (' + fmt(currentClose) + ') mencapai ' + deviasiPct + ' (> 25%)',
          entry: e1,
          sl: sl,
          tp1: t1,
          tp2: t2,
          lo: e2 ? Math.min(e1, e2) : e1,
          hi: e2 ? Math.max(e1, e2) : e1,
          source: (row.__src || 'Screener') + planDateStr + ' [STALE DEVIASI ' + deviasiPct + ']',
          as_of: planDate,
          deviationPct: deviasi * 100,
          actionable: false
        };
      }
    }

    return {
      status: 'VALID',
      lo: e2 ? Math.min(e1, e2) : e1,
      hi: e2 ? Math.max(e1, e2) : e1,
      entry: e1,
      sl: sl,
      tp1: t1,
      tp2: t2,
      source: (row.__src || 'Screener') + planDateStr,
      as_of: planDate,
      // BUG-V6-I: `priceValidated` menandai bahwa gate deviasi SUDAH dijalankan
      // terhadap harga pasar nyata. Bila harga belum tersedia saat plan dimuat
      // (currentClose null) nilainya false dan enforcePlanFreshness() wajib
      // memvalidasi ulang sebelum plan boleh tampil sebagai actionable.
      priceValidated: !!(currentClose && currentClose > 0),
      actionable: true
    };
  }

  /* ---------------------------------------------------------------------- */
  /* BUG-V6-I — stale-plan gate di lapisan DISPLAY (temuan regresi BMRI)     */
  /* ---------------------------------------------------------------------- */
  /* Bukti browser nyata (Subtask I): BMRI quote 3.590 tetapi sheet rencana    */
  /* menampilkan kalkulator laba actionable "lot @ 6.700 · TP1 7.100 ·        */
  /* TP2 7.350" (entry 86,6% di atas harga pasar). Penyebabnya:               */
  /*   1. `refresh()` pertama dipicu `syncActiveTicker` SEBELUM candle chart   */
  /*      tiba, sehingga `curClose` null dan `levelsOf(row, null)` gagal-open  */
  /*      menjadi VALID;                                                       */
  /*   2. hasil itu di-cache 10 menit, jadi refresh kedua (setelah candle      */
  /*      3.590 tersedia) memakai cache dan gate tidak pernah dievaluasi.      */
  /* Perbaikan: gate deviasi ditegakkan ulang di titik render/draw memakai     */
  /* candle yang sudah terverifikasi identitasnya. Tidak ada jalur urutan      */
  /* maupun cache yang bisa menerbitkan plan tak tervalidasi.                  */
  function lastVerifiedClose(ticker) {
    var candles = planCandles(ticker);
    for (var i = candles.length - 1; i >= 0; i--) {
      var c = Number(candles[i] && candles[i].close);
      if (Number.isFinite(c) && c > 0) return c;
    }
    return null;
  }

  /**
   * Return `plan` only if it is provably fresh against this ticker's own
   * identity-checked price. Otherwise return a non-actionable status object
   * (STALE_PLAN_REJECTED when the deviation is proven, PRICE_UNVERIFIED when
   * no verified price exists yet). Never invents levels, never mutates input.
   */
  function enforcePlanFreshness(plan, ticker) {
    if (!plan || plan.actionable === false || plan.status === 'STALE_PLAN_REJECTED') return plan;
    var entry = n(plan.entry);
    if (!entry) return plan;
    var close = lastVerifiedClose(ticker);
    if (close == null) {
      // Fail-closed: tanpa harga terverifikasi, deviasi tidak bisa dibuktikan,
      // jadi plan tidak boleh disajikan sebagai siap eksekusi.
      return Object.assign({}, plan, {
        status: 'PRICE_UNVERIFIED',
        code: 'NEEDS_RECALCULATION',
        actionable: false,
        reason: 'Harga pasar ' + String(ticker || '').toUpperCase() + ' belum terverifikasi dari chart, sehingga deviasi entry plan tidak dapat dihitung.'
      });
    }
    if (plan.priceValidated === true) return plan;
    var deviasi = Math.abs(entry - close) / close;
    if (deviasi <= STALE_DEVIATION_MAX) return plan;
    var deviasiPct = (deviasi * 100).toFixed(1) + '%';
    return Object.assign({}, plan, {
      status: 'STALE_PLAN_REJECTED',
      code: 'NEEDS_RECALCULATION',
      actionable: false,
      deviationPct: deviasi * 100,
      marketClose: close,
      reason: 'Deviasi entry (' + fmt(entry) + ') vs harga pasar (' + fmt(close) + ') mencapai ' + deviasiPct + ' (> 25%)',
      source: (plan.source || 'Screener') + ' [STALE DEVIASI ' + deviasiPct + ']'
    });
  }

  var _rowsCache = {};
  var _rowsInFlight = {};
  var _plansInFlight = {};
  var ROWS_CACHE_MS = 60 * 1000;

  function hasClientSessionAuth(headers) {
    if (headers && (headers.Authorization || headers.authorization)) return true;
    if (root.__AUTOCUAN_PREVIEW_MOCKS__ || root.currentUser || root.__adminAuthed) return true;
    if (typeof doc !== 'undefined' && doc && typeof doc.cookie === 'string') {
      if (doc.cookie.indexOf('ac_sess=') !== -1 || doc.cookie.indexOf('ac_admin=') !== -1) return true;
      return false;
    }
    return true;
  }

  function fetchRows(url) {
    var headers = typeof root.getAuthHeaders === 'function' ? root.getAuthHeaders() : {};
    if (!hasClientSessionAuth(headers)) return Promise.resolve([]);
    var now = Date.now();
    var hit = _rowsCache[url];
    if (hit && (now - hit.at) < ROWS_CACHE_MS) return Promise.resolve(hit.rows);
    if (_rowsInFlight[url]) return _rowsInFlight[url];
    var p = fetch(url, { headers: headers, credentials: 'same-origin' })
      .then(function (r) { return (!r || r.status === 401 || r.status === 403 || r.status === 429) ? null : r.json(); })
      .then(function (d) {
        if (!d || d.success === false) return [];
        var rows = [];
        ['results', 'rows', 'data'].forEach(function (k) { if (Array.isArray(d[k])) rows = rows.concat(d[k]); });
        _rowsCache[url] = { at: Date.now(), rows: rows };
        return rows;
      })
      .catch(function () { return []; })
      .finally(function () { delete _rowsInFlight[url]; });
    _rowsInFlight[url] = p;
    return p;
  }
  function findRow(rows, t, src) {
    var hit = (rows || []).find(function (r) { return String((r && r.ticker) || '').toUpperCase().replace(/\.JK$/, '') === t; });
    if (hit) hit.__src = src;
    return hit || null;
  }

  function deriveDeterministicPlan(ticker, hz) {
    var t = String(ticker || '').toUpperCase();
    // BUG-V5-P0-009: candles come from the identity-checked bus for THIS
    // ticker. When they are absent the plan is NOT invented (see below).
    var candles = planCandles(t);
    var lastClose = null;
    var atr = null;
    if (candles && candles.length > 0) {
      var last = candles[candles.length - 1];
      var rawClose = Number(last && last.close);
      if (Number.isFinite(rawClose) && rawClose > 0) {
        lastClose = rawClose;
        var sumTr = 0, count = 0;
        for (var i = Math.max(1, candles.length - 14); i < candles.length; i++) {
          var c1 = candles[i], p1 = candles[i - 1];
          sumTr += Math.max(Number(c1.high) - Number(c1.low), Math.abs(Number(c1.high) - Number(p1.close)), Math.abs(Number(c1.low) - Number(p1.close)));
          count++;
        }
        atr = count > 0 ? Math.max(1, Math.round(sumTr / count)) : Math.max(1, Math.round(lastClose * 0.02));
      }
    }
    if (lastClose == null) {
      // No identity-verified candles for this ticker. The old code substituted
      // 9860 for BBCA, 7480 for IHSG and 5000 for everything else, which is how
      // "BBCA 9.860" reached a card for a ticker whose real price was 1.525.
      // Returning null makes the caller render an explicit "belum tersedia".
      return null;
    }
    var snappedEntry = snapIdxTick(lastClose, 'nearest');
    if (hz === 'scalp') {
      return {
        entry: snappedEntry,
        sl: snapIdxTick(lastClose - 1.2 * atr, 'down'),
        tp1: snapIdxTick(lastClose + 1.5 * atr, 'up'),
        tp2: snapIdxTick(lastClose + 2.5 * atr, 'up'),
        lo: snapIdxTick(lastClose - 0.4 * atr, 'down'),
        hi: snapIdxTick(lastClose + 0.2 * atr, 'up'),
        source: 'Deterministik Scalping ATR-14'
      };
    } else if (hz === 'inv') {
      return {
        entry: snappedEntry,
        sl: snapIdxTick(lastClose - 3.5 * atr, 'down'),
        tp1: snapIdxTick(lastClose + 6.0 * atr, 'up'),
        tp2: snapIdxTick(lastClose + 10.0 * atr, 'up'),
        lo: snapIdxTick(lastClose - 1.0 * atr, 'down'),
        hi: snappedEntry,
        source: 'Deterministik Nilai Wajar Investor'
      };
    } else {
      return {
        entry: snappedEntry,
        sl: snapIdxTick(lastClose - 2.0 * atr, 'down'),
        tp1: snapIdxTick(lastClose + 3.0 * atr, 'up'),
        tp2: snapIdxTick(lastClose + 5.0 * atr, 'up'),
        lo: snapIdxTick(lastClose - 0.6 * atr, 'down'),
        hi: snapIdxTick(lastClose + 0.4 * atr, 'up'),
        source: 'Deterministik Swing ATR-14'
      };
    }
  }
  function loadPlans(ticker) {
    var t = String(ticker || '').toUpperCase();
    if (!t) return Promise.resolve({ scalp: null, swing: null, inv: null });
    var c = cache[t];
    if (c && Date.now() - c.at < CACHE_MS) return Promise.resolve(c.plans);
    if (_plansInFlight[t]) return _plansInFlight[t];
    var req = Promise.all([
      fetchRows('/api/sector-hot?action=screener'),
      fetchRows('/api/sector-hot?action=nk-screener-results'),
      fetchRows('/api/sector-hot?action=daytrade-screener')
    ]).then(function (all) {
      // The response may belong to a ticker the user has already left. The
      // `deriveDeterministicPlan` fallback reads THIS ticker's candles from the
      // bus, so a late plan for another ticker cannot borrow them.
      var curCandles = planCandles(t);
      var curClose = (curCandles && curCandles.length > 0) ? Number(curCandles[curCandles.length - 1].close) : null;
      var swingRow = findRow(all[0], t, 'Swing Konglo') || findRow(all[1], t, 'Swing Non-Konglo');
      var rawScalp = levelsOf(findRow(all[2], t, 'Day Trade'), curClose);
      var rawSwing = levelsOf(swingRow, curClose);
      // ADDENDUM P0 FIX: Jika plan ditolak karena stale (>25%), pertahankan objek status tidak actionable.
      // Jangan otomatis diganti dengan plan tampak meyakinkan jika dasar strategi belum tervalidasi.
      var scalpPlan = rawScalp ? rawScalp : deriveDeterministicPlan(t, 'scalp');
      var swingPlan = rawSwing ? rawSwing : deriveDeterministicPlan(t, 'swing');
      var invPlan = deriveDeterministicPlan(t, 'inv');
      var plans = { scalp: scalpPlan, swing: swingPlan, inv: invPlan };
      // BUG-V6-I: jangan cache plan yang gate deviasinya belum bisa dijalankan
      // (harga pasar belum tersedia saat fetch). Tanpa ini, plan VALID semu
      // terkunci 10 menit dan lolos walau candle aktif menyimpang >25%.
      if (curClose != null) cache[t] = { at: Date.now(), plans: plans };
      return plans;
    }).catch(function() {
      var plans = {
        scalp: deriveDeterministicPlan(t, 'scalp'),
        swing: deriveDeterministicPlan(t, 'swing'),
        inv: deriveDeterministicPlan(t, 'inv')
      };
      if (hasCandlesFor(t)) cache[t] = { at: Date.now(), plans: plans };
      return plans;
    }).finally(function () {
      delete _plansInFlight[t];
    });
    _plansInFlight[t] = req;
    return req;
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

    // REQ-13: Validasi matematis percentile p10-p90 vs Target Harga (TP1, TP2) dan Stop Loss (SL)
    // Target harga dikatakan berada di luar rentang jika TP > p90 ATAU TP < p10 (di bawah batas bawah rentang)
    var tpOut = null;
    var tpOutReason = null;

    var tp2 = plan.tp2 ? Number(plan.tp2) : null;
    var tp1 = plan.tp1 ? Number(plan.tp1) : null;
    var sl = plan.sl ? Number(plan.sl) : null;
    var p10 = Number(rng.p10);
    var p90 = Number(rng.p90);

    if (tp2 != null) {
      if (tp2 > p90) { tpOut = 'TP2'; tpOutReason = '> p90'; }
      else if (tp2 < p10) { tpOut = 'TP2'; tpOutReason = '< p10'; }
    }
    if (!tpOut && tp1 != null) {
      if (tp1 > p90) { tpOut = 'TP1'; tpOutReason = '> p90'; }
      else if (tp1 < p10) { tpOut = 'TP1'; tpOutReason = '< p10'; }
    }

    var s = 'p10 ' + Math.round(p10).toLocaleString('id-ID') + ' – p90 ' + Math.round(p90).toLocaleString('id-ID');
    if (tpOut) {
      var targetVal = (tpOut === 'TP2' ? tp2 : tp1);
      s += ' · ' + tpOut + ' ' + Math.round(targetVal).toLocaleString('id-ID') + ' ' + tpOutReason;
    }
    if (sl != null && sl < p10) {
      s += ' · SL di bawah p10';
    } else if (sl != null && sl > p90) {
      s += ' · SL di atas p90';
    }

    var isInside = !tpOut;
    return {
      cls: isInside ? 'ok' : 'w',
      v: isInside ? 'Target di dalam rentang' : (tpOut + ' di luar rentang'),
      s: s
    };
  }

  function sheet() { return doc.getElementById('anaPlanSheet'); }
  function hzBar(isIdx) {
    var opts = isIdx ? [['scalp', 'Harian'], ['swing', 'Mingguan'], ['inv', 'Bulanan']] : [['scalp', 'Scalping'], ['swing', 'Swing'], ['inv', 'Investor']];
    var k = opts.map(function (o) { return o[0]; }).indexOf(state.hz);
    return '<div class="segx n3 ana-hz" role="group" aria-label="' + (isIdx ? 'Horizon arah' : 'Rencana untuk') + '"><span class="ind' + (k > 0 ? ' k' + k : '') + '"></span>' +
      opts.map(function (o) { return '<button type="button" class="' + (o[0] === state.hz ? 'on' : '') + '" aria-pressed="' + (o[0] === state.hz) + '" data-hz="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div>';
  }

  function renderStock(el, t) {
    // BUG-V6-I: gate deviasi ditegakkan ULANG di titik render memakai harga
    // terverifikasi milik ticker ini. Plan hasil cache yang dimuat sebelum
    // candle tiba tidak bisa lagi lolos sebagai kalkulator actionable.
    var plan = enforcePlanFreshness(state.plans[state.hz] || deriveDeterministicPlan(t, state.hz), t);
    var h = HZ[state.hz] || HZ.swing;
    var head = '<div class="ana-hzbar"><span class="ana-hzl">Rencana untuk</span>' + hzBar(false) +
      '<span class="ana-hzm"><b>' + esc(h.h) + '</b> · ' + esc(h.stop) + '</span><span class="ana-hzs">' + esc(plan && plan.source ? h.src + ' · ' + plan.source : h.src) + '</span></div>';
    if (state.loading) { el.innerHTML = head + '<div class="ana-plan-empty">Memuat rencana…</div>'; return; }
    if (!plan) {
      // BUG-V5-P0-009 / BUG-V5-P1-024: no identity-verified candles AND no
      // server levels for this ticker. Rather than publishing invented levels
      // (the old 9860 / 7480 / 5000 defaults), say so explicitly.
      el.innerHTML = head + '<div class="ana-plan-empty">Rencana untuk ' + esc(t) + ' belum tersedia. ' +
        'Muat chart ticker ini terlebih dahulu, atau pilih ticker yang punya level dari engine.</div>';
      return;
    }
    if (plan.actionable === false || plan.status === 'STALE_PLAN_REJECTED' || plan.status === 'PRICE_UNVERIFIED') {
      var dateInfo = plan.as_of ? (' Tanggal screener: ' + String(plan.as_of).slice(0, 10) + '.') : '';
      var isStale = plan.status === 'STALE_PLAN_REJECTED';
      var badge = isStale ? 'STALE_PLAN_REJECTED' : 'PRICE_UNVERIFIED';
      var title = isStale
        ? 'Plan Tidak Dapat Digunakan (Deviasi > 25%)'
        : 'Plan Belum Dapat Divalidasi (Harga Pasar Belum Terverifikasi)';
      el.innerHTML = head + '<div class="ana-plan-empty" data-plan-gate="' + badge + '" style="border-color:rgba(239,68,68,0.4);background:rgba(239,68,68,0.06);color:#fca5a5;padding:16px;border-radius:8px">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
          '<span style="background:#dc2626;color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;letter-spacing:0.5px">' + badge + '</span>' +
          '<span style="background:rgba(239,68,68,0.2);color:#f87171;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px">NEEDS_RECALCULATION</span>' +
        '</div>' +
        '<b style="color:#f87171;font-size:13px">' + esc(title) + '</b><br>' +
        '<div style="font-size:12px;margin-top:4px;color:#cbd5e1">' + esc(plan.reason || 'Harga pasar telah bergerak jauh melampaui toleransi rencana.') + esc(dateInfo) + '</div>' +
        '<div style="font-size:11px;margin-top:6px;color:#94a3b8">Sistem menolak mengganti plan ini secara otomatis dengan plan acak agar tidak menyamarkan risiko dasar strategi yang belum divalidasi ulang.</div>' +
      '</div>';
      return;
    }
    var c = calc(plan, state.lots);
    // The volatility band must come from THIS ticker's candles, never from
    // whatever the shared slot last held.
    var rc = rangeCheck(state.hz, plan, range10(planCandles(t)));
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
      // BUG-V6-I: garis harga plan juga wajib lolos gate freshness, supaya chart
      // tidak menggambar entry/SL/TP yang menyimpang jauh dari candle aktif.
      var plan = isIndex(state.ticker) ? null : enforcePlanFreshness(state.plans[state.hz], state.ticker);
      if (!plan || plan.actionable === false) { ws.clearPlanPriceLines(e.candleSeries); return; }
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
      // BUG-V5-P0-009: a plan that resolves after the user switched ticker is
      // discarded, mirroring the sequence discipline in the chart loader.
      if (state.ticker !== t) return;
      state.plans = plans; state.loading = null;
      // A plan derived while the chart was still loading has null levels
      // (deriveDeterministicPlan refuses to invent prices). Re-derive now that
      // identity-verified candles for this ticker may exist.
      if (!plans[state.hz] && hasCandlesFor(t)) {
        plans[state.hz] = deriveDeterministicPlan(t, state.hz);
      }
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
    // BUG-V6-I: diekspos agar regresi stale-plan gate bisa diuji unit tanpa browser.
    enforcePlanFreshness: enforcePlanFreshness, lastVerifiedClose: lastVerifiedClose,
    STALE_DEVIATION_MAX: STALE_DEVIATION_MAX,
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
    // BUG-V5-P0-009: the direction read is computed from the index's own
    // identity-verified candles, never from whatever the shared slot held.
    var ix = potential(planCandles(t), hz);
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
    var reg = root.__chartRegistry || {};
    var id = Object.keys(reg).find(function (k) { var e = reg[k]; return e && e.candleSeries && String(e.ticker || '').toUpperCase() === state.ticker; });
    if (!id) return;
    var e = reg[id];
    if (!e || !e.mainChart || e.mainChart.__acDead) return;

    if (isIndex(state.ticker)) {
      var ix = potential(planCandles(state.ticker), state.hz);
      if (!ix || ix.insufficient) return;
      try { drawOverlay(id, e, ix); } catch (_) { /* the chart was replaced mid-draw; the next render draws again */ }
    } else {
      // Stock chart: 10-day fair range cone ONLY for Scalping and Swing; NOT for Investor
      if (state.hz === 'scalp' || state.hz === 'swing') {
        try { drawStockCone(id, e, planCandles(state.ticker), state.hz); } catch (_) {}
      }
    }
  };

  function drawStockCone(id, e, candles, hz) {
    if (hz === 'inv') return;
    var r10 = range10(candles);
    if (!r10 || !candles || !candles.length) return;
    var last = candles[candles.length - 1];
    var c0 = Number(last.close);
    if (!(c0 > 0)) return;

    var cs = getComputedStyle(doc.getElementById(id + '_container') || doc.body);
    var info = String(cs.getPropertyValue('--ac-info') || '').trim() || '#315F9A';
    var days = futureDays(last.time, 10);
    if (!days.length) return;

    var t0 = last.time, qm = days.length;
    var path = function (target) {
      return [{ time: t0, value: c0 }].concat(days.map(function (t, q) {
        var f = Math.sqrt((q + 1) / qm);
        return { time: t, value: c0 * Math.exp(Math.log(target / c0) * f) };
      }));
    };

    var add = function (opts, data) {
      var srOpts = Object.assign({
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false
      }, opts);
      var s = (typeof e.mainChart.addSeries === 'function' && root.LightweightCharts && root.LightweightCharts.LineSeries)
        ? e.mainChart.addSeries(root.LightweightCharts.LineSeries, srOpts, 0)
        : e.mainChart.addLineSeries(srOpts);
      s.setData(data);
      overlay.series.push(s);
      return s;
    };

    // Upper and lower boundary of the 10-day fair range cone
    add({ color: info, lineWidth: 1, lineStyle: 2, title: 'p90 10H' }, path(r10.p90));
    add({ color: info, lineWidth: 1, lineStyle: 2, title: 'p10 10H' }, path(r10.p10));

    overlay.id = id;

    // Show the cone: open the right edge to the end of the projection
    try {
      var ts = e.mainChart.timeScale(), lr = ts.getVisibleLogicalRange();
      var n = typeof e.candleSeries.data === 'function' ? e.candleSeries.data().length : candles.length;
      var edge = n - 1 + days.length + 2;
      if (!e.mainChart.__acCone && e.defaultRange) {
        ts.setVisibleLogicalRange({ from: e.defaultRange.from, to: Math.max(e.defaultRange.to, edge) });
      } else if (lr && lr.to < edge) {
        ts.setVisibleLogicalRange({ from: lr.from, to: edge });
      }
      e.mainChart.__acCone = true;
    } catch (_) {}
  }
  function drawOverlay(id, e, ix) {
    var cs = getComputedStyle(doc.getElementById(id + '_container') || doc.body);
    var info = String(cs.getPropertyValue('--ac-info') || '').trim() || '#315F9A';
    var pos = String(cs.getPropertyValue('--ac-pos') || '').trim() || '#247A43';
    var neg = String(cs.getPropertyValue('--ac-neg') || '').trim() || '#AD3F52';
    var days = futureDays(ix.last.t, ix.z.ext);
    if (!days.length) return;
    var t0 = ix.last.t, qm = days.length;
    var path = function (target) { return [{ time: t0, value: ix.c0 }].concat(days.map(function (t, q) { var f = Math.sqrt((q + 1) / qm); return { time: t, value: ix.c0 * Math.exp(Math.log(target / ix.c0) * f) }; })); };
    var add = function (opts, data) {
      var srOpts = Object.assign({ priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, opts);
      var s = (typeof e.mainChart.addSeries === 'function' && root.LightweightCharts && root.LightweightCharts.LineSeries)
        ? e.mainChart.addSeries(root.LightweightCharts.LineSeries, srOpts, 0)
        : e.mainChart.addLineSeries(srOpts);
      s.setData(data);
      overlay.series.push(s);
      return s;
    };
    add({ color: info, lineWidth: 1, lineStyle: 2 }, path(ix.p90));
    add({ color: info, lineWidth: 1, lineStyle: 2 }, path(ix.p10));
    var upMain = ix.bias === 'up', dnMain = ix.bias === 'down';
    add({ color: pos, lineWidth: upMain ? 3 : 1, lineStyle: upMain ? 0 : 2 }, [{ time: t0, value: ix.c0 }, { time: days[Math.min(days.length - 1, Math.round(days.length * 0.6))], value: ix.upT.v }]);
    add({ color: neg, lineWidth: dnMain ? 3 : 1, lineStyle: dnMain ? 0 : 2 }, [{ time: t0, value: ix.c0 }, { time: days[Math.min(days.length - 1, Math.round(days.length * 0.6))], value: ix.dnT.v }]);
    var short = root.innerWidth < 520;
    var guard = root.AutoCuanRightAxisGuard;
    var line = function (price, title, color) {
      try {
        var showAxis = guard ? guard.canPlace(id, e.candleSeries, price, 20, 4) : true;
        overlay.lines.push(e.candleSeries.createPriceLine({ price: price, color: color, lineWidth: 1, lineStyle: 3, axisLabelVisible: showAxis, title: showAxis ? title : '' }));
      } catch (_) {}
    };
    ix.R.forEach(function (v, i) { line(v, (short ? 'R' : '▲ R') + (i + 1), pos); });
    ix.S.forEach(function (v, i) { line(v, (short ? 'S' : '▼ S') + (i + 1), neg); });
    overlay.id = id;
    // Show the cone: open the right edge to the end of the projection, once
    // (redraws on horizon change must not keep widening the view).
    try {
      var ts = e.mainChart.timeScale(), lr = ts.getVisibleLogicalRange();
      var n = typeof e.candleSeries.data === 'function'
        ? e.candleSeries.data().length
        : planCandles(state.ticker).length;
      var edge = n - 1 + days.length + 2;
      // First draw on a new chart: the chosen range plus the cone. Adding the
      // cone series can land before the chart applied that range.
      if (!e.mainChart.__acCone && e.defaultRange) ts.setVisibleLogicalRange({ from: e.defaultRange.from, to: Math.max(e.defaultRange.to, edge) });
      else if (lr && lr.to < edge) ts.setVisibleLogicalRange({ from: lr.from, to: edge });
      e.mainChart.__acCone = true;
    } catch (_) {}
  }

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
