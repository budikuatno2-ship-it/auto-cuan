(function () {
  'use strict';

  function approvedFeatureElements() {
    return document.querySelectorAll('[data-premium-nav="true"]');
  }

  function keepApprovedFeaturesVisible() {
    approvedFeatureElements().forEach(function (el) {
      el.classList.remove('hidden');
      el.removeAttribute('hidden');
      el.setAttribute('aria-hidden', 'false');
    });
    document.querySelectorAll('[data-page="subscription"],#page-subscription,#subscriptionIdentityCard').forEach(function (el) {
      el.classList.add('hidden');
      el.setAttribute('hidden', '');
    });
  }

  function wirePortfolioLinks() {
    document.querySelectorAll('[data-page="portofolio"]').forEach(function (el) {
      el.onclick = function (event) {
        if (event) event.preventDefault();
        window.location.href = '/portfolio-planner';
      };
    });
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
      var stale = data.monitor_is_stale ? ' · Monitor belum mendapat pembaruan terbaru' : ' · Monitor siap';
      return { text: 'Data sehat: ' + count + ' saham Top 5 Final/Locked (' + date + ')' + stale + '.', ok: !data.monitor_is_stale };
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
    return { text: 'Status Top 5 dan Auto Monitor belum dapat dibaca. Muat ulang halaman beberapa saat lagi.', ok: false };
  }

  async function loadHealth() {
    var box = healthHost();
    if (!box) return;
    try {
      var userId = String(localStorage.getItem('autocuan_user_id') || '');
      var username = String(localStorage.getItem('autocuan_user') || '');
      var response = await fetch('/api/sector-hot?action=web-daily-picks', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-User-Id': userId, 'X-Username': username }
      });
      var data = await response.json();
      var status = statusText(data);
      box.textContent = status.text;
      box.style.borderColor = status.ok ? 'rgba(16,185,129,.28)' : 'rgba(245,158,11,.26)';
      box.style.background = status.ok ? 'rgba(16,185,129,.07)' : 'rgba(245,158,11,.06)';
      box.style.color = status.ok ? '#a7f3d0' : '#fde68a';
      if (data && !data.top5_locked) {
        var note = document.getElementById('dashboardTop5LockNote');
        if (note) note.textContent = 'Menunggu Top 5 Final/Locked yang lolos safety.';
        var monitor = document.getElementById('dashboardMonitorUpdated');
        if (monitor) monitor.textContent = 'Menunggu Top 5';
      }
    } catch (_) {
      box.textContent = 'Status Top 5 dan Auto Monitor belum dapat dibaca. Muat ulang halaman beberapa saat lagi.';
    }
  }

  function init() {
    keepApprovedFeaturesVisible();
    wirePortfolioLinks();
    loadHealth();
    var observer = new MutationObserver(function () {
      keepApprovedFeaturesVisible();
      wirePortfolioLinks();
    });
    observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    setInterval(function () { if (!document.hidden) loadHealth(); }, 5 * 60 * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
