/**
 * Auto-Cuan Global Ticker Search Command Palette (Fase 7)
 * Shortcuts: '/' (when not in text input) or 'Ctrl+K' / 'Cmd+K'
 *
 * AntiSlop compliance:
 * - Zero em-dashes
 * - Accessible keyboard navigation (ArrowDown, ArrowUp, Enter, Escape)
 * - Trapped focus & return focus on close
 * - Bi-directional broadcast via custom event 'autocuan:ticker-select'
 */
(function (root) {
  'use strict';

  var _isOpen = false;
  var _selectedIndex = 0;
  var _currentResults = [];
  var _previousActiveElement = null;
  var _searchDebounceTimer = null;

  var POPULAR_DEFAULTS = [
    { ticker: 'IHSG', name: 'Indeks Harga Saham Gabungan (IDX Composite)', sector: 'Indeks Utama', board: 'IDX', lastPrice: null },
    { ticker: 'BBCA', name: 'Bank Central Asia Tbk.', sector: 'Keuangan', board: 'UTAMA', lastPrice: null },
    { ticker: 'BBRI', name: 'Bank Rakyat Indonesia (Persero) Tbk.', sector: 'Keuangan', board: 'UTAMA', lastPrice: null },
    { ticker: 'BMRI', name: 'Bank Mandiri (Persero) Tbk.', sector: 'Keuangan', board: 'UTAMA', lastPrice: null },
    { ticker: 'TLKM', name: 'Telkom Indonesia (Persero) Tbk.', sector: 'Infrastruktur', board: 'UTAMA', lastPrice: null },
    { ticker: 'ASII', name: 'Astra International Tbk.', sector: 'Perindustrian', board: 'UTAMA', lastPrice: null },
    { ticker: 'BRPT', name: 'Barito Pacific Tbk.', sector: 'Barang Baku', board: 'UTAMA', lastPrice: null },
    { ticker: 'ANTM', name: 'Aneka Tambang Tbk.', sector: 'Barang Baku', board: 'UTAMA', lastPrice: null },
    { ticker: 'BREN', name: 'Barito Renewables Energy Tbk.', sector: 'Energi', board: 'UTAMA', lastPrice: null },
    { ticker: 'AMMN', name: 'Amman Mineral Internasional Tbk.', sector: 'Barang Baku', board: 'UTAMA', lastPrice: null },
    { ticker: 'ADRO', name: 'Adaro Energy Indonesia Tbk.', sector: 'Energi', board: 'UTAMA', lastPrice: null },
    { ticker: 'ICBP', name: 'Indofood CBP Sukses Makmur Tbk.', sector: 'Konsumen Primer', board: 'UTAMA', lastPrice: null },
    { ticker: 'GOTO', name: 'GoTo Gojek Tokopedia Tbk.', sector: 'Teknologi', board: 'PENGEMBANGAN', lastPrice: null }
  ];
  var _localCtrlKIndex = null;
  var _localCtrlKFetching = null;
  function loadLocalCtrlKIndex() {
    if (_localCtrlKIndex) return Promise.resolve(_localCtrlKIndex);
    if (_localCtrlKFetching) return _localCtrlKFetching;
    _localCtrlKFetching = fetch('/cache/ctrlk-search-index.json', { cache: 'default' })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) {
        if (j && Array.isArray(j.items)) _localCtrlKIndex = j.items;
        return _localCtrlKIndex;
      });
    return _localCtrlKFetching;
  }

  var WORKSPACE_PAGES = [
    { page: 'dashboard', label: 'Dashboard', keywords: 'dashboard ringkasan ihsg utama' },
    { page: 'analisis', subTab: 'analisis-chart', label: 'Analisis & Chart', keywords: 'analisis chart workstation candlestick ai' },
    { page: 'screener', label: 'Screener Saham (Three-Horizon)', keywords: 'screener potensi besok short swing' },
    { page: 'sektor', label: 'Sektor Hot (Konglomerat)', keywords: 'sektor hot konglomerat prajogo djarum salim' },
    { page: 'analisis', subTab: 'bandarmologi', label: 'Bandarmologi & Broksum', keywords: 'bandarmologi broksum broker summary' },
    { page: 'analisis', subTab: 'hunter', label: 'Broker Hunter', keywords: 'broker hunter institusi akumulasi' },
    { page: 'analisis', subTab: 'intel', label: 'Sinyal Intelijen', keywords: 'sinyal intelijen anomali volume' },
    { page: 'analisis', subTab: 'insider', label: 'Jejaring Insider', keywords: 'insider jaringan kepemilikan pemegang saham' },
    { page: 'analisis', subTab: 'ranking', label: 'Ranking Harian', keywords: 'ranking harian klasemen pro' },
    { page: 'analisis', subTab: 'financial', label: 'Financial & Valuasi', keywords: 'financial laporan keuangan pbv q2' },
    { page: 'analisis', subTab: 'market-structure', label: 'Struktur Pasar KSEI', keywords: 'struktur pasar ksei free float hsc' },
    { page: 'analisis', subTab: 'pattern', label: 'Pattern Radar', keywords: 'pattern radar xabcd pola' },
    { page: 'watchlist', label: 'Watchlist & Alert', keywords: 'watchlist pantau alert telegram' },
    { page: 'portofolio', label: 'Portofolio', keywords: 'portofolio posisi trading plan' },
    { page: 'trackrecord', label: 'Track Record', keywords: 'track record riwayat sinyal' },
    { page: 'money-management', label: 'Kelola Keuangan', keywords: 'kelola keuangan anggaran cashflow' },
    { page: 'catatan-admin', label: 'Catatan Admin', keywords: 'catatan admin riset' },
    { page: 'news', label: 'Berita Saham', keywords: 'berita news emiten' },
    { page: 'admin-console', label: 'Admin Console', keywords: 'admin console kuota keamanan audit ksei' }
  ];

  function translateSector(sec) {
    if (!sec) return 'Keuangan';
    var map = {
      'Financials': 'Keuangan',
      'Finance': 'Keuangan',
      'Infrastructure': 'Infrastruktur',
      'Industrials': 'Perindustrian',
      'Basic Materials': 'Barang Baku',
      'Energy': 'Energi',
      'Technology': 'Teknologi',
      'Consumer Non-Cyclical': 'Konsumen Primer',
      'Consumer Non-Cyclicals': 'Konsumen Primer',
      'Consumer Cyclical': 'Konsumen Non-Primer',
      'Healthcare': 'Kesehatan',
      'Properties & Real Estate': 'Properti & Real Estat',
      'Transportation & Logistics': 'Transportasi & Logistik'
    };
    return map[sec] || sec;
  }

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }

  function ensureModalDom() {
    if (byId('commandPaletteModal')) return;

    var isMobile = typeof window !== 'undefined' && window.innerWidth <= 640;
    var ph = isMobile ? 'Cari 962 saham BEI...' : 'Cari 962 saham IDX (kode, nama perusahaan, atau sektor)...';

    var modalHtml = '<div id="commandPaletteModal" class="ac-command-palette-backdrop" style="display: none;" role="dialog" aria-modal="true" aria-label="Pencarian Saham Global">' +
      '<div class="ac-command-palette-container">' +
      '  <div class="ac-command-palette-header">' +
      '    <div class="ac-command-palette-input-wrap">' +
      '      <svg class="w-5 h-5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
      '        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />' +
      '      </svg>' +
      '      <input type="text" id="commandPaletteInput" class="ac-command-palette-input" placeholder="' + ph + '" autocomplete="off" spellcheck="false" style="background-color: #1e293b !important; color: #f8fafc !important; border: 1px solid #334155 !important;" />' +
      '      <button type="button" id="commandPaletteCloseBtn" class="ac-command-palette-close" aria-label="Tutup pencarian">&times;</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="ac-command-palette-body">' +
      '    <div class="ac-command-palette-hint">' +
      '      <span>Navigasi: <strong>&uarr; &darr;</strong></span>' +
      '      <span>Pilih: <strong>ENTER</strong></span>' +
      '      <span>Tutup: <strong>ESC</strong></span>' +
      '    </div>' +
      '    <div id="commandPaletteResults" class="ac-command-palette-results" role="listbox" style="padding-bottom: 36px !important;"></div>' +
      '  </div>' +
      '  <div class="ac-command-palette-footer">' +
      '    <span class="text-xs text-gray-400">Tekan <kbd class="px-1.5 py-0.5 rounded bg-dark-700 text-gray-300 font-mono text-[10px]">ESC</kbd> untuk keluar atau klik di luar kotak.</span>' +
      '    <span class="text-xs text-emerald-400 font-semibold">962 Saham Terindeks BEI</span>' +
      '  </div>' +
      '</div>' +
      '</div>';

    var div = document.createElement('div');
    div.innerHTML = modalHtml;
    document.body.appendChild(div.firstElementChild);

    // Event listeners for modal
    var modal = byId('commandPaletteModal');
    var input = byId('commandPaletteInput');
    var closeBtn = byId('commandPaletteCloseBtn');

    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) {
          close();
        }
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        close();
      });
    }

    if (input) {
      input.addEventListener('input', function () {
        clearTimeout(_searchDebounceTimer);
        _searchDebounceTimer = setTimeout(function () {
          performSearch(input.value);
        }, 120);
      });

      input.addEventListener('keydown', handleKeyNavigation);
    }
  }

  function handleKeyNavigation(e) {
    if (!_isOpen) return;
    var container = byId('commandPaletteResults');
    var allItems = container ? container.querySelectorAll('.ac-palette-item') : [];

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (allItems.length > 0) {
        _selectedIndex = (_selectedIndex + 1) % allItems.length;
        updateSelectedHighlight();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (allItems.length > 0) {
        _selectedIndex = (_selectedIndex - 1 + allItems.length) % allItems.length;
        updateSelectedHighlight();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var chosen = allItems[_selectedIndex];
      if (chosen) {
        var pgName = chosen.getAttribute('data-page');
        var tkName = chosen.getAttribute('data-ticker');
        if (pgName) {
          var subTab = chosen.getAttribute('data-subtab');
          close();
          if (typeof root.navigateTo === 'function') root.navigateTo(pgName, subTab || undefined);
          return;
        }
        if (tkName) {
          selectTicker(tkName);
          return;
        }
      }
      if (_currentResults.length > 0 && _currentResults[0]) {
        selectTicker(_currentResults[0].ticker);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function updateSelectedHighlight() {
    var container = byId('commandPaletteResults');
    if (!container) return;

    var items = container.querySelectorAll('.ac-palette-item');
    for (var i = 0; i < items.length; i++) {
      if (i === _selectedIndex) {
        items[i].classList.add('is-selected');
        items[i].setAttribute('aria-selected', 'true');
        items[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        items[i].classList.remove('is-selected');
        items[i].setAttribute('aria-selected', 'false');
      }
    }
  }

  async function performSearch(query) {
    var q = String(query || '').trim();
    var localIdx = await loadLocalCtrlKIndex();
    if (q && Array.isArray(localIdx) && localIdx.length > 0) {
      var qUp = q.toUpperCase();
      var qLo = q.toLowerCase();
      var exact = localIdx.filter(function (it) { return it.ticker === qUp; });
      var prefix = localIdx.filter(function (it) { return it.ticker !== qUp && it.ticker.indexOf(qUp) === 0; });
      var fuzzy = localIdx.filter(function (it) {
        return it.ticker !== qUp && it.ticker.indexOf(qUp) !== 0 && it.q && it.q.indexOf(qLo) >= 0;
      });
      var localHits = exact.concat(prefix, fuzzy).slice(0, 15).map(function (it) {
        return { ticker: it.ticker, name: it.name, sector: it.ticker === 'IHSG' ? 'Indeks Utama' : 'Emiten BEI', board: it.ticker === 'IHSG' ? 'IDX' : 'BEI', lastPrice: null };
      });
      if (localHits.length > 0 && qUp === 'IHSG') {
        _currentResults = localHits;
        _selectedIndex = 0;
        renderResults(_currentResults, 'Hasil Pencarian Indeks & Saham IDX');
        return;
      }
    }
    try {
      var resp = await fetch('/api/sector-hot?action=stocks-search&q=' + encodeURIComponent(q) + '&limit=15');
      var data = await resp.json();
      if (data && data.success && Array.isArray(data.results)) {
        var apiList = data.results.slice();
        if (q && /^ih/i.test(q) && !apiList.some(function (x) { return x.ticker === 'IHSG'; })) {
          apiList.unshift(POPULAR_DEFAULTS[0]);
        }
        _currentResults = apiList;
        _selectedIndex = 0;
        renderResults(_currentResults, q ? 'Hasil Pencarian Saham IDX' : 'Saham Pilihan Teraktif (SQLite IDX)');
        return;
      }
    } catch (_) {}

    if (!q) {
      _currentResults = POPULAR_DEFAULTS.slice();
      _selectedIndex = 0;
      renderResults(_currentResults, 'Saham Pilihan Teraktif (IDX Bellwether)');
      return;
    }

    var pool = (Array.isArray(localIdx) && localIdx.length > 0)
      ? localIdx.map(function (it) { return { ticker: it.ticker, name: it.name, sector: it.ticker === 'IHSG' ? 'Indeks Utama' : 'Emiten BEI', board: 'BEI', lastPrice: null }; })
      : POPULAR_DEFAULTS;
    var filtered = pool.filter(function (item) {
      return String(item.ticker || '').toUpperCase().includes(q.toUpperCase()) ||
        String(item.name || '').toUpperCase().includes(q.toUpperCase()) ||
        String(item.sector || '').toUpperCase().includes(q.toUpperCase());
    }).slice(0, 15);
    _currentResults = filtered;
    _selectedIndex = 0;
    renderResults(_currentResults, 'Hasil Pencarian');
  }

  function renderResults(list, sectionTitle) {
    var container = byId('commandPaletteResults');
    var qLower = String((byId('commandPaletteInput') && byId('commandPaletteInput').value) || '').trim().toLowerCase();
    var matchedPages = qLower ? WORKSPACE_PAGES.filter(function (p) {
      return p.label.toLowerCase().indexOf(qLower) >= 0 || p.keywords.indexOf(qLower) >= 0;
    }).slice(0, 5) : WORKSPACE_PAGES.slice(0, 4);

    if ((!list || list.length === 0) && matchedPages.length === 0) {
      renderEmpty();
      return;
    }

    var html = '';
    var flatIdx = 0;
    if (matchedPages.length > 0) {
      html += '<div class="ac-palette-section-title">Navigasi Halaman (19 Menu)</div>';
      matchedPages.forEach(function (pg) {
        var isSelPage = flatIdx === _selectedIndex;
        var subArg = pg.subTab ? (", '" + pg.subTab + "'") : '';
        html += '<div class="ac-palette-item' + (isSelPage ? ' is-selected' : '') + '" data-page="' + escapeHtml(pg.page) + '" data-subtab="' + escapeHtml(pg.subTab || '') + '" role="option" aria-selected="' + (isSelPage ? 'true' : 'false') + '" onclick="AutoCuanCommandPalette.close(); if(typeof navigateTo===\'function\') navigateTo(\'' + pg.page + '\'' + subArg + ');">' +
          '<div class="ac-palette-item-left"><div class="ac-palette-ticker-badge">HAL</div><div class="ac-palette-item-info"><div class="ac-palette-company-name">' + escapeHtml(pg.label) + '</div></div></div>' +
          '<div class="ac-palette-item-right"><span class="ac-palette-action-hint">Buka &rarr;</span></div></div>';
        flatIdx++;
      });
    }
    if (list && list.length > 0) {
      html += '<div class="ac-palette-section-title">' + escapeHtml(sectionTitle) + '</div>';
    }
    (list || []).forEach(function (item) {
      var isSelected = flatIdx === _selectedIndex;
      flatIdx++;
      var boardBadge = item.board ? '<span class="ac-palette-board-badge">' + escapeHtml(item.board) + '</span>' : '';
      var priceDisplay = (item.lastPrice != null && Number.isFinite(Number(item.lastPrice)) && Number(item.lastPrice) > 0)
        ? '<span class="ac-palette-price font-mono font-bold" style="color: #f8fafc !important;">Rp ' + Number(item.lastPrice).toLocaleString('id-ID') + '</span>'
        : '<span class="ac-palette-price text-xs text-gray-400">SQLite EOD</span>';

      html += '<div class="ac-palette-item ' + (isSelected ? 'is-selected' : '') + '" data-ticker="' + escapeHtml(item.ticker) + '" role="option" aria-selected="' + (isSelected ? 'true' : 'false') + '" onclick="AutoCuanCommandPalette.selectTicker(\'' + escapeHtml(item.ticker) + '\')">' +
        '  <div class="ac-palette-item-left">' +
        '    <div class="ac-palette-ticker-badge">' + escapeHtml(item.ticker) + '</div>' +
        '    <div class="ac-palette-item-info">' +
        '      <div class="ac-palette-company-name">' + escapeHtml(item.name) + '</div>' +
        '      <div class="ac-palette-meta">' +
        '        <span class="ac-palette-sector">' + escapeHtml(translateSector(item.sector)) + '</span>' +
        '        ' + boardBadge +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="ac-palette-item-right">' +
        '    ' + priceDisplay +
        '    <span class="ac-palette-action-hint">Pilih &rarr;</span>' +
        '  </div>' +
        '</div>';
    });

    container.innerHTML = html;
  }

  function renderEmpty() {
    var container = byId('commandPaletteResults');
    if (!container) return;
    container.innerHTML = '<div class="ac-palette-empty">' +
      '<svg class="w-8 h-8 mx-auto mb-2 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>' +
      '<p class="text-sm font-semibold text-gray-300">Tidak ada saham yang cocok</p>' +
      '<p class="text-xs text-gray-500 mt-1">Coba ketik 4 huruf ticker (misal: BBCA, TLKM) atau nama sektor.</p>' +
      '</div>';
  }

  function open() {
    ensureModalDom();
    var modal = byId('commandPaletteModal');
    var input = byId('commandPaletteInput');
    if (!modal) return;
    if (input) {
      var isMobile = typeof window !== 'undefined' && window.innerWidth <= 640;
      input.placeholder = isMobile ? 'Cari 962 saham BEI...' : 'Cari 962 saham IDX (kode, nama perusahaan, atau sektor)...';
    }

    _previousActiveElement = document.activeElement;
    _isOpen = true;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    if (input) {
      input.value = '';
      input.placeholder = (typeof window !== 'undefined' && window.innerWidth <= 640) ? 'Cari 962 saham BEI...' : 'Cari 962 saham IDX (kode, nama perusahaan, atau sektor)...';
      input.focus();
    }

    performSearch('');
  }

  function close() {
    var modal = byId('commandPaletteModal');
    if (!modal) return;

    _isOpen = false;
    modal.style.display = 'none';
    document.body.style.overflow = '';

    if (_previousActiveElement && typeof _previousActiveElement.focus === 'function') {
      try { _previousActiveElement.focus(); } catch (_) {}
    }
  }

  function selectTicker(ticker) {
    var safeTicker = String(ticker || '').trim().toUpperCase();
    if (!safeTicker) return;

    close();

    // 1. Dispatch custom bi-directional broadcast event
    var event = new CustomEvent('autocuan:ticker-select', {
      detail: { ticker: safeTicker, source: 'command-palette' },
      bubbles: true
    });
    window.dispatchEvent(event);

    // 2. Sync to UnifiedCockpit if present
    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(safeTicker, {
        loadChart: true,
        forceChartReload: true,
        preserveTab: false
      });
    }

    // 3. FIX-22: jump into the dedicated Chart Workstation lens and hand the
    // screener preset plus any known trading plan levels to the chart.
    var chartPreset = root.__acActiveScreenerPreset || 'simpel';
    var chartPlanLevels = null;
    try {
      if (Array.isArray(root.__acLastPresetResults)) {
        for (var _i = 0; _i < root.__acLastPresetResults.length; _i++) {
          var _row = root.__acLastPresetResults[_i];
          if (String(_row && _row.ticker || '').toUpperCase() === safeTicker) {
            var _eLow = Number(_row.entry_low || _row.entryLow || _row.buy_low);
            var _eHigh = Number(_row.entry_high || _row.entryHigh || _row.buy_high);
            var _e = Number(_row.entry || _row.last_price || _row.close || (_eHigh > 0 ? _eHigh : _eLow));
            var _sl = Number(_row.sl || _row.stop_loss || _row.stopLoss);
            var _tp1 = Number(_row.tp1 || _row.target1 || _row.tp1n);
            var _tp2 = Number(_row.tp2 || _row.target2 || _row.tp2n);
            if (Number.isFinite(_e) && _e > 0 && Number.isFinite(_sl) && _sl > 0 && Number.isFinite(_tp1) && _tp1 > 0) {
              chartPlanLevels = { entry: _e, sl: _sl, tp1: _tp1, tp2: Number.isFinite(_tp2) && _tp2 > 0 ? _tp2 : _tp1 };
            }
            break;
          }
        }
      }
    } catch (_) { chartPlanLevels = null; }

    if (typeof root.navigateTo === 'function') {
      try { root.navigateTo('analisis', 'chart'); } catch (_) {}
    }
    var chartTab = typeof document !== 'undefined' && document ? document.getElementById('tabChartWorkstation') : null;
    if (chartTab && typeof chartTab.click === 'function' && !chartTab.classList.contains('is-active')) {
      chartTab.click();
    }

    // Switch Chart Workstation with preset + plan levels if initialized
    if (root.AutoCuanChartWorkstation && typeof root.AutoCuanChartWorkstation.switchTicker === 'function') {
      root.AutoCuanChartWorkstation.switchTicker('mainChart', safeTicker, {
        preset: chartPreset,
        planLevels: chartPlanLevels,
        source: 'command-palette'
      });
    }

    // 4. Feedback toast
    if (typeof root.showToast === 'function') {
      root.showToast(`Konteks saham dialihkan ke ${safeTicker}`, 'info');
    }
  }

  // Global Keyboard Listener for shortcuts: '/' or 'Ctrl+K' / 'Cmd+K'
  window.addEventListener('keydown', function (e) {
    var target = e.target;
    var isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.tagName === 'SELECT');

    // Ctrl+K or Cmd+K
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (_isOpen) close();
      else open();
      return;
    }

    // '/' when not in input
    if (e.key === '/' && !isInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      open();
      return;
    }

    // Escape closes palette
    if (e.key === 'Escape' && _isOpen) {
      e.preventDefault();
      close();
    }
  });

  // Bi-directional listener: when another component selects a ticker, keep activeTicker synchronized
  window.addEventListener('autocuan:ticker-select', function (e) {
    if (e && e.detail && e.detail.ticker) {
      root.activeTicker = e.detail.ticker;
    }
  });

  // Expose public API
  root.AutoCuanCommandPalette = {
    open: open,
    close: close,
    isOpen: function () { return _isOpen; },
    selectTicker: selectTicker
  };

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
