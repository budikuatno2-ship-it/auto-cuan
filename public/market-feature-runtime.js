// ===== LIGHTWEIGHT CHARTS LOADER (lazy — loaded on first chart request) =====
var _lwcLoaded = false;
var _lwcLoadPromise = null;
function loadLightweightCharts() {
    if (_lwcLoaded && window.LightweightCharts) return Promise.resolve();
    if (_lwcLoadPromise) return _lwcLoadPromise;
    _lwcLoadPromise = new Promise(function(resolve, reject) {
        if (window.LightweightCharts) { _lwcLoaded = true; resolve(); return; }
        var s = document.createElement('script');
        s.src = 'https://unpkg.com/lightweight-charts@4.1.1/dist/lightweight-charts.standalone.production.js';
        s.async = true;
        s.onload = function() { _lwcLoaded = true; resolve(); };
        s.onerror = reject;
        document.head.appendChild(s);
    });
    return _lwcLoadPromise;
}
// ===== YAHOO OHLCV CHART (lazy-loaded, click-to-show) =====
// ===== NEWS PANEL TOGGLE =====
function toggleNewsPanel(ticker, panelId, btn) {
    var panel = document.getElementById(panelId);
    if (!panel) return;
    if (panel.classList.contains('hidden')) {
        // Build news content from per-ticker store
        var items = (window._stockNewsByTicker && window._stockNewsByTicker[ticker]) || [];
        if (items.length === 0) return;
        var html = '<div class="bg-dark-800/60 border border-yellow-500/20 rounded-xl p-3 space-y-2">';
        html += '<div class="flex items-center gap-2 mb-1"><span class="w-2 h-2 rounded-full bg-yellow-500"></span><span class="text-xs font-semibold text-yellow-400">News / Katalis ' + escapeHtml(ticker) + '</span></div>';
        for (var i = 0; i < items.length; i++) {
            var n = items[i];
            html += '<div class="bg-dark-700/50 rounded-lg p-2.5">';
            html += '<p class="text-xs text-gray-300 font-medium">' + escapeHtml(n.title || '') + '</p>';
            if (n.date) html += '<p class="text-[10px] text-gray-500 mt-0.5">' + escapeHtml(n.date) + '</p>';
            if (n.summary) html += '<p class="text-xs text-gray-400 mt-1">' + escapeHtml(n.summary) + '</p>';
            var badges = '';
            if (n.possibleImpact) { var ic = n.possibleImpact === 'positive' ? 'text-emerald-400 bg-emerald-500/10' : n.possibleImpact === 'negative' ? 'text-red-400 bg-red-500/10' : 'text-gray-400 bg-gray-500/10'; badges += '<span class="px-1.5 py-0.5 rounded text-[10px] ' + ic + '">' + n.possibleImpact + '</span>'; }
            if (n.source) badges += '<span class="text-[10px] text-gray-500">' + escapeHtml(n.source) + '</span>';
            if (badges) html += '<div class="flex items-center gap-2 mt-1.5">' + badges + '</div>';
            if (n.url) html += '<a href="' + escapeHtml(n.url) + '" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-[10px] text-blue-400 hover:underline mt-1"><svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>Buka Sumber</a>';
            html += '</div>';
        }
        html += '</div>';
        panel.innerHTML = html;
        panel.classList.remove('hidden');
        btn.innerHTML = btn.innerHTML.replace('Lihat News', 'Tutup News');
    } else {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        btn.innerHTML = btn.innerHTML.replace('Tutup News', 'Lihat News');
    }
}

var _activeChartPanel = null;
var _candleCache = {};
var _candleCacheTTL = 5 * 60 * 1000; // 5 min frontend candle cache

async function toggleYahooChart(ticker, chartId, btn) {
    try {
    var existing = document.getElementById(chartId);
    if (existing) {
        if (typeof disposeChart === 'function') disposeChart(chartId);
        existing.remove();
        _activeChartPanel = null;
        btn.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"/></svg>Lihat Chart ' + ticker;
        return;
    }
    if (_activeChartPanel) { _activeChartPanel.remove(); _activeChartPanel = null; }
    var _id = (typeof chartDims === 'function') ? chartDims('inline') : { main: 280, rsi: 60 };

    // Loading state
    btn.innerHTML = '<span class="spinner-sm"></span>Memuat Chart...';

    var bubble = btn.closest('.flex.gap-3');
    var panel = document.createElement('div');
    panel.id = chartId;
    panel.className = 'mt-3 rounded-xl border border-dark-600/30 bg-dark-800/60 overflow-hidden fade-in-up';
    panel.innerHTML = '<div class="px-3 py-2 border-b border-dark-600/20 flex flex-wrap items-center justify-between gap-2"><div class="flex items-center gap-2 min-w-0"><span class="text-xs font-semibold text-gray-300 truncate">Chart ' + ticker + '</span><span class="text-[10px] text-gray-600 shrink-0">Data Historis T-1</span></div><div class="flex items-center gap-2 shrink-0"><button onclick="downloadChartPng(\'' + chartId + '\',\'' + ticker + '\',this)" class="text-[10px] text-blue-400 hover:text-blue-300 transition">Download PNG</button><button onclick="closeYahooChart(\'' + chartId + '\',this)" class="text-[10px] text-gray-500 hover:text-red-400 transition">Tutup</button></div></div>' +
        '<div id="' + chartId + '_container" style="height:' + _id.main + 'px;width:100%"><div class="flex items-center justify-center h-full text-gray-600 text-xs">Memuat chart...</div></div>' +
        '<div id="' + chartId + '_rsi" class="border-t border-dark-600/20" style="height:' + _id.rsi + 'px;width:100%"></div>' +
        '<div id="' + chartId + '_metrics" class="px-3 py-2 border-t border-dark-600/20 grid grid-cols-4 sm:grid-cols-8 gap-1 text-[10px]"></div>' +
        '<div class="px-3 py-1.5 border-t border-dark-600/20 flex items-center gap-3 text-[10px]"><span class="text-emerald-400">MA20</span><span class="text-yellow-400">MA50</span><span class="text-blue-400">MA100</span><span class="text-purple-400">MA200</span><span class="text-orange-400">RSI14</span><span class="text-amber-400/80">Fib</span></div>';
    bubble.after(panel);
    _activeChartPanel = panel;

    try {
        var cachedCandles = _candleCache[ticker];
        var data;
        if (cachedCandles && (Date.now() - cachedCandles.ts < _candleCacheTTL)) {
            data = cachedCandles.data;
        } else {
            var resp = await fetch('/api/candles?ticker=' + encodeURIComponent(ticker));
            data = await resp.json();
            if (data.success && data.candles && data.candles.length > 0) {
                _candleCache[ticker] = { data: data, ts: Date.now() };
            }
        }
        if (!data.success || !data.candles || data.candles.length === 0) {
            document.getElementById(chartId + '_container').innerHTML = '<div class="flex items-center justify-center h-full text-gray-500 text-xs p-4 text-center">Chart belum berhasil dimuat. Coba lagi nanti atau buka TradingView.</div>';
            btn.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"/></svg>Lihat Chart ' + ticker;
            return;
        }
        await loadLightweightCharts();
        await renderLightweightChart(chartId, data.candles, data.metrics || null, ticker, { variant: 'inline' });
        btn.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>Tutup Chart';
    } catch (e) {
        document.getElementById(chartId + '_container').innerHTML = '<div class="flex items-center justify-center h-full text-gray-500 text-xs p-4 text-center">Chart belum berhasil dimuat. Coba lagi nanti atau buka TradingView.</div>';
        btn.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"/></svg>Lihat Chart ' + ticker;
    }
    } catch (outerErr) {
        if (typeof showToast === 'function') showToast('Chart gagal dimuat.', 'warning');
    }
}

function closeYahooChart(chartId) {
    if (typeof disposeChart === 'function') disposeChart(chartId);
    var el = document.getElementById(chartId);
    if (el) { el.remove(); _activeChartPanel = null; }
}

// ===== CHART REGISTRY + EXPORT HELPERS (presentation-only) =====
// Scoped registry keyed by chartId. Avoids global loose vars and stale/duplicate
// chart instances or ResizeObservers when a chart is re-rendered.
var _chartRegistry = (typeof window !== 'undefined' && window.__chartRegistry) ? window.__chartRegistry : {};
if (typeof window !== 'undefined') window.__chartRegistry = _chartRegistry;

// Single source of truth for chart heights (CSS px). Responsive by viewport width.
// viewportHeight is only consulted by the 'fullscreen' variant; existing two-argument
// callers are unaffected.
function chartDims(variant, viewportWidth, viewportHeight) {
    var w = (typeof viewportWidth === 'number' && viewportWidth > 0) ? viewportWidth
          : (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1024;
    var mobile = w < 640;
    if (variant === 'inline') return { main: mobile ? 240 : 280, rsi: 60 };
    if (variant === 'fullscreen') {
        // Fill the overlay: viewport minus its chrome (header ~58, metrics/legend ~86,
        // safe-area allowance ~24), with the RSI strip taking a fixed slice.
        var h = (typeof viewportHeight === 'number' && viewportHeight > 0) ? viewportHeight
              : (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 768;
        var rsi = mobile ? 72 : 90;
        var main = Math.max(220, Math.round(h - 168 - rsi));
        return { main: main, rsi: rsi };
    }
    // Chart page (default): taller on desktop, roomier on mobile than the old
    // 270px panel — but never taller than the container is wide, so it cannot
    // swallow a small phone screen. Fullscreen covers serious inspection.
    return { main: mobile ? Math.min(320, Math.round(w * 0.92)) : 420, rsi: mobile ? 60 : 64 };
}

// Dispose a chart + its observers and drop it from the registry.
function disposeChart(chartId) {
    var e = _chartRegistry[chartId];
    if (!e) return;
    try { if (e.observers) e.observers.forEach(function(o) { if (o && o.disconnect) o.disconnect(); }); } catch (x) {}
    try { if (e.mainChart && e.mainChart.remove) e.mainChart.remove(); } catch (x) {}
    try { if (e.rsiChart && e.rsiChart.remove) e.rsiChart.remove(); } catch (x) {}
    delete _chartRegistry[chartId];
}

// Dispose registry entries whose DOM container has been removed (orphans from re-render).
function disposeStaleCharts() {
    Object.keys(_chartRegistry).forEach(function(id) {
        var el = (typeof document !== 'undefined') ? document.getElementById(id + '_container') : null;
        if (!el || (document.body && !document.body.contains(el))) disposeChart(id);
    });
}

// rAF-batched ResizeObserver that only fires the callback when width actually changes
// (prevents resize loops when we also adjust height inside the callback).
function observeChartResize(el, cb) {
    if (typeof ResizeObserver === 'undefined' || !el) return null;
    var raf = 0, lastW = el.clientWidth || 0;
    var schedule = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame : function(f) { return setTimeout(f, 16); };
    var ro = new ResizeObserver(function() {
        if (raf) return;
        raf = schedule(function() {
            raf = 0;
            var w = el.clientWidth;
            if (w && w !== lastW) { lastW = w; try { cb(w); } catch (x) {} }
        });
    });
    ro.observe(el);
    return ro;
}

// WIB (UTC+7) display stamp: "YYYY-MM-DD HH:MM WIB". Deterministic regardless of runner TZ.
function formatWibStamp(d) {
    d = d || new Date();
    var utcMs = d.getTime() + (d.getTimezoneOffset() * 60000);
    var wib = new Date(utcMs + 7 * 3600000);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return wib.getFullYear() + '-' + p(wib.getMonth() + 1) + '-' + p(wib.getDate()) + ' ' + p(wib.getHours()) + ':' + p(wib.getMinutes()) + ' WIB';
}

// Deterministic, filesystem-safe export filename in WIB: auto-cuan-TICKER-chart-YYYY-MM-DD-HHMM-WIB.png
function buildChartExportFilename(ticker, d) {
    d = d || new Date();
    var t = String(ticker || 'CHART').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'CHART';
    var utcMs = d.getTime() + (d.getTimezoneOffset() * 60000);
    var wib = new Date(utcMs + 7 * 3600000);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    var stamp = wib.getFullYear() + '-' + p(wib.getMonth() + 1) + '-' + p(wib.getDate()) + '-' + p(wib.getHours()) + p(wib.getMinutes());
    return 'auto-cuan-' + t + '-chart-' + stamp + '-WIB.png';
}

// Pure: compute backing bitmap size from CSS size and device pixel ratio.
function computeExportBitmapSize(cssWidth, cssHeight, dpr) {
    var r = (typeof dpr === 'number' && dpr > 0) ? dpr : 1;
    return { width: Math.max(1, Math.round(cssWidth * r)), height: Math.max(1, Math.round(cssHeight * r)) };
}

async function renderLightweightChart(chartId, candles, metrics, ticker, options) {
    var containerId = chartId + '_container';
    var container = document.getElementById(containerId);
    if (!container || !window.LightweightCharts) {
        if (container) container.innerHTML = '<div class="flex items-center justify-center h-full text-gray-500 text-xs">Library chart belum dimuat.</div>';
        return;
    }
    try {
    var variant = (options && options.variant) || 'inline';
    var dims = chartDims(variant, (typeof window !== 'undefined' ? window.innerWidth : 0), (typeof window !== 'undefined' ? window.innerHeight : 0));
    var _observers = [];
    // Clean up any prior chart bound to this id + orphaned charts (prevents duplicate
    // observers, stale references, and exporting an older hidden chart).
    disposeChart(chartId);
    disposeStaleCharts();
    container.innerHTML = '';
    container.style.height = dims.main + 'px';

    // Main chart: candlestick + MA
    var chart = LightweightCharts.createChart(container, {
        width: container.clientWidth, height: dims.main,
        layout: { background: { color: '#0f1319' }, textColor: '#9ca3af' },
        grid: { vertLines: { color: '#1c233320' }, horzLines: { color: '#1c233320' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#1c2333' },
        timeScale: { borderColor: '#1c2333', timeVisible: false },
        // Touch behavior: horizontal drag pans the chart, vertical finger movement is
        // left to the page so mobile page scrolling is never trapped. Pinch zoom kept.
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
    });

    var candleSeries = chart.addCandlestickSeries({
        upColor: '#10b981', downColor: '#ef4444',
        borderUpColor: '#10b981', borderDownColor: '#ef4444',
        wickUpColor: '#10b981', wickDownColor: '#ef4444'
    });
    candleSeries.setData(candles);

    // Volume
    var volumeSeries = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', color: '#242d3d' });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    var volData = candles.map(function(c) { return { time: c.time, value: c.volume, color: c.close >= c.open ? '#10b98130' : '#ef444430' }; });
    volumeSeries.setData(volData);

    // Volume Avg 20 line
    var closes = candles.map(function(c) { return c.close; });
    var vols = candles.map(function(c) { return c.volume; });

    function buildMALine(arr, period, color) {
        var data = [];
        for (var i = period - 1; i < arr.length; i++) {
            var sum = 0;
            for (var j = i - period + 1; j <= i; j++) sum += arr[j];
            data.push({ time: candles[i].time, value: Math.round((sum / period) * 100) / 100 });
        }
        var s = chart.addLineSeries({ color: color, lineWidth: 1, crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false });
        s.setData(data);
    }

    if (candles.length >= 20) buildMALine(closes, 20, '#10b981');
    if (candles.length >= 50) buildMALine(closes, 50, '#eab308');
    if (candles.length >= 100) buildMALine(closes, 100, '#3b82f6');
    if (candles.length >= 200) buildMALine(closes, 200, '#a855f7');

    // Fibonacci level overlay (from quote API) — uses createPriceLine for direct chart visibility
    var fibQuote = null;
    try {
        var fibTicker = ticker || chartId.replace('ychart_', '').replace(/^\d+$/, '');
        if (fibTicker) {
        var fibResp = await fetch('/api/quote?ticker=' + encodeURIComponent(fibTicker), { headers: getAuthHeaders() }).then(function(r) { return r.json(); }).catch(function() { return null; });
        fibQuote = (fibResp && fibResp.fibonacci) ? fibResp.fibonacci : null;
        if (fibQuote && fibQuote.levels && candles.length >= 10) {
            // Use createPriceLine on candlestick series for reliable horizontal Fib lines
            var fibPriceLines = [
                { val: fibQuote.levels.fib382, label: 'Fib 38.2', color: '#f59e0b' },
                { val: fibQuote.levels.fib500, label: 'Fib 50', color: '#fbbf24' },
                { val: fibQuote.levels.fib618, label: 'Fib 61.8', color: '#d97706' },
                { val: fibQuote.levels.fib786, label: 'Fib 78.6', color: '#b45309' }
            ];
            // Get price range from candles to skip lines far outside visible area
            var priceMin = Infinity, priceMax = -Infinity;
            for (var pi = 0; pi < candles.length; pi++) {
                if (candles[pi].low < priceMin) priceMin = candles[pi].low;
                if (candles[pi].high > priceMax) priceMax = candles[pi].high;
            }
            var priceRange = priceMax - priceMin;
            var visibleMin = priceMin - priceRange * 0.15;
            var visibleMax = priceMax + priceRange * 0.15;

            for (var fi = 0; fi < fibPriceLines.length; fi++) {
                var fpl = fibPriceLines[fi];
                if (fpl.val != null && fpl.val >= visibleMin && fpl.val <= visibleMax) {
                    candleSeries.createPriceLine({
                        price: fpl.val,
                        color: fpl.color,
                        lineWidth: 1,
                        lineStyle: 2,
                        axisLabelVisible: true,
                        title: fpl.label
                    });
                }
            }
        }
        } // end if (fibTicker)
    } catch (fibErr) { /* Fibonacci overlay is optional — fail silently */ }

    // Caller-supplied overlays. Pattern uses these to draw its deterministic geometry
    // (Konfirmasi / Invalidasi / TP1 / TP2 / PRZ) and its X-A-B-C-D pivots on the same
    // chart engine the Chart page uses, so both views read identically.
    var extraLines = (options && Array.isArray(options.priceLines)) ? options.priceLines : [];
    for (var eli = 0; eli < extraLines.length; eli++) {
        var el = extraLines[eli];
        var elPrice = Number(el && el.price);
        if (!Number.isFinite(elPrice)) continue;
        try {
            candleSeries.createPriceLine({
                price: elPrice,
                color: el.color || '#94a3b8',
                lineWidth: el.lineWidth || 1,
                lineStyle: el.lineStyle == null ? 2 : el.lineStyle,
                axisLabelVisible: true,
                title: String(el.title || '')
            });
        } catch (elErr) { /* an overlay must never break the chart */ }
    }
    var extraMarkers = (options && Array.isArray(options.markers)) ? options.markers : [];
    if (extraMarkers.length && typeof candleSeries.setMarkers === 'function') {
        try { candleSeries.setMarkers(extraMarkers); } catch (mkErr) { /* optional */ }
    }

    chart.timeScale().fitContent();
    var _mainRO = observeChartResize(container, function(w) {
        var d = chartDims(variant, (typeof window !== 'undefined' ? window.innerWidth : 0), (typeof window !== 'undefined' ? window.innerHeight : 0));
        container.style.height = d.main + 'px';
        chart.applyOptions({ width: w, height: d.main });
    });
    if (_mainRO) _observers.push(_mainRO);
    container._chart = chart;

    // RSI panel
    var rsiContainer = document.getElementById(chartId + '_rsi');
    if (rsiContainer && candles.length > 15) {
        rsiContainer.innerHTML = '';
        rsiContainer.style.height = dims.rsi + 'px';
        var rsiChart = LightweightCharts.createChart(rsiContainer, {
            width: rsiContainer.clientWidth, height: dims.rsi,
            layout: { background: { color: '#0b0e14' }, textColor: '#6b7280' },
            grid: { vertLines: { color: '#1c233315' }, horzLines: { color: '#1c233320' } },
            rightPriceScale: { borderColor: '#1c2333', scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { visible: false },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            // RSI is a read-only strip: don't let it capture touch/scroll gestures.
            handleScroll: { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
            handleScale: { axisPressedMouseMove: false, mouseWheel: false, pinch: false }
        });

        // RSI data
        var rsiData = [];
        for (var i = 14; i < closes.length; i++) {
            var gains = 0, losses = 0;
            for (var k = i - 13; k <= i; k++) {
                var d = closes[k] - closes[k - 1];
                if (d > 0) gains += d; else losses -= d;
            }
            var ag = gains / 14, al = losses / 14;
            var rsi = al === 0 ? 100 : Math.round((100 - 100 / (1 + ag / al)) * 100) / 100;
            rsiData.push({ time: candles[i].time, value: rsi });
        }

        var rsiSeries = rsiChart.addLineSeries({ color: '#f97316', lineWidth: 1.5, crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: true });
        rsiSeries.setData(rsiData);

        // Guide levels 70/50/30
        var guideSeries70 = rsiChart.addLineSeries({ color: '#ef444440', lineWidth: 0.5, lineStyle: 2, crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false });
        var guideSeries30 = rsiChart.addLineSeries({ color: '#10b98140', lineWidth: 0.5, lineStyle: 2, crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false });
        var guideData70 = rsiData.map(function(r) { return { time: r.time, value: 70 }; });
        var guideData30 = rsiData.map(function(r) { return { time: r.time, value: 30 }; });
        guideSeries70.setData(guideData70);
        guideSeries30.setData(guideData30);

        rsiChart.timeScale().fitContent();
        var _rsiRO = observeChartResize(rsiContainer, function(w) {
            var d = chartDims(variant, (typeof window !== 'undefined' ? window.innerWidth : 0), (typeof window !== 'undefined' ? window.innerHeight : 0));
            rsiContainer.style.height = d.rsi + 'px';
            rsiChart.applyOptions({ width: w, height: d.rsi });
        });
        if (_rsiRO) _observers.push(_rsiRO);
    }

    // Metrics panel
    var metricsEl = document.getElementById(chartId + '_metrics');
    if (metricsEl && metrics) {
        var m = metrics;
        var latest = candles[candles.length - 1];
        var html = '';
        html += '<div><span class="text-gray-500">Last</span><br><span class="text-gray-200">' + latest.close + '</span></div>';
        html += '<div><span class="text-gray-500">Vol</span><br><span class="text-gray-200">' + formatVol(latest.volume) + '</span></div>';
        if (m.volumeAvg20) html += '<div><span class="text-gray-500">AvgVol20</span><br><span class="text-gray-200">' + formatVol(m.volumeAvg20) + '</span></div>';
        if (m.volumeVsAvg20) html += '<div><span class="text-gray-500">Vol/Avg</span><br><span class="text-gray-200">' + m.volumeVsAvg20 + 'x</span></div>';
        if (m.rsi14) html += '<div><span class="text-gray-500">RSI14</span><br><span class="' + (m.rsi14 > 70 ? 'text-red-400' : m.rsi14 < 30 ? 'text-emerald-400' : 'text-gray-200') + '">' + m.rsi14 + '</span></div>';
        if (m.ma20) html += '<div><span class="text-gray-500">MA20</span><br><span class="text-emerald-400">' + m.ma20 + '</span></div>';
        if (m.ma50) html += '<div><span class="text-gray-500">MA50</span><br><span class="text-yellow-400">' + m.ma50 + '</span></div>';
        if (m.ma200) html += '<div><span class="text-gray-500">MA200</span><br><span class="text-purple-400">' + m.ma200 + '</span></div>';
        metricsEl.innerHTML = html;
    }

    // Fibonacci levels strip (compact fallback below chart — secondary to in-chart price lines)
    if (fibQuote && fibQuote.levels) {
        var fibStripEl = document.getElementById(chartId + '_fib_strip');
        if (!fibStripEl) {
            fibStripEl = document.createElement('div');
            fibStripEl.id = chartId + '_fib_strip';
            fibStripEl.className = 'chart-fib-strip chart-fib-strip-compact';
            var metricsParent = document.getElementById(chartId + '_metrics');
            if (metricsParent && metricsParent.parentNode) {
                metricsParent.parentNode.insertBefore(fibStripEl, metricsParent.nextSibling);
            }
        }
        if (fibStripEl) {
            var fHtml = '<div class="chart-fib-header"><span class="text-amber-400/70 text-[9px]">Fib Levels (lihat chart)</span>';
            if (fibQuote.nearestLabel) fHtml += '<span class="text-gray-500 text-[9px]">Nearest: <b class="text-amber-400/80">' + fibQuote.nearestLabel + '</b></span>';
            fHtml += '</div><div class="chart-fib-grid">';
            if (fibQuote.levels.fib382 != null) fHtml += '<div class="chart-fib-item"><span>38.2%</span><b>' + fibQuote.levels.fib382 + '</b></div>';
            if (fibQuote.levels.fib500 != null) fHtml += '<div class="chart-fib-item"><span>50%</span><b>' + fibQuote.levels.fib500 + '</b></div>';
            if (fibQuote.levels.fib618 != null) fHtml += '<div class="chart-fib-item"><span>61.8%</span><b>' + fibQuote.levels.fib618 + '</b></div>';
            if (fibQuote.levels.fib786 != null) fHtml += '<div class="chart-fib-item"><span>78.6%</span><b>' + fibQuote.levels.fib786 + '</b></div>';
            fHtml += '</div>';
            fibStripEl.innerHTML = fHtml;
        }
    }

    // Register instances + metadata for the exporter (scoped, no global loose vars).
    var _latest = (candles && candles.length) ? candles[candles.length - 1] : null;
    _chartRegistry[chartId] = {
        chartId: chartId,
        variant: variant,
        mainChart: chart,
        rsiChart: (typeof rsiChart !== 'undefined' ? rsiChart : null) || null,
        ticker: ticker || '',
        metrics: metrics || null,
        lastClose: _latest ? _latest.close : null,
        lastVolume: _latest ? _latest.volume : null,
        fibQuote: fibQuote,
        dims: dims,
        observers: _observers
    };

    } catch (renderErr) {
        container.innerHTML = '<div class="flex items-center justify-center h-full text-gray-500 text-xs p-4 text-center">Chart gagal dirender. Coba buka TradingView.</div>';
    }
}

function formatVol(v) {
    if (!v) return '0';
    if (v >= 1000000000) return (v / 1000000000).toFixed(1) + 'B';
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(0) + 'K';
    return String(v);
}

// Indonesian volume formatter (lembar, not Rupiah)
function formatIndonesianVolume(v) {
    if (!v || v === 0) return '0 lembar';
    if (v >= 1000000000) return (v / 1000000000).toFixed(2).replace('.', ',') + ' miliar lembar';
    if (v >= 1000000) return (v / 1000000).toFixed(2).replace('.', ',') + ' juta lembar';
    if (v >= 1000) return (v / 1000).toFixed(1).replace('.', ',') + ' ribu lembar';
    return String(v) + ' lembar';
}

// Compact Indonesian volume (shorter, for context lines — always includes "lembar")
function formatCompactVolume(v) {
    if (!v || v === 0) return '0 lembar';
    if (v >= 1000000000) return (v / 1000000000).toFixed(2).replace('.', ',') + ' miliar lembar';
    if (v >= 1000000) return (v / 1000000).toFixed(2).replace('.', ',') + ' juta lembar';
    if (v >= 1000) return (v / 1000).toFixed(1).replace('.', ',') + ' ribu lembar';
    return String(v) + ' lembar';
}

// Format Rupiah (for estimated transaction value)
function formatIndonesianRupiah(v) {
    if (!v || v === 0) return 'Rp0';
    if (v >= 1000000000000) return 'Rp' + (v / 1000000000000).toFixed(2).replace('.', ',') + ' triliun';
    if (v >= 1000000000) return 'Rp' + (v / 1000000000).toFixed(2).replace('.', ',') + ' miliar';
    if (v >= 1000000) return 'Rp' + (v / 1000000).toFixed(1).replace('.', ',') + ' juta';
    return 'Rp' + Math.round(v).toLocaleString('id-ID');
}

// Humanize Fibonacci trend enum to Indonesian label
function humanizeFibTrend(trend) {
    var map = {
        'upward_retracement': 'Retracement naik',
        'downward_retracement': 'Retracement turun',
        'range_bound': 'Dalam rentang swing',
        'above_high': 'Di atas swing high',
        'below_low': 'Di bawah swing low'
    };
    return map[trend] || trend || 'Tidak tersedia';
}

// Full-composite chart exporter. Captures the COMPLETE composed chart:
//   - main chart via Lightweight Charts takeScreenshot() (candles, volume, MA lines,
//     grid, right price scale, Fibonacci price lines + axis labels, bottom time scale);
//   - RSI sub-chart via its own takeScreenshot() (RSI line, guides, scale);
//   - canvas-rendered metadata (ticker + WIB timestamp, MA legend, full metrics —
//     Last/Vol/AvgVol20/Vol/Avg/RSI14/MA20/MA50/MA200 — Fibonacci summary, disclaimer).
// High-DPI correct: all layout is in CSS pixels, the context is scaled once by DPR,
// and screenshots are drawn into CSS-pixel rectangles so nothing is stretched/blurred.
async function exportChartPng(chartId, ticker, btn) {
    var entry = _chartRegistry[chartId];
    var origBtnHtml = btn ? btn.innerHTML : null;
    function restoreBtn() { if (btn && origBtnHtml != null) { btn.disabled = false; btn.innerHTML = origBtnHtml; } }
    function fail(msg) {
        restoreBtn();
        if (typeof showToast === 'function') showToast(msg || 'Download chart belum tersedia. Coba lagi.', 'warning');
    }
    // Guard: require a ready main chart instance before doing anything (no blank files).
    if (!entry || !entry.mainChart || typeof entry.mainChart.takeScreenshot !== 'function') {
        return fail('Chart belum siap untuk di-download. Tunggu chart selesai dimuat lalu coba lagi.');
    }
    if (btn) { btn.disabled = true; btn.innerHTML = 'Menyiapkan…'; }
    try {
        // Let any pending resize/render work settle before screenshotting (two frames).
        await new Promise(function(res) {
            var raf = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame : function(f) { return setTimeout(f, 16); };
            raf(function() { raf(function() { res(); }); });
        });

        var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
        var mainShot = entry.mainChart.takeScreenshot();
        var rsiShot = (entry.rsiChart && typeof entry.rsiChart.takeScreenshot === 'function') ? entry.rsiChart.takeScreenshot() : null;
        if (!mainShot || !mainShot.width) throw new Error('empty main screenshot');

        // Intrinsic CSS sizes from the screenshots (device px / dpr) — preserves aspect ratio.
        var mainCssW = mainShot.width / dpr;
        var mainCssH = mainShot.height / dpr;
        var rsiCssH = rsiShot ? (rsiShot.height / dpr) : 0;
        var cssW = mainCssW;
        var pad = 12;

        // Metrics items (full — never truncated).
        var m = entry.metrics || {};
        var items = [];
        if (entry.lastClose != null) items.push({ k: 'Last', v: String(entry.lastClose) });
        if (entry.lastVolume != null) items.push({ k: 'Vol', v: formatVol(entry.lastVolume) });
        if (m.volumeAvg20 != null) items.push({ k: 'AvgVol20', v: formatVol(m.volumeAvg20) });
        if (m.volumeVsAvg20 != null) items.push({ k: 'Vol/Avg', v: m.volumeVsAvg20 + 'x' });
        if (m.rsi14 != null) items.push({ k: 'RSI14', v: String(m.rsi14) });
        if (m.ma20 != null) items.push({ k: 'MA20', v: String(m.ma20) });
        if (m.ma50 != null) items.push({ k: 'MA50', v: String(m.ma50) });
        if (m.ma200 != null) items.push({ k: 'MA200', v: String(m.ma200) });
        var colW = 96;
        var perRow = Math.max(1, Math.floor((cssW - pad * 2) / colW));
        var metricRows = items.length ? Math.ceil(items.length / perRow) : 0;
        var metricsH = items.length ? (metricRows * 30 + 10) : 0;

        // Fibonacci summary line.
        var fib = entry.fibQuote;
        var fibLine = '';
        if (fib && fib.levels) {
            var parts = [];
            if (fib.levels.fib382 != null) parts.push('38.2 ' + fib.levels.fib382);
            if (fib.levels.fib500 != null) parts.push('50 ' + fib.levels.fib500);
            if (fib.levels.fib618 != null) parts.push('61.8 ' + fib.levels.fib618);
            if (fib.levels.fib786 != null) parts.push('78.6 ' + fib.levels.fib786);
            if (parts.length) fibLine = 'Fib: ' + parts.join('  |  ') + (fib.nearestLabel ? '   (Nearest: ' + fib.nearestLabel + ')' : '');
        }
        var headerH = 40, legendH = 22, fibH = fibLine ? 20 : 0, disclaimerH = 26;
        var totalCssH = headerH + mainCssH + rsiCssH + legendH + metricsH + fibH + disclaimerH;

        // Backing bitmap = CSS size × DPR; scale context once so we draw in CSS coords.
        var bmp = computeExportBitmapSize(cssW, totalCssH, dpr);
        var canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        var ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        // Dark, readable background (explicitly opaque — never transparent).
        ctx.fillStyle = '#0f1319';
        ctx.fillRect(0, 0, cssW, totalCssH);

        // Header: title (left) + WIB timestamp (right).
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#e5e7eb';
        ctx.font = '600 15px Inter, system-ui, sans-serif';
        ctx.fillText('Chart ' + (entry.ticker || ticker || '') + '  \u00b7  Data Historis T-1', pad, 26);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#6b7280';
        ctx.font = '11px Inter, system-ui, sans-serif';
        ctx.fillText(formatWibStamp(), cssW - pad, 26);
        ctx.textAlign = 'left';

        var y = headerH;
        // Main chart screenshot (full width, intrinsic CSS height).
        ctx.drawImage(mainShot, 0, y, mainCssW, mainCssH);
        y += mainCssH;
        // RSI screenshot.
        if (rsiShot) { ctx.drawImage(rsiShot, 0, y, rsiShot.width / dpr, rsiCssH); y += rsiCssH; }

        // MA / RSI / Fib legend row.
        var legend = [
            { t: 'MA20', c: '#10b981' }, { t: 'MA50', c: '#eab308' }, { t: 'MA100', c: '#3b82f6' },
            { t: 'MA200', c: '#a855f7' }, { t: 'RSI14', c: '#f97316' }, { t: 'Fib', c: '#f59e0b' }
        ];
        var lx = pad, ly = y + 15;
        ctx.font = '11px Inter, system-ui, sans-serif';
        for (var li = 0; li < legend.length; li++) {
            ctx.fillStyle = legend[li].c;
            ctx.fillRect(lx, ly - 8, 9, 9);
            ctx.fillStyle = '#cbd5e1';
            ctx.fillText(legend[li].t, lx + 13, ly);
            lx += 13 + ctx.measureText(legend[li].t).width + 16;
        }
        y += legendH;

        // Metrics grid.
        if (items.length) {
            ctx.font = '11px Inter, system-ui, sans-serif';
            for (var ii = 0; ii < items.length; ii++) {
                var col = ii % perRow, row = Math.floor(ii / perRow);
                var mx = pad + col * colW, my = y + row * 30;
                ctx.fillStyle = '#6b7280';
                ctx.fillText(items[ii].k, mx, my + 12);
                ctx.fillStyle = '#e5e7eb';
                ctx.fillText(items[ii].v, mx, my + 26);
            }
            y += metricsH;
        }

        // Fibonacci summary.
        if (fibLine) {
            ctx.fillStyle = '#fbbf24';
            ctx.font = '11px Inter, system-ui, sans-serif';
            ctx.fillText(fibLine, pad, y + 13);
            y += fibH;
        }

        // Disclaimer.
        ctx.fillStyle = '#6b7280';
        ctx.font = '10px Inter, system-ui, sans-serif';
        ctx.fillText('Bukan rekomendasi beli/jual \u00b7 Data historis T-1 \u00b7 Auto-Cuan', pad, y + 15);

        var link = document.createElement('a');
        link.download = buildChartExportFilename(ticker);
        link.href = canvas.toDataURL('image/png');
        link.click();
        restoreBtn();
    } catch (e) {
        fail('Gagal membuat gambar chart. Coba lagi sebentar.');
    }
}

// Backwards-compatible alias — inline chat chart and Chart page use the SAME exporter.
function downloadChartPng(chartId, ticker, btn) {
    return exportChartPng(chartId, ticker, btn);
}

// ===== PDF DOWNLOAD FUNCTIONS (jsPDF + autoTable — programmatic, no screenshot) =====
var _pdfDisclaimer = 'Ini bukan rekomendasi beli/jual. Gunakan sebagai bahan analisis mandiri dan kelola risiko.';

function _ensureJsPdf(cb) {
    if (typeof window.jspdf !== 'undefined' && typeof window.jspdf.jsPDF !== 'undefined') { cb(); return; }
    if (typeof window.loadPdfLibrary !== 'function') {
        showToast('Ekspor PDF belum tersedia. Muat ulang halaman lalu coba lagi.', 'warning');
        return;
    }
    showToast('Menyiapkan ekspor PDF…', 'info');
    window.loadPdfLibrary().then(function(ready) {
        if (ready && typeof window.jspdf !== 'undefined' && typeof window.jspdf.jsPDF !== 'undefined') { cb(); return; }
        showToast('Ekspor PDF gagal disiapkan. Periksa koneksi lalu coba lagi.', 'warning');
    });
}

function _pdfAddHeader(doc, title, orientation) {
    var pageW = orientation === 'landscape' ? 297 : 210;
    var now = new Date();
    var ts = now.toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short' });
    // Title
    doc.setFontSize(14);
    doc.setTextColor(16, 185, 129);
    doc.text(title, 5, 9);
    // Timestamp
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.text('Dibuat: ' + ts + '  |  Auto-Cuan SMC Analysis Platform', 5, 13.5);
    // Line
    doc.setDrawColor(16, 185, 129);
    doc.setLineWidth(0.3);
    doc.line(5, 15, pageW - 5, 15);
    return 17; // y position after header
}

function _pdfAddFooter(doc, orientation) {
    var pageW = orientation === 'landscape' ? 297 : 210;
    var pageH = orientation === 'landscape' ? 210 : 297;
    var pageCount = doc.internal.getNumberOfPages();
    for (var i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(6);
        doc.setTextColor(130, 130, 130);
        doc.text(_pdfDisclaimer, 5, pageH - 5);
        doc.text('Auto-Cuan | Halaman ' + i + '/' + pageCount, pageW - 45, pageH - 5);
    }
}

// ===== ANALYSIS PDF (compact 1-page executive summary) =====
function exportAnalisisPDF(ticker) {
    var resultArea = document.getElementById('analisisResult');
    if (!resultArea) return;
    var contentEl = resultArea.querySelector('.ai-content');
    if (!contentEl) { showToast('Belum ada hasil analisis untuk di-export.', 'warning'); return; }

    _ensureJsPdf(function() {
        var isIndex = isIndexTicker(ticker);
        var title = isIndex ? 'Analisis IHSG' : 'Analisis ' + ticker;
        var filename = isIndex ? 'Auto-Cuan-IHSG-Analysis.pdf' : 'Auto-Cuan-' + ticker + '-Analysis.pdf';

        var jsPDF = window.jspdf.jsPDF;
        var doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        var startY = _pdfAddHeader(doc, title, 'portrait');
        var maxW = 200; // 210 - 2*5mm margin
        var y = startY;

        // Smart extraction: pull key fields from the DOM text
        var rawText = _extractAnalysisText(contentEl);
        var fields = _extractKeyFields(rawText, isIndex);

        // Render compact fields
        y = _renderCompactAnalysis(doc, fields, y, maxW, isIndex);

        // If we still have space, add a compact note
        if (y < 285) {
            doc.setFontSize(6);
            doc.setTextColor(150, 150, 150);
            doc.setFont(undefined, 'italic');
            doc.text('Ringkasan PDF compact. Lihat halaman analisis untuk detail lengkap.', 5, Math.min(y + 3, 288));
        }

        _pdfAddFooter(doc, 'portrait');
        doc.save(filename);
        showToast('PDF berhasil diunduh.', 'success');
    });
}

function _extractAnalysisText(el) {
    if (!el) return '';
    var html = el.innerHTML;
    var o = html;
    o = o.replace(/<br\s*\/?>/gi, '\n');
    o = o.replace(/<\/(div|p|li|h[1-6]|tr)>/gi, '\n');
    o = o.replace(/<(div|p|li|h[1-6]|tr)[^>]*>/gi, '\n');
    o = o.replace(/<span[^>]*>([^<]*)<\/span>\s*<b[^>]*>([^<]*)<\/b>/gi, '$1: $2');
    o = o.replace(/<[^>]+>/g, '');
    o = o.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ').replace(/&middot;/g, '\u00B7');
    o = o.replace(/[ \t]+/g, ' ');
    o = o.replace(/ ?\n ?/g, '\n');
    o = o.replace(/\n{3,}/g, '\n\n');
    return o.trim();
}

function _extractKeyFields(text, isIndex) {
    var f = {};
    if (!text) return f;
    // Helper: find value after a label pattern
    function grab(patterns, maxLen) {
        maxLen = maxLen || 120;
        for (var p = 0; p < patterns.length; p++) {
            var rx = new RegExp(patterns[p] + '[:\\s]*(.+)', 'im');
            var m = text.match(rx);
            if (m && m[1]) { var v = m[1].trim().substring(0, maxLen); if (v) return v; }
        }
        return '';
    }
    // Helper: grab a section block (from heading to next heading or max lines)
    function grabSection(headings, maxLines) {
        maxLines = maxLines || 5;
        var lines = text.split('\n');
        var found = false;
        var result = [];
        var hRx = new RegExp('^(' + headings.join('|') + ')', 'i');
        var anyHead = /^(Kesimpulan|Ringkasan|Potensi|Data|Momentum|Resistance|Support|Skenario|Risk|Invalidasi|News|Katalis|Implikasi|Bias|Status|Trend|Volume|Level|Entry|Stop|Take|Action|Confidence|Market|RSI|MACD|Fib|Rekomendasi|Peluang|Warning|Disclaimer|Overview|Summary|Key)/i;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!found) {
                if (hRx.test(line)) { found = true; continue; }
            } else {
                if (!line) continue;
                if (anyHead.test(line) && result.length > 0) break;
                result.push(line);
                if (result.length >= maxLines) break;
            }
        }
        return result.join('\n');
    }

    f.status = grab(['Status Market', 'Status', 'Sikap']);
    f.bias = grab(['Bias', 'Bias IHSG', 'Bias Saham']);
    f.confidence = grab(['Confidence', 'Keyakinan']);
    f.action = grab(['Action', 'Aksi', 'Sikap']);
    f.last = grab(['Last', 'Harga Terakhir', 'Close']);
    f.change = grab(['Change', 'Perubahan', 'Chg']);
    f.resistance = grab(['Resistance', 'Resist']);
    f.support = grab(['Support']);
    f.entry = grab(['Entry', 'Area Entry', 'Entry Area']);
    f.stopLoss = grab(['Stop Loss', 'SL', 'Invalidasi']);
    f.tp1 = grab(['TP1', 'Take Profit 1', 'Target 1']);
    f.tp2 = grab(['TP2', 'Take Profit 2', 'Target 2']);
    f.rr = grab(['Risk.?Reward', 'RR', 'R:R', 'Risk/Reward']);
    f.ringkasan = grabSection(['Ringkasan', 'Summary', 'Overview', 'Kesimpulan Cepat'], 4);
    f.potensiBesok = grabSection(['Potensi Besok', 'Potensi'], 3);
    f.skenarioBullish = grab(['Bullish', 'Bull Case', 'Best Case']);
    f.skenarioNetral = grab(['Netral', 'Base Case', 'Neutral']);
    f.skenarioBearish = grab(['Bearish', 'Bear Case', 'Worst Case']);
    f.riskGuard = grabSection(['Risk Guard', 'Risk', 'Warning'], 3);
    f.kesimpulan = grabSection(['Kesimpulan Final', 'Kesimpulan'], 4);

    // IHSG specific
    if (isIndex) {
        f.ma20 = grab(['MA20', 'MA 20']);
        f.ma50 = grab(['MA50', 'MA 50']);
        f.ma100 = grab(['MA100', 'MA 100']);
        f.ma200 = grab(['MA200', 'MA 200']);
        f.rsi = grab(['RSI']);
        f.volume = grab(['Volume']);
    }
    return f;
}

function _renderCompactAnalysis(doc, f, y, maxW, isIndex) {
    // Helper: render a labeled row
    function row(label, value, labelColor, valueColor) {
        if (!value) return;
        if (y > 282) return; // hard stop near page end
        doc.setFontSize(7);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(labelColor[0], labelColor[1], labelColor[2]);
        doc.text(label + ':', 5, y);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(valueColor[0], valueColor[1], valueColor[2]);
        var valLines = doc.splitTextToSize(value, maxW - 30);
        doc.text(valLines.slice(0, 2).join(' '), 32, y);
        y += Math.min(valLines.length, 2) * 3 + 0.5;
    }
    // Helper: render a section heading + body
    function section(heading, body, maxLines) {
        if (!body) return;
        if (y > 278) return;
        doc.setFontSize(8);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(16, 185, 129);
        doc.text(heading, 5, y);
        y += 3.5;
        doc.setFontSize(7);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(60, 60, 60);
        var lines = doc.splitTextToSize(body, maxW);
        var max = maxLines || 4;
        for (var i = 0; i < Math.min(lines.length, max); i++) {
            if (y > 284) break;
            doc.text(lines[i], 5, y);
            y += 2.8;
        }
        y += 1.5;
    }

    var green = [16, 185, 129];
    var gray = [80, 80, 80];
    var dark = [40, 40, 40];

    // === Key Metrics Grid ===
    row('Status', f.status, green, dark);
    row('Bias', f.bias, green, dark);
    row('Confidence', f.confidence, green, dark);
    row('Action/Sikap', f.action, green, dark);
    row('Last', f.last + (f.change ? ' (' + f.change + ')' : ''), green, dark);
    y += 1;

    // === Levels ===
    row('Resistance', f.resistance, gray, dark);
    row('Support', f.support, gray, dark);
    if (!isIndex) {
        row('Entry', f.entry, gray, dark);
        row('Stop Loss', f.stopLoss, [200, 50, 50], dark);
        row('TP1', f.tp1, [16, 160, 100], dark);
        row('TP2', f.tp2, [16, 160, 100], dark);
        row('RR', f.rr, gray, dark);
    }
    y += 1;

    // === IHSG Data Teknikal ===
    if (isIndex && (f.ma20 || f.ma50 || f.rsi)) {
        doc.setFontSize(8);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(16, 185, 129);
        doc.text('Data Teknikal', 5, y);
        y += 3.5;
        doc.setFontSize(7);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(60, 60, 60);
        var techParts = [];
        if (f.ma20) techParts.push('MA20: ' + f.ma20);
        if (f.ma50) techParts.push('MA50: ' + f.ma50);
        if (f.ma100) techParts.push('MA100: ' + f.ma100);
        if (f.ma200) techParts.push('MA200: ' + f.ma200);
        if (f.rsi) techParts.push('RSI: ' + f.rsi);
        if (f.volume) techParts.push('Vol: ' + f.volume);
        var techLine = techParts.join('  |  ');
        var techLines = doc.splitTextToSize(techLine, maxW);
        for (var t = 0; t < Math.min(techLines.length, 2); t++) {
            doc.text(techLines[t], 5, y); y += 2.8;
        }
        y += 2;
    }

    // === Sections ===
    section('Ringkasan', f.ringkasan, 4);
    section('Potensi Besok', f.potensiBesok, 3);

    // === Skenario (compact inline) ===
    if (f.skenarioBullish || f.skenarioNetral || f.skenarioBearish) {
        if (y < 275) {
            doc.setFontSize(8);
            doc.setFont(undefined, 'bold');
            doc.setTextColor(16, 185, 129);
            doc.text('Skenario', 5, y);
            y += 3.5;
            doc.setFontSize(7);
            doc.setFont(undefined, 'normal');
            if (f.skenarioBullish) { doc.setTextColor(16, 160, 100); doc.text('\u2022 Bull: ' + f.skenarioBullish.substring(0, 90), 5, y); y += 2.8; }
            if (f.skenarioNetral) { doc.setTextColor(80, 80, 80); doc.text('\u2022 Base: ' + f.skenarioNetral.substring(0, 90), 5, y); y += 2.8; }
            if (f.skenarioBearish) { doc.setTextColor(200, 50, 50); doc.text('\u2022 Bear: ' + f.skenarioBearish.substring(0, 90), 5, y); y += 2.8; }
            y += 1.5;
        }
    }

    section('Risk Guard', f.riskGuard, 3);
    section('Kesimpulan', f.kesimpulan, 4);

    return y;
}

// ===== KONGLO SCREENER PDF (jsPDF autoTable) =====
function exportKongloScreenerPDF() {
    var tbody = document.getElementById('screenerTableBody');
    if (!tbody || !tbody.querySelector('tr td:not([colspan])')) {
        showToast('Belum ada data screener untuk di-export.', 'warning');
        return;
    }
    _ensureJsPdf(function() {
        var jsPDF = window.jspdf.jsPDF;
        var doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        var startY = _pdfAddHeader(doc, 'Auto-Cuan Konglo Screener', 'landscape');

        // Stats line
        var universe = (document.getElementById('screenerStatUniverse') || {}).textContent || '-';
        var scanned = (document.getElementById('screenerStatScanned') || {}).textContent || '-';
        var failed = (document.getElementById('screenerStatFailed') || {}).textContent || '-';
        var metaBadge = (document.getElementById('screenerMetaBadge') || {}).textContent || '';
        doc.setFontSize(7);
        doc.setTextColor(80, 80, 80);
        var statsText = 'Universe: ' + universe + '  |  Scanned: ' + scanned + '  |  Failed: ' + failed;
        if (metaBadge) statsText += '  |  ' + metaBadge;
        if (_screenerFilter && _screenerFilter !== 'all') statsText += '  |  Filter: ' + _screenerFilter;
        doc.text(statsText, 5, startY);
        startY += 4;

        // Extract table data from DOM
        var heads = [['Ticker', 'Group', 'Tier', 'Exec', 'Setup', 'Last', 'Chg%', 'RSI', 'Vol/Avg20', 'Entry', 'SL', 'TP1', 'TP2', 'RR', 'Timing', 'Arah', 'Catatan']];
        var body = [];
        var rows = document.querySelectorAll('#screenerTableBody tr');
        rows.forEach(function(row) {
            var cells = row.querySelectorAll('td');
            if (cells.length < 14) return;
            var rowData = [];
            for (var i = 0; i < cells.length; i++) {
                rowData.push((cells[i].textContent || '').trim());
            }
            body.push(rowData);
        });

        doc.autoTable({
            startY: startY,
            head: heads,
            body: body,
            theme: 'grid',
            margin: { left: 5, right: 5 },
            styles: { fontSize: 5.5, cellPadding: 1.2, lineColor: [40, 50, 60], lineWidth: 0.1, textColor: [50, 50, 50], overflow: 'linebreak' },
            headStyles: { fillColor: [20, 30, 40], textColor: [180, 200, 210], fontSize: 6, fontStyle: 'bold', cellPadding: 1.5 },
            columnStyles: { 16: { cellWidth: 25 } },
            didParseCell: function(data) {
                // Color status cells
                if (data.column.index === 2 && data.section === 'body') {
                    var val = (data.cell.raw || '').toUpperCase();
                    if (val.indexOf('READY') >= 0 || val.indexOf('A+') >= 0 || val.indexOf('TRADE') >= 0) data.cell.styles.textColor = [16, 185, 129];
                    else if (val.indexOf('WATCH') >= 0) data.cell.styles.textColor = [59, 130, 246];
                    else if (val.indexOf('SPEC') >= 0 || val.indexOf('REBOUND') >= 0) data.cell.styles.textColor = [245, 158, 11];
                    else if (val.indexOf('WAIT') >= 0) data.cell.styles.textColor = [249, 115, 22];
                    else data.cell.styles.textColor = [239, 68, 68];
                }
            }
        });

        _pdfAddFooter(doc, 'landscape');
        doc.save('Auto-Cuan-Konglo-Screener.pdf');
        showToast('PDF berhasil diunduh.', 'success');
    });
}

// ===== NON-KONGLO SCREENER PDF (jsPDF autoTable) =====
function exportNonKongloScreenerPDF() {
    var tbody = document.getElementById('nkScreenerTableBody');
    if (!tbody || !tbody.querySelector('tr td:not([colspan])')) {
        showToast('Belum ada data screener untuk di-export.', 'warning');
        return;
    }
    _ensureJsPdf(function() {
        var jsPDF = window.jspdf.jsPDF;
        var doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        var startY = _pdfAddHeader(doc, 'Auto-Cuan Non-Konglo Screener', 'landscape');

        // Meta line
        var metaBadge = (document.getElementById('nkScreenerMetaBadge') || {}).textContent || '';
        doc.setFontSize(7);
        doc.setTextColor(80, 80, 80);
        var metaText = metaBadge ? metaBadge : '';
        if (_nkScreenerFilter && _nkScreenerFilter !== 'all') metaText += (metaText ? '  |  ' : '') + 'Filter: ' + _nkScreenerFilter;
        if (metaText) { doc.text(metaText, 5, startY); startY += 4; }

        // Extract table data from DOM
        var heads = [['#', 'Ticker', 'Board', 'Tier', 'Exec', 'Setup', 'Last', 'Chg%', 'RSI', 'Vol/Avg20', 'Entry', 'SL', 'TP1', 'TP2', 'RR', 'Timing', 'Arah', 'Catatan']];
        var body = [];
        var rows = document.querySelectorAll('#nkScreenerTableBody tr');
        rows.forEach(function(row) {
            var cells = row.querySelectorAll('td');
            if (cells.length < 16) return;
            var rowData = [];
            for (var i = 0; i < cells.length; i++) {
                rowData.push((cells[i].textContent || '').trim());
            }
            body.push(rowData);
        });

        doc.autoTable({
            startY: startY,
            head: heads,
            body: body,
            theme: 'grid',
            margin: { left: 5, right: 5 },
            styles: { fontSize: 5, cellPadding: 1, lineColor: [40, 50, 60], lineWidth: 0.1, textColor: [50, 50, 50], overflow: 'linebreak' },
            headStyles: { fillColor: [20, 30, 40], textColor: [180, 200, 210], fontSize: 5.5, fontStyle: 'bold', cellPadding: 1.3 },
            columnStyles: { 0: { cellWidth: 6 }, 17: { cellWidth: 22 } },
            didParseCell: function(data) {
                if (data.column.index === 3 && data.section === 'body') {
                    var val = (data.cell.raw || '').toUpperCase();
                    if (val.indexOf('READY') >= 0 || val.indexOf('A+') >= 0 || val.indexOf('TRADE') >= 0) data.cell.styles.textColor = [16, 185, 129];
                    else if (val.indexOf('WATCH') >= 0 && val.indexOf('WAIT') < 0) data.cell.styles.textColor = [59, 130, 246];
                    else if (val.indexOf('SPEC') >= 0 || val.indexOf('REBOUND') >= 0) data.cell.styles.textColor = [245, 158, 11];
                    else if (val.indexOf('WAIT') >= 0) data.cell.styles.textColor = [249, 115, 22];
                    else data.cell.styles.textColor = [239, 68, 68];
                }
            }
        });

        _pdfAddFooter(doc, 'landscape');
        doc.save('Auto-Cuan-Non-Konglo-Screener.pdf');
        showToast('PDF berhasil diunduh.', 'success');
    });
}

// ============================================================
// DAY TRADE SCREENER — JavaScript Functions
// ============================================================
var _dtScreenerCache = null;
var _dtScreenerFilter = 'all';
var _dtPollInterval = null;
var DAYTRADE_LATEST_EMPTY_TEXT = 'Snapshot Day Trade belum tersedia / latest table kosong. Coba refresh saat scan selesai.';
var DAYTRADE_WATCH_STATUSES = ['WATCH_PULLBACK', 'WAIT_PULLBACK', 'RECLAIM_CANDIDATE', 'MOMENTUM_CONTINUATION', 'SPECULATIVE'];
function isDayTradeWatchStatus(status) { return DAYTRADE_WATCH_STATUSES.indexOf(status) >= 0; }
function getDayTradeEmptyMessage(data) { return data && data.latest_rows_empty ? DAYTRADE_LATEST_EMPTY_TEXT : DAYTRADE_EMPTY_TEXT; }

async function loadDayTradeScreener() {
    if (_dtScreenerInFlight) return _dtScreenerInFlight;
    var tbody = document.getElementById('dtScreenerTableBody');
    if (!tbody) return;

    // Perceived-speed fix: dtCardGrid is the visible UI, not the table tbody. Render cached
    // cards immediately (with a subtle refreshing banner) so the grid never looks blank/stuck.
    // If no cache exists yet, show skeleton cards instead of nothing. Day Trade in particular
    // was reported as feeling slow/blank because this scan can take longer than the other two.
    var dtCardEl = document.getElementById('dtCardGrid');
    if (dtCardEl) {
        if (_dtScreenerCache && _dtScreenerCache.results && _dtScreenerCache.results.length) {
            renderDtCardGrid(_dtScreenerCache.results, _dtScreenerCache);
            dtCardEl.insertAdjacentHTML('afterbegin', screenerRefreshingBannerHtml());
        } else {
            dtCardEl.innerHTML = screenerSkeletonCardHtml(4);
        }
    }
    // Table tbody loading stays as secondary/fallback (table view is hidden by default).
    tbody.innerHTML = '<tr><td colspan="22" class="text-center py-8 text-gray-500"><div class="spinner mx-auto mb-2"></div>' + DASHBOARD_LOADING_TEXT + '</td></tr>';

    _dtScreenerInFlight = (async function() {
    try {
        var response = await fetch('/api/sector-hot?action=daytrade-screener');
        var data = await response.json();

        if (!data.success) {
            tbody.innerHTML = screenerEmptyRowHtml(22, DASHBOARD_ERROR_TEXT, 'error', 'loadDayTradeScreener()');
            var dtCardElEmptyErr = document.getElementById('dtCardGrid');
            if (dtCardElEmptyErr) {
                if (_dtScreenerCache && _dtScreenerCache.results && _dtScreenerCache.results.length) {
                    renderDtCardGrid(_dtScreenerCache.results, _dtScreenerCache);
                } else {
                    dtCardElEmptyErr.innerHTML = screenerEmptyCardHtml(DASHBOARD_ERROR_TEXT);
                }
            }
            return;
        }

        _dtScreenerCache = data;

        // Update meta
        var meta = data.meta || {};
        var badge = document.getElementById('dtMetaBadge');
        if (badge) {
            var ts = meta.calculated_at ? new Date(meta.calculated_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : '—';
            badge.textContent = ((meta.source === 'latest_completed_snapshot' || meta.status === 'latest_completed_snapshot') ? 'Latest Completed Snapshot' : (meta.freshness_label || meta.snapshot_label || meta.status || 'pending')) + ' · ' + ts;
            // V2 Freshness label: warn if Day Trade data is not from today
            if (meta.calculated_at && meta.status !== 'scanning') {
                var dtCalcDate = new Date(meta.calculated_at);
                var dtNowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
                var dtCalcDateStr = dtCalcDate.toISOString().slice(0, 10);
                var dtTodayStr = dtNowWib.toISOString().slice(0, 10);
                var dtYesterdayStr = new Date(dtNowWib.getTime() - 86400000).toISOString().slice(0, 10);
                if (dtCalcDateStr !== dtTodayStr && dtCalcDateStr !== dtYesterdayStr) {
                    badge.textContent = '\u26A0 STALE \u00b7 Data day trade sudah lama (' + dtCalcDateStr + '). Refresh wajib sebelum entry. \u00b7 ' + ts;
                    badge.style.color = '#f59e0b';
                }
            }
        }

        var statU = document.getElementById('dtStatUniverse');
        var statS = document.getElementById('dtStatScanned');
        var statP = document.getElementById('dtStatPublished');
        var statM = document.getElementById('dtStatRunMode');
        if (statU) statU.textContent = meta.universe_count || '—';
        if (statS) statS.textContent = meta.scanned_count || '—';
        if (statP) statP.textContent = meta.published_count || (data.results ? data.results.length : '—');
        if (statM) statM.textContent = meta.run_mode || '—';

        // Handle scanning state — show progress and start polling
        if (meta.status === 'scanning') {
            showDtProgress(meta);
            startDtPolling();
        } else {
            hideDtProgress();
            stopDtPolling();
        }

        renderDtTable(data.results || [], data);
        renderDtCardGrid(data.results || [], data);
    } catch (e) {
        tbody.innerHTML = screenerEmptyRowHtml(22, DASHBOARD_ERROR_TEXT, 'error', 'loadDayTradeScreener()');
        // Card grid: keep showing cached cards on a failed background refresh (just drop the
        // banner); only replace with an error state if there is no cache to fall back to.
        var dtCardElErr = document.getElementById('dtCardGrid');
        if (dtCardElErr) {
            if (_dtScreenerCache && _dtScreenerCache.results && _dtScreenerCache.results.length) {
                renderDtCardGrid(_dtScreenerCache.results);
            } else {
                dtCardElErr.innerHTML = screenerEmptyCardHtml(DASHBOARD_ERROR_TEXT);
            }
        }
    } finally { _dtScreenerInFlight = null; }
    })();
    return _dtScreenerInFlight;
}

function showDtProgress(meta) {
    var wrap = document.getElementById('dtProgressWrap');
    if (wrap) wrap.classList.remove('hidden');

    var universe = meta.universe_count || 0;
    var scanned = meta.scanned_count || 0;
    var pct = universe > 0 ? Math.round(scanned / universe * 100) : 0;

    var bar = document.getElementById('dtProgressBar');
    var label = document.getElementById('dtProgressLabel');
    var msg = document.getElementById('dtProgressMsg');
    var batch = document.getElementById('dtProgressBatch');
    var passed = document.getElementById('dtProgressPassed');
    var failed = document.getElementById('dtProgressFailed');

    if (bar) bar.style.width = pct + '%';
    if (label) label.textContent = scanned + ' / ' + universe + ' (' + pct + '%)';
    if (msg) msg.textContent = meta.message || 'Scanning…';
    if (batch) batch.textContent = '';
    if (passed) passed.textContent = meta.passed_count || 0;
    if (failed) failed.textContent = meta.failed_count || 0;
}

function hideDtProgress() {
    var wrap = document.getElementById('dtProgressWrap');
    if (wrap) wrap.classList.add('hidden');
}

function startDtPolling() {
    stopDtPolling();
    _dtPollInterval = setInterval(async function() {
        if (_currentScreenerType !== 'daytrade') { stopDtPolling(); return; }
        try {
            var response = await fetch('/api/sector-hot?action=daytrade-screener');
            var data = await response.json();
            if (!data.success) return;

            var meta = data.meta || {};

            // Update progress
            if (meta.status === 'scanning') {
                showDtProgress(meta);
                // Update stats
                var statS = document.getElementById('dtStatScanned');
                if (statS) statS.textContent = meta.scanned_count || '—';
            } else {
                // Scanning done — stop polling, reload full data
                hideDtProgress();
                stopDtPolling();
                _dtScreenerCache = data;
                updateDtMetaUI(meta);
                renderDtTable(data.results || [], data);
                renderDtCardGrid(data.results || [], data);
            }
        } catch (e) { /* silent retry next interval */ }
    }, 3000);
}

function stopDtPolling() {
    if (_dtPollInterval) { clearInterval(_dtPollInterval); _dtPollInterval = null; }
}

function updateDtMetaUI(meta) {
    var badge = document.getElementById('dtMetaBadge');
    if (badge) {
        var ts = meta.calculated_at ? new Date(meta.calculated_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : '—';
        badge.textContent = ((meta.source === 'latest_completed_snapshot' || meta.status === 'latest_completed_snapshot') ? 'Latest Completed Snapshot' : (meta.freshness_label || meta.snapshot_label || meta.status || 'pending')) + ' · ' + ts;
    }
    var statU = document.getElementById('dtStatUniverse');
    var statS = document.getElementById('dtStatScanned');
    var statP = document.getElementById('dtStatPublished');
    var statM = document.getElementById('dtStatRunMode');
    if (statU) statU.textContent = meta.universe_count || '—';
    if (statS) statS.textContent = meta.scanned_count || '—';
    if (statP) statP.textContent = meta.published_count || '—';
    if (statM) statM.textContent = meta.run_mode || '—';
}

function renderDtTable(results, data) {
    var tbody = document.getElementById('dtScreenerTableBody');
    if (!tbody) return;

    // Apply filter
    var filtered = applyScreenerUiFilters('daytrade', results || []);
    if (_dtScreenerFilter && _dtScreenerFilter !== 'all') {
        if (_dtScreenerFilter === 'WATCH') {
            filtered = filtered.filter(function(r) {
                return isDayTradeWatchStatus(r.status);
            });
        } else {
            filtered = filtered.filter(function(r) { return r.status === _dtScreenerFilter; });
        }
    }

    if (filtered.length === 0) {
        tbody.innerHTML = screenerEmptyRowHtml(22, getDayTradeEmptyMessage(data));
        return;
    }

    var html = '';
    for (var i = 0; i < filtered.length; i++) {
        var r = filtered[i];
        var statusClass = getDtStatusClass(r.status);
        var chgClass = r.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400';
        var volRatioStr = r.volume_ratio_20d != null ? r.volume_ratio_20d.toFixed(1) + 'x' : '—';
        var txStr = r.value_today ? formatTxValue(r.value_today) : '—';
        var entryStr = r.entry_low && r.entry_high ? r.entry_low.toLocaleString('id-ID') + '–' + r.entry_high.toLocaleString('id-ID') : '—';
        var rrStr = r.risk_reward != null ? r.risk_reward.toFixed(2) : '—';
        // V3: Confidence/Timing/Direction labels (from API or derive client-side)
        var confLabel = r.confidence || '-';
        var timingLabel = r.entry_timing || '-';
        var dirLabel = r.direction || '-';
        var confColor = confLabel === 'A+' ? 'text-emerald-300 font-bold' : (confLabel === 'A' ? 'text-emerald-400' : (confLabel === 'B' ? 'text-blue-400' : (confLabel === 'C' ? 'text-gray-400' : 'text-red-400')));
        var dirColor = dirLabel.indexOf('naik kuat') >= 0 ? 'text-emerald-400' : (dirLabel.indexOf('naik moderat') >= 0 ? 'text-blue-400' : (dirLabel.indexOf('radar') >= 0 ? 'text-violet-400' : (dirLabel.indexOf('Rawan') >= 0 ? 'text-orange-400' : 'text-red-400')));

        html += '<tr class="border-b border-dark-600/20 hover:bg-dark-700/30 transition">';
        html += '<td class="px-2 py-2 text-gray-500 sticky left-0 bg-dark-800/90 z-10">' + (i + 1) + '</td>';
        html += '<td class="px-2 py-2 font-medium text-white">' + r.ticker + '<div class="mt-0.5">' + freshnessChipHtml(r) + '</div></td>';
        html += '<td class="px-2 py-2 text-gray-400 text-[10px]">' + (r.board || '—') + '</td>';
        html += '<td class="px-2 py-2 text-center"><span class="px-1.5 py-0.5 rounded text-[10px] font-semibold ' + statusClass + '">' + escapeHtml(getStatusLabel(r, formatDtStatus(r.status))) + '</span></td>';
        html += '<td class="px-2 py-2 text-center font-bold ' + getDtScoreClass(r.daytrade_score) + '">' + r.daytrade_score + '</td>';
        html += '<td class="px-2 py-2 text-center ' + confColor + ' text-[10px]" title="' + escapeHtml((r.confidence_label || '') + ' — ' + (r.confidence_notes || '')) + '">' + confLabel + '</td>';
        html += '<td class="px-2 py-2 text-gray-300 text-[10px] max-w-[100px] truncate" title="' + (r.setup || '') + '">' + (r.setup || '—') + '</td>';
        html += '<td class="px-2 py-2 text-right text-gray-200">' + (r.last_price ? r.last_price.toLocaleString('id-ID') : '—') + '</td>';
        html += '<td class="px-2 py-2 text-right ' + chgClass + '">' + (r.change_pct != null ? r.change_pct.toFixed(2) + '%' : '—') + '</td>';
        html += '<td class="px-2 py-2 text-right text-gray-300">' + volRatioStr + '</td>';
        html += '<td class="px-2 py-2 text-right text-gray-300">' + txStr + '</td>';
        html += '<td class="px-2 py-2 text-right text-cyan-400">' + (r.prespike_score || 0) + '</td>';
        html += '<td class="px-2 py-2 text-right text-violet-400">' + (r.momentum_score || 0) + '</td>';
        html += '<td class="px-2 py-2 text-right text-gray-200 text-[10px]">' + entryStr + '</td>';
        html += '<td class="px-2 py-2 text-right text-red-400">' + (r.stop_loss ? r.stop_loss.toLocaleString('id-ID') : '—') + '</td>';
        html += '<td class="px-2 py-2 text-right text-emerald-400">' + (r.tp1 ? r.tp1.toLocaleString('id-ID') : '—') + '</td>';
        html += '<td class="px-2 py-2 text-right text-emerald-300">' + (r.tp2 ? r.tp2.toLocaleString('id-ID') : '—') + '</td>';
        html += '<td class="px-2 py-2 text-right font-medium ' + (r.risk_reward >= 2.0 ? 'text-emerald-400' : r.risk_reward >= 1.5 ? 'text-yellow-400' : 'text-red-400') + '">' + rrStr + '</td>';
        html += '<td class="px-2 py-2 text-gray-400 text-[10px] whitespace-nowrap" title="ENTRY WINDOW: ' + escapeHtml((r.entry_window_notes || '') + ' Liq: ' + (r.liquidity_label || '-') + '. ' + (r.liquidity_notes || '') + ' ' + (r.stale_notes || '')) + '">' + escapeHtml((r.entry_window_label || timingLabel || '-')) + '</td>';
        html += '<td class="px-2 py-2 ' + dirColor + ' text-[10px] whitespace-nowrap">' + dirLabel + '</td>';
        html += '<td class="px-2 py-2 text-gray-400 text-[10px] max-w-[120px] truncate" title="' + (r.time_plan || '') + '">' + (r.time_plan || '—') + '</td>';
        var _dtReason = getSignalReason(r);
        html += '<td class="px-2 py-2 text-gray-400 text-[10px] max-w-[120px] truncate" title="' + escapeHtml(_dtReason) + '">' + escapeHtml(_dtReason || '—') + '</td>';
        html += '</tr>';
    }
    tbody.innerHTML = html;
}

function filterDtScreener(filter) {
    _dtScreenerFilter = filter;
    document.querySelectorAll('.dt-screener-tab').forEach(function(btn) {
        if (btn.getAttribute('data-filter') === filter) {
            btn.className = 'dt-screener-tab active px-3 py-1.5 rounded-lg text-xs font-medium transition';
        } else {
            btn.className = 'dt-screener-tab px-3 py-1.5 rounded-lg text-xs font-medium transition';
        }
    });
    if (_dtScreenerCache && _dtScreenerCache.results) {
        renderDtTable(_dtScreenerCache.results, _dtScreenerCache);
        renderDtCardGrid(_dtScreenerCache.results, _dtScreenerCache);
    }
}

function getDtStatusClass(status) {
    switch (status) {
        case 'A_PLUS_SETUP': return 'bg-emerald-500/30 text-emerald-300 border border-emerald-400/40';
        case 'TRADE_CANDIDATE': return 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
        case 'READY_BREAKOUT': return 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25';
        case 'EARLY_RADAR': return 'bg-violet-500/20 text-violet-400 border border-violet-500/30';
        case 'PRE_SPIKE_WATCH': return 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30';
        case 'WAIT_PULLBACK': return 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30';
        case 'RECLAIM_CANDIDATE': return 'bg-blue-500/20 text-blue-400 border border-blue-500/30';
        case 'MOMENTUM_CONTINUATION': return 'bg-violet-500/20 text-violet-400 border border-violet-500/30';
        case 'SPECULATIVE': return 'bg-orange-500/20 text-orange-400 border border-orange-500/30';
        case 'AVOID': return 'bg-red-500/20 text-red-400 border border-red-500/30';
        default: return 'bg-gray-500/20 text-gray-400 border border-gray-500/30';
    }
}

function formatDtStatus(status) {
    switch (status) {
        case 'A_PLUS_SETUP': return 'A+ SETUP';
        case 'TRADE_CANDIDATE': return 'TRADE';
        case 'READY_BREAKOUT': return 'READY';
        case 'EARLY_RADAR': return 'RADAR';
        case 'PRE_SPIKE_WATCH': return 'PRE-SPIKE';
        case 'WAIT_PULLBACK': return 'WAIT';
        case 'RECLAIM_CANDIDATE': return 'RECLAIM';
        case 'MOMENTUM_CONTINUATION': return 'MOMENTUM';
        case 'SPECULATIVE': return 'SPEC';
        case 'AVOID': return 'AVOID';
        default: return status;
    }
}

function getDtScoreClass(score) {
    if (score >= 85) return 'text-emerald-400';
    if (score >= 75) return 'text-cyan-400';
    if (score >= 65) return 'text-yellow-400';
    return 'text-gray-400';
}

function formatTxValue(val) {
    if (!val || val === 0) return '—';
    if (val >= 1e12) return (val / 1e12).toFixed(1) + 'T';
    if (val >= 1e9) return (val / 1e9).toFixed(1) + 'B';
    if (val >= 1e6) return (val / 1e6).toFixed(0) + 'M';
    return val.toLocaleString('id-ID');
}

// ===== DAY TRADE SCREENER PDF (jsPDF autoTable) =====
function exportDayTradePDF() {
    var tbody = document.getElementById('dtScreenerTableBody');
    if (!tbody || !tbody.querySelector('tr td:not([colspan])')) {
        showToast('Belum ada data Day Trade untuk di-export.', 'warning');
        return;
    }
    _ensureJsPdf(function() {
        var jsPDF = window.jspdf.jsPDF;
        var doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        var startY = _pdfAddHeader(doc, 'Auto-Cuan Day Trade Screener', 'landscape');

        // Meta line
        var metaBadge = (document.getElementById('dtMetaBadge') || {}).textContent || '';
        doc.setFontSize(7);
        doc.setTextColor(80, 80, 80);
        var metaText = metaBadge ? metaBadge : '';
        if (_dtScreenerFilter && _dtScreenerFilter !== 'all') metaText += (metaText ? '  |  ' : '') + 'Filter: ' + _dtScreenerFilter;
        if (metaText) { doc.text(metaText, 5, startY); startY += 4; }

        // Extract table data from DOM
        var heads = [['#', 'Ticker', 'Board', 'Status', 'Setup Score', 'Setup', 'Last', 'Chg%', 'Vol/Avg', 'Tx', 'PreSpk', 'Mom', 'Entry', 'SL', 'TP1', 'TP2', 'RR', 'Time Plan', 'Catatan']];
        var body = [];
        var rows = document.querySelectorAll('#dtScreenerTableBody tr');
        rows.forEach(function(row) {
            var cells = row.querySelectorAll('td');
            if (cells.length < 17) return;
            var rowData = [];
            for (var ci = 0; ci < cells.length; ci++) {
                rowData.push((cells[ci].textContent || '').trim());
            }
            body.push(rowData);
        });

        doc.autoTable({
            startY: startY,
            head: heads,
            body: body,
            theme: 'grid',
            margin: { left: 3, right: 3 },
            styles: { fontSize: 5, cellPadding: 0.8, lineColor: [40, 50, 60], lineWidth: 0.1, textColor: [50, 50, 50], overflow: 'linebreak' },
            headStyles: { fillColor: [20, 30, 40], textColor: [180, 200, 210], fontSize: 5.5, fontStyle: 'bold', cellPadding: 1 },
            columnStyles: { 0: { cellWidth: 5 }, 5: { cellWidth: 22 }, 17: { cellWidth: 25 }, 18: { cellWidth: 25 } },
            didParseCell: function(data) {
                if (data.column.index === 3 && data.section === 'body') {
                    var val = (data.cell.raw || '').toUpperCase();
                    if (val.indexOf('READY') >= 0) data.cell.styles.textColor = [16, 185, 129];
                    else if (val.indexOf('PRE') >= 0 || val.indexOf('SPIKE') >= 0) data.cell.styles.textColor = [6, 182, 212];
                    else if (val.indexOf('WAIT') >= 0 || val.indexOf('MOMENTUM') >= 0) data.cell.styles.textColor = [245, 158, 11];
                    else if (val.indexOf('AVOID') >= 0) data.cell.styles.textColor = [239, 68, 68];
                    else data.cell.styles.textColor = [107, 114, 128];
                }
            }
        });

        _pdfAddFooter(doc, 'landscape');
        doc.save('Auto-Cuan-Day-Trade-Screener.pdf');
        showToast('PDF berhasil diunduh.', 'success');
    });
}
