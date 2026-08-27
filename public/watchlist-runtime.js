(function () {
  'use strict';

  window.__AUTOCUAN_WATCHLIST_DATA__ = [];
  window.__AUTOCUAN_WATCHLIST_SET__ = new Set();
  var isLoading = false;

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

  function renderWatchlistView(items) {
    var container = document.getElementById('watchlistContainer');
    var emptyState = document.getElementById('watchlistEmpty');
    if (!container) return;

    if (!items || !items.length) {
      container.innerHTML = '';
      if (emptyState) emptyState.classList.remove('hidden');
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    var html = '<div class="overflow-x-auto"><table class="w-full text-left text-xs border-collapse">';
    html += '<thead><tr class="border-b border-dark-600/60 text-gray-400 uppercase tracking-wider">';
    html += '<th class="py-3 px-3 font-semibold">Ticker</th>';
    html += '<th class="py-3 px-3 font-semibold text-right">Harga</th>';
    html += '<th class="py-3 px-3 font-semibold text-right">Perubahan</th>';
    html += '<th class="py-3 px-3 font-semibold">Alert Aktif</th>';
    html += '<th class="py-3 px-3 font-semibold text-right">Aksi</th>';
    html += '</tr></thead><tbody class="divide-y divide-dark-700/40">';

    items.forEach(function (item) {
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
            ' <button onclick="window.deleteUserAlert(\'' + a.id + '\')" class="text-gray-500 hover:text-red-400 ml-1 text-xs" title="Hapus Alert">×</button></div>';
        }).join('');
      } else {
        alertsHtml = '<span class="text-gray-500 italic">Belum ada alert</span>';
      }

      html += '<tr class="hover:bg-dark-800/40 transition-colors">';
      html += '<td class="py-3 px-3 font-bold text-white text-sm"><div class="flex items-center gap-1.5"><span>' + item.ticker + '</span>';
      if (item.notes) {
        html += '<span class="text-[10px] text-gray-400 font-normal truncate max-w-[120px]" title="' + item.notes + '">(' + item.notes + ')</span>';
      }
      html += '</div></td>';
      html += '<td class="py-3 px-3 text-right font-medium text-gray-200">' + last + '</td>';
      html += '<td class="py-3 px-3 text-right font-semibold" style="color:' + chgColor + '">' + chgText + '</td>';
      html += '<td class="py-3 px-3">' + alertsHtml + '</td>';
      html += '<td class="py-3 px-3 text-right whitespace-nowrap">';
      html += '<button onclick="window.openCreateAlertModal(\'' + item.ticker + '\')" class="px-2 py-1 bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 border border-blue-500/30 rounded text-xs mr-2 transition-all">+ Alert</button>';
      html += '<button onclick="window.toggleWatchlistTicker(\'' + item.ticker + '\', null, event)" class="px-2 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/25 rounded text-xs transition-all">Hapus</button>';
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

  function openCreateAlertModal(ticker) {
    var modal = document.getElementById('wlAlertModal');
    var tickerInput = document.getElementById('wlAlertTicker');
    var priceInput = document.getElementById('wlAlertPrice');
    if (!modal) return;

    if (tickerInput) tickerInput.value = ticker || '';
    if (priceInput) priceInput.value = '';
    modal.classList.remove('hidden');
  }

  function closeCreateAlertModal() {
    var modal = document.getElementById('wlAlertModal');
    if (modal) modal.classList.add('hidden');
  }

  async function submitCreateAlert() {
    var tickerInput = document.getElementById('wlAlertTicker');
    var typeInput = document.getElementById('wlAlertCondition');
    var priceInput = document.getElementById('wlAlertPrice');

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
      var res = await fetch('/api/sector-hot?action=watchlist-alert', {
        method: 'POST',
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
        if (typeof showToast === 'function') showToast('Alert ' + ticker + ' berhasil dipasang!', 'success');
        closeCreateAlertModal();
        loadUserWatchlist(true);
      } else {
        if (typeof showToast === 'function') showToast(json.error || 'Gagal memasang alert.', 'error');
      }
    } catch (err) {
      console.error('Error creating alert:', err);
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

  window.loadUserWatchlist = loadUserWatchlist;
  window.toggleWatchlistTicker = toggleWatchlistTicker;
  window.updateAllWatchlistStars = updateAllWatchlistStars;
  window.openCreateAlertModal = openCreateAlertModal;
  window.closeCreateAlertModal = closeCreateAlertModal;
  window.submitCreateAlert = submitCreateAlert;
  window.deleteUserAlert = deleteUserAlert;

  // Auto-init on DOM ready
  document.addEventListener('DOMContentLoaded', function () {
    loadUserWatchlist();
  });
})();