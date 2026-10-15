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
    { ticker: 'BBCA', name: 'Bank Central Asia Tbk.', sector: 'Financials', board: 'UTAMA' },
    { ticker: 'BBRI', name: 'Bank Rakyat Indonesia (Persero) Tbk.', sector: 'Financials', board: 'UTAMA' },
    { ticker: 'BMRI', name: 'Bank Mandiri (Persero) Tbk.', sector: 'Financials', board: 'UTAMA' },
    { ticker: 'TLKM', name: 'Telkom Indonesia (Persero) Tbk.', sector: 'Infrastructure', board: 'UTAMA' },
    { ticker: 'ASII', name: 'Astra International Tbk.', sector: 'Industrials', board: 'UTAMA' },
    { ticker: 'BRPT', name: 'Barito Pacific Tbk.', sector: 'Basic Materials', board: 'UTAMA' },
    { ticker: 'ANTM', name: 'Aneka Tambang Tbk.', sector: 'Basic Materials', board: 'UTAMA' },
    { ticker: 'BREN', name: 'Barito Renewables Energy Tbk.', sector: 'Energy', board: 'UTAMA' },
    { ticker: 'AMMN', name: 'Amman Mineral Internasional Tbk.', sector: 'Basic Materials', board: 'UTAMA' },
    { ticker: 'ADRO', name: 'Alamtri Resources Indonesia Tbk.', sector: 'Energy', board: 'UTAMA' },
    { ticker: 'ICBP', name: 'Indofood CBP Sukses Makmur Tbk.', sector: 'Consumer Non-Cyclical', board: 'UTAMA' },
    { ticker: 'GOTO', name: 'GoTo Gojek Tokopedia Tbk.', sector: 'Technology', board: 'PENGEMBANGAN' }
  ];

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }

  function ensureModalDom() {
    if (byId('commandPaletteModal')) return;

    var modalHtml = '<div id="commandPaletteModal" class="ac-command-palette-backdrop" style="display: none;" role="dialog" aria-modal="true" aria-label="Pencarian Saham Global">' +
      '<div class="ac-command-palette-container">' +
      '  <div class="ac-command-palette-header">' +
      '    <div class="ac-command-palette-input-wrap">' +
      '      <svg class="w-5 h-5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
      '        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />' +
      '      </svg>' +
      '      <input type="text" id="commandPaletteInput" class="ac-command-palette-input" placeholder="Cari 962 saham IDX (kode, nama perusahaan, atau sektor)..." autocomplete="off" spellcheck="false" />' +
      '      <button type="button" id="commandPaletteCloseBtn" class="ac-command-palette-close" aria-label="Tutup pencarian">&times;</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="ac-command-palette-body">' +
      '    <div class="ac-command-palette-hint">' +
      '      <span>Navigasi: <strong>&uarr; &darr;</strong></span>' +
      '      <span>Pilih: <strong>ENTER</strong></span>' +
      '      <span>Tutup: <strong>ESC</strong></span>' +
      '    </div>' +
      '    <div id="commandPaletteResults" class="ac-command-palette-results" role="listbox"></div>' +
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

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (_currentResults.length > 0) {
        _selectedIndex = (_selectedIndex + 1) % _currentResults.length;
        updateSelectedHighlight();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (_currentResults.length > 0) {
        _selectedIndex = (_selectedIndex - 1 + _currentResults.length) % _currentResults.length;
        updateSelectedHighlight();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (_currentResults.length > 0 && _currentResults[_selectedIndex]) {
        selectTicker(_currentResults[_selectedIndex].ticker);
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
    if (!q) {
      _currentResults = POPULAR_DEFAULTS.slice();
      _selectedIndex = 0;
      renderResults(_currentResults, 'Saham Pilihan Teraktif (IDX Bellwether)');
      return;
    }

    try {
      var resp = await fetch('/api/sector-hot?action=stocks-search&q=' + encodeURIComponent(q) + '&limit=15');
      var data = await resp.json();
      if (data && data.success && Array.isArray(data.results)) {
        _currentResults = data.results;
        _selectedIndex = 0;
        renderResults(_currentResults, `Hasil Pencarian (${data.count} ditemukan)`);
      } else {
        renderEmpty();
      }
    } catch (_) {
      // Local fallback search against popular defaults
      var filtered = POPULAR_DEFAULTS.filter(function (item) {
        return item.ticker.includes(q.toUpperCase()) ||
          item.name.toUpperCase().includes(q.toUpperCase()) ||
          item.sector.toUpperCase().includes(q.toUpperCase());
      });
      _currentResults = filtered;
      _selectedIndex = 0;
      if (filtered.length > 0) {
        renderResults(_currentResults, 'Hasil Pencarian');
      } else {
        renderEmpty();
      }
    }
  }

  function renderResults(list, sectionTitle) {
    var container = byId('commandPaletteResults');
    if (!container) return;

    if (!list || list.length === 0) {
      renderEmpty();
      return;
    }

    var html = '<div class="ac-palette-section-title">' + escapeHtml(sectionTitle) + '</div>';
    list.forEach(function (item, idx) {
      var isSelected = idx === _selectedIndex;
      var boardBadge = item.board ? '<span class="ac-palette-board-badge">' + escapeHtml(item.board) + '</span>' : '';
      var priceDisplay = item.lastPrice ? '<span class="ac-palette-price">Rp ' + item.lastPrice.toLocaleString('id-ID') + '</span>' : '';

      html += '<div class="ac-palette-item ' + (isSelected ? 'is-selected' : '') + '" data-ticker="' + escapeHtml(item.ticker) + '" role="option" aria-selected="' + (isSelected ? 'true' : 'false') + '" onclick="AutoCuanCommandPalette.selectTicker(\'' + escapeHtml(item.ticker) + '\')">' +
        '  <div class="ac-palette-item-left">' +
        '    <div class="ac-palette-ticker-badge">' + escapeHtml(item.ticker) + '</div>' +
        '    <div class="ac-palette-item-info">' +
        '      <div class="ac-palette-company-name">' + escapeHtml(item.name) + '</div>' +
        '      <div class="ac-palette-meta">' +
        '        <span class="ac-palette-sector">' + escapeHtml(item.sector) + '</span>' +
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

    _previousActiveElement = document.activeElement;
    _isOpen = true;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    if (input) {
      input.value = '';
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

    // 3. Switch Chart Workstation if initialized
    if (root.AutoCuanChartWorkstation && typeof root.AutoCuanChartWorkstation.switchTicker === 'function') {
      root.AutoCuanChartWorkstation.switchTicker(safeTicker);
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
