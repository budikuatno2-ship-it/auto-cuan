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
      var activeAlertsCount = 0;
      var upCount = 0;
      var downCount = 0;
      items.forEach(function (it) {
        if (it.alerts && it.alerts.length) {
          it.alerts.forEach(function (a) { if (a.is_active && !a.is_triggered) activeAlertsCount++; });
        }
        var c = Number(it.change_pct != null ? it.change_pct : (it.change || 0));
        if (c > 0) upCount++;
        else if (c < 0) downCount++;
      });
      if (countEl) countEl.innerHTML = items.length + ' <span class="mut" style="font-size:15px">saham</span>';
      if (alertCountEl) alertCountEl.textContent = activeAlertsCount;
      var upEl = document.getElementById('wlUpCount');
      if (upEl) upEl.textContent = upCount;
      var downEl = document.getElementById('wlDownCount');
      if (downEl) downEl.textContent = downCount;
      var timeStr = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ' WIB';
      var freshEl = document.getElementById('wlFreshness');
      if (freshEl) freshEl.innerHTML = '<b>Diperbarui</b> ' + timeStr;

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
      var isMatch = (btn.getAttribute('data-wl-filter') === _wlFilter) || (btn.dataset && btn.dataset.wlFilter === _wlFilter);
      if (isMatch) {
        btn.classList.add('on', 'active');
        btn.setAttribute('aria-selected', 'true');
        btn.setAttribute('aria-pressed', 'true');
      } else {
        btn.classList.remove('on', 'active');
        btn.setAttribute('aria-selected', 'false');
        btn.setAttribute('aria-pressed', 'false');
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
      container.innerHTML = '<div class="mut" style="padding:32px 20px;text-align:center">Tidak ada saham di filter ini.</div>';
      return;
    }

    // Canvas Table View (Watchlist.dc.html)
    var html = '<div class="tw wl-table-wrap" style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table class="tbl wl-table ac-table" style="min-width:920px">';
    html += '<thead><tr>';
    html += '<th>Ticker</th>';
    html += '<th class="r">Harga</th>';
    html += '<th class="r">Perubahan</th>';
    html += '<th>Alert</th>';
    html += '<th>Jarak ke alert</th>';
    html += '<th>Catatan pantauan</th>';
    html += '<th class="r">Aksi</th>';
    html += '</tr></thead><tbody>';

    filtered.forEach(function (item, idx) {
      var last = item.last_price ? Number(item.last_price).toLocaleString('id-ID') : '—';
      var chg = item.change_pct != null ? Number(item.change_pct) : null;
      var chgText = chg != null ? ((chg >= 0 ? '+' : '−') + Math.abs(chg).toFixed(2).replace('.', ',') + '%') : '—';
      var chgClass = chg != null ? (chg >= 0 ? 'pos' : 'neg') : 'mut';
      var compName = item.name || item.company_name || '';

      var hasAlert = false;
      var alertText = 'Tidak ada alert';
      var alertDot = 'm';
      var distText = '—';
      var proxWidth = 0;

      if (item.alerts && item.alerts.length) {
        var activeAlert = item.alerts.find(function (a) { return a.is_active && !a.is_triggered; }) || item.alerts[0];
        if (activeAlert) {
          hasAlert = true;
          var cond = String(activeAlert.condition_type || activeAlert.condition || '').toUpperCase();
          var targetPrice = activeAlert.target_price != null ? Number(activeAlert.target_price) : 0;
          var tFmt = targetPrice ? targetPrice.toLocaleString('id-ID') : '—';
          alertText = (cond === 'PRICE_ABOVE' || cond === 'ABOVE') ? ('Saat ≥ ' + tFmt) :
                      ((cond === 'PRICE_BELOW' || cond === 'BELOW') ? ('Saat ≤ ' + tFmt) :
                      (cond ? (cond + ' ' + tFmt) : ('Target ' + tFmt)));
          alertDot = 'g';
          if (item.last_price && targetPrice) {
            var dist = ((targetPrice - item.last_price) / item.last_price) * 100;
            distText = (dist >= 0 ? '+' : '−') + Math.abs(dist).toFixed(2).replace('.', ',') + '%';
            proxWidth = Math.min(100, Math.max(8, Math.round(100 - Math.abs(dist) * 10)));
          }
        }
      }

      var noteText = item.notes ? escapeHtml(item.notes) : '—';

      html += '<tr class="wl-row rise d' + Math.min(idx, 7) + '" data-ticker="' + escapeAttr(item.ticker) + '">';
      html += '  <td><span class="tk mono cursor-pointer" onclick="if(typeof navigateTo===\'function\')navigateTo(\'analisis\',null,\'' + escapeAttr(item.ticker) + '\')">' + escapeHtml(item.ticker) + '</span> <span class="mut" style="font-size:12px">' + escapeHtml(compName) + '</span></td>';
      html += '  <td class="r num mono" style="font-weight:600">' + last + '</td>';
      html += '  <td class="r num ' + chgClass + '" style="font-weight:600">' + chgText + '</td>';
      html += '  <td><span class="pill-st" style="font-weight:500"><span class="dot ' + alertDot + '"></span>' + escapeHtml(alertText) + '</span></td>';
      html += '  <td class="num mut">' + distText;
      if (hasAlert) {
        html += '<span class="prox"><i style="width:' + proxWidth + '%"></i></span>';
      }
      html += '  </td>';
      html += '  <td class="mut" style="white-space:normal;max-width:280px"><span data-action="edit-notes" data-ticker="' + escapeAttr(item.ticker) + '" class="cursor-pointer hover:underline" title="Klik untuk edit catatan">' + noteText + '</span></td>';
      html += '  <td class="r" style="white-space:nowrap">';
      html += '    <a class="ib" href="/analisis-saham?ticker=' + escapeAttr(item.ticker) + '" onclick="if(typeof navigateTo===\'function\'){navigateTo(\'analisis\',null,\'' + escapeAttr(item.ticker) + '\');return false;}" aria-label="Buka analisis ' + escapeAttr(item.ticker) + '"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 3v18h18M7 15l4-5 3 3 5-7"/></svg></a>';
      html += '    <button class="ib" onclick="window.toggleWatchlistTicker(\'' + escapeAttr(item.ticker) + '\', null, event)" aria-label="Hapus ' + escapeAttr(item.ticker) + ' dari watchlist"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button>';
      html += '  </td>';
      html += '</tr>';
    });

    html += '</tbody></table></div>';
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
      // Screener v2 detail: an outline/filled star icon instead of a glyph.
      if (btn.classList.contains('scr-star')) {
        btn.classList.toggle('on-star', active);
        btn.setAttribute('aria-pressed', String(active));
        btn.setAttribute('aria-label', (active ? 'Hapus ' : 'Simpan ') + clean + (active ? ' dari Watchlist' : ' ke Watchlist'));
        var icon = btn.querySelector('svg');
        if (icon) icon.setAttribute('fill', active ? 'currentColor' : 'none');
        return;
      }
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
        list.innerHTML = '<div class="text-center text-[var(--ac-loss,#dc2626)] text-xs py-6">' + escapeHtml((data && data.error) || 'Gagal memuat riwayat alert.') + '</div>';

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
