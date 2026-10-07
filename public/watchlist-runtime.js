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
  function watchlistFetch(url, options, forceRefresh) {
    if (forceRefresh) options = Object.assign({}, options, { cache: 'no-cache' });
    if (window.AutoCuanKeepAlive && typeof window.AutoCuanKeepAlive.cachedFetch === 'function') {
      return window.AutoCuanKeepAlive.cachedFetch(url, options, { revalidate: !!forceRefresh });
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
    var errorBanner = document.getElementById('wlErrorBanner');
    var refreshBtn = document.getElementById('wlRefreshBtn');

    if (isLoading) return;
    isLoading = true;
    var status = document.getElementById('wlRefreshStatus');
    if (!status && refreshBtn) {
      status = document.createElement('div');
      status.id = 'wlRefreshStatus';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.style.cssText = 'min-height:3em;font-size:12px;line-height:1.5;color:var(--ac-text-muted)';
      var page = document.getElementById('page-watchlist');
      if (page) page.insertBefore(status, page.children[1] || null);
    }
    if (status) status.textContent = 'Memperbarui watchlist…';
    if (refreshBtn) {
      refreshBtn.setAttribute('aria-busy', 'true');
      refreshBtn.disabled = true;
    }

    try {
      var res = await watchlistFetch('/api/sector-hot?action=watchlist', { credentials: 'same-origin' }, force);
      var data = await res.json();

      if (!data || !data.success) {
        if (status) status.textContent = 'Gagal memperbarui watchlist.';
        if (data && data.error && /login|sesi/i.test(data.error)) {
          if (container) {
            container.innerHTML = '<div class="wl-login-prompt">Silakan <a href="#" onclick="openLoginModal();return false;" class="wl-login-link">Login</a> untuk melihat dan mengelola Watchlist Pribadi Anda.</div>';
          }
          if (emptyState) emptyState.classList.add('hidden');
        } else if (window.__AUTOCUAN_WATCHLIST_DATA__ && window.__AUTOCUAN_WATCHLIST_DATA__.length) {
          // Keep prior valid list visible; show local non-destructive factual notice
          if (errorBanner) {
            errorBanner.textContent = 'Gagal memperbarui watchlist: ' + escapeHtml((data && data.error) || 'Terjadi gangguan koneksi.');
            errorBanner.classList.remove('hidden');
          }
        }
        return;
      }

      if (errorBanner) errorBanner.classList.add('hidden');

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
      if (status) status.textContent = force ? 'Diperbarui. Watchlist terbaru ditampilkan.' : 'Data watchlist tersedia.';
    } catch (err) {
      if (status) status.textContent = 'Gagal memperbarui watchlist.';
      console.error('Error loading watchlist:', err);
      if (window.__AUTOCUAN_WATCHLIST_DATA__ && window.__AUTOCUAN_WATCHLIST_DATA__.length) {
        if (errorBanner) {
          errorBanner.textContent = 'Gagal memperbarui watchlist. Menampilkan data tersimpan terakhir.';
          errorBanner.classList.remove('hidden');
        }
      }
    } finally {
      isLoading = false;
      if (refreshBtn) {
        refreshBtn.removeAttribute('aria-busy');
        refreshBtn.disabled = false;
      }
    }
  }

  function filterWatchlist(filterName) {
    _wlFilter = filterName || 'all';
    var tabs = document.querySelectorAll('#watchlistFilterTabs button');
    tabs.forEach(function (btn) {
      if (btn.getAttribute('data-wl-filter') === _wlFilter) {
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
      } else {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
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
      container.innerHTML = '<div class="wl-empty-filter"><div class="wl-empty-filter-icon">🔍</div><p class="wl-empty-filter-title">Tidak ada saham yang sesuai dengan filter ini.</p><p class="wl-empty-filter-sub">Coba pilih filter [Semua] untuk melihat seluruh daftar pantauan.</p></div>';
      return;
    }

    // 1. Desktop Table
    var html = '<div class="wl-table-wrap"><table class="wl-table ac-table">';
    html += '<thead><tr>';
    html += '<th>Ticker &amp; Catatan</th>';
    html += '<th class="text-right">Harga</th>';
    html += '<th class="text-right">Perubahan</th>';
    html += '<th>Alert Aktif</th>';
    html += '<th class="text-right">Aksi</th>';
    html += '</tr></thead><tbody>';

    filtered.forEach(function (item) {
      var last = item.last_price != null && isFinite(item.last_price) ? Number(item.last_price).toLocaleString('id-ID') : '—';
      var chg = item.change_pct != null && isFinite(item.change_pct) ? Number(item.change_pct) : null;
      var chgText = chg != null ? ((chg >= 0 ? '+' : '') + chg.toFixed(2) + '%') : '—';
      var chgClass = chg != null ? (chg > 0 ? 'ac-num-positive' : (chg < 0 ? 'ac-num-negative' : 'ac-num-neutral')) : 'ac-num-neutral';

      var alertsHtml = '';
      if (item.alerts && item.alerts.length) {
        alertsHtml = item.alerts.map(function (a) {
          var label = a.condition_type === 'PRICE_ABOVE' ? ('▲ > Rp' + Number(a.target_price).toLocaleString('id-ID')) :
                      (a.condition_type === 'PRICE_BELOW' ? ('▼ < Rp' + Number(a.target_price).toLocaleString('id-ID')) : a.condition_type);
          var statusBadge = a.is_triggered ?
            '<span class="wl-badge-triggered">Triggered</span>' :
            '<span class="wl-badge-active">Aktif</span>';

          return '<div class="wl-alert-row">' +
            '<span class="wl-alert-label">' + escapeHtml(label) + '</span> ' + statusBadge +
            ' <button onclick="window.openEditAlertModal(\'' + a.id + '\', \'' + escapeAttr(item.ticker) + '\', \'' + a.condition_type + '\', ' + Number(a.target_price) + ')" class="wl-icon-btn" title="Edit Alert">✎</button>' +
            '<button onclick="window.deleteUserAlert(\'' + a.id + '\')" class="wl-icon-btn wl-icon-danger" title="Hapus Alert">×</button></div>';
        }).join('');
      } else {
        alertsHtml = '<span class="wl-no-alert">Belum ada alert</span>';
      }

      var noteHtml = item.notes ?
        '<span data-action="edit-notes" data-ticker="' + escapeAttr(item.ticker) + '" class="wl-note-tag" title="Klik untuk edit catatan">📝 ' + escapeHtml(item.notes) + '</span>' :
        '<button type="button" data-action="edit-notes" data-ticker="' + escapeAttr(item.ticker) + '" class="wl-note-btn" title="Tambah catatan">+ Catatan</button>';

      html += '<tr class="wl-row">';
      html += '<td><div class="wl-ticker-cell"><span class="wl-ticker-symbol">' + escapeHtml(item.ticker) + '</span>' + noteHtml + '</div></td>';
      html += '<td class="text-right font-mono tabular-nums">' + last + '</td>';
      html += '<td class="text-right font-mono tabular-nums font-semibold ' + chgClass + '">' + chgText + '</td>';
      html += '<td>' + alertsHtml + '</td>';
      html += '<td class="text-right whitespace-nowrap">';
      html += '<button type="button" data-action="edit-notes" data-ticker="' + escapeAttr(item.ticker) + '" class="wl-action-btn" title="Edit Catatan">📝 Edit</button>';
      html += '<button onclick="window.openCreateAlertModal(\'' + escapeAttr(item.ticker) + '\')" class="wl-action-btn wl-action-alert">+ Alert</button>';
      html += '<button onclick="window.toggleWatchlistTicker(\'' + escapeAttr(item.ticker) + '\', null, event)" class="wl-action-btn wl-action-danger">Hapus</button>';
      html += '</td>';
      html += '</tr>';
    });

    html += '</tbody></table></div>';

    // 2. Mobile Decision Rows
    html += '<div class="wl-mobile-cards">';
    filtered.forEach(function (item) {
      var last = item.last_price != null && isFinite(item.last_price) ? Number(item.last_price).toLocaleString('id-ID') : '—';
      var chg = item.change_pct != null && isFinite(item.change_pct) ? Number(item.change_pct) : null;
      var chgText = chg != null ? ((chg >= 0 ? '+' : '') + chg.toFixed(2) + '%') : '—';
      var chgClass = chg != null ? (chg > 0 ? 'ac-num-positive' : (chg < 0 ? 'ac-num-negative' : 'ac-num-neutral')) : 'ac-num-neutral';

      var mobileAlertsHtml = '';
      if (item.alerts && item.alerts.length) {
        mobileAlertsHtml = item.alerts.map(function (a) {
          var label = a.condition_type === 'PRICE_ABOVE' ? ('▲ > Rp' + Number(a.target_price).toLocaleString('id-ID')) :
                      (a.condition_type === 'PRICE_BELOW' ? ('▼ < Rp' + Number(a.target_price).toLocaleString('id-ID')) : a.condition_type);
          var statusBadge = a.is_triggered ?
            '<span class="wl-badge-triggered">Triggered</span>' :
            '<span class="wl-badge-active">Aktif</span>';

          return '<div class="wl-alert-row">' +
            '<span class="wl-alert-label">' + escapeHtml(label) + '</span> ' + statusBadge +
            ' <button onclick="window.openEditAlertModal(\'' + a.id + '\', \'' + escapeAttr(item.ticker) + '\', \'' + a.condition_type + '\', ' + Number(a.target_price) + ')" class="wl-icon-btn" title="Edit Alert">✎</button>' +
            '<button onclick="window.deleteUserAlert(\'' + a.id + '\')" class="wl-icon-btn wl-icon-danger" title="Hapus Alert">×</button></div>';
        }).join('');
      } else {
        mobileAlertsHtml = '<span class="wl-no-alert">Belum ada alert</span>';
      }

      var mobileNoteHtml = item.notes ?
        '<div data-action="edit-notes" data-ticker="' + escapeAttr(item.ticker) + '" class="wl-mobile-note" title="Klik untuk edit catatan">📝 ' + escapeHtml(item.notes) + '</div>' :
        '<button type="button" data-action="edit-notes" data-ticker="' + escapeAttr(item.ticker) + '" class="wl-note-btn">+ Tambah Catatan</button>';

      html += '<div class="wl-mobile-card">';
      html += '  <div class="wl-mobile-card-top">';
      html += '    <div class="wl-mobile-card-symbol-wrap">';
      html += '      <span class="wl-mobile-ticker">' + escapeHtml(item.ticker) + '</span>';
      html += '    </div>';
      html += '    <div class="wl-mobile-card-price-wrap">';
      html += '      <span class="wl-mobile-price font-mono tabular-nums">' + last + '</span>';
      html += '      <span class="wl-mobile-change font-mono tabular-nums ' + chgClass + '">' + chgText + '</span>';
      html += '    </div>';
      html += '  </div>';
      html += '  <div class="wl-mobile-card-note">' + mobileNoteHtml + '</div>';
      html += '  <div class="wl-mobile-card-alerts">' + mobileAlertsHtml + '</div>';
      html += '  <div class="wl-mobile-card-actions">';
      html += '    <button type="button" data-action="edit-notes" data-ticker="' + escapeAttr(item.ticker) + '" class="wl-mobile-btn">📝 Catatan</button>';
      html += '    <button onclick="window.openCreateAlertModal(\'' + escapeAttr(item.ticker) + '\')" class="wl-mobile-btn wl-mobile-btn-alert">🔔 + Alert</button>';
      html += '    <button onclick="window.toggleWatchlistTicker(\'' + escapeAttr(item.ticker) + '\', null, event)" class="wl-mobile-btn wl-mobile-btn-danger">Hapus</button>';
      html += '  </div>';
      html += '</div>';
    });
    html += '</div>';

    container.innerHTML = html;
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
      var active = window.__AUTOCUAN_WATCHLIST_SET__.has(clean);
      btn.classList.toggle('active', active);
      btn.innerHTML = active ? '★' : '☆';
      btn.style.color = active ? 'var(--ac-warning)' : 'var(--ac-text-dim)';
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
    created: { label: 'Alert dibuat', icon: '🟢', colorClass: 'wl-hist-created' },
    updated: { label: 'Alert diubah', icon: '✏️', colorClass: 'wl-hist-updated' },
    deleted: { label: 'Alert dihapus', icon: '🗑️', colorClass: 'wl-hist-deleted' },
    triggered: { label: 'Alert ter-trigger', icon: '🔔', colorClass: 'wl-hist-triggered' }
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
    list.innerHTML = '<div class="wl-hist-loading">Memuat riwayat...</div>';

    try {
      var res = await fetch('/api/sector-hot?action=watchlist-alert-history', { credentials: 'same-origin' });
      var data = await res.json();

      if (!data || !data.success) {
        list.innerHTML = '<div class="wl-hist-error">' + escapeHtml((data && data.error) || 'Gagal memuat riwayat alert.') + '</div>';
        return;
      }

      var history = data.history || [];
      if (!history.length) {
        list.innerHTML = '<div class="wl-hist-empty">Belum ada riwayat perubahan alert.</div>';
        return;
      }

      list.innerHTML = history.map(function (h) {
        var meta = ALERT_HISTORY_ACTION_LABELS[h.action] || { label: h.action, icon: '📌', colorClass: 'wl-hist-default' };
        var priceText = h.target_price != null ? ('Rp' + Number(h.target_price).toLocaleString('id-ID')) : '—';
        return '<div class="wl-hist-card">' +
          '<span class="wl-hist-icon">' + meta.icon + '</span>' +
          '<div class="wl-hist-body">' +
            '<div class="wl-hist-header">' +
              '<span class="wl-hist-action ' + meta.colorClass + '">' + escapeHtml(meta.label) + '</span>' +
              '<span class="wl-hist-time">' + escapeHtml(formatHistoryTimestamp(h.created_at)) + '</span>' +
            '</div>' +
            '<div class="wl-hist-detail">' + escapeHtml(h.ticker) + (h.condition_type ? (' · ' + escapeHtml(h.condition_type) + ' @ ' + escapeHtml(priceText)) : '') + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    } catch (err) {
      list.innerHTML = '<div class="wl-hist-error">Gagal menghubungi server.</div>';
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
