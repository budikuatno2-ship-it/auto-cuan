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
// News/katalis items come from a server/AI-summarized feed, not a fixed
// constant. escapeHtml() only entity-encodes text — it does not stop a
// javascript:/vbscript:/data: URL scheme from executing when the browser
// parses the resulting href attribute. Unlike the sanitizeAIHtml() sink
// (index.html), this one never routed through the URL-scheme hardening in
// ui-bugfix-pack-v1.js, so it needs its own scheme check.
function isSafeHttpUrl(value) {
    try {
        var parsed = new URL(String(value), window.location.href);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

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
            if (n.url && isSafeHttpUrl(n.url)) html += '<a href="' + escapeHtml(n.url) + '" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-[10px] text-blue-400 hover:underline mt-1"><svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>Buka Sumber</a>';
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

// Chart colours from the redesign v2 theme tokens, read from the chart's own
// container so light and dark follow the page. The old fixed dark values are
// the fallback when a token is not defined there.
function acChartTheme(el) {
    var cs = (typeof getComputedStyle === 'function' && el) ? getComputedStyle(el) : null;
    function t(name, fallback) { var v = cs ? String(cs.getPropertyValue(name) || '').trim() : ''; return v || fallback; }
    return {
        bg: t('--ac-surface', '#0f1319'),
        panel: t('--ac-surface', '#0b0e14'),
        text: t('--ac-2', '#9ca3af'),
        grid: t('--ac-hair', '#1c233320'),
        border: t('--ac-hair', '#1c2333'),
        up: t('--ac-pos', '#10b981'),
        down: t('--ac-neg', '#ef4444'),
        vol: t('--ac-ctl', '#242d3d'),
        font: t('--ac-font-mono', '')
    };
}
function acChartAlpha(color, hexAlpha) {
    return /^#[0-9a-f]{6}$/i.test(color) ? color + hexAlpha : color;
}
function acChartLayout(th) {
    var layout = { background: { color: th.bg }, textColor: th.text };
    if (th.font) layout.fontFamily = th.font;
    return layout;
}
// A theme switch repaints every live chart in place (no reload).
if (typeof window !== 'undefined' && !window.__acChartThemeHook) {
    window.__acChartThemeHook = true;
    window.addEventListener('ac-theme', function() {
        Object.keys(_chartRegistry).forEach(function(id) {
            var e = _chartRegistry[id];
            var th = acChartTheme(document.getElementById(id + '_container'));
            [e.mainChart, e.rsiChart, e.intensityChart, e.rotationChart].forEach(function(ch) {
                if (!ch) return;
                try { ch.applyOptions({ layout: acChartLayout(th), grid: { vertLines: { color: th.grid }, horzLines: { color: th.grid } }, rightPriceScale: { borderColor: th.border }, timeScale: { borderColor: th.border } }); } catch (x) {}
            });
            if (e.candleSeries) {
                try { e.candleSeries.applyOptions({ upColor: th.up, downColor: th.down, borderUpColor: th.up, borderDownColor: th.down, wickUpColor: th.up, wickDownColor: th.down }); } catch (x) {}
            }
            if (e.lastLine) { try { e.lastLine.applyOptions({ color: e.lastUp ? th.up : th.down }); } catch (x) {} }
        });
    });
}

// Dispose a chart + its observers and drop it from the registry.
function disposeChart(chartId) {
    var e = _chartRegistry[chartId];
    if (!e) return;
    try { if (e.observers) e.observers.forEach(function(o) { if (o && o.disconnect) o.disconnect(); }); } catch (x) {}
    try { if (e.mainChart && e.mainChart.remove) e.mainChart.remove(); } catch (x) {}
    try { if (e.rsiChart && e.rsiChart.remove) e.rsiChart.remove(); } catch (x) {}
    try { if (e.intensityChart && e.intensityChart.remove) e.intensityChart.remove(); } catch (x) {}
    try { if (e.rotationChart && e.rotationChart.remove) e.rotationChart.remove(); } catch (x) {}
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

// HANDOFF 5a "Harga selalu terbaca". Level titles carry no "Rp" (the axis tag
// already shows the price) and shorten on phones: T1, T2, En.
var AC_SHORT_TAGS = { 'Entry': 'En', 'TP1': 'T1', 'TP2': 'T2', 'Resistance': 'R', 'Support': 'S' };
function acLevelTitle(name, narrow) { return narrow && AC_SHORT_TAGS[name] ? AC_SHORT_TAGS[name] : name; }
// Last-price tag: green when the close is up on the previous close, red when
// down, with the % change as the line title and a dashed line across the chart.
function acLastPrice(candles) {
    var n = candles ? candles.length : 0;
    if (!n) return null;
    var last = Number(candles[n - 1].close), prev = n > 1 ? Number(candles[n - 2].close) : null;
    if (!(last > 0)) return null;
    var chg = prev > 0 ? (last - prev) / prev * 100 : null;
    return { price: last, up: chg == null || chg >= 0, title: chg == null ? '' : (chg >= 0 ? '+' : '−') + Math.abs(chg).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%' };
}
// Highest and lowest bar in the visible range, as indices into candles.
function acVisibleHiLo(candles, from, to) {
    var a = Math.max(0, Math.ceil(from)), b = Math.min(candles.length - 1, Math.floor(to));
    if (b - a < 9) return null;
    var hi = a, lo = a;
    for (var i = a + 1; i <= b; i++) {
        if (Number(candles[i].high) > Number(candles[hi].high)) hi = i;
        if (Number(candles[i].low) < Number(candles[lo].low)) lo = i;
    }
    return { hi: hi, lo: lo };
}
// High and low labels over the chart, placed once per frame when the
// visible range or the price scale moves. No layout reads in the handlers.
function acAttachHiLo(chart, series, candles, container, fmt) {
    var mk = function(cls) {
        var d = document.createElement('div');
        d.className = 'ac-hilo ' + cls;
        d.style.cssText = 'position:absolute;left:0;top:0;z-index:5;pointer-events:none;white-space:nowrap;font:600 11px var(--ac-font-mono, ui-monospace, monospace);color:var(--ac-2, #9ca3af);display:none;';
        container.appendChild(d);
        return d;
    };
    var hiEl = mk('hi'), loEl = mk('lo'), raf = 0;
    var put = function(el, idx, price, text, above) {
        var x = chart.timeScale().logicalToCoordinate(idx), y = series.priceToCoordinate(price);
        var size = typeof chart.paneSize === 'function' ? chart.paneSize() : null;
        var w = size ? size.width : container.clientWidth, h = size ? size.height : container.clientHeight;
        if (x == null || y == null || y < 4 || y > h - 4 || x < 0 || x > w) { el.style.display = 'none'; return; }
        el.textContent = text;
        el.style.display = 'block';
        var shift = x > w - 70 ? '-100%' : (x < 50 ? '0' : '-50%');
        el.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(above ? y - 17 : y + 5) + 'px) translateX(' + shift + ')';
    };
    var place = function() {
        raf = 0;
        var lr = chart.timeScale().getVisibleLogicalRange();
        var hl = lr ? acVisibleHiLo(candles, lr.from, lr.to) : null;
        if (!hl) { hiEl.style.display = 'none'; loEl.style.display = 'none'; return; }
        put(hiEl, hl.hi, Number(candles[hl.hi].high), '▲ ' + fmt(Number(candles[hl.hi].high)), true);
        put(loEl, hl.lo, Number(candles[hl.lo].low), '▼ ' + fmt(Number(candles[hl.lo].low)), false);
    };
    var schedule = function() { if (!raf) raf = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(place); };
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    // Price-scale drags and wheel zoom fire no range event in Lightweight Charts 4.
    container.addEventListener('wheel', schedule, { passive: true });
    container.addEventListener('pointerup', schedule);
    container.addEventListener('pointermove', function(e) { if (e.buttons) schedule(); });
    schedule();
    return { refresh: schedule };
}

// HANDOFF 5a "Kursor" and "Timeframe dan navigasi".
var AC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
function acTimeParts(t) {
    if (t && typeof t === 'object') return { y: t.year, m: t.month, d: t.day };
    if (typeof t === 'number') { var dt = new Date(t * 1000); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; }
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(t || ''));
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}
// Bottom axis: the year shows wherever the year changes ("Jan '26").
function acTickMark(t, type) {
    var p = acTimeParts(t);
    if (!p) return '';
    if (type === 0) return AC_MONTHS[p.m - 1] + " '" + String(p.y).slice(2);
    if (type === 1) return AC_MONTHS[p.m - 1];
    return String(p.d);
}
function acCrosshairDate(t) {
    var p = acTimeParts(t);
    return p ? p.d + ' ' + AC_MONTHS[p.m - 1] + " '" + String(p.y).slice(2) : '';
}
// Default view per chart mode: Scalping 3 months, Investor 1 year, the rest
// 6 months (sessions on 1D, bars on 1W).
function acDefaultBars(mode, weekly) {
    if (mode === 'scalping') return weekly ? 13 : 63;
    if (mode === 'investor') return weekly ? 52 : 250;
    return weekly ? 26 : 126;
}
// Candle under the crosshair: the logical index when it matches, else by date.
function acCandleIndex(candles, param, byDate) {
    if (!param || param.time == null) return -1;
    var i = param.logical != null ? Math.round(param.logical) : -1;
    var p = acTimeParts(param.time), key = p ? p.y + '-' + p.m + '-' + p.d : '';
    if (i >= 0 && i < candles.length) {
        var q = acTimeParts(candles[i].time);
        if (q && q.y + '-' + q.m + '-' + q.d === key) return i;
    }
    return byDate && key in byDate ? byDate[key] : -1;
}
function acDateIndex(candles) {
    var map = {};
    for (var i = 0; i < candles.length; i++) { var p = acTimeParts(candles[i].time); if (p) map[p.y + '-' + p.m + '-' + p.d] = i; }
    return map;
}
// Info box next to the cursor: date, open, high, low, close, change, volume.
// It moves by transform once per frame and switches side near the right edge;
// its contents change only when the bar under the cursor changes.
function acAttachCursorBox(chart, candles, container, fmt, volFmt, byDate) {
    var box = document.createElement('div');
    box.className = 'ac-xtip';
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:absolute;left:0;top:0;z-index:13;pointer-events:none;display:none;will-change:transform;box-sizing:border-box;padding:7px 10px;gap:3px;border-radius:8px;background:var(--ac-surface, #0f1319);border:1px solid var(--ac-hair, #1c2333);box-shadow:0 10px 24px -14px rgba(14,23,20,.45);font:500 12px var(--ac-font, system-ui, sans-serif);color:var(--ac-2, #9ca3af);';
    container.appendChild(box);
    var pending = null, raf = 0, shown = -1, tipW = 178, tipH = 0, paneW = 0, paneH = 0;
    var measure = function() {
        var size = typeof chart.paneSize === 'function' ? chart.paneSize() : null;
        paneW = size ? size.width : container.clientWidth;
        paneH = size ? size.height : container.clientHeight;
        tipW = paneW < 520 ? 150 : 178;
        box.style.width = tipW + 'px';
    };
    var row = function(k, v, col) { return '<div style="display:flex;justify-content:space-between;gap:10px"><span>' + k + '</span><b style="font-family:var(--ac-font-mono, ui-monospace, monospace);font-weight:700;color:' + (col || 'var(--ac-ink, #e5e7eb)') + '">' + v + '</b></div>'; };
    var content = function(i) {
        var c = candles[i], prev = i > 0 ? Number(candles[i - 1].close) : null, close = Number(c.close);
        var chg = prev > 0 ? (close - prev) / prev * 100 : null;
        var col = chg == null ? '' : (chg >= 0 ? 'var(--ac-pos, #10b981)' : 'var(--ac-neg, #ef4444)');
        var p = acTimeParts(c.time);
        var rows = ['<div style="font-weight:700;color:var(--ac-ink, #e5e7eb)">' + (p ? p.d + ' ' + AC_MONTHS[p.m - 1] + ' ' + p.y : '') + '</div>',
            row('Buka', fmt(c.open)), row('Tertinggi', fmt(c.high)), row('Terendah', fmt(c.low)), row('Tutup', fmt(close), col),
            row('Perubahan', chg == null ? '—' : (chg >= 0 ? '+' : '−') + Math.abs(chg).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%', col),
            row('Volume', c.volume > 0 ? volFmt(Number(c.volume)) : '—')];
        tipH = rows.length * 18 + 16;
        return rows.join('');
    };
    var draw = function() {
        raf = 0;
        var q = pending;
        if (!q || !q.point || q.idx < 0) { box.style.display = 'none'; shown = -1; return; }
        if (!paneW) measure();
        if (q.idx !== shown) { box.innerHTML = content(q.idx); shown = q.idx; box.style.display = 'grid'; }
        var tx = q.point.x + 16 + tipW < paneW ? q.point.x + 16 : q.point.x - 16 - tipW;
        var ty = Math.max(4, Math.min(paneH - tipH - 4, q.point.y + 14));
        box.style.transform = 'translate3d(' + Math.round(Math.max(0, tx)) + 'px,' + Math.round(ty) + 'px,0)';
    };
    chart.subscribeCrosshairMove(function(param) {
        pending = { point: param && param.point, idx: acCandleIndex(candles, param, byDate) };
        if (!raf) raf = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(draw);
    });
    return { resize: measure };
}
// Wheel zooms time only with Ctrl/Cmd, or in "Satu layar" mode, so plain
// scrolling still scrolls the page. Zoom keeps the bar under the cursor.
function acAttachWheelZoom(chart, container) {
    var rect = null;
    var cacheRect = function() { rect = container.getBoundingClientRect(); };
    container.addEventListener('pointerenter', cacheRect);
    if (typeof window !== 'undefined') window.addEventListener('scroll', function() { rect = null; }, { passive: true });
    container.addEventListener('wheel', function(e) {
        var one = document.documentElement.classList.contains('cw-one-screen-open');
        if (!(e.ctrlKey || e.metaKey || one)) return;
        e.preventDefault();
        var ts = chart.timeScale(), lr = ts.getVisibleLogicalRange();
        if (!lr) return;
        if (!rect) cacheRect();
        var anchor = ts.coordinateToLogical(e.clientX - rect.left);
        if (anchor == null) anchor = lr.to;
        var f = Math.exp(Math.max(-0.5, Math.min(0.5, (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.002)));
        var from = anchor - (anchor - lr.from) * f, to = anchor + (lr.to - anchor) * f;
        if (to - from < 10 && f < 1) return;
        ts.setVisibleLogicalRange({ from: from, to: to });
    }, { passive: false });
    return { invalidate: function() { rect = null; } };
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
    var _th = acChartTheme(container);

    // Main chart: candlestick + MA
    var chart = LightweightCharts.createChart(container, {
        width: container.clientWidth, height: dims.main,
        layout: acChartLayout(_th),
        grid: { vertLines: { color: _th.grid }, horzLines: { color: _th.grid } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        // Indonesian number format on the price axis; stocks trade in whole
        // rupiah, indices keep two decimals.
        localization: { locale: 'id-ID', timeFormatter: acCrosshairDate, priceFormatter: function(p) { return Number(p).toLocaleString('id-ID', /^(IHSG|COMPOSITE|JKSE|LQ45|IDX30)$/i.test(String(ticker || '')) ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 }); } },
        rightPriceScale: { borderColor: _th.border },
        timeScale: { borderColor: _th.border, timeVisible: false, tickMarkFormatter: acTickMark },
        // Touch behavior: horizontal drag pans the chart, vertical finger movement is
        // left to the page so mobile page scrolling is never trapped. Pinch zooms time,
        // a tap pins the crosshair until the next tap. The wheel is handled by
        // acAttachWheelZoom (Ctrl/Cmd + scroll, or plain scroll in "Satu layar").
        handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: false, pinch: true },
        kineticScroll: { touch: true, mouse: false },
        trackingMode: { exitMode: LightweightCharts.TrackingModeExitMode ? LightweightCharts.TrackingModeExitMode.OnNextTap : 1 }
    });
    container.style.touchAction = 'pan-y';
    var _wheel = acAttachWheelZoom(chart, container);

    // Keep every series added to this chart so the price-scale buttons can
    // set one range for all of them (each series otherwise widens autoscale).
    var _allSeries = [];
    ['addLineSeries', 'addHistogramSeries', 'addAreaSeries', 'addBaselineSeries'].forEach(function(fn) {
        if (typeof chart[fn] !== 'function') return;
        var orig = chart[fn].bind(chart);
        chart[fn] = function(opts) { var sr = orig(opts); _allSeries.push({ series: sr, scale: (opts && opts.priceScaleId) || 'right' }); return sr; };
    });

    // Axis steps follow the IDX price fraction (1/2/5/10/25) of the last close;
    // indices keep 0,01.
    var _isIdxTicker = /^(IHSG|COMPOSITE|JKSE|LQ45|IDX30|IDX80|KOMPAS100)$/i.test(String(ticker || ''));
    var _wsTick = window.AutoCuanChartWorkstation;
    var _lastClose = candles && candles.length ? Number(candles[candles.length - 1].close) : 0;
    var _tick = _isIdxTicker ? 0.01 : (_wsTick && typeof _wsTick.getIdxTickSize === 'function' ? _wsTick.getIdxTickSize(_lastClose) : 1);
    var candleSeries = chart.addCandlestickSeries({
        upColor: _th.up, downColor: _th.down,
        borderUpColor: _th.up, borderDownColor: _th.down,
        wickUpColor: _th.up, wickDownColor: _th.down,
        priceFormat: { type: 'price', precision: _isIdxTicker ? 2 : 0, minMove: _tick },
        lastValueVisible: false, priceLineVisible: false
    });
    candleSeries.setData(candles);
    var _narrow = (typeof window !== 'undefined' && window.innerWidth < 520) || container.clientWidth < 520;
    var _lp = acLastPrice(candles), _lastLine = null;
    if (_lp) {
        try { _lastLine = candleSeries.createPriceLine({ price: _lp.price, color: _lp.up ? _th.up : _th.down, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: _narrow ? '' : _lp.title }); } catch (_) {}
    }

    // Volume
    var volumeSeries = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', color: _th.vol });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    var volData = candles.map(function(c) { return { time: c.time, value: c.volume, color: c.close >= c.open ? acChartAlpha(_th.up, '30') : acChartAlpha(_th.down, '30') }; });
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
        return s;
    }

    var ws = (typeof window !== 'undefined' && window.AutoCuanChartWorkstation) ? window.AutoCuanChartWorkstation : null;
    var wsState = (options && options.workstationState) || (ws && ws.getOrCreateInstance ? ws.getOrCreateInstance(chartId, candles, metrics, ticker, options).state : null);

    var showMA20 = wsState ? wsState.isLayerActive('ma20') : true;
    var showMA50 = wsState ? wsState.isLayerActive('ma50') : true;
    var showMA100 = wsState ? wsState.isLayerActive('ma100') : true;
    var showMA200 = wsState ? wsState.isLayerActive('ma200') : true;
    var showEMA20 = wsState ? wsState.isLayerActive('ema20') : false;
    var showEMA50 = wsState ? wsState.isLayerActive('ema50') : false;
    var showBollinger = wsState ? wsState.isLayerActive('bollinger') : false;
    var showTradingPlan = wsState ? wsState.isLayerActive('trading_plan') : false;
    var showFib = wsState ? wsState.isLayerActive('fibonacci') : true;
    var showSR = wsState ? wsState.isLayerActive('sr_levels') : true;

    if (showMA20 && candles.length >= 20) buildMALine(closes, 20, '#10b981');
    if (showMA50 && candles.length >= 50) buildMALine(closes, 50, '#eab308');
    if (showMA100 && candles.length >= 100) buildMALine(closes, 100, '#3b82f6');
    if (showMA200 && candles.length >= 200) buildMALine(closes, 200, '#a855f7');

    if (showEMA20 && ws && candles.length >= 20) {
        var ema20Data = ws.calculateEMA(candles, 20);
        var sEma20 = chart.addLineSeries({ color: '#06b6d4', lineWidth: 1.5, crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false });
        sEma20.setData(ema20Data);
    }
    if (showEMA50 && ws && candles.length >= 50) {
        var ema50Data = ws.calculateEMA(candles, 50);
        var sEma50 = chart.addLineSeries({ color: '#ec4899', lineWidth: 1.5, crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false });
        sEma50.setData(ema50Data);
    }
    if (showBollinger && ws && candles.length >= 20) {
        var bb = ws.calculateBollinger(candles, 20, 2);
        var sBbUpper = chart.addLineSeries({ color: '#6366f1', lineWidth: 1, lineStyle: 2, crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false });
        var sBbLower = chart.addLineSeries({ color: '#6366f1', lineWidth: 1, lineStyle: 2, crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false });
        sBbUpper.setData(bb.upper);
        sBbLower.setData(bb.lower);
    }

    var showLPM = wsState ? wsState.isLayerActive('bandar_lpm') : false;
    var showForeign = wsState ? wsState.isLayerActive('bandar_foreign') : false;
    var showCMF = wsState ? wsState.isLayerActive('bandar_cmf') : false;
    var showIntensity = wsState ? wsState.isLayerActive('bandar_intensity') : false;
    var showRotation = wsState ? wsState.isLayerActive('bandar_rotation') : false;
    // Indices have no plan, no signal markers and no broker summary (HANDOFF 5a).
    var _isIndexChart = ws && typeof ws.isIndexTicker === 'function' ? ws.isIndexTicker(ticker) : /^IHSG$/i.test(String(ticker || ''));
    if (_isIndexChart) { showTradingPlan = false; showLPM = false; showForeign = false; showCMF = false; showIntensity = false; showRotation = false; }

    // Render Bandar Metrics Curves on Main Chart Canvas
    if (showLPM && ws && candles.length >= 5) {
        var lpmData = ws.calculateLPMSeries(candles);
        var sLpm = chart.addLineSeries({
            color: '#10b981',
            lineWidth: 2,
            priceScaleId: 'right', // Overlay directly on candlestick price scale
            crosshairMarkerVisible: false,
            priceLineVisible: false,
            lastValueVisible: true,
            title: 'LPM',
            priceFormat: {
                type: 'custom',
                formatter: function(price) {
                    if (!price && price !== 0) return '';
                    return 'Rp ' + Math.round(price).toLocaleString('id-ID');
                }
            }
        });
        sLpm.setData(lpmData);
    }

    if (showForeign && ws && candles.length >= 5) {
        var foreignData = ws.calculateForeignFlowCumulative(candles);
        var sForeign = chart.addLineSeries({
            color: '#3b82f6',
            lineWidth: 2,
            priceScaleId: 'foreign_scale',
            crosshairMarkerVisible: false,
            priceLineVisible: false,
            lastValueVisible: true,
            title: 'Foreign Flow',
            priceFormat: {
                type: 'custom',
                formatter: function(price) {
                    if (!price && price !== 0) return '';
                    var abs = Math.abs(price);
                    var sign = price < 0 ? '-' : '';
                    if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2).replace('.', ',') + ' T';
                    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(1).replace('.', ',') + ' Mrd';
                    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1).replace('.', ',') + ' Jt';
                    return sign + Math.round(abs).toLocaleString('id-ID');
                }
            }
        });
        chart.priceScale('foreign_scale').applyOptions({
            visible: false,
            scaleMargins: { top: 0.28, bottom: 0.15 }
        });
        sForeign.setData(foreignData);
    }

    if (showCMF && ws && candles.length >= 5) {
        var cmfData = ws.calculateCMF(candles, 20);
        var sCmf = chart.addLineSeries({
            color: '#f97316',
            lineWidth: 2,
            priceScaleId: 'cmf_scale',
            crosshairMarkerVisible: false,
            priceLineVisible: false,
            lastValueVisible: true,
            title: 'Money Flow',
            priceFormat: {
                type: 'custom',
                formatter: function(price) {
                    if (!price && price !== 0) return '';
                    return (price >= 0 ? '+' : '') + price.toFixed(2);
                }
            }
        });
        chart.priceScale('cmf_scale').applyOptions({
            visible: false,
            scaleMargins: { top: 0.38, bottom: 0.05 }
        });
        sCmf.setData(cmfData);
    }

    var activeMode = (wsState && wsState.activePreset) ? wsState.activePreset : 'swing';
    var activeTf = (wsState && wsState.timeframe) ? wsState.timeframe : '1D';
    var plan = null;
    // Plan levels come from the server only (HANDOFF 5a): a plan handed over by
    // the screener (customTradingPlan) is drawn here; otherwise the selected
    // horizon's server levels are drawn by analisis-v2.js. No plan is derived
    // from the candles in the browser any more.
    var customPlan = options && options.customTradingPlan ? options.customTradingPlan : (wsState ? wsState.customTradingPlan : null);
    if (showTradingPlan && ws && customPlan && customPlan.entry && customPlan.sl) {
        plan = ws.calculateTradingPlan(candles, customPlan, activeMode, activeTf);
        if (plan) {
            candleSeries.createPriceLine({ price: plan.entry, color: '#38bdf8', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: acLevelTitle('Entry', _narrow) });
            candleSeries.createPriceLine({ price: plan.sl, color: '#ef4444', lineWidth: 1.5, lineStyle: 2, axisLabelVisible: true, title: 'SL' });
            candleSeries.createPriceLine({ price: plan.tp1, color: '#10b981', lineWidth: 1.5, lineStyle: 2, axisLabelVisible: true, title: acLevelTitle('TP1', _narrow) });
            candleSeries.createPriceLine({ price: plan.tp2, color: '#059669', lineWidth: 1.5, lineStyle: 2, axisLabelVisible: true, title: acLevelTitle('TP2', _narrow) });
        }
    }

    var btRes = (ws && typeof ws.calculateHistoricalBacktest === 'function')
        ? ws.calculateHistoricalBacktest(candles, ticker, activeMode, activeTf)
        : null;

    if (showSR && candles.length >= 10) {
        var pivots = (ws && typeof ws.calculateSwingPivots === 'function')
            ? ws.calculateSwingPivots(candles, 30)
            : null;
        var resPrice = pivots && pivots.resistance ? pivots.resistance : null;
        var supPrice = pivots && pivots.support ? pivots.support : null;

        if (!resPrice || !supPrice) {
            var recentHigh = -Infinity, recentLow = Infinity;
            var lookback = Math.min(30, candles.length);
            for (var si = candles.length - lookback; si < candles.length; si++) {
                if (candles[si].high > recentHigh) recentHigh = candles[si].high;
                if (candles[si].low < recentLow) recentLow = candles[si].low;
            }
            if (!resPrice && recentHigh > 0 && isFinite(recentHigh)) resPrice = recentHigh;
            if (!supPrice && recentLow > 0 && isFinite(recentLow)) supPrice = recentLow;
        }

        if (resPrice > 0 && isFinite(resPrice)) {
            candleSeries.createPriceLine({ price: resPrice, color: '#3b82f6', lineWidth: 1.5, lineStyle: 3, axisLabelVisible: true, title: acLevelTitle('Resistance', _narrow) });
        }
        if (supPrice > 0 && isFinite(supPrice)) {
            candleSeries.createPriceLine({ price: supPrice, color: '#10b981', lineWidth: 1.5, lineStyle: 3, axisLabelVisible: true, title: acLevelTitle('Support', _narrow) });
        }
    }

    // Break of Structure (BOS) Layer Rendering
    var showBOS = wsState ? wsState.isLayerActive('market_structure') : false;
    if (showBOS && ws && typeof ws.calculateBOS === 'function') {
        var bosData = ws.calculateBOS(candles);
        if (bosData && Array.isArray(bosData.lines)) {
            for (var bi = 0; bi < bosData.lines.length; bi++) {
                var bl = bosData.lines[bi];
                candleSeries.createPriceLine({
                    price: bl.price,
                    color: bl.color,
                    lineWidth: 1.5,
                    lineStyle: 1, // Dotted line
                    axisLabelVisible: true,
                    title: bl.title
                });
            }
        }
    }

    // Volume Profile (POC / VAH / VAL) Layer Rendering
    var showVolProfile = wsState ? wsState.isLayerActive('vol_profile') : false;
    if (showVolProfile && ws && typeof ws.calculateVolumeProfile === 'function') {
        var vp = ws.calculateVolumeProfile(candles, 12);
        if (vp) {
            candleSeries.createPriceLine({ price: vp.poc, color: '#f59e0b', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: 'VP POC' });
            candleSeries.createPriceLine({ price: vp.vah, color: '#38bdf8', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'VAH 70%' });
            candleSeries.createPriceLine({ price: vp.val, color: '#818cf8', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'VAL 70%' });
        }
    }

    // Floating Canvas Header Overlay
    container.style.position = 'relative';
    var headerEl = document.getElementById(chartId + '_canvas_header');
    if (!headerEl) {
        headerEl = document.createElement('div');
        headerEl.id = chartId + '_canvas_header';
        headerEl.className = 'chart-canvas-floating-header';
        headerEl.style.cssText = 'position:absolute; top:8px; left:10px; z-index:12; pointer-events:none; font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; line-height:1.45; text-shadow:0 1px 3px rgba(0,0,0,0.9);';
        container.appendChild(headerEl);
    }

    // Values that do not depend on the hovered bar, computed once per render.
    var _hdrMemo = null;
    function headerMemo() {
        if (_hdrMemo) return _hdrMemo;
        _hdrMemo = {
            corr: ws && !_isIndexChart ? ws.calculateCorrF(candles) : null,
            par: ws && !_isIndexChart ? ws.calculateParF(candles) : null,
            lpm: ws ? ws.calculateLPM(candles) : null,
            fData: ws ? ws.calculateForeignFlowCumulative(candles, options && options.foreignFlow) : null,
            moneyFlow: ws ? ws.getLatestMoneyFlow(candles) : '0.000'
        };
        return _hdrMemo;
    }
    var _hdrShown = null, _hdrMobile = null;
    function updateCanvasHeader(c) {
        if (!c || !headerEl) return;
        var _mob = (typeof window !== 'undefined' && window.innerWidth <= 640) || (container.clientWidth <= 640);
        if (c === _hdrShown && _mob === _hdrMobile) return;
        _hdrShown = c; _hdrMobile = _mob;
        var _m = headerMemo();
        var cOpen = Number(c.open != null ? c.open : c.close);
        var cHigh = Number(c.high != null ? c.high : c.close);
        var cLow = Number(c.low != null ? c.low : c.close);
        var cClose = Number(c.close);
        var cVol = Number(c.volume || 0);

        var prevClose = cOpen;
        var candleIdx = candles.indexOf(c);
        if (candleIdx > 0) prevClose = Number(candles[candleIdx - 1].close);
        else if (candles.length > 1) prevClose = Number(candles[candles.length - 2].close);

        var chg = cClose - prevClose;
        var chgPct = prevClose > 0 ? (chg / prevClose) * 100 : 0;
        var chgSign = chg >= 0 ? '+' : '';
        var chgColor = chg >= 0 ? '#34d399' : '#f87171';

        // No workstation module, no Corr F / Par F (the old fallback printed 0.72 and 34.2).
        var corrVal = _m.corr;
        var parVal = _m.par;
        var corrTxt = (corrVal == null || !isFinite(corrVal)) ? '—' : ((corrVal >= 0 ? '+' : '') + corrVal.toFixed(2));
        var parTxt = (parVal == null || !isFinite(parVal)) ? '—' : (parVal.toFixed(1) + '%');
        var lpmVal = _m.lpm;
        var tf = (wsState && wsState.timeframe) ? wsState.timeframe : '1D';

        var volStr = ws ? ws.formatIndonesianVolumeCompact(cVol) : (cVol.toLocaleString('id-ID') + ' lembar');
        var foreignNet = ws ? ws.getLatestForeignNet([c], options && options.foreignFlow) : 0;
        if (foreignNet === 0 && ws) {
            var fData = _m.fData;
            if (fData && fData.length > 0) {
                var hoveredFd = fData.find(function(fd) { return fd.time === c.time; });
                var targetFd = hoveredFd || fData[fData.length - 1];
                if (targetFd && targetFd.value != null && targetFd.value !== 0) {
                    foreignNet = targetFd.value;
                }
            }
        }
        var foreignStr = ws ? ws.formatIndonesianRupiahCompact(foreignNet) : 'Rp 0';
        var moneyFlowStr = _m.moneyFlow;

        var isMobile = _mob;
        if (isMobile) {
            headerEl.style.fontSize = '10px';
            headerEl.innerHTML =
                '<div class="flex items-center gap-1 text-[10px] font-bold text-slate-100 flex-wrap" style="color:#f8fafc;">' +
                    '<span>' + (ticker || 'SAHAM') + ' · ' + tf + '</span>' +
                    '<span style="color:' + chgColor + '"> ' + cClose.toLocaleString('id-ID') + ' (' + chgSign + chgPct.toFixed(1) + '%)</span>' +
                    '<span class="text-gray-400 font-normal">• Corr F <b style="color:#38bdf8;">' + corrTxt + '</b></span>' +
                '</div>' +
                '<div class="text-[10px] text-gray-300 font-medium">Vol <b style="color:#f1f5f9;">' + volStr + '</b> • Par F <b style="color:#fbbf24;">' + parTxt + '</b></div>' +
                '<div class="text-[10px] font-medium flex items-center gap-1" style="color:#10b981;"><span class="w-1.5 h-1.5 rounded-full inline-block" style="background-color:#10b981;"></span>LPM <b style="color:#34d399;">' + (lpmVal ? lpmVal.toLocaleString('id-ID') : '—') + '</b></div>' +
                '<div class="text-[10px] font-medium flex items-center gap-1" style="color:#3b82f6;"><span class="w-1.5 h-1.5 rounded-full inline-block" style="background-color:#3b82f6;"></span>Foreign <b style="color:#60a5fa;">' + foreignStr + '</b></div>' +
                '<div class="text-[10px] font-medium flex items-center gap-1" style="color:#f97316;"><span class="w-1.5 h-1.5 rounded-full inline-block" style="background-color:#f97316;"></span>CMF <b style="color:#fb923c;">' + moneyFlowStr + '</b></div>';
        } else {
            headerEl.style.fontSize = '12px';
            headerEl.innerHTML =
                '<div class="flex items-center gap-1.5 text-xs font-bold text-slate-100 flex-wrap" style="color:#f8fafc;">' +
                    '<span>' + (ticker || 'SAHAM') + ' · ' + tf + ' · IDX</span>' +
                    '<span class="text-gray-300">O<span style="color:' + (cOpen >= prevClose ? '#34d399' : '#f87171') + '">' + cOpen.toLocaleString('id-ID') + '</span></span>' +
                    '<span class="text-gray-300">H<span style="color:#34d399">' + cHigh.toLocaleString('id-ID') + '</span></span>' +
                    '<span class="text-gray-300">L<span style="color:#f87171">' + cLow.toLocaleString('id-ID') + '</span></span>' +
                    '<span class="text-gray-300">C<span style="color:' + chgColor + '">' + cClose.toLocaleString('id-ID') + '</span></span>' +
                    '<span style="color:' + chgColor + '"> ' + chgSign + chg.toLocaleString('id-ID') + ' (' + chgSign + chgPct.toFixed(2) + '%)</span>' +
                    '<span class="text-gray-400 font-normal">• Corr F <b style="color:#38bdf8;">' + corrTxt + '</b></span>' +
                    '<span class="text-gray-400 font-normal">• Par F <b style="color:#fbbf24;">' + parTxt + '</b></span>' +
                '</div>' +
                '<div class="text-[11px] text-gray-300 font-medium">Volume <b style="color:#f1f5f9;">' + volStr + '</b></div>' +
                '<div class="text-[11px] font-medium flex items-center gap-1" style="color:#10b981;"><span class="w-1.5 h-1.5 rounded-full inline-block" style="background-color:#10b981;"></span>Liquidity Pressure Model (LPM) <b style="color:#34d399;">' + (lpmVal ? lpmVal.toLocaleString('id-ID') : '—') + '</b></div>' +
                '<div class="text-[11px] font-medium flex items-center gap-1" style="color:#3b82f6;"><span class="w-1.5 h-1.5 rounded-full inline-block" style="background-color:#3b82f6;"></span>Foreign Flow <b style="color:#60a5fa;">' + foreignStr + '</b></div>' +
                '<div class="text-[11px] font-medium flex items-center gap-1" style="color:#f97316;"><span class="w-1.5 h-1.5 rounded-full inline-block" style="background-color:#f97316;"></span>Money Flow <b style="color:#fb923c;">' + moneyFlowStr + '</b></div>';
        }
        // Indices carry no broker summary: drop the LPM / foreign / money-flow rows.
        if (_isIndexChart) {
            Array.prototype.slice.call(headerEl.children).forEach(function(row) {
                if (/LPM|Foreign|Money Flow/.test(row.textContent || '')) row.remove();
            });
        }
    }

    if (candles && candles.length) {
        var _lastCandle = candles[candles.length - 1];
        var _byDate = acDateIndex(candles);
        updateCanvasHeader(_lastCandle);
        // Legend follows the hovered bar, written at most once per frame.
        var _hdrNext = _lastCandle, _hdrRaf = 0;
        chart.subscribeCrosshairMove(function(param) {
            var i = acCandleIndex(candles, param, _byDate);
            _hdrNext = i >= 0 ? candles[i] : _lastCandle;
            if (_hdrRaf) return;
            _hdrRaf = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(function() { _hdrRaf = 0; updateCanvasHeader(_hdrNext); });
        });
        var _fmtPx = function(v) { return Number(v).toLocaleString('id-ID', _isIdxTicker ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 }); };
        var _cursorBox = acAttachCursorBox(chart, candles, container, _fmtPx, function(v) { return ws && ws.formatIndonesianVolumeCompact ? String(ws.formatIndonesianVolumeCompact(v)).replace(/ lembar$/, '') : Number(v).toLocaleString('id-ID'); }, _byDate);

        var _onWinResize = function() {
            var reg = _chartRegistry[chartId];
            if (!reg || reg.mainChart !== chart) { window.removeEventListener('resize', _onWinResize); return; }
            if (container) chart.applyOptions({ width: container.clientWidth });
            _hdrShown = null;
            updateCanvasHeader(_lastCandle);
            _cursorBox.resize();
            _wheel.invalidate();
        };
        window.addEventListener('resize', _onWinResize);
    }

    if (ws && typeof ws.attach === 'function') {
        try { ws.attach(chartId, candles, metrics, ticker, options); } catch (_) {}
    }

    // Register the live chart before waiting on the network, so theme repaint,
    // price-scale buttons and overlays can reach it even while the quote below
    // is slow. The full entry is written again at the end.
    _chartRegistry[chartId] = Object.assign(_chartRegistry[chartId] || {}, { chartId: chartId, variant: variant, mainChart: chart, candleSeries: candleSeries, allSeries: _allSeries, ticker: ticker || '', lastClose: candles && candles.length ? candles[candles.length - 1].close : null, dims: dims, observers: _observers });

    // Fibonacci level overlay (from quote API) — uses createPriceLine for direct chart visibility
    var fibQuote = null;
    try {
        var fibTicker = ticker || chartId.replace('ychart_', '').replace(/^\d+$/, '');
        if (fibTicker) {
        // Bounded wait: a slow quote must not hold the rest of the chart.
        var _fibAbort = typeof AbortController === 'function' ? new AbortController() : null;
        var _fibTimer = _fibAbort ? setTimeout(function() { _fibAbort.abort(); }, 5000) : null;
        var fibResp = await fetch('/api/quote?ticker=' + encodeURIComponent(fibTicker), { headers: getAuthHeaders(), signal: _fibAbort ? _fibAbort.signal : undefined }).then(function(r) { return r.json(); }).catch(function() { return null; });
        if (_fibTimer) clearTimeout(_fibTimer);
        fibQuote = (fibResp && fibResp.fibonacci) ? fibResp.fibonacci : null;
        if (fibQuote && fibQuote.levels && candles.length >= 10) {
            // Use createPriceLine on candlestick series for reliable horizontal Fib lines
            var fibPriceLines = [
                { val: fibQuote.levels.fib382, label: 'Fib 38,2', color: '#f59e0b' },
                { val: fibQuote.levels.fib500, label: 'Fib 50', color: '#fbbf24' },
                { val: fibQuote.levels.fib618, label: 'Fib 61,8', color: '#d97706' },
                { val: fibQuote.levels.fib786, label: 'Fib 78,6', color: '#b45309' }
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
    var showSignalMarkers = wsState && !_isIndexChart ? wsState.isLayerActive('signal_markers') : false;
    var markersToApply = [];
    if (showSignalMarkers && btRes && Array.isArray(btRes.markers) && btRes.markers.length > 0) {
        markersToApply = btRes.markers;
    } else if (options && Array.isArray(options.markers) && options.markers.length > 0) {
        markersToApply = options.markers;
    }
    if (typeof candleSeries.setMarkers === 'function') {
        try { candleSeries.setMarkers(markersToApply); } catch (mkErr) { /* optional */ }
    }

    chart.timeScale().fitContent();
    var _mainRO = observeChartResize(container, function(w) {
        var d = chartDims(variant, (typeof window !== 'undefined' ? window.innerWidth : 0), (typeof window !== 'undefined' ? window.innerHeight : 0));
        container.style.height = d.main + 'px';
        chart.applyOptions({ width: w, height: d.main });
        if (typeof updateShadingBox === 'function') updateShadingBox();
        if (_hiLo) _hiLo.refresh();
    });
    if (_mainRO) _observers.push(_mainRO);
    container._chart = chart;

    // SVG Shading Box inside container
    var shadingSvg = document.getElementById(chartId + '_rr_shading_svg');
    if (!shadingSvg) {
        shadingSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        shadingSvg.id = chartId + '_rr_shading_svg';
        shadingSvg.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; pointer-events:none; z-index:4;';
        container.appendChild(shadingSvg);
    }

    function updateShadingBox() {
        if (!showTradingPlan || !plan || !shadingSvg) {
            if (shadingSvg) shadingSvg.innerHTML = '';
            return;
        }
        try {
            var yTp1 = candleSeries.priceToCoordinate(plan.tp1);
            var yEntry = candleSeries.priceToCoordinate(plan.entry);
            var ySl = candleSeries.priceToCoordinate(plan.sl);
            if (yTp1 == null || yEntry == null || ySl == null || isNaN(yTp1) || isNaN(yEntry) || isNaN(ySl)) {
                return;
            }
            var xStart = 50;
            if (candles.length > 25) {
                var cRef = candles[candles.length - 25];
                var coord = chart.timeScale().timeToCoordinate(cRef.time);
                if (coord != null && !isNaN(coord) && coord > 0) xStart = coord;
            }
            var xEnd = container.clientWidth - 55;
            if (xEnd <= xStart) xEnd = container.clientWidth;

            var w = Math.max(10, xEnd - xStart);
            var hProfit = Math.max(2, yEntry - yTp1);
            var hLoss = Math.max(2, ySl - yEntry);

            shadingSvg.innerHTML =
                '<rect x="' + xStart + '" y="' + yTp1 + '" width="' + w + '" height="' + hProfit + '" fill="rgba(16, 185, 129, 0.12)" stroke="rgba(16, 185, 129, 0.45)" stroke-dasharray="4,4" />' +
                '<text x="' + (xStart + 8) + '" y="' + (yTp1 + 14) + '" fill="#34d399" font-size="10" font-weight="600" font-family="sans-serif">Area Profit (+' + plan.tp1Pct.toFixed(1) + '%)</text>' +
                '<rect x="' + xStart + '" y="' + yEntry + '" width="' + w + '" height="' + hLoss + '" fill="rgba(239, 68, 68, 0.12)" stroke="rgba(239, 68, 68, 0.45)" stroke-dasharray="4,4" />' +
                '<text x="' + (xStart + 8) + '" y="' + (ySl - 6) + '" fill="#f87171" font-size="10" font-weight="600" font-family="sans-serif">Area Risiko (' + plan.slPct.toFixed(1) + '%)</text>';
        } catch (_) {}
    }

    setTimeout(updateShadingBox, 150);
    chart.timeScale().subscribeVisibleLogicalRangeChange(updateShadingBox);

    // Subpanels: Intensity & Volume Rotation
    var subpanelsWrapper = document.getElementById(chartId + '_subpanels_wrapper');
    if (!subpanelsWrapper) {
        subpanelsWrapper = document.createElement('div');
        subpanelsWrapper.id = chartId + '_subpanels_wrapper';
        subpanelsWrapper.className = 'chart-subpanels-wrapper space-y-1.5 mt-2';
        container.parentNode.insertBefore(subpanelsWrapper, container.nextSibling);
    }

    var intensityContainer = document.getElementById(chartId + '_intensity_container');
    if (!intensityContainer) {
        intensityContainer = document.createElement('div');
        intensityContainer.id = chartId + '_intensity_container';
        intensityContainer.className = 'relative w-full rounded-lg overflow-hidden border border-dark-700/60 bg-[#0b0e14]';
        intensityContainer.style.height = '65px';
        subpanelsWrapper.appendChild(intensityContainer);
    }

    var rotationContainer = document.getElementById(chartId + '_rotation_container');
    if (!rotationContainer) {
        rotationContainer = document.createElement('div');
        rotationContainer.id = chartId + '_rotation_container';
        rotationContainer.className = 'relative w-full rounded-lg overflow-hidden border border-dark-700/60 bg-[#0b0e14]';
        rotationContainer.style.height = '65px';
        subpanelsWrapper.appendChild(rotationContainer);
    }

    var intensityChart = null;
    var rotationChart = null;
    var rsiChart = null;

    if (showIntensity && ws && candles.length >= 5) {
        intensityContainer.style.display = 'block';
        intensityContainer.innerHTML = '<div style="position:absolute; top:2px; left:8px; z-index:5; font-size:10px; font-weight:700; color:#c084fc; pointer-events:none; text-shadow:0 1px 2px rgba(0,0,0,0.8);">INTENSITY (Aktivitas Bandar)</div>';
        intensityChart = LightweightCharts.createChart(intensityContainer, {
            width: container.clientWidth,
            height: 65,
            layout: acChartLayout(_th),
            grid: { vertLines: { color: _th.grid }, horzLines: { color: _th.grid } },
            rightPriceScale: { borderColor: _th.border, scaleMargins: { top: 0.15, bottom: 0.1 } },
            timeScale: { visible: false },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            handleScroll: { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
            handleScale: { axisPressedMouseMove: false, mouseWheel: false, pinch: false }
        });
        var intSeries = intensityChart.addHistogramSeries({ priceFormat: { type: 'volume' } });
        intSeries.setData(ws.calculateIntensityHistogram(candles));
        intensityChart.timeScale().fitContent();
    } else {
        intensityContainer.style.display = 'none';
    }

    if (showRotation && ws && candles.length >= 5) {
        rotationContainer.style.display = 'block';
        rotationContainer.innerHTML = '<div style="position:absolute; top:2px; left:8px; z-index:5; font-size:10px; font-weight:700; color:#34d399; pointer-events:none; text-shadow:0 1px 2px rgba(0,0,0,0.8);">VOLUME ROTATION (Akumulasi / Distribusi / Transisi)</div>';
        rotationChart = LightweightCharts.createChart(rotationContainer, {
            width: container.clientWidth,
            height: 65,
            layout: acChartLayout(_th),
            grid: { vertLines: { color: _th.grid }, horzLines: { color: _th.grid } },
            rightPriceScale: { borderColor: _th.border, scaleMargins: { top: 0.15, bottom: 0.1 } },
            timeScale: { visible: false },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            handleScroll: { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
            handleScale: { axisPressedMouseMove: false, mouseWheel: false, pinch: false }
        });
        var rotSeries = rotationChart.addHistogramSeries({ priceFormat: { type: 'volume' } });
        rotSeries.setData(ws.calculateVolumeRotation(candles));
        rotationChart.timeScale().fitContent();
    } else {
        rotationContainer.style.display = 'none';
    }

    chart.timeScale().subscribeVisibleLogicalRangeChange(function(range) {
        if (range) {
            if (intensityChart) intensityChart.timeScale().setVisibleLogicalRange(range);
            if (rotationChart) rotationChart.timeScale().setVisibleLogicalRange(range);
            if (rsiChart) rsiChart.timeScale().setVisibleLogicalRange(range);
        }
    });

    // Plan & Backtest Card below subpanels
    var planCardEl = document.getElementById(chartId + '_plan_backtest_card');
    if (!planCardEl) {
        planCardEl = document.createElement('div');
        planCardEl.id = chartId + '_plan_backtest_card';
        planCardEl.className = 'chart-plan-backtest-card mt-3';
        subpanelsWrapper.parentNode.insertBefore(planCardEl, subpanelsWrapper.nextSibling);
    }

    if (showTradingPlan && plan) {
        planCardEl.style.display = 'block';
        planCardEl.innerHTML =
            (!plan.isSafeRR ?
                '<div class="p-3 rounded-xl bg-amber-500/20 border border-amber-500/50 text-amber-300 text-xs font-semibold flex items-center gap-2 mb-3">' +
                    '<svg class="w-4 h-4 text-amber-400 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>' +
                    '<span>STATUS PANTAUAN - R/R Aktual (' + plan.rrRatio.toFixed(2).replace('.', ',') + 'x) di bawah batas minimum keselamatan 1,50x (Tidak Siap Eksekusi)</span>' +
                '</div>' : ''
            ) +
            '<div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">' +
                '<div class="p-3.5 rounded-xl bg-dark-800/80 border border-dark-700/60 space-y-3">' +
                    '<div class="flex items-center justify-between pb-2 border-b border-dark-700/50">' +
                        '<h4 class="font-semibold text-slate-100 flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-sky-400"></span>Kalkulator Simulasi Scale-Out</h4>' +
                        '<span class="text-[11px] font-mono px-2 py-0.5 rounded font-bold ' + (plan.isSafeRR ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30') + '">R/R ' + plan.rrRatio.toFixed(2) + 'x</span>' +
                    '</div>' +
                    '<div class="grid grid-cols-2 gap-2 text-[11px] font-mono">' +
                        '<div class="p-2 rounded bg-dark-900 border border-dark-700/60"><span class="text-gray-400">ENTRY</span><br><b class="text-sky-300">Rp ' + plan.entry.toLocaleString('id-ID') + '</b></div>' +
                        '<div class="p-2 rounded bg-dark-900 border border-dark-700/60"><span class="text-gray-400">STOP LOSS</span><br><b class="text-rose-400">Rp ' + plan.sl.toLocaleString('id-ID') + ' (' + plan.slPct.toFixed(1) + '%)</b></div>' +
                        '<div class="p-2 rounded bg-dark-900 border border-dark-700/60"><span class="text-gray-400">TARGET 1 (50%)</span><br><b class="text-emerald-400">Rp ' + plan.tp1.toLocaleString('id-ID') + ' (+' + plan.tp1Pct.toFixed(1) + '%)</b></div>' +
                        '<div class="p-2 rounded bg-dark-900 border border-dark-700/60"><span class="text-gray-400">TARGET 2 (50%)</span><br><b class="text-emerald-300">Rp ' + plan.tp2.toLocaleString('id-ID') + ' (+' + plan.tp2Pct.toFixed(1) + '%)</b></div>' +
                    '</div>' +
                    '<div class="pt-2 border-t border-dark-700/50 text-[11px] space-y-1">' +
                        '<div class="flex justify-between"><span class="text-gray-400">Estimasi Keuntungan Bersih:</span><b class="text-emerald-400">+Rp ' + plan.scaleOut.netProfit.toLocaleString('id-ID') + '</b></div>' +
                        '<div class="flex justify-between"><span class="text-gray-400">Maksimal Risiko Kerugian:</span><b class="text-rose-400">-Rp ' + plan.scaleOut.maxLoss.toLocaleString('id-ID') + '</b></div>' +
                        '<div class="flex justify-between"><span class="text-gray-400">Biaya Fee (Beli 0,15% + Jual 0,25%):</span><b class="text-gray-300">Rp ' + plan.scaleOut.totalFees.toLocaleString('id-ID') + '</b></div>' +
                        '<div class="flex justify-between"><span class="text-gray-400">Breakeven Stop (saat TP1):</span><b class="text-sky-300">Rp ' + plan.scaleOut.breakevenStop.toLocaleString('id-ID') + '</b></div>' +
                    '</div>' +
                '</div>' +
                '<div class="p-3.5 rounded-xl bg-dark-800/80 border border-dark-700/60 space-y-3">' +
                    '<div class="flex items-center justify-between pb-2 border-b border-dark-700/50">' +
                        '<h4 class="font-semibold text-slate-100 flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-emerald-400"></span>Backtest Historis (' + activeMode.toUpperCase() + ' · ' + activeTf + ')</h4>' +
                        '<span class="text-[10px] px-2 py-0.5 rounded bg-emerald-950/60 text-emerald-400 border border-emerald-500/30 font-mono">' + (btRes ? btRes.candleCount : (candles.length.toLocaleString('id-ID') + ' Lilin')) + '</span>' +
                    '</div>' +
                    '<div class="grid grid-cols-2 gap-2 text-[11px] font-mono">' +
                        '<div class="p-2 rounded bg-dark-900 border border-dark-700/60"><span class="text-gray-400">WIN RATE</span><br><b class="text-emerald-400 text-sm">' + (btRes ? btRes.winRate : '—') + '</b></div>' +
                        '<div class="p-2 rounded bg-dark-900 border border-dark-700/60"><span class="text-gray-400">PROFIT FACTOR</span><br><b class="text-sky-400 text-sm">' + (btRes ? btRes.profitFactor : '—') + '</b></div>' +
                        '<div class="p-2 rounded bg-dark-900 border border-dark-700/60"><span class="text-gray-400">TOTAL TRADES</span><br><b class="text-gray-200">' + (btRes ? btRes.totalTrades : '—') + '</b></div>' +
                        '<div class="p-2 rounded bg-dark-900 border border-dark-700/60"><span class="text-gray-400">MAX DRAWDOWN</span><br><b class="text-amber-400">' + (btRes ? btRes.maxDrawdown : '—') + '</b></div>' +
                    '</div>' +
                    '<div class="pt-2 border-t border-dark-700/50 text-[11px] space-y-1">' +
                        '<div class="flex justify-between"><span class="text-gray-400">Rata-rata Durasi Hold:</span><b class="text-gray-200">' + (btRes ? btRes.avgHoldingDays : '—') + '</b></div>' +
                        '<div class="flex justify-between"><span class="text-gray-400">Expectancy per Trade:</span><b class="text-emerald-400">' + (btRes ? btRes.expectancy : '—') + '</b></div>' +
                        '<div class="flex justify-between"><span class="text-gray-400">Status Validasi Risk Gate:</span>' + (plan.isSafeRR ? '<b class="text-emerald-400 font-semibold">LOLOS (R/R &ge; 1,50x)</b>' : '<b class="text-rose-400 font-semibold">PANTAUAN / DITOLAK (R/R &lt; 1,50x)</b>') + '</div>' +
                    '</div>' +
                '</div>' +
            '</div>';
    } else {
        planCardEl.style.display = 'none';
    }

    // Legacy RSI & Metrics strip management
    var rsiContainer = document.getElementById(chartId + '_rsi');
    var metricsEl = document.getElementById(chartId + '_metrics');
    if (ws) {
        // When Chart Workstation is attached, suppress legacy squeezed subpanels below the plan & backtest card
        if (rsiContainer) rsiContainer.style.display = 'none';
        if (metricsEl) metricsEl.style.display = 'none';
    } else {
        // RSI panel (for non-workstation legacy views)
        if (rsiContainer && candles.length > 15) {
            rsiContainer.innerHTML = '';
            rsiContainer.style.height = dims.rsi + 'px';
            rsiChart = LightweightCharts.createChart(rsiContainer, {
                width: rsiContainer.clientWidth, height: dims.rsi,
                layout: acChartLayout(_th),
                grid: { vertLines: { color: _th.grid }, horzLines: { color: _th.grid } },
                rightPriceScale: { borderColor: _th.border, scaleMargins: { top: 0.1, bottom: 0.1 } },
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

    // Default view (HANDOFF 5a): Scalping 3 months, Investor 1 year, other modes
    // 6 months; double-click returns to it. The subpanels follow through the
    // logical-range subscription above.
    var _defaultRange = null;
    if (candles && candles.length > 30) {
        var _t = function(c) { var v = c.time; return typeof v === 'number' ? v * 1000 : Date.parse(typeof v === 'string' ? v : (v.year + '-' + v.month + '-' + v.day)); };
        var _span = (_t(candles[candles.length - 1]) - _t(candles[candles.length - 11])) / 86400000 / 10;
        var _bars = acDefaultBars(wsState && wsState.activePreset, _span > 3);
        if (candles.length > _bars) _defaultRange = { from: candles.length - _bars, to: candles.length + 2 };
    }
    if (_defaultRange) {
        try { chart.timeScale().setVisibleLogicalRange(_defaultRange); } catch (_) {}
        container.addEventListener('dblclick', function() { try { chart.timeScale().setVisibleLogicalRange(_defaultRange); } catch (_) {} });
    }
    var _hiLo = null;
    if (candles && candles.length >= 10) {
        try { _hiLo = acAttachHiLo(chart, candleSeries, candles, container, function(v) { return Number(v).toLocaleString('id-ID', _isIdxTicker ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 }); }); } catch (_) {}
    }

    // Register instances + metadata for the exporter (scoped, no global loose vars).
    var _latest = (candles && candles.length) ? candles[candles.length - 1] : null;
    _chartRegistry[chartId] = {
        chartId: chartId,
        variant: variant,
        mainChart: chart,
        candleSeries: candleSeries,
        allSeries: _allSeries,
        rsiChart: (typeof rsiChart !== 'undefined' ? rsiChart : null) || null,
        intensityChart: (typeof intensityChart !== 'undefined' ? intensityChart : null) || null,
        rotationChart: (typeof rotationChart !== 'undefined' ? rotationChart : null) || null,
        ticker: ticker || '',
        metrics: metrics || null,
        lastClose: _latest ? _latest.close : null,
        lastVolume: _latest ? _latest.volume : null,
        fibQuote: fibQuote,
        dims: dims,
        observers: _observers,
        lastLine: _lastLine,
        lastUp: _lp ? _lp.up : true,
        hiLo: _hiLo
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

// ===== SHARED QUOTE-CONTEXT BUILDER =====
// Extracted here so every surface that sends an AI analysis request (the
// Dashboard chat in index.html and the standalone Analisis Saham page) builds
// the SAME enriched [Auto-Cuan Market Data]/[Auto-Cuan Fibonacci
// Intelligence]/[Auto-Cuan Volume Intelligence] text blocks from the SAME
// /api/quote response, instead of silently drifting apart. Before this
// extraction, analisis-saham-runtime.js sent a bare ticker with no enrichment
// at all, so lib/analyze-legacy.js fell back to a 90-day Yahoo-only quote
// that structurally cannot produce MA100/MA200 or a real Fibonacci swing
// high/low — while the Dashboard chat (which did call this function) showed
// them. See PR #529 follow-up investigation.
//
// isValidTicker/getAuthHeaders/isLoggedInUser are defined inline in
// index.html and don't exist on analisis-saham.html, so this falls back to
// safe equivalents when they're absent rather than requiring every host page
// to redefine them.
var _quoteContextCache = {};
var _quoteInflight = {};
var QUOTE_CONTEXT_CACHE_TTL = 4 * 60 * 1000;

function _qcIsValidTicker(word) {
    if (typeof window.isValidTicker === 'function') return window.isValidTicker(word);
    var ticker = String(word || '').toUpperCase().trim();
    return ticker === 'IHSG' || /^[A-Z]{4}$/.test(ticker);
}
function _qcAuthHeaders() {
    return (typeof window.getAuthHeaders === 'function') ? window.getAuthHeaders() : {};
}
function _qcIsLoggedIn() {
    return (typeof window.isLoggedInUser === 'function') ? window.isLoggedInUser() : false;
}

async function fetchQuoteContext(ticker, forceFresh) {
    if (!ticker || !_qcIsValidTicker(ticker)) return '';

    // Check frontend cache (skipped when forceFresh — initial analysis must match live card)
    var cacheKey = ticker;
    if (!forceFresh) {
        var cached = _quoteContextCache[cacheKey];
        if (cached && (Date.now() - cached.ts < QUOTE_CONTEXT_CACHE_TTL)) {
            return cached.ctx;
        }
        // Deduplicate inflight requests for same ticker
        if (_quoteInflight[cacheKey]) {
            return _quoteInflight[cacheKey];
        }
    }

    _quoteInflight[cacheKey] = (async function() {
    try {
        var quoteResp = await fetch('/api/quote?ticker=' + encodeURIComponent(ticker) + '&includeNews=0', { method: 'GET', headers: _qcAuthHeaders() }).catch(function() { return null; });

        var lines = ['\n[Auto-Cuan Market Data]'];
        lines.push('Ticker: ' + ticker);
        lines.push('Basis Data: Data Historis T-1');

        if (quoteResp && quoteResp.ok) {
            var q = await quoteResp.json();
            if (q.success) {
                // Same rule as every other grounding line: absent stays absent.
                // "Volume: 0" told the model the stock did not trade, and a
                // missing OHLC field was written as the literal "undefined".
                [['Last', q.last], ['Open', q.open], ['High', q.high], ['Low', q.low], ['Volume', q.volume]]
                    .forEach(function(entry) {
                        if (entry[1] != null && entry[1] !== '') lines.push(entry[0] + ': ' + entry[1]);
                    });
                if (q.volumeAvg20 != null) lines.push('Avg Volume 20: ' + q.volumeAvg20);
                if (q.volumeVsAvg20 != null) lines.push('Volume vs Avg 20: ' + q.volumeVsAvg20 + 'x');
                if (q.volumeAvg3 != null) lines.push('Avg Volume 3D: ' + q.volumeAvg3);
                if (q.volumeAvg7 != null) lines.push('Avg Volume 7D: ' + q.volumeAvg7);
                if (q.volumeVsAvg3 != null) lines.push('Volume vs Avg 3D: ' + q.volumeVsAvg3 + 'x');
                if (q.volumeVsAvg7 != null) lines.push('Volume vs Avg 7D: ' + q.volumeVsAvg7 + 'x');
                if (q.prevClose != null) lines.push('Prev Close: ' + q.prevClose);
                if (q.priceChange1D != null) lines.push('Price Change 1D: ' + q.priceChange1D + '%');
                if (q.volumeTrend) lines.push('Volume Trend: ' + q.volumeTrend);
                if (q.priceVolumeReading) lines.push('Price-Volume Reading: ' + q.priceVolumeReading);
                if (q.ma20 != null) lines.push('MA20: ' + q.ma20);
                if (q.ma50 != null) lines.push('MA50: ' + q.ma50);
                if (q.ma100 != null) lines.push('MA100: ' + q.ma100);
                if (q.ma200 != null) lines.push('MA200: ' + q.ma200);
                if (q.rsi14 != null) lines.push('RSI14: ' + q.rsi14);
                // Pivot data from same response
                if (q.pivot) {
                    // A missing pivot used to be written into the prompt as the
                    // literal string "undefined" ("Support 1: undefined").
                    [['Pivot Point', q.pivot.pivotPoint], ['OHLC Pivot', q.pivot.ohlcPivot],
                     ['Support 1', q.pivot.support1], ['Support 2', q.pivot.support2],
                     ['Resistance 1', q.pivot.resistance1], ['Resistance 2', q.pivot.resistance2],
                     ['Pivot Method', q.pivot.pivotMethod], ['Pivot Source Date', q.pivot.pivotSourceDate]
                    ].forEach(function(entry) {
                        if (entry[1] != null && entry[1] !== '') lines.push(entry[0] + ': ' + entry[1]);
                    });
                    if (q.pivot.flatRange) lines.push('Note: Range T-1 flat/sempit, level pivot kurang informatif.');
                }

                // Volume Intelligence context (only for stocks with volume data)
                if (q.volumeAvg3 != null && q.volumeAvg7 != null && !q.isIndex) {
                    lines.push('');
                    lines.push('[Auto-Cuan Volume Intelligence]');
                    // Every line here is grounding the model reads as fact, so a
                    // missing field is omitted rather than defaulted. The `|| 0`
                    // fallbacks this replaces turned an absent 20-day average
                    // into "Volume vs Avg 20D: 0x" and an absent daily move into
                    // "Price Change 1D: 0%" — readings the model would then
                    // reason from as a volume collapse and a flat session. The
                    // block immediately above already guards the same fields
                    // with `!= null`; this one did not.
                    if (q.volume != null) lines.push('Volume Terakhir: ' + formatIndonesianVolume(q.volume));
                    lines.push('Rata-rata 3 Hari: ' + formatCompactVolume(q.volumeAvg3));
                    lines.push('Rata-rata 7 Hari: ' + formatCompactVolume(q.volumeAvg7));
                    if (q.volumeAvg20 != null) lines.push('Rata-rata 20 Hari: ' + formatCompactVolume(q.volumeAvg20));
                    if (q.volumeVsAvg3 != null) lines.push('Volume vs Avg 3D: ' + String(q.volumeVsAvg3).replace('.', ',') + 'x');
                    if (q.volumeVsAvg7 != null) lines.push('Volume vs Avg 7D: ' + String(q.volumeVsAvg7).replace('.', ',') + 'x');
                    if (q.volumeVsAvg20 != null) lines.push('Volume vs Avg 20D: ' + String(q.volumeVsAvg20).replace('.', ',') + 'x');
                    if (q.priceChange1D != null) lines.push('Price Change 1D: ' + q.priceChange1D + '%');
                    if (q.volumeTrend) lines.push('Volume Trend: ' + q.volumeTrend);
                    lines.push('Pembacaan: ' + (q.priceVolumeReading || 'Data tidak cukup untuk pembacaan volume.'));
                    // Estimated transaction value (optional)
                    if (q.last && q.volume && q.volume > 0) {
                        var estTxnValue = q.last * q.volume;
                        lines.push('Estimasi Nilai Transaksi: ' + formatIndonesianRupiah(estTxnValue));
                    }
                }

                // Fibonacci Intelligence context (only if data available)
                var fib = q.fibonacci;
                if (fib && fib.swingHigh != null && fib.levels) {
                    lines.push('');
                    lines.push('[Auto-Cuan Fibonacci Intelligence]');
                    lines.push('Swing High: ' + fib.swingHigh);
                    lines.push('Swing Low: ' + fib.swingLow);
                    lines.push('Trend Context: ' + humanizeFibTrend(fib.trend));
                    lines.push('Lookback: ' + fib.lookbackCandles + ' candles');
                    lines.push('Fib 23.6%: ' + fib.levels.fib236);
                    lines.push('Fib 38.2%: ' + fib.levels.fib382);
                    lines.push('Fib 50%: ' + fib.levels.fib500);
                    lines.push('Fib 61.8%: ' + fib.levels.fib618);
                    lines.push('Fib 78.6%: ' + fib.levels.fib786);
                    if (fib.nearestLabel) lines.push('Nearest Fib: ' + fib.nearestLabel + ' (' + fib.nearestLevel + ')');
                    if (fib.positionReading) lines.push('Reading: ' + fib.positionReading);
                    if (fib.invalidationLevel) lines.push('Invalidation: ' + (fib.trend === 'upward_retracement' ? 'Breakdown di bawah ' : 'Breakout di atas ') + fib.invalidationLevel + ' melemahkan skenario saat ini.');
                }
            } else {
                lines.push('Data historis belum berhasil diambil.');
            }

            // Board data from same response
            var b = q && q.board;
            if (b) {
                lines.push('');
                lines.push('[Auto-Cuan Board Data]');
                lines.push('Ticker: ' + ticker);
                if (b.companyName) lines.push('Company: ' + b.companyName);
                lines.push('Board: ' + (b.board || 'UNKNOWN'));
                lines.push('FCA: ' + (b.isFca ? 'true' : 'false'));
                lines.push('Min Price Guard: ' + (b.minPriceGuard != null ? b.minPriceGuard : 50));
                if (b.note) lines.push('Note: ' + b.note);
            }

            // News data from same response
            var newsData = q && q.news;
            if (newsData && newsData.items && newsData.items.length > 0) {
                lines.push('');
                lines.push('[Auto-Cuan News Summary]');
                lines.push('Ticker: ' + ticker);
                lines.push('Period: 6 bulan terakhir');
                for (var ni = 0; ni < newsData.items.length; ni++) {
                    var news = newsData.items[ni];
                    lines.push('- ' + (news.date || '?') + ': ' + news.title);
                    if (news.summary) lines.push('  ' + news.summary);
                    if (news.possibleImpact) lines.push('  Impact: ' + news.possibleImpact);
                    if (news.source) lines.push('  Sumber: ' + news.source);
                }
                // Store for News panel button (by ticker)
                if (!window._stockNewsByTicker) window._stockNewsByTicker = {};
                window._stockNewsByTicker[ticker] = newsData.items;
            } else {
                lines.push('');
                lines.push('[Auto-Cuan News Summary]');
                lines.push('News Summary: unavailable');
                window._stockNewsByTicker = window._stockNewsByTicker || {};
                delete window._stockNewsByTicker[ticker];
            }

            // === AUTO-CUAN SCORE (from server-side calculation) ===
            var acs = q.autoCuanScore;
            if (acs && acs.score != null) {
                lines.push('');
                lines.push('[Auto-Cuan Score]');
                lines.push('Score: ' + acs.score + '/100');
                lines.push('Grade: ' + acs.grade);
                lines.push('Confidence: ' + acs.confidence);
                lines.push('Trend: ' + acs.components.trend + '/25');
                lines.push('Momentum: ' + acs.components.momentum + '/20');
                lines.push('Volume: ' + acs.components.volume + '/20');
                lines.push('Pivot: ' + acs.components.pivot + '/15');
                lines.push('Catalyst: ' + acs.components.catalyst + '/10');
                lines.push('Risk: ' + acs.components.risk);
                if (acs.reasons && acs.reasons.length > 0) lines.push('Reasons: ' + acs.reasons.join('; '));
                if (acs.warnings && acs.warnings.length > 0) lines.push('Warnings: ' + acs.warnings.join('; '));
            } else {
                // Fallback to frontend calculation if server didn't return score
                var acScore = calculateAutoCuanScore(q, b, newsData);
                if (acScore) {
                    lines.push('');
                    lines.push('[Auto-Cuan Score]');
                    lines.push('Total: ' + acScore.total + '/100');
                    lines.push('Category: ' + acScore.category);
                    lines.push('Trend Score: ' + acScore.trendScore + '/30');
                    lines.push('RSI Score: ' + acScore.rsiScore + '/20');
                    lines.push('Volume Score: ' + acScore.volumeScore + '/20');
                    lines.push('News Score: ' + acScore.newsScore + '/15');
                    lines.push('Board Risk Score: ' + acScore.boardRiskScore + '/15');
                    lines.push('Reason: ' + acScore.reason);
                }
            }

            // === SETUP LABEL (from server-side calculation) ===
            var sl = q.setupLabel;
            if (sl && sl.status) {
                lines.push('');
                lines.push('[Auto-Cuan Setup Label]');
                lines.push('Status: ' + sl.status);
                lines.push('Confidence: ' + sl.confidence);
                if (sl.reasons && sl.reasons.length > 0) lines.push('Reasons: ' + sl.reasons.join('; '));
                lines.push('Valid If: ' + sl.validIf);
                lines.push('Invalid If: ' + sl.invalidIf);
                if (sl.flags && sl.flags.length > 0) lines.push('Flags: ' + sl.flags.join(', '));
            }

            // === BREAKOUT / BREAKDOWN CONFIRMATION (from server-side) ===
            var bc = q.breakoutConfirmation;
            if (bc && bc.status) {
                lines.push('');
                lines.push('[Auto-Cuan Breakout Confirmation]');
                lines.push('Status: ' + bc.status);
                lines.push('Confidence: ' + bc.confidence);
                if (bc.breakoutLevel != null) lines.push('Breakout Level: ' + bc.breakoutLevel);
                if (bc.breakdownLevel != null) lines.push('Breakdown Level: ' + bc.breakdownLevel);
                lines.push('Valid If: ' + bc.validIf);
                lines.push('Invalid If: ' + bc.invalidIf);
                if (bc.reasons && bc.reasons.length > 0) lines.push('Reasons: ' + bc.reasons.join('; '));
                if (bc.warnings && bc.warnings.length > 0) lines.push('Warnings: ' + bc.warnings.join('; '));
            }

            // === RESPECT ZONE & TRADING PLAN (from server-side) ===
            if (q.respectZone && q.respectZone.notes && q.respectZone.notes.length > 0) {
                lines.push('');
                lines.push('[Auto-Cuan Respect Zone]');
                q.respectZone.notes.forEach(function(n) { lines.push('- ' + n); });
            }
            if (q.tradingPlan) {
                var tp = q.tradingPlan;
                lines.push('');
                lines.push('[Auto-Cuan Trading Plan]');
                lines.push('Entry 1: ' + (tp.entry_1 || '-'));
                lines.push('Entry 2: ' + (tp.entry_2 || '-'));
                lines.push('Stop Loss: ' + (tp.stop_loss || '-'));
                lines.push('Target 1: ' + (tp.target_1 || '-'));
                lines.push('Target 2: ' + (tp.target_2 || '-'));
                lines.push('R/R: ' + (tp.risk_reward || '-'));
                if (_qcIsLoggedIn() && tp.half_candle_level) lines.push('Half Candle Debt: ' + tp.half_candle_level + ' — ' + (tp.half_candle_label || 'Entry pullback 1/2 candle'));
                if (_qcIsLoggedIn() && tp.half_candle_note) lines.push('Half Candle Note: ' + tp.half_candle_note);
                if (_qcIsLoggedIn() && tp.refinement_notes) lines.push('Refinement: ' + tp.refinement_notes);
                if (_qcIsLoggedIn() && tp.respect_zone_notes) lines.push('Zone Context: ' + tp.respect_zone_notes);
                if (_qcIsLoggedIn() && tp.respect_quality_label) {
                    lines.push('Respect v2: ' + tp.respect_quality_label + (tp.respect_quality_score != null ? ' (' + tp.respect_quality_score + '/100)' : ''));
                    if (tp.respect_quality_factors && tp.respect_quality_factors.length) lines.push('Respect Factors: ' + tp.respect_quality_factors.slice(0, 4).join('; '));
                    if (tp.respect_invalid_reason) lines.push('Respect Invalid: ' + tp.respect_invalid_reason);
                    if (tp.bearish_respect_warning) lines.push('Bearish Respect: ' + tp.bearish_respect_warning);
                }
            }
            if (q.bsjpLabel) {
                lines.push('');
                lines.push('[Auto-Cuan BSJP]');
                lines.push(q.bsjpLabel);
            }
            // === V6: RISK LABEL (from server-side deterministic calculation) ===
            if (q.riskLabel && q.riskLabel.risk_label) {
                lines.push('');
                lines.push('[Auto-Cuan Risk Label]');
                lines.push('Risk: ' + q.riskLabel.risk_label);
                lines.push('Score: ' + q.riskLabel.risk_score + '/100');
                if (q.riskLabel.risk_notes && q.riskLabel.risk_notes.length > 0) lines.push('Notes: ' + q.riskLabel.risk_notes.join('; '));
            }
        } else {
            lines.push('Data historis belum berhasil diambil.');
        }

        var ctx = lines.join('\n');
        _quoteContextCache[cacheKey] = { ctx: ctx, ts: Date.now() };
        return ctx;
    } catch (e) {
        return '\n[Auto-Cuan Market Data]\nData historis belum berhasil diambil.';
    }
    })();
    try { var result = await _quoteInflight[cacheKey]; return result; }
    finally { delete _quoteInflight[cacheKey]; }
}

// ===== AUTO-CUAN SCORE CALCULATOR =====
function calculateAutoCuanScore(q, board, newsData) {
    if (!q || !q.success) return null;

    var trendScore = 0; // 0-30
    var rsiScore = 0;   // 0-20
    var volumeScore = 0; // 0-20
    var newsScore = 7;  // 0-15 (default neutral)
    var boardRiskScore = 10; // 0-15 (default medium)
    var reasons = [];

    // 1. TREND / MA Score (0-30)
    var last = q.last;
    var maAbove = 0;
    var maTotal = 0;
    if (q.ma20 != null) { maTotal++; if (last >= q.ma20) maAbove++; }
    if (q.ma50 != null) { maTotal++; if (last >= q.ma50) maAbove++; }
    if (q.ma100 != null) { maTotal++; if (last >= q.ma100) maAbove++; }
    if (q.ma200 != null) { maTotal++; if (last >= q.ma200) maAbove++; }

    if (maTotal > 0) {
        var maRatio = maAbove / maTotal;
        trendScore = Math.round(maRatio * 30);
        // Bonus: check MA alignment (MA20 > MA50 > MA100 = bullish)
        if (q.ma20 != null && q.ma50 != null && q.ma20 > q.ma50) trendScore = Math.min(30, trendScore + 3);
        if (maAbove === 0) reasons.push('trend bearish (below all MA)');
        else if (maAbove === maTotal) reasons.push('trend bullish (above all MA)');
        else reasons.push('trend mixed');
    } else {
        trendScore = 10; // no MA data, neutral
    }

    // 2. RSI / MOMENTUM Score (0-20)
    var rsi = q.rsi14;
    if (rsi != null) {
        if (rsi >= 55 && rsi <= 70) { rsiScore = 17; reasons.push('RSI bullish momentum'); }
        else if (rsi >= 45 && rsi < 55) { rsiScore = 12; reasons.push('RSI netral'); }
        else if (rsi > 70) { rsiScore = 8; reasons.push('RSI overbought risk'); }
        else if (rsi >= 30 && rsi < 45) { rsiScore = 7; reasons.push('RSI weak/bearish'); }
        else if (rsi < 30) { rsiScore = 5; reasons.push('RSI oversold belum confirm reversal'); }
        else { rsiScore = 10; }
    } else {
        rsiScore = 8; // no RSI data
    }

    // 3. VOLUME Score (0-20)
    var volVsAvg = q.volumeVsAvg20;
    if (volVsAvg != null) {
        // Determine if last candle was green or red
        var isGreenCandle = q.last >= q.open;
        if (volVsAvg >= 1.2 && isGreenCandle) { volumeScore = 18; reasons.push('volume tinggi + price naik'); }
        else if (volVsAvg >= 1.2 && !isGreenCandle) { volumeScore = 6; reasons.push('volume tinggi tapi price turun (distribusi)'); }
        else if (volVsAvg >= 0.8 && volVsAvg < 1.2) { volumeScore = 12; reasons.push('volume normal'); }
        else if (volVsAvg < 0.5) { volumeScore = 4; reasons.push('volume sangat lemah'); }
        else { volumeScore = 8; reasons.push('volume di bawah rata-rata'); }
    } else {
        volumeScore = 8; // no volume data
    }

    // 4. NEWS / KATALIS Score (0-15)
    if (newsData && newsData.items && newsData.items.length > 0) {
        var positiveNews = 0, negativeNews = 0;
        for (var ni = 0; ni < newsData.items.length; ni++) {
            var impact = newsData.items[ni].possibleImpact || newsData.items[ni].impact || 'neutral';
            if (impact === 'positive') positiveNews++;
            else if (impact === 'negative') negativeNews++;
        }
        if (positiveNews > 0 && negativeNews === 0) { newsScore = 13; reasons.push('katalis positif'); }
        else if (negativeNews > 0 && positiveNews === 0) { newsScore = 3; reasons.push('katalis negatif'); }
        else if (positiveNews > 0 && negativeNews > 0) { newsScore = 8; reasons.push('katalis mixed'); }
        else { newsScore = 7; }
    } else {
        newsScore = 6; // no news = slightly below neutral
    }

    // 5. BOARD / RISK Score (0-15)
    if (board && board.board) {
        var b = board.board;
        if (b === 'UTAMA') { boardRiskScore = 14; }
        else if (b === 'PENGEMBANGAN' || b === 'EKONOMI_BARU') { boardRiskScore = 11; }
        else if (b === 'AKSELERASI') { boardRiskScore = 6; reasons.push('papan AKSELERASI (likuiditas ketat)'); }
        else if (b === 'PEMANTAUAN_KHUSUS') { boardRiskScore = 3; reasons.push('Pemantauan Khusus (risk tinggi)'); }
        else { boardRiskScore = 8; } // UNKNOWN
        if (board.isFca) { boardRiskScore = Math.min(boardRiskScore, 3); reasons.push('FCA risk'); }
    }

    // Calculate total
    var total = trendScore + rsiScore + volumeScore + newsScore + boardRiskScore;
    total = Math.max(0, Math.min(100, total));

    // Determine category
    var category;
    if (total <= 30) category = 'Avoid';
    else if (total <= 45) category = 'Wait and see';
    else if (total <= 60) category = 'Watchlist';
    else if (total <= 75) category = 'Speculative buy';
    else category = 'Strong setup';

    // Build reason string (max 2 most important)
    var topReasons = reasons.slice(0, 3).join(', ');
    if (!topReasons) topReasons = 'Data terbatas';

    return {
        total: total,
        category: category,
        trendScore: trendScore,
        rsiScore: rsiScore,
        volumeScore: volumeScore,
        newsScore: newsScore,
        boardRiskScore: boardRiskScore,
        reason: topReasons
    };
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
