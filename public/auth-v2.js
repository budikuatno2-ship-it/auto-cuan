(function () {
  'use strict';

  if (window.__AUTOCUAN_AUTH_V2__) return;
  window.__AUTOCUAN_AUTH_V2__ = true;

  var AUTH_API = '/api/reset-password';
  var RESET_MODAL_ID = 'authV2ResetModal';
  var authReadyResolve;
  // Other scripts (subscription-access-gate-v1.js, subscription-manual-payment-v1.js,
  // index.html) sequence their own startup fetches after this promise settles so they
  // do not race the session-status check below. Without this assignment,
  // authReadyResolve(status) at the end of init() throws (calling undefined), and
  // every consumer's `window.autocuanAuthReady` check silently falls through to firing
  // immediately instead of waiting.
  window.autocuanAuthReady = new Promise(function (resolve) { authReadyResolve = resolve; });

  function byId(id) { return document.getElementById(id); }

  function clearLocalAuthState() {
    [
      'autocuan_user',
      'autocuan_user_id',
      'autocuan_logged_in',
      'autocuan_is_admin',
      'autocuan_is_review',
      'autocuan_login_time',
      'autocuan_full_name'
    ].forEach(function (key) {
      try { localStorage.removeItem(key); } catch (_) {}
    });
    if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('autocuan:session-cleared'));
  }

  function storeSession(data) {
    var username = String(data.username || '').trim().toLowerCase();
    var isAdmin = data.isAdmin === true && username === 'budi';
    try {
      localStorage.setItem('autocuan_user', username);
      localStorage.setItem('autocuan_user_id', String(data.userId || ''));
      localStorage.setItem('autocuan_logged_in', 'true');
      localStorage.setItem('autocuan_is_admin', isAdmin ? 'true' : 'false');
      localStorage.setItem('autocuan_login_time', String(Date.now()));
      if (data.isReview === true) localStorage.setItem('autocuan_is_review', 'true');
      else localStorage.removeItem('autocuan_is_review');
    } catch (_) {}
    if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('autocuan:session-ready'));
  }

  async function authRequest(action, payload) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timeout = setTimeout(function () {
      try { if (controller) controller.abort(); } catch (_) {}
    }, 10000);
    try {
      var response = await fetch(AUTH_API, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        },
        body: JSON.stringify(Object.assign({ action: action }, payload || {})),
        signal: controller ? controller.signal : undefined
      });
      var data = await response.json().catch(function () { return {}; });
      return { response: response, data: data };
    } finally {
      clearTimeout(timeout);
    }
  }

  function returnToGuest(options) {
    clearLocalAuthState();
    if (typeof window.updateDashGreeting === 'function') {
      try { window.updateDashGreeting(); } catch (_) {}
    }
    if (typeof window.updateLandingCtas === 'function') {
      try { window.updateLandingCtas(); } catch (_) {}
    }
    if (typeof window.showLandingPage === 'function') {
      try {
        window.showLandingPage({
          replaceHistory: !!(options && options.replaceHistory),
          skipHistory: !!(options && options.skipHistory),
          keepScroll: true
        });
      } catch (_) {}
    }
  }

  async function validateServerSession() {
    try {
      var result = await authRequest('session-status');
      if (result.response.ok && result.data.success === true && result.data.userId) {
        window.__AUTOCUAN_AUTHENTICATED_SESSION__ = result.data;
        storeSession(result.data);
        if (typeof window.updateDashGreeting === 'function') {
          try { window.updateDashGreeting(); } catch (_) {}
        }
        if (result.data.email_required === true) {
          if (typeof window.closeAuthChoiceModal === 'function') {
            try { window.closeAuthChoiceModal(); } catch (_) {}
          }
          if (typeof window.closeLoginModal === 'function') {
            try { window.closeLoginModal(); } catch (_) {}
          }
          if (typeof window.showLandingPage === 'function') {
            try { window.showLandingPage({ replaceHistory: true, keepScroll: true }); } catch (_) {}
          }
          if (typeof window.enforceLegacyGmail === 'function') {
            try { window.enforceLegacyGmail(); } catch (_) {}
          }
          return { valid: true, data: result.data, email_required: true };
        }
        // Re-enter the app for ANY protected SPA route, not just /dashboard.
        // A valid session cookie with no matching localStorage state lands on
        // the login prompt for /screener, /watchlist, /sektor, /trackrecord and
        // the /dashboard?page=... deep links; without this the user stays
        // stranded on the prompt despite being authenticated.
        var isProtectedSpaRoute = false;
        if (typeof window.parseAppRoute === 'function') {
          try {
            var route = window.parseAppRoute();
            isProtectedSpaRoute = route && (route.authRequired === true || route.page === 'dashboard' || route.page === 'analisis' || route.page === 'news' || route.page === 'portofolio');
          } catch (_) {}
        } else {
          var p = window.location.pathname || '/';
          isProtectedSpaRoute = p === '/dashboard' || p === '/dashboard/' || p === '/screener' || p === '/watchlist' || p === '/sektor' || p === '/trackrecord';
        }
        if (isProtectedSpaRoute) {
          if (typeof window.closeAuthChoiceModal === 'function') {
            try { window.closeAuthChoiceModal(); } catch (_) {}
          }
          if (typeof window.enterApp === 'function') {
            try { window.enterApp({ replaceHistory: true }); } catch (_) {}
          }
        }
        return { valid: true, data: result.data };
      }

      if (result.response.status === 401 || result.response.status === 403) {
        window.__AUTOCUAN_AUTHENTICATED_SESSION__ = null;
        var isGuestPermitted = false;
        if (typeof window.isCurrentRouteGuestAllowed === 'function') {
          try { isGuestPermitted = window.isCurrentRouteGuestAllowed(); } catch (_) {}
        } else {
          var params = new URLSearchParams(window.location.search);
          var path = window.location.pathname || '/';
          isGuestPermitted = (path === '/dashboard' || path === '/dashboard/') && (params.get('page') || '').toLowerCase() === 'news';
        }
        if (!isGuestPermitted) {
          returnToGuest({ skipHistory: true });
          if (window.location.pathname === '/dashboard' || window.location.pathname === '/dashboard/') {
            if (typeof window.openAuthChoiceModal === 'function') {
              try {
                var message = result.response.status === 403
                  ? 'Akses ditolak. Akun Anda belum disetujui atau tidak memiliki izin.'
                  : 'Sesi sudah tidak berlaku. Silakan login kembali.';
                window.openAuthChoiceModal(message);
              } catch (_) {}
            }
          }
        } else {
          clearLocalAuthState();
          if (typeof window.updateDashGreeting === 'function') {
            try { window.updateDashGreeting(); } catch (_) {}
          }
          if (typeof window.updateLandingCtas === 'function') {
            try { window.updateLandingCtas(); } catch (_) {}
          }
        }
        return { valid: false, status: result.response.status };
      }
      return { valid: false, transient: result.response.status >= 500 };
    } catch (_) {
      return { valid: false, transient: true };
    }
  }

  function clearLoginInputs() {
    var username = byId('loginUsername');
    var password = byId('loginPassword');
    var error = byId('loginError');
    if (username) {
      username.value = '';
      username.setAttribute('autocomplete', 'username');
    }
    if (password) {
      password.value = '';
      password.setAttribute('autocomplete', 'current-password');
    }
    if (error) {
      error.textContent = '';
      error.classList.add('hidden');
    }
  }

  function installLoginModalReset() {
    var originalOpen = window.openLoginModal;
    window.openLoginModal = function () {
      if (typeof originalOpen === 'function') originalOpen.apply(this, arguments);
      clearLoginInputs();
      setTimeout(clearLoginInputs, 60);
    };
    clearLoginInputs();
  }

  async function doLoginV2() {
    var usernameEl = byId('loginUsername');
    var passwordEl = byId('loginPassword');
    var errorEl = byId('loginError');
    var loginBtn = byId('loginBtn');
    if (!usernameEl || !passwordEl || !errorEl || !loginBtn) return;

    var username = usernameEl.value.trim().toLowerCase();
    var password = passwordEl.value;
    errorEl.textContent = '';
    errorEl.classList.add('hidden');

    if (!username || username.length < 2) {
      errorEl.textContent = 'Gmail tidak valid.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (!password) {
      errorEl.textContent = 'Password tidak boleh kosong.';
      errorEl.classList.remove('hidden');
      return;
    }

    loginBtn.disabled = true;
    loginBtn.innerHTML = '<span class="spinner-sm"></span>Masuk...';
    try {
      if (typeof window.hashPassword !== 'function') throw new Error('hash_unavailable');
      var passwordHash = await window.hashPassword(password);
      var deviceId = typeof window.getOrCreateDeviceId === 'function'
        ? window.getOrCreateDeviceId()
        : (function () {
            try {
              var stored = localStorage.getItem('autocuan_device_id');
              if (stored) return stored;
            } catch (_) {}
            return 'dev_' + Date.now().toString(16);
          })();

      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timeout = setTimeout(function () {
        try { if (controller) controller.abort(); } catch (_) {}
      }, 10000);
      var recaptchaToken = '';
      if (window.grecaptcha && typeof window.grecaptcha.execute === 'function' && window.__RECAPTCHA_SITE_KEY__) {
        try { recaptchaToken = await window.grecaptcha.execute(window.__RECAPTCHA_SITE_KEY__, { action: 'login' }); } catch (_) {}
      }

      var response, data;
      try {
        response = await fetch('/api/login-user', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache'
          },
          body: JSON.stringify({
            username: username,
            passwordHash: passwordHash,
            deviceId: deviceId,
            userAgent: navigator.userAgent,
            recaptchaToken: recaptchaToken || undefined
          }),
          signal: controller ? controller.signal : undefined
        });
        data = await response.json().catch(function () { return {}; });
      } finally {
        clearTimeout(timeout);
      }

      if (response && response.ok && data.success === true) {
        window.__AUTOCUAN_AUTHENTICATED_SESSION__ = data;
        storeSession(data);
        passwordEl.value = '';
        if (typeof window.refreshSubscriptionStatus === 'function') {
          try { window.refreshSubscriptionStatus(); } catch (_) {}
        }
        if (typeof window.logLogin === 'function') {
          try { window.logLogin(data.username, false, data.isAdmin === true); } catch (_) {}
        }
        if (typeof window.closeLoginModal === 'function') window.closeLoginModal();
        if (typeof window.closeAuthChoiceModal === 'function') window.closeAuthChoiceModal();

        var sessionCheck = await validateServerSession();
        if (sessionCheck && sessionCheck.email_required === true) {
          return;
        }
        if (typeof window.enterApp === 'function') window.enterApp({ replaceHistory: true });
        return;
      }

      if (data && data.approval_status === 'pending' && /^AC-[A-F0-9]{6}$/.test(String(data.approval_code || ''))) {
        if (typeof window.showPendingLoginApproval === 'function') {
          window.showPendingLoginApproval(data);
          return;
        }
      }

      if (data && (data.code === 'DEVICE_APPROVAL_PENDING' || data.approval_token)) {
        if (typeof window.showAdminDeviceApprovalModal === 'function') {
          window.showAdminDeviceApprovalModal(data);
          return;
        }
      }

      errorEl.textContent = (data && data.error) || 'Login gagal.';
      errorEl.classList.remove('hidden');
    } catch (_) {
      errorEl.textContent = 'Koneksi ke server sedang bermasalah. Coba beberapa saat lagi.';
      errorEl.classList.remove('hidden');
    } finally {
      loginBtn.disabled = false;
      loginBtn.innerHTML = 'Masuk';
    }
  }

  function modalShell(inner) {
    return [
      '<div class="fixed inset-0 z-[100000] flex items-center justify-center p-4" style="background:var(--backdrop-surface, rgba(15,23,42,0.75));">',
      '  <div class="w-full max-w-md rounded-2xl p-6" style="background:var(--surface); border:1px solid var(--border-subtle); color:var(--text-primary); box-shadow:0 20px 40px rgba(0,0,0,0.35);">',
      inner,
      '  </div>',
      '</div>'
    ].join('');
  }

  function ensureResetModal() {
    var existing = byId(RESET_MODAL_ID);
    if (existing) return existing;
    var modal = document.createElement('div');
    modal.id = RESET_MODAL_ID;
    modal.className = 'hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Pemulihan akun');
    modal.style.zIndex = '100000';
    document.body.appendChild(modal);
    return modal;
  }

  function closeResetModal() {
    var modal = byId(RESET_MODAL_ID);
    if (modal) modal.classList.add('hidden');
  }

  function showResetRequest() {
    var modal = ensureResetModal();
    modal.innerHTML = modalShell([
      '<div class="flex items-start justify-between gap-4">',
      '  <div><p class="text-xs font-bold uppercase tracking-wider" style="color:var(--accent-primary);">Pemulihan akun</p><h2 class="mt-1 text-xl font-black" style="color:var(--text-primary);">Reset lewat Telegram</h2></div>',
      '  <button type="button" id="authV2ResetClose" class="text-2xl leading-none" style="color:var(--text-secondary); background:transparent; border:none; cursor:pointer;" aria-label="Tutup">&times;</button>',
      '</div>',
      '<form id="authV2ResetRequestForm" class="mt-3" onsubmit="return false;">',
      '  <p class="text-sm leading-6" style="color:var(--text-secondary);">Masukkan username. Bot verifikasi akan meminta konfirmasi pada akun Telegram yang sudah terhubung.</p>',
      '  <label class="mt-5 block text-sm font-medium" style="color:var(--text-secondary);" for="authV2ResetUsername">Username</label>',
      '  <input id="authV2ResetUsername" name="username" aria-label="Username pemulihan akun" autocomplete="username" class="mt-2 w-full rounded-xl px-4 py-3 outline-none" style="background:var(--canvas); border:1px solid var(--border-subtle); color:var(--text-primary); font-size:16px; min-height:44px;" />',
      '  <p id="authV2ResetMessage" class="mt-3 hidden rounded-xl border px-3 py-2 text-sm" role="alert" aria-live="assertive"></p>',
      '  <button type="submit" id="authV2ResetRequestBtn" class="mt-5 w-full rounded-xl px-4 py-3 font-bold" style="background:var(--accent-primary); color:var(--color-on-accent,#ffffff); min-height:44px; border:none; cursor:pointer;">Kirim konfirmasi ke bot</button>',
      '</form>',
      '<p class="mt-4 text-xs leading-5" style="color:var(--text-muted);">Password tidak dikirim ke Telegram. Bot hanya menyetujui atau menolak permintaan reset.</p>'
    ].join(''));
    modal.classList.remove('hidden');

    byId('authV2ResetClose').addEventListener('click', closeResetModal);
    byId('authV2ResetRequestForm').addEventListener('submit', function (e) {
      e.preventDefault();
      requestResetFromBot();
    });
    var oldModal = byId('selfResetModal');
    if (oldModal) oldModal.classList.add('hidden');
  }

  function setResetMessage(text, ok) {
    var el = byId('authV2ResetMessage');
    if (!el) return;
    el.textContent = text;
    el.className = 'mt-3 rounded-xl border px-3 py-2 text-sm ' +
      (ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-red-500/30 bg-red-500/10 text-red-200');
  }

  async function requestResetFromBot() {
    var usernameEl = byId('authV2ResetUsername');
    var button = byId('authV2ResetRequestBtn');
    var username = usernameEl ? usernameEl.value.trim().toLowerCase() : '';
    if (!username || username.length < 2) {
      setResetMessage('Masukkan username yang valid.', false);
      return;
    }

    button.disabled = true;
    button.textContent = 'Mengirim…';
    try {
      var result = await authRequest('request-password-reset', { username: username });
      if (!result.response.ok || result.data.success !== true) {
        setResetMessage(result.data.error || 'Pemulihan sementara belum tersedia.', false);
        return;
      }
      setResetMessage('Cek chat pribadi AutoCuanVerificationBot, lalu tekan Konfirmasi Reset.', true);
    } catch (_) {
      setResetMessage('Koneksi ke server sedang bermasalah.', false);
    } finally {
      button.disabled = false;
      button.textContent = 'Kirim konfirmasi ke bot';
    }
  }

  function validNewPassword(password) {
    return typeof password === 'string' && password.length >= 8 &&
      /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password);
  }

  function showResetCompletion(resetToken) {
    var modal = ensureResetModal();
    modal.innerHTML = modalShell([
      '<div class="flex items-start justify-between gap-4">',
      '  <div><p class="text-xs font-bold uppercase tracking-wider" style="color:var(--accent-primary);">Telegram terkonfirmasi</p><h2 class="mt-1 text-xl font-black" style="color:var(--text-primary);">Buat password baru</h2></div>',
      '  <button type="button" id="authV2ResetClose" class="text-2xl leading-none" style="color:var(--text-secondary); background:transparent; border:none; cursor:pointer;" aria-label="Tutup">&times;</button>',
      '</div>',
      '<form id="authV2ResetCompleteForm" class="mt-3" onsubmit="return false;">',
      '  <p class="text-sm leading-6" style="color:var(--text-secondary);">Gunakan minimal 8 karakter dengan huruf besar, huruf kecil, dan angka.</p>',
      '  <label class="mt-5 block text-sm font-medium" style="color:var(--text-secondary);" for="authV2NewPassword">Password baru</label>',
      '  <input id="authV2NewPassword" name="password" type="password" aria-label="Password baru" autocomplete="new-password" class="mt-2 w-full rounded-xl px-4 py-3 outline-none" style="background:var(--canvas); border:1px solid var(--border-subtle); color:var(--text-primary); font-size:16px; min-height:44px;" />',
      '  <label class="mt-4 block text-sm font-medium" style="color:var(--text-secondary);" for="authV2NewPasswordConfirm">Konfirmasi password</label>',
      '  <input id="authV2NewPasswordConfirm" name="passwordConfirm" type="password" aria-label="Konfirmasi password baru" autocomplete="new-password" class="mt-2 w-full rounded-xl px-4 py-3 outline-none" style="background:var(--canvas); border:1px solid var(--border-subtle); color:var(--text-primary); font-size:16px; min-height:44px;" />',
      '  <p id="authV2ResetMessage" class="mt-3 hidden rounded-xl border px-3 py-2 text-sm" role="alert" aria-live="assertive"></p>',
      '  <button type="submit" id="authV2ResetCompleteBtn" class="mt-5 w-full rounded-xl px-4 py-3 font-bold" style="background:var(--accent-primary); color:var(--color-on-accent,#ffffff); min-height:44px; border:none; cursor:pointer;">Simpan password baru</button>',
      '</form>'
    ].join(''));
    modal.classList.remove('hidden');
    byId('authV2ResetClose').addEventListener('click', closeResetModal);
    byId('authV2ResetCompleteForm').addEventListener('submit', function (e) {
      e.preventDefault();
      completeReset(resetToken);
    });
  }

  async function completeReset(resetToken) {
    var password = byId('authV2NewPassword').value;
    var confirmation = byId('authV2NewPasswordConfirm').value;
    var button = byId('authV2ResetCompleteBtn');

    if (!validNewPassword(password)) {
      setResetMessage('Password harus minimal 8 karakter serta memiliki huruf besar, huruf kecil, dan angka.', false);
      return;
    }
    if (password !== confirmation) {
      setResetMessage('Konfirmasi password tidak sama.', false);
      return;
    }

    button.disabled = true;
    button.textContent = 'Menyimpan…';
    try {
      if (typeof window.hashPassword !== 'function') throw new Error('hash_unavailable');
      var newPasswordHash = await window.hashPassword(password);
      var result = await authRequest('complete-password-reset', {
        resetToken: resetToken,
        newPasswordHash: newPasswordHash
      });
      if (!result.response.ok || result.data.success !== true) {
        setResetMessage(result.data.error || 'Password belum berhasil diperbarui.', false);
        return;
      }

      clearLocalAuthState();
      setResetMessage('Password berhasil diperbarui. Silakan login dengan password baru.', true);
      var cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('reset_token');
      history.replaceState({}, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
      setTimeout(function () {
        closeResetModal();
        if (typeof window.openLoginModal === 'function') window.openLoginModal();
      }, 1200);
    } catch (_) {
      setResetMessage('Koneksi ke server sedang bermasalah.', false);
    } finally {
      button.disabled = false;
      button.textContent = 'Simpan password baru';
    }
  }

  function installRecoveryUi() {
    window.openSelfResetModal = showResetRequest;
    window.closeAuthV2ResetModal = closeResetModal;
    window.closeSelfResetModal = closeResetModal;
    window.doSelfResetPassword = showResetRequest;

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeResetModal();
    });

    var params = new URLSearchParams(window.location.search);
    var resetToken = params.get('reset_token');
    if (resetToken && /^[A-Za-z0-9_-]{32,100}$/.test(resetToken)) {
      showResetCompletion(resetToken);
    }
  }

  async function init() {
    installLoginModalReset();
    window.doLogin = doLoginV2;
    installRecoveryUi();
    var status = await validateServerSession();
    authReadyResolve(status);
  }

  window.clearAutocuanAuthState = clearLocalAuthState;
  window.validateAutocuanSession = validateServerSession;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
