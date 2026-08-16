(function () {
  'use strict';

  if (window.__AUTOCUAN_ZERO_LINK_PAIRING__) return;
  window.__AUTOCUAN_ZERO_LINK_PAIRING__ = true;

  var HINT_ID = 'adminZeroLinkPairingHint';
  var stopped = false;
  var inFlight = false;

  function visible(id) {
    var el = document.getElementById(id);
    return !!(el && el.classList && !el.classList.contains('hidden'));
  }

  function maintenanceVisible() {
    return visible('maintenanceScreen') || visible('serviceStatusScreen');
  }

  function onDashboardPath() {
    return window.location.pathname === '/dashboard' || window.location.pathname === '/dashboard/';
  }

  function hideHint() {
    var el = document.getElementById(HINT_ID);
    if (el) el.classList.add('hidden');
  }

  function renderHint(tag, label) {
    var safeTag = String(tag || '').replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (!safeTag) return;

    var el = document.getElementById(HINT_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = HINT_ID;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.position = 'fixed';
      el.style.left = '50%';
      el.style.bottom = '18px';
      el.style.transform = 'translateX(-50%)';
      el.style.zIndex = '9998';
      el.style.width = 'min(92vw, 520px)';
      el.style.padding = '12px 14px';
      el.style.borderRadius = '14px';
      el.style.border = '1px solid rgba(52,211,153,.28)';
      el.style.background = 'rgba(15,23,42,.96)';
      el.style.boxShadow = '0 18px 50px rgba(0,0,0,.35)';
      el.style.color = '#cbd5e1';
      el.style.fontFamily = 'Inter, system-ui, sans-serif';
      el.style.fontSize = '12px';
      el.style.lineHeight = '1.5';
      el.style.textAlign = 'center';
      document.body.appendChild(el);
    }

    var safeLabel = String(label || 'Laptop utama').replace(/[<>]/g, '').slice(0, 80);
    el.innerHTML =
      '<div style="font-weight:800;color:#6ee7b7">💻 Laptop siap dihubungkan</div>' +
      '<div style="margin-top:3px">' + safeLabel + ' · ID perangkat <strong style="color:#fff;letter-spacing:.16em">' + safeTag + '</strong></div>' +
      '<div style="margin-top:3px;color:#94a3b8">Telegram → <strong>/akses</strong> → pilih Laptop dengan ID yang sama. Tidak perlu buka link atau mengetik kode.</div>';
    el.classList.remove('hidden');
  }

  async function poll() {
    if (stopped) return;

    if (!onDashboardPath() || !maintenanceVisible()) {
      hideHint();
      window.setTimeout(poll, 2500);
      return;
    }

    if (inFlight) {
      window.setTimeout(poll, 2500);
      return;
    }

    inFlight = true;
    try {
      var response = await window.fetch('/api/reset-password', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        },
        body: JSON.stringify({
          action: 'admin-command-pair-poll',
          pagePath: window.location.pathname
        })
      });
      var data = await response.json().catch(function () { return {}; });

      if (data && data.success === true && data.state === 'approved') {
        stopped = true;
        hideHint();
        window.location.reload();
        return;
      }

      if (data && data.state === 'pair_pending') {
        renderHint(data.displayTag, data.deviceLabel);
      } else if (data && data.state === 'already_paired') {
        stopped = true;
        hideHint();
        return;
      } else if (data && data.state === 'desktop_required') {
        stopped = true;
        hideHint();
        return;
      }
    } catch (_) {
      // Fail closed: no UI/auth state is changed when registration polling fails.
    } finally {
      inFlight = false;
    }

    if (!stopped) window.setTimeout(poll, 2500);
  }

  window.setTimeout(poll, 700);

  window.__AUTOCUAN_ZERO_LINK_PAIRING_API__ = {
    maintenanceVisible: maintenanceVisible,
    onDashboardPath: onDashboardPath,
    renderHint: renderHint,
    hideHint: hideHint
  };
})();
