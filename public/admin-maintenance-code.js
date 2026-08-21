(function () {
  'use strict';

  if (window.__AUTOCUAN_MAINTENANCE_CODE_RUNTIME__) return;
  window.__AUTOCUAN_MAINTENANCE_CODE_RUNTIME__ = true;

  var API = '/api/reset-password';
  var pollTimer = null;
  var inFlight = false;
  var submitting = false;
  var expiresAt = 0;

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

  function legacyButton(scope) {
    return document.getElementById(scopeIds(scope).panel);
  }

  function legacyStatus(scope) {
    return document.getElementById(scopeIds(scope).status);
  }

  function legacyPanel(scope) {
    var btn = legacyButton(scope);
    return btn && btn.parentNode ? btn.parentNode : null;
  }

  function setLegacyVisible(scope, show) {
    var btn = legacyButton(scope);
    var status = legacyStatus(scope);
    if (btn) btn.style.display = show ? '' : 'none';
    if (status) status.style.display = show ? '' : 'none';
  }

  function ensureCodeUi(scope) {
    var ids = scopeIds(scope);
    var existing = document.getElementById(ids.wrap);
    if (existing) return existing;

    var panel = legacyPanel(scope);
    if (!panel) return null;

    var wrap = document.createElement('div');
    wrap.id = ids.wrap;
    wrap.style.width = '100%';
    wrap.style.maxWidth = '320px';
    wrap.style.textAlign = 'center';
    wrap.style.fontFamily = 'Inter, system-ui, sans-serif';
    wrap.innerHTML = [
      '<div data-code-title style="font-size:12px;font-weight:800;color:#cbd5e1">Akses administrator</div>',
      '<div data-code-status role="status" aria-live="polite" style="margin-top:5px;font-size:11.5px;line-height:1.55;color:#6b7a90">Kirim <strong style="color:#cbd5e1">/akses</strong> ke AutoCuan Verification.</div>',
      '<form data-code-form class="hidden" style="margin-top:10px" autocomplete="off">',
      '  <input data-code-input inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" aria-label="Kode administrator 6 digit" placeholder="000000" style="box-sizing:border-box;width:100%;height:46px;border:1px solid rgba(148,163,184,.25);border-radius:12px;background:#020617;color:#fff;text-align:center;font-size:22px;font-weight:800;letter-spacing:.22em;outline:none" />',
      '  <button data-code-submit type="submit" style="box-sizing:border-box;width:100%;min-height:44px;margin-top:9px;border:0;border-radius:12px;background:#10b981;color:#04130d;font-size:13px;font-weight:800;cursor:pointer">Masuk sebagai administrator</button>',
      '</form>',
      '<div data-code-error class="hidden" role="alert" style="margin-top:8px;font-size:11.5px;line-height:1.5;color:#fca5a5"></div>'
    ].join('');
    panel.appendChild(wrap);

    var form = wrap.querySelector('[data-code-form]');
    var input = wrap.querySelector('[data-code-input]');
    if (input) {
      input.addEventListener('input', function () {
        this.value = String(this.value || '').replace(/\D/g, '').slice(0, 6);
      });
    }
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        submitCode(scope);
      });
    }
    return wrap;
  }

  function setStatus(scope, text, tone) {
    var wrap = ensureCodeUi(scope);
    if (!wrap) return;
    var el = wrap.querySelector('[data-code-status]');
    if (!el) return;
    el.innerHTML = text;
    if (tone === 'success') el.style.color = '#6ee7b7';
    else if (tone === 'error') el.style.color = '#fca5a5';
    else el.style.color = '#6b7a90';
  }

  function setError(scope, text) {
    var wrap = ensureCodeUi(scope);
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

  function showForm(scope, show) {
    var wrap = ensureCodeUi(scope);
    if (!wrap) return;
    var form = wrap.querySelector('[data-code-form]');
    if (form) form.classList.toggle('hidden', !show);
  }

  function setSubmitting(scope, value) {
    submitting = value;
    var wrap = ensureCodeUi(scope);
    if (!wrap) return;
    var input = wrap.querySelector('[data-code-input]');
    var button = wrap.querySelector('[data-code-submit]');
    if (input) input.disabled = value;
    if (button) {
      button.disabled = value;
      button.style.opacity = value ? '.65' : '1';
      button.textContent = value ? 'Memverifikasi…' : 'Masuk sebagai administrator';
    }
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

  function renderCodeMode(scope, data) {
    window.__AUTOCUAN_MAINTENANCE_CODE_ACTIVE__ = true;
    setLegacyVisible(scope, false);
    ensureCodeUi(scope);

    var oldHint = document.getElementById('adminZeroLinkPairingHint');
    if (oldHint) oldHint.classList.add('hidden');

    if (data && data.state === 'active') {
      expiresAt = Date.parse(data.expiresAt || '') || (Date.now() + 120000);
      var remaining = secondsRemaining();
      showForm(scope, true);
      setStatus(scope,
        'Kode dari Telegram aktif. Masukkan 6 digit di bawah' +
        (remaining ? ' · <strong style="color:#cbd5e1">' + remaining + ' dtk</strong>' : '') + '.',
        'info');
      return;
    }

    expiresAt = 0;
    showForm(scope, false);
    setError(scope, '');
    setStatus(scope, 'Kirim <strong style="color:#cbd5e1">/akses</strong> ke AutoCuan Verification. Form kode akan muncul otomatis.', 'info');
  }

  function renderLegacyMode(scope) {
    window.__AUTOCUAN_MAINTENANCE_CODE_ACTIVE__ = false;
    setLegacyVisible(scope, true);
    var wrap = document.getElementById(scopeIds(scope).wrap);
    if (wrap) wrap.remove();
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
    var wrap = ensureCodeUi(scope);
    if (!wrap) return;
    var input = wrap.querySelector('[data-code-input]');
    var code = String(input && input.value || '').replace(/\D/g, '').slice(0, 6);
    if (!/^\d{6}$/.test(code)) {
      setError(scope, 'Masukkan 6 digit kode dari Telegram.');
      return;
    }

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

      if (data.state === 'invalid_code') {
        var remaining = Number(data.attemptsRemaining || 0);
        setError(scope, 'Kode salah.' + (remaining > 0 ? ' Sisa ' + remaining + ' percobaan.' : ''));
      } else {
        setError(scope, data.error || 'Kode tidak dapat digunakan. Kirim /akses lagi.');
      }
    } catch (_) {
      setError(scope, 'Koneksi ke server sedang bermasalah. Coba lagi.');
    } finally {
      setSubmitting(scope, false);
    }
  }

  async function poll() {
    var scope = activeScope();
    if (!scope) {
      window.setTimeout(poll, 2500);
      return;
    }

    if (inFlight || submitting) {
      window.setTimeout(poll, 1500);
      return;
    }

    inFlight = true;
    try {
      var result = await post('admin-maintenance-code-status');
      var data = result.data || {};
      if (data.featureAvailable === true) renderCodeMode(scope, data);
      else renderLegacyMode(scope);
    } catch (_) {
      // Keep whichever UI mode was last known. A transient status failure must
      // never unlock maintenance or erase an in-progress code entry.
    } finally {
      inFlight = false;
    }

    pollTimer = window.setTimeout(poll, 2500);
  }

  window.setTimeout(poll, 450);

  window.__AUTOCUAN_MAINTENANCE_CODE_API__ = {
    activeScope: activeScope,
    renderCodeMode: renderCodeMode,
    renderLegacyMode: renderLegacyMode,
    submitCode: submitCode,
    cleanupTelegram: cleanupTelegram,
    post: post
  };
})();
