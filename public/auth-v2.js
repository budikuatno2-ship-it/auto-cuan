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
                if (result.response.status === 403) {
                  window.openAuthChoiceModal('Akses ditolak. Akun Anda belum disetujui atau tidak memiliki izin.');
                } else {
                  window.openAuthChoiceModal('Sesi sudah tidak berlaku. Silakan login kembali.');
                }
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
      '<div class="fixed inset-0 z-[100000] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">',
      '  <div class="w-full max-w-[460px] rounded-2xl p-7 shadow-2xl space-y-4" style="background:var(--ac-surface, #111827); border:1px solid var(--ac-hair, rgba(255,255,255,0.1)); color:var(--ac-ink, #ffffff);">',
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
      '<div class="flex items-start justify-between gap-3">',
      '  <div>',
      '    <h2 id="authV2ResetTitle" class="text-xl font-bold tracking-tight m-0" style="color:var(--ac-ink, #ffffff);">Pulihkan password</h2>',
      '    <p class="text-xs mt-1 m-0" style="color:var(--ac-2, #9ca3af);">Verifikasi melalui bot Telegram yang terhubung ke akun Anda.</p>',
      '  </div>',
      '  <button type="button" id="authV2ResetClose" class="text-2xl leading-none bg-transparent border-0 cursor-pointer p-1" style="color:var(--ac-muted, #9ca3af);" aria-label="Tutup">&times;</button>',
      '</div>',
      '<div class="wz flex items-center justify-between my-3 text-xs" aria-label="Langkah 1 dari 3">',
      '  <span class="w-6 h-6 rounded-full font-bold flex items-center justify-center text-white" style="background:var(--ac-brand, #10b981);">1</span>',
      '  <span class="flex-1 h-[2px] mx-2" style="background:var(--ac-hair, rgba(255,255,255,0.15));"></span>',
      '  <span class="w-6 h-6 rounded-full font-bold flex items-center justify-center" style="background:var(--ac-hover, rgba(255,255,255,0.08)); color:var(--ac-muted, #9ca3af);">2</span>',
      '  <span class="flex-1 h-[2px] mx-2" style="background:var(--ac-hair, rgba(255,255,255,0.15));"></span>',
      '  <span class="w-6 h-6 rounded-full font-bold flex items-center justify-center" style="background:var(--ac-hover, rgba(255,255,255,0.08)); color:var(--ac-muted, #9ca3af);">3</span>',
      '</div>',
      '<form id="authV2ResetRequestForm" class="space-y-3.5" onsubmit="return false;">',
      '  <div>',
      '    <label class="block text-xs font-semibold mb-1" style="color:var(--ac-ink, #e5e7eb);" for="authV2ResetUsername">Gmail atau username</label>',
      '    <input id="authV2ResetUsername" name="username" aria-label="Username pemulihan akun" autocomplete="username" placeholder="nama@gmail.com atau username" class="w-full rounded-xl px-3.5 py-2.5 outline-none text-sm" style="background:var(--ac-canvas, #0b0e14); border:1px solid var(--ac-ctl, #374151); color:var(--ac-ink, #ffffff); min-height:42px;" />',
      '    <p class="text-[11px] mt-1 m-0" style="color:var(--ac-2, #9ca3af);">Kode verifikasi dikirim ke Telegram yang sudah tertaut, bukan ke email.</p>',
      '  </div>',
      '  <p id="authV2ResetMessage" class="hidden rounded-xl border px-3 py-2 text-xs" role="alert" aria-live="assertive"></p>',
      '  <button type="submit" id="authV2ResetRequestBtn" class="w-full py-2.5 rounded-xl text-sm font-bold text-white transition-all cursor-pointer border-0" style="background:linear-gradient(135deg, #059669, #10b981); min-height:42px;">Kirim kode ke Telegram</button>',
      '  <button type="button" id="authV2ResetCancelBtn" class="w-full py-2 rounded-xl text-xs font-medium transition cursor-pointer bg-transparent" style="border:1px solid var(--ac-hair, #374151); color:var(--ac-2, #9ca3af);">Batal</button>',
      '</form>'
    ].join(''));
    modal.classList.remove('hidden');

    byId('authV2ResetClose').addEventListener('click', closeResetModal);
    var cancelBtn = byId('authV2ResetCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeResetModal);
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
    el.className = 'rounded-xl border px-3 py-2 text-xs ' +
      (ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-red-500/30 bg-red-500/10 text-red-300');
  }

  async function requestResetFromBot() {
    var usernameEl = byId('authV2ResetUsername');
    var button = byId('authV2ResetRequestBtn');
    var username = usernameEl ? usernameEl.value.trim().toLowerCase() : '';
    if (!username || username.length < 2) {
      setResetMessage('Masukkan username atau Gmail yang valid.', false);
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
      setResetMessage('Permintaan terkirim! Cek chat pribadi bot verifikasi Auto-Cuan di Telegram, lalu tekan Konfirmasi Reset.', true);
    } catch (_) {
      setResetMessage('Koneksi ke server sedang bermasalah.', false);
    } finally {
      button.disabled = false;
      button.textContent = 'Kirim kode ke Telegram';
    }
  }

  function validNewPassword(password) {
    return typeof password === 'string' && password.length >= 8 &&
      /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password);
  }

  function showResetCompletion(resetToken) {
    var modal = ensureResetModal();
    modal.innerHTML = modalShell([
      '<div class="flex items-start justify-between gap-3">',
      '  <div>',
      '    <h2 id="authV2ResetTitle" class="text-xl font-bold tracking-tight m-0" style="color:var(--ac-ink, #ffffff);">Buat password baru</h2>',
      '    <p class="text-xs mt-1 m-0" style="color:var(--ac-2, #9ca3af);">Telegram terkonfirmasi. Silakan tentukan password baru.</p>',
      '  </div>',
      '  <button type="button" id="authV2ResetClose" class="text-2xl leading-none bg-transparent border-0 cursor-pointer p-1" style="color:var(--ac-muted, #9ca3af);" aria-label="Tutup">&times;</button>',
      '</div>',
      '<div class="wz flex items-center justify-between my-3 text-xs" aria-label="Langkah 3 dari 3">',
      '  <span class="w-6 h-6 rounded-full font-bold flex items-center justify-center" style="background:var(--ac-brand-soft, rgba(16,185,129,0.2)); color:var(--ac-brand, #10b981);">✓</span>',
      '  <span class="flex-1 h-[2px] mx-2" style="background:var(--ac-brand, #10b981);"></span>',
      '  <span class="w-6 h-6 rounded-full font-bold flex items-center justify-center" style="background:var(--ac-brand-soft, rgba(16,185,129,0.2)); color:var(--ac-brand, #10b981);">✓</span>',
      '  <span class="flex-1 h-[2px] mx-2" style="background:var(--ac-brand, #10b981);"></span>',
      '  <span class="w-6 h-6 rounded-full font-bold flex items-center justify-center text-white" style="background:var(--ac-brand, #10b981);">3</span>',
      '</div>',
      '<form id="authV2ResetCompleteForm" class="space-y-3.5" onsubmit="return false;">',
      '  <div>',
      '    <label class="block text-xs font-semibold mb-1" style="color:var(--ac-ink, #e5e7eb);" for="authV2NewPassword">Password baru</label>',
      '    <input id="authV2NewPassword" name="password" type="password" aria-label="Password baru" autocomplete="new-password" placeholder="Minimal 8 karakter, huruf dan angka" class="w-full rounded-xl px-3.5 py-2.5 outline-none text-sm" style="background:var(--ac-canvas, #0b0e14); border:1px solid var(--ac-ctl, #374151); color:var(--ac-ink, #ffffff); min-height:42px;" />',
      '  </div>',
      '  <div>',
      '    <label class="block text-xs font-semibold mb-1" style="color:var(--ac-ink, #e5e7eb);" for="authV2NewPasswordConfirm">Konfirmasi password baru</label>',
      '    <input id="authV2NewPasswordConfirm" name="passwordConfirm" type="password" aria-label="Konfirmasi password baru" autocomplete="new-password" placeholder="Ulangi password baru" class="w-full rounded-xl px-3.5 py-2.5 outline-none text-sm" style="background:var(--ac-canvas, #0b0e14); border:1px solid var(--ac-ctl, #374151); color:var(--ac-ink, #ffffff); min-height:42px;" />',
      '    <p class="text-[11px] mt-1 m-0" style="color:var(--ac-2, #9ca3af);">Semua sesi lain akan keluar setelah password diganti.</p>',
      '  </div>',
      '  <p id="authV2ResetMessage" class="hidden rounded-xl border px-3 py-2 text-xs" role="alert" aria-live="assertive"></p>',
      '  <button type="submit" id="authV2ResetCompleteBtn" class="w-full py-2.5 rounded-xl text-sm font-bold text-white transition-all cursor-pointer border-0" style="background:linear-gradient(135deg, #059669, #10b981); min-height:42px;">Simpan password</button>',
      '</form>'
    ].join(''));
    modal.classList.remove('hidden');
    byId('authV2ResetClose').addEventListener('click', closeResetModal);
    byId('authV2ResetCompleteForm').addEventListener('submit', function (e) {
      e.preventDefault();
      completeReset(resetToken);
    });
  }

  function showResetSuccess() {
    var modal = ensureResetModal();
    modal.innerHTML = modalShell([
      '<div class="text-center py-4 space-y-3">',
      '  <span class="w-12 h-12 rounded-full inline-grid place-items-center mb-1" style="background:var(--ac-pos-soft, rgba(16,185,129,0.15)); color:var(--ac-pos, #10b981);">',
      '    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
      '  </span>',
      '  <h2 class="text-xl font-bold tracking-tight m-0" style="color:var(--ac-ink, #ffffff);">Password diperbarui</h2>',
      '  <p class="text-xs m-0" style="color:var(--ac-2, #9ca3af);">Silakan masuk kembali dengan password baru.</p>',
      '  <div class="pt-3">',
      '    <button type="button" id="authV2SuccessLoginBtn" class="w-full py-2.5 rounded-xl text-sm font-bold text-white transition-all cursor-pointer border-0" style="background:linear-gradient(135deg, #059669, #10b981); min-height:42px;">Masuk</button>',
      '  </div>',
      '</div>'
    ].join(''));
    modal.classList.remove('hidden');
    var loginBtn = byId('authV2SuccessLoginBtn');
    if (loginBtn) {
      loginBtn.addEventListener('click', function () {
        closeResetModal();
        if (typeof window.openLoginModal === 'function') window.openLoginModal();
      });
    }
  }

  async function completeReset(resetToken) {
    var password = byId('authV2NewPassword').value;
    var confirmation = byId('authV2NewPasswordConfirm').value;
    var button = byId('authV2ResetCompleteBtn');

    if (!validNewPassword(password)) {
      setResetMessage('Password baru minimal 8 karakter dan memuat huruf besar, huruf kecil, serta angka.', false);
      return;
    }
    if (password !== confirmation) {
      setResetMessage('Konfirmasi tidak sama dengan password baru.', false);
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
      var cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('reset_token');
      history.replaceState({}, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
      showResetSuccess();
    } catch (_) {
      setResetMessage('Koneksi ke server sedang bermasalah.', false);
    } finally {
      button.disabled = false;
      button.textContent = 'Simpan password';
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
