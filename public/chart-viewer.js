// Shared fullscreen chart viewer for Auto-Cuan.
//
// One overlay serves both the Chart page and Pattern, which is what makes the two
// feel like the same product rather than two separate widgets.
//
//   - Primary path re-drives the existing window.renderLightweightChart() into the
//     overlay with the 'fullscreen' variant. Pinch-zoom, drag-pan, crosshair, MA,
//     volume, RSI and Fibonacci all come from that function unchanged.
//   - Fallback path shows a high-resolution PNG in a pinch-zoom / pan surface, used
//     when the chart library is unavailable or no candles were supplied. Pattern
//     always passes its rendered PNG so there is something to fall back to.
//
// This file owns presentation only. It fetches nothing, and it never touches auth,
// access gates, navigation or any backend.
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.AutoCuanChartViewer = api;
    root.openChartViewer = function (config) { return api.open(root, config); };
    root.closeChartViewer = function () { return api.close(root); };
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VERSION = '20260802-chart-viewer-v1';
  var MIN_ZOOM = 1;
  var MAX_ZOOM = 6;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function clamp(value, min, max) {
    return value < min ? min : (value > max ? max : value);
  }

  // Pure: given a zoom factor and the overflow available at that zoom, clamp a pan
  // offset so the image can never be dragged off its own frame.
  function clampPan(offset, contentSize, frameSize, zoom) {
    var overflow = Math.max(0, (contentSize * zoom - frameSize) / 2);
    // `|| 0` also normalises the -0 that clamping to a zero overflow produces.
    return clamp(offset, -overflow, overflow) || 0;
  }

  // Pure: the next zoom level for a double-tap / double-click toggle.
  function toggleZoom(current) {
    return current > MIN_ZOOM + 0.01 ? MIN_ZOOM : 2.5;
  }

  // iOS ignores `overflow:hidden` on <body> once momentum scrolling has started, so a
  // real lock has to pin the body and restore the scroll position afterwards.
  function lockScroll(root) {
    var doc = root.document;
    var body = doc.body;
    if (body.hasAttribute('data-ac-scroll-locked')) return;
    var y = root.pageYOffset || doc.documentElement.scrollTop || 0;
    body.setAttribute('data-ac-scroll-locked', String(y));
    body.style.position = 'fixed';
    body.style.top = (-y) + 'px';
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
  }

  function unlockScroll(root) {
    var doc = root.document;
    var body = doc.body;
    if (!body.hasAttribute('data-ac-scroll-locked')) return;
    var y = Number(body.getAttribute('data-ac-scroll-locked')) || 0;
    body.removeAttribute('data-ac-scroll-locked');
    body.style.position = '';
    body.style.top = '';
    body.style.left = '';
    body.style.right = '';
    body.style.width = '';
    if (typeof root.scrollTo === 'function') root.scrollTo(0, y);
  }

  function focusableIn(node) {
    if (!node || typeof node.querySelectorAll !== 'function') return [];
    return Array.prototype.filter.call(
      node.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (el) { return !el.disabled && el.getAttribute('aria-hidden') !== 'true'; }
    );
  }

  function open(root, config) {
    if (!root || !root.document || !config) return null;
    var doc = root.document;
    close(root);

    var options = config || {};
    var state = {
      chartId: 'acviewer_' + Date.now(),
      zoom: MIN_ZOOM,
      panX: 0,
      panY: 0,
      lastFocus: doc.activeElement
    };

    var overlay = doc.createElement('div');
    overlay.id = 'acChartViewer';
    overlay.className = 'ac-viewer';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', String(options.title || 'Chart'));

    var head = doc.createElement('div');
    head.className = 'ac-viewer-head';
    var heading = doc.createElement('div');
    heading.className = 'ac-viewer-heading';
    var title = doc.createElement('h2');
    title.className = 'ac-viewer-title';
    title.textContent = String(options.title || 'Chart');
    heading.appendChild(title);
    if (options.subtitle) {
      var subtitle = doc.createElement('p');
      subtitle.className = 'ac-viewer-subtitle';
      subtitle.textContent = String(options.subtitle);
      heading.appendChild(subtitle);
    }
    var actions = doc.createElement('div');
    actions.className = 'ac-viewer-actions';
    head.appendChild(heading);
    head.appendChild(actions);

    var body = doc.createElement('div');
    body.className = 'ac-viewer-body';

    var closeButton = doc.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'ac-viewer-btn ac-viewer-close';
    closeButton.setAttribute('aria-label', 'Tutup tampilan layar penuh');
    closeButton.textContent = 'Tutup';

    overlay.appendChild(head);
    overlay.appendChild(body);
    doc.body.appendChild(overlay);
    lockScroll(root);

    var disposed = false;
    function dispose() {
      if (disposed) return;
      disposed = true;
      doc.removeEventListener('keydown', onKeydown, true);
      if (root.removeEventListener) root.removeEventListener('orientationchange', onViewportChange);
      if (typeof root.disposeChart === 'function') {
        try { root.disposeChart(state.chartId); } catch (_) {}
      }
      unlockScroll(root);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      root.__AUTOCUAN_CHART_VIEWER__ = null;
      if (state.lastFocus && typeof state.lastFocus.focus === 'function') {
        try { state.lastFocus.focus(); } catch (_) {}
      }
      if (typeof options.onClose === 'function') { try { options.onClose(); } catch (_) {} }
    }

    function onKeydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); dispose(); return; }
      if (event.key !== 'Tab') return;
      var items = focusableIn(overlay);
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    doc.addEventListener('keydown', onKeydown, true);

    var onViewportChange = function () {
      var entry = root.__chartRegistry && root.__chartRegistry[state.chartId];
      if (entry && entry.mainChart && entry.mainChart.timeScale) {
        try { entry.mainChart.timeScale().fitContent(); } catch (_) {}
      }
    };
    if (root.addEventListener) root.addEventListener('orientationchange', onViewportChange);

    closeButton.addEventListener('click', dispose);

    var candles = Array.isArray(options.candles) ? options.candles : [];
    var canRenderChart = candles.length >= 2 && typeof root.renderLightweightChart === 'function';

    if (options.download && options.download.href) {
      var save = doc.createElement('a');
      save.className = 'ac-viewer-btn';
      save.setAttribute('download', String(options.download.name || 'chart.png'));
      save.href = options.download.href;
      save.textContent = 'Simpan PNG';
      actions.appendChild(save);
    } else if (canRenderChart && typeof root.downloadChartPng === 'function') {
      var exportBtn = doc.createElement('button');
      exportBtn.type = 'button';
      exportBtn.className = 'ac-viewer-btn';
      exportBtn.textContent = 'Simpan PNG';
      exportBtn.addEventListener('click', function () {
        root.downloadChartPng(state.chartId, options.ticker || '', exportBtn);
      });
      actions.appendChild(exportBtn);
    }
    actions.appendChild(closeButton);

    if (canRenderChart) {
      renderInteractive(root, doc, body, state, options);
    } else {
      renderImage(root, doc, body, state, options);
    }

    var firstFocusable = focusableIn(overlay)[0];
    if (firstFocusable && typeof firstFocusable.focus === 'function') firstFocusable.focus();

    root.__AUTOCUAN_CHART_VIEWER__ = { version: VERSION, overlay: overlay, close: dispose, chartId: state.chartId };
    return root.__AUTOCUAN_CHART_VIEWER__;
  }

  // Interactive path — the exact renderer the Chart page uses.
  function renderInteractive(root, doc, body, state, options) {
    var wrap = doc.createElement('div');
    wrap.className = 'ac-viewer-chart';
    wrap.innerHTML =
      '<div id="' + esc(state.chartId) + '_container" class="ac-viewer-main"></div>' +
      '<div id="' + esc(state.chartId) + '_rsi" class="ac-viewer-rsi"></div>' +
      '<div id="' + esc(state.chartId) + '_metrics" class="ac-viewer-metrics"></div>' +
      '<p class="ac-viewer-hint">Cubit untuk zoom, geser untuk menggulir waktu.</p>';
    body.appendChild(wrap);

    Promise.resolve()
      .then(function () {
        if (typeof root.loadLightweightCharts === 'function') return root.loadLightweightCharts();
        return null;
      })
      .then(function () {
        return root.renderLightweightChart(
          state.chartId,
          options.candles,
          options.metrics || null,
          options.ticker || '',
          { variant: 'fullscreen', priceLines: options.priceLines || [], markers: options.markers || [] }
        );
      })
      .catch(function () {
        // The chart engine failed: fall back to the still-usable image path.
        body.innerHTML = '';
        renderImage(root, doc, body, state, options);
      });
  }

  // Fallback path — pinch-zoom / pan over the rendered PNG. Pointer Events cover
  // touch, pen and mouse with one code path.
  function renderImage(root, doc, body, state, options) {
    var image = options.image || {};
    var frame = doc.createElement('div');
    frame.className = 'ac-viewer-imageframe';

    if (!image.src) {
      var empty = doc.createElement('p');
      empty.className = 'ac-viewer-empty';
      empty.textContent = 'Visual chart belum tersedia untuk ditampilkan.';
      frame.appendChild(empty);
      body.appendChild(frame);
      return;
    }

    var img = doc.createElement('img');
    img.className = 'ac-viewer-image';
    img.src = image.src;
    img.alt = String(image.alt || options.title || 'Chart');
    if (image.width) img.setAttribute('width', String(image.width));
    if (image.height) img.setAttribute('height', String(image.height));
    frame.appendChild(img);

    var hint = doc.createElement('p');
    hint.className = 'ac-viewer-hint';
    hint.textContent = 'Cubit atau ketuk dua kali untuk zoom, geser untuk menggeser.';
    body.appendChild(frame);
    body.appendChild(hint);

    function apply() {
      var rect = frame.getBoundingClientRect ? frame.getBoundingClientRect() : { width: 0, height: 0 };
      state.panX = clampPan(state.panX, rect.width, rect.width, state.zoom);
      state.panY = clampPan(state.panY, rect.height, rect.height, state.zoom);
      img.style.transform = 'translate(' + state.panX + 'px,' + state.panY + 'px) scale(' + state.zoom + ')';
      frame.setAttribute('data-zoomed', state.zoom > MIN_ZOOM + 0.01 ? '1' : '0');
    }

    var pointers = Object.create(null);
    var pinchStart = null;
    var dragStart = null;

    frame.addEventListener('pointerdown', function (event) {
      pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
      if (frame.setPointerCapture) { try { frame.setPointerCapture(event.pointerId); } catch (_) {} }
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        var a = pointers[ids[0]];
        var b = pointers[ids[1]];
        pinchStart = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: state.zoom };
        dragStart = null;
      } else if (ids.length === 1 && state.zoom > MIN_ZOOM + 0.01) {
        dragStart = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
      }
    });

    frame.addEventListener('pointermove', function (event) {
      if (!pointers[event.pointerId]) return;
      pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
      var ids = Object.keys(pointers);
      if (pinchStart && ids.length === 2) {
        var a = pointers[ids[0]];
        var b = pointers[ids[1]];
        var distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        state.zoom = clamp(pinchStart.zoom * (distance / pinchStart.distance), MIN_ZOOM, MAX_ZOOM);
        apply();
        event.preventDefault();
      } else if (dragStart && ids.length === 1) {
        state.panX = dragStart.panX + (event.clientX - dragStart.x);
        state.panY = dragStart.panY + (event.clientY - dragStart.y);
        apply();
        event.preventDefault();
      }
    });

    function endPointer(event) {
      delete pointers[event.pointerId];
      if (Object.keys(pointers).length < 2) pinchStart = null;
      if (!Object.keys(pointers).length) dragStart = null;
    }
    frame.addEventListener('pointerup', endPointer);
    frame.addEventListener('pointercancel', endPointer);

    frame.addEventListener('dblclick', function (event) {
      state.zoom = toggleZoom(state.zoom);
      if (state.zoom === MIN_ZOOM) { state.panX = 0; state.panY = 0; }
      apply();
      event.preventDefault();
    });

    frame.addEventListener('wheel', function (event) {
      if (!event.ctrlKey && Math.abs(event.deltaY) < 2) return;
      state.zoom = clamp(state.zoom * (event.deltaY > 0 ? 0.9 : 1.1), MIN_ZOOM, MAX_ZOOM);
      if (state.zoom === MIN_ZOOM) { state.panX = 0; state.panY = 0; }
      apply();
      event.preventDefault();
    }, { passive: false });

    apply();
  }

  function close(root) {
    var active = root && root.__AUTOCUAN_CHART_VIEWER__;
    if (active && typeof active.close === 'function') active.close();
    return null;
  }

  return {
    version: VERSION,
    MIN_ZOOM: MIN_ZOOM,
    MAX_ZOOM: MAX_ZOOM,
    clamp: clamp,
    clampPan: clampPan,
    toggleZoom: toggleZoom,
    lockScroll: lockScroll,
    unlockScroll: unlockScroll,
    open: open,
    close: close
  };
});
