(function () {
  'use strict';

  if (window.__AUTOCUAN_APPROVED_ENHANCEMENTS_STARTED__) return;
  window.__AUTOCUAN_APPROVED_ENHANCEMENTS_STARTED__ = true;

  var CACHE_KEY = 'autocuan_dashboard_locked_lkg_v1';

  function keepApprovedFeaturesVisible() {
    document.querySelectorAll('[data-premium-nav="true"]').forEach(function (el) {
      if (el.classList.contains('hidden')) el.classList.remove('hidden');
      if (el.hasAttribute('hidden')) el.removeAttribute('hidden');
      if (el.getAttribute('aria-hidden') !== 'false') el.setAttribute('aria-hidden', 'false');
    });

    document.querySelectorAll('[data-page="subscription"],#page-subscription,#subscriptionIdentityCard').forEach(function (el) {
      if (!el.classList.contains('hidden')) el.classList.add('hidden');
      if (!el.hasAttribute('hidden')) el.setAttribute('hidden', '');
    });
  }

  function wirePortfolioLinks() {
    document.querySelectorAll('[data-page="portofolio"]').forEach(function (el) {
      if (el.dataset.portfolioRouteWired === 'true') return;
      el.dataset.portfolioRouteWired = 'true';
      el.onclick = function (event) {
        if (event) event.preventDefault();
        window.location.href = '/portfolio-planner';
      };
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function numberText(value) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number).toLocaleString('id-ID') : '—';
  }

  function healthHost() {
    var note = document.getElementById('dashboardTop5LockNote');
    if (!note) return null;
    var panel = note.closest('section');
    var row = panel && panel.parentElement;
    if (!row || !row.parentElement) return null;
    var existing = document.getElementById('dashboardDataHealth');
    if (existing) return existing;
    var box = document.createElement('div');
    box.id = 'dashboardDataHealth';
    box.className = 'dash-section-note';
    box.style.borderColor = 'rgba(56,189,248,.24)';
    box.style.background = 'rgba(14,116,144,.07)';
    box.style.color = '#bae6fd';
    box.textContent = 'Memeriksa kesehatan data Top 5 dan Auto Monitor…';
    row.parentElement.insertBefore(box, row);
    return box;
  }

  function statusText(data) {
    var count = Array.isArray(data && data.top5) ? data.top5.length : 0;
    if (data && data.success && data.top5_locked && count > 0) {
      var date = data.date || data.latest_locked_fallback_date || 'tanggal terakhir';
      var fallback = data.latest_locked_fallback_date && data.latest_locked_fallback_date !== data.date ? ' · memakai snapshot terakhir' : '';
      var stale = data.monitor_is_stale ? ' · Monitor belum mendapat pembaruan terbaru' : ' · Monitor siap';
      return { text: 'Data sehat: ' + count + ' saham Top 5 Final/Locked (' + date + ')' + fallback + stale + '.', ok: !data.monitor_is_stale };
    }
    if (data && data.awaiting_reason === 'locked_rows_filtered_unsafe') {
      return { text: 'Safety aktif: snapshot Top 5 ditemukan, tetapi seluruh isinya disembunyikan karena tidak lolos pemeriksaan keamanan.', ok: false };
    }
    if (data && data.awaiting_reason === 'fallback_rows_filtered_unsafe') {
      return { text: 'Safety aktif: snapshot terakhir tersedia, tetapi tidak aman untuk ditampilkan sebagai kandidat.', ok: false };
    }
    if (data && data.success) {
      return { text: 'Belum ada Top 5 Final/Locked yang aman. Auto Monitor menunggu snapshot final; ini bukan sinyal beli.', ok: false };
    }
    return { text: 'Status Top 5 dan Auto Monitor belum dapat dibaca. Data terakhir yang valid tetap dipertahankan.', ok: false };
  }

  function readCache() {
    try {
      var parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (!parsed || !parsed.data || !Array.isArray(parsed.data.top5) || !parsed.data.top5.length) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function monitorRows(data) {
    var candidates = [
      data && data.monitor,
      data && data.monitor_rows,
      data && data.monitor_picks,
      data && data.active_monitor,
      data && data.active_picks,
      data && data.tracking
    ];
    for (var index = 0; index < candidates.length; index++) {
      if (Array.isArray(candidates[index])) return candidates[index];
    }
    return [];
  }

  function writeCache(data) {
    if (!data || !data.top5_locked || !Array.isArray(data.top5) || !data.top5.length) return;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        saved_at: new Date().toISOString(),
        data: {
          success: true,
          top5_locked: true,
          date: data.date || null,
          latest_locked_fallback_date: data.latest_locked_fallback_date || null,
          monitor_is_stale: !!data.monitor_is_stale,
          top5: data.top5.slice(0, 5),
          monitor: monitorRows(data).slice(0, 12)
        }
      }));
    } catch (_) {}
  }

  function ensureRenderHost(panel, id) {
    if (!panel) return null;
    var host = document.getElementById(id);
    if (host) return host;
    host = document.createElement('div');
    host.id = id;
    host.style.display = 'grid';
    host.style.gridTemplateColumns = 'repeat(auto-fit,minmax(220px,1fr))';
    host.style.gap = '10px';
    host.style.marginTop = '12px';
    panel.appendChild(host);
    return host;
  }

  function hideEmptyLeafText(panel, pattern, protectedId) {
    if (!panel) return;
    panel.querySelectorAll('p,div').forEach(function (node) {
      if (node.id === protectedId || node.closest('#approvedTop5LockedRows') || node.closest('#approvedMonitorLockedRows')) return;
      if (node.childElementCount !== 0) return;
      var text = String(node.textContent || '').trim();
      if (text.length < 140 && pattern.test(text)) node.style.display = 'none';
    });
  }

  function cardShell(inner) {
    return '<article style="border:1px solid rgba(148,163,184,.16);border-radius:13px;padding:12px;background:rgba(15,23,42,.72);min-width:0">' + inner + '</article>';
  }

  function renderTop5(data, cached) {
    var rows = Array.isArray(data && data.top5) ? data.top5.slice(0, 5) : [];
    if (!rows.length) return false;
    var note = document.getElementById('dashboardTop5LockNote');
    var panel = note && note.closest('section');
    var host = ensureRenderHost(panel, 'approvedTop5LockedRows');
    if (!host) return false;
    host.innerHTML = rows.map(function (row, index) {
      var ticker = escapeHtml(row.ticker || '-');
      var source = escapeHtml(row.category || row.source || 'Top 5');
      var entry1 = row.entry1 != null ? row.entry1 : row.entry;
      var entry2 = row.entry2;
      var reason = escapeHtml(row.top5_reason || row.alasan_top5 || row.reason || row.signal_reason || 'Snapshot Final/Locked yang lolos safety.');
      var entryText = numberText(entry1) + (Number(entry2) > 0 && Number(entry2) !== Number(entry1) ? ' – ' + numberText(entry2) : '');
      return cardShell(
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
          '<div><span style="font-size:10px;color:#64748b">#' + (index + 1) + ' · ' + source + '</span><div style="font-size:18px;font-weight:900;color:#f8fafc">' + ticker + '</div></div>' +
          '<span style="font-size:9px;font-weight:800;color:#a7f3d0;border:1px solid rgba(52,211,153,.24);border-radius:999px;padding:4px 7px">FINAL</span>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:10px;font-size:10px">' +
          '<div><span style="color:#64748b">ENTRY</span><b style="display:block;color:#e2e8f0">' + entryText + '</b></div>' +
          '<div><span style="color:#64748b">TP1</span><b style="display:block;color:#86efac">' + numberText(row.tp1) + '</b></div>' +
          '<div><span style="color:#64748b">SL</span><b style="display:block;color:#fca5a5">' + numberText(row.sl || row.stop_loss) + '</b></div>' +
        '</div>' +
        '<p style="margin:9px 0 0;color:#94a3b8;font-size:10px;line-height:1.45">' + reason + '</p>'
      );
    }).join('');
    hideEmptyLeafText(panel, /belum ada top 5|data akan muncul setelah semua screener|menunggu top 5/i, 'dashboardTop5LockNote');
    var date = data.date || data.latest_locked_fallback_date || 'tanggal terakhir';
    if (note) note.textContent = 'Top 5 Final/Locked · data ' + date + (cached ? ' · salinan terakhir tersimpan' : '');
    return true;
  }

  function renderMonitor(data, cached) {
    var rows = monitorRows(data).slice(0, 12);
    var updated = document.getElementById('dashboardMonitorUpdated');
    var panel = updated && updated.closest('section');
    if (!panel) return false;
    var host = ensureRenderHost(panel, 'approvedMonitorLockedRows');
    if (!host) return false;
    if (!rows.length) {
      host.innerHTML = '<div style="grid-column:1/-1;border:1px dashed rgba(148,163,184,.18);border-radius:12px;padding:14px;color:#94a3b8;font-size:11px">Top 5 tersedia. Pembaruan harga monitor belum masuk; level Entry, TP, dan SL tetap berasal dari snapshot Final/Locked.</div>';
    } else {
      host.innerHTML = rows.map(function (row) {
        var ticker = escapeHtml(row.ticker || '-');
        var status = escapeHtml(row.status_label || row.status || row.progress || 'Dipantau');
        var price = row.current_price != null ? row.current_price : row.last_price;
        var pl = Number(row.monitor_pl_pct != null ? row.monitor_pl_pct : row.return_from_entry_pct);
        var plText = Number.isFinite(pl) ? ((pl >= 0 ? '+' : '') + pl.toFixed(2) + '%') : '—';
        var plColor = Number.isFinite(pl) && pl < 0 ? '#fca5a5' : '#86efac';
        return cardShell(
          '<div style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:16px;color:#f8fafc">' + ticker + '</b><span style="font-size:9px;color:#bae6fd">' + status + '</span></div>' +
          '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:9px;font-size:10px">' +
            '<div><span style="color:#64748b">HARGA</span><b style="display:block">' + numberText(price) + '</b></div>' +
            '<div><span style="color:#64748b">PROGRES</span><b style="display:block;color:' + plColor + '">' + plText + '</b></div>' +
            '<div><span style="color:#64748b">TP1</span><b style="display:block;color:#86efac">' + numberText(row.tp1) + '</b></div>' +
          '</div>'
        );
      }).join('');
    }
    hideEmptyLeafText(panel, /belum ada data monitor|belum ada auto monitor|menunggu top 5|data monitor akan muncul/i, 'dashboardMonitorUpdated');
    if (updated) {
      var date = data.date || data.latest_locked_fallback_date || 'snapshot terakhir';
      updated.textContent = (data.monitor_is_stale ? 'Belum diperbarui · ' : 'Diperbarui · ') + date + (cached ? ' · cache' : '');
    }
    return true;
  }

  function applyData(data, cached) {
    renderTop5(data, cached);
    renderMonitor(data, cached);
  }

  function paintStatus(box, status) {
    box.textContent = status.text;
    box.style.borderColor = status.ok ? 'rgba(16,185,129,.28)' : 'rgba(245,158,11,.26)';
    box.style.background = status.ok ? 'rgba(16,185,129,.07)' : 'rgba(245,158,11,.06)';
    box.style.color = status.ok ? '#a7f3d0' : '#fde68a';
  }

  async function loadHealth() {
    var box = healthHost();
    if (!box) return;
    var cached = readCache();
    try {
      var userId = String(localStorage.getItem('autocuan_user_id') || '');
      var username = String(localStorage.getItem('autocuan_user') || '');
      var response = await fetch('/api/sector-hot?action=web-daily-picks', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-User-Id': userId, 'X-Username': username }
      });
      var data = await response.json();
      var hasLockedRows = !!(data && data.success && data.top5_locked && Array.isArray(data.top5) && data.top5.length);
      if (hasLockedRows) {
        writeCache(data);
        applyData(data, false);
        paintStatus(box, statusText(data));
        return;
      }
      if (cached) {
        applyData(cached.data, true);
        paintStatus(box, { text: 'Pembaruan terbaru belum tersedia. Menampilkan Top 5 Final/Locked terakhir (' + (cached.data.date || cached.data.latest_locked_fallback_date || 'tanggal terakhir') + ').', ok: false });
        return;
      }
      paintStatus(box, statusText(data));
      if (data && !data.top5_locked) {
        var note = document.getElementById('dashboardTop5LockNote');
        if (note) note.textContent = 'Menunggu Top 5 Final/Locked yang lolos safety.';
        var monitor = document.getElementById('dashboardMonitorUpdated');
        if (monitor) monitor.textContent = 'Menunggu Top 5';
      }
    } catch (_) {
      if (cached) {
        applyData(cached.data, true);
        paintStatus(box, { text: 'VPS/API belum dapat diperbarui. Menampilkan data Final/Locked terakhir yang tersimpan.', ok: false });
      } else {
        paintStatus(box, { text: 'Status Top 5 belum dapat dibaca dan belum ada salinan data valid di browser.', ok: false });
      }
    }
  }

  function applyApprovedUi() {
    keepApprovedFeaturesVisible();
    wirePortfolioLinks();
  }

  function init() {
    applyApprovedUi();
    loadHealth();

    [250, 1000, 2500].forEach(function (delay) {
      setTimeout(function () {
        applyApprovedUi();
        var cached = readCache();
        if (cached) applyData(cached.data, true);
      }, delay);
    });

    setInterval(function () {
      if (!document.hidden) loadHealth();
    }, 5 * 60 * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
