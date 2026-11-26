'use strict';

/**
 * public/chart-drawing-tools.js
 * ============================================================================
 * V7 (Kloter 4B) — Chart drawing tools + Trawangan UX patterns.
 *
 * The chart engine is TradingView **Lightweight Charts v5.3.0** (Apache-2.0,
 * self-hosted at public/vendor/lightweight-charts.standalone.production.js).
 * Selectively adapts UX patterns from trawangan (Apache-2.0):
 *   - chartPriceScaleInputGuard (`isOutsideDataArea`)
 *   - priceSnapService (`snapPriceToOhlcAndIdxTick`, strictly IDX/BEI tick-guarded)
 *   - gestureDrawingRecognizer (`recognizeGesture`, `isScribbleErase`)
 *
 * All pure geometry / snapping / serialisation helpers are exported for unit tests.
 * ============================================================================
 */

(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.AutoCuanChartDrawing = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var VERSION = 'v7-4b-1';
  var STORAGE_PREFIX = 'ac_drawings::';
  var SCHEMA_VERSION = 1;

  var DEFAULT_FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

  var TOOLS = ['trendline', 'hline', 'ray', 'box', 'fib', 'ruler', 'freehand', 'gesture'];

  /* ------------------------------------------------------------------------ */
  /* IDX BEI Tick Rounding & Trawangan-Adapted UX Helpers (Apache-2.0)        */
  /* ------------------------------------------------------------------------ */

  function idxTickSizeLocal(price) {
    var p = Number(price);
    if (!isFinite(p)) return 1;
    if (typeof globalThis !== 'undefined' && globalThis.AutoCuanTradePlan && typeof globalThis.AutoCuanTradePlan.idxTickSize === 'function') {
      return globalThis.AutoCuanTradePlan.idxTickSize(p) || 1;
    }
    if (p < 200) return 1;
    if (p < 500) return 2;
    if (p < 2000) return 5;
    if (p < 5000) return 10;
    return 25;
  }

  /**
   * Always snap drawing prices onto canonical IDX/BEI tick fractions
   * (<200: 1, 200-499: 2, 500-1999: 5, 2000-4999: 10, >=5000: 25) or 0.01 for indices.
   */
  function roundToIdxTick(price, isIndex) {
    var p = Number(price);
    if (!isFinite(p)) return p;
    if (isIndex) return Number(p.toFixed(2));
    if (typeof globalThis !== 'undefined' && globalThis.AutoCuanTradePlan && typeof globalThis.AutoCuanTradePlan.roundToIdxTick === 'function') {
      return globalThis.AutoCuanTradePlan.roundToIdxTick(p);
    }
    var t = idxTickSizeLocal(p);
    var rounded = Math.round(p / t) * t;
    for (var i = 0; i < 3; i++) {
      var nt = idxTickSizeLocal(rounded);
      if (Math.abs((rounded / nt) - Math.round(rounded / nt)) < 1e-9) break;
      rounded = Math.round(rounded / nt) * nt;
    }
    return Number(rounded.toFixed(6));
  }

  /** Guard right price-scale axis and sub-pane regions from hijacking drawings. */
  function isOutsideDataArea(x, y, bounds) {
    if (!bounds) return false;
    var w = Number(bounds.width) || 0;
    var h = Number(bounds.height) || 0;
    var rightAxisWidth = Number(bounds.rightAxisWidth) > 0 ? Number(bounds.rightAxisWidth) : 64;
    var pricePaneHeight = Number(bounds.pricePaneHeight) > 0 ? Number(bounds.pricePaneHeight) : h;
    if (x < 0 || y < 0) return true;
    if (w > 0 && x >= (w - rightAxisWidth)) return true;
    if (pricePaneHeight > 0 && y > pricePaneHeight) return true;
    return false;
  }

  /**
   * OHLC wick-priority magnet (15px default radius) + Shift inversion, strictly
   * enforcing IDX tick rounding so foreign/custom fractions are never produced.
   */
  function snapPriceToOhlcAndIdxTick(opts) {
    var o = opts || {};
    var rawPrice = Number(o.rawPrice);
    var isIndex = Boolean(o.isIndex);
    var fallback = roundToIdxTick(rawPrice, isIndex);
    var effectiveMagnet = o.shiftKey ? !o.magnetEnabled : Boolean(o.magnetEnabled);
    if (!effectiveMagnet || !o.candle || typeof o.toY !== 'function' || !isFinite(Number(o.pointerY))) {
      return { price: fallback, snappedTo: null, snapped: false, tickSize: isIndex ? 0.01 : idxTickSizeLocal(fallback) };
    }
    var radius = Number(o.radiusPx) > 0 ? Number(o.radiusPx) : 15;
    var ptrY = Number(o.pointerY);
    var candidates = [
      { key: 'high', price: Number(o.candle.high) },
      { key: 'low', price: Number(o.candle.low) },
      { key: 'open', price: Number(o.candle.open) },
      { key: 'close', price: Number(o.candle.close) }
    ];
    var best = null;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!isFinite(c.price) || c.price <= 0) continue;
      var cy = o.toY(c.price);
      if (!isFinite(cy)) continue;
      var dist = Math.abs(cy - ptrY);
      if (dist <= radius && (!best || dist < best.dist - 0.5)) {
        best = { key: c.key, price: c.price, dist: dist };
      }
    }
    if (best) {
      var snappedPrice = roundToIdxTick(best.price, isIndex);
      return { price: snappedPrice, snappedTo: best.key, snapped: true, tickSize: isIndex ? 0.01 : idxTickSizeLocal(snappedPrice) };
    }
    return { price: fallback, snappedTo: null, snapped: false, tickSize: isIndex ? 0.01 : idxTickSizeLocal(fallback) };
  }

  function simplifyRDP(points, epsilon) {
    var pts = Array.isArray(points) ? points : [];
    if (pts.length <= 2) return pts.slice();
    var eps = Number(epsilon) > 0 ? Number(epsilon) : 4;
    var first = pts[0], last = pts[pts.length - 1];
    var maxDist = 0, idx = 0;
    for (var i = 1; i < pts.length - 1; i++) {
      var d = distToSegment(pts[i].x, pts[i].y, first.x, first.y, last.x, last.y);
      if (d > maxDist) { maxDist = d; idx = i; }
    }
    if (maxDist > eps) {
      var left = simplifyRDP(pts.slice(0, idx + 1), eps);
      var right = simplifyRDP(pts.slice(idx), eps);
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }

  function isScribbleErase(points) {
    var pts = Array.isArray(points) ? points : [];
    if (pts.length < 8) return false;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var pathLen = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (i > 0) pathLen += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
    }
    var diag = Math.hypot(maxX - minX, maxY - minY);
    if (diag < 20) return false;
    var reversals = 0;
    var prevDx = 0, prevDy = 0;
    for (var j = 1; j < pts.length; j++) {
      var dx = pts[j].x - pts[j - 1].x;
      var dy = pts[j].y - pts[j - 1].y;
      if (Math.hypot(dx, dy) < 2) continue;
      if ((prevDx !== 0 && dx * prevDx < -1) || (prevDy !== 0 && dy * prevDy < -1)) reversals++;
      prevDx = dx;
      prevDy = dy;
    }
    return reversals >= 3 && (pathLen / diag) >= 2.6;
  }

  function recognizeGesture(points) {
    var pts = Array.isArray(points) ? points : [];
    if (pts.length < 2) return { kind: 'none' };
    if (isScribbleErase(pts)) return { kind: 'erase', points: pts };
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var pathLen = 0;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].x < minX) minX = pts[i].x;
      if (pts[i].x > maxX) maxX = pts[i].x;
      if (pts[i].y < minY) minY = pts[i].y;
      if (pts[i].y > maxY) maxY = pts[i].y;
      if (i > 0) pathLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    var first = pts[0], last = pts[pts.length - 1];
    var w = maxX - minX, h = maxY - minY;
    var diag = Math.hypot(w, h);
    var directDist = Math.hypot(last.x - first.x, last.y - first.y);
    var endGap = directDist;
    if (w >= 20 && h >= 16 && diag > 0 && endGap <= Math.max(28, diag * 0.35) && pts.length >= 4) {
      return { kind: 'box', start: { x: minX, y: minY }, end: { x: maxX, y: maxY } };
    }
    if (w >= 24 && Math.abs(last.y - first.y) <= Math.max(12, w * 0.14) && h <= Math.max(18, w * 0.18)) {
      var midY = (first.y + last.y) / 2;
      return { kind: 'hline', start: { x: first.x, y: midY }, end: { x: last.x, y: midY } };
    }
    if (directDist >= 24 && pathLen > 0 && (directDist / pathLen) >= 0.85) {
      return { kind: 'trendline', start: first, end: last };
    }
    return { kind: 'freehand', points: simplifyRDP(pts, 3) };
  }

  /* ------------------------------------------------------------------------ */
  /* Geometry — pure functions                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Trendline through two anchors in (logical, price) space.
   * Returns slope (price per logical bar) and intercept (price at logical 0).
   */
  function trendlineFromPoints(a, b) {
    if (!a || !b) return null;
    var dx = Number(b.logical) - Number(a.logical);
    var dy = Number(b.price) - Number(a.price);
    if (!isFinite(dx) || !isFinite(dy)) return null;
    if (dx === 0) {
      // Vertical line: slope is undefined; expose it explicitly rather than
      // returning Infinity and poisoning downstream math.
      return { vertical: true, slope: null, intercept: null, x: Number(a.logical) };
    }
    var slope = dy / dx;
    var intercept = Number(a.price) - slope * Number(a.logical);
    return { vertical: false, slope: slope, intercept: intercept };
  }

  /** Price on a trendline at a given logical index. */
  function trendlinePriceAt(line, logical) {
    if (!line) return null;
    if (line.vertical) return null;
    return line.intercept + line.slope * Number(logical);
  }

  /**
   * Fibonacci retracement levels between two anchors.
   * Level price = A.price + (B.price - A.price) * ratio.
   */
  function fibLevels(a, b, ratios) {
    if (!a || !b) return [];
    var list = Array.isArray(ratios) && ratios.length ? ratios : DEFAULT_FIB_RATIOS;
    var p0 = Number(a.price);
    var p1 = Number(b.price);
    if (!isFinite(p0) || !isFinite(p1)) return [];
    var span = p1 - p0;
    return list.map(function (ratio) {
      return {
        ratio: ratio,
        price: p0 + span * ratio,
        label: (ratio * 100).toFixed(1).replace(/\.0$/, '') + '%'
      };
    });
  }

  /**
   * Ruler / measure between two anchors.
   * Returns absolute price delta, percent change relative to the first anchor,
   * and the number of bars (logical distance).
   */
  function rulerMeasure(a, b) {
    if (!a || !b) return null;
    var p0 = Number(a.price);
    var p1 = Number(b.price);
    var l0 = Number(a.logical);
    var l1 = Number(b.logical);
    if (!isFinite(p0) || !isFinite(p1) || !isFinite(l0) || !isFinite(l1)) return null;
    var delta = p1 - p0;
    var percent = p0 === 0 ? null : (delta / p0) * 100;
    return {
      priceDelta: delta,
      percent: percent,
      bars: Math.round(l1 - l0),
      direction: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat')
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Projection + hit-testing                                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * Project a drawing's anchors to screen pixels.
   * `projector` = { toX(logical), toY(price) }.
   */
  function projectDrawing(drawing, projector) {
    if (!drawing || !projector) return null;
    var anchors = Array.isArray(drawing.anchors) ? drawing.anchors : [];
    var pts = anchors.map(function (an) {
      return { x: projector.toX(an.logical), y: projector.toY(an.price) };
    });
    return { type: drawing.type, id: drawing.id, points: pts, drawing: drawing };
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    var lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    var t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    var cx = x1 + t * dx;
    var cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  /**
   * Hit-test a projected drawing against a screen point.
   * `tolerance` is in pixels. Returns true when the point is within tolerance.
   */
  function hitTest(projected, point, tolerance) {
    if (!projected || !point) return false;
    var tol = Number(tolerance) > 0 ? Number(tolerance) : 6;
    var pts = projected.points || [];
    var type = projected.type;

    if (type === 'hline') {
      if (!pts.length) return false;
      return Math.abs(point.y - pts[0].y) <= tol;
    }

    if (type === 'fib') {
      if (pts.length < 2) return false;
      var levels = fibLevels(
        projected.drawing.anchors[0],
        projected.drawing.anchors[1],
        projected.drawing.ratios
      );
      var y0 = pts[0].y;
      var y1 = pts[1].y;
      for (var i = 0; i < levels.length; i++) {
        var ly = y0 + (y1 - y0) * levels[i].ratio;
        if (Math.abs(point.y - ly) <= tol) return true;
      }
      return false;
    }

    if (type === 'freehand') {
      for (var f = 1; f < pts.length; f++) {
        if (distToSegment(point.x, point.y, pts[f - 1].x, pts[f - 1].y, pts[f].x, pts[f].y) <= tol) return true;
      }
      return false;
    }

    if (type === 'box') {
      if (pts.length < 2) return false;
      var xMin = Math.min(pts[0].x, pts[1].x), xMax = Math.max(pts[0].x, pts[1].x);
      var yMin = Math.min(pts[0].y, pts[1].y), yMax = Math.max(pts[0].y, pts[1].y);
      var nearEdge =
        distToSegment(point.x, point.y, xMin, yMin, xMax, yMin) <= tol ||
        distToSegment(point.x, point.y, xMax, yMin, xMax, yMax) <= tol ||
        distToSegment(point.x, point.y, xMax, yMax, xMin, yMax) <= tol ||
        distToSegment(point.x, point.y, xMin, yMax, xMin, yMin) <= tol;
      var inside = point.x >= xMin && point.x <= xMax && point.y >= yMin && point.y <= yMax;
      return nearEdge || inside;
    }

    if (type === 'ray') {
      if (pts.length < 2) return false;
      var rdx = pts[1].x - pts[0].x, rdy = pts[1].y - pts[0].y;
      var rLenSq = rdx * rdx + rdy * rdy;
      if (rLenSq === 0) return Math.hypot(point.x - pts[0].x, point.y - pts[0].y) <= tol;
      var tRay = Math.max(0, ((point.x - pts[0].x) * rdx + (point.y - pts[0].y) * rdy) / rLenSq);
      return Math.hypot(point.x - (pts[0].x + tRay * rdx), point.y - (pts[0].y + tRay * rdy)) <= tol;
    }

    // trendline + ruler: distance to the segment between the two anchors.
    if (pts.length >= 2) {
      return distToSegment(point.x, point.y, pts[0].x, pts[0].y, pts[1].x, pts[1].y) <= tol;
    }
    return false;
  }

  /* ------------------------------------------------------------------------ */
  /* Label collision resolver (VIDEO-09)                                      */
  /* ------------------------------------------------------------------------ */

  /**
   * Push axis labels apart so they never overlap.
   *
   * Input: array of { y, text, ... } (y in pixels, ascending or not).
   * Output: a NEW array, sorted by y, where each label's `y` is nudged so that
   * consecutive labels are at least `minGap` pixels apart. `offset` records how
   * far the label was moved from its true position (so the caller can draw a
   * leader line back to the real level).
   */
  function resolveLabelCollisions(labels, minGap) {
    var gap = Number(minGap) > 0 ? Number(minGap) : 12;
    var list = (Array.isArray(labels) ? labels : [])
      .filter(function (l) { return l && isFinite(Number(l.y)); })
      .map(function (l) {
        return { y: Number(l.y), text: l.text, originalY: Number(l.y), offset: 0, meta: l };
      })
      .sort(function (a, b) { return a.y - b.y; });

    for (var i = 1; i < list.length; i++) {
      var minY = list[i - 1].y + gap;
      if (list[i].y < minY) {
        list[i].y = minY;
        list[i].offset = list[i].y - list[i].originalY;
      }
    }
    return list;
  }

  /* ------------------------------------------------------------------------ */
  /* Serialisation + per-(ticker,timeframe) store                             */
  /* ------------------------------------------------------------------------ */

  function storageKey(ticker, timeframe) {
    var t = String(ticker || '').toUpperCase().trim() || 'UNKNOWN';
    var tf = String(timeframe || '1D').toUpperCase().trim() || '1D';
    return STORAGE_PREFIX + t + '::' + tf;
  }

  function serialize(drawings, meta) {
    var m = meta || {};
    return JSON.stringify({
      schema: SCHEMA_VERSION,
      version: VERSION,
      ticker: String(m.ticker || '').toUpperCase(),
      timeframe: String(m.timeframe || '1D').toUpperCase(),
      drawings: Array.isArray(drawings) ? drawings : []
    });
  }

  function deserialize(raw) {
    if (raw === null || raw === undefined || raw === '') return { drawings: [], ticker: '', timeframe: '1D' };
    var obj;
    try {
      obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
      return { drawings: [], ticker: '', timeframe: '1D', corrupt: true };
    }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.drawings)) {
      return { drawings: [], ticker: '', timeframe: '1D', corrupt: true };
    }
    var drawings = obj.drawings.filter(function (d) {
      return d && typeof d === 'object' && TOOLS.indexOf(d.type) !== -1 && Array.isArray(d.anchors);
    });
    return {
      drawings: drawings,
      ticker: String(obj.ticker || '').toUpperCase(),
      timeframe: String(obj.timeframe || '1D').toUpperCase(),
      schema: obj.schema || null
    };
  }

  /**
   * A tiny storage-backed store. `storage` must implement getItem/setItem
   * (localStorage in the browser, a Map-backed shim in tests).
   */
  function createStore(storage) {
    var backing = storage || null;
    return {
      load: function (ticker, timeframe) {
        if (!backing) return [];
        var raw = null;
        try { raw = backing.getItem(storageKey(ticker, timeframe)); } catch (_) { raw = null; }
        return deserialize(raw).drawings;
      },
      save: function (ticker, timeframe, drawings) {
        if (!backing) return false;
        try {
          backing.setItem(storageKey(ticker, timeframe), serialize(drawings, { ticker: ticker, timeframe: timeframe }));
          return true;
        } catch (_) {
          return false;
        }
      },
      clear: function (ticker, timeframe) {
        if (!backing) return false;
        try { backing.removeItem(storageKey(ticker, timeframe)); return true; } catch (_) { return false; }
      },
      key: storageKey
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Drawing factory                                                          */
  /* ------------------------------------------------------------------------ */

  var _seq = 0;
  function newId() {
    _seq += 1;
    return 'd' + Date.now().toString(36) + '_' + _seq;
  }

  function createDrawing(type, anchors, extra) {
    if (TOOLS.indexOf(type) === -1) return null;
    var list = Array.isArray(anchors) ? anchors.slice() : [];
    var d = {
      id: newId(),
      type: type,
      anchors: list.map(function (a) { return { logical: Number(a.logical), price: Number(a.price) }; })
    };
    if (type === 'fib') d.ratios = (extra && extra.ratios) || DEFAULT_FIB_RATIOS.slice();
    if (extra && extra.color) d.color = extra.color;
    return d;
  }

  /* ------------------------------------------------------------------------ */
  /* DOM layer (browser only)                                                 */
  /* ------------------------------------------------------------------------ */

  function attach(chartId, options) {
    if (typeof document === 'undefined') return null;
    var opts = options || {};
    var id = String(chartId || 'mainChart');
    var container = document.getElementById(id + '_container');
    if (!container) return null;

    var store = createStore(opts.storage || (typeof localStorage !== 'undefined' ? localStorage : null));
    var state = {
      chartId: id,
      ticker: String(opts.ticker || '').toUpperCase(),
      timeframe: String(opts.timeframe || '1D').toUpperCase(),
      tool: null,
      magnetEnabled: true,
      drawings: [],
      selectedId: null,
      draft: null,
      draftPixels: [],
      snapBadge: null,
      dragging: null
    };
    state.drawings = store.load(state.ticker, state.timeframe);

    function getHostContainer() {
      var reg = (typeof window !== 'undefined' && window.__chartRegistry) ? window.__chartRegistry[id] : null;
      return (reg && reg.canvasHost) || document.getElementById(id + '_canvas_host') || container;
    }

    var drawHost = getHostContainer();
    container.style.position = 'relative';
    drawHost.style.position = 'relative';

    // --- overlay canvas -----------------------------------------------------
    var canvas = document.getElementById(id + '_draw_canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = id + '_draw_canvas';
      canvas.className = 'ac-draw-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText = 'position:absolute;inset:0;z-index:11;pointer-events:none;';
      drawHost.appendChild(canvas);
    } else if (canvas.parentNode !== drawHost) {
      drawHost.appendChild(canvas);
    }
    var ctx = canvas.getContext('2d');

    // --- toolbar (docked cleanly above canvas container so OHLCV legend never collides) ---
    var toolbar = document.getElementById(id + '_draw_toolbar');
    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.id = id + '_draw_toolbar';
      toolbar.className = 'ac-draw-toolbar';
      toolbar.setAttribute('role', 'toolbar');
      toolbar.setAttribute('aria-label', 'Alat gambar chart');
      toolbar.style.cssText = 'position:relative;z-index:13;display:flex;flex-wrap:wrap;align-items:center;gap:6px;width:100%;overflow-x:auto;overscroll-behavior-x:contain;' +
        'background:var(--ac-surface-raised, #F2F4EE);color:var(--ac-ink, #121714);border:1px solid var(--ac-line-hairline, rgba(22,30,24,0.12));border-radius:8px;padding:6px 10px;';
      if (container.parentNode) {
        container.parentNode.insertBefore(toolbar, container);
      } else {
        container.appendChild(toolbar);
      }
    }
    var TOOL_LABELS = {
      trendline: 'Garis Tren',
      hline: 'Garis Datar',
      ray: 'Sinar (Ray)',
      box: 'Kotak Zona',
      fib: 'Fibonacci',
      ruler: 'Penggaris',
      freehand: 'Gambar',
      gesture: 'Gesture Pintar'
    };
    function renderToolbar() {
      var html = '';
      TOOLS.forEach(function (t) {
        var on = state.tool === t ? ' aria-pressed="true"' : ' aria-pressed="false"';
        var cls = 'ac-draw-btn' + (state.tool === t ? ' on' : '');
        var pill = TOOL_LABELS[t] || t;
        html += '<button type="button" class="' + cls + '" data-tool="' + t + '"' + on +
          ' style="display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:4px 8px;border-radius:6px;line-height:1.2;white-space:nowrap;"' +
          ' aria-label="' + TOOL_LABELS[t] + '" title="' + TOOL_LABELS[t] + '">' + pill + '</button>';
      });
      var magPressed = state.magnetEnabled ? ' aria-pressed="true"' : ' aria-pressed="false"';
      var magCls = 'ac-draw-btn' + (state.magnetEnabled ? ' on' : '');
      html += '<button type="button" class="' + magCls + '" data-action="magnet"' + magPressed +
        ' style="display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:4px 8px;border-radius:6px;line-height:1.2;white-space:nowrap;"' +
        ' aria-label="Magnet OHLC BEI (tahan Shift untuk lepas)" title="Magnet OHLC 15px + Fraksi BEI (tahan Shift untuk bypass)">Magnet OHLC</button>';
      html += '<button type="button" class="ac-draw-btn" data-action="delete" style="display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:4px 8px;border-radius:6px;line-height:1.2;white-space:nowrap;" aria-label="Hapus gambar terpilih" title="Hapus (Delete)">Hapus</button>';
      html += '<button type="button" class="ac-draw-btn" data-action="clear" style="display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:4px 8px;border-radius:6px;line-height:1.2;white-space:nowrap;" aria-label="Hapus semua gambar" title="Hapus semua">Bersihkan</button>';
      toolbar.innerHTML = html;
    }
    renderToolbar();

    // --- coordinate helpers -------------------------------------------------
    function getChart() {
      var reg = (typeof window !== 'undefined' && window.__chartRegistry) ? window.__chartRegistry[id] : null;
      return reg || null;
    }
    function toX(logical) {
      var reg = getChart();
      if (!reg || !reg.mainChart) return NaN;
      try { return reg.mainChart.timeScale().logicalToCoordinate(logical); } catch (_) { return NaN; }
    }
    function toY(price) {
      var reg = getChart();
      if (!reg || !reg.candleSeries) return NaN;
      try { return reg.candleSeries.priceToCoordinate(price); } catch (_) { return NaN; }
    }
    function fromX(x) {
      var reg = getChart();
      if (!reg || !reg.mainChart) return NaN;
      try { return reg.mainChart.timeScale().coordinateToLogical(x); } catch (_) { return NaN; }
    }
    function fromY(y) {
      var reg = getChart();
      if (!reg || !reg.candleSeries) return NaN;
      try { return reg.candleSeries.coordinateToPrice(y); } catch (_) { return NaN; }
    }
    var projector = { toX: toX, toY: toY };

    // --- rendering (single rAF) --------------------------------------------
    var rafId = 0;
    function scheduleRender() {
      if (rafId) return;
      rafId = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame(function () { rafId = 0; render(); })
        : setTimeout(function () { rafId = 0; render(); }, 16);
    }

    function sizeCanvas() {
      var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      var host = getHostContainer();
      var w = host.clientWidth || container.clientWidth;
      var reg = getChart();
      var h = (reg && reg.pricePaneHeight) ? Math.min(host.clientHeight || reg.pricePaneHeight, reg.pricePaneHeight) : (host.clientHeight || container.clientHeight);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: w, h: h };
    }

    function drawOne(d, isSelected) {
      var proj = projectDrawing(d, projector);
      if (!proj || !proj.points.length) return;
      var pts = proj.points;
      ctx.save();
      ctx.lineWidth = isSelected ? 2.5 : 1.75;
      ctx.strokeStyle = isSelected ? '#d97706' : (d.color || '#0284c7');
      ctx.fillStyle = ctx.strokeStyle;

      if (d.type === 'hline') {
        ctx.beginPath();
        ctx.moveTo(0, pts[0].y);
        ctx.lineTo(canvas.clientWidth, pts[0].y);
        ctx.stroke();
        ctx.font = '11px ui-monospace, monospace';
        ctx.fillText('S/R ' + Number(d.anchors[0].price).toLocaleString('id-ID'), 6, pts[0].y - 4);
      } else if (d.type === 'ray') {
        if (pts.length >= 2) {
          var dxR = pts[1].x - pts[0].x, dyR = pts[1].y - pts[0].y;
          var lenR = Math.hypot(dxR, dyR);
          var endX = pts[1].x, endY = pts[1].y;
          if (lenR > 0.5) {
            var scaleR = Math.max(canvas.clientWidth, canvas.clientHeight, 1200) / lenR;
            endX = pts[0].x + dxR * scaleR;
            endY = pts[0].y + dyR * scaleR;
          }
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          ctx.lineTo(endX, endY);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(pts[0].x, pts[0].y, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (d.type === 'box') {
        if (pts.length >= 2) {
          var bx = Math.min(pts[0].x, pts[1].x);
          var by = Math.min(pts[0].y, pts[1].y);
          var bw = Math.abs(pts[1].x - pts[0].x);
          var bh = Math.abs(pts[1].y - pts[0].y);
          ctx.save();
          ctx.fillStyle = isSelected ? 'rgba(217,119,6,0.16)' : 'rgba(2,132,199,0.14)';
          ctx.fillRect(bx, by, bw, bh);
          ctx.restore();
          ctx.strokeRect(bx, by, bw, bh);
          ctx.font = '10px ui-monospace, monospace';
          var hiP = Math.max(d.anchors[0].price, d.anchors[1].price);
          var loP = Math.min(d.anchors[0].price, d.anchors[1].price);
          ctx.fillText('Zona ' + loP.toLocaleString('id-ID') + '\u2013' + hiP.toLocaleString('id-ID'), bx + 4, Math.max(12, by - 4));
        }
      } else if (d.type === 'fib') {
        var levels = fibLevels(d.anchors[0], d.anchors[1], d.ratios);
        var y0 = pts[0].y;
        var y1 = pts[1].y;
        var labels = [];
        levels.forEach(function (lv) {
          var ly = y0 + (y1 - y0) * lv.ratio;
          ctx.globalAlpha = 0.85;
          ctx.beginPath();
          ctx.moveTo(0, ly);
          ctx.lineTo(canvas.clientWidth, ly);
          ctx.stroke();
          labels.push({ y: ly, text: lv.label + ' ' + Number(lv.price).toLocaleString('id-ID') });
        });
        ctx.globalAlpha = 1;
        // VIDEO-09: stack labels so they never overlap on the axis.
        var resolved = resolveLabelCollisions(labels, 12);
        ctx.font = '10px ui-monospace, monospace';
        resolved.forEach(function (l) {
          ctx.fillText(l.text, 6, l.y - 2);
        });
      } else if (d.type === 'ruler') {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.stroke();
        var m = rulerMeasure(d.anchors[0], d.anchors[1]);
        if (m) {
          var txt = (m.priceDelta >= 0 ? '+' : '') + Number(m.priceDelta).toLocaleString('id-ID') +
            ' (' + (m.percent === null ? '\u2014' : (m.percent >= 0 ? '+' : '') + m.percent.toFixed(2) + '%') + ') \u00b7 ' +
            m.bars + ' bar';
          ctx.font = '11px ui-monospace, monospace';
          ctx.fillText(txt, Math.min(pts[0].x, pts[1].x) + 6, Math.min(pts[0].y, pts[1].y) - 6);
        }
      } else if (d.type === 'freehand' || d.type === 'gesture') {
        ctx.beginPath();
        pts.forEach(function (p, i) { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.stroke();
      } else {
        // trendline
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.stroke();
      }
      ctx.restore();
    }

    function render() {
      var dims = sizeCanvas();
      ctx.clearRect(0, 0, dims.w, dims.h);
      state.drawings.forEach(function (d) { drawOne(d, d.id === state.selectedId); });
      if (state.draft) drawOne(state.draft, true);
      if (state.snapBadge && state.snapBadge.snapped) {
        ctx.save();
        ctx.strokeStyle = '#f59e0b';
        ctx.fillStyle = 'rgba(245,158,11,0.92)';
        ctx.beginPath();
        ctx.arc(state.snapBadge.x, state.snapBadge.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '600 10px ui-monospace, monospace';
        ctx.fillText(state.snapBadge.label, Math.min(dims.w - 92, state.snapBadge.x + 8), Math.max(14, state.snapBadge.y - 8));
        ctx.restore();
      }
    }

    // --- pointer interaction ------------------------------------------------
    function localPoint(ev) {
      var r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }
    function isPointerGuarded(pt) {
      var reg = getChart();
      var host = getHostContainer();
      return isOutsideDataArea(pt.x, pt.y, {
        width: host.clientWidth || canvas.clientWidth,
        height: host.clientHeight || canvas.clientHeight,
        rightAxisWidth: 64,
        pricePaneHeight: (reg && reg.pricePaneHeight) || host.clientHeight || canvas.clientHeight
      });
    }
    function anchorAt(pt, shiftKey) {
      var rawL = fromX(pt.x);
      var rawP = fromY(pt.y);
      if (!isFinite(rawL) || !isFinite(rawP)) return { logical: rawL, price: rawP };
      var reg = getChart();
      var isIdx = /^(IHSG|\^JKSE|JKSE|JCI|COMPOSITE|LQ45|IDX30|IDX80|KOMPAS100)$/i.test(state.ticker);
      var candles = (reg && Array.isArray(reg.candles)) ? reg.candles : [];
      var barIdx = candles.length ? Math.max(0, Math.min(candles.length - 1, Math.round(rawL))) : -1;
      var candle = barIdx >= 0 ? candles[barIdx] : null;
      var snapped = snapPriceToOhlcAndIdxTick({
        rawPrice: rawP,
        pointerY: pt.y,
        candle: candle,
        toY: toY,
        magnetEnabled: state.magnetEnabled,
        shiftKey: Boolean(shiftKey),
        radiusPx: 15,
        isIndex: isIdx
      });
      state.snapBadge = snapped.snapped ? {
        snapped: true,
        x: pt.x,
        y: toY(snapped.price),
        label: snapped.snappedTo.toUpperCase() + ' ' + snapped.price.toLocaleString('id-ID')
      } : null;
      return { logical: rawL, price: snapped.price, snappedTo: snapped.snappedTo };
    }

    function onPointerDown(ev) {
      if (!state.tool) return;
      var pt = localPoint(ev);
      if (isPointerGuarded(pt)) return;
      var an = anchorAt(pt, ev.shiftKey);
      if (!isFinite(an.logical) || !isFinite(an.price)) return;
      ev.preventDefault();
      if (state.tool === 'hline') {
        var h = createDrawing('hline', [an]);
        state.drawings.push(h);
        state.selectedId = h.id;
        persist();
        scheduleRender();
        return;
      }
      if (state.tool === 'freehand' || state.tool === 'gesture') {
        state.draft = createDrawing(state.tool, [an]);
        state.draftPixels = [pt];
        state.dragging = 'draft';
        return;
      }
      state.draft = createDrawing(state.tool, [an, an]);
      state.draftPixels = [pt];
      state.dragging = 'draft';
    }

    function onPointerMove(ev) {
      if (!state.dragging) return;
      var pt = localPoint(ev);
      var an = anchorAt(pt, ev.shiftKey);
      if (!isFinite(an.logical) || !isFinite(an.price)) return;
      if (state.draft) {
        if (state.draft.type === 'freehand' || state.draft.type === 'gesture') {
          state.draft.anchors.push(an);
          state.draftPixels.push(pt);
        } else {
          state.draft.anchors[1] = an;
        }
        scheduleRender();
      }
    }

    function onPointerUp(ev) {
      if (!state.dragging) return;
      state.dragging = null;
      var pxTrail = state.draftPixels.slice();
      state.draftPixels = [];
      state.snapBadge = null;
      if (state.draft) {
        var d = state.draft;
        state.draft = null;
        if (d.type === 'gesture') {
          var recog = recognizeGesture(pxTrail);
          if (recog.kind === 'erase') {
            var remaining = [];
            var erased = 0;
            for (var ri = 0; ri < state.drawings.length; ri++) {
              var projE = projectDrawing(state.drawings[ri], projector);
              var hitE = pxTrail.some(function (p) { return hitTest(projE, p, 14); });
              if (hitE) erased++;
              else remaining.push(state.drawings[ri]);
            }
            if (erased > 0) {
              state.drawings = remaining;
              state.selectedId = null;
              persist();
            }
            scheduleRender();
            return;
          }
          if (recog.kind === 'hline') {
            d = createDrawing('hline', [anchorAt(recog.start, ev && ev.shiftKey)]);
          } else if (recog.kind === 'trendline') {
            d = createDrawing('trendline', [anchorAt(recog.start, ev && ev.shiftKey), anchorAt(recog.end, ev && ev.shiftKey)]);
          } else if (recog.kind === 'box') {
            d = createDrawing('box', [anchorAt(recog.start, ev && ev.shiftKey), anchorAt(recog.end, ev && ev.shiftKey)]);
          } else {
            d = createDrawing('freehand', d.anchors);
          }
        }
        var valid = d && ((d.type === 'freehand' || d.type === 'hline')
          ? d.anchors.length >= (d.type === 'hline' ? 1 : 2)
          : (d.anchors.length >= 2 && (d.anchors[0].logical !== d.anchors[1].logical || d.anchors[0].price !== d.anchors[1].price)));
        if (valid) {
          state.drawings.push(d);
          state.selectedId = d.id;
          persist();
        }
        scheduleRender();
      }
    }

    function onClick(ev) {
      if (state.tool) return; // in draw mode, clicks create drawings
      var pt = localPoint(ev);
      var hit = null;
      for (var i = state.drawings.length - 1; i >= 0; i--) {
        var proj = projectDrawing(state.drawings[i], projector);
        if (hitTest(proj, pt, 8)) { hit = state.drawings[i]; break; }
      }
      state.selectedId = hit ? hit.id : null;
      scheduleRender();
    }

    function onKeyDown(ev) {
      if (ev.key === 'Escape') {
        state.draft = null;
        state.dragging = null;
        state.tool = null;
        renderToolbar();
        updatePointerMode();
        scheduleRender();
      } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && state.selectedId) {
        state.drawings = state.drawings.filter(function (d) { return d.id !== state.selectedId; });
        state.selectedId = null;
        persist();
        scheduleRender();
      }
    }

    function updatePointerMode() {
      canvas.style.pointerEvents = state.tool ? 'auto' : 'none';
      canvas.style.cursor = state.tool ? 'crosshair' : 'default';
    }

    function persist() {
      store.save(state.ticker, state.timeframe, state.drawings);
    }

    toolbar.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!btn) return;
      var tool = btn.getAttribute('data-tool');
      var action = btn.getAttribute('data-action');
      if (tool) {
        state.tool = state.tool === tool ? null : tool;
        state.draft = null;
        renderToolbar();
        updatePointerMode();
        scheduleRender();
      } else if (action === 'magnet') {
        state.magnetEnabled = !state.magnetEnabled;
        renderToolbar();
      } else if (action === 'delete') {
        if (state.selectedId) {
          state.drawings = state.drawings.filter(function (d) { return d.id !== state.selectedId; });
          state.selectedId = null;
          persist();
          scheduleRender();
        }
      } else if (action === 'clear') {
        state.drawings = [];
        state.selectedId = null;
        persist();
        scheduleRender();
      }
    });

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);

    updatePointerMode();
    scheduleRender();

    var api = {
      version: VERSION,
      state: state,
      setTicker: function (ticker, timeframe) {
        state.ticker = String(ticker || '').toUpperCase();
        if (timeframe) state.timeframe = String(timeframe).toUpperCase();
        state.drawings = store.load(state.ticker, state.timeframe);
        state.selectedId = null;
        scheduleRender();
      },
      setTool: function (tool) {
        state.tool = TOOLS.indexOf(tool) !== -1 ? tool : null;
        renderToolbar();
        updatePointerMode();
      },
      getDrawings: function () { return state.drawings.slice(); },
      addDrawing: function (d) { state.drawings.push(d); persist(); scheduleRender(); },
      removeSelected: function () {
        if (!state.selectedId) return false;
        state.drawings = state.drawings.filter(function (d) { return d.id !== state.selectedId; });
        state.selectedId = null;
        persist();
        scheduleRender();
        return true;
      },
      clear: function () { state.drawings = []; state.selectedId = null; persist(); scheduleRender(); },
      render: scheduleRender,
      destroy: function () {
        document.removeEventListener('keydown', onKeyDown);
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerUp);
        canvas.removeEventListener('click', onClick);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        if (toolbar.parentNode) toolbar.parentNode.removeChild(toolbar);
      }
    };
    if (typeof window !== 'undefined') {
      window.__acDrawings = window.__acDrawings || {};
      window.__acDrawings[id] = api;
    }
    return api;
  }

  return {
    VERSION: VERSION,
    TOOLS: TOOLS,
    DEFAULT_FIB_RATIOS: DEFAULT_FIB_RATIOS,
    trendlineFromPoints: trendlineFromPoints,
    trendlinePriceAt: trendlinePriceAt,
    fibLevels: fibLevels,
    rulerMeasure: rulerMeasure,
    projectDrawing: projectDrawing,
    hitTest: hitTest,
    resolveLabelCollisions: resolveLabelCollisions,
    storageKey: storageKey,
    serialize: serialize,
    deserialize: deserialize,
    createStore: createStore,
    createDrawing: createDrawing,
    attach: attach,
    roundToIdxTick: roundToIdxTick,
    isOutsideDataArea: isOutsideDataArea,
    snapPriceToOhlcAndIdxTick: snapPriceToOhlcAndIdxTick,
    simplifyRDP: simplifyRDP,
    isScribbleErase: isScribbleErase,
    recognizeGesture: recognizeGesture
  };
});
