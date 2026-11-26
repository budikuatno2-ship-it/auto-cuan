/**
 * F3 (CHT wiring) — chart-auto-patterns-runtime.js
 *
 * Wires the F1/F2 pure detectors (lib/chart-core, bundled to
 * public/chart-core-browser.js) into the REAL chart surface:
 *
 *   - runs detectors over the loaded candle series on each render / ticker /
 *     timeframe change (incremental, keyed by a source_hash of the series);
 *   - converts every detector result into overlay objects carrying REAL
 *     candle-index + price anchors (never static screen coordinates), so the
 *     existing `classifyPatternGeometry` guard classifies them VERIFIED;
 *   - renders lifecycle states through the existing verified-anchor overlay
 *     pipeline (projectVerifiedAnchors + resolveLabelCollisions);
 *   - exposes per-family toggles + preset defaults for the existing 4-category
 *     drawer (Pattern category);
 *   - provides honest mode guards (Scalping / Day Trade / Short Swing) and
 *     RSI/MACD/OBV pane series for the existing synced sub-chart panes.
 *
 * Pure logic (no DOM) is exported for Node tests; the browser integration is
 * guarded so a headless environment can never break chart rendering.
 *
 * No third-party dependencies. No lookahead (delegated to the detectors).
 * No provider API calls. No fabricated shapes: insufficient data => honest
 * empty state (data-overlay-empty).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var cDep = null;
    try { cDep = require('../lib/chart-core'); } catch (_) {}
    module.exports = factory(cDep, root);
  } else if (typeof define === 'function' && define.amd) {
    define(['./chart-core-browser'], function (cDep) { return factory(cDep, root); });
  } else {
    var cDep = (root && root.AutoCuanChartCore) ? root.AutoCuanChartCore : null;
    var exported = factory(cDep, root);
    root.AutoCuanChartAutoPatterns = exported;
    root.AutoCuanChartPatternsRuntime = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (coreDep, root) {
  'use strict';

  var VERSION = 'chart-auto-patterns-v1';

  // ------------------------------------------------------------------
  // Detector families (each maps to a drawer toggle in the Pattern category)
  // ------------------------------------------------------------------
  var FAMILIES = [
    { id: 'sr', name: 'Support & Resistance (auto)', group: 'level_area', simple: true, pro: true },
    { id: 'fibonacci', name: 'Fibonacci (auto)', group: 'fibonacci', simple: true, pro: true },
    { id: 'candlestick', name: 'Pola Candlestick', group: 'pola_klasik', simple: true, pro: true },
    { id: 'pivots', name: 'Swing Pivots', group: 'struktur', simple: false, pro: true },
    { id: 'zigzag', name: 'ZigZag', group: 'struktur', simple: false, pro: true },
    { id: 'trendlines', name: 'Trendline & Channel', group: 'struktur', simple: false, pro: true },
    { id: 'gaps', name: 'Session Gap', group: 'struktur', simple: false, pro: true },
    { id: 'divergence', name: 'Divergence', group: 'sinyal', simple: false, pro: true },
    { id: 'fvg', name: 'Fair Value Gap (FVG)', group: 'struktur', simple: false, pro: true },
    { id: 'smc_structure', name: 'BOS / CHoCH', group: 'struktur', simple: false, pro: true },
    { id: 'order_blocks', name: 'Order Block & Sweep', group: 'struktur', simple: false, pro: true },
    { id: 'classical', name: 'Pola Klasik', group: 'pola_klasik', simple: false, pro: true },
    { id: 'harmonic', name: 'Harmonic XABCD', group: 'pola_klasik', simple: false, pro: true },
    { id: 'elliott', name: 'Elliott Wave', group: 'pola_klasik', simple: false, pro: true }
  ];

  var FAMILY_IDS = FAMILIES.map(function (f) { return f.id; });

  // FINAL CLEAN 5-FILE WAVE / FIX 1: every default preset is clean.
  // Candlestick/pivot labels, ZigZag mesh, XABCD projection, LPM dots and
  // stacked ATR boxes are ALL off by default in Simpel/Scalping/Swing/
  // Investor/Pro. All 14 detectors remain reachable manually via the
  // Mode & Layer drawer (familyOverrides), so no capability is removed.
  var PRESET_FAMILIES = {
    simpel: [],
    scalping: [],
    swing: [],
    investor: [],
    pro: []
  };

  var DEFAULT_MAX_OVERLAYS = 200;
  var LIFECYCLE_RANK = { CONFIRMED: 0, PROVISIONAL: 1, PROJECTION: 2, FORMING: 3, INVALIDATED: 4, EXPIRED: 5 };

  // ------------------------------------------------------------------
  // Core access (browser bundle or Node require)
  // ------------------------------------------------------------------
  function getCore() {
    if (coreDep) return coreDep;
    var win = (typeof root !== 'undefined' && root) ? root : (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
    if (win && win.AutoCuanChartCore) return win.AutoCuanChartCore;
    if (typeof module === 'object' && module.exports) {
      try { return require('../lib/chart-core'); } catch (_) { return null; }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Incremental key: source_hash of the candle series
  // ------------------------------------------------------------------
  function computeSourceHash(candles) {
    var arr = Array.isArray(candles) ? candles : [];
    var n = arr.length;
    if (n === 0) return 'empty';
    var last = arr[n - 1] || {};
    var first = arr[0] || {};
    var parts = [
      n,
      String(first.time != null ? first.time : 0),
      String(last.time != null ? last.time : 0),
      Number(last.open) || 0,
      Number(last.high) || 0,
      Number(last.low) || 0,
      Number(last.close) || 0,
      Number(last.volume) || 0
    ];
    // Include interior candle cumulative metrics and distributed samples so
    // modifications to any interior candle invalidate the cached hash.
    var sumClose = 0, sumHigh = 0, sumLow = 0, sumVol = 0;
    for (var ci = 0; ci < n; ci++) {
      var c = arr[ci] || {};
      sumClose += (Number(c.close) || 0);
      sumHigh += (Number(c.high) || 0);
      sumLow += (Number(c.low) || 0);
      sumVol += (Number(c.volume) || 0);
    }
    parts.push(Math.round(sumClose * 100), Math.round(sumHigh * 100), Math.round(sumLow * 100), Math.round(sumVol));
    var sampleCount = Math.min(n, 10);
    var step = (n - 1) / Math.max(1, sampleCount - 1);
    for (var s = 0; s < sampleCount; s++) {
      var sIdx = Math.round(s * step);
      var sc = arr[sIdx] || {};
      parts.push(sIdx, sc.time, sc.high, sc.close);
    }
    // Cheap deterministic FNV-1a over the signature (not cryptographic; the
    // lifecycle module owns the cryptographic hash for audit records).
    var str = parts.join('|');
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return 'sh_' + h.toString(16) + '_' + n;
  }

  // ------------------------------------------------------------------
  // Anchor helpers — every overlay point carries {index, price}
  // ------------------------------------------------------------------
  function anchor(index, price, time) {
    return { index: Number(index), price: Number(price), time: time != null ? time : index };
  }

  function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

  // ------------------------------------------------------------------
  // Detector runners -> overlay objects (real anchors, lifecycle state)
  // ------------------------------------------------------------------
  function runDetectors(candles, families, options) {
    var core = getCore();
    var opts = options || {};
    var bars = Array.isArray(candles) ? candles : [];
    var fams = Array.isArray(families) && families.length ? families : FAMILY_IDS;
    var out = [];
    if (!core || bars.length === 0) return out;

    var k = isFiniteNum(opts.k) ? opts.k : 3;
    var asOf = bars.length - 1;

    function push(o) { if (o) out.push(o); }

    if (fams.indexOf('sr') !== -1) {
      try {
        var zones = core.supportResistance.detectSupportResistance(bars, { k: k });
        zones.forEach(function (z, i) {
          var mid = (Number(z.price_low) + Number(z.price_high)) / 2;
          push({
            family: 'sr', kind: 'zone', label: 'S/R ' + (z.touches || 0) + 'x',
            state: 'CONFIRMED',
            points: [anchor(z.last_touch_index != null ? z.last_touch_index : asOf, mid)],
            zone: { top: Number(z.price_high), bottom: Number(z.price_low) },
            strength: z.strength || 1, id: 'sr_' + i
          });
        });
      } catch (_) {}
    }

    if (fams.indexOf('fibonacci') !== -1) {
      try {
        var fib = core.fibonacci.detectFibonacci(bars, { k: k, asOfIndex: asOf });
        if (fib && fib.swing) {
          var st = fib.status === 'confirmed' ? 'CONFIRMED' : 'PROVISIONAL';
          var pts = [anchor(fib.swing.from.index, fib.swing.from.price, fib.swing.from.time),
                     anchor(fib.swing.to.index, fib.swing.to.price, fib.swing.to.time)];
          (fib.levels || []).forEach(function (lv, i) {
            push({
              family: 'fibonacci', kind: 'level', label: 'Fib ' + (lv.ratio * 100).toFixed(1) + '%',
              state: st, points: pts.slice(), level: Number(lv.price), ratio: lv.ratio, id: 'fib_' + i
            });
          });
          (fib.extensions || []).forEach(function (ex, i) {
            push({
              family: 'fibonacci', kind: 'extension', label: 'Fib Ext ' + (ex.ratio * 100).toFixed(1) + '%',
              state: 'PROJECTION', points: pts.slice(), level: Number(ex.price), ratio: ex.ratio, id: 'fibx_' + i
            });
          });
        }
      } catch (_) {}
    }

    if (fams.indexOf('candlestick') !== -1) {
      try {
        var cps = core.candlestickPatterns.detectCandlestickPatterns(bars);
        cps.forEach(function (p, i) {
          var bar = bars[p.index] || {};
          push({
            family: 'candlestick', kind: 'marker', label: p.pattern,
            state: 'CONFIRMED', direction: p.direction,
            points: [anchor(p.index, Number(bar.close) || Number(bar.high) || 0, p.time)],
            confidence: p.confidence, id: 'cs_' + i
          });
        });
      } catch (_) {}
    }

    if (fams.indexOf('pivots') !== -1) {
      try {
        var piv = core.pivots.detectPivots(bars, { k: k });
        piv.forEach(function (p, i) {
          push({
            family: 'pivots', kind: 'pivot', label: p.type === 'high' ? 'H' : 'L',
            state: 'CONFIRMED', points: [anchor(p.index, p.price, p.time)], id: 'pv_' + i
          });
        });
      } catch (_) {}
    }

    if (fams.indexOf('zigzag') !== -1) {
      try {
        // buildZigZag returns an ARRAY of legs: {from_index,from_time,from_price,
        // to_index,to_time,to_price,direction}.
        var zz = core.zigzag.buildZigZag(bars, { k: k });
        var legs = Array.isArray(zz) ? zz : ((zz && zz.legs) || []);
        legs.forEach(function (leg, i) {
          push({
            family: 'zigzag', kind: 'leg', label: 'ZZ',
            state: 'CONFIRMED',
            points: [anchor(leg.from_index, leg.from_price, leg.from_time),
                     anchor(leg.to_index, leg.to_price, leg.to_time)],
            id: 'zz_' + i
          });
        });
      } catch (_) {}
    }

    if (fams.indexOf('trendlines') !== -1) {
      try {
        // detectTrendlines returns {resistance:[], support:[], channels:[]}.
        var tl = core.trendlines.detectTrendlines(bars, { k: k }) || {};
        var tlLines = [].concat(tl.resistance || [], tl.support || []);
        tlLines.forEach(function (line, i) {
          var p1 = line.p1 || {}, p2 = line.p2 || {};
          if (!isFiniteNum(p1.index) || !isFiniteNum(p2.index)) return;
          push({
            family: 'trendlines', kind: 'line', label: line.type === 'resistance' ? 'Resistance' : 'Support',
            state: 'CONFIRMED',
            points: [anchor(p1.index, p1.price), anchor(p2.index, p2.price)],
            slope: line.slope, intercept: line.intercept, id: 'tl_' + i
          });
        });
      } catch (_) {}
    }

    if (fams.indexOf('gaps') !== -1) {
      try {
        var gaps = core.gaps.detectGaps(bars);
        gaps.forEach(function (g, i) {
          var st = g.state === 'filled' ? 'EXPIRED' : 'CONFIRMED';
          push({
            family: 'gaps', kind: 'gap', label: 'Gap ' + (g.type === 'up' ? 'Up' : 'Down'),
            state: st, reason: g.state,
            points: [anchor(g.gap_index, (Number(g.gap_top) + Number(g.gap_bottom)) / 2, g.gap_time)],
            zone: { top: Number(g.gap_top), bottom: Number(g.gap_bottom) }, id: 'gp_' + i
          });
        });
      } catch (_) {}
    }

    if (fams.indexOf('divergence') !== -1) {
      try {
        var closes = bars.map(function (b) { return Number(b.close); });
        var rsi = core.oscillators.rsi(closes, 14);
        var div = core.divergence.detectDivergence(bars, rsi, { k: k, asOfIndex: asOf });
        (div.bullish || []).forEach(function (d, i) {
          push({
            family: 'divergence', kind: 'divergence', label: 'Bullish Div',
            state: div.provisional ? 'PROVISIONAL' : 'CONFIRMED', direction: 'bullish',
            points: [anchor(d.pivot1.index, d.pivot1.price), anchor(d.pivot2.index, d.pivot2.price)],
            id: 'dv_b_' + i
          });
        });
        (div.bearish || []).forEach(function (d, i) {
          push({
            family: 'divergence', kind: 'divergence', label: 'Bearish Div',
            state: div.provisional ? 'PROVISIONAL' : 'CONFIRMED', direction: 'bearish',
            points: [anchor(d.pivot1.index, d.pivot1.price), anchor(d.pivot2.index, d.pivot2.price)],
            id: 'dv_s_' + i
          });
        });
      } catch (_) {}
    }

    if (fams.indexOf('fvg') !== -1) {
      try {
        var fvgs = core.fvg.detectFVGs(bars);
        fvgs.forEach(function (f, i) {
          var st = f.state === 'fully-mitigated' ? 'EXPIRED' : (f.state === 'partially-mitigated' ? 'PROVISIONAL' : 'CONFIRMED');
          push({
            family: 'fvg', kind: 'fvg', label: 'FVG ' + (f.type === 'bullish' ? 'Bull' : 'Bear'),
            state: st, reason: f.state,
            points: [anchor(f.index, f.midpoint, f.time)],
            zone: { top: Number(f.zone.top), bottom: Number(f.zone.bottom) }, id: 'fvg_' + i
          });
        });
      } catch (_) {}
    }

    if (fams.indexOf('smc_structure') !== -1) {
      try {
        var st2 = core.smcStructure.analyzeStructure(bars, { k: k });
        (st2.events || []).forEach(function (e, i) {
          push({
            family: 'smc_structure', kind: 'event', label: e.type,
            state: e.confirmed ? 'CONFIRMED' : 'PROVISIONAL', direction: e.direction,
            points: [anchor(e.break_index, e.broken_level, e.break_time)],
            id: 'smc_' + i
          });
        });
      } catch (_) {}
    }

    if (fams.indexOf('order_blocks') !== -1) {
      try {
        var obs = core.smcOrderBlocks.detectOrderBlocks(bars, { k: k });
        obs.forEach(function (ob, i) {
          var st = ob.mitigated_index != null ? 'EXPIRED' : 'CONFIRMED';
          push({
            family: 'order_blocks', kind: 'order_block', label: 'OB ' + (ob.type === 'bullish' ? 'Bull' : 'Bear'),
            state: st,
            points: [anchor(ob.created_index, (Number(ob.zone.top) + Number(ob.zone.bottom)) / 2, ob.created_time)],
            zone: { top: Number(ob.zone.top), bottom: Number(ob.zone.bottom) }, id: 'ob_' + i
          });
        });
      } catch (_) {}
    }

    if (fams.indexOf('classical') !== -1) {
      try {
        var cls = core.classicalPatterns.detectClassicalPatterns(bars, { k: k });
        cls.forEach(function (p, i) {
          var st = p.confirmed ? 'CONFIRMED' : 'PROVISIONAL';
          // Some classical patterns (flags/pennants) carry time-only anchors
          // (index null). Those cannot be projected through the verified-anchor
          // pipeline, so they are skipped rather than rendered with fake coords.
          var pts = (p.anchors || [])
            .filter(function (a) { return a && isFiniteNum(a.index) && isFiniteNum(a.price) && a.price > 0; })
            .map(function (a) { return anchor(a.index, a.price, a.time); });
          if (pts.length < 2) return;
          push({
            family: 'classical', kind: 'pattern', label: p.pattern,
            state: st, direction: p.direction, points: pts, id: 'cl_' + i
          });
        });
      } catch (_) {}
    }

    if (fams.indexOf('harmonic') !== -1) {
      try {
        var har = core.harmonic.detectHarmonics(bars, { k: k });
        har.forEach(function (h, i) {
          var st = h.status === 'CONFIRMED' ? 'CONFIRMED' : 'PROVISIONAL';
          var pts = [];
          ['X', 'A', 'B', 'C', 'D'].forEach(function (lbl) {
            var p = h.points && h.points[lbl];
            if (p) pts.push(anchor(p.index, p.price, p.time));
          });
          if (pts.length === 0) return;
          push({
            family: 'harmonic', kind: 'harmonic', label: h.pattern,
            state: st, direction: h.direction, points: pts, id: 'hm_' + i
          });
        });
      } catch (_) {}
    }

    if (fams.indexOf('elliott') !== -1) {
      try {
        var ell = core.elliott.detectElliott(bars, { k: k });
        ell.forEach(function (w, i) {
          var st = w.status === 'CONFIRMED' ? 'CONFIRMED' : (w.status === 'INVALIDATED' ? 'INVALIDATED' : 'PROVISIONAL');
          var pts = [];
          (w.waves || []).forEach(function (wv) {
            var fp = wv.from_pivot || {}, tp = wv.to_pivot || {};
            if (isFiniteNum(fp.index) && isFiniteNum(fp.price)) pts.push(anchor(fp.index, fp.price, fp.time));
            if (isFiniteNum(tp.index) && isFiniteNum(tp.price)) pts.push(anchor(tp.index, tp.price, tp.time));
          });
          if (pts.length === 0) return;
          push({
            family: 'elliott', kind: 'wave', label: w.kind === 'impulse' ? 'Impulse' : 'ABC',
            state: st, direction: w.direction, points: pts, id: 'el_' + i
          });
          // Elliott alternatives are forward scenarios => PROJECTION (SKENARIO).
          (w.alternatives || []).forEach(function (alt, j) {
            push({
              family: 'elliott', kind: 'wave', label: 'SKENARIO ' + (alt.kind || 'alt'),
              state: 'PROJECTION', direction: w.direction, points: pts.slice(), id: 'el_alt_' + i + '_' + j
            });
          });
        });
      } catch (_) {}
    }

    // Final integrity gate: every overlay that leaves this function MUST carry
    // at least one real candle-index + real price anchor, otherwise the
    // classifyPatternGeometry guard would reject it (or worse, it would be
    // drawn from fabricated coordinates). Drop anything that fails.
    return out.filter(function (o) {
      var pts = Array.isArray(o.points) ? o.points : [];
      if (pts.length === 0) return false;
      return pts.every(function (p) {
        return p && Number.isFinite(Number(p.index)) && Number.isFinite(Number(p.price)) && Number(p.price) > 0;
      });
    });
  }

  // ------------------------------------------------------------------
  // Overlay selection: cap + priority (CONFIRMED > PROVISIONAL > PROJECTION)
  // ------------------------------------------------------------------
  function selectOverlays(overlays, maxOverlays) {
    var cap = isFiniteNum(maxOverlays) && maxOverlays > 0 ? maxOverlays : DEFAULT_MAX_OVERLAYS;
    var arr = Array.isArray(overlays) ? overlays.slice() : [];
    arr.sort(function (a, b) {
      var ra = LIFECYCLE_RANK[a.state] != null ? LIFECYCLE_RANK[a.state] : 9;
      var rb = LIFECYCLE_RANK[b.state] != null ? LIFECYCLE_RANK[b.state] : 9;
      return ra - rb;
    });
    var live = arr.filter(function (o) { return o.state !== 'INVALIDATED' && o.state !== 'EXPIRED'; });
    var dead = arr.filter(function (o) { return o.state === 'INVALIDATED' || o.state === 'EXPIRED'; });
    return {
      rendered: live.slice(0, cap),
      // INVALIDATED/EXPIRED are never rendered live; they are listed in the
      // pattern panel with their reason.
      panel: dead,
      truncated: Math.max(0, live.length - cap)
    };
  }

  // ------------------------------------------------------------------
  // Mode guards (honesty)
  // ------------------------------------------------------------------
  function detectBarIntervalMs(candles) {
    var arr = Array.isArray(candles) ? candles : [];
    if (arr.length < 2) return null;
    function toMs(t) {
      if (typeof t === 'number') return t > 1e12 ? t : t * 1000;
      if (typeof t === 'string') { var d = Date.parse(t); return isNaN(d) ? null : d; }
      if (t && typeof t === 'object' && t.year) return Date.UTC(t.year, (t.month || 1) - 1, t.day || 1);
      return null;
    }
    var a = toMs(arr[arr.length - 2].time), b = toMs(arr[arr.length - 1].time);
    if (a == null || b == null) return null;
    return Math.abs(b - a);
  }

  function isEodSeries(candles) {
    var iv = detectBarIntervalMs(candles);
    if (iv == null) return true; // unknown interval => treat as EOD (conservative)
    return iv >= 20 * 3600 * 1000; // >= 20h => daily/EOD
  }

  function evaluateScalpingGuard(candles, requestedTimeframe) {
    var tf = String(requestedTimeframe || '').toLowerCase();
    var intradayRequested = tf === '1m' || tf === '3m' || tf === '5m';
    if (isEodSeries(candles)) {
      return {
        ok: false, code: 'TIMEFRAME_DATA_UNAVAILABLE',
        badge: intradayRequested ? 'Data Harian EOD' : null,
        requestedTimeframe: tf || null,
        message: 'Mode Scalping butuh data intraday (menit). Seri yang dimuat adalah EOD harian — tidak ada bar menit yang difabrikasi.'
      };
    }
    return { ok: true, code: 'OK', badge: null, requestedTimeframe: tf || null, message: 'Data intraday tersedia.' };
  }

  // WIB session: 09:00–15:50 (IDX regular) with lunch breaks:
  // Mon-Thu: 12:00-13:30 WIB break
  // Fri: 11:30-14:00 WIB break
  function evaluateDayTradeSessionGuard(nowMs) {
    var ms = isFiniteNum(nowMs) ? nowMs : Date.now();
    var wib = new Date(ms + 7 * 3600000);
    var day = wib.getUTCDay(); // 0 Sun .. 6 Sat
    var mins = wib.getUTCHours() * 60 + wib.getUTCMinutes();
    var weekday = day >= 1 && day <= 5;
    if (!weekday) {
      return { ok: false, code: 'SESSION_CLOSED_WEEKEND', message: 'Di luar sesi bursa (akhir pekan). Tidak ada sinyal live.' };
    }
    var open = 9 * 60, close = 15 * 60 + 50;
    if (mins < open || mins > close) {
      return { ok: false, code: 'SESSION_CLOSED', message: 'Di luar sesi bursa WIB 09:00–15:50. Tidak ada sinyal live.' };
    }
    // Friday lunch break: 11:30 - 14:00 WIB
    if (day === 5) {
      if (mins >= 11 * 60 + 30 && mins < 14 * 60) {
        return { ok: false, code: 'SESSION_BREAK', message: 'Jeda istirahat perdagangan bursa IDX (Jumat 11:30–14:00 WIB).' };
      }
    } else {
      // Monday - Thursday lunch break: 12:00 - 13:30 WIB
      if (mins >= 12 * 60 && mins < 13 * 60 + 30) {
        return { ok: false, code: 'SESSION_BREAK', message: 'Jeda istirahat perdagangan bursa IDX (Senin–Kamis 12:00–13:30 WIB).' };
      }
    }
    return { ok: true, code: 'IN_SESSION', message: 'Dalam sesi bursa WIB.' };
  }

  // Short Swing: R/R >= 1.5 gate from the existing screener snapshot.
  function evaluateShortSwingGuard(snapshot, options) {
    var opts = options || {};
    var minRR = isFiniteNum(opts.minRR) ? opts.minRR : 1.5;
    var maxAgeMs = isFiniteNum(opts.maxAgeMs) ? opts.maxAgeMs : 24 * 3600 * 1000;
    var nowMs = isFiniteNum(opts.nowMs) ? opts.nowMs : Date.now();
    if (!snapshot || typeof snapshot !== 'object') {
      return { ok: false, code: 'NOT_READY', message: 'Snapshot screener belum tersedia — tidak ada sinyal.' };
    }
    var asOf = snapshot.asOf || snapshot.as_of || snapshot.updatedAt;
    var asOfMs = asOf ? (typeof asOf === 'number' ? (asOf > 1e12 ? asOf : asOf * 1000) : Date.parse(asOf)) : null;
    if (asOfMs == null || isNaN(asOfMs) || (nowMs - asOfMs) > maxAgeMs) {
      return { ok: false, code: 'NOT_READY_AS_OF_STALE', message: 'Snapshot screener kedaluwarsa (AS_OF_STALE) — tidak ada sinyal.' };
    }
    var rr = Number(snapshot.rr != null ? snapshot.rr : snapshot.rrRatio);
    if (!isFiniteNum(rr)) {
      return { ok: false, code: 'NOT_READY', message: 'Rasio R/R tidak tersedia pada snapshot — tidak ada sinyal.' };
    }
    if (rr < minRR) {
      return { ok: false, code: 'RR_BELOW_GATE', message: 'R/R ' + rr.toFixed(2) + 'x di bawah gate ' + minRR.toFixed(2) + 'x — tidak siap eksekusi.' };
    }
    return { ok: true, code: 'OK', message: 'R/R ' + rr.toFixed(2) + 'x memenuhi gate.' };
  }

  // ------------------------------------------------------------------
  // Pane series (RSI / MACD / OBV) for the existing synced sub-charts
  // ------------------------------------------------------------------
  function buildPaneSeries(candles, kind, options) {
    var core = getCore();
    var bars = Array.isArray(candles) ? candles : [];
    var opts = options || {};
    if (!core || bars.length === 0) return { kind: kind, points: [], empty: true, reason: 'NO_DATA' };
    var closes = bars.map(function (b) { return Number(b.close); });
    var points = [];
    if (kind === 'rsi') {
      var period = isFiniteNum(opts.period) ? opts.period : 14;
      var rsi = core.oscillators.rsi(closes, period);
      for (var i = 0; i < bars.length; i += 1) {
        if (rsi[i] == null) continue;
        points.push({ time: bars[i].time, value: rsi[i] });
      }
      if (points.length === 0) return { kind: 'rsi', points: [], empty: true, reason: 'INSUFFICIENT_PERIOD' };
      return { kind: 'rsi', points: points, empty: false, guides: [70, 30] };
    }
    if (kind === 'macd') {
      var m = core.oscillators.macd(closes, opts.fast, opts.slow, opts.signal);
      for (var j = 0; j < bars.length; j += 1) {
        if (m.macd[j] == null) continue;
        points.push({ time: bars[j].time, macd: m.macd[j], signal: m.signal[j], histogram: m.histogram[j] });
      }
      if (points.length === 0) return { kind: 'macd', points: [], empty: true, reason: 'INSUFFICIENT_PERIOD' };
      return { kind: 'macd', points: points, empty: false };
    }
    if (kind === 'obv') {
      var obv = core.oscillators.obv(bars);
      for (var k2 = 0; k2 < bars.length; k2 += 1) {
        if (obv[k2] == null) continue;
        points.push({ time: bars[k2].time, value: obv[k2] });
      }
      if (points.length === 0) return { kind: 'obv', points: [], empty: true, reason: 'INSUFFICIENT_PERIOD' };
      return { kind: 'obv', points: points, empty: false };
    }
    return { kind: kind, points: [], empty: true, reason: 'UNKNOWN_KIND' };
  }

  // ------------------------------------------------------------------
  // Preset / toggle helpers
  // ------------------------------------------------------------------
  function familiesForPreset(preset) {
    var p = String(preset || 'simpel').toLowerCase();
    if (p === 'simple') p = 'simpel';
    return (PRESET_FAMILIES[p] || PRESET_FAMILIES.simpel).slice();
  }

  function resolveActiveFamilies(preset, overrides) {
    var base = familiesForPreset(preset);
    var set = Object.create(null);
    base.forEach(function (f) { set[f] = true; });
    if (overrides && typeof overrides === 'object') {
      Object.keys(overrides).forEach(function (fid) {
        if (FAMILY_IDS.indexOf(fid) === -1) return;
        if (overrides[fid]) set[fid] = true; else delete set[fid];
      });
    }
    return FAMILY_IDS.filter(function (f) { return set[f]; });
  }

  // ------------------------------------------------------------------
  // Full pipeline: candles -> { rendered, panel, empty, sourceHash }
  // ------------------------------------------------------------------
  function computeOverlays(candles, families, options) {
    var opts = options || {};
    var bars = Array.isArray(candles) ? candles : [];
    var sourceHash = computeSourceHash(bars);
    if (bars.length < 5) {
      return { rendered: [], panel: [], empty: true, reason: 'INSUFFICIENT_DATA', sourceHash: sourceHash, truncated: 0 };
    }
    if (Array.isArray(families) && families.length === 0) {
      return { rendered: [], panel: [], empty: true, reason: 'ALL_FAMILIES_DISABLED', sourceHash: sourceHash, truncated: 0 };
    }
    var raw = runDetectors(bars, families, opts);
    var sel = selectOverlays(raw, opts.maxOverlays);
    return {
      rendered: sel.rendered,
      panel: sel.panel,
      empty: sel.rendered.length === 0,
      reason: sel.rendered.length === 0 ? 'NO_PATTERN_DETECTED' : null,
      sourceHash: sourceHash,
      truncated: sel.truncated
    };
  }

  // ------------------------------------------------------------------
  // Browser integration (guarded; never breaks chart rendering)
  // ------------------------------------------------------------------
  var _state = Object.create(null); // chartId -> { sourceHash, families, preset, overlays }

  function ensureOverlayHost(chartId) {
    if (typeof document === 'undefined') return null;
    var container = document.getElementById(chartId + '_container');
    if (!container) return null;
    container.style.position = 'relative';
    var host = document.getElementById(chartId + '_autopattern_overlay');
    if (!host) {
      host = document.createElement('div');
      host.id = chartId + '_autopattern_overlay';
      host.className = 'chart-autopattern-overlay';
      host.setAttribute('data-overlay-empty', 'true');
      host.style.cssText = 'position:absolute; inset:0; pointer-events:none; z-index:9; width:100%; height:100%; overflow:hidden;';
      container.appendChild(host);
    }
    return host;
  }

  function renderOverlay(chartId, overlays, empty, reason) {
    var host = ensureOverlayHost(chartId);
    if (!host) return;
    if (empty || !overlays || overlays.length === 0) {
      host.setAttribute('data-overlay-empty', 'true');
      host.setAttribute('data-overlay-reason', reason || 'NO_PATTERN_DETECTED');
      host.innerHTML = '';
      return;
    }
    host.setAttribute('data-overlay-empty', 'false');
    host.removeAttribute('data-overlay-reason');
    var win = (typeof root !== 'undefined' && root) ? root : (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
    var ws = (win && win.AutoCuanChartWorkstation) ? win.AutoCuanChartWorkstation : null;
    var svg = buildOverlaySvg(overlays, ws);
    host.innerHTML = svg;
  }

  // Build an SVG overlay from verified anchors. Uses the workstation's
  // projectVerifiedAnchors + resolveLabelCollisions when available so the
  // geometry matches the existing overlay pipeline exactly.
  function buildOverlaySvg(overlays, ws) {
    var W = 800, H = 320;
    var plot = { x0: 40, x1: 760, y0: 40, y1: 300 };
    var labels = [];
    var body = '';
    var allPoints = [];
    overlays.forEach(function (o) { (o.points || []).forEach(function (p) { allPoints.push(p); }); });
    if (allPoints.length === 0) return '';
    var maxIndex = 0;
    allPoints.forEach(function (p) { maxIndex = Math.max(maxIndex, Number(p.index) || 0); });
    var prices = allPoints.map(function (p) { return Number(p.price); }).filter(isFiniteNum);
    var pMin = Math.min.apply(null, prices), pMax = Math.max.apply(null, prices);
    var span = (pMax - pMin) || 1;
    var bounds = { pMin: pMin, pMax: pMax, maxIndex: maxIndex, minIndex: 0 };
    var projectedList = (ws && typeof ws.projectVerifiedAnchors === 'function')
      ? ws.projectVerifiedAnchors(allPoints, plot, bounds)
      : [];
    var pointProjMap = (typeof Map !== 'undefined') ? new Map() : null;
    if (pointProjMap && Array.isArray(projectedList) && projectedList.length === allPoints.length) {
      for (var pi = 0; pi < allPoints.length; pi++) {
        pointProjMap.set(allPoints[pi], projectedList[pi]);
      }
    }
    function proj(p) {
      if (pointProjMap && pointProjMap.has(p)) return pointProjMap.get(p);
      if (ws && typeof ws.projectVerifiedAnchors === 'function') {
        var r = ws.projectVerifiedAnchors([p], plot, bounds);
        if (r && r.length) return r[0];
      }
      return {
        x: plot.x0 + ((Number(p.index) || 0) / (maxIndex || 1)) * (plot.x1 - plot.x0),
        y: plot.y0 + ((pMax - Number(p.price)) / span) * (plot.y1 - plot.y0)
      };
    }
    overlays.forEach(function (o) {
      var pts = (o.points || []).map(proj);
      if (pts.length === 0) return;
      var dash = o.state === 'PROVISIONAL' ? ' stroke-dasharray="5,4"' : (o.state === 'PROJECTION' ? ' stroke-dasharray="2,4"' : '');
      var color = o.state === 'PROVISIONAL' ? '#f59e0b' : (o.state === 'PROJECTION' ? '#a855f7' : '#10b981');
      if (o.zone) {
        var zt = proj({ index: maxIndex, price: o.zone.top });
        var zb = proj({ index: maxIndex, price: o.zone.bottom });
        body += '<rect x="' + plot.x0 + '" y="' + Math.min(zt.y, zb.y).toFixed(1) + '" width="' + (plot.x1 - plot.x0) + '" height="' + Math.abs(zb.y - zt.y).toFixed(1) + '" fill="' + color + '" fill-opacity="0.08" stroke="' + color + '" stroke-opacity="0.4"' + dash + '/>';
      }
      if (pts.length >= 2) {
        var d = pts.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' ');
        body += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5"' + dash + '/>';
      }
      var last = pts[pts.length - 1];
      body += '<circle cx="' + last.x.toFixed(1) + '" cy="' + last.y.toFixed(1) + '" r="2.5" fill="' + color + '"/>';
      labels.push({ x: last.x, y: last.y, anchorY: last.y, text: o.label, color: color, state: o.state });
    });
    if (ws && typeof ws.resolveLabelCollisions === 'function') {
      labels = ws.resolveLabelCollisions(labels, 12, { top: plot.y0, bottom: plot.y1 });
    }
    labels.forEach(function (l) {
      body += '<text x="' + (l.x + 4).toFixed(1) + '" y="' + l.y.toFixed(1) + '" font-size="9" fill="' + l.color + '">' + escapeXml(l.text) + '</text>';
    });
    return '<svg width="100%" height="100%" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Auto pattern overlay">' + body + '</svg>';
  }

  // XML-escape using char codes so the entity text can never be mangled by an
  // editor/tool round-trip.
  var XML_AMP = String.fromCharCode(38) + 'amp;';
  var XML_LT = String.fromCharCode(38) + 'lt;';
  var XML_GT = String.fromCharCode(38) + 'gt;';
  var XML_QUOT = String.fromCharCode(38) + 'quot;';
  function escapeXml(s) {
    return String(s == null ? '' : s)
      .split(String.fromCharCode(38)).join(XML_AMP)
      .split(String.fromCharCode(60)).join(XML_LT)
      .split(String.fromCharCode(62)).join(XML_GT)
      .split(String.fromCharCode(34)).join(XML_QUOT);
  }

  // Hook: called from the render path (market-feature-runtime / workstation).
  // Incremental: recomputes only when the source_hash OR the family set changes.
  function attach(chartId, candles, ticker, options) {
    var opts = options || {};
    var bars = Array.isArray(candles) ? candles : [];
    var preset = opts.preset || 'simpel';
    // Caller may pass an explicit resolved family list (workstation state);
    // otherwise derive it from the preset + overrides.
    var families = Array.isArray(opts.families)
      ? opts.families.slice()
      : resolveActiveFamilies(preset, opts.familyOverrides);
    var famKey = families.slice().sort().join(',');
    var hash = computeSourceHash(bars);
    var prev = _state[chartId];
    if (prev && prev.sourceHash === hash && prev.famKey === famKey && !opts.force) {
      return prev.result; // no recompute on pan/zoom (anchors are data-space)
    }
    var result = computeOverlays(bars, families, opts);
    _state[chartId] = { sourceHash: hash, families: families, famKey: famKey, preset: preset, result: result };
    try { renderOverlay(chartId, result.rendered, result.empty, result.reason); } catch (_) {}
    return result;
  }

  // ------------------------------------------------------------------
  // Pane support (CHT-27): RSI / MACD / OBV as SEPARATE synced chart
  // instances below the main chart. This matches the existing codebase
  // approach (market-feature-runtime.js already creates a separate RSI
  // sub-chart and syncs its visible logical range). Panes are collapsible
  // and never rescale the main chart (independent price scales).
  // ------------------------------------------------------------------
  var _panes = Object.create(null); // chartId -> { wrapper, charts:{} }

  function mountPanes(chartId, candles, kinds, options) {
    var win = (typeof root !== 'undefined' && root) ? root : (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
    if (typeof document === 'undefined' || !win || !win.LightweightCharts) return null;
    var container = document.getElementById(chartId + '_container');
    if (!container || !container.parentNode) return null;
    var opts = options || {};
    var list = Array.isArray(kinds) && kinds.length ? kinds : ['rsi'];
    var mainReg = (win && win.__chartRegistry && win.__chartRegistry[chartId]) || null;
    var mainChart = mainReg && mainReg.mainChart;

    var wrapper = document.getElementById(chartId + '_autopattern_panes');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = chartId + '_autopattern_panes';
      wrapper.className = 'chart-autopattern-panes space-y-1.5 mt-2';
      container.parentNode.insertBefore(wrapper, container.nextSibling);
    }
    var entry = _panes[chartId] || { wrapper: wrapper, charts: {} };
    _panes[chartId] = entry;

    list.forEach(function (kind) {
      var paneId = chartId + '_pane_' + kind;
      var paneEl = document.getElementById(paneId);
      if (!paneEl) {
        paneEl = document.createElement('div');
        paneEl.id = paneId;
        paneEl.className = 'chart-autopattern-pane';
        paneEl.style.cssText = 'height:110px; position:relative;';
        wrapper.appendChild(paneEl);
      }
      var series = buildPaneSeries(candles, kind, opts);
      if (series.empty) {
        // Honest empty state: never plot 0 for an unavailable period.
        paneEl.setAttribute('data-pane-empty', 'true');
        paneEl.setAttribute('data-pane-reason', series.reason || 'INSUFFICIENT_PERIOD');
        paneEl.innerHTML = '<div class="flex items-center justify-center h-full text-gray-500 text-[11px]">' +
          escapeXml(kind.toUpperCase()) + ': data belum cukup (' + escapeXml(series.reason || 'INSUFFICIENT_PERIOD') + ')</div>';
        return;
      }
      paneEl.setAttribute('data-pane-empty', 'false');
      paneEl.innerHTML = '';
      // FIX 1: real numeric legend in the pane corner, computed from the
      // canonical series (never a placeholder or fabricated value).
      var _lastPoint = series.points[series.points.length - 1] || {};
      var _legendValue = _lastPoint.value != null ? _lastPoint.value : (_lastPoint.macd != null ? _lastPoint.macd : null);
      var _legendText = kind.toUpperCase() + (_legendValue != null && isFinite(Number(_legendValue)) ? ' ' + Number(_legendValue).toFixed(2) : '');
      var legendEl = document.createElement('div');
      legendEl.style.cssText = 'position:absolute;top:2px;left:8px;z-index:5;font-size:10px;font-weight:700;color:#94a3b8;pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,0.8);';
      legendEl.textContent = _legendText;
      paneEl.appendChild(legendEl);
      var paneChart = root.LightweightCharts.createChart(paneEl, {
        width: paneEl.clientWidth || 600,
        height: 110,
        layout: { background: { color: 'transparent' }, textColor: '#94a3b8' },
        grid: { vertLines: { color: 'rgba(148,163,184,0.08)' }, horzLines: { color: 'rgba(148,163,184,0.08)' } },
        rightPriceScale: { borderColor: 'rgba(148,163,184,0.2)' },
        timeScale: { borderColor: 'rgba(148,163,184,0.2)', visible: false },
        crosshair: { mode: 0 },
        handleScroll: false,
        handleScale: false
      });
      var addPaneLine = function (opts) {
        return (typeof paneChart.addSeries === 'function' && root.LightweightCharts && root.LightweightCharts.LineSeries)
          ? paneChart.addSeries(root.LightweightCharts.LineSeries, opts)
          : paneChart.addLineSeries(opts);
      };
      var addPaneHist = function (opts) {
        return (typeof paneChart.addSeries === 'function' && root.LightweightCharts && root.LightweightCharts.HistogramSeries)
          ? paneChart.addSeries(root.LightweightCharts.HistogramSeries, opts)
          : paneChart.addHistogramSeries(opts);
      };
      if (kind === 'rsi') {
        var rsiSeries = addPaneLine({ color: '#f97316', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true });
        rsiSeries.setData(series.points);
        [70, 30].forEach(function (lvl) {
          rsiSeries.createPriceLine({ price: lvl, color: 'rgba(148,163,184,0.4)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
        });
      } else if (kind === 'macd') {
        var histSeries = addPaneHist({ priceLineVisible: false, lastValueVisible: false });
        histSeries.setData(series.points.map(function (p) {
          return { time: p.time, value: p.histogram, color: (p.histogram >= 0 ? 'rgba(16,185,129,0.5)' : 'rgba(239,68,68,0.5)') };
        }));
        var macdSeries = addPaneLine({ color: '#38bdf8', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
        macdSeries.setData(series.points.map(function (p) { return { time: p.time, value: p.macd }; }));
        var sigSeries = addPaneLine({ color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
        sigSeries.setData(series.points.filter(function (p) { return p.signal != null; }).map(function (p) { return { time: p.time, value: p.signal }; }));
      } else if (kind === 'obv') {
        var obvSeries = addPaneLine({ color: '#a855f7', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true });
        obvSeries.setData(series.points);
      }
      paneChart.timeScale().fitContent();
      entry.charts[kind] = paneChart;

      // Sync the pane's visible range to the main chart (one-way: main drives
      // panes). Never touches the main chart's scale => no main-chart rescale.
      if (mainChart && mainChart.timeScale) {
        try {
          var applyRange = function (range) { if (range) { try { paneChart.timeScale().setVisibleLogicalRange(range); } catch (_) {} } };
          applyRange(mainChart.timeScale().getVisibleLogicalRange());
          mainChart.timeScale().subscribeVisibleLogicalRangeChange(applyRange);
        } catch (_) {}
      }
    });
    return entry;
  }

  function unmountPanes(chartId) {
    var entry = _panes[chartId];
    if (!entry) return;
    Object.keys(entry.charts).forEach(function (k) {
      try { entry.charts[k].remove(); } catch (_) {}
    });
    if (entry.wrapper && entry.wrapper.parentNode) entry.wrapper.parentNode.removeChild(entry.wrapper);
    delete _panes[chartId];
  }

  function getState(chartId) { return _state[chartId] || null; }
  function reset(chartId) { if (chartId) delete _state[chartId]; else _state = Object.create(null); }

  return {
    VERSION: VERSION,
    FAMILIES: FAMILIES,
    FAMILY_IDS: FAMILY_IDS,
    PRESET_FAMILIES: PRESET_FAMILIES,
    DEFAULT_MAX_OVERLAYS: DEFAULT_MAX_OVERLAYS,
    computeSourceHash: computeSourceHash,
    runDetectors: runDetectors,
    selectOverlays: selectOverlays,
    computeOverlays: computeOverlays,
    familiesForPreset: familiesForPreset,
    resolveActiveFamilies: resolveActiveFamilies,
    detectBarIntervalMs: detectBarIntervalMs,
    isEodSeries: isEodSeries,
    evaluateScalpingGuard: evaluateScalpingGuard,
    evaluateDayTradeSessionGuard: evaluateDayTradeSessionGuard,
    evaluateShortSwingGuard: evaluateShortSwingGuard,
    buildPaneSeries: buildPaneSeries,
    buildOverlaySvg: buildOverlaySvg,
    mountPanes: mountPanes,
    unmountPanes: unmountPanes,
    attach: attach,
    getState: getState,
    reset: reset
  };
});
