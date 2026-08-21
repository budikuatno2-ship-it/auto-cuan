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

  function ensureHint() {
    var el = document.getElementById(HINT_ID);
    if (el) return el;

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
    return el;
  }

  function renderHint(tag, label) {
    var safeTag = String(tag || '').replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (!safeTag) return;

    var el = ensureHint();
    var safeLabel = String(label || 'Laptop utama').replace(/[<>]/g, '').slice(0, 80);
    el.innerHTML =
      '<div style="font-weight:800;color:#6ee7b7">💻 Laptop siap dihubungkan</div>' +
      '<div style="margin-top:3px">' + safeLabel + ' · ID perangkat <strong style="color:#fff;letter-spacing:.16em">' + safeTag + '</strong></div>' +
      '<div style="margin-top:3px;color:#94a3b8">Telegram → <strong>/akses</strong> → pilih Laptop dengan ID yang sama. Tidak perlu buka link atau mengetik kode.</div>';
    el.classList.remove('hidden');
  }

  function renderKnownDeviceHint() {
    var el = ensureHint();
    el.innerHTML =
      '<div style="font-weight:800;color:#6ee7b7">✅ Laptop utama dikenali</div>' +
      '<div style="margin-top:3px;color:#cbd5e1">Perangkat ini sudah terhubung ke Auto-Cuan.</div>' +
      '<div style="margin-top:3px;color:#94a3b8">Kirim <strong>/akses</strong> di AutoCuan Verification. Setelah grant diterima, halaman ini akan login otomatis.</div>';
    el.classList.remove('hidden');
  }

  async function postAction(action, payload) {
    var response = await window.fetch('/api/reset-password', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    });
    var data = await response.json().catch(function () { return {}; });
    return { response: response, data: data };
  }

  async function finishApprovedDevice() {
    stopped = true;
    hideHint();
    if (typeof window.validateAutocuanSession === 'function') {
      try { await window.validateAutocuanSession(); } catch (_) {}
    }
    window.location.reload();
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
      // Always try the existing trusted-device grant first. This is the normal
      // /akses path for an already-paired laptop: Telegram creates a short-lived
      // grant for ac_admin_dev, this poll consumes it, receives a signed session,
      // and the maintenance page disappears automatically. Previously the UI
      // stopped as soon as pair-poll returned already_paired, so the grant was
      // never consumed even though Telegram correctly said it had been sent.
      var deviceResult = await postAction('admin-command-device-poll');
      var deviceData = deviceResult.data || {};

      if (deviceData.success === true && deviceData.state === 'approved') {
        await finishApprovedDevice();
        return;
      }

      if (deviceData.state === 'pending') {
        renderKnownDeviceHint();
      } else if (deviceData.state === 'unpaired') {
        // No usable trusted-device cookie exists. Register/refresh the zero-link
        // pairing request so /akses can approve this exact browser. This is also
        // the recovery path after cookies/site data have been cleared.
        var pairResult = await postAction('admin-command-pair-poll', {
          pagePath: window.location.pathname
        });
        var data = pairResult.data || {};

        if (data.success === true && data.state === 'approved') {
          await finishApprovedDevice();
          return;
        }

        if (data.state === 'pair_pending') {
          renderHint(data.displayTag, data.deviceLabel);
        } else if (data.state === 'already_paired') {
          // Defensive compatibility for a race where the pairing endpoint sees
          // the device become known between the device-poll and pair-poll calls.
          // Do not stop: the next cycle must consume the Telegram device grant.
          renderKnownDeviceHint();
        } else if (data.state === 'desktop_required') {
          stopped = true;
          hideHint();
          return;
        }
      } else if (deviceData.state === 'rejected') {
        stopped = true;
        hideHint();
        return;
      }
    } catch (_) {
      // Fail closed: no UI/auth state is changed when registration/grant polling fails.
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
    renderKnownDeviceHint: renderKnownDeviceHint,
    hideHint: hideHint,
    postAction: postAction
  };
})();
