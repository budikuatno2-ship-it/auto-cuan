// FCA (Full Call Auction) / Papan Pemantauan Khusus Stock Mapping
// ============================================================
// LEGACY FILE — kept for old UI compatibility only.
// This file is NOT the source of truth for board/FCA status.
// Source of truth: Supabase stock_boards table → exposed via /api/quote boardResult.
//
// Risk Guard and server-side analysis use ONLY boardResult from Supabase.
// This file is used ONLY by the frontend isFCAStock() for quick UI hints.
// If Supabase board data contradicts this file, Supabase wins.
//
// Corrections applied 2025-06:
//   - NAYZ removed: actual board = AKSELERASI (not Pemantauan Khusus)
//   - WMUU removed: actual board = PENGEMBANGAN (not Pemantauan Khusus, not FCA)
//
// Only keep tickers here if they are CONFIRMED Pemantauan Khusus / FCA
// from official BEI/IDX announcement AND verified in Supabase stock_boards.
// ============================================================
window.FCA_STOCKS = {
  "LUCK": { name: "Sentral Mitra Informatika Tbk.", reason: "Papan Pemantauan Khusus" },
  "MAHA": { name: "Mahaka Radio Integra Tbk.", reason: "Papan Pemantauan Khusus" },
  "RATU": { name: "Mitra Tirta Buwana Tbk.", reason: "Papan Pemantauan Khusus" },
  "ZBRA": { name: "Zebra Nusantara Tbk.", reason: "Papan Pemantauan Khusus" },
  "GHON": { name: "Gihon Telekomunikasi Indonesia Tbk.", reason: "Papan Pemantauan Khusus" },
  "CLAY": { name: "Citra Putra Realty Tbk.", reason: "Papan Pemantauan Khusus" },
  "KOTA": { name: "DMS Propertindo Tbk.", reason: "Papan Pemantauan Khusus" },
  "BOSS": { name: "Borneo Olah Sarana Sukses Tbk.", reason: "Papan Pemantauan Khusus" }
};

