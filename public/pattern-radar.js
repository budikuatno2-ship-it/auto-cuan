(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var TICKER_RE = /^[A-Z]{3,5}$/;
  var MAX_SCAN = 60;
  var SCAN_CONCURRENCY = 4;
  var FALLBACK_TICKERS = [
    'BBCA','BBRI','BMRI','BBNI','BRIS','BBTN','TLKM','ASII','ANTM','ADRO',
    'AMMN','BREN','BRPT','MDKA','INCO','PTBA','ITMG','UNTR','PGAS','MEDC',
    'ESSA','TPIA','CUAN','PANI','DEWA','BUMI','BRMS','GOTO','BUKA','WIFI',
    'ICBP','INDF','KLBF','AMRT','CPIN','JPFA','MYOR','UNVR','ERAA','MAPI',
    'AKRA','SMGR','INTP','JSMR','EXCL','ISAT','INKP','TKIM','BSDE','CTRA',
    'PWON','ACES','AUTO','ARTO','NCKL','MBMA','HRUM','INDY','RAJA','ENRG'
  ];

  function normalizeTicker(value) {
    var ticker = String(value == null ? '' : value).trim().toUpperCase().replace(/\.JK$/, '');
    return TICKER_RE.test(ticker) ? ticker : null;
  }

  function rowsFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return [];
    var keys = ['results', 'rows', 'data', 'picks', 'top5'];
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(payload[keys[i]])) return payload[keys[i]];
    }
    return [];
  }

  function collectTickers(payloads, limit, fallback) {
    var seen = Object.create(null);
    var tickers = [];
    function add(value) {
      var ticker = normalizeTicker(value);
      if (!ticker || seen[ticker]) return;
      seen[ticker] = true;
      tickers.push(ticker);
    }
    (Array.isArray(payloads) ? payloads : []).forEach(function (payload) {
      rowsFromPayload(payload).forEach(function (row) {
        if (!row || typeof row !== 'object') return;
        add(row.ticker || row.symbol || row.code);
      });
    });
    if (tickers.length < 30) (fallback || FALLBACK_TICKERS).forEach(add);
    return tickers.slice(0, Number.isInteger(limit) && limit > 0 ? limit : MAX_SCAN);
  }

  function patternRowFromResponse(data, validator) {
    if (!data || data.success !== true || !data.patternMap || !Array.isArray(data.candles)) return null;
    var ticker = normalizeTicker(data.ticker || data.patternMap.ticker);
    var dataDate = String(data.actual_data_date || data.patternMap.dataDate || '');
    if (!ticker || !dataDate) return null;
    var context = { ticker: ticker, timeframe: '1D', dataDate: dataDate, candles: data.candles };
    var validation = typeof validator === 'function' ? validator(data.patternMap, context) : { valid: true };
    if (!validation || validation.valid !== true) return null;
    return {
      ticker: ticker,
      candidate: data.patternMap,
      context: context,
      dataDate: dataDate,
      t1Status: data.t1_status || 'unverified',
      currentPrice: data.patternMap.currentPrice,
      latest: data.latest || null
    };
  }

  function sortPatternRows(rows) {
    return (Array.isArray(rows) ? rows.slice() : []).sort(function (left, right) {
      var leftConfirmed = left && left.candidate && left.candidate.status === 'confirmed' ? 1 : 0;
      var rightConfirmed = right && right.candidate && right.candidate.status === 'confirmed' ? 1 : 0;
      if (rightConfirmed !== leftConfirmed) return rightConfirmed - leftConfirmed;
      var dateOrder = String(right.dataDate || '').localeCompare(String(left.dataDate || ''));
      return dateOrder || String(left.ticker || '').localeCompare(String(right.ticker || ''));
    });
  }

  async function mapBounded(items, concurrency, worker, onProgress) {
    var list = Array.isArray(items) ? items : [];
    var next = 0;
    var completed = 0;
    var results = new Array(list.length);
    var count = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
    async function runWorker() {
      while (next < list.length) {
        var index = next++;
        try { results[index] = await worker(list[index], index); }
        catch (_) { results[index] = null; }
        completed += 1;
        if (typeof onProgress === 'function') onProgress(completed, list.length, results[index]);
      }
    }
    await Promise.all(Array.from({ length: count }, runWorker));
    return results;
  }

  function install(root) {
    if (!root || !root.document || root.__AUTOCUAN_PATTERN_RADAR__) return;
    root.__AUTOCUAN_PATTERN_RADAR__ = true;

    var doc = root.document;
    var state = {
      installed: false,
      allowed: false,
      loading: false,
      loaded: false,
      scanned: 0,
      total: 0,
      rows: [],
      failures: 0,
      requestVersion: 0,
      managers: Object.create(null),
      urls: Object.create(null),
      originalNavigateTo: null,
      originalLogout: null,
      originalEnterApp: null
    };

    function escapeHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
        return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char];
      });
    }

    function number(value) {
      var n = Number(value);
      return Number.isFinite(n) ? n.toLocaleString('id-ID', { maximumFractionDigits: 2 }) : '—';
    }

    function statusLabel(status) {
      return status === 'confirmed' ? 'Terkonfirmasi' : 'Kandidat';
    }

    function directionClass(name) {
      return String(name || '').toLowerCase().indexOf('bullish') >= 0 ? 'bullish' : 'bearish';
    }

    function addStyles() {
      if (doc.getElementById('patternRadarStyles')) return;
      var style = doc.createElement('style');
      style.id = 'patternRadarStyles';
      style.textContent = [
        '#patternChartTab,#patternPageContainer{display:none!important}',
        '.desktop-header-chips{display:none!important}',
        '.pattern-radar-shell{background:linear-gradient(145deg,rgba(21,26,35,.76),rgba(11,14,20,.64));border:1px solid rgba(148,163,184,.14);border-radius:22px;padding:18px;box-shadow:0 18px 45px rgba(0,0,0,.22)}',
        '.pattern-radar-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}',
        '.pattern-radar-title{font-size:22px;font-weight:900;color:#f8fafc;letter-spacing:-.02em}',
        '.pattern-radar-sub{font-size:12px;color:#94a3b8;margin-top:4px;max-width:720px}',
        '.pattern-radar-actions{display:flex;gap:8px;flex-wrap:wrap}',
        '.pattern-radar-button{min-height:40px;border-radius:11px;padding:9px 13px;font-size:12px;font-weight:800;border:1px solid rgba(52,211,153,.28);color:#6ee7b7;background:rgba(16,185,129,.08)}',
        '.pattern-radar-button.secondary{border-color:rgba(148,163,184,.18);color:#cbd5e1;background:rgba(15,23,42,.58)}',
        '.pattern-radar-button:disabled{opacity:.5;cursor:not-allowed}',
        '.pattern-radar-progress{margin-top:14px;padding:12px 14px;border:1px solid rgba(148,163,184,.12);border-radius:14px;background:rgba(2,6,23,.38)}',
        '.pattern-radar-progress-row{display:flex;justify-content:space-between;gap:12px;font-size:11px;color:#94a3b8}',
        '.pattern-radar-track{height:7px;border-radius:999px;background:#151a23;overflow:hidden;margin-top:8px}',
        '.pattern-radar-fill{height:100%;width:0;background:linear-gradient(90deg,#10b981,#22d3ee);transition:width .18s ease}',
        '.pattern-radar-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px;margin-top:14px}',
        '.pattern-radar-card{min-width:0;border:1px solid rgba(148,163,184,.14);border-radius:17px;background:rgba(15,23,42,.52);padding:15px}',
        '.pattern-radar-card.bullish{border-color:rgba(52,211,153,.24)}',
        '.pattern-radar-card.bearish{border-color:rgba(248,113,113,.23)}',
        '.pattern-radar-card-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}',
        '.pattern-radar-ticker{font-size:20px;font-weight:950;color:#f8fafc}',
        '.pattern-radar-name{font-size:12px;color:#94a3b8;margin-top:1px}',
        '.pattern-radar-badge{display:inline-flex;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:850;border:1px solid rgba(96,165,250,.25);color:#93c5fd;background:rgba(59,130,246,.08);white-space:nowrap}',
        '.pattern-radar-levels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:13px}',
        '.pattern-radar-level{border:1px solid rgba(148,163,184,.10);border-radius:11px;padding:8px;background:rgba(2,6,23,.34)}',
        '.pattern-radar-level span{display:block;color:#64748b;font-size:9px;text-transform:uppercase;letter-spacing:.04em}',
        '.pattern-radar-level b{display:block;color:#e5e7eb;font-size:12px;margin-top:2px;overflow-wrap:anywhere}',
        '.pattern-radar-card-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',
        '.pattern-radar-map{display:none;margin-top:12px;min-height:160px;border-radius:13px;border:1px solid rgba(148,163,184,.12);background:rgba(2,6,23,.44);padding:10px;align-items:center;justify-content:center;color:#94a3b8;font-size:12px;text-align:center}',
        '.pattern-radar-map.open{display:flex}',
        '.pattern-radar-map img{width:100%;height:auto;max-height:620px;object-fit:contain;border-radius:9px}',
        '.pattern-radar-empty{margin-top:14px;padding:34px 18px;text-align:center;border:1px dashed rgba(148,163,184,.18);border-radius:16px;color:#94a3b8;background:rgba(2,6,23,.30)}',
        '@media(min-width:1024px) and (max-width:1279px){.desktop-nav{display:none!important}.mobile-nav-row{display:block!important}.header-account{margin-left:auto!important}}',
        '@media(min-width:1280px) and (max-width:1499px){.desktop-nav .nav-btn{padding:6px 8px!important;gap:4px!important;font-size:11px!important}}',
        '@media(max-width:760px){.pattern-radar-grid{grid-template-columns:1fr}.pattern-radar-levels{grid-template-columns:repeat(2,minmax(0,1fr))}.pattern-radar-shell{padding:14px}.pattern-radar-actions{width:100%}.pattern-radar-actions .pattern-radar-button{flex:1}}'
      ].join('');
      doc.head.appendChild(style);
    }

    function navButton(id, mobile) {
      var button = doc.createElement('button');
      button.id = id;
      button.type = 'button';
      button.className = 'nav-btn';
      button.setAttribute('data-page', 'pattern');
      button.setAttribute('aria-label', 'Pattern Radar');
      button.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 18l4-5 4 3 4-8 4 4M4 21h16"/></svg><span>Pattern</span>';
      button.onclick = function () { root.navigateTo('pattern'); };
      if (mobile) button.classList.add('flex-shrink-0');
      return button;
    }

    function insertBeforeChart(container, button) {
      if (!container || !button) return;
      var chart = container.querySelector('[data-page="chart"]');
      if (chart) container.insertBefore(button, chart);
      else container.appendChild(button);
    }

    function ensureNavigation() {
      if (!state.allowed) return;
      var desktop = doc.querySelector('.desktop-nav');
      var mobile = doc.getElementById('mainNav');
      if (desktop && !doc.getElementById('patternRadarDesktopNav')) insertBeforeChart(desktop, navButton('patternRadarDesktopNav', false));
      if (mobile && !doc.getElementById('patternRadarMobileNav')) insertBeforeChart(mobile, navButton('patternRadarMobileNav', true));
    }

    function removeNavigation() {
      ['patternRadarDesktopNav','patternRadarMobileNav'].forEach(function (id) {
        var element = doc.getElementById(id);
        if (element) element.remove();
      });
    }

    function pageMarkup() {
      return '<section class="pattern-radar-shell">' +
        '<div class="pattern-radar-head"><div><h2 class="pattern-radar-title">Pattern Radar</h2>' +
        '<p class="pattern-radar-sub">Menampilkan hanya saham dari hasil screener terbaru yang memiliki ABCD T-1 valid. Tidak ada pencarian ticker manual.</p></div>' +
        '<div class="pattern-radar-actions"><button id="patternRadarRefresh" class="pattern-radar-button">Scan Ulang</button><button id="patternRadarTechnical" class="pattern-radar-button secondary">Buka Technical Chart</button></div></div>' +
        '<div class="pattern-radar-progress"><div class="pattern-radar-progress-row"><span id="patternRadarStatus">Siap memindai.</span><span id="patternRadarCount">0 pattern</span></div><div class="pattern-radar-track"><div id="patternRadarFill" class="pattern-radar-fill"></div></div></div>' +
        '<div id="patternRadarGrid" class="pattern-radar-grid"></div><div id="patternRadarEmpty" class="pattern-radar-empty">Buka halaman ini untuk memindai saham dari Screener terbaru.</div>' +
        '</section>';
    }

    function ensurePage() {
      var page = doc.getElementById('page-pattern');
      if (!page) {
        page = doc.createElement('div');
        page.id = 'page-pattern';
        page.className = 'page-content hidden flex-1 max-w-[1200px] w-full mx-auto px-3 sm:px-5 py-4';
        page.setAttribute('data-premium-page', 'true');
        page.innerHTML = pageMarkup();
        var screen = doc.getElementById('dashboardScreen');
        if (screen) screen.appendChild(page);
        var refresh = doc.getElementById('patternRadarRefresh');
        var technical = doc.getElementById('patternRadarTechnical');
        if (refresh) refresh.onclick = function () { scan(true); };
        if (technical) technical.onclick = function () { root.navigateTo('chart'); };
        page.addEventListener('click', function (event) {
          var renderButton = event.target.closest('[data-pattern-render]');
          if (renderButton) renderMap(renderButton.getAttribute('data-pattern-render'), renderButton);
          var chartButton = event.target.closest('[data-pattern-chart]');
          if (chartButton) openTechnicalChart(chartButton.getAttribute('data-pattern-chart'));
        });
      }
      return page;
    }

    function setActiveNav(pageName) {
      doc.querySelectorAll('.nav-btn[data-page]').forEach(function (button) {
        button.classList.toggle('active', button.getAttribute('data-page') === pageName);
      });
    }

    function hidePatternPage() {
      var page = doc.getElementById('page-pattern');
      if (page) page.classList.add('hidden');
    }

    function showPatternPage() {
      doc.querySelectorAll('.page-content').forEach(function (page) { page.classList.add('hidden'); });
      var page = ensurePage();
      page.classList.remove('hidden');
      setActiveNav('pattern');
      if (typeof root.closeSidebar === 'function') root.closeSidebar();
      if (typeof root.scrollTo === 'function') root.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function clearRenderResources() {
      Object.keys(state.managers).forEach(function (ticker) {
        var manager = state.managers[ticker];
        if (manager && typeof manager.cancel === 'function') manager.cancel();
      });
      Object.keys(state.urls).forEach(function (ticker) {
        try { root.URL.revokeObjectURL(state.urls[ticker]); } catch (_) {}
      });
      state.managers = Object.create(null);
      state.urls = Object.create(null);
    }

    function teardown() {
      state.allowed = false;
      state.loaded = false;
      state.loading = false;
      state.rows = [];
      state.requestVersion += 1;
      clearRenderResources();
      hidePatternPage();
      removeNavigation();
    }

    async function verifyAccess(force) {
      var gate = root.PatternMapAdminAccess;
      if (!gate || typeof gate.refresh !== 'function') return false;
      var allowed = await gate.refresh(force === true).catch(function () { return false; });
      state.allowed = allowed === true && typeof gate.isAllowed === 'function' && gate.isAllowed() === true;
      if (state.allowed) ensureNavigation(); else teardown();
      return state.allowed;
    }

    function authHeaders() {
      var headers = {};
      try {
        headers['X-User-Id'] = root.localStorage.getItem('autocuan_user_id') || '';
        headers['X-Username'] = root.localStorage.getItem('autocuan_user') || '';
      } catch (_) {}
      return headers;
    }

    async function fetchJson(url) {
      var response = await root.fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: authHeaders() });
      var data = await response.json().catch(function () { return null; });
      if (!response.ok || !data || data.success === false) return null;
      return data;
    }

    async function loadUniverse() {
      var stamp = Date.now();
      var urls = [
        '/api/sector-hot?action=screener&t=' + stamp,
        '/api/sector-hot?action=nk-screener-results&t=' + stamp,
        '/api/sector-hot?action=daytrade-screener&t=' + stamp
      ];
      var payloads = await Promise.all(urls.map(function (url) { return fetchJson(url).catch(function () { return null; }); }));
      return collectTickers(payloads, MAX_SCAN, FALLBACK_TICKERS);
    }

    function progress(completed, total) {
      state.scanned = completed;
      state.total = total;
      var status = doc.getElementById('patternRadarStatus');
      var count = doc.getElementById('patternRadarCount');
      var fill = doc.getElementById('patternRadarFill');
      if (status) status.textContent = state.loading ? ('Memindai ' + completed + ' dari ' + total + ' saham…') : ('Selesai memindai ' + total + ' saham.');
      if (count) count.textContent = state.rows.length + ' pattern';
      if (fill) fill.style.width = (total ? Math.round(completed / total * 100) : 0) + '%';
    }

    function cardMarkup(row) {
      var c = row.candidate;
      var css = directionClass(c.name);
      return '<article class="pattern-radar-card ' + css + '" data-pattern-card="' + escapeHtml(row.ticker) + '">' +
        '<div class="pattern-radar-card-head"><div><div class="pattern-radar-ticker">' + escapeHtml(row.ticker) + '</div><div class="pattern-radar-name">' + escapeHtml(c.name) + ' · T-1 ' + escapeHtml(row.dataDate) + '</div></div><span class="pattern-radar-badge">' + escapeHtml(statusLabel(c.status)) + '</span></div>' +
        '<div class="pattern-radar-levels">' +
        '<div class="pattern-radar-level"><span>Harga terakhir</span><b>' + number(c.currentPrice) + '</b></div>' +
        '<div class="pattern-radar-level"><span>Konfirmasi</span><b>' + number(c.confirmation) + '</b></div>' +
        '<div class="pattern-radar-level"><span>Invalidasi</span><b>' + number(c.invalidation) + '</b></div>' +
        '<div class="pattern-radar-level"><span>TP1</span><b>' + number(c.tp1) + '</b></div>' +
        '<div class="pattern-radar-level"><span>TP2</span><b>' + number(c.tp2) + '</b></div>' +
        '<div class="pattern-radar-level"><span>PRZ</span><b>' + number(c.prz && c.prz.low) + '–' + number(c.prz && c.prz.high) + '</b></div></div>' +
        '<div class="pattern-radar-card-actions"><button class="pattern-radar-button" data-pattern-render="' + escapeHtml(row.ticker) + '">Lihat Peta</button><button class="pattern-radar-button secondary" data-pattern-chart="' + escapeHtml(row.ticker) + '">Technical Chart</button></div>' +
        '<div id="patternRadarMap-' + escapeHtml(row.ticker) + '" class="pattern-radar-map"></div></article>';
    }

    function renderRows() {
      var grid = doc.getElementById('patternRadarGrid');
      var empty = doc.getElementById('patternRadarEmpty');
      var rows = sortPatternRows(state.rows);
      if (grid) grid.innerHTML = rows.map(cardMarkup).join('');
      if (empty) {
        empty.classList.toggle('hidden', rows.length > 0);
        if (!rows.length) empty.textContent = state.loading ? 'Sedang memindai saham dari Screener terbaru…' : 'Tidak ada ABCD valid pada universe Screener saat ini. Coba Scan Ulang setelah data screener diperbarui.';
      }
      var count = doc.getElementById('patternRadarCount');
      if (count) count.textContent = rows.length + ' pattern';
    }

    async function scan(force) {
      if (state.loading) return;
      if (!await verifyAccess(force === true)) return;
      if (state.loaded && force !== true) return;
      var version = ++state.requestVersion;
      state.loading = true;
      state.loaded = false;
      state.rows = [];
      state.failures = 0;
      clearRenderResources();
      renderRows();
      var refresh = doc.getElementById('patternRadarRefresh');
      if (refresh) { refresh.disabled = true; refresh.textContent = 'Memindai…'; }
      try {
        var tickers = await loadUniverse();
        if (version !== state.requestVersion) return;
        state.total = tickers.length;
        progress(0, tickers.length);
        await mapBounded(tickers, SCAN_CONCURRENCY, async function (ticker) {
          var data = await fetchJson('/api/candles?ticker=' + encodeURIComponent(ticker));
          if (!data) { state.failures += 1; return null; }
          var validator = root.PatternMap && root.PatternMap.validateCandidate;
          var row = patternRowFromResponse(data, validator);
          if (row) {
            state.rows.push(row);
            renderRows();
          }
          return row;
        }, function (completed, total) {
          if (version === state.requestVersion) progress(completed, total);
        });
        if (version !== state.requestVersion) return;
        state.loaded = true;
      } finally {
        if (version === state.requestVersion) {
          state.loading = false;
          progress(state.total, state.total);
          renderRows();
          if (refresh) { refresh.disabled = false; refresh.textContent = 'Scan Ulang'; }
        }
      }
    }

    function findRow(ticker) {
      return state.rows.find(function (row) { return row.ticker === ticker; }) || null;
    }

    async function renderMap(ticker, button) {
      var row = findRow(ticker);
      var box = doc.getElementById('patternRadarMap-' + ticker);
      if (!row || !box || !root.PatternMap) return;
      box.classList.add('open');
      if (state.urls[ticker]) {
        box.innerHTML = '<img src="' + state.urls[ticker] + '" alt="Pattern Map ' + escapeHtml(ticker) + '">';
        return;
      }
      box.textContent = 'Memuat peta pattern…';
      if (button) button.disabled = true;
      try {
        var manager = state.managers[ticker] || new root.PatternMap.RequestManager(root.fetch.bind(root));
        state.managers[ticker] = manager;
        var result = await manager.render(row.candidate, row.context);
        if (result && result.blob) {
          var url = root.URL.createObjectURL(result.blob);
          state.urls[ticker] = url;
          box.innerHTML = '<img src="' + url + '" alt="Pattern Map ' + escapeHtml(ticker) + ' T-1 ' + escapeHtml(row.dataDate) + '">';
        } else box.textContent = result && result.message ? result.message : 'Pattern Map belum dapat dimuat.';
      } finally {
        if (button) button.disabled = false;
      }
    }

    function openTechnicalChart(ticker) {
      root.navigateTo('chart');
      var input = doc.getElementById('chartTickerInput');
      if (input) input.value = ticker;
      if (typeof root.loadChartPage === 'function') root.loadChartPage();
    }

    async function openPage() {
      if (!await verifyAccess(true)) return false;
      showPatternPage();
      scan(false);
      return true;
    }

    function wrapAppFunctions() {
      if (state.installed) return;
      state.installed = true;
      state.originalNavigateTo = typeof root.navigateTo === 'function' ? root.navigateTo : null;
      if (state.originalNavigateTo) {
        root.navigateTo = function (page) {
          if (page === 'pattern') return openPage();
          hidePatternPage();
          return state.originalNavigateTo.apply(root, arguments);
        };
      }
      state.originalLogout = typeof root.logout === 'function' ? root.logout : null;
      if (state.originalLogout) {
        root.logout = function () {
          teardown();
          return state.originalLogout.apply(root, arguments);
        };
      }
      state.originalEnterApp = typeof root.enterApp === 'function' ? root.enterApp : null;
      if (state.originalEnterApp) {
        root.enterApp = function () {
          var result = state.originalEnterApp.apply(root, arguments);
          Promise.resolve(result).finally(function () { verifyAccess(true); });
          return result;
        };
      }
    }

    function ready() {
      return doc.getElementById('dashboardScreen') && root.PatternMap && root.PatternMapAdminAccess && typeof root.navigateTo === 'function';
    }

    function boot(attempt) {
      if (!ready()) {
        if (attempt < 120) root.setTimeout(function () { boot(attempt + 1); }, 50);
        return;
      }
      addStyles();
      ensurePage();
      wrapAppFunctions();
      verifyAccess(false);
      root.addEventListener('focus', function () { verifyAccess(true); });
      root.addEventListener('storage', function (event) {
        if (!event || ['autocuan_logged_in','autocuan_user','autocuan_is_admin'].indexOf(event.key) < 0) return;
        verifyAccess(true);
      });
      doc.addEventListener('visibilitychange', function () {
        if (doc.visibilityState === 'visible') verifyAccess(true);
      });
    }

    boot(0);
  }

  return {
    normalizeTicker: normalizeTicker,
    rowsFromPayload: rowsFromPayload,
    collectTickers: collectTickers,
    patternRowFromResponse: patternRowFromResponse,
    sortPatternRows: sortPatternRows,
    mapBounded: mapBounded,
    install: install,
    constants: { MAX_SCAN: MAX_SCAN, SCAN_CONCURRENCY: SCAN_CONCURRENCY, FALLBACK_TICKERS: FALLBACK_TICKERS.slice() }
  };
});
