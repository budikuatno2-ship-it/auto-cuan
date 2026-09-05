(function () {
  'use strict';

  window.__AUTOCUAN_WATCHLIST_DATA__ = [];
  window.__AUTOCUAN_WATCHLIST_SET__ = new Set();
  var isLoading = false;
  var _wlFilter = 'all';

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttr(str) {
    if (str == null) return '';
    return String(str)
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function loadUserWatchlist(force) {
    var container = document.getElementById('watchlistContainer');
    var emptyState = document.getElementById('watchlistEmpty');
    var countEl = document.getElementById('wlTotalCount');
    var alertCountEl = document.getElementById('wlActiveAlertCount');

    if (isLoading && !force) return;
    isLoading = true;

    try {
      var res = await fetch('/api/sector-hot?action=watchlist', { credentials: 'same-origin' });
      var data = await res.json();

      if (!data || !data.success) {
        if (data && data.error && /login|sesi/i.test(data.error)) {
          if (container) container.innerHTML = '<div class="p-8 text-center text-gray-400">Silakan <a href="#" onclick="openLoginModal();return false;" class="text-emerald-400 underline font-semibold">Login</a> untuk melihat dan mengelola Watchlist Pribadi Anda.</div>';
          if (emptyState) emptyState.classList.add('hidden');
        }
        return;
      }

      var items = data.watchlist || [];
      window.__AUTOCUAN_WATCHLIST_DATA__ = items;
      window.__AUTOCUAN_WATCHLIST_SET__ = new Set(items.map(function (it) { return it.ticker; }));

      // Update metrics
      if (countEl) countEl.textContent = items.length;
      var activeAlertsCount = 0;
      items.forEach(function (it) {
        if (it.alerts && it.alerts.length) {
          it.alerts.forEach(function (a) { if (a.is_active && !a.is_triggered) activeAlertsCount++; });
        }
      });
      if (alertCountEl) alertCountEl.textContent = activeAlertsCount;

      renderWatchlistView(items);
      updateAllWatchlistStars();
    } catch (err) {
      console.error('Error loading watchlist:', err);
    } finally {
      isLoading = false;
    }
  }

  function filterWatchlist(filterName) {
    _wlFilter = filterName || 'all';
    var tabs = document.querySelectorAll('#watchlistFilterTabs button');
    tabs.forEach(function (btn) {
      if (btn.getAttribute('data-wl-filter') === _wlFilter) {
        btn.className = 'wl-filter-btn active px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 transition';
      } else {
        btn.className = 'wl-filter-btn px-2.5 py-1 rounded-lg text-xs font-medium text-gray-400 border border-dark-600/40 hover:text-gray-200 transition';
      }
    });
    renderWatchlistView(window.__AUTOCUAN_WATCHLIST_DATA__);
  }

  function renderWatchlistView(items) {
    var container = document.getElementById('watchlistContainer');
    var emptyState = document.getElementById('watchlistEmpty');
    if (!container) return;

    if (!items || !items.length) {
      container.innerHTML = '';
      if (emptyState) {
        emptyState.classList.remove('hidden');
        var emptyTitle = document.getElementById('watchlistEmptyTitle');
        var emptyDesc = document.getElementById('watchlistEmptyDesc');
        if (emptyTitle) emptyTitle.textContent = 'Watchlist Anda masih kosong.';
        if (emptyDesc) emptyDesc.textContent = 'Gunakan ikon bintang pada kartu Screener atau Modal Detail untuk menambahkan saham ke pantauan.';
      }
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    var filtered = items.filter(function (it) {
      if (_wlFilter === 'alert') {
        return it.alerts && it.alerts.some(function (a) { return a.is_active && !a.is_triggered; });
      }
      if (_wlFilter === 'gain') {
        return it.change_pct != null && Number(it.change_pct) > 0;
      }
      if (_wlFilter === 'loss') {
        return it.change_pct != null && Number(it.change_pct) < 0;
      }
      return true;
    });

    if (!filtered.length) {
      container.innerHTML = '<div class="py-10 text-center text-gray-500 text-xs"><div class="text-2xl mb-1.5">🔍</div><p class="font-medium text-gray-400">Tidak ada saham yang sesuai dengan filter ini.</p><p class="mt-1 text-gray-500">Coba pilih tab filter [Semua] untuk melihat seluruh daftar pantauan.</p></div>';
      return;
    }

    var html = '<div class="overflow-x-auto overflow-y-auto max-h-[540px] scrollbar-thin rounded-lg"><table class="w-full text-left text-xs border-collapse">';
    html += '<thead class="sticky top-0 bg-dark-800/95 backdrop-blur z-10 shadow-sm"><tr class="border-b border-dark-600/60 text-gray-400 uppercase tracking-wider">';
    html += '<th class="py-3 px-3 font-semibold">Ticker &amp; Catatan</th>';
    html += '<th class="py-3 px-3 font-semibold text-right">Harga</th>';
    html += '<th class="py-3 px-3 font-semibold text-right">Perubahan</th>';
    html += '<th class="py-3 px-3 font-semibold">Alert Aktif</th>';
    html += '<th class="py-3 px-3 font-semibold text-right">Aksi</th>';
    html += '</tr></thead><tbody class="divide-y divide-dark-700/40">';

    filtered.forEach(function (item) {
      var last = item.last_price ? Number(item.last_price).toLocaleString('id-ID') : '-';
      var chg = item.change_pct != null ? Number(item.change_pct) : null;
      var chgText = chg != null ? ((chg >= 0 ? '+' : '') + chg.toFixed(2) + '%') : '-';
      var chgColor = chg != null ? (chg > 0 ? '#34d399' : (chg < 0 ? '#f87171' : '#9ca3af')) : '#9ca3af';

      var alertsHtml = '';
      if (item.alerts && item.alerts.length) {
        alertsHtml = item.alerts.map(function (a) {
          var label = a.condition_type === 'PRICE_ABOVE' ? ('▲ > Rp' + Number(a.target_price).toLocaleString('id-ID')) :
                      (a.condition_type === 'PRICE_BELOW' ? ('▼ < Rp' + Number(a.target_price).toLocaleString('id-ID')) : a.condition_type);
          var statusBadge = a.is_triggered ?
            '<span class="px-1.5 py-0.5 rounded text-[10px] bg-gray-700 text-gray-400">Triggered</span>' :
            '<span class="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Aktif</span>';

          return '<div class="flex items-center gap-1.5 mb-1">' +
            '<span class="font-mono text-gray-300">' + label + '</span> ' + statusBadge +
            ' <button onclick="window.openEditAlertModal(\'' + a.id + '\', \'' + escapeAttr(item.ticker) + '\', \'' + a.condition_type + '\', ' + Number(a.target_price) + ')" class="text-gray-500 hover:text-amber-300 ml-1 text-xs" title="Edit Alert">✎</button>' +
            '<button onclick="window.deleteUserAlert(\'' + a.id + '\')" class="text-gray-500 hover:text-red-400 ml-0.5 text-xs" title="Hapus Alert">×</button></div>';
        }).join('');
      } else {
        alertsHtml = '<span class="text-gray-500 italic">Belum ada alert</span>';
      }

      var noteHtml = item.notes ?
        '<span onclick="window.openEditNotesModal(\'' + escapeAttr(item.ticker) + '\', \'' + escapeAttr(item.notes) + '\')" class="cursor-pointer text-[10px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded truncate max-w-[160px] hover:border-amber-500/40 transition" title="Klik untuk edit catatan: ' + escapeAttr(item.notes) + '">📝 ' + escapeHtml(item.notes) + '</span>' :
        '<button onclick="window.openEditNotesModal(\'' + escapeAttr(item.ticker) + '\', \'\')" class="text-[10px] text-gray-500 hover:text-amber-300 transition" title="Tambah catatan">+ Catatan</button>';

      html += '<tr class="hover:bg-dark-800/40 transition-colors">';
      html += '<td class="py-3 px-3 font-bold text-white text-sm"><div class="flex items-center gap-2 flex-wrap"><span>' + item.ticker + '</span>' + noteHtml + '</div></td>';
      html += '<td class="py-3 px-3 text-right font-medium text-gray-200">' + last + '</td>';
      html += '<td class="py-3 px-3 text-right font-semibold" style="color:' + chgColor + '">' + chgText + '</td>';
      html += '<td class="py-3 px-3">' + alertsHtml + '</td>';
      html += '<td class="py-3 px-3 text-right whitespace-nowrap">';
      html += '<button onclick="window.openEditNotesModal(\'' + escapeAttr(item.ticker) + '\', \'' + escapeAttr(item.notes || '') + '\')" class="px-2 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/25 rounded text-xs mr-1.5 transition-all" title="Edit Catatan">📝 Edit</button>';
      html += '<button onclick="window.openCreateAlertModal(\'' + escapeAttr(item.ticker) + '\')" class="px-2 py-1 bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 border border-blue-500/30 rounded text-xs mr-1.5 transition-all">+ Alert</button>';
      html += '<button onclick="window.toggleWatchlistTicker(\'' + escapeAttr(item.ticker) + '\', null, event)" class="px-2 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/25 rounded text-xs transition-all">Hapus</button>';
      html += '</td>';
      html += '</tr>';
    });

    html += '</tbody></table></div>';
    container.innerHTML = html;
  }

  async function toggleWatchlistTicker(ticker, notes, e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (!ticker) return;
    var clean = String(ticker).trim().toUpperCase();

    var isBookmarked = window.__AUTOCUAN_WATCHLIST_SET__.has(clean);

    try {
      if (isBookmarked) {
        var res = await fetch('/api/sector-hot?action=watchlist&ticker=' + encodeURIComponent(clean), {
          method: 'DELETE',
          credentials: 'same-origin'
        });
        var json = await res.json();
        if (json && json.success) {
          window.__AUTOCUAN_WATCHLIST_SET__.delete(clean);
          if (typeof showToast === 'function') showToast(clean + ' dihapus dari Watchlist.', 'info');
        }
      } else {
        var res = await fetch('/api/sector-hot?action=watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ ticker: clean, notes: notes || null })
        });
        var json = await res.json();
        if (json && json.success) {
          window.__AUTOCUAN_WATCHLIST_SET__.add(clean);
          if (typeof showToast === 'function') showToast('⭐ ' + clean + ' ditambahkan ke Watchlist!', 'success');
        } else if (json && json.error) {
          if (typeof showToast === 'function') showToast(json.error, 'warning');
        }
      }

      updateAllWatchlistStars();
      // If currently on watchlist page, reload
      var pageEl = document.getElementById('page-watchlist');
      if (pageEl && !pageEl.classList.contains('hidden')) {
        loadUserWatchlist(true);
      }
    } catch (err) {
      console.error('Error toggling watchlist:', err);
    }
  }

  function updateAllWatchlistStars() {
    var stars = document.querySelectorAll('.wl-star-btn');
    stars.forEach(function (btn) {
      var t = btn.getAttribute('data-ticker');
      if (!t) return;
      var clean = t.trim().toUpperCase();
      if (window.__AUTOCUAN_WATCHLIST_SET__.has(clean)) {
        btn.classList.add('active');
        btn.innerHTML = '★';
        btn.style.color = '#fbbf24';
      } else {
        btn.classList.remove('active');
        btn.innerHTML = '☆';
        btn.style.color = '#6b7280';
      }
    });
  }

  function setAlertModalMode(editingId) {
    var idInput = document.getElementById('wlAlertId');
    var title = document.getElementById('wlAlertModalTitle');
    var submitBtn = document.getElementById('wlAlertSubmitBtn');
    var tickerInput = document.getElementById('wlAlertTicker');
    if (idInput) idInput.value = editingId || '';
    if (title) title.textContent = editingId ? 'Edit Alert Harga' : 'Pasang Alert Harga';
    if (submitBtn) submitBtn.textContent = editingId ? 'Simpan Perubahan' : 'Simpan Alert';
    if (tickerInput) tickerInput.readOnly = !!editingId;
  }

  function openCreateAlertModal(ticker) {
    var modal = document.getElementById('wlAlertModal');
    var tickerInput = document.getElementById('wlAlertTicker');
    var typeInput = document.getElementById('wlAlertCondition');
    var priceInput = document.getElementById('wlAlertPrice');
    if (!modal) return;

    setAlertModalMode(null);
    if (tickerInput) tickerInput.value = ticker || '';
    if (typeInput) typeInput.value = 'PRICE_ABOVE';
    if (priceInput) priceInput.value = '';
    modal.classList.remove('hidden');
  }

  function openEditAlertModal(alertId, ticker, conditionType, targetPrice) {
    var modal = document.getElementById('wlAlertModal');
    var tickerInput = document.getElementById('wlAlertTicker');
    var typeInput = document.getElementById('wlAlertCondition');
    var priceInput = document.getElementById('wlAlertPrice');
    if (!modal) return;

    setAlertModalMode(alertId);
    if (tickerInput) tickerInput.value = ticker || '';
    if (typeInput) typeInput.value = conditionType || 'PRICE_ABOVE';
    if (priceInput) priceInput.value = targetPrice != null ? targetPrice : '';
    modal.classList.remove('hidden');
  }

  function closeCreateAlertModal() {
    var modal = document.getElementById('wlAlertModal');
    if (modal) modal.classList.add('hidden');
    setAlertModalMode(null);
  }

  async function submitCreateAlert() {
    var idInput = document.getElementById('wlAlertId');
    var tickerInput = document.getElementById('wlAlertTicker');
    var typeInput = document.getElementById('wlAlertCondition');
    var priceInput = document.getElementById('wlAlertPrice');

    var editingId = idInput ? idInput.value.trim() : '';
    var ticker = tickerInput ? tickerInput.value.trim().toUpperCase() : '';
    var cond = typeInput ? typeInput.value : 'PRICE_ABOVE';
    var price = priceInput ? Number(priceInput.value) : null;

    if (!ticker) {
      if (typeof showToast === 'function') showToast('Pilih ticker terlebih dahulu.', 'warning');
      return;
    }
    if (!price || price <= 0) {
      if (typeof showToast === 'function') showToast('Masukkan level harga target yang valid.', 'warning');
      return;
    }

    try {
      var url = editingId
        ? '/api/sector-hot?action=watchlist-alert&id=' + encodeURIComponent(editingId)
        : '/api/sector-hot?action=watchlist-alert';
      var res = await fetch(url, {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          ticker: ticker,
          condition_type: cond,
          target_price: price
        })
      });
      var json = await res.json();
      if (json && json.success) {
        if (typeof showToast === 'function') showToast(editingId ? ('Alert ' + ticker + ' berhasil diperbarui!') : ('Alert ' + ticker + ' berhasil dipasang!'), 'success');
        closeCreateAlertModal();
        loadUserWatchlist(true);
      } else {
        if (typeof showToast === 'function') showToast(json.error || 'Gagal menyimpan alert.', 'error');
      }
    } catch (err) {
      console.error('Error saving alert:', err);
    }
  }

  async function deleteUserAlert(alertId) {
    if (!alertId) return;
    try {
      var res = await fetch('/api/sector-hot?action=watchlist-alert&id=' + encodeURIComponent(alertId), {
        method: 'DELETE',
        credentials: 'same-origin'
      });
      var json = await res.json();
      if (json && json.success) {
        if (typeof showToast === 'function') showToast('Alert dibatalkan.', 'info');
        loadUserWatchlist(true);
      }
    } catch (err) {
      console.error('Error deleting alert:', err);
    }
  }

  function openEditNotesModal(ticker, currentNotes) {
    var modal = document.getElementById('wlNotesModal');
    var tickerInput = document.getElementById('wlNotesTicker');
    var tickerDisplay = document.getElementById('wlNotesTickerDisplay');
    var notesText = document.getElementById('wlNotesText');
    if (!modal) return;

    if (tickerInput) tickerInput.value = ticker || '';
    if (tickerDisplay) tickerDisplay.textContent = ticker || '';
    if (notesText) notesText.value = currentNotes || '';
    modal.classList.remove('hidden');
    if (notesText) {
      setTimeout(function () {
        try { notesText.focus(); } catch (_) {}
      }, 50);
    }
  }

  function closeEditNotesModal() {
    var modal = document.getElementById('wlNotesModal');
    if (modal) modal.classList.add('hidden');
  }

  async function saveWatchlistNotes() {
    var tickerInput = document.getElementById('wlNotesTicker');
    var notesText = document.getElementById('wlNotesText');
    var saveBtn = document.getElementById('wlNotesSaveBtn');
    var ticker = tickerInput ? tickerInput.value.trim().toUpperCase() : '';
    var notes = notesText ? notesText.value.trim() : '';

    if (!ticker) return;

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Menyimpan...'; }

    try {
      var res = await fetch('/api/sector-hot?action=watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ ticker: ticker, notes: notes || null })
      });
      var json = await res.json();
      if (json && json.success) {
        if (window.__AUTOCUAN_WATCHLIST_DATA__) {
          var found = window.__AUTOCUAN_WATCHLIST_DATA__.find(function (it) { return it.ticker === ticker; });
          if (found) found.notes = notes || null;
        }
        closeEditNotesModal();
        renderWatchlistView(window.__AUTOCUAN_WATCHLIST_DATA__);
        if (typeof showToast === 'function') showToast('Catatan ' + ticker + ' berhasil disimpan!', 'success');
      } else {
        if (typeof showToast === 'function') showToast(json.error || 'Gagal menyimpan catatan.', 'error');
      }
    } catch (err) {
      console.error('Error saving note:', err);
      if (typeof showToast === 'function') showToast('Gagal menghubungi server.', 'error');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Simpan'; }
    }
  }

  window.loadUserWatchlist = loadUserWatchlist;
  window.filterWatchlist = filterWatchlist;
  window.toggleWatchlistTicker = toggleWatchlistTicker;
  window.updateAllWatchlistStars = updateAllWatchlistStars;
  window.openCreateAlertModal = openCreateAlertModal;
  window.openEditAlertModal = openEditAlertModal;
  window.closeCreateAlertModal = closeCreateAlertModal;
  window.submitCreateAlert = submitCreateAlert;
  window.deleteUserAlert = deleteUserAlert;
  window.openEditNotesModal = openEditNotesModal;
  window.closeEditNotesModal = closeEditNotesModal;
  window.saveWatchlistNotes = saveWatchlistNotes;

  // Auto-init on DOM ready
  document.addEventListener('DOMContentLoaded', function () {
    loadUserWatchlist();
  });
})();