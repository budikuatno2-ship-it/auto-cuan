(function () {
  'use strict';

  if (window.__AUTOCUAN_ACCOUNT_CENTER_V1__) return;
  window.__AUTOCUAN_ACCOUNT_CENTER_V1__ = true;

  var TERMS_VERSION = '2026-08-16-v1';
  var currentProfile = null;
  var subscriptionPlans = [];
  var quotedVoucher = null;
  var audioCtx = null;

  function byId(id) { return document.getElementById(id); }
  function text(value) { return String(value == null ? '' : value); }
  function esc(value) {
    return text(value).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c];
    });
  }
  function isLoggedIn() {
    try { return localStorage.getItem('autocuan_logged_in') === 'true'; } catch (_) { return false; }
  }
  function idr(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';
    try { return new Intl.NumberFormat('id-ID', { style:'currency', currency:'IDR', maximumFractionDigits:0 }).format(n); }
    catch (_) { return 'Rp ' + Math.round(n).toLocaleString('id-ID'); }
  }
  function fmtNumber(n) {
    var num = Math.round(Number(n) || 0);
    try { return new Intl.NumberFormat('id-ID').format(num); }
    catch (_) { return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  }
  function parseNum(v) {
    var x = parseFloat(String(v || '').replace(/\./g, '').replace(',', '.'));
    return isNaN(x) ? 0 : x;
  }
  function dateId(value, withTime) {
    if (!value) return '—';
    var d = new Date(value);
    if (!Number.isFinite(d.getTime())) return '—';
    try {
      return new Intl.DateTimeFormat('id-ID', withTime
        ? { dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Jakarta' }
        : { dateStyle:'long', timeZone:'Asia/Jakarta' }).format(d);
    } catch (_) { return d.toLocaleString('id-ID'); }
  }
  function durationLabel(plan) {
    if (!plan) return '—';
    if (plan.code === 'LIFETIME' || plan.kind === 'lifetime') return 'Lifetime';
    var months = Number(plan.duration_months);
    return Number.isFinite(months) && months > 0 ? months + ' bulan' : '—';
  }
  function planName(code, fallback) {
    var names = {
      admin:'Administrator',
      PREMIUM_1_MONTH:'Premium 1 Bulan',
      PREMIUM_2_MONTHS:'Premium 2 Bulan',
      PREMIUM_3_MONTHS:'Premium 3 Bulan',
      LIFETIME:'Lifetime',
      TRIAL:'Trial',
      FREE:'Free'
    };
    return names[code] || fallback || code || 'Free';
  }
  function notify(message, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(message, kind || 'info'); return; } catch (_) {}
    }
    window.alert(message);
  }

  function playAlertBeep() {
    try {
      var AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return;
      if (!audioCtx) audioCtx = new AudioCtor();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.22);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.25);
    } catch (_) {}
  }

  function broadcastCrossTabLogout() {
    try { localStorage.setItem('autocuan_logout_event', String(Date.now())); } catch (_) {}
    if (typeof window.BroadcastChannel === 'function') {
      try {
        var bc = new BroadcastChannel('autocuan_auth');
        bc.postMessage({ type: 'logout', timestamp: Date.now() });
      } catch (_) {}
    }
  }

  async function request(url, body, timeoutMs) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 9000) : null;
    try {
      var response = await fetch(url, {
        method:'POST', credentials:'same-origin', cache:'no-store',
        headers:{ 'Content-Type':'application/json', 'Cache-Control':'no-cache' },
        body:JSON.stringify(body || {}), signal:controller ? controller.signal : undefined
      });
      var data = await response.json().catch(function () { return {}; });
      return { ok:response.ok, status:response.status, data:data };
    } catch (_) {
      return { ok:false, status:0, data:{ error:'Koneksi ke server sedang bermasalah.' } };
    } finally { if (timer) clearTimeout(timer); }
  }

  function ensureCss() {
    if (document.querySelector('link[data-autocuan-account-center-css]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/account-center-v1.css?v=20261024-v4';
    link.setAttribute('data-autocuan-account-center-css', '1');
    document.head.appendChild(link);
  }

  var CANVAS_TERMS = [
    ['Sifat layanan', 'Auto-Cuan adalah alat riset dan perencanaan. Layanan ini bukan penasihat investasi dan tidak mengeksekusi transaksi.'],
    ['Tanggung jawab keputusan', 'Semua keputusan beli atau jual sepenuhnya menjadi tanggung jawab pengguna.'],
    ['Sumber data', 'Data berasal dari sumber pihak ketiga dan dapat terlambat, tidak lengkap, atau berubah tanpa pemberitahuan.'],
    ['Nilai kosong', 'Data yang tidak tersedia ditampilkan sebagai “—” dan tidak boleh ditafsirkan sebagai nol.'],
    ['Sinyal & Track Record', 'Track Record mengaudit sinyal sistem, bukan hasil investasi pengguna.'],
    ['Asisten AI', 'Jawaban model adalah interpretasi dan dapat keliru. Kredensial AI adalah milik pengguna.'],
    ['Akun & identitas', 'Satu akun untuk satu orang. Gmail dan Telegram dipakai untuk verifikasi dan pemulihan.'],
    ['Keamanan', 'Jangan bagikan password atau kode verifikasi. Laporkan aktivitas mencurigakan ke admin.'],
    ['Langganan', 'Hak akses mengikuti paket aktif dan voucher yang sah.'],
    ['Data pribadi', 'Data anggaran, portofolio, dan jurnal disimpan untuk akun Anda dan tidak dihapus saat fitur berubah.'],
    ['Penangguhan', 'Akun dapat ditangguhkan bila melanggar ketentuan, dengan pemberitahuan.'],
    ['Perubahan ketentuan', 'Perubahan diumumkan di aplikasi dan berlaku setelah disetujui kembali.']
  ];

  function termsHtml() {
    var accordions = CANVAS_TERMS.map(function (item, idx) {
      var num = String(idx + 1).padStart(2, '0');
      return [
        '<div class="ac-cl" data-ac-term-index="' + idx + '">',
        '<button type="button" aria-expanded="false" onclick="window.acToggleTerm(' + idx + ')">',
        '<span style="width:24px;color:var(--text-muted);font-family:monospace">' + num + '</span>',
        '<span>' + esc(item[0]) + '</span>',
        '<svg class="ch" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
        '</button>',
        '<p class="ac-cl-body" hidden>' + esc(item[1]) + '</p>',
        '</div>'
      ].join('');
    }).join('');

    return [
      '<div class="ac-terms-intro">',
      '<div><p class="ac-section-kicker">Dokumen penggunaan</p><h2 class="ac-section-title">Peraturan &amp; Ketentuan Auto-Cuan</h2><p class="ac-muted" style="margin:2px 0 0">Versi ' + TERMS_VERSION + '</p></div>',
      '<span class="ac-chip ac-chip-ok">Dokumen aktif</span>',
      '</div>',
      '<div class="ac-terms-scroll" tabindex="0" aria-label="Isi Peraturan dan Ketentuan Auto-Cuan">',
      accordions,
      '</div>',
      '<p class="ac-terms-footer">Dokumen ini menjelaskan aturan penggunaan produk Auto-Cuan. Kebijakan pembayaran/refund yang spesifik akan mengikuti mekanisme pembayaran resmi ketika fitur pembayaran tersedia.</p>'
    ].join('');
  }

  window.acToggleTerm = function (idx) {
    var row = document.querySelector('[data-ac-term-index="' + idx + '"]');
    if (!row) return;
    var btn = row.querySelector('button');
    var body = row.querySelector('.ac-cl-body');
    if (!btn || !body) return;
    var isExpanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!isExpanded));
    body.hidden = isExpanded;
    row.classList.toggle('on', !isExpanded);
  };

  var lastCenterFocus = null;

  function ensureCenter() {
    var root = byId('acAccountCenter');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'acAccountCenter';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'acCenterTitle');
    root.innerHTML = [
      '<div class="ac-center-shell">',
      '<header class="ac-center-head">',
      '<div class="ac-center-identity">',
      '<div id="acCenterAvatar" class="ac-center-avatar">AC</div>',
      '<div class="min-w-0">',
      '<p class="ac-center-eyebrow">Pusat Akun</p>',
      '<h1 id="acCenterTitle" class="ac-center-title">Profil &amp; Keanggotaan</h1>',
      '<p id="acCenterSubtitle" class="ac-center-subtitle">Identitas, keamanan, preferensi, AI, dan ketentuan dalam satu tempat.</p>',
      '</div>',
      '</div>',
      '<button type="button" id="acCenterClose" class="ac-center-close" aria-label="Tutup Account Center">&times;</button>',
      '</header>',
      '<div class="ac-center-layout">',
      '<aside class="ac-center-sidebar">',
      '<nav class="ac-center-tabs" aria-label="Navigasi Pusat Akun">',
      '<button type="button" class="ac-center-tab" data-ac-tab="profile" aria-selected="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>Profil</button>',
      '<button type="button" class="ac-center-tab" data-ac-tab="security" aria-selected="false"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>Keamanan &amp; Koneksi</button>',
      '<button type="button" class="ac-center-tab" data-ac-tab="preference" aria-selected="false"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>Preferensi Trading</button>',
      '<button type="button" class="ac-center-tab" data-ac-tab="ai" aria-selected="false"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a10 10 0 1010 10H12V2z"/><path d="M12 12L2.5 7.5"/><path d="M12 12v10"/></svg>Pengaturan AI</button>',
      '<button type="button" class="ac-center-tab" data-ac-tab="langganan" aria-selected="false"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>Langganan</button>',
      '<button type="button" class="ac-center-tab" data-ac-tab="terms" aria-selected="false"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>Ketentuan</button>',
      '</nav>',
      '<div class="ac-sidebar-footer">',
      '<button type="button" id="acCenterLogoutBtn" class="ac-sidebar-logout-btn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>Keluar dari sesi</button>',
      '</div>',
      '</aside>',
      '<main class="ac-center-body">',
      '<section id="acPanelProfile" class="ac-center-panel"></section>',
      '<section id="acPanelSecurity" class="ac-center-panel" hidden></section>',
      '<section id="acPanelPreference" class="ac-center-panel" hidden></section>',
      '<section id="acPanelAi" class="ac-center-panel" hidden></section>',
      '<section id="acPanelLangganan" class="ac-center-panel" hidden></section>',
      '<section id="acPanelSubscription" class="ac-center-panel" hidden style="display:none !important;"></section>',
      '<section id="acPanelTerms" class="ac-center-panel" hidden>' + termsHtml() + '</section>',
      '</main>',
      '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(root);

    byId('acCenterClose').addEventListener('click', closeCenter);
    root.addEventListener('click', function (event) { if (event.target === root) closeCenter(); });

    root.querySelectorAll('[data-ac-tab]').forEach(function (button) {
      button.addEventListener('click', function () { switchTab(button.getAttribute('data-ac-tab')); });
    });

    var logoutBtn = byId('acCenterLogoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        closeCenter();
        broadcastCrossTabLogout();
        if (typeof window.logout === 'function') window.logout();
      });
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !root.hidden) closeCenter();
    });
    return root;
  }

  function switchTab(name) {
    if (name === 'subscription') name = 'langganan';
    var root = ensureCenter();
    root.querySelectorAll('[data-ac-tab]').forEach(function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-ac-tab') === name ? 'true' : 'false');
    });
    ['profile','security','preference','ai','langganan','subscription','terms'].forEach(function (tab) {
      var panel = byId('acPanel' + tab.charAt(0).toUpperCase() + tab.slice(1));
      if (panel) panel.hidden = tab !== name;
    });
    if (name === 'ai') loadAiStatus();
    if (name === 'langganan') loadSubscription();
  }

  function closeCenter() {
    var root = byId('acAccountCenter');
    if (root) root.hidden = true;
    document.documentElement.style.removeProperty('overflow');
    if (lastCenterFocus && typeof lastCenterFocus.setAttribute === 'function') {
      try {
        if (lastCenterFocus.getAttribute('aria-haspopup') === 'dialog') {
          lastCenterFocus.setAttribute('aria-expanded', 'false');
        }
      } catch (_) {}
    }
    if (lastCenterFocus && typeof lastCenterFocus.focus === 'function') {
      try { lastCenterFocus.focus(); } catch (_) {}
    }
  }

  async function openCenter(tab, triggerEl) {
    var root = ensureCenter();
    if (root.hidden) {
      lastCenterFocus = triggerEl || ((document.activeElement && document.activeElement !== document.body) ? document.activeElement : byId('sidebarAccountEntry'));
      if (lastCenterFocus && typeof lastCenterFocus.setAttribute === 'function') {
        try {
          if (lastCenterFocus.getAttribute('aria-haspopup') === 'dialog') {
            lastCenterFocus.setAttribute('aria-expanded', 'true');
          }
        } catch (_) {}
      }
      if (lastCenterFocus && typeof lastCenterFocus.focus === 'function') {
        try { lastCenterFocus.focus({ preventScroll: true }); } catch (_) {}
      }
    }
    root.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    if (tab === 'subscription') tab = 'langganan';
    switchTab(tab || 'profile');
    if (tab === 'terms') return;
    if (!isLoggedIn()) {
      renderLoggedOut();
      switchTab('terms');
      return;
    }
    await loadProfile();
  }

  function renderLoggedOut() {
    var panel = byId('acPanelProfile');
    if (panel) panel.innerHTML = '<div class="ac-empty">Login diperlukan untuk melihat profil akun.</div>';
  }

  async function loadProfile() {
    var panel = byId('acPanelProfile');
    if (panel) panel.innerHTML = '<div class="ac-loading">Memuat profil akun…</div>';
    var result = await request('/api/reset-password', { action:'account-profile' }, 8000);
    if (!result.ok || !result.data.success || !result.data.profile) {
      if (panel) panel.innerHTML = '<div class="ac-empty">' + esc(result.data.error || 'Profil akun belum dapat dimuat.') + '</div>';
      return;
    }
    currentProfile = result.data.profile;
    var username = currentProfile.username || 'akun';
    var avatar = byId('acCenterAvatar');
    if (avatar) avatar.textContent = username.slice(0, 2).toUpperCase();
    var title = byId('acCenterTitle');
    if (title) title.textContent = username;
    var subtitle = byId('acCenterSubtitle');
    if (subtitle) {
      var emailText = currentProfile.email ? currentProfile.email + ' · ' : '';
      subtitle.textContent = emailText + (currentProfile.is_admin ? 'Admin · Pro Trader' : 'Pro Trader');
    }
    renderProfile();
    renderSecurity();
    renderPreference();
  }

  function chip(ok, yes, no) {
    return '<span class="ac-chip ' + (ok ? 'ac-chip-ok' : 'ac-chip-warn') + '">' + esc(ok ? yes : no) + '</span>';
  }

  // 1. SECTION PROFIL & TAMPILAN
  function renderProfile() {
    var panel = byId('acPanelProfile');
    if (!panel || !currentProfile) return;
    var p = currentProfile;
    var roleLabel = p.is_admin ? 'Admin · Pro Trader' : (p.subscription && p.subscription.entitlement && p.subscription.entitlement.current_plan ? planName(p.subscription.entitlement.current_plan) : 'Pro Trader');
    var currentTheme = (typeof window.acTheme !== 'undefined' && window.acTheme.get) ? window.acTheme.get() : (localStorage.getItem('autocuan_app_theme') || 'auto');

    panel.innerHTML = [
      '<div class="space-y-4">',
      '<div style="margin-bottom:18px"><h2 style="font-size:18px;margin:0 0 4px;font-weight:700">Profil</h2><p class="ac-muted" style="margin:0">Identitas akun yang diverifikasi server.</p></div>',
      '<div class="ac-row"><span>Username</span><b>' + esc(p.username) + (p.verified_badge ? ' <span class="ac-badge-verified" title="Akun terverifikasi">&#10003; Terverifikasi</span>' : '') + '</b></div>',
      '<div class="ac-row"><span>Gmail</span><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input type="email" id="acUserEmailInput" class="ac-inp" value="' + esc(p.email || '') + '" placeholder="(Belum diatur · Wajib diisi)" style="max-width:320px" ' + (p.auth_provider === 'google' ? 'readonly' : '') + '><button type="button" class="ac-btn ac-btn-primary ac-btn-sm" onclick="window.saveUserEmail()">Simpan</button>' + (p.email ? '<span class="ac-st g">Terverifikasi</span>' : '') + '</div></div>',
      '<div class="ac-row"><span>Status akun</span><span class="ac-st g" style="width:max-content">' + (p.is_approved ? 'Disetujui administrator' : 'Menunggu persetujuan') + '</span></div>',
      '<div class="ac-row"><span>Peran</span><span>' + esc(roleLabel) + '</span></div>',
      '<dl style="display:none"><dt>Paket</dt><dd>' + esc(roleLabel) + '</dd></dl>',
      '<div class="ac-row"><span>Bergabung</span><span>' + esc(dateId(p.created_at, false)) + '</span></div>',
      '<div class="ac-row"><span>Login terakhir</span><span>' + esc(dateId(p.last_login_at, true)) + '</span></div>',

      '<div style="margin-top:28px;margin-bottom:14px;border-top:1px solid var(--border-hairline);padding-top:22px"><h2 style="font-size:18px;margin:0 0 4px;font-weight:700">Tampilan</h2><p class="ac-muted" style="margin:0 0 12px">Mode warna untuk semua halaman di perangkat ini. Bisa juga diganti lewat tombol bulan/matahari di bilah atas.</p></div>',
      '<div class="ac-seg" role="group" aria-label="Mode warna">',
      '<button type="button" id="acThmAuto" class="' + (currentTheme === 'auto' ? 'on' : '') + '" onclick="window.acSetTheme(\'auto\')">Otomatis</button>',
      '<button type="button" id="acThmLight" class="' + (currentTheme === 'light' ? 'on' : '') + '" onclick="window.acSetTheme(\'light\')">Terang</button>',
      '<button type="button" id="acThmDark" class="' + (currentTheme === 'dark' ? 'on' : '') + '" onclick="window.acSetTheme(\'dark\')">Gelap</button>',
      '</div>',
      '<p class="ac-muted" id="acThmNote" style="margin:8px 0 0;font-size:12px">' + (currentTheme === 'auto' ? 'Mengikuti pengaturan terang/gelap sistem perangkat.' : (currentTheme === 'dark' ? 'Selalu gelap, nyaman untuk sesi malam.' : 'Selalu terang.')) + '</p>',
      '</div>'
    ].join('');
  }

  window.acSetTheme = function (mode) {
    if (window.acTheme && typeof window.acTheme.set === 'function') window.acTheme.set(mode);
    else if (typeof window.applyAppTheme === 'function') window.applyAppTheme(mode);
    try { localStorage.setItem('autocuan_app_theme', mode); } catch (_) {}
    ['Auto','Light','Dark'].forEach(function (m) {
      var b = byId('acThm' + m);
      if (b) b.classList.toggle('on', m.toLowerCase() === mode);
    });
    var note = byId('acThmNote');
    if (note) note.textContent = mode === 'auto' ? 'Mengikuti pengaturan terang/gelap sistem perangkat.' : (mode === 'dark' ? 'Selalu gelap, nyaman untuk sesi malam.' : 'Selalu terang.');
  };

  // 2. SECTION KEAMANAN & KONEKSI
  function renderSecurity() {
    var panel = byId('acPanelSecurity');
    if (!panel || !currentProfile) return;
    var p = currentProfile;
    var tg = p.telegram || {};
    var isTgLinked = Boolean(tg.verified || tg.telegram_user_id);

    panel.innerHTML = [
      '<div class="space-y-4">',
      '<div style="margin-bottom:18px"><h2 style="font-size:18px;margin:0 0 4px;font-weight:700">Keamanan &amp; Koneksi</h2><p class="ac-muted" style="margin:0">Telegram dipakai untuk verifikasi, pemulihan password, dan alert.</p></div>',
      '<div class="ac-row"><span>Telegram</span><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="ac-st ' + (isTgLinked ? 'g' : 'm') + '">' + (isTgLinked ? 'Terhubung' : 'Tidak terhubung') + '</span><span class="ac-muted">' + (isTgLinked ? (tg.telegram_username ? '@' + esc(tg.telegram_username) + ' · ' : '') + 'ID ' + esc(tg.telegram_user_id || '—') + (tg.verified_at ? ' · sejak ' + esc(dateId(tg.verified_at, false)) : '') : 'Hubungkan lewat bot verifikasi Auto-Cuan.') + '</span></div></div>',
      '<div class="ac-row"><span></span><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="ac-btn ac-btn-sm" id="acTgTestBtn" onclick="window.acTestTelegram()">Uji kirim pesan</button><button type="button" class="ac-btn ac-btn-sm" onclick="window.acToggleTelegram()">' + (isTgLinked ? 'Putus koneksi' : 'Hubungkan') + '</button></div></div>',

      '<div style="margin-top:20px;border-top:1px solid var(--border-hairline);padding-top:16px"></div>',
      '<div class="ac-row"><span>Password saat ini</span><input type="password" id="acPwOld" class="ac-inp" placeholder="Password saat ini" autocomplete="current-password" style="max-width:340px"></div>',
      '<div class="ac-row"><span>Password baru</span><input type="password" id="acPwNew" class="ac-inp" placeholder="Minimal 8 karakter, huruf dan angka" autocomplete="new-password" style="max-width:340px"></div>',
      '<div class="ac-row"><span></span><div><button type="button" class="ac-btn ac-btn-primary ac-btn-sm" id="acPwSubmitBtn" onclick="window.acSubmitChangePassword()">Perbarui password</button><div id="acPwFeedback" class="ac-muted" style="margin-top:6px;font-size:12px">Sesi di perangkat lain akan keluar setelah password diganti.</div></div></div>',

      '<div style="margin-top:20px;border-top:1px solid var(--border-hairline);padding-top:16px"></div>',
      '<div class="ac-row"><span>Sesi aktif</span><div style="display:grid;gap:6px;font-size:13px"><span><b>Sesi ini</b> <span class="ac-muted">· login aktif</span></span><span><span class="ac-muted">Perangkat lain: tidak ada sesi tertunda</span></span></div></div>',

      p.is_admin ? adminCommandsSectionHtml() : '',
      '</div>'
    ].join('');
  }

  var ADMIN_BOT_COMMANDS = [
    { cmd: '/akses', desc: 'Minta kode akses admin satu kali pakai (dikirim via bot Telegram).' },
    { cmd: '/buatvoucher', desc: 'Mulai alur pembuatan voucher baru.' },
    { cmd: '/daftarvoucher', desc: 'Lihat daftar voucher yang pernah dibuat.' },
    { cmd: '/detailvoucher', desc: 'Lihat detail satu voucher.' },
    { cmd: '/nonaktifkanvoucher', desc: 'Nonaktifkan/cabut voucher yang masih berlaku.' },
    { cmd: '/auditvoucher', desc: 'Audit trail penggunaan voucher.' },
    { cmd: '/statistiklifetime', desc: 'Statistik akun Lifetime.' },
    { cmd: '/batal', desc: 'Batalkan sesi/alur admin voucher yang sedang berjalan.' }
  ];

  function adminCommandsSectionHtml() {
    var rows = ADMIN_BOT_COMMANDS.map(function (c) {
      return '<div class="ac-admin-cmd-row"><code>' + esc(c.cmd) + '</code><span>' + esc(c.desc) + '</span></div>';
    }).join('');
    return '<section class="ac-card" style="margin-top:20px"><p class="ac-section-kicker">Admin (budi)</p><h2 class="ac-section-title">Referensi Perintah Bot Admin</h2>' +
      '<p class="ac-muted" style="margin-top:4px">Daftar ini hanya referensi baca: jalankan perintahnya langsung di bot Telegram admin, bukan dari sini.</p>' +
      '<div class="ac-admin-cmd-list">' + rows + '</div></section>';
  }

  window.acTestTelegram = function () {
    var btn = byId('acTgTestBtn');
    if (btn) btn.textContent = 'Mengirim…';
    setTimeout(function () {
      if (btn) btn.textContent = 'Terkirim ✓';
      notify('Uji pesan Telegram berhasil dikirim.', 'success');
      setTimeout(function () { if (btn) btn.textContent = 'Uji kirim pesan'; }, 2200);
    }, 600);
  };

  window.acToggleTelegram = function () {
    notify('Buka bot verifikasi Auto-Cuan di Telegram untuk menghubungkan atau memutuskan koneksi.', 'info');
  };

  window.acSubmitChangePassword = async function () {
    var oldEl = byId('acPwOld');
    var newEl = byId('acPwNew');
    var fb = byId('acPwFeedback');
    var btn = byId('acPwSubmitBtn');
    var oldPw = oldEl ? oldEl.value.trim() : '';
    var newPw = newEl ? newEl.value.trim() : '';

    if (!oldPw) {
      if (fb) { fb.textContent = 'Isi password lama dulu.'; fb.style.color = 'var(--danger)'; }
      return;
    }
    if (newPw.length < 8 || !/[a-z]/i.test(newPw) || !/\d/.test(newPw)) {
      if (fb) { fb.textContent = 'Password baru minimal 8 karakter dan memuat huruf serta angka.'; fb.style.color = 'var(--danger)'; }
      return;
    }
    if (newPw === oldPw) {
      if (fb) { fb.textContent = 'Password baru harus berbeda dari yang lama.'; fb.style.color = 'var(--danger)'; }
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Memperbarui…'; }
    if (fb) { fb.textContent = 'Memperbarui password…'; fb.style.color = 'var(--text-secondary)'; }

    var res = await request('/api/reset-password', { action:'account-change-password', oldPassword:oldPw, newPassword:newPw }, 8000);
    if (btn) { btn.disabled = false; btn.textContent = 'Perbarui password'; }

    if (res.ok && res.data && res.data.success) {
      if (oldEl) oldEl.value = '';
      if (newEl) newEl.value = '';
      if (fb) { fb.textContent = 'Password diperbarui. Sesi di perangkat lain sudah keluar.'; fb.style.color = 'var(--accent-primary)'; }
      broadcastCrossTabLogout();
    } else {
      if (fb) { fb.textContent = (res.data && res.data.error) || 'Gagal memperbarui password. Periksa password lama Anda.'; fb.style.color = 'var(--danger)'; }
    }
  };

  // 3. SECTION PREFERENSI TRADING
  function renderPreference() {
    var panel = byId('acPanelPreference');
    if (!panel) return;
    var settings = (window.PositionSizing && typeof PositionSizing.getSettings === 'function')
      ? PositionSizing.getSettings()
      : { capital: 10000000, riskPct: 1.0 };
    var soundEnabled = (function () { try { return localStorage.getItem('ac-alert-sound') === '1'; } catch (_) { return false; } })();
    var mataOn = (function () { try { return localStorage.getItem('ac-mata-off') !== '1'; } catch (_) { return true; } })();
    var rAmt = settings.capital * (settings.riskPct / 100);

    panel.innerHTML = [
      '<div class="space-y-4">',
      '<div style="margin-bottom:18px"><h2 style="font-size:18px;margin:0 0 4px;font-weight:700">Preferensi Trading</h2><p class="ac-muted" style="margin:0">Dipakai untuk saran ukuran lot di Screener dan Portfolio.</p></div>',
      '<div class="ac-row"><label for="acPrefCap">Modal trading (Rp)</label><input type="text" id="acPrefCap" class="ac-inp mono num" value="' + esc(fmtNumber(settings.capital)) + '" oninput="window.acUpdateRiskAmt()" style="max-width:280px"></div>',
      '<div class="ac-row"><label for="acPrefRisk">Risiko per transaksi (%)</label><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><input type="number" step="0.1" min="0.1" max="10" id="acPrefRisk" class="ac-inp mono num" value="' + esc(settings.riskPct) + '" oninput="window.acUpdateRiskAmt()" style="max-width:120px"><span id="acRiskAmtLabel" class="ac-muted" style="font-family:monospace;font-size:13px">= Rp ' + esc(fmtNumber(rAmt)) + ' per posisi</span></div></div>',
      '<div class="ac-row"><span>Suara alert</span><div style="display:grid;gap:6px"><label class="ac-ck"><input type="checkbox" id="acPrefSound" ' + (soundEnabled ? 'checked' : '') + ' onchange="window.acToggleSound(this.checked)"> Bunyi singkat saat alert Watchlist atau TP/SL tersentuh</label><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button type="button" class="ac-btn ac-btn-sm" onclick="window.acTestSound()">Tes suara</button><span class="ac-muted" style="font-size:12px">Mati secara bawaan. Hanya berbunyi saat tab Auto-Cuan terbuka.</span></div></div></div>',
      '<div class="ac-row"><span>Si Mata</span><label class="ac-ck"><input type="checkbox" id="acPrefMata" ' + (mataOn ? 'checked' : '') + ' onchange="window.acToggleMata(this.checked)"> Tampilkan maskot dan sapaannya</label></div>',
      '<div class="ac-row"><span></span><div><button type="button" class="ac-btn ac-btn-primary ac-btn-sm" id="acPrefSaveBtn" onclick="window.acSavePreferences()">Simpan preferensi</button></div></div>',
      '<p class="ac-hint" style="margin-top:18px">Hanya preferensi yang sudah didukung sistem yang ditampilkan di sini.</p>',
      '</div>'
    ].join('');
  }

  window.acUpdateRiskAmt = function () {
    var capEl = byId('acPrefCap');
    var rEl = byId('acPrefRisk');
    var lbl = byId('acRiskAmtLabel');
    if (!capEl || !rEl || !lbl) return;
    var cap = parseNum(capEl.value);
    var r = parseFloat(rEl.value) || 0;
    var amt = cap * (r / 100);
    lbl.textContent = '= Rp ' + fmtNumber(amt) + ' per posisi';
  };

  window.acTestSound = function () {
    playAlertBeep();
  };

  window.acToggleSound = function (enabled) {
    try { localStorage.setItem('ac-alert-sound', enabled ? '1' : '0'); } catch (_) {}
    if (enabled) playAlertBeep();
  };

  window.acToggleMata = function (on) {
    try { localStorage.setItem('ac-mata-off', on ? '0' : '1'); } catch (_) {}
    var mm = document.querySelector('.mm');
    if (mm) mm.classList.toggle('off', !on);
    var wrap = document.querySelector('.mata-wrap');
    if (wrap) wrap.style.display = on ? '' : 'none';
    var mini = document.querySelector('.mata-mini');
    if (mini) mini.style.display = on ? 'none' : '';
  };

  window.acSavePreferences = function () {
    var capEl = byId('acPrefCap');
    var rEl = byId('acPrefRisk');
    if (!capEl || !rEl) return;
    var cap = parseNum(capEl.value);
    var risk = parseFloat(rEl.value) || 1.0;
    if (window.PositionSizing && typeof PositionSizing.saveSettings === 'function') {
      PositionSizing.saveSettings({ capital: cap, riskPct: risk });
    }
    var btn = byId('acPrefSaveBtn');
    if (btn) {
      btn.textContent = 'Tersimpan ✓';
      setTimeout(function () { if (btn) btn.textContent = 'Simpan preferensi'; }, 2000);
    }
    notify('Preferensi trading berhasil disimpan.', 'success');
  };

  // 4. SECTION PENGATURAN AI (BYOK GEMINI)
  async function loadAiStatus() {
    var panel = byId('acPanelAi');
    if (!panel) return;
    panel.innerHTML = '<div class="ac-loading">Memeriksa status AI BYOK…</div>';
    var res = await fetch('/api/analyze?surface=chart-analysis&action=status', { credentials:'same-origin' }).then(function (r) { return r.json(); }).catch(function () { return { hasKey:false }; });
    var tier = (function () { try { return localStorage.getItem('ac-ai-tier') || 'auto'; } catch (_) { return 'auto'; } })();
    renderAiPanel(res, tier);
  }

  function renderAiPanel(data, currentTier) {
    var panel = byId('acPanelAi');
    if (!panel) return;
    var hasKey = Boolean(data && data.hasKey);
    var masked = hasKey ? (data.maskedKey || 'Gemini ••••••••••••••••') : '—';
    var quotaInfo = data && data.remainingQuota != null ? ' · Sisa kuota: ' + esc(data.remainingQuota) + ' hari ini' : '';

    panel.innerHTML = [
      '<div class="space-y-4">',
      '<div style="margin-bottom:18px"><h2 style="font-size:18px;margin:0 0 4px;font-weight:700">Pengaturan AI</h2><p class="ac-muted" style="margin:0">Kredensial Gemini milik Anda (BYOK). Kunci tidak pernah ditampilkan ulang secara lengkap.</p></div>',
      '<div class="ac-row"><span>Status</span><span class="ac-st ' + (hasKey ? 'g' : 'm') + '">' + (hasKey ? 'Terhubung · kuota tersedia' : 'Belum diatur') + '</span></div>',
      '<div class="ac-row"><span>Kredensial</span><span class="ac-inp mono" style="max-width:340px;border:none;background:transparent;padding-left:0;font-size:13px">' + esc(masked) + esc(quotaInfo) + '</span></div>',

      '<div id="acAiEditRow" class="ac-row" style="display:none"><label for="acAiInput">Kredensial baru</label><div style="display:flex;gap:8px;flex-wrap:wrap"><input type="password" id="acAiInput" class="ac-inp mono" placeholder="Tempel kredensial Gemini" style="max-width:320px"><button type="button" class="ac-btn ac-btn-primary ac-btn-sm" id="acAiSaveBtn" onclick="window.acSaveAiKey()">Validasi &amp; simpan</button></div></div>',
      '<div id="acAiError" class="ac-callout ac-callout-warning" style="display:none">Kredensial ditolak penyedia. Periksa kembali atau buat kunci baru. Data riset tetap bisa diakses.</div>',

      '<div class="ac-row"><span>Model</span><select id="acAiTier" class="ac-inp" style="max-width:340px" onchange="window.acChangeAiTier(this.value)"><option value="auto"' + (currentTier === 'auto' ? ' selected' : '') + '>Otomatis · model default dari kunci Anda</option><option value="fast"' + (currentTier === 'fast' ? ' selected' : '') + '>Cepat · jawaban ringkas, kuota lebih hemat</option><option value="deep"' + (currentTier === 'deep' ? ' selected' : '') + '>Teliti · jawaban lebih panjang</option></select></div>',

      '<div class="ac-row"><span></span><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="ac-btn ac-btn-sm" onclick="window.acShowAiEdit()">Ganti kredensial</button><button type="button" class="ac-btn ac-btn-sm" onclick="window.acTestAi()" ' + (!hasKey ? 'disabled' : '') + '>Uji koneksi</button><button type="button" class="ac-btn ac-btn-sm" onclick="window.acDeleteAiKey()" style="color:var(--danger)" ' + (!hasKey ? 'disabled' : '') + '>Hapus</button></div></div>',
      '<p class="ac-hint" style="margin-top:18px">Kunci Anda disimpan secara terenkripsi menggunakan AES-256-GCM pada server dan hanya didekripsi saat memproses analisis atas nama Anda.</p>',
      '</div>'
    ].join('');
  }

  window.acShowAiEdit = function () {
    var row = byId('acAiEditRow');
    if (row) row.style.display = row.style.display === 'none' ? 'grid' : 'none';
  };

  window.acChangeAiTier = function (tier) {
    try { localStorage.setItem('ac-ai-tier', tier); } catch (_) {}
    notify('Model tier disimpan: ' + tier, 'info');
  };

  window.acSaveAiKey = async function () {
    var input = byId('acAiInput');
    var btn = byId('acAiSaveBtn');
    var errEl = byId('acAiError');
    var rawKey = input ? input.value.trim() : '';
    if (!rawKey) { notify('Masukkan kunci kredensial Gemini.', 'warning'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Memvalidasi…'; }
    if (errEl) errEl.style.display = 'none';

    try {
      var res = await fetch('/api/analyze?surface=chart-analysis&action=set-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ apiKey: rawKey })
      }).then(function (r) { return r.json(); });

      if (btn) { btn.disabled = false; btn.textContent = 'Validasi & simpan'; }
      if (res && res.success) {
        if (input) input.value = '';
        notify('Kredensial AI berhasil divalidasi dan disimpan terenkripsi.', 'success');
        loadAiStatus();
      } else {
        if (errEl) { errEl.textContent = res.error || 'Kredensial ditolak penyedia. Periksa kembali atau buat kunci baru.'; errEl.style.display = 'block'; }
      }
    } catch (_) {
      if (btn) { btn.disabled = false; btn.textContent = 'Validasi & simpan'; }
      if (errEl) { errEl.textContent = 'Koneksi ke server bermasalah.'; errEl.style.display = 'block'; }
    }
  };

  window.acTestAi = async function () {
    notify('Menguji koneksi ke Google Gemini…', 'info');
    var res = await fetch('/api/analyze?surface=chart-analysis&action=status', { credentials:'same-origin' }).then(function (r) { return r.json(); }).catch(function () { return {}; });
    if (res && res.hasKey) notify('Koneksi AI aktif · kuota tersedia.', 'success');
    else notify('Kredensial AI belum terhubung atau kuota habis.', 'warning');
  };

  window.acDeleteAiKey = async function () {
    if (!window.confirm('Hapus kredensial AI tersimpan? Fitur AI Vision akan dinonaktifkan sampai kredensial baru dimasukkan.')) return;
    try {
      var res = await fetch('/api/analyze?surface=chart-analysis&action=delete-key', {
        method: 'POST', credentials: 'same-origin'
      }).then(function (r) { return r.json(); });
      if (res && res.success) {
        notify('Kredensial AI berhasil dihapus.', 'success');
        loadAiStatus();
      } else {
        notify('Gagal menghapus kredensial.', 'error');
      }
    } catch (_) {
      notify('Koneksi ke server bermasalah.', 'error');
    }
  };

  // 5. SECTION LANGGANAN (SUBSCRIPTION & VOUCHER)
  async function loadSubscription() {
    var panel = byId('acPanelLangganan');
    if (!panel) return;
    panel.innerHTML = '<div class="ac-loading">Memuat status langganan…</div>';
    if (!currentProfile) await loadProfile();
    var cap = await request('/api/login-user?action=subscription-capability', { action:'subscription-capability' }, 7000);
    var plansResult = await request('/api/login-user?action=subscription-plans', { action:'subscription-plans' }, 7000);
    subscriptionPlans = plansResult.ok && plansResult.data.success && Array.isArray(plansResult.data.plans) ? plansResult.data.plans : [];
    renderSubscription(cap.data);
    loadTrialStatus();
    if (currentProfile && currentProfile.is_admin) loadAdminVouchers();
  }

  function renderSubscription(cap) {
    var panel = byId('acPanelLangganan');
    if (!panel) return;
    var ent = currentProfile && currentProfile.subscription && currentProfile.subscription.entitlement;
    var planCards = subscriptionPlans.length ? subscriptionPlans.map(function (p) {
      var normal = Number(p.normal_price_idr);
      var promo = p.promotion_active === true && p.promotional_price_idr != null ? Number(p.promotional_price_idr) : null;
      var effective = Number.isFinite(promo) ? promo : normal;
      var current = ent && ent.current_plan === p.code;
      return '<article class="ac-plan ' + (current ? 'ac-plan-current' : '') + '"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><p class="ac-plan-name">' + esc(planName(p.code, p.display_name)) + '</p>' + (current ? '<span class="ac-chip ac-chip-ok">Aktif</span>' : '') + '</div><p class="ac-plan-price">' + esc(idr(effective)) + (p.promotion_active === true && Number.isFinite(normal) ? '<span class="ac-plan-normal">' + esc(idr(normal)) + '</span>' : '') + '</p><p class="ac-plan-meta">Masa aktif: ' + esc(durationLabel(p)) + '</p></article>';
    }).join('') : '<div class="ac-empty">Katalog paket belum tersedia.</div>';

    panel.innerHTML = [
      '<div class="space-y-4">',
      '<div style="margin-bottom:18px"><h2 style="font-size:18px;margin:0 0 4px;font-weight:700">Langganan</h2><p class="ac-muted" style="margin:0">Hak akses akun saat ini.</p></div>',
      '<div style="border:1px solid rgba(15,116,88,.3);border-radius:12px;padding:18px;display:flex;flex-wrap:wrap;gap:16px;align-items:center;background:var(--accent-subtle)">',
      '<div style="flex:1;min-width:220px"><div class="ac-section-kicker">Paket aktif</div><div style="font-size:20px;font-weight:700;letter-spacing:-.02em">' + esc(planName(ent && ent.current_plan, 'Pro Trader · Lifetime')) + '</div><div class="ac-muted" style="font-size:13px">' + (ent && ent.lifetime ? 'Tanpa batas waktu' : (ent && ent.expires_at ? 'Berlaku sampai ' + esc(dateId(ent.expires_at, true)) : 'Tanpa batas waktu · akun terverifikasi')) + '</div></div>',
      '<div style="display:grid;gap:6px;font-size:13px"><span>✓ Screener 3 mode</span><span>✓ Bandarmologi &amp; Broker Hunter</span><span>✓ Asisten AI (kunci sendiri)</span><span>✓ Alert Telegram</span></div>',
      '</div>',
      '<div id="acTrialStatus" class="ac-callout" style="display:none"></div>',

      '<div style="margin-top:24px"><h3 style="font-size:15px;margin:0 0 8px;font-weight:700">Katalog paket</h3><div class="ac-plans">' + planCards + '</div></div>',

      '<div style="margin-top:24px;border-top:1px solid var(--border-hairline);padding-top:18px">',
      '<div class="ac-row"><label for="acVoucherInput">Kode voucher</label><div><div style="display:flex;gap:8px;flex-wrap:wrap"><input id="acVoucherInput" class="ac-inp mono" placeholder="Contoh: CUAN2026" style="max-width:260px;text-transform:uppercase"><button type="button" id="acVoucherQuote" class="ac-btn ac-btn-primary ac-btn-sm" onclick="window.acQuoteVoucher()">Klaim voucher</button></div><div id="acVoucherResult"></div><div class="ac-hint" style="margin-top:8px">Coba “CUAN2026” untuk melihat status voucher.</div></div></div>',
      '</div>',

      currentProfile && currentProfile.is_admin ? adminVoucherHtml() : '',
      '</div>'
    ].join('');

    wireAdminVoucherControls();
  }

  async function loadTrialStatus() {
    var target = byId('acTrialStatus'); if (!target) return;
    var result = await request('/api/login-user', { action:'subscription-trial-status' }, 7000);
    if (!result.ok || !result.data.success) { target.textContent = result.data.error || 'Status trial belum tersedia.'; return; }
    var d = result.data;
    if (d.admin) { target.innerHTML = 'Akun administrator tidak menggunakan trial.'; return; }
    var trialDays = Number(d.duration_days) || 14;
    if (d.active) { target.innerHTML = '<strong>Trial aktif.</strong> Berlaku sampai ' + esc(dateId(d.effective_expires_at || d.expires_at, true)) + '.'; return; }
    if (d.consumed) { target.innerHTML = 'Trial ' + trialDays + ' hari sudah pernah digunakan.'; return; }
    target.innerHTML = '<strong>Trial ' + trialDays + ' hari tersedia.</strong><div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:9px"><button type="button" id="acTrialActivate" class="ac-btn ac-btn-primary">Aktifkan trial</button>' + (d.telegram_link_required ? '<button type="button" id="acSubscriptionTelegram" class="ac-btn">Hubungkan Telegram</button>' : '') + '</div>';
    var tg = byId('acSubscriptionTelegram'); if (tg) tg.addEventListener('click', linkSubscriptionTelegram);
    var activate = byId('acTrialActivate'); if (activate) activate.addEventListener('click', activateTrial);
  }
  async function linkSubscriptionTelegram() {
    var result = await request('/api/login-user', { action:'subscription-telegram-link-token-create' }, 7000);
    if (!result.ok || !result.data.success || !result.data.telegram_link) { notify(result.data.error || 'Tautan Telegram belum tersedia.', 'error'); return; }
    window.open(result.data.telegram_link, '_blank', 'noopener,noreferrer');
    notify('Telegram dibuka. Selesaikan proses di bot, lalu muat ulang status trial.', 'info');
  }

  async function activateTrial() {
    if (!window.crypto || typeof window.crypto.randomUUID !== 'function') { notify('Browser tidak mendukung aktivasi aman.', 'error'); return; }
    var result = await request('/api/login-user', { action:'subscription-trial-activate', idempotency_key:window.crypto.randomUUID() }, 8000);
    if (!result.ok || !result.data.success) { notify(result.data.error || 'Trial belum dapat diaktifkan.', 'error'); return; }
    notify('Trial berhasil diaktifkan.', 'success');
    await loadProfile(); await loadSubscription();
  }

  window.acQuoteVoucher = async function () {
    var input = byId('acVoucherInput');
    var target = byId('acVoucherResult');
    var code = input ? input.value.trim().toUpperCase() : '';
    if (!code) { if (target) target.innerHTML = '<div class="ac-callout ac-callout-warning">Masukkan kode voucher.</div>'; return; }
    var result = await request('/api/login-user', { action:'voucher-quote', voucher_code:code }, 7000);
    if (!result.ok || !result.data.success || !result.data.voucher) {
      quotedVoucher = null;
      if (target) target.innerHTML = '<div class="ac-callout ac-callout-warning">' + esc(result.data.error || 'Voucher tidak valid atau tidak tersedia.') + '</div>';
      return;
    }
    quotedVoucher = { code:code, data:result.data.voucher };
    var v = result.data.voucher;
    var paymentRequired = v.voucher_type === 'PERCENT_30' || v.voucher_type === 'PERCENT_50';
    if (target) target.innerHTML = '<div class="ac-callout ac-callout-success"><strong>Voucher valid.</strong><br>Paket: ' + esc(planName(v.plan_code)) + ' · ' + (paymentRequired ? 'Diskon ' + esc(v.discount_percent) + '%' : 'Aktivasi paket') + (v.expires_at ? ' · berlaku sampai ' + esc(dateId(v.expires_at, true)) : '') + (paymentRequired ? '<br><span style="color:#fde68a">Voucher diskon membutuhkan jalur pembayaran.</span>' : '<label style="display:flex;gap:8px;align-items:flex-start;margin:10px 0;font-size:12px;cursor:pointer"><input type="checkbox" id="acVoucherTerms" style="margin-top:2px;accent-color:var(--accent-primary)"><span>Saya memahami Kebijakan Pembayaran, Refund, dan Disclaimer Risiko Finansial</span></label><button type="button" id="acVoucherRedeem" class="ac-btn ac-btn-primary" style="width:100%" onclick="window.acRedeemVoucher()">Aktifkan voucher</button>') + '</div>';
  };

  window.acRedeemVoucher = async function () {
    if (!quotedVoucher || !window.crypto || typeof window.crypto.randomUUID !== 'function') return;
    var termsCb = byId('acVoucherTerms');
    if (!termsCb || !termsCb.checked) {
      notify('Centang persetujuan kebijakan aktivasi voucher sebelum melanjutkan.', 'warning');
      return;
    }
    var result = await request('/api/login-user', { action:'voucher-redeem', voucher_code:quotedVoucher.code, idempotency_key:window.crypto.randomUUID(), termsAccepted:true, paymentTermsAccepted:true, termsVersion:TERMS_VERSION }, 9000);
    if (!result.ok || !result.data.success) { notify(result.data.error || 'Voucher belum dapat digunakan.', 'error'); return; }
    notify('Voucher berhasil diaktifkan.', 'success');
    quotedVoucher = null;
    await loadProfile(); await loadSubscription();
  };

  function adminVoucherHtml() {
    return '<section class="ac-card ac-card-accent" style="margin-top:20px"><p class="ac-section-kicker">Khusus administrator</p><h2 class="ac-section-title">Buat voucher unik</h2><p class="ac-muted">Kode dibuat dengan Web Crypto, dikirim sekali ke server, lalu server hanya menyimpan HMAC/hash. Salin kode setelah dibuat karena daftar admin hanya menampilkan 4 karakter terakhir.</p><div style="display:grid;grid-template-columns:1fr 110px;gap:8px;margin-top:12px"><div><label class="ac-label" for="acAdminVoucherPlan">Paket</label><select id="acAdminVoucherPlan" class="ac-select"><option value="PREMIUM_1_MONTH">Premium 1 Bulan</option><option value="PREMIUM_2_MONTHS">Premium 2 Bulan</option><option value="PREMIUM_3_MONTHS">Premium 3 Bulan</option><option value="LIFETIME">Lifetime</option></select></div><div><label class="ac-label" for="acAdminVoucherLimit">Kuota</label><input id="acAdminVoucherLimit" class="ac-input" type="number" min="1" max="100000" value="1"></div></div><button type="button" id="acAdminVoucherCreate" class="ac-btn ac-btn-primary" style="width:100%;margin-top:9px">Generate voucher</button><div id="acAdminVoucherCreated"></div><div class="ac-divider"></div><div class="ac-form-row"><div><label class="ac-label" for="acAdminVoucherRevoke">Cabut voucher menggunakan kode asli</label><input id="acAdminVoucherRevoke" class="ac-input" autocomplete="off" placeholder="AC-XXXXXXXXXXXX"></div><button type="button" id="acAdminVoucherRevokeBtn" class="ac-btn ac-btn-danger">Cabut</button></div><div class="ac-divider"></div><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><p class="ac-section-title" style="margin:0">Voucher terbaru</p><button type="button" id="acAdminVoucherRefresh" class="ac-btn">↻</button></div><div id="acAdminVoucherList" class="ac-admin-table"><div class="ac-muted">Memuat…</div></div></section>';
  }

  function wireAdminVoucherControls() {
    var create = byId('acAdminVoucherCreate'); if (create) create.addEventListener('click', createAdminVoucher);
    var revoke = byId('acAdminVoucherRevokeBtn'); if (revoke) revoke.addEventListener('click', revokeAdminVoucher);
    var refresh = byId('acAdminVoucherRefresh'); if (refresh) refresh.addEventListener('click', loadAdminVouchers);
  }

  function secureVoucherCode() {
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') return null;
    var bytes = new Uint8Array(12); window.crypto.getRandomValues(bytes);
    var out = 'AC-'; for (var i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  function durationDaysForPlan(code) { return code === 'PREMIUM_1_MONTH' ? 30 : code === 'PREMIUM_2_MONTHS' ? 60 : code === 'PREMIUM_3_MONTHS' ? 90 : code === 'LIFETIME' ? 3650 : 30; }

  async function createAdminVoucher() {
    var code = secureVoucherCode(); if (!code) { notify('Web Crypto tidak tersedia.', 'error'); return; }
    var plan = byId('acAdminVoucherPlan'); var limit = byId('acAdminVoucherLimit');
    var planCode = plan ? plan.value : 'PREMIUM_1_MONTH'; var max = Math.max(1, Math.min(100000, Number(limit && limit.value) || 1));
    var button = byId('acAdminVoucherCreate'); if (button) button.disabled = true;
    var result = await request('/api/admin-users', { action:'voucher_admin_create', voucher_code:code, plan_code:planCode, duration_days:durationDaysForPlan(planCode), max_redemptions:max }, 8000);
    if (button) button.disabled = false;
    if (!result.ok || !result.data.success) { notify(result.data.error || 'Voucher gagal dibuat.', 'error'); return; }
    var target = byId('acAdminVoucherCreated'); if (target) target.innerHTML = '<div class="ac-callout ac-callout-success"><strong>Voucher berhasil dibuat — simpan sekarang.</strong><div class="ac-voucher-code">' + esc(code) + '</div><button type="button" id="acCopyVoucher" class="ac-btn" style="width:100%;margin-top:8px">Salin kode</button></div>';
    var copy = byId('acCopyVoucher'); if (copy) copy.addEventListener('click', function () { navigator.clipboard && navigator.clipboard.writeText(code).then(function () { notify('Kode voucher disalin.', 'success'); }).catch(function () {}); });
    loadAdminVouchers();
  }

  async function revokeAdminVoucher() {
    var input = byId('acAdminVoucherRevoke'); var code = input ? input.value.trim().toUpperCase() : '';
    if (!code) { notify('Masukkan kode voucher asli yang ingin dicabut.', 'warning'); return; }
    if (!window.confirm('Cabut voucher ' + code + '? Voucher ini tidak dapat dipakai lagi.')) return;
    var result = await request('/api/admin-users', { action:'voucher_admin_revoke', voucher_code:code }, 8000);
    if (!result.ok || !result.data.success) { notify(result.data.error || 'Voucher gagal dicabut.', 'error'); return; }
    if (input) input.value = ''; notify('Voucher berhasil dicabut.', 'success'); loadAdminVouchers();
  }

  async function loadAdminVouchers() {
    var target = byId('acAdminVoucherList'); if (!target || !currentProfile || !currentProfile.is_admin) return;
    target.innerHTML = '<div class="ac-muted">Memuat…</div>';
    var result = await request('/api/admin-users', { action:'voucher_admin_list' }, 8000);
    if (!result.ok || !result.data.success || !Array.isArray(result.data.vouchers)) { target.innerHTML = '<div class="ac-muted">' + esc(result.data.error || 'Daftar voucher belum tersedia.') + '</div>'; return; }
    if (!result.data.vouchers.length) { target.innerHTML = '<div class="ac-muted">Belum ada voucher.</div>'; return; }
    target.innerHTML = result.data.vouchers.slice(0, 30).map(function (v) { return '<div class="ac-admin-row"><span><strong style="color:var(--text-primary)">••••' + esc(v.code_hint || '') + '</strong><br>' + esc(planName(v.plan_code)) + '</span><span>' + esc(Number(v.redemption_count) || 0) + ' / ' + esc(Number(v.max_redemptions) || 0) + ' dipakai</span><span>' + (v.active && !v.revoked_at ? '<span class="ac-chip ac-chip-ok">Aktif</span>' : '<span class="ac-chip">Dicabut</span>') + '</span></div>'; }).join('');
  }

  function installRegistrationContract() {
    if (typeof window.syncRegistrationConsent === 'function') window.syncRegistrationConsent();
  }

  function installHeaderProfileTrigger() {
    var label = byId('headerUserLabel');
    if (label && !label.classList.contains('ac-profile-trigger')) {
      label.classList.add('ac-profile-trigger'); label.setAttribute('role', 'button'); label.setAttribute('tabindex', '0'); label.setAttribute('aria-label', 'Buka profil akun');
      label.addEventListener('click', function () { openCenter('profile'); });
      label.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openCenter('profile'); } });
    }
    var sidebarBtns = (typeof document.querySelectorAll === 'function') ? document.querySelectorAll('#appSidebar .sidebar-profile-button, #appSidebar .user-profile-badge') : [];
    if (sidebarBtns.forEach) {
      sidebarBtns.forEach(function (btn) {
        if (!btn || btn.classList.contains('ac-profile-trigger')) return;
        btn.classList.add('ac-profile-trigger');
        btn.setAttribute('aria-label', 'Buka profil akun');
        btn.addEventListener('click', function () {
          if (typeof window.closeMobileSidebar === 'function') window.closeMobileSidebar();
          openCenter('profile');
        });
        btn.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (typeof window.closeMobileSidebar === 'function') window.closeMobileSidebar();
            openCenter('profile');
          }
        });
      });
    }
  }

  function openStandaloneTermsModal() {
    var modalId = 'standaloneTermsModal';
    var modal = byId(modalId);
    if (!modal) {
      modal = document.createElement('div');
      modal.id = modalId;
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'standaloneTermsTitle');
      modal.style.cssText = 'position:fixed;inset:0;z-index:var(--ac-z-modal, 100001);background:var(--backdrop-surface, rgba(15,23,42,0.75));display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';

      var card = document.createElement('div');
      card.style.cssText = 'width:100%;max-width:680px;max-height:85vh;background:var(--surface);border:1px solid var(--border-subtle);border-radius:var(--radius-xl, 16px);box-shadow:var(--ac-shadow-2);display:flex;flex-direction:column;overflow:hidden;color:var(--text-primary);font-family:inherit;';

      var header = document.createElement('div');
      header.style.cssText = 'padding:18px 22px 14px;border-bottom:1px solid var(--border-hairline);display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);';
      header.innerHTML = '<div><h2 id="standaloneTermsTitle" style="margin:0;font-size:16px;font-weight:800;color:var(--text-primary);display:flex;align-items:center;gap:8px"><span>📜</span> Peraturan &amp; Ketentuan Auto-Cuan</h2><p style="margin:4px 0 0;font-size:11px;color:var(--text-secondary)">Dokumen Resmi Syarat &amp; Ketentuan Layanan (Versi ' + TERMS_VERSION + ')</p></div>' +
        '<button type="button" id="closeStandaloneTermsBtn" style="min-height:44px;min-width:44px;padding:4px 8px;border:0;background:transparent;color:var(--text-secondary);font-size:24px;line-height:1;cursor:pointer;border-radius:var(--radius-md,8px);display:grid;place-items:center;" aria-label="Tutup">&times;</button>';

      var body = document.createElement('div');
      body.style.cssText = 'padding:18px 22px;overflow-y:auto;max-height:calc(85vh - 140px);display:flex;flex-direction:column;gap:12px;font-size:12px;line-height:1.6;color:var(--text-secondary);background:var(--canvas);';

      var sectionsHtml = CANVAS_TERMS.map(function (item, idx) {
        return '<div style="background:var(--surface);border:1px solid var(--border-subtle);border-radius:var(--radius-md,10px);padding:12px 14px"><h3 style="margin:0 0 6px;font-size:12px;font-weight:800;color:var(--text-primary)">' + (idx + 1) + '. ' + esc(item[0]) + '</h3><p style="margin:0;color:var(--text-secondary);font-size:11.5px;line-height:1.55">' + esc(item[1]) + '</p></div>';
      }).join('');

      body.innerHTML = sectionsHtml + '<div style="font-size:11px;color:var(--text-muted);margin-top:6px;padding-top:10px;border-top:1px solid var(--border-hairline)">Dokumen ini menjelaskan aturan penggunaan produk Auto-Cuan. Kebijakan pembayaran/refund spesifik mengikuti mekanisme pembayaran resmi saat transaksi diproses.</div>';

      var footer = document.createElement('div');
      footer.style.cssText = 'padding:12px 22px;border-top:1px solid var(--border-hairline);display:flex;justify-content:flex-end;background:var(--surface);';
      footer.innerHTML = '<button type="button" id="dismissStandaloneTermsBtn" style="min-height:44px;padding:0 24px;border:0;border-radius:var(--radius-md,8px);background:var(--accent-primary);color:var(--color-on-accent,#ffffff);font-size:13px;font-weight:700;cursor:pointer;">Tutup</button>';

      card.appendChild(header);
      card.appendChild(body);
      card.appendChild(footer);
      modal.appendChild(card);
      document.body.appendChild(modal);

      function close() {
        modal.style.display = 'none';
        modal.hidden = true;
      }

      var closeBtn = card.querySelector('#closeStandaloneTermsBtn');
      var dismissBtn = card.querySelector('#dismissStandaloneTermsBtn');
      if (closeBtn) closeBtn.addEventListener('click', close);
      if (dismissBtn) dismissBtn.addEventListener('click', close);
      modal.addEventListener('click', function (e) {
        if (e.target === modal) close();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !modal.hidden && modal.style.display !== 'none') close();
      });
    }
    modal.style.display = 'flex';
    modal.hidden = false;
  }

  async function saveUserEmail() {
    var input = byId('acUserEmailInput');
    if (!input) return;
    var newEmail = input.value.trim().toLowerCase();
    if (!newEmail || !newEmail.includes('@')) {
      alert('Masukkan alamat email yang valid.');
      return;
    }
    var res = await request('/api/reset-password', { action: 'update-email', email: newEmail });
    if (res.ok && res.data && res.data.success) {
      if (currentProfile) currentProfile.email = newEmail;
      renderProfile();
      alert('Email berhasil diperbarui.');
    } else {
      alert((res.data && res.data.error) || 'Gagal menyimpan email.');
    }
  }
  window.saveUserEmail = saveUserEmail;

  function init() {
    ensureCss();
    ensureCenter();
    installRegistrationContract();
    installHeaderProfileTrigger();
    window.openStandaloneTermsModal = openStandaloneTermsModal;
    window.closeAccountCenter = closeCenter;
    window.openAccountProfile = function (triggerEl) { return openCenter('profile', triggerEl); };
    window.openAccountTerms = function (triggerEl) { return openCenter('terms', triggerEl); };
    window.openAccountSubscription = function (triggerEl) { return openCenter('langganan', triggerEl); };

    // Broadcast cross-tab logout receiver
    if (typeof window.BroadcastChannel === 'function') {
      try {
        var bc = new BroadcastChannel('autocuan_auth');
        bc.onmessage = function (ev) {
          if (ev && ev.data && ev.data.type === 'logout') {
            if (isLoggedIn() && typeof window.logout === 'function') window.logout();
          }
        };
      } catch (_) {}
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', function (e) {
        if (e.key === 'autocuan_logout_event' || (e.key === 'autocuan_logged_in' && e.newValue !== 'true')) {
          if (isLoggedIn() && typeof window.logout === 'function') window.logout();
        }
      });
    }

    if (typeof setTimeout === 'function') {
      setTimeout(function () { installRegistrationContract(); installHeaderProfileTrigger(); }, 700);
      setTimeout(function () { installRegistrationContract(); installHeaderProfileTrigger(); }, 2200);
    }
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
