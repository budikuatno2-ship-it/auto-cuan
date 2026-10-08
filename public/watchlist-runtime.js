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

  // KEEP-ALIVE: read through the shared SWR store when it is present. The
  // store is read-only for GETs, so every watchlist mutation below still goes
  // straight to the server and explicitly invalidates this key afterwards.
  function watchlistFetch(url, options) {
    if (window.AutoCuanKeepAlive && typeof window.AutoCuanKeepAlive.cachedFetch === 'function') {
      return window.AutoCuanKeepAlive.cachedFetch(url, options);
    }
    return fetch(url, options);
  }

  /** Called after a successful mutation so the next read cannot be stale. */
  function invalidateWatchlistCache() {
    if (window.AutoCuanKeepAlive && typeof window.AutoCuanKeepAlive.invalidate === 'function') {
      window.AutoCuanKeepAlive.invalidate('/api/sector-hot?action=watchlist');
    }
  }
  window.__AUTOCUAN_INVALIDATE_WATCHLIST__ = invalidateWatchlistCache;

  async function loadUserWatchlist(force) {
    var container = document.getElementById('watchlistContainer');
    var emptyState = document.getElementById('watchlistEmpty');
    var countEl = document.getElementById('wlTotalCount');
    var alertCountEl = document.getElementById('wlActiveAlertCount');

    if (isLoading && !force) return;
    isLoading = true;

    try {
      var res = await watchlistFetch('/api/sector-hot?action=watchlist', { credentials: 'same-origin' });
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
        btn.className = 'wl-filter-btn is-active ac-btn ac-btn-secondary text-xs py-1 px-2.5';
      } else {
        btn.className = 'wl-filter-btn ac-btn ac-btn-secondary text-xs py-1 px-2.5';
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
        if (emptyTitle) emptyTitle.textContent = 'Belum ada saham dalam Watchlist.';
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
      container.innerHTML = '<div class="py-10 text-center text-[var(--ac-text-muted,#6b7280)] text-xs"><div class="text-2xl mb-1.5">🔍</div><p class="font-medium text-[var(--ac-text-secondary,#9ca3af)]">Tidak ada saham yang sesuai dengan filter ini.</p><p class="mt-1 text-[var(--ac-text-muted,#6b7280)]">Coba pilih tab filter [Semua] untuk melihat seluruh daftar pantauan.</p></div>';
      return;
    }

    // Desktop Table View
    var tableHtml = '<div class="hidden sm:block overflow-x-auto overflow-y-auto max-h-[540px] scrollbar-thin rounded-lg"><table class="w-full text-left text-xs border-collapse">';
    tableHtml += '<thead class="sticky top-0 bg-[var(--ac-surface,#181d28)]/95 backdrop-blur z-10 shadow-sm"><tr class="border-b border-[var(--ac-line-hairline,#374151)] text-[var(--ac-text-secondary,#9ca3af)] uppercase tracking-wider text-[11px]">';
    tableHtml += '<th class="py-2.5 px-3 font-semibold text-center w-10 text-[var(--ac-text-muted,#6b7280)]">#</th>';
    tableHtml += '<th class="py-2.5 px-3 font-semibold">Ticker &amp; Catatan</th>';
    tableHtml += '<th class="py-2.5 px-3 font-semibold text-right">Harga</th>';
    tableHtml += '<th class="py-2.5 px-3 font-semibold text-right">Perubahan</th>';
    tableHtml += '<th class="py-2.5 px-3 font-semibold">Alert Aktif</th>';
    tableHtml += '<th class="py-2.5 px-3 font-semibold text-right">Aksi</th>';
    tableHtml += '</tr></thead><tbody class="divide-y divide-[var(--ac-line-hairline,#374151)]/30">';

    // Mobile Compact List View
    var mobileHtml = '<div class="sm:hidden space-y-2.5">';

    filtered.forEach(function (item, idx) {
      var last = item.last_price ? Number(item.last_price).toLocaleString('id-ID') : '—';
      var chg = item.change_pct != null ? Number(item.change_pct) : null;
      var chgText = chg != null ? ((chg >= 0 ? '+' : '') + chg.toFixed(2) + '%') : '—';
      var chgColor = chg != null ? (chg > 0 ? 'var(--ac-gain,#10b981)' : (chg < 0 ? 'var(--ac-loss,#ef4444)' : 'var(--ac-text-muted,#9ca3af)')) : 'var(--ac-text-muted,#9ca3af)';

      var alertsDesktopHtml = '';
      var alertsMobileHtml = '';
      if (item.alerts && item.alerts.length) {
        alertsDesktopHtml = item.alerts.map(function (a) {
          var cond = String(a.condition_type || a.condition || '').toUpperCase();
          var targetPrice = a.target_price != null ? Number(a.target_price).toLocaleString('id-ID') : '—';
          var label = (cond === 'PRICE_ABOVE' || cond === 'ABOVE') ? ('▲ > Rp' + targetPrice) :
                      ((cond === 'PRICE_BELOW' || cond === 'BELOW') ? ('▼ < Rp' + targetPrice) :
                      (cond ? (cond + ' Rp' + targetPrice) : ('Target Rp' + targetPrice)));
          var statusBadge = a.is_triggered ?
            '<span class="px-1.5 py-0.5 rounded text-[10px] bg-[var(--ac-surface-sunken,#374151)] text-[var(--ac-text-muted,#9ca3af)] border border-[var(--ac-line-hairline,#4b5563)]">Triggered</span>' :
            '<span class="px-1.5 py-0.5 rounded text-[10px] bg-[var(--ac-gain,#059669)]/15 text-[var(--ac-gain,#059669)] border border-[var(--ac-gain,#059669)]/30 font-medium">Aktif</span>';

          return '<div class="flex items-center gap-1.5 mb-1">' +
            '<span class="font-mono text-gray-300 tabular-nums">' + label + '</span> ' + statusBadge +
            ' <button onclick="window.openEditAlertModal(\'' + escapeAttr(a.id) + '\', \'' + escapeAttr(item.ticker) + '\', \'' + escapeAttr(a.condition_type || a.condition || 'PRICE_ABOVE') + '\', ' + Number(a.target_price || 0) + ')" class="text-gray-500 hover:text-amber-300 ml-1 text-xs" title="Edit Alert">✎</button>' +
            '<button onclick="window.deleteUserAlert(\'' + escapeAttr(a.id) + '\')" class="text-gray-500 hover:text-red-400 ml-0.5 text-xs" title="Hapus Alert">×</button></div>';
        }).join('');

        alertsMobileHtml = item.alerts.map(function (a) {
          var cond = String(a.condition_type || a.condition || '').toUpperCase();
          var targetPrice = a.target_price != null ? Number(a.target_price).toLocaleString('id-ID') : '—';
          var label = (cond === 'PRICE_ABOVE' || cond === 'ABOVE') ? ('> Rp' + targetPrice) :
                      ((cond === 'PRICE_BELOW' || cond === 'BELOW') ? ('< Rp' + targetPrice) :
                      ('Rp' + targetPrice));
          return '<span class="inline-flex items-center gap-1 text-[11px] font-mono tabular-nums text-[var(--ac-text-secondary,#9ca3af)]">' +
            '<span>' + label + '</span>' +
            (a.is_triggered ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-[var(--ac-surface-sunken,#374151)] text-[var(--ac-text-muted,#9ca3af)] border border-[var(--ac-line-hairline,#4b5563)]">Triggered</span>' : '<span class="text-[9px] px-1.5 py-0.5 rounded bg-[var(--ac-gain,#059669)]/15 text-[var(--ac-gain,#059669)] border border-[var(--ac-gain,#059669)]/30 font-medium">Aktif</span>') +
            '</span>';
        }).join(' ');
      } else {
        alertsDesktopHtml = '<span class="text-[var(--ac-text-muted,#6b7280)] italic">Belum ada alert</span>';
        alertsMobileHtml = '<span class="text-[var(--ac-text-muted,#6b7280)] text-[11px] italic">Belum ada alert</span>';
      }

      var noteText = item.notes ? escapeHtml(item.notes) : '';
      var noteDesktopHtml = item.notes ?
        '<span data-action="edit-notes" data-ticker="' + escapeAttr(item.ticker) + '" class="cursor-pointer text-[11px] text-[var(--ac-text-secondary,#9ca3af)] bg-[var(--ac-surface-3,#1f2937)] border border-[var(--ac-line-hairline,#374151)] px-2 py-0.5 rounded max-w-[220px] truncate hover:border-[var(--ac-line-default,#4b5563)] transition" title="Klik untuk edit catatan">' + noteText + '</span>' :
        '<button type="button" data-action="edit-notes" data-ticker="' + escapeAttr(item.ticker) + '" class="text-[11px] text-[var(--ac-text-muted,#6b7280)] hover:text-[var(--ac-text,#e5e7eb)] transition" title="Tambah catatan">+ Catatan</button>';

      var tickerBtn = '<button type="button" class="ticker-link font-bold text-[var(--text-primary,#ffffff)] hover:text-[var(--ac-primary,#10b981)] font-mono text-sm tracking-wide transition" onclick="if(typeof navigateTo===\'function\')navigateTo(\'analisis\',null,\'' + escapeAttr(item.ticker) + '\')" title="Buka Riset ' + escapeAttr(item.ticker) + '">' + escapeHtml(item.ticker) + '</button>';

      // Append Desktop Row
      tableHtml += '<tr class="hover:bg-[var(--ac-surface-hover,rgba(255,255,255,0.03))] transition-colors" data-ticker="' + escapeAttr(item.ticker) + '">';
      tableHtml += '<td class="py-2.5 px-3 text-center text-[var(--ac-text-secondary,#9ca3af)] font-mono text-[11px] tabular-nums lining-nums">' + (idx + 1) + '</td>';
      tableHtml += '<td class="py-2.5 px-3 font-bold text-[var(--text-primary,#ffffff)] text-sm"><div class="flex items-center gap-2 flex-wrap">' + tickerBtn + noteDesktopHtml + '</div></td>';
      tableHtml += '<td class="py-2.5 px-3 text-right font-medium text-[var(--text-primary,#e5e7eb)] font-mono tabular-nums lining-nums">' + last + '</td>';
      tableHtml += '<td class="py-2.5 px-3 text-right font-semibold font-mono tabular-nums lining-nums" style="color:' + chgColor + '">' + chgText + '</td>';
      tableHtml += '<td class="py-2.5 px-3">' + alertsDesktopHtml + '</td>';
      tableHtml += '<td class="py-2.5 px-3 text-right whitespace-nowrap">';
      tableHtml += '<button type="button" data-action="edit-notes" data-ticker="' + escapeAttr(item.ticker) + '" class="ac-btn ac-btn-secondary text-xs py-1 px-2.5 mr-1.5" title="Edit Catatan">Edit</button>';
      tableHtml += '<button onclick="window.openCreateAlertModal(\'' + escapeAttr(item.ticker) + '\')" class="ac-btn ac-btn-secondary text-xs py-1 px-2.5 mr-1.5">+ Alert</button>';
      tableHtml += '<button onclick="window.toggleWatchlistTicker(\'' + escapeAttr(item.ticker) + '\', null, event)" class="px-2.5 py-1 bg-red-500/10 hover:bg-red-500/20 text-[var(--ac-loss,#dc2626)] border border-red-500/25 rounded-md text-xs transition-all">Hapus</button>';
      tableHtml += '</td>';
      tableHtml += '</tr>';

      // Append Mobile Compact Card
      mobileHtml += '<div class="ac-surface-bounded p-3 space-y-2" data-ticker="' + escapeAttr(item.ticker) + '">';
      mobileHtml += '<div class="flex items-center justify-between gap-2">';
      mobileHtml += '<div class="flex items-center gap-2">';
      mobileHtml += '<span class="text-xs text-[var(--ac-text-muted,#6b7280)] font-mono tabular-nums lining-nums w-4 text-center">' + (idx + 1) + '</span>';
      mobileHtml += tickerBtn;
      mobileHtml += '</div>';
      mobileHtml += '<div class="flex items-baseline gap-2 font-mono tabular-nums lining-nums text-right">';
      mobileHtml += '<span class="text-sm font-semibold text-[var(--text-primary,#ffffff)]">' + last + '</span>';
      mobileHtml += '<span class="text-xs font-bold" style="color:' + chgColor + '">' + chgText + '</span>';
      mobileHtml += '</div>';
      mobileHtml += '</div>';

      if (item.notes) {
        mobileHtml += '<div data-action="edit-notes" data-ticker="' + escapeAttr(item.ticker) + '" class="cursor-pointer text-xs text-[var(--ac-text-secondary,#9ca3af)] bg-[var(--ac-surface-3,#1f2937)] px-2.5 py-1.5 rounded border border-[var(--ac-line-hairline,#374151)] leading-relaxed hover:border-[var(--ac-line-default,#4b5563)] transition" title="Klik untuk edit catatan">' + noteText + '</div>';
      }

      mobileHtml += '<div class="flex items-center justify-between gap-2 pt-1 border-t border-[var(--ac-line-hairline,#374151)]/40 text-xs">';
      mobileHtml += '<div class="flex items-center gap-1.5 overflow-hidden">' + alertsMobileHtml + '</div>';
      mobileHtml += '<div class="flex items-center gap-1 flex-shrink-0">';
      mobileHtml += '<button type="button" data-action="edit-notes" data-ticker="' + escapeAttr(item.ticker) + '" class="ac-btn ac-btn-secondary text-[11px] py-0.5 px-2">Edit</button>';
      mobileHtml += '<button onclick="window.openCreateAlertModal(\'' + escapeAttr(item.ticker) + '\')" class="ac-btn ac-btn-secondary text-[11px] py-0.5 px-2">+ Alert</button>';
      mobileHtml += '<button onclick="window.toggleWatchlistTicker(\'' + escapeAttr(item.ticker) + '\', null, event)" class="px-2 py-0.5 bg-red-500/10 hover:bg-red-500/20 text-[var(--ac-loss,#dc2626)] border border-red-500/25 rounded text-[11px]">Hapus</button>';
      mobileHtml += '</div>';
      mobileHtml += '</div>';
      mobileHtml += '</div>';
    });

    tableHtml += '</tbody></table></div>';
    mobileHtml += '</div>';

    container.innerHTML = tableHtml + mobileHtml;
    if (container && !container.__notesDelegationBound) {
      container.__notesDelegationBound = true;
      container.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action="edit-notes"]');
        if (btn) {
          e.preventDefault();
          e.stopPropagation();
          var t = btn.getAttribute('data-ticker');
          openEditNotesModal(t);
        }
      });
    }
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

      // KEEP-ALIVE: the write above bypassed the store (non-GET), so the cached
      // read is now known-stale. Drop it before anything can read it back.
      invalidateWatchlistCache();

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
        invalidateWatchlistCache();
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
        invalidateWatchlistCache();
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

    if (currentNotes === undefined && window.__AUTOCUAN_WATCHLIST_DATA__) {
      var item = window.__AUTOCUAN_WATCHLIST_DATA__.find(function (it) { return it.ticker === ticker; });
      if (item) currentNotes = item.notes;
    }

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
        invalidateWatchlistCache();
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

  var ALERT_HISTORY_ACTION_LABELS = {
    created: { label: 'Alert dibuat', icon: '🟢', color: 'text-emerald-400' },
    updated: { label: 'Alert diubah', icon: '✏️', color: 'text-blue-400' },
    deleted: { label: 'Alert dihapus', icon: '🗑️', color: 'text-red-400' },
    triggered: { label: 'Alert ter-trigger', icon: '🔔', color: 'text-amber-400' }
  };

  function formatHistoryTimestamp(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short'
      }).format(d) + ' WIB';
    } catch (_) { return '—'; }
  }

  async function openAlertHistoryModal() {
    var modal = document.getElementById('wlAlertHistoryModal');
    var list = document.getElementById('wlAlertHistoryList');
    if (!modal || !list) return;
    modal.classList.remove('hidden');
    list.innerHTML = '<div class="text-center text-gray-500 text-xs py-6">Memuat riwayat...</div>';

    try {
      var res = await fetch('/api/sector-hot?action=watchlist-alert-history', { credentials: 'same-origin' });
      var data = await res.json();

      if (!data || !data.success) {
        list.innerHTML = '<div class="text-center text-[var(--ac-loss,#dc2626)] text-xs py-6">' + escapeHtml((data && data.error) || 'Gagal memuat riwayat alert.') + '</div>';
        return;
      }

      var history = data.history || [];
      if (!history.length) {
        list.innerHTML = '<div class="text-center text-gray-500 text-xs py-6">Belum ada riwayat perubahan alert.</div>';
        return;
      }

      list.innerHTML = history.map(function (h) {
        var meta = ALERT_HISTORY_ACTION_LABELS[h.action] || { label: h.action, icon: '📌', color: 'text-gray-400' };
        var priceText = h.target_price != null ? ('Rp' + Number(h.target_price).toLocaleString('id-ID')) : '—';
        return '<div class="flex items-start gap-2.5 p-2.5 rounded-xl bg-dark-800/60 border border-dark-600/30">' +
          '<span class="text-base leading-none mt-0.5">' + meta.icon + '</span>' +
          '<div class="min-w-0 flex-1">' +
            '<div class="flex items-center justify-between gap-2">' +
              '<span class="text-xs font-semibold ' + meta.color + '">' + escapeHtml(meta.label) + '</span>' +
              '<span class="text-[10px] text-gray-500 flex-shrink-0">' + escapeHtml(formatHistoryTimestamp(h.created_at)) + '</span>' +
            '</div>' +
            '<div class="text-[11px] text-gray-400 mt-0.5">' + escapeHtml(h.ticker) + (h.condition_type ? (' · ' + escapeHtml(h.condition_type) + ' @ ' + escapeHtml(priceText)) : '') + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    } catch (err) {
      list.innerHTML = '<div class="text-center text-red-400 text-xs py-6">Gagal menghubungi server.</div>';
    }
  }

  function closeAlertHistoryModal() {
    var modal = document.getElementById('wlAlertHistoryModal');
    if (modal) modal.classList.add('hidden');
  }

  window.openAlertHistoryModal = openAlertHistoryModal;
  window.closeAlertHistoryModal = closeAlertHistoryModal;
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