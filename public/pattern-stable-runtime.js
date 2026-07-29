(function (root) {
  'use strict';
  if (!root || !root.document) return;

  function boot(attempt) {
    var Ui = root.AutoCuanUiStability;
    var doc = root.document;
    if (!Ui || !doc.getElementById('dashboardScreen') || !root.PatternMap || !root.PatternMapAdminAccess || typeof root.navigateTo !== 'function') {
      if (attempt < 240) root.setTimeout(function () { boot(attempt + 1); }, 50);
      return;
    }
    if (root.__AUTOCUAN_PATTERN_STABLE__) return;
    root.__AUTOCUAN_PATTERN_STABLE__ = '20260728-pattern-stable-v3';

    var originalNavigate = root.navigateTo;
    var originalLogout = typeof root.logout === 'function' ? root.logout : null;
    var state = {
      allowed:false, checked:false, loading:false, loaded:false, rows:[], total:0,
      version:0, urls:{}, controllers:{}, cacheHydrated:false
    };

    function esc(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
        return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
      });
    }
    function num(value) {
      var n = Number(value);
      return Number.isFinite(n) ? n.toLocaleString('id-ID', { maximumFractionDigits:2 }) : '—';
    }
    function headers() {
      var result = {};
      try {
        result['X-User-Id'] = root.localStorage.getItem('autocuan_user_id') || '';
        result['X-Username'] = root.localStorage.getItem('autocuan_user') || '';
      } catch (_) {}
      return result;
    }
    async function json(url) {
      var response = await root.fetch(url, { credentials:'same-origin', cache:'no-store', headers:headers() });
      var data = await response.json().catch(function () { return null; });
      return response.ok && data && data.success !== false ? data : null;
    }
    function jakartaDateKey() {
      try {
        return new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Jakarta', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
      } catch (_) { return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10); }
    }
    function cacheKey() {
      var uid = '';
      try { uid = root.localStorage.getItem('autocuan_user_id') || 'session'; } catch (_) { uid = 'session'; }
      return 'autocuan_pattern_scan_cache_v3_' + uid;
    }
    function clearCache() {
      try { root.sessionStorage.removeItem(cacheKey()); } catch (_) {}
    }
    function persistCache() {
      try {
        root.sessionStorage.setItem(cacheKey(), JSON.stringify({
          version:3,
          dateKey:jakartaDateKey(),
          savedAt:Date.now(),
          total:state.total,
          rows:state.rows
        }));
      } catch (_) {}
    }
    function hydrateCache() {
      if (state.cacheHydrated) return state.loaded;
      state.cacheHydrated = true;
      try {
        var raw = root.sessionStorage.getItem(cacheKey());
        var cached = raw ? JSON.parse(raw) : null;
        if (!cached || cached.version !== 3 || cached.dateKey !== jakartaDateKey() || !Array.isArray(cached.rows)) return false;
        state.rows = cached.rows;
        state.total = Number(cached.total) || 0;
        state.loaded = true;
        state.loading = false;
        render();
        progress(state.total, state.total, 'Hasil scan hari ini dipulihkan. Tekan Scan Ulang hanya bila diperlukan.');
        return true;
      } catch (_) { return false; }
    }

    function addStyles() {
      if (doc.getElementById('patternStableStyles')) return;
      var style = doc.createElement('style');
      style.id = 'patternStableStyles';
      style.textContent = [
        '#patternChartTab,#patternPageContainer{display:none!important}',
        '.ps-shell{padding:18px;border:1px solid rgba(148,163,184,.15);border-radius:22px;background:linear-gradient(145deg,rgba(18,25,36,.98),rgba(8,14,22,.98));box-shadow:0 24px 68px rgba(0,0,0,.22)}',
        '.ps-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}.ps-title{font-size:23px;font-weight:900;color:#f8fafc}.ps-sub{margin-top:4px;max-width:850px;font-size:12px;color:#94a3b8}.ps-actions,.ps-card-actions{display:flex;gap:8px;flex-wrap:wrap}',
        '.ps-btn{min-height:40px;padding:9px 13px;border:1px solid rgba(52,211,153,.28);border-radius:11px;background:rgba(16,185,129,.08);color:#6ee7b7;font-size:12px;font-weight:800;cursor:pointer}.ps-btn.alt{border-color:rgba(148,163,184,.18);background:rgba(15,23,42,.58);color:#cbd5e1}.ps-btn:disabled{opacity:.5}',
        '.ps-progress{margin-top:14px;padding:12px 14px;border:1px solid rgba(148,163,184,.12);border-radius:14px;background:rgba(2,6,23,.38)}.ps-progress-row{display:flex;justify-content:space-between;gap:12px;font-size:11px;color:#94a3b8}.ps-track{height:7px;margin-top:8px;overflow:hidden;border-radius:999px;background:#151a23}.ps-fill{height:100%;width:0;background:linear-gradient(90deg,#10b981,#22d3ee);transition:width .18s}',
        '.ps-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px;margin-top:14px}.ps-card{min-width:0;padding:15px;border:1px solid rgba(148,163,184,.14);border-radius:17px;background:rgba(15,23,42,.52)}.ps-card.bullish{border-color:rgba(52,211,153,.24)}.ps-card.bearish{border-color:rgba(248,113,113,.23)}.ps-card.bilateral{border-color:rgba(96,165,250,.22)}',
        '.ps-card-head{display:flex;justify-content:space-between;gap:12px}.ps-ticker{font-size:20px;font-weight:950;color:#f8fafc}.ps-name{margin-top:1px;font-size:12px;color:#94a3b8}.ps-badge{height:fit-content;padding:4px 8px;border:1px solid rgba(96,165,250,.25);border-radius:999px;background:rgba(59,130,246,.08);color:#93c5fd;font-size:10px;font-weight:850;white-space:nowrap}',
        '.ps-pattern-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:13px}.ps-pattern-chip{display:inline-flex;align-items:center;min-height:27px;padding:5px 9px;border:1px solid rgba(96,165,250,.2);border-radius:999px;background:rgba(59,130,246,.075);color:#bfdbfe;font-size:10px;font-weight:850}.ps-pattern-chip.bullish{border-color:rgba(52,211,153,.23);background:rgba(16,185,129,.08);color:#a7f3d0}.ps-pattern-chip.bearish{border-color:rgba(248,113,113,.23);background:rgba(239,68,68,.07);color:#fecaca}.ps-pattern-note{margin-top:9px;color:#7f8da3;font-size:10px;line-height:1.55}',
        '.ps-levels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:13px}.ps-level{padding:8px;border:1px solid rgba(148,163,184,.10);border-radius:11px;background:rgba(2,6,23,.34)}.ps-level span{display:block;color:#64748b;font-size:9px;text-transform:uppercase}.ps-level b{display:block;margin-top:2px;color:#e5e7eb;font-size:12px;overflow-wrap:anywhere}.ps-card-actions{margin-top:12px}',
        '.ps-map{display:none;min-height:250px;margin-top:12px;padding:10px;align-items:center;justify-content:center;overflow:hidden;border:1px solid rgba(148,163,184,.12);border-radius:13px;background:rgba(2,6,23,.44);color:#94a3b8;font-size:12px;text-align:center}.ps-map.open{display:flex}.ps-map img{width:100%;max-height:700px;object-fit:contain;border-radius:9px}.ps-empty{margin-top:14px;padding:34px 18px;border:1px dashed rgba(148,163,184,.18);border-radius:16px;background:rgba(2,6,23,.30);color:#94a3b8;text-align:center}',
        '@media(max-width:760px){.ps-grid{grid-template-columns:1fr}.ps-levels{grid-template-columns:repeat(2,minmax(0,1fr))}.ps-shell{padding:14px}.ps-actions{width:100%}.ps-actions .ps-btn{flex:1}}'
      ].join('');
      doc.head.appendChild(style);
    }

    function pageHtml() {
      return '<section class="ps-shell"><div class="ps-head"><div><h2 class="ps-title">Pattern Radar</h2><p class="ps-sub">Hanya menampilkan saham yang benar-benar memiliki ABCD atau pola chart konservatif T-1. Label setup Screener hanya menjadi informasi tambahan, bukan kartu pattern tersendiri.</p></div><div class="ps-actions"><button id="psRefresh" class="ps-btn">Scan Ulang</button><button id="psTechnical" class="ps-btn alt">Buka Chart</button></div></div><div class="ps-progress"><div class="ps-progress-row"><span id="psStatus">Siap memindai.</span><span id="psCount">0 saham pattern</span></div><div class="ps-track"><div id="psFill" class="ps-fill"></div></div></div><div id="psGrid" class="ps-grid"></div><div id="psEmpty" class="ps-empty">Belum ada hasil scan Pattern hari ini.</div></section>';
    }
    function place(node) {
      var screen = doc.getElementById('dashboardScreen');
      var footer = screen && screen.querySelector('footer');
      if (!screen || !node) return node;
      if (node.parentNode !== screen) footer ? screen.insertBefore(node, footer) : screen.appendChild(node);
      else if (footer && node.nextSibling !== footer) screen.insertBefore(node, footer);
      return node;
    }
    function page() {
      var node = doc.getElementById('page-pattern');
      if (!node) {
        node = doc.createElement('div');
        node.id = 'page-pattern';
        node.className = 'page-content hidden flex-1 max-w-[1200px] w-full mx-auto px-3 sm:px-5 py-4';
        node.setAttribute('data-premium-page', 'true');
        node.innerHTML = pageHtml();
        place(node);
        doc.getElementById('psRefresh').onclick = function () { clearCache(); state.cacheHydrated = true; scan(true); };
        doc.getElementById('psTechnical').onclick = function () { root.navigateTo('chart'); };
        node.addEventListener('click', function (event) {
          var mapButton = event.target.closest('[data-ps-map]');
          if (mapButton) draw(mapButton.getAttribute('data-ps-map'), mapButton);
          var chartButton = event.target.closest('[data-ps-chart]');
          if (chartButton) openChart(chartButton.getAttribute('data-ps-chart'));
        });
      }
      return place(node);
    }

    function makeNav(id, mobile) {
      var button = doc.createElement('button');
      button.id = id; button.type = 'button'; button.className = 'nav-btn' + (mobile ? ' flex-shrink-0' : '');
      button.setAttribute('data-page', 'pattern');
      button.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 18l4-5 4 3 4-8 4 4M4 21h16"/></svg><span>Pattern</span>';
      button.onclick = function () { root.navigateTo('pattern'); };
      return button;
    }
    function insertNav(container, button) {
      if (!container || !button) return;
      var chart = container.querySelector('[data-page="chart"]');
      chart ? container.insertBefore(button, chart) : container.appendChild(button);
    }
    function removeNav() {
      ['patternStableDesktopNav','patternStableMobileNav','patternRadarDesktopNav','patternRadarMobileNav'].forEach(function (id) { var node = doc.getElementById(id); if (node) node.remove(); });
    }
    function ensureNav() {
      if (!state.allowed) return;
      ['patternRadarDesktopNav','patternRadarMobileNav'].forEach(function (id) { var old = doc.getElementById(id); if (old) old.remove(); });
      if (!doc.getElementById('patternStableDesktopNav')) insertNav(doc.querySelector('.desktop-nav'), makeNav('patternStableDesktopNav', false));
      if (!doc.getElementById('patternStableMobileNav')) insertNav(doc.getElementById('mainNav'), makeNav('patternStableMobileNav', true));
    }
    async function access(force) {
      var allowed = await root.PatternMapAdminAccess.refresh(force === true).catch(function () { return false; });
      state.checked = true;
      state.allowed = allowed === true && root.PatternMapAdminAccess.isAllowed() === true;
      if (state.allowed) ensureNav(); else { removeNav(); hide(); }
      return state.allowed;
    }
    function hide() { var node = doc.getElementById('page-pattern'); if (node) node.classList.add('hidden'); }
    function show() {
      originalNavigate('chart');
      doc.querySelectorAll('.page-content').forEach(function (node) { node.classList.add('hidden'); });
      page().classList.remove('hidden');
      doc.querySelectorAll('.nav-btn[data-page]').forEach(function (button) { button.classList.toggle('active', button.getAttribute('data-page') === 'pattern'); });
      try { root.history.replaceState({}, '', '/pattern'); } catch (_) {}
      if (typeof root.closeSidebar === 'function') root.closeSidebar();
      root.scrollTo({ top:0, behavior:'smooth' });
    }

    function clearImages() {
      Object.keys(state.controllers).forEach(function (key) { try { state.controllers[key].abort(); } catch (_) {} });
      Object.keys(state.urls).forEach(function (key) { try { root.URL.revokeObjectURL(state.urls[key]); } catch (_) {} });
      state.controllers = {}; state.urls = {};
    }
    function progress(done, total, overrideText) {
      state.total = total;
      var status = doc.getElementById('psStatus');
      if (status) status.textContent = overrideText || (state.loading ? 'Memindai ' + done + ' dari ' + total + ' saham Screener…' : (total ? 'Selesai memindai ' + total + ' saham Screener.' : 'Screener belum memiliki ticker untuk dipindai.'));
      var count = doc.getElementById('psCount');
      if (count) count.textContent = state.rows.length + ' saham pattern';
      var fill = doc.getElementById('psFill');
      if (fill) fill.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    }
    function patternChips(row) {
      var patterns = Array.isArray(row.classicPatterns) ? row.classicPatterns : [];
      if (!patterns.length) return '';
      var chips = patterns.map(function (pattern) {
        var bias = String(pattern.bias || '').toLowerCase();
        var cls = bias.indexOf('bull') >= 0 ? ' bullish' : (bias.indexOf('bear') >= 0 ? ' bearish' : '');
        return '<span class="ps-pattern-chip' + cls + '">' + esc(pattern.label || pattern.type) + '</span>';
      }).join('');
      var primary = patterns[0] || {};
      return '<div class="ps-pattern-chips">' + chips + '</div>' + (primary.reason ? '<p class="ps-pattern-note">' + esc(primary.reason) + ' Pattern adalah konfirmasi teknikal, bukan sinyal BUY otomatis.</p>' : '');
    }
    function card(row) {
      var c = row.candidate;
      var patterns = Array.isArray(row.classicPatterns) ? row.classicPatterns : [];
      var primary = patterns[0] || {};
      var directionText = c && c.name ? c.name : primary.bias;
      var direction = String(directionText || '').toLowerCase().indexOf('bull') >= 0 ? 'bullish' : (String(directionText || '').toLowerCase().indexOf('bear') >= 0 ? 'bearish' : 'bilateral');
      if (!c) {
        return '<article class="ps-card ' + direction + '" data-classic-only="1"><div class="ps-card-head"><div><div class="ps-ticker">' + esc(row.ticker) + '</div><div class="ps-name">' + esc(primary.label || 'Classic Chart Pattern') + ' · T-1 ' + esc(row.dataDate) + '</div></div><span class="ps-badge">Pattern Terdeteksi</span></div>' + patternChips(row) + '<div class="ps-levels"><div class="ps-level"><span>Harga terakhir</span><b>' + num(row.currentPrice) + '</b></div><div class="ps-level"><span>Bias</span><b>' + esc(primary.bias || 'Bilateral') + '</b></div><div class="ps-level"><span>Keyakinan</span><b>' + (Number.isFinite(Number(primary.confidence)) ? Math.round(Number(primary.confidence) * 100) + '%' : '—') + '</b></div></div><div class="ps-card-actions"><button class="ps-btn" data-ps-map="' + esc(row.ticker) + '">Lihat Pola</button><button class="ps-btn alt" data-ps-chart="' + esc(row.ticker) + '">Buka Chart</button></div><div id="psMap-' + esc(row.ticker) + '" class="ps-map"></div></article>';
      }
      return '<article class="ps-card ' + direction + '"><div class="ps-card-head"><div><div class="ps-ticker">' + esc(row.ticker) + '</div><div class="ps-name">' + esc(c.name) + ' · T-1 ' + esc(row.dataDate) + '</div></div><span class="ps-badge">' + (c.status === 'confirmed' ? 'Terkonfirmasi' : 'Kandidat') + '</span></div>' + patternChips(row) + '<div class="ps-levels"><div class="ps-level"><span>Harga terakhir</span><b>' + num(c.currentPrice) + '</b></div><div class="ps-level"><span>Konfirmasi</span><b>' + num(c.confirmation) + '</b></div><div class="ps-level"><span>Invalidasi</span><b>' + num(c.invalidation) + '</b></div><div class="ps-level"><span>TP1</span><b>' + num(c.tp1) + '</b></div><div class="ps-level"><span>TP2</span><b>' + num(c.tp2) + '</b></div><div class="ps-level"><span>PRZ</span><b>' + num(c.prz && c.prz.low) + '–' + num(c.prz && c.prz.high) + '</b></div></div><div class="ps-card-actions"><button class="ps-btn" data-ps-map="' + esc(row.ticker) + '">Lihat Peta</button><button class="ps-btn alt" data-ps-chart="' + esc(row.ticker) + '">Buka Chart</button></div><div id="psMap-' + esc(row.ticker) + '" class="ps-map"></div></article>';
    }
    function render() {
      state.rows.sort(function (a, b) {
        var ac = a.candidate && a.candidate.status === 'confirmed' ? 1 : 0, bc = b.candidate && b.candidate.status === 'confirmed' ? 1 : 0;
        if (ac !== bc) return bc - ac;
        var ag = a.candidate ? 1 : 0, bg = b.candidate ? 1 : 0;
        if (ag !== bg) return bg - ag;
        var af = a.classicPatterns && a.classicPatterns[0] ? Number(a.classicPatterns[0].confidence) || 0 : 0;
        var bf = b.classicPatterns && b.classicPatterns[0] ? Number(b.classicPatterns[0].confidence) || 0 : 0;
        return (bf - af) || a.ticker.localeCompare(b.ticker);
      });
      var grid = doc.getElementById('psGrid');
      if (grid) grid.innerHTML = state.rows.map(card).join('');
      var empty = doc.getElementById('psEmpty');
      if (empty) {
        empty.classList.toggle('hidden', state.rows.length > 0);
        if (!state.rows.length) empty.textContent = state.loading ? 'Sedang memindai seluruh saham dari Screener terbaru…' : (state.total ? 'Tidak ada pattern konservatif yang valid pada hasil Screener saat ini.' : 'Belum ada ticker dari Screener yang dapat dipindai.');
      }
    }
    async function universe() {
      var stamp = Date.now();
      return Ui.collectTickers(await Promise.all([
        json('/api/sector-hot?action=screener&t=' + stamp).catch(function () { return null; }),
        json('/api/sector-hot?action=nk-screener-results&t=' + stamp).catch(function () { return null; }),
        json('/api/sector-hot?action=daytrade-screener&t=' + stamp).catch(function () { return null; })
      ]));
    }
    async function scan(force) {
      if (state.loading || (state.loaded && force !== true) || !await access(force === true)) return;
      var version = ++state.version;
      var previousRows = state.rows.slice();
      state.loading = true;
      var refresh = doc.getElementById('psRefresh');
      if (refresh) { refresh.disabled = true; refresh.textContent = 'Memindai…'; }
      try {
        var tickers = await universe();
        if (version !== state.version) return;
        progress(0, tickers.length);
        var results = await Ui.mapBounded(tickers, Ui.constants.SCAN_CONCURRENCY, async function (ticker) {
          var data = await json('/api/candles?ticker=' + encodeURIComponent(ticker));
          if (version !== state.version || !data || !Array.isArray(data.candles)) return null;
          var classicPatterns = Array.isArray(data.classicPatterns) ? data.classicPatterns.filter(function (pattern) { return pattern && pattern.label; }).slice(0, 3) : [];
          var candidate = null;
          var dataDate = String(data.actual_data_date || (data.patternMap && data.patternMap.dataDate) || (data.latest && data.latest.date) || '');
          var context = { ticker:ticker, timeframe:'1D', dataDate:dataDate, candles:data.candles };
          if (data.patternMap) {
            var validation = root.PatternMap.validateCandidate(data.patternMap, context);
            if (validation && validation.valid === true) candidate = data.patternMap;
          }
          if (!candidate && !classicPatterns.length) return null;
          return { ticker:ticker, candidate:candidate, classicPatterns:classicPatterns, context:context, dataDate:dataDate, currentPrice:data.latest && data.latest.last };
        }, function (done, total) { if (version === state.version) progress(done, total); });
        if (version !== state.version) return;
        state.rows = results.filter(Boolean);
        state.total = tickers.length;
        state.loaded = true;
        clearImages(); render(); persistCache();
      } catch (_) {
        state.rows = previousRows;
        state.loaded = previousRows.length > 0;
        render();
      } finally {
        if (version === state.version) {
          state.loading = false;
          progress(state.total, state.total, state.loaded ? 'Hasil Pattern hari ini siap. Scan tidak diulang saat keluar–masuk halaman.' : 'Scan belum berhasil.');
          if (refresh) { refresh.disabled = false; refresh.textContent = 'Scan Ulang'; }
        }
      }
    }

    function sparse(length, points) {
      var data = Array.from({ length:length }, function () { return null; });
      points.forEach(function (point) { if (point && point.index >= 0 && point.index < length && Number.isFinite(Number(point.value))) data[point.index] = Number(point.value); });
      return data;
    }
    function extrema(candles, useHigh) {
      var result = [];
      for (var i = 2; i < candles.length - 2; i += 1) {
        var value = Number(useHigh ? candles[i].high : candles[i].low);
        var good = true;
        for (var j = 1; j <= 2; j += 1) {
          var left = Number(useHigh ? candles[i-j].high : candles[i-j].low);
          var right = Number(useHigh ? candles[i+j].high : candles[i+j].low);
          if (useHigh ? (value < left || value < right) : (value > left || value > right)) good = false;
        }
        if (good) result.push({ index:i, value:value });
      }
      return result;
    }
    function buildClassicConfig(row) {
      var candles = row.context && Array.isArray(row.context.candles) ? row.context.candles.slice(-90) : [];
      if (candles.length < 5) return null;
      var labels = candles.map(function (c) { return c.time || c.date || ''; });
      var close = candles.map(function (c) { return Number(c.close); });
      if (close.some(function (v) { return !Number.isFinite(v); })) return null;
      var primary = row.classicPatterns && row.classicPatterns[0] || {};
      var type = String(primary.type || '').toUpperCase();
      var points = [];
      var highs = extrema(candles, true), lows = extrema(candles, false);
      if (type.indexOf('DOUBLE_TOP') >= 0) points = highs.slice(-2);
      else if (type.indexOf('DOUBLE_BOTTOM') >= 0) points = lows.slice(-2);
      else if (type.indexOf('HEAD_AND_SHOULDERS') >= 0 && type.indexOf('INVERSE') < 0) points = highs.slice(-3);
      else if (type.indexOf('INVERSE_HEAD') >= 0) points = lows.slice(-3);
      else if (type.indexOf('CUP') >= 0 && type.indexOf('INVERTED') < 0) {
        var left = candles.slice(0, Math.floor(candles.length*.35)).reduce(function (best,c,i) { return !best || c.high > best.value ? {index:i,value:Number(c.high)} : best; }, null);
        var bottomStart = Math.floor(candles.length*.2), bottomEnd = Math.floor(candles.length*.7);
        var bottom = candles.slice(bottomStart,bottomEnd).reduce(function (best,c,i) { return !best || c.low < best.value ? {index:bottomStart+i,value:Number(c.low)} : best; }, null);
        var rightStart = Math.floor(candles.length*.55);
        var right = candles.slice(rightStart).reduce(function (best,c,i) { return !best || c.high > best.value ? {index:rightStart+i,value:Number(c.high)} : best; }, null);
        points = [left,bottom,right].filter(Boolean);
      } else if (type.indexOf('INVERTED_CUP') >= 0) {
        var l = candles.slice(0, Math.floor(candles.length*.35)).reduce(function (best,c,i) { return !best || c.low < best.value ? {index:i,value:Number(c.low)} : best; }, null);
        var topStart = Math.floor(candles.length*.2), topEnd = Math.floor(candles.length*.7);
        var top = candles.slice(topStart,topEnd).reduce(function (best,c,i) { return !best || c.high > best.value ? {index:topStart+i,value:Number(c.high)} : best; }, null);
        var rStart = Math.floor(candles.length*.55);
        var r = candles.slice(rStart).reduce(function (best,c,i) { return !best || c.low < best.value ? {index:rStart+i,value:Number(c.low)} : best; }, null);
        points = [l,top,r].filter(Boolean);
      } else if (type.indexOf('GAP') >= 0) {
        points = [{ index:candles.length-2, value:Number(candles[candles.length-2].close) }, { index:candles.length-1, value:Number(candles[candles.length-1].close) }];
      } else {
        points = highs.slice(-2).concat(lows.slice(-2)).sort(function (a,b) { return a.index-b.index; });
      }
      var guide = sparse(candles.length, points);
      return {
        type:'line',
        data:{ labels:labels, datasets:[
          { label:'Harga penutupan', data:close, borderColor:'#94a3b8', backgroundColor:'rgba(148,163,184,.08)', borderWidth:2, pointRadius:0, tension:.12, fill:true },
          { label:'Titik pembentuk pola', data:guide, borderColor:'#38bdf8', backgroundColor:'#38bdf8', borderWidth:3, pointRadius:6, pointBorderWidth:2, pointBorderColor:'#082f49', spanGaps:true, tension:0 }
        ]},
        options:{ responsive:false, animation:false, interaction:{mode:'index',intersect:false}, layout:{padding:{top:8,right:18,bottom:8,left:8}}, plugins:{ title:{display:true,text:String(primary.label || 'Chart Pattern')+' · '+row.ticker+' · T-1 '+row.dataDate,color:'#f8fafc',font:{size:18,weight:'bold'},padding:{bottom:14}}, subtitle:{display:!!primary.reason,text:String(primary.reason || ''),color:'#94a3b8',font:{size:11}}, legend:{display:true,position:'top',labels:{color:'#cbd5e1',boxWidth:18,boxHeight:3,padding:12,font:{size:11}}}}, scales:{x:{type:'category',ticks:{color:'#8190a5',maxTicksLimit:12,maxRotation:0,autoSkip:true,font:{size:10}},grid:{color:'rgba(148,163,184,.08)'},border:{color:'rgba(148,163,184,.18)'}},y:{ticks:{color:'#8190a5',font:{size:10}},grid:{color:'rgba(148,163,184,.08)'},border:{color:'rgba(148,163,184,.18)'}}}}
      };
    }
    async function draw(ticker, button) {
      var row = state.rows.find(function (item) { return item.ticker === ticker; });
      var box = doc.getElementById('psMap-' + ticker);
      if (!row || !box) return;
      box.classList.add('open');
      if (state.urls[ticker]) { box.innerHTML = '<img src="' + state.urls[ticker] + '" alt="Pattern ' + esc(ticker) + '">'; return; }
      box.textContent = 'Menyusun visual pattern…';
      if (button) button.disabled = true;
      var controller = new AbortController();
      if (state.controllers[ticker]) state.controllers[ticker].abort();
      state.controllers[ticker] = controller;
      try {
        var config = row.candidate ? Ui.buildReliableChartConfig(row.candidate, row.context) : buildClassicConfig(row);
        if (!config) throw new Error('invalid_chart_config');
        var response = await root.fetch('https://quickchart.io/chart', { method:'POST', signal:controller.signal, headers:{'Content-Type':'application/json','Accept':'image/png'}, body:JSON.stringify({ version:'4', width:1200, height:700, devicePixelRatio:1, format:'png', backgroundColor:'#111827', chart:config }) });
        if (!response.ok) throw new Error('QuickChart HTTP ' + response.status);
        var blob = await response.blob();
        if (!blob || blob.size < 500) throw new Error('empty_chart_image');
        state.urls[ticker] = root.URL.createObjectURL(blob);
        box.innerHTML = '<img src="' + state.urls[ticker] + '" alt="Pattern ' + esc(ticker) + ' T-1 ' + esc(row.dataDate) + '">';
      } catch (error) {
        if (!error || error.name !== 'AbortError') box.textContent = 'Visual pattern belum dapat dimuat. Buka Chart tetap tersedia.';
      } finally {
        if (state.controllers[ticker] === controller) delete state.controllers[ticker];
        if (button) button.disabled = false;
      }
    }
    function openChart(ticker) {
      root.navigateTo('chart');
      var input = doc.getElementById('chartTickerInput');
      if (input) input.value = ticker;
      if (typeof root.loadChartPage === 'function') root.loadChartPage();
    }
    async function open() {
      if (!await access(true)) return false;
      show();
      if (!hydrateCache()) scan(false);
      return true;
    }

    addStyles(); page();
    root.navigateTo = function (name) {
      if (name === 'pattern') return open();
      hide();
      if (root.location && root.location.pathname === '/pattern') { try { root.history.replaceState({}, '', '/dashboard'); } catch (_) {} }
      return originalNavigate.apply(root, arguments);
    };
    if (originalLogout) root.logout = function () { state.allowed=false; state.checked=true; state.version+=1; clearImages(); clearCache(); hide(); removeNav(); return originalLogout.apply(root, arguments); };
    access(false).then(function (allowed) { if (allowed && root.location && root.location.pathname === '/pattern') open(); });
    root.setInterval(function () {
      if (!state.checked || root.PatternMapAdminAccess.isAllowed()) return;
      state.allowed=false; removeNav();
      var node=doc.getElementById('page-pattern');
      if (node && !node.classList.contains('hidden')) root.navigateTo('chart');
    }, 1000);
    root.addEventListener('focus', function () { access(true); });
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible') access(true); });
  }

  boot(0);
})(typeof window !== 'undefined' ? window : null);
