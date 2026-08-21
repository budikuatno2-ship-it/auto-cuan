(function () {
  'use strict';

  if (window.__AUTOCUAN_MAINTENANCE_CODE_RUNTIME__) return;
  window.__AUTOCUAN_MAINTENANCE_CODE_RUNTIME__ = true;

  var API = '/api/reset-password';
  var submitting = false;
  var expiresAt = 0;

  // Prefer the maintenance-code system immediately so the legacy zero-link
  // runtime cannot flash an administrator control while this feature probes.
  window.__AUTOCUAN_MAINTENANCE_CODE_ACTIVE__ = true;

  function visible(id) {
    var el = document.getElementById(id);
    return !!(el && el.classList && !el.classList.contains('hidden'));
  }

  function activeScope() {
    if (visible('maintenanceScreen')) return 'maintenance';
    if (visible('serviceStatusScreen')) return 'serviceStatus';
    return null;
  }

  function scopeIds(scope) {
    return scope === 'serviceStatus'
      ? { panel: 'serviceStatusAdminBtn', status: 'serviceStatusAdminStatus', wrap: 'serviceStatusAdminCodeWrap' }
      : { panel: 'maintenanceAdminBtn', status: 'maintenanceAdminStatus', wrap: 'maintenanceAdminCodeWrap' };
  }

  function scopeScreen(scope) {
    return document.getElementById(scope === 'serviceStatus' ? 'serviceStatusScreen' : 'maintenanceScreen');
  }

  function legacyButton(scope) {
    return document.getElementById(scopeIds(scope).panel);
  }

  function legacyStatus(scope) {
    return document.getElementById(scopeIds(scope).status);
  }

  // IMPORTANT: code entry must never be mounted inside the legacy
  // `.maintenance-admin` container. That container is intentionally hidden while
  // code mode is active and can also be hidden by older presentation layers.
  // Mount a dedicated sibling directly in the maintenance card instead.
  function codeHost(scope) {
    var screen = scopeScreen(scope);
    var card = screen && screen.querySelector('.maintenance-card');
    if (!card) return null;

    var outer = card.querySelector('[data-admin-code-host-outer]');
    var host = outer && outer.querySelector('[data-admin-code-host]');
    if (!host) {
      outer = document.createElement('div');
      outer.setAttribute('data-admin-code-host-outer', '1');
      outer.style.cssText = 'margin-top:18px;padding-top:14px;border-top:1px solid rgba(148,163,184,.12);display:flex;justify-content:center;width:100%';

      host = document.createElement('div');
      host.setAttribute('data-admin-code-host', '1');
      host.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;max-width:320px';
      outer.appendChild(host);
      card.appendChild(outer);
    }
    return host;
  }

  function setLegacyVisible(scope, show) {
    var btn = legacyButton(scope);
    var status = legacyStatus(scope);
    if (btn) btn.style.display = show ? '' : 'none';
    if (status) status.style.display = show ? '' : 'none';

    var panel = btn && btn.parentNode;
    var outer = panel && panel.closest && panel.closest('.maintenance-admin');
    if (outer && outer.style) outer.style.display = show ? '' : 'none';
  }

  function removeCodeUi(scope) {
    var wrap = document.getElementById(scopeIds(scope).wrap);
    if (wrap) wrap.remove();

    var screen = scopeScreen(scope);
    var outer = screen && screen.querySelector('[data-admin-code-host-outer]');
    if (outer) outer.remove();
  }

  function ensureCodeUi(scope) {
    var ids = scopeIds(scope);
    var existing = document.getElementById(ids.wrap);
    if (existing) return existing;

    var host = codeHost(scope);
    if (!host) return null;

    var wrap = document.createElement('div');
    wrap.id = ids.wrap;
    wrap.style.width = '100%';
    wrap.style.maxWidth = '320px';
    wrap.style.textAlign = 'center';
    wrap.style.fontFamily = 'Inter, system-ui, sans-serif';
    wrap.innerHTML = [
      '<div data-code-title style="font-size:12px;font-weight:800;color:#cbd5e1">Verifikasi administrator</div>',
      '<div data-code-status role="status" aria-live="polite" style="margin-top:5px;font-size:11.5px;line-height:1.55;color:#6b7a90">Masukkan 6 digit dari AutoCuan Verification.</div>',
      '<div style="margin-top:10px">',
      '  <input data-code-input inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" aria-label="Kode administrator 6 digit" placeholder="000000" style="box-sizing:border-box;width:100%;height:46px;border:1px solid rgba(148,163,184,.25);border-radius:12px;background:#020617;color:#fff;text-align:center;font-size:22px;font-weight:800;letter-spacing:.22em;outline:none" />',
      '</div>',
      '<div data-code-error class="hidden" role="alert" style="margin-top:8px;font-size:11.5px;line-height:1.5;color:#fca5a5"></div>'
    ].join('');
    host.appendChild(wrap);

    var input = wrap.querySelector('[data-code-input]');
    if (input) {
      input.addEventListener('input', function () {
        this.value = String(this.value || '').replace(/\D/g, '').slice(0, 6);
        if (this.value.length === 6 && !submitting) submitCode(scope);
      });
      window.setTimeout(function () {
        try { input.focus(); } catch (_) {}
      }, 60);
    }
    return wrap;
  }

  function setStatus(scope, text, tone) {
    var wrap = document.getElementById(scopeIds(scope).wrap);
    if (!wrap) return;
    var el = wrap.querySelector('[data-code-status]');
    if (!el) return;
    el.innerHTML = text;
    if (tone === 'success') el.style.color = '#6ee7b7';
    else if (tone === 'error') el.style.color = '#fca5a5';
    else el.style.color = '#6b7a90';
  }

  function setError(scope, text) {
    var wrap = document.getElementById(scopeIds(scope).wrap);
    if (!wrap) return;
    var el = wrap.querySelector('[data-code-error]');
    if (!el) return;
    if (!text) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    el.textContent = text;
    el.classList.remove('hidden');
  }

  function setSubmitting(scope, value) {
    submitting = value;
    var wrap = document.getElementById(scopeIds(scope).wrap);
    if (!wrap) return;
    var input = wrap.querySelector('[data-code-input]');
    if (input) input.disabled = value;
    setStatus(scope, value ? 'Memverifikasi kode…' : 'Masukkan 6 digit dari AutoCuan Verification.', 'info');
  }

  async function post(action, payload) {
    var response = await window.fetch(API, {
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

  function secondsRemaining() {
    if (!expiresAt) return 0;
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  }

  function renderActiveCode(scope, data) {
    window.__AUTOCUAN_MAINTENANCE_CODE_ACTIVE__ = true;
    setLegacyVisible(scope, false);

    var wrap = ensureCodeUi(scope);
    if (!wrap) return;

    expiresAt = Date.parse(data && data.expiresAt || '') || (Date.now() + 120000);
    var remaining = secondsRemaining();
    setStatus(scope,
      'Kode Telegram aktif. Ketik 6 digit' +
      (remaining ? ' · <strong style="color:#cbd5e1">' + remaining + ' dtk</strong>' : '') +
      '. Setelah digit ke-6, verifikasi berjalan otomatis.',
      'info');
  }

  function renderIdleCode(scope) {
    // Feature exists, but no /akses code is currently active. Keep maintenance
    // visually clean; the admin sends /akses first and refreshes this page.
    window.__AUTOCUAN_MAINTENANCE_CODE_ACTIVE__ = true;
    expiresAt = 0;
    removeCodeUi(scope);
    setLegacyVisible(scope, false);
  }

  function renderLegacyMode(scope) {
    window.__AUTOCUAN_MAINTENANCE_CODE_ACTIVE__ = false;
    removeCodeUi(scope);
    setLegacyVisible(scope, true);
  }

  async function cleanupTelegram(cleanupRef) {
    if (!cleanupRef) return;
    try {
      await post('admin-maintenance-code-cleanup', { cleanupRef: cleanupRef });
    } catch (_) {}
  }

  function scheduleCleanup(cleanupRef) {
    if (!cleanupRef) return;
    window.setTimeout(function () { cleanupTelegram(cleanupRef); }, 10000);
  }

  async function finishLogin(scope, data) {
    setError(scope, '');
    setStatus(scope, '✅ Kode benar. Membuka Auto-Cuan…', 'success');
    scheduleCleanup(data && data.cleanupRef);

    if (typeof window.validateAutocuanSession === 'function') {
      try { await window.validateAutocuanSession(); } catch (_) {}
    }
    if (typeof window.applyMaintenanceGate === 'function') {
      try { window.applyMaintenanceGate(); } catch (_) {}
    }
    if (typeof window.enterApp === 'function') {
      try {
        window.enterApp({ replaceHistory: true });
        return;
      } catch (_) {}
    }
    window.location.reload();
  }

  async function submitCode(scope) {
    if (submitting) return;
    var wrap = document.getElementById(scopeIds(scope).wrap);
    if (!wrap) return;
    var input = wrap.querySelector('[data-code-input]');
    var code = String(input && input.value || '').replace(/\D/g, '').slice(0, 6);
    if (!/^\d{6}$/.test(code)) return;

    setError(scope, '');
    setSubmitting(scope, true);
    try {
      var result = await post('admin-maintenance-code-consume', { code: code });
      var data = result.data || {};
      if (result.response.ok && data.success === true && data.state === 'approved') {
        if (input) input.value = '';
        await finishLogin(scope, data);
        return;
      }

      if (input) input.value = '';
      if (data.state === 'invalid_code') {
        var remaining = Number(data.attemptsRemaining || 0);
        setError(scope, 'Kode salah.' + (remaining > 0 ? ' Sisa ' + remaining + ' percobaan.' : ''));
      } else {
        setError(scope, data.error || 'Kode tidak dapat digunakan. Kirim /akses lagi lalu refresh halaman.');
      }
    } catch (_) {
      if (input) input.value = '';
      setError(scope, 'Koneksi ke server sedang bermasalah. Coba lagi.');
    } finally {
      setSubmitting(scope, false);
      if (input) {
        input.disabled = false;
        try { input.focus(); } catch (_) {}
      }
    }
  }

  async function checkOnLoad() {
    var scope = activeScope();
    if (!scope) {
      window.setTimeout(checkOnLoad, 350);
      return;
    }

    try {
      var result = await post('admin-maintenance-code-status');
      var data = result.data || {};
      if (data.featureAvailable !== true) {
        renderLegacyMode(scope);
        return;
      }
      if (data.state === 'active') renderActiveCode(scope, data);
      else renderIdleCode(scope);
    } catch (_) {
      // Fail closed and visually clean. A refresh can retry the status check.
      renderIdleCode(scope);
    }
  }

  window.setTimeout(checkOnLoad, 250);

  window.__AUTOCUAN_MAINTENANCE_CODE_API__ = {
    activeScope: activeScope,
    renderActiveCode: renderActiveCode,
    renderIdleCode: renderIdleCode,
    renderLegacyMode: renderLegacyMode,
    submitCode: submitCode,
    cleanupTelegram: cleanupTelegram,
    post: post
  };
})();