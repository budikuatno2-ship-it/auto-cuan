(function () {
  'use strict';

  if (window.__AUTOCUAN_ACCOUNT_CENTER_V1__) return;
  window.__AUTOCUAN_ACCOUNT_CENTER_V1__ = true;

  var TERMS_VERSION = '2026-08-16-v1';
  var TERMS_EFFECTIVE = '16 Agustus 2026';
  var currentProfile = null;
  var subscriptionPlans = [];
  var quotedVoucher = null;
  var originalDoRegister = null;
  var originalOpenRegister = null;

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
    catch (_) { return 'Rp' + Math.round(n).toLocaleString('id-ID'); }
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
    link.href = '/account-center-v1.css?v=20260816-v1';
    link.setAttribute('data-autocuan-account-center-css', '1');
    document.head.appendChild(link);
  }
  function termsHtml() {
    return [
      '<div class="ac-terms-intro">',
      '<div><p class="ac-section-kicker">Dokumen penggunaan</p><h2 class="ac-section-title">Peraturan &amp; Ketentuan Auto-Cuan</h2><p class="ac-muted">Versi ' + esc(TERMS_VERSION) + ' · berlaku ' + esc(TERMS_EFFECTIVE) + '</p></div>',
      '<span class="ac-chip ac-chip-ok">Dokumen aktif</span>',
      '</div>',
      '<div class="ac-terms-scroll" tabindex="0" aria-label="Isi Peraturan dan Ketentuan Auto-Cuan">',
      term('1. Ruang lingkup layanan', 'Auto-Cuan adalah alat bantu pemantauan, pencatatan, penyaringan, dan analisis pasar saham. Informasi pada layanan tidak merupakan jaminan keuntungan, tidak menggantikan penilaian pribadi pengguna, dan tidak merupakan perintah beli atau jual yang bersifat pasti.'),
      term('2. Risiko pasar dan keputusan transaksi', 'Harga saham dapat bergerak cepat dan menimbulkan kerugian. Setiap keputusan transaksi, ukuran posisi, penggunaan modal, target, stop loss, dan tindakan lain tetap menjadi keputusan pengguna. Pengguna wajib mempertimbangkan kemampuan menanggung risiko sebelum melakukan transaksi.'),
      term('3. Data, keterlambatan, dan keterbatasan informasi', 'Data pasar, indikator, ranking, screener, chart, analisis AI, dan informasi lain dapat berasal dari data tersimpan, data historis, sumber pihak ketiga, atau proses sistem. Kecuali dinyatakan secara eksplisit sebagai real-time, pengguna tidak boleh menganggap data selalu real-time, lengkap, atau bebas kesalahan.'),
      term('4. Analisis AI', 'Jawaban AI merupakan alat bantu analisis. AI dapat salah memahami konteks, menghasilkan kesimpulan yang kurang tepat, atau tidak memiliki data terbaru. Pengguna harus memeriksa kembali angka dan fakta penting sebelum mengambil keputusan finansial.'),
      term('5. Akun dan keamanan', 'Pengguna bertanggung jawab menjaga password, perangkat, sesi login, serta akses Telegram yang terhubung. Dilarang membagikan akses akun, mencoba melewati pengamanan, menggunakan identitas orang lain, melakukan scraping atau otomatisasi yang mengganggu layanan, maupun menyalahgunakan endpoint dan voucher.'),
      term('6. Verifikasi Telegram', 'Telegram dapat digunakan untuk verifikasi identitas akun, pemulihan akses, notifikasi, channel, trial, dan fitur subscription tertentu. Sistem dapat menyimpan identifier Telegram dan waktu verifikasi yang diperlukan untuk fungsi keamanan dan operasional tersebut.'),
      term('7. Subscription dan masa aktif', 'Hak akses subscription mengikuti paket, tanggal mulai, tanggal berakhir, status entitlement, dan konfigurasi yang tercatat di server. Masa aktif yang tampil di akun adalah rujukan operasional layanan. Paket Lifetime tidak memiliki tanggal kedaluwarsa selama entitlement Lifetime tetap aktif dan akun tidak diblokir atau dicabut berdasarkan aturan layanan.'),
      term('8. Voucher', 'Voucher hanya berlaku sesuai paket, kuota penggunaan, status aktif, dan batas yang tercatat di server. Voucher bersifat unik dan dapat dibatasi jumlah penukaran. Voucher yang sudah digunakan, dicabut, kedaluwarsa, tidak valid, atau melewati kuota dapat ditolak. Voucher bukan uang tunai dan tidak dapat digunakan untuk melewati pengamanan akun.'),
      term('9. Maintenance dan gangguan layanan', 'Auto-Cuan dapat melakukan maintenance, pembaruan, pembatasan sementara, atau penghentian fitur tertentu untuk keamanan, kestabilan, perbaikan bug, perubahan penyedia data, atau alasan operasional. Selama gangguan, sebagian fungsi dapat tidak tersedia.'),
      term('10. Perilaku yang dilarang', 'Pengguna tidak boleh mencoba memperoleh akses admin, mengubah data server tanpa hak, mengeksploitasi bug, melakukan serangan terhadap layanan, membanjiri request, menyebarkan kode voucher secara tidak sah, atau menggunakan layanan untuk aktivitas yang melanggar hukum.'),
      term('11. Data akun dan catatan persetujuan', 'Auto-Cuan menyimpan data yang diperlukan untuk menjalankan akun dan keamanan, seperti username, status approval, waktu pembuatan akun, catatan login, status verifikasi Telegram, entitlement subscription, serta versi dan waktu persetujuan Peraturan & Ketentuan. Password yang dikirim aplikasi diproses sebagai hash sesuai mekanisme autentikasi yang digunakan sistem.'),
      term('12. Perubahan ketentuan', 'Ketentuan dapat diperbarui ketika fitur, risiko, atau operasional layanan berubah. Setiap versi memiliki penanda versi dan tanggal berlaku. Untuk pendaftaran baru, persetujuan terhadap versi aktif wajib diberikan sebelum akun dibuat.'),
      '</div>',
      '<p class="ac-terms-footer">Dokumen ini menjelaskan aturan penggunaan produk Auto-Cuan. Kebijakan pembayaran/refund yang spesifik akan mengikuti mekanisme pembayaran resmi ketika fitur pembayaran tersedia.</p>'
    ].join('');
  }
  function term(title, body) {
    return '<section class="ac-term-section"><h3>' + esc(title) + '</h3><p>' + esc(body) + '</p></section>';
  }
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
      '<div class="ac-center-identity"><div id="acCenterAvatar" class="ac-center-avatar">AC</div><div class="min-w-0"><p class="ac-center-eyebrow">Auto-Cuan Account Center</p><h1 id="acCenterTitle" class="ac-center-title">Profil &amp; Keanggotaan</h1><p id="acCenterSubtitle" class="ac-center-subtitle">Identitas, keamanan, subscription, dan ketentuan dalam satu tempat.</p></div></div>',
      '<button type="button" id="acCenterClose" class="ac-center-close" aria-label="Tutup Account Center">&times;</button>',
      '</header>',
      '<nav class="ac-center-tabs" aria-label="Bagian Account Center">',
      '<button type="button" class="ac-center-tab" data-ac-tab="profile" aria-selected="true">● Profil</button>',
      '<button type="button" class="ac-center-tab" data-ac-tab="subscription" aria-selected="false">◇ Subscription</button>',
      '<button type="button" class="ac-center-tab" data-ac-tab="terms" aria-selected="false">▤ Peraturan &amp; Ketentuan</button>',
      '</nav>',
      '<main class="ac-center-body">',
      '<section id="acPanelProfile" class="ac-center-panel"></section>',
      '<section id="acPanelSubscription" class="ac-center-panel" hidden></section>',
      '<section id="acPanelTerms" class="ac-center-panel" hidden>' + termsHtml() + '</section>',
      '</main></div>'
    ].join('');
    document.body.appendChild(root);
    byId('acCenterClose').addEventListener('click', closeCenter);
    root.addEventListener('click', function (event) { if (event.target === root) closeCenter(); });
    root.querySelectorAll('[data-ac-tab]').forEach(function (button) {
      button.addEventListener('click', function () { switchTab(button.getAttribute('data-ac-tab')); });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !root.hidden) closeCenter();
    });
    return root;
  }
  function switchTab(name) {
    var root = ensureCenter();
    root.querySelectorAll('[data-ac-tab]').forEach(function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-ac-tab') === name ? 'true' : 'false');
    });
    ['profile','subscription','terms'].forEach(function (tab) {
      var panel = byId('acPanel' + tab.charAt(0).toUpperCase() + tab.slice(1));
      if (panel) panel.hidden = tab !== name;
    });
    if (name === 'subscription' && isLoggedIn()) loadSubscription();
  }
  function closeCenter() {
    var root = byId('acAccountCenter');
    if (root) root.hidden = true;
    document.documentElement.style.removeProperty('overflow');
  }
  async function openCenter(tab) {
    var root = ensureCenter();
    root.hidden = false;
    document.documentElement.style.overflow = 'hidden';
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
    if (avatar) avatar.textContent = username.slice(0,2).toUpperCase();
    var title = byId('acCenterTitle');
    if (title) title.textContent = username;
    renderProfile();
  }
  function chip(ok, yes, no) {
    return '<span class="ac-chip ' + (ok ? 'ac-chip-ok' : 'ac-chip-warn') + '">' + esc(ok ? yes : no) + '</span>';
  }
  function fact(label, value) {
    return '<div class="ac-fact"><dt>' + esc(label) + '</dt><dd>' + value + '</dd></div>';
  }
  function renderProfile() {
    var panel = byId('acPanelProfile');
    if (!panel || !currentProfile) return;
    var p = currentProfile;
    var tg = p.telegram || {};
    var terms = p.terms || {};
    var accepted = terms.accepted || null;
    var sub = p.subscription || {};
    var ent = sub.entitlement || null;
    panel.innerHTML = [
      '<div class="ac-center-grid">',
      '<section class="ac-card ac-card-accent">',
      '<div class="ac-profile-hero"><div><p class="ac-section-kicker">Identitas akun</p><p class="ac-big-name">' + esc(p.username) + '</p><p class="ac-muted">ID akun disembunyikan dari tampilan; identitas diverifikasi dari sesi server.</p></div>' + chip(p.is_approved, 'Approved', 'Pending') + '</div>',
      '<dl class="ac-facts">',
      fact('Username', esc(p.username)),
      fact('Status akun', chip(p.is_approved, 'Terverifikasi admin', 'Menunggu approval')),
      fact('Akun dibuat', esc(dateId(p.created_at, true))),
      fact('Login terakhir', esc(dateId(p.last_login_at, true))),
      fact('Peraturan', accepted ? chip(accepted.version === TERMS_VERSION, 'Disetujui · ' + accepted.version, 'Versi lama · ' + accepted.version) : '<span class="ac-chip">Belum ada catatan</span>'),
      '</dl></section>',
      '<div class="space-y-3">',
      '<section class="ac-card"><p class="ac-section-kicker">Telegram</p><h2 class="ac-section-title">Keamanan &amp; verifikasi</h2><dl class="ac-facts">' +
      fact('Status', chip(tg.verified, 'Verified', 'Belum verified')) +
      fact('Telegram ID', esc(tg.telegram_user_id || '—')) +
      fact('Diverifikasi', esc(dateId(tg.verified_at, true))) +
      fact('Channel', tg.channel_joined ? '<span class="ac-chip ac-chip-ok">Sudah bergabung</span>' : '<span class="ac-chip">Belum tercatat</span>') +
      '</dl></section>',
      '<section class="ac-card"><p class="ac-section-kicker">Subscription</p><h2 class="ac-section-title">Status akses</h2>' + subscriptionMini(ent, sub) + '<button type="button" class="ac-btn ac-btn-primary" style="margin-top:12px;width:100%" data-ac-open-sub>Kelola subscription &amp; voucher</button></section>',
      '</div></div>',
      '<div class="ac-hint">Peraturan &amp; Ketentuan dapat dibuka kapan saja dari tab di atas. Untuk akun baru, persetujuan versi aktif diwajibkan sebelum pendaftaran diproses.</div>'
    ].join('');
    var openSub = panel.querySelector('[data-ac-open-sub]');
    if (openSub) openSub.addEventListener('click', function () { switchTab('subscription'); });
  }
  function subscriptionMini(ent, sub) {
    if (!sub || sub.enabled !== true) return '<div class="ac-callout">Subscription belum diaktifkan pada server.</div>';
    if (sub.ready !== true) return '<div class="ac-callout ac-callout-warning">Fondasi subscription belum siap di database.</div>';
    if (!ent) return '<div class="ac-callout">Status subscription belum tersedia.</div>';
    var active = ent.status === 'active';
    return '<dl class="ac-facts">' +
      fact('Paket', esc(planName(ent.current_plan))) +
      fact('Status', chip(active, active ? 'Aktif' : 'Tidak aktif', 'Tidak aktif')) +
      fact('Aktif sampai', esc(ent.lifetime ? 'Lifetime' : dateId(ent.expires_at, true))) +
      '</dl>';
  }
  async function loadSubscription() {
    var panel = byId('acPanelSubscription');
    if (!panel) return;
    panel.innerHTML = '<div class="ac-loading">Memuat subscription…</div>';
    if (!currentProfile) await loadProfile();
    var cap = await request('/api/login-user?action=subscription-capability', { action:'subscription-capability' }, 7000);
    if (!cap.ok || !cap.data.success || cap.data.enabled !== true || cap.data.ready !== true) {
      panel.innerHTML = '<div class="ac-card"><p class="ac-section-kicker">Subscription</p><h2 class="ac-section-title">Belum diaktifkan</h2><p class="ac-muted">Fitur subscription masih terkunci di server. Profil akun dan Peraturan &amp; Ketentuan tetap dapat digunakan.</p></div>';
      return;
    }
    var plansResult = await request('/api/login-user?action=subscription-plans', { action:'subscription-plans' }, 7000);
    subscriptionPlans = plansResult.ok && plansResult.data.success && Array.isArray(plansResult.data.plans) ? plansResult.data.plans : [];
    renderSubscription();
    loadTrialStatus();
    if (currentProfile && currentProfile.is_admin) loadAdminVouchers();
  }
  function renderSubscription() {
    var panel = byId('acPanelSubscription');
    if (!panel) return;
    var ent = currentProfile && currentProfile.subscription && currentProfile.subscription.entitlement;
    var planCards = subscriptionPlans.length ? subscriptionPlans.map(function (p) {
      var price = p.current_price || {};
      var effective = price.promo_enabled && price.promo_price_idr != null ? price.promo_price_idr : price.normal_price_idr;
      var current = ent && ent.current_plan === p.code;
      return '<article class="ac-plan ' + (current ? 'ac-plan-current' : '') + '"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><p class="ac-plan-name">' + esc(planName(p.code,p.display_name)) + '</p>' + (current ? '<span class="ac-chip ac-chip-ok">Aktif</span>' : '') + '</div><p class="ac-plan-price">' + esc(idr(effective)) + (price.promo_enabled && price.normal_price_idr != null ? '<span class="ac-plan-normal">' + esc(idr(price.normal_price_idr)) + '</span>' : '') + '</p><p class="ac-plan-meta">Masa aktif: ' + esc(durationLabel(p)) + '</p></article>';
    }).join('') : '<div class="ac-empty">Katalog paket belum tersedia.</div>';
    panel.innerHTML = [
      '<div class="ac-center-grid">',
      '<div>',
      '<section class="ac-card ac-card-accent"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start"><div><p class="ac-section-kicker">Paket saya</p><h2 class="ac-section-title">' + esc(planName(ent && ent.current_plan)) + '</h2></div>' + chip(Boolean(ent && ent.status === 'active'), ent && ent.lifetime ? 'Lifetime aktif' : 'Subscription aktif', 'Free / tidak aktif') + '</div><dl class="ac-facts">' +
      fact('Mulai aktif', esc(dateId(ent && ent.starts_at, true))) +
      fact('Masa aktif sampai', esc(ent && ent.lifetime ? 'Lifetime' : dateId(ent && ent.expires_at, true))) +
      fact('Sumber akses', esc(ent && ent.source || '—')) +
      '</dl><div id="acTrialStatus" class="ac-callout">Memeriksa status trial…</div></section>',
      '<section class="ac-card" style="margin-top:12px"><p class="ac-section-kicker">Katalog paket</p><h2 class="ac-section-title">Harga &amp; masa aktif dari server</h2><p class="ac-muted">Harga yang tampil dibaca dari katalog aktif. Pembayaran online belum diproses dari Account Center ini.</p><div class="ac-plans">' + planCards + '</div></section>',
      '</div>',
      '<div>',
      '<section class="ac-card"><p class="ac-section-kicker">Voucher</p><h2 class="ac-section-title">Cek dan aktifkan voucher</h2><p class="ac-muted">Kode diperiksa di server. Voucher tidak disimpan sebagai plaintext di database.</p><div class="ac-form-row" style="margin-top:12px"><div><label class="ac-label" for="acVoucherInput">Kode voucher</label><input id="acVoucherInput" class="ac-input" autocomplete="off" spellcheck="false" placeholder="AC-XXXXXXXXXXXX"></div><button type="button" id="acVoucherQuote" class="ac-btn">Cek voucher</button></div><div id="acVoucherResult"></div></section>',
      currentProfile && currentProfile.is_admin ? adminVoucherHtml() : '',
      '</div></div>'
    ].join('');
    var quote = byId('acVoucherQuote'); if (quote) quote.addEventListener('click', quoteVoucher);
    wireAdminVoucherControls();
  }
  async function loadTrialStatus() {
    var target = byId('acTrialStatus'); if (!target) return;
    var result = await request('/api/login-user', { action:'subscription-trial-status' }, 7000);
    if (!result.ok || !result.data.success) { target.textContent = result.data.error || 'Status trial belum tersedia.'; return; }
    var d = result.data;
    if (d.admin) { target.innerHTML = 'Akun administrator tidak menggunakan trial.'; return; }
    if (d.active) { target.innerHTML = '<strong>Trial aktif.</strong> Berlaku sampai ' + esc(dateId(d.expires_at,true)) + '.'; return; }
    if (d.consumed) { target.innerHTML = 'Trial 10 hari sudah pernah digunakan.'; return; }
    target.innerHTML = '<strong>Trial 10 hari tersedia.</strong><div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:9px"><button type="button" id="acTrialActivate" class="ac-btn ac-btn-primary">Aktifkan trial</button>' + (d.telegram_link_required ? '<button type="button" id="acSubscriptionTelegram" class="ac-btn">Hubungkan Telegram</button>' : '') + '</div>';
    var tg = byId('acSubscriptionTelegram'); if (tg) tg.addEventListener('click', linkSubscriptionTelegram);
    var activate = byId('acTrialActivate'); if (activate) activate.addEventListener('click', activateTrial);
  }
  async function linkSubscriptionTelegram() {
    var result = await request('/api/login-user', { action:'subscription-telegram-link-token-create' }, 7000);
    if (!result.ok || !result.data.success || !result.data.telegram_link) { notify(result.data.error || 'Tautan Telegram belum tersedia.','error'); return; }
    window.open(result.data.telegram_link, '_blank', 'noopener,noreferrer');
    notify('Telegram dibuka. Selesaikan proses di bot, lalu muat ulang status trial.','info');
  }
  async function activateTrial() {
    if (!window.crypto || typeof window.crypto.randomUUID !== 'function') { notify('Browser tidak mendukung aktivasi aman.','error'); return; }
    var result = await request('/api/login-user', { action:'subscription-trial-activate', idempotency_key:window.crypto.randomUUID() }, 8000);
    if (!result.ok || !result.data.success) { notify(result.data.error || 'Trial belum dapat diaktifkan.','error'); return; }
    notify('Trial berhasil diaktifkan.','success');
    await loadProfile(); await loadSubscription();
  }
  async function quoteVoucher() {
    var input = byId('acVoucherInput'); var target = byId('acVoucherResult');
    var code = input ? input.value.trim().toUpperCase() : '';
    if (!code) { if (target) target.innerHTML = '<div class="ac-callout ac-callout-warning">Masukkan kode voucher.</div>'; return; }
    var result = await request('/api/login-user', { action:'voucher-quote', voucher_code:code }, 7000);
    if (!result.ok || !result.data.success || !result.data.voucher) { quotedVoucher=null; if (target) target.innerHTML='<div class="ac-callout ac-callout-warning">' + esc(result.data.error || 'Voucher tidak valid atau tidak tersedia.') + '</div>'; return; }
    quotedVoucher = { code:code, data:result.data.voucher };
    var v = result.data.voucher;
    var paymentRequired = v.voucher_type === 'PERCENT_30' || v.voucher_type === 'PERCENT_50';
    if (target) target.innerHTML = '<div class="ac-callout ac-callout-success"><strong>Voucher valid.</strong><br>Paket: ' + esc(planName(v.plan_code)) + ' · ' + (paymentRequired ? 'Diskon ' + esc(v.discount_percent) + '%' : 'Aktivasi paket') + (v.expires_at ? ' · berlaku sampai ' + esc(dateId(v.expires_at,true)) : '') + (paymentRequired ? '<br><span style="color:#fde68a">Voucher diskon membutuhkan jalur pembayaran yang belum dibuka di Account Center.</span>' : '<button type="button" id="acVoucherRedeem" class="ac-btn ac-btn-primary" style="width:100%;margin-top:10px">Aktifkan voucher</button>') + '</div>';
    var redeem = byId('acVoucherRedeem'); if (redeem) redeem.addEventListener('click', redeemVoucher);
  }
  async function redeemVoucher() {
    if (!quotedVoucher || !window.crypto || typeof window.crypto.randomUUID !== 'function') return;
    var result = await request('/api/login-user', { action:'voucher-redeem', voucher_code:quotedVoucher.code, idempotency_key:window.crypto.randomUUID() }, 9000);
    if (!result.ok || !result.data.success) { notify(result.data.error || 'Voucher belum dapat digunakan.','error'); return; }
    notify('Voucher berhasil diaktifkan.','success');
    quotedVoucher=null;
    await loadProfile(); await loadSubscription();
  }
  function adminVoucherHtml() {
    return '<section class="ac-card ac-card-accent" style="margin-top:12px"><p class="ac-section-kicker">Khusus administrator</p><h2 class="ac-section-title">Buat voucher unik</h2><p class="ac-muted">Kode dibuat dengan Web Crypto, dikirim sekali ke server, lalu server hanya menyimpan HMAC/hash. Salin kode setelah dibuat karena daftar admin hanya menampilkan 4 karakter terakhir.</p><div style="display:grid;grid-template-columns:1fr 110px;gap:8px;margin-top:12px"><div><label class="ac-label" for="acAdminVoucherPlan">Paket</label><select id="acAdminVoucherPlan" class="ac-select"><option value="PREMIUM_1_MONTH">Premium 1 Bulan</option><option value="PREMIUM_2_MONTHS">Premium 2 Bulan</option><option value="PREMIUM_3_MONTHS">Premium 3 Bulan</option><option value="LIFETIME">Lifetime</option></select></div><div><label class="ac-label" for="acAdminVoucherLimit">Kuota</label><input id="acAdminVoucherLimit" class="ac-input" type="number" min="1" max="100000" value="1"></div></div><button type="button" id="acAdminVoucherCreate" class="ac-btn ac-btn-primary" style="width:100%;margin-top:9px">Generate voucher</button><div id="acAdminVoucherCreated"></div><div class="ac-divider"></div><div class="ac-form-row"><div><label class="ac-label" for="acAdminVoucherRevoke">Cabut voucher menggunakan kode asli</label><input id="acAdminVoucherRevoke" class="ac-input" autocomplete="off" placeholder="AC-XXXXXXXXXXXX"></div><button type="button" id="acAdminVoucherRevokeBtn" class="ac-btn ac-btn-danger">Cabut</button></div><div class="ac-divider"></div><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><p class="ac-section-title" style="margin:0">Voucher terbaru</p><button type="button" id="acAdminVoucherRefresh" class="ac-btn">↻</button></div><div id="acAdminVoucherList" class="ac-admin-table"><div class="ac-muted">Memuat…</div></div></section>';
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
    var out = 'AC-'; for (var i=0;i<bytes.length;i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }
  function durationDaysForPlan(code) { return code === 'PREMIUM_1_MONTH' ? 30 : code === 'PREMIUM_2_MONTHS' ? 60 : code === 'PREMIUM_3_MONTHS' ? 90 : code === 'LIFETIME' ? 3650 : 30; }
  async function createAdminVoucher() {
    var code = secureVoucherCode(); if (!code) { notify('Web Crypto tidak tersedia.','error'); return; }
    var plan = byId('acAdminVoucherPlan'); var limit = byId('acAdminVoucherLimit');
    var planCode = plan ? plan.value : 'PREMIUM_1_MONTH'; var max = Math.max(1,Math.min(100000,Number(limit && limit.value)||1));
    var button = byId('acAdminVoucherCreate'); if (button) button.disabled=true;
    var result = await request('/api/admin-users', { action:'voucher_admin_create', voucher_code:code, plan_code:planCode, duration_days:durationDaysForPlan(planCode), max_redemptions:max }, 8000);
    if (button) button.disabled=false;
    if (!result.ok || !result.data.success) { notify(result.data.error || 'Voucher gagal dibuat.','error'); return; }
    var target=byId('acAdminVoucherCreated'); if (target) target.innerHTML='<div class="ac-callout ac-callout-success"><strong>Voucher berhasil dibuat — simpan sekarang.</strong><div class="ac-voucher-code">' + esc(code) + '</div><button type="button" id="acCopyVoucher" class="ac-btn" style="width:100%;margin-top:8px">Salin kode</button></div>';
    var copy=byId('acCopyVoucher'); if(copy) copy.addEventListener('click',function(){ navigator.clipboard && navigator.clipboard.writeText(code).then(function(){notify('Kode voucher disalin.','success');}).catch(function(){}); });
    loadAdminVouchers();
  }
  async function revokeAdminVoucher() {
    var input=byId('acAdminVoucherRevoke'); var code=input ? input.value.trim().toUpperCase() : '';
    if(!code){notify('Masukkan kode voucher asli yang ingin dicabut.','warning');return;}
    if(!window.confirm('Cabut voucher ' + code + '? Voucher ini tidak dapat dipakai lagi.')) return;
    var result=await request('/api/admin-users',{action:'voucher_admin_revoke',voucher_code:code},8000);
    if(!result.ok||!result.data.success){notify(result.data.error||'Voucher gagal dicabut.','error');return;}
    if(input) input.value=''; notify('Voucher berhasil dicabut.','success'); loadAdminVouchers();
  }
  async function loadAdminVouchers() {
    var target=byId('acAdminVoucherList'); if(!target || !currentProfile || !currentProfile.is_admin) return;
    target.innerHTML='<div class="ac-muted">Memuat…</div>';
    var result=await request('/api/admin-users',{action:'voucher_admin_list'},8000);
    if(!result.ok||!result.data.success||!Array.isArray(result.data.vouchers)){target.innerHTML='<div class="ac-muted">' + esc(result.data.error||'Daftar voucher belum tersedia.') + '</div>';return;}
    if(!result.data.vouchers.length){target.innerHTML='<div class="ac-muted">Belum ada voucher.</div>';return;}
    target.innerHTML=result.data.vouchers.slice(0,30).map(function(v){return '<div class="ac-admin-row"><span><strong style="color:#e5edf7">••••' + esc(v.code_hint||'') + '</strong><br>' + esc(planName(v.plan_code)) + '</span><span>' + esc(Number(v.redemption_count)||0) + ' / ' + esc(Number(v.max_redemptions)||0) + ' dipakai</span><span>' + (v.active && !v.revoked_at ? '<span class="ac-chip ac-chip-ok">Aktif</span>' : '<span class="ac-chip">Dicabut</span>') + '</span></div>';}).join('');
  }
  function injectRegistrationTerms() {
    if (byId('acTermsRegistration')) return;
    var error = byId('registerError'); var button=byId('registerBtn');
    if (!error || !error.parentNode || !button) return;
    var box=document.createElement('div'); box.id='acTermsRegistration';
    box.innerHTML='<label class="ac-reg-terms-row"><input type="checkbox" id="acRegTermsAccepted"><span class="ac-reg-terms-copy">Saya telah membaca dan menyetujui <button type="button" id="acOpenTermsFromRegister" class="ac-reg-terms-link">Peraturan &amp; Ketentuan Auto-Cuan</button> versi ' + esc(TERMS_VERSION) + '.</span></label>';
    error.parentNode.insertBefore(box,error);
    var checkbox=byId('acRegTermsAccepted'); var open=byId('acOpenTermsFromRegister');
    function sync(){ if(button) button.disabled=!checkbox.checked; }
    checkbox.addEventListener('change',sync); if(open) open.addEventListener('click',function(event){event.preventDefault();openCenter('terms');});
    sync();
  }
  function showRegisterTermsError() {
    var error=byId('registerError');
    if(error){error.textContent='Baca dan setujui Peraturan & Ketentuan sebelum mendaftar.';error.classList.remove('hidden');}
  }
  function installRegistrationContract() {
    injectRegistrationTerms();
    if (typeof window.doRegister === 'function' && !originalDoRegister) {
      originalDoRegister=window.doRegister;
      window.doRegister=async function(){
        var checkbox=byId('acRegTermsAccepted');
        if(!checkbox||checkbox.checked!==true){showRegisterTermsError();return;}
        var nativeFetch=window.fetch;
        window.fetch=function(input,init){
          var url=typeof input==='string'?input:(input&&input.url)||'';
          if(url.indexOf('/api/register-user')!==-1 && init && typeof init.body==='string'){
            try{var body=JSON.parse(init.body);body.termsAccepted=true;body.termsVersion=TERMS_VERSION;init=Object.assign({},init,{body:JSON.stringify(body)});}catch(_){}
          }
          return nativeFetch.call(window,input,init);
        };
        try{return await originalDoRegister.apply(this,arguments);}finally{window.fetch=nativeFetch;}
      };
    }
    if (typeof window.openRegisterModal === 'function' && !originalOpenRegister) {
      originalOpenRegister=window.openRegisterModal;
      window.openRegisterModal=function(){
        var out=originalOpenRegister.apply(this,arguments);
        setTimeout(function(){injectRegistrationTerms();var c=byId('acRegTermsAccepted');if(c)c.checked=false;var b=byId('registerBtn');if(b)b.disabled=true;},0);
        return out;
      };
    }
  }
  function installHeaderProfileTrigger() {
    var label=byId('headerUserLabel');
    if(!label||label.classList.contains('ac-profile-trigger')) return;
    label.classList.add('ac-profile-trigger'); label.setAttribute('role','button'); label.setAttribute('tabindex','0'); label.setAttribute('aria-label','Buka profil akun');
    label.addEventListener('click',function(){openCenter('profile');});
    label.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){event.preventDefault();openCenter('profile');}});
  }
  function init() {
    ensureCss(); ensureCenter(); installRegistrationContract(); installHeaderProfileTrigger();
    window.openAccountProfile=function(){return openCenter('profile');};
    window.openAccountTerms=function(){return openCenter('terms');};
    window.openAccountSubscription=function(){return openCenter('subscription');};
    // Other runtimes can replace/re-render header and registration state after
    // session validation. Re-attach idempotently without using MutationObserver
    // on the entire document tree.
    setTimeout(function(){installRegistrationContract();installHeaderProfileTrigger();},700);
    setTimeout(function(){installRegistrationContract();installHeaderProfileTrigger();},2200);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
})();
