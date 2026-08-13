(function () {
  'use strict';

  if (window.__AUTOCUAN_AUTH_V2__) return;
  window.__AUTOCUAN_AUTH_V2__ = true;

  var AUTH_API = '/api/reset-password';
  var RESET_MODAL_ID = 'authV2ResetModal';
  var authReadyResolve;
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
        storeSession(result.data);
        window.__AUTOCUAN_AUTHENTICATED_SESSION__ = result.data;
        if (typeof window.updateDashGreeting === 'function') {
          try { window.updateDashGreeting(); } catch (_) {}
        }
        if (window.location.pathname === '/dashboard' || window.location.pathname === '/dashboard/') {
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
        returnToGuest({ skipHistory: true });
        if (window.location.pathname === '/dashboard' || window.location.pathname === '/dashboard/') {
          if (typeof window.openAuthChoiceModal === 'function') {
            try { window.openAuthChoiceModal('Sesi sudah tidak berlaku. Silakan login kembali.'); } catch (_) {}
          }
        }
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
      errorEl.textContent = 'Username tidak valid.';
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
      var result = await authRequest('login', {
        username: username,
        passwordHash: passwordHash,
        userAgent: navigator.userAgent
      });
      var data = result.data || {};

      if (result.response.ok && data.success === true) {
        storeSession(data);
        window.__AUTOCUAN_AUTHENTICATED_SESSION__ = data;
        passwordEl.value = '';
        if (typeof window.refreshSubscriptionStatus === 'function') {
          try { window.refreshSubscriptionStatus(); } catch (_) {}
        }
        if (typeof window.logLogin === 'function') {
          try { window.logLogin(data.username, false, data.isAdmin === true); } catch (_) {}
        }
        if (typeof window.closeLoginModal === 'function') window.closeLoginModal();
        if (typeof window.closeAuthChoiceModal === 'function') window.closeAuthChoiceModal();
        if (typeof window.enterApp === 'function') window.enterApp({ replaceHistory: true });
        return;
      }

      if (data.approval_status === 'pending' && /^AC-[A-F0-9]{6}$/.test(String(data.approval_code || ''))) {
        if (typeof window.showPendingLoginApproval === 'function') {
          window.showPendingLoginApproval(data);
          return;
        }
      }

      errorEl.textContent = data.error || 'Login gagal.';
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
      '<div class="fixed inset-0 z-[100000] flex items-center justify-center bg-black/75 px-4 backdrop-blur-sm">',
      '  <div class="w-full max-w-md rounded-3xl border border-slate-700 bg-[#111827] p-6 shadow-2xl">',
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
      '  <div><p class="text-xs font-bold uppercase tracking-wider text-emerald-300">Pemulihan akun</p><h2 class="mt-1 text-xl font-black text-white">Reset lewat Telegram</h2></div>',
      '  <button id="authV2ResetClose" class="text-2xl leading-none text-slate-400 hover:text-white" aria-label="Tutup">&times;</button>',
      '</div>',
      '<p class="mt-3 text-sm leading-6 text-slate-400">Masukkan username. Bot verifikasi akan meminta konfirmasi pada akun Telegram yang sudah terhubung.</p>',
      '<label class="mt-5 block text-sm text-slate-300" for="authV2ResetUsername">Username</label>',
      '<input id="authV2ResetUsername" autocomplete="username" class="mt-2 w-full rounded-xl border border-slate-600 bg-slate-950/70 px-4 py-3 text-white outline-none focus:border-emerald-400" />',
      '<p id="authV2ResetMessage" class="mt-3 hidden rounded-xl border px-3 py-2 text-sm"></p>',
      '<button id="authV2ResetRequestBtn" class="mt-5 w-full rounded-xl bg-emerald-500 px-4 py-3 font-bold text-slate-950 hover:bg-emerald-400">Kirim konfirmasi ke bot</button>',
      '<p class="mt-4 text-xs leading-5 text-slate-500">Password tidak dikirim ke Telegram. Bot hanya menyetujui atau menolak permintaan reset.</p>'
    ].join(''));
    modal.classList.remove('hidden');

    byId('authV2ResetClose').addEventListener('click', closeResetModal);
    byId('authV2ResetRequestBtn').addEventListener('click', requestResetFromBot);
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
      '  <div><p class="text-xs font-bold uppercase tracking-wider text-emerald-300">Telegram terkonfirmasi</p><h2 class="mt-1 text-xl font-black text-white">Buat password baru</h2></div>',
      '  <button id="authV2ResetClose" class="text-2xl leading-none text-slate-400 hover:text-white" aria-label="Tutup">&times;</button>',
      '</div>',
      '<p class="mt-3 text-sm leading-6 text-slate-400">Gunakan minimal 8 karakter dengan huruf besar, huruf kecil, dan angka.</p>',
      '<label class="mt-5 block text-sm text-slate-300" for="authV2NewPassword">Password baru</label>',
      '<input id="authV2NewPassword" type="password" autocomplete="new-password" class="mt-2 w-full rounded-xl border border-slate-600 bg-slate-950/70 px-4 py-3 text-white outline-none focus:border-emerald-400" />',
      '<label class="mt-4 block text-sm text-slate-300" for="authV2NewPasswordConfirm">Konfirmasi password</label>',
      '<input id="authV2NewPasswordConfirm" type="password" autocomplete="new-password" class="mt-2 w-full rounded-xl border border-slate-600 bg-slate-950/70 px-4 py-3 text-white outline-none focus:border-emerald-400" />',
      '<p id="authV2ResetMessage" class="mt-3 hidden rounded-xl border px-3 py-2 text-sm"></p>',
      '<button id="authV2ResetCompleteBtn" class="mt-5 w-full rounded-xl bg-emerald-500 px-4 py-3 font-bold text-slate-950 hover:bg-emerald-400">Simpan password baru</button>'
    ].join(''));
    modal.classList.remove('hidden');
    byId('authV2ResetClose').addEventListener('click', closeResetModal);
    byId('authV2ResetCompleteBtn').addEventListener('click', function () {
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
    window.closeSelfResetModal = closeResetModal;
    window.doSelfResetPassword = showResetRequest;

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