(function loadPatternRadar() {
  if (typeof document === 'undefined') return;
  function load() {
    if (document.querySelector('script[data-pattern-radar-loader]')) return;
    var script = document.createElement('script');
    script.src = '/pattern-radar.js?v=20260728-radar3';
    script.async = true;
    script.setAttribute('data-pattern-radar-loader', 'true');
    document.head.appendChild(script);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();

(function watchPatternRadarAccess() {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof window.setInterval !== 'function') return;
  window.setInterval(function () {
    var gate = window.PatternMapAdminAccess;
    if (!gate || typeof gate.isAllowed !== 'function' || gate.isAllowed()) return;
    ['patternRadarDesktopNav', 'patternRadarMobileNav'].forEach(function (id) {
      var nav = document.getElementById(id);
      if (nav) nav.remove();
    });
    var page = document.getElementById('page-pattern');
    if (!page || page.classList.contains('hidden')) return;
    page.classList.add('hidden');
    if (typeof window.navigateTo === 'function') window.navigateTo('chart');
  }, 1000);
})();

// Production hotfix: Pattern is a real standalone page and scans every unique
// ticker returned by the latest screeners. No fallback list and no fixed 60 cap.
(function installPatternRadarProductionFix(root) {
  'use strict';
  if (!root || !root.document) return;
  var doc = root.document;
  var state = { installed:false, loading:false, loaded:false, rows:[], total:0, version:0, urls:{}, managers:{} };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('id-ID', { maximumFractionDigits:2 }) : '—';
  }
  function placePage() {
    var page = doc.getElementById('page-pattern');
    var screen = doc.getElementById('dashboardScreen');
    if (!page || !screen) return page;
    var footer = screen.querySelector('footer');
    if (footer) screen.insertBefore(page, footer);
    return page;
  }
  function headers() {
    var h = {};
    try {
      h['X-User-Id'] = root.localStorage.getItem('autocuan_user_id') || '';
      h['X-Username'] = root.localStorage.getItem('autocuan_user') || '';
    } catch (_) {}
    return h;
  }
  async function json(url) {
    var response = await root.fetch(url, { credentials:'same-origin', cache:'no-store', headers:headers() });
    var data = await response.json().catch(function(){ return null; });
    return response.ok && data && data.success !== false ? data : null;
  }
  function rows(payload) {
    if (!payload || typeof payload !== 'object') return [];
    var keys = ['results','rows','data','picks','top5'];
    for (var i=0;i<keys.length;i++) if (Array.isArray(payload[keys[i]])) return payload[keys[i]];
    return [];
  }
  function uniqueTickers(payloads) {
    var seen = {}, out = [];
    payloads.forEach(function(payload){
      rows(payload).forEach(function(row){
        var ticker = String(row && (row.ticker || row.symbol || row.code) || '').trim().toUpperCase().replace(/\.JK$/, '');
        if (!/^[A-Z]{3,5}$/.test(ticker) || seen[ticker]) return;
        seen[ticker] = true;
        out.push(ticker);
      });
    });
    return out;
  }
  function clearMaps() {
    Object.keys(state.managers).forEach(function(t){ try { state.managers[t].cancel(); } catch (_) {} });
    Object.keys(state.urls).forEach(function(t){ try { root.URL.revokeObjectURL(state.urls[t]); } catch (_) {} });
    state.managers = {};
    state.urls = {};
  }
  function progress(done, total) {
    state.total = total;
    var status = doc.getElementById('patternRadarStatus');
    var count = doc.getElementById('patternRadarCount');
    var fill = doc.getElementById('patternRadarFill');
    if (status) status.textContent = state.loading ? ('Memindai ' + done + ' dari ' + total + ' saham Screener…') : (total ? ('Selesai memindai ' + total + ' saham Screener.') : 'Screener belum memiliki ticker untuk dipindai.');
    if (count) count.textContent = state.rows.length + ' pattern';
    if (fill) fill.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
  }
  function card(row) {
    var c = row.candidate;
    var direction = String(c.name || '').toLowerCase().indexOf('bullish') >= 0 ? 'bullish' : 'bearish';
    var status = c.status === 'confirmed' ? 'Terkonfirmasi' : 'Kandidat';
    return '<article class="pattern-radar-card ' + direction + '">' +
      '<div class="pattern-radar-card-head"><div><div class="pattern-radar-ticker">' + esc(row.ticker) + '</div><div class="pattern-radar-name">' + esc(c.name) + ' · T-1 ' + esc(row.dataDate) + '</div></div><span class="pattern-radar-badge">' + status + '</span></div>' +
      '<div class="pattern-radar-levels"><div class="pattern-radar-level"><span>Harga terakhir</span><b>' + num(c.currentPrice) + '</b></div><div class="pattern-radar-level"><span>Konfirmasi</span><b>' + num(c.confirmation) + '</b></div><div class="pattern-radar-level"><span>Invalidasi</span><b>' + num(c.invalidation) + '</b></div><div class="pattern-radar-level"><span>TP1</span><b>' + num(c.tp1) + '</b></div><div class="pattern-radar-level"><span>TP2</span><b>' + num(c.tp2) + '</b></div><div class="pattern-radar-level"><span>PRZ</span><b>' + num(c.prz && c.prz.low) + '–' + num(c.prz && c.prz.high) + '</b></div></div>' +
      '<div class="pattern-radar-card-actions"><button class="pattern-radar-button" data-fix-map="' + esc(row.ticker) + '">Lihat Peta</button><button class="pattern-radar-button secondary" data-fix-chart="' + esc(row.ticker) + '">Technical Chart</button></div><div id="patternFixMap-' + esc(row.ticker) + '" class="pattern-radar-map"></div></article>';
  }
  function render() {
    var grid = doc.getElementById('patternRadarGrid');
    var empty = doc.getElementById('patternRadarEmpty');
    state.rows.sort(function(a,b){
      var ac = a.candidate.status === 'confirmed' ? 1 : 0;
      var bc = b.candidate.status === 'confirmed' ? 1 : 0;
      return bc-ac || String(b.dataDate).localeCompare(String(a.dataDate)) || a.ticker.localeCompare(b.ticker);
    });
    if (grid) grid.innerHTML = state.rows.map(card).join('');
    if (empty) {
      empty.classList.toggle('hidden', state.rows.length > 0);
      if (!state.rows.length) empty.textContent = state.loading ? 'Sedang memindai seluruh saham dari Screener terbaru…' : (state.total ? 'Tidak ada ABCD valid pada hasil Screener saat ini.' : 'Belum ada ticker dari Screener yang dapat dipindai.');
    }
  }
  async function scan(force) {
    if (state.loading || (state.loaded && !force)) return;
    var gate = root.PatternMapAdminAccess;
    if (!gate || !await gate.refresh(true).catch(function(){ return false; }) || !gate.isAllowed()) return;
    var version = ++state.version;
    state.loading = true;
    state.loaded = false;
    state.rows = [];
    state.total = 0;
    clearMaps();
    render();
    var refresh = doc.getElementById('patternRadarRefresh');
    if (refresh) { refresh.disabled = true; refresh.textContent = 'Memindai…'; }
    try {
      var stamp = Date.now();
      var payloads = await Promise.all([
        json('/api/sector-hot?action=screener&t=' + stamp).catch(function(){return null;}),
        json('/api/sector-hot?action=nk-screener-results&t=' + stamp).catch(function(){return null;}),
        json('/api/sector-hot?action=daytrade-screener&t=' + stamp).catch(function(){return null;})
      ]);
      var tickers = uniqueTickers(payloads);
      state.total = tickers.length;
      progress(0, tickers.length);
      var next = 0, done = 0;
      async function worker() {
        while (next < tickers.length) {
          var ticker = tickers[next++];
          var data = await json('/api/candles?ticker=' + encodeURIComponent(ticker)).catch(function(){return null;});
          if (version !== state.version) return;
          if (data && data.patternMap && Array.isArray(data.candles) && root.PatternMap) {
            var context = { ticker:ticker, timeframe:'1D', dataDate:String(data.actual_data_date || data.patternMap.dataDate || ''), candles:data.candles };
            var validation = root.PatternMap.validateCandidate(data.patternMap, context);
            if (validation && validation.valid) {
              state.rows.push({ ticker:ticker, candidate:data.patternMap, context:context, dataDate:context.dataDate });
              render();
            }
          }
          done += 1;
          progress(done, tickers.length);
        }
      }
      await Promise.all([worker(),worker(),worker(),worker()]);
      if (version === state.version) state.loaded = true;
    } finally {
      if (version === state.version) {
        state.loading = false;
        progress(state.total, state.total);
        render();
        if (refresh) { refresh.disabled = false; refresh.textContent = 'Scan Ulang'; }
      }
    }
  }
  async function map(ticker, button) {
    var row = state.rows.find(function(r){ return r.ticker === ticker; });
    var box = doc.getElementById('patternFixMap-' + ticker);
    if (!row || !box || !root.PatternMap) return;
    box.classList.add('open');
    if (state.urls[ticker]) { box.innerHTML = '<img src="' + state.urls[ticker] + '" alt="Pattern Map ' + esc(ticker) + '">'; return; }
    box.textContent = 'Memuat peta pattern…';
    if (button) button.disabled = true;
    try {
      var manager = state.managers[ticker] || new root.PatternMap.RequestManager(root.fetch.bind(root));
      state.managers[ticker] = manager;
      var result = await manager.render(row.candidate, row.context);
      if (result && result.blob) {
        state.urls[ticker] = root.URL.createObjectURL(result.blob);
        box.innerHTML = '<img src="' + state.urls[ticker] + '" alt="Pattern Map ' + esc(ticker) + '">';
      } else box.textContent = result && result.message ? result.message : 'Pattern Map belum dapat dimuat.';
    } finally { if (button) button.disabled = false; }
  }
  function showPage(nativeNavigate) {
    nativeNavigate('chart');
    doc.querySelectorAll('.page-content').forEach(function(p){ p.classList.add('hidden'); });
    var page = placePage();
    if (page) page.classList.remove('hidden');
    doc.querySelectorAll('.nav-btn[data-page]').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-page') === 'pattern'); });
    try { root.history.replaceState({}, '', '/pattern'); } catch (_) {}
    root.scrollTo({ top:0, behavior:'smooth' });
  }
  function install() {
    if (state.installed || !doc.getElementById('page-pattern') || !root.PatternMapAdminAccess || !root.PatternMap) return false;
    state.installed = true;
    placePage();
    var oldNavigate = root.navigateTo;
    root.navigateTo = function(page) {
      if (page !== 'pattern') return oldNavigate.apply(root, arguments);
      return root.PatternMapAdminAccess.refresh(true).then(function(allowed){
        if (!allowed || !root.PatternMapAdminAccess.isAllowed()) return false;
        showPage(oldNavigate);
        scan(false);
        return true;
      });
    };
    var refresh = doc.getElementById('patternRadarRefresh');
    if (refresh) refresh.onclick = function(){ scan(true); };
    var page = doc.getElementById('page-pattern');
    page.addEventListener('click', function(event){
      var mapButton = event.target.closest('[data-fix-map]');
      if (mapButton) map(mapButton.getAttribute('data-fix-map'), mapButton);
      var chartButton = event.target.closest('[data-fix-chart]');
      if (chartButton) {
        var ticker = chartButton.getAttribute('data-fix-chart');
        oldNavigate('chart');
        var input = doc.getElementById('chartTickerInput');
        if (input) input.value = ticker;
        if (typeof root.loadChartPage === 'function') root.loadChartPage();
      }
    });
    return true;
  }
  function boot(attempt) {
    if (install()) return;
    if (attempt < 160) root.setTimeout(function(){ boot(attempt + 1); }, 50);
  }
  boot(0);
})(typeof window !== 'undefined' ? window : null);
