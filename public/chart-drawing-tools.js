'use strict';

/**
 * public/chart-drawing-tools.js
 * ============================================================================
 * V6 (W2b / Feature 13B) — Chart drawing tools.
 *
 * The chart engine is TradingView **Lightweight Charts v4.1.1** (Apache-2.0,
 * self-hosted at public/vendor/lightweight-charts.standalone.production.js).
 * It is NOT the proprietary "Advanced Charts" product, so an annotation layer
 * is legitimate to build on top of it.
 *
 * Architecture
 * ------------
 *   - The chart itself is created in public/market-feature-runtime.js
 *     `renderLightweightChart()` (line ~513) and registered in
 *     `window.__chartRegistry[chartId]` (line ~1442) with `mainChart` and
 *     `candleSeries`.
 *   - This module adds a *separate* transparent <canvas> overlay on top of the
 *     chart container. It never re-renders the chart; pointer moves are batched
 *     into a single requestAnimationFrame (project performance rule).
 *   - Drawings are stored in DATA space (logical index + price), so they stay
 *     anchored across zoom/pan and timeframe switches.
 *
 * Persistence
 * -----------
 *   localStorage, keyed per (ticker, timeframe):
 *       ac_drawings::<TICKER>::<TF>
 *   There is no dedicated authenticated server endpoint for user chart
 *   annotations in this codebase (the Vercel function budget is capped at 13
 *   and no drawings store exists), so persistence is client-side only. This
 *   limitation is stated honestly in docs/v6/V6_W2B_CHART_SCREENER_UX.md.
 *
 * The pure geometry / serialisation logic is exported for unit tests and is
 * free of any DOM dependency.
 * ============================================================================
 */

(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.AutoCuanChartDrawing = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var VERSION = 'v6-w2b-13b-1';
  var STORAGE_PREFIX = 'ac_drawings::';
  var SCHEMA_VERSION = 1;

  var DEFAULT_FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

  var TOOLS = ['trendline', 'hline', 'fib', 'ruler', 'freehand'];

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
      drawings: [],
      selectedId: null,
      draft: null,
      dragging: null
    };
    state.drawings = store.load(state.ticker, state.timeframe);

    container.style.position = 'relative';

    // --- overlay canvas -----------------------------------------------------
    var canvas = document.getElementById(id + '_draw_canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = id + '_draw_canvas';
      canvas.className = 'ac-draw-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText = 'position:absolute;inset:0;z-index:11;pointer-events:none;';
      container.appendChild(canvas);
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
        'background:var(--ac-raised, rgba(15,20,28,0.92));color:var(--ac-ink, #e2e8f0);border:1px solid var(--ac-hair, rgba(255,255,255,0.12));border-radius:8px;padding:6px 10px;';
      if (container.parentNode) {
        container.parentNode.insertBefore(toolbar, container);
      } else {
        container.appendChild(toolbar);
      }
    }
    var TOOL_LABELS = {
      trendline: 'Garis Tren',
      hline: 'Garis Datar',
      fib: 'Fibonacci',
      ruler: 'Penggaris',
      freehand: 'Gambar'
    };
    function renderToolbar() {
      var html = '';
      TOOLS.forEach(function (t) {
        var on = state.tool === t ? ' aria-pressed="true"' : ' aria-pressed="false"';
        var cls = 'ac-draw-btn' + (state.tool === t ? ' on' : '');
        var pill = TOOL_LABELS[t] || t;
        html += '<button type="button" class="' + cls + '" data-tool="' + t + '"' + on +
          ' style="display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:4px 8px;background:var(--ac-surface, rgba(255,255,255,0.06));color:var(--ac-ink, #e2e8f0);border:1px solid var(--ac-hair, rgba(255,255,255,.14));border-radius:6px;line-height:1.2;white-space:nowrap;"' +
          ' aria-label="' + TOOL_LABELS[t] + '" title="' + TOOL_LABELS[t] + '">' + pill + '</button>';
      });
      html += '<button type="button" class="ac-draw-btn" data-action="delete" style="display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:4px 8px;background:var(--ac-surface, rgba(255,255,255,0.06));color:var(--ac-ink, #e2e8f0);border:1px solid var(--ac-hair, rgba(255,255,255,.14));border-radius:6px;line-height:1.2;white-space:nowrap;" aria-label="Hapus gambar terpilih" title="Hapus (Delete)">Hapus</button>';
      html += '<button type="button" class="ac-draw-btn" data-action="clear" style="display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:4px 8px;background:var(--ac-surface, rgba(255,255,255,0.06));color:var(--ac-ink, #e2e8f0);border:1px solid var(--ac-hair, rgba(255,255,255,.14));border-radius:6px;line-height:1.2;white-space:nowrap;" aria-label="Hapus semua gambar" title="Hapus semua">Bersihkan</button>';
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
      var w = container.clientWidth;
      var h = container.clientHeight;
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
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.strokeStyle = isSelected ? '#f59e0b' : (d.color || '#38bdf8');
      ctx.fillStyle = ctx.strokeStyle;

      if (d.type === 'hline') {
        ctx.beginPath();
        ctx.moveTo(0, pts[0].y);
        ctx.lineTo(canvas.clientWidth, pts[0].y);
        ctx.stroke();
        ctx.font = '11px ui-monospace, monospace';
        ctx.fillText('S/R ' + Number(d.anchors[0].price).toLocaleString('id-ID'), 6, pts[0].y - 4);
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
            ' (' + (m.percent === null ? '—' : (m.percent >= 0 ? '+' : '') + m.percent.toFixed(2) + '%') + ') · ' +
            m.bars + ' bar';
          ctx.font = '11px ui-monospace, monospace';
          ctx.fillText(txt, Math.min(pts[0].x, pts[1].x) + 6, Math.min(pts[0].y, pts[1].y) - 6);
        }
      } else if (d.type === 'freehand') {
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
    }

    // --- pointer interaction ------------------------------------------------
    var pending = null;
    function localPoint(ev) {
      var r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }
    function anchorAt(pt) {
      return { logical: fromX(pt.x), price: fromY(pt.y) };
    }

    function onPointerDown(ev) {
      if (!state.tool) return;
      var pt = localPoint(ev);
      var an = anchorAt(pt);
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
      if (state.tool === 'freehand') {
        state.draft = createDrawing('freehand', [an]);
        state.dragging = 'draft';
        return;
      }
      state.draft = createDrawing(state.tool, [an, an]);
      state.dragging = 'draft';
    }

    function onPointerMove(ev) {
      if (!state.dragging) return;
      var pt = localPoint(ev);
      var an = anchorAt(pt);
      if (!isFinite(an.logical) || !isFinite(an.price)) return;
      if (state.draft) {
        if (state.draft.type === 'freehand') state.draft.anchors.push(an);
        else state.draft.anchors[1] = an;
        scheduleRender();
      }
    }

    function onPointerUp() {
      if (!state.dragging) return;
      state.dragging = null;
      if (state.draft) {
        var d = state.draft;
        state.draft = null;
        var valid = d.type === 'freehand'
          ? d.anchors.length >= 2
          : (d.anchors.length >= 2 && (d.anchors[0].logical !== d.anchors[1].logical || d.anchors[0].price !== d.anchors[1].price));
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
    attach: attach
  };
});
