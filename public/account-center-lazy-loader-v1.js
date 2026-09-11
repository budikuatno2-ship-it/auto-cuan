(function () {
  'use strict';

  if (window.__AUTOCUAN_ACCOUNT_CENTER_LAZY_V1__) return;
  window.__AUTOCUAN_ACCOUNT_CENTER_LAZY_V1__ = true;

  var TERMS_VERSION = '2026-08-16-v1';
  var accountCenterLoad = null;
  var manualPaymentLoad = null;
  var voucherClaimLoad = null;
  var originalDoRegister = null;
  var originalOpenRegister = null;

  function byId(id) { return document.getElementById(id); }

  function notify(message, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(message, kind || 'info'); return; } catch (_) {}
    }
  }

  function loadRuntime(options) {
    if (window[options.flag]) return Promise.resolve();
    var existing = document.querySelector('script[' + options.attribute + ']');
    return new Promise(function (resolve, reject) {
      if (existing) {
        if (window[options.flag]) { resolve(); return; }
        existing.addEventListener('load', resolve, { once:true });
        existing.addEventListener('error', reject, { once:true });
        return;
      }
      var script = document.createElement('script');
      script.src = options.src;
      script.async = true;
      script.setAttribute(options.attribute, '1');
      script.addEventListener('load', resolve, { once:true });
      script.addEventListener('error', reject, { once:true });
      document.head.appendChild(script);
    });
  }

  function loadManualPaymentRuntime() {
    if (window.__AUTOCUAN_MANUAL_PAYMENT_V1__) return Promise.resolve();
    if (manualPaymentLoad) return manualPaymentLoad;
    manualPaymentLoad = loadRuntime({ flag:'__AUTOCUAN_MANUAL_PAYMENT_V1__', attribute:'data-autocuan-manual-payment', src:'/subscription-manual-payment-v1.js?v=20260817-v1' })
      .catch(function () { manualPaymentLoad = null; return null; });
    return manualPaymentLoad;
  }

  function loadVoucherClaimRuntime() {
    if (window.__AUTOCUAN_VOUCHER_CLAIM_V1__) return Promise.resolve();
    if (voucherClaimLoad) return voucherClaimLoad;
    voucherClaimLoad = loadRuntime({ flag:'__AUTOCUAN_VOUCHER_CLAIM_V1__', attribute:'data-autocuan-voucher-claim', src:'/subscription-voucher-claim-v1.js?v=20260817-v1' })
      .catch(function () { voucherClaimLoad = null; return null; });
    return voucherClaimLoad;
  }

  function installPerformanceOverride() {
    if (byId('acPerformanceOverrideV1')) return;
    var style = document.createElement('style');
    style.id = 'acPerformanceOverrideV1';
    style.textContent = [
      '#acAccountCenter{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background:rgba(2,6,12,.88)!important}',
      '#acAccountCenter .ac-center-shell{contain:layout paint style}',
      '@media (prefers-reduced-motion:reduce){#acAccountCenter *,#acAccountCenter *::before,#acAccountCenter *::after{animation:none!important;transition:none!important}}'
    ].join('');
    document.head.appendChild(style);
  }

  function realCenterFunction(tab) {
    if (tab === 'terms') return window.openAccountTerms;
    if (tab === 'subscription') return window.openAccountSubscription;
    return window.openAccountProfile;
  }

  function lazyStubFor(tab) {
    if (tab === 'terms') return openTermsStub;
    if (tab === 'subscription') return openSubscriptionStub;
    return openProfileStub;
  }

  function loadCenter(tab) {
    var existing = realCenterFunction(tab);
    var stub = lazyStubFor(tab);
    if (window.__AUTOCUAN_ACCOUNT_CENTER_V1__ && typeof existing === 'function' && existing !== stub) {
      var immediate = Promise.resolve(existing());
      immediate.then(function () {
        try { window.dispatchEvent(new CustomEvent('autocuan:account-center-opened', { detail:{ tab:tab } })); } catch (_) {}
      });
      return immediate;
    }

    if (!accountCenterLoad) {
      installPerformanceOverride();
      accountCenterLoad = new Promise(function (resolve, reject) {
        var present = document.querySelector('script[data-autocuan-account-center]');
        if (present) {
          if (window.__AUTOCUAN_ACCOUNT_CENTER_V1__) { resolve(); return; }
          present.addEventListener('load', resolve, { once:true });
          present.addEventListener('error', reject, { once:true });
          return;
        }
        var script = document.createElement('script');
        script.src = '/account-center-v1.js?v=20260816-v2';
        script.async = true;
        script.setAttribute('data-autocuan-account-center', '1');
        script.addEventListener('load', resolve, { once:true });
        script.addEventListener('error', reject, { once:true });
        document.head.appendChild(script);
      }).catch(function () {
        accountCenterLoad = null;
        notify('Account Center belum berhasil dimuat. Coba lagi.', 'warning');
        throw new Error('account_center_load_failed');
      });
    }

    return accountCenterLoad.then(function () {
      var fn = realCenterFunction(tab);
      if (typeof fn === 'function' && fn !== stub) {
        var out = fn();
        try { window.dispatchEvent(new CustomEvent('autocuan:account-center-opened', { detail:{ tab:tab } })); } catch (_) {}
        return out;
      }
      throw new Error('account_center_runtime_unavailable');
    }).catch(function () {});
  }

  function openProfileStub() { return loadCenter('profile'); }
  function openTermsStub() { return openStandaloneTermsModal(); }
  function openSubscriptionStub() { return loadCenter('subscription'); }

  function openStandaloneTermsModal() {
    var modalId = 'standaloneTermsModal';
    var modal = byId(modalId);
    if (!modal) {
      modal = document.createElement('div');
      modal.id = modalId;
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'standaloneTermsTitle');
      modal.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,0.85);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';

      var card = document.createElement('div');
      card.style.cssText = 'width:100%;max-width:680px;max-height:85vh;background:#0f172a;border:1px solid rgba(148,163,184,0.25);border-radius:20px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.7);display:flex;flex-direction:column;overflow:hidden;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;';

      var header = document.createElement('div');
      header.style.cssText = 'padding:18px 22px 14px;border-bottom:1px solid rgba(148,163,184,0.15);display:flex;align-items:center;justify-content:space-between;gap:12px;';
      header.innerHTML = '<div><h2 id="standaloneTermsTitle" style="margin:0;font-size:16px;font-weight:700;color:#f8fafc;display:flex;align-items:center;gap:8px"><span>📜</span> Peraturan &amp; Ketentuan Auto-Cuan</h2><p style="margin:4px 0 0;font-size:11px;color:#94a3b8">Dokumen Resmi Syarat &amp; Ketentuan Layanan (Versi ' + TERMS_VERSION + ')</p></div>' +
        '<button type="button" id="closeStandaloneTermsBtn" style="padding:4px 8px;border:0;background:transparent;color:#94a3b8;font-size:24px;line-height:1;cursor:pointer;border-radius:6px" aria-label="Tutup">&times;</button>';

      var body = document.createElement('div');
      body.style.cssText = 'padding:18px 22px;overflow-y:auto;max-height:calc(85vh - 140px);display:flex;flex-direction:column;gap:14px;font-size:12px;line-height:1.6;color:#cbd5e1;';

      var termsList = [
        ['1. Ruang lingkup layanan', 'Auto-Cuan adalah alat bantu pemantauan, pencatatan, penyaringan, dan analisis pasar saham. Informasi pada layanan tidak merupakan jaminan keuntungan, tidak menggantikan penilaian pribadi pengguna, dan tidak merupakan perintah beli atau jual yang bersifat pasti.'],
        ['2. Risiko pasar dan keputusan transaksi', 'Harga saham dapat bergerak cepat dan menimbulkan kerugian. Setiap keputusan transaksi, ukuran posisi, penggunaan modal, target, stop loss, dan tindakan lain tetap menjadi keputusan pengguna. Pengguna wajib mempertimbangkan kemampuan menanggung risiko sebelum melakukan transaksi.'],
        ['3. Data, keterlambatan, dan keterbatasan informasi', 'Data pasar, indikator, ranking, screener, chart, analisis AI, dan informasi lain dapat berasal dari data tersimpan, data historis, sumber pihak ketiga, atau proses sistem. Kecuali dinyatakan secara eksplisit sebagai real-time, pengguna tidak boleh menganggap data selalu real-time, lengkap, atau bebas kesalahan.'],
        ['4. Analisis AI', 'Jawaban AI merupakan alat bantu analisis. AI dapat salah memahami konteks, menghasilkan kesimpulan yang kurang tepat, atau tidak memiliki data terbaru. Pengguna harus memeriksa kembali angka dan fakta penting sebelum mengambil keputusan finansial.'],
        ['5. Akun dan keamanan', 'Pengguna bertanggung jawab menjaga password, perangkat, sesi login, serta akses Telegram yang terhubung. Dilarang membagikan akses akun, mencoba melewati pengamanan, menggunakan identitas orang lain, melakukan scraping atau otomatisasi yang mengganggu layanan, maupun menyalahgunakan endpoint dan voucher.'],
        ['6. Verifikasi Telegram', 'Telegram dapat digunakan untuk verifikasi identitas akun, pemulihan akses, notifikasi, channel, trial, dan fitur subscription tertentu. Sistem dapat menyimpan identifier Telegram dan waktu verifikasi yang diperlukan untuk fungsi keamanan dan operasional tersebut.'],
        ['7. Subscription dan masa aktif', 'Hak akses subscription mengikuti paket, tanggal mulai, tanggal berakhir, status entitlement, dan konfigurasi yang tercatat di server. Masa aktif yang tampil di akun adalah rujukan operasional layanan. Paket Lifetime tidak memiliki tanggal kedaluwarsa selama entitlement Lifetime tetap aktif dan akun tidak diblokir atau dicabut berdasarkan aturan layanan.'],
        ['8. Voucher', 'Voucher hanya berlaku sesuai paket, kuota penggunaan, status aktif, dan batas yang tercatat di server. Voucher bersifat unik dan dapat dibatasi jumlah penukaran. Voucher yang sudah digunakan, dicabut, kedaluwarsa, tidak valid, atau melewati kuota dapat ditolak. Voucher bukan uang tunai dan tidak dapat digunakan untuk melewati pengamanan akun.'],
        ['9. Maintenance dan gangguan layanan', 'Auto-Cuan dapat melakukan maintenance, pembaruan, pembatasan sementara, atau penghentian fitur tertentu untuk keamanan, kestabilan, perbaikan bug, perubahan penyedia data, atau alasan operasional. Selama gangguan, sebagian fungsi dapat tidak tersedia.'],
        ['10. Perilaku yang dilarang', 'Pengguna tidak boleh mencoba memperoleh akses admin, mengubah data server tanpa hak, mengeksploitasi bug, melakukan serangan terhadap layanan, membanjiri request, menyebarkan kode voucher secara tidak sah, atau menggunakan layanan untuk aktivitas yang melanggar hukum.'],
        ['11. Data akun dan catatan persetujuan', 'Auto-Cuan menyimpan data yang diperlukan untuk menjalankan akun dan keamanan, seperti username, status approval, waktu pembuatan akun, catatan login, status verifikasi Telegram, entitlement subscription, serta versi dan waktu persetujuan Peraturan & Ketentuan. Password yang dikirim aplikasi diproses sebagai hash sesuai mekanisme autentikasi yang digunakan sistem.'],
        ['12. Perubahan ketentuan', 'Ketentuan dapat diperbarui ketika fitur, risiko, atau operasional layanan berubah. Setiap versi memiliki penanda versi dan tanggal berlaku. Untuk pendaftaran baru, persetujuan terhadap versi aktif wajib diberikan sebelum akun dibuat.']
      ];

      var sectionsHtml = termsList.map(function (item) {
        return '<div style="background:rgba(30,41,59,0.5);border:1px solid rgba(148,163,184,0.1);border-radius:10px;padding:12px 14px"><h3 style="margin:0 0 6px;font-size:12px;font-weight:700;color:#38bdf8">' + item[0] + '</h3><p style="margin:0;color:#94a3b8;font-size:11.5px;line-height:1.55">' + item[1] + '</p></div>';
      }).join('');

      body.innerHTML = sectionsHtml + '<div style="font-size:11px;color:#64748b;margin-top:6px;padding-top:10px;border-top:1px solid rgba(148,163,184,0.1)">Dokumen ini menjelaskan aturan penggunaan produk Auto-Cuan. Kebijakan pembayaran/refund spesifik mengikuti mekanisme pembayaran resmi saat transaksi diproses.</div>';

      var footer = document.createElement('div');
      footer.style.cssText = 'padding:12px 22px;border-top:1px solid rgba(148,163,184,0.15);display:flex;justify-content:flex-end;background:rgba(15,23,42,0.6);';
      footer.innerHTML = '<button type="button" id="dismissStandaloneTermsBtn" style="padding:8px 20px;border:0;border-radius:10px;background:#10b981;color:#042f2e;font-size:12px;font-weight:700;cursor:pointer;transition:background 0.2s">Tutup</button>';

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

  function installCenterStubs() {
    window.openStandaloneTermsModal = openStandaloneTermsModal;
    if (!window.__AUTOCUAN_ACCOUNT_CENTER_V1__) {
      window.openAccountProfile = openProfileStub;
      window.openAccountTerms = openTermsStub;
      window.openAccountSubscription = openSubscriptionStub;
    }
  }

  function registrationMarkup() {
    return [
      '<label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">',
      '<input type="checkbox" id="acRegTermsAccepted" style="width:17px;height:17px;flex:0 0 17px;margin-top:2px;accent-color:#10b981">',
      '<span style="color:#94a3b8;font-size:11px;line-height:1.55">Saya menyetujui ',
      '<button type="button" id="acOpenTermsFromRegister" style="padding:0;border:0;background:transparent;color:#6ee7b7;font:inherit;font-weight:800;text-decoration:underline;cursor:pointer">Syarat &amp; Ketentuan Layanan Auto-Cuan</button>.</span></label>'
    ].join('');
  }

  function injectRegistrationTerms() {
    if (byId('acTermsRegistration')) return;
    var error = byId('registerError');
    var button = byId('registerBtn');
    if (!error || !error.parentNode || !button) return;

    var box = document.createElement('div');
    box.id = 'acTermsRegistration';
    box.style.cssText = 'margin-top:2px;padding:11px 12px;border:1px solid rgba(148,163,184,.14);border-radius:12px;background:rgba(15,23,42,.45)';
    box.innerHTML = registrationMarkup();
    error.parentNode.insertBefore(box, error);

    var checkbox = byId('acRegTermsAccepted');
    var open = byId('acOpenTermsFromRegister');
    function sync() { if (button && checkbox) button.disabled = checkbox.checked !== true; }
    if (checkbox) checkbox.addEventListener('change', sync);
    if (open) open.addEventListener('click', function (event) {
      event.preventDefault();
      openStandaloneTermsModal();
    });
    sync();
  }

  function showRegisterTermsError() {
    var error = byId('registerError');
    if (!error) return;
    error.textContent = 'Baca dan setujui Peraturan & Ketentuan sebelum mendaftar.';
    error.classList.remove('hidden');
  }

  function installRegistrationContract() {
    injectRegistrationTerms();

    if (typeof window.doRegister === 'function' && !originalDoRegister) {
      originalDoRegister = window.doRegister;
      window.doRegister = async function () {
        var checkbox = byId('acRegTermsAccepted');
        if (!checkbox || checkbox.checked !== true) {
          showRegisterTermsError();
          return;
        }

        var nativeFetch = window.fetch;
        window.fetch = function (input, init) {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url.indexOf('/api/register-user') !== -1 && init && typeof init.body === 'string') {
            try {
              var body = JSON.parse(init.body);
              body.termsAccepted = true;
              body.termsVersion = TERMS_VERSION;
              init = Object.assign({}, init, { body:JSON.stringify(body) });
            } catch (_) {}
          }
          return nativeFetch.call(window, input, init);
        };

        try { return await originalDoRegister.apply(this, arguments); }
        finally { window.fetch = nativeFetch; }
      };
    }

    if (typeof window.openRegisterModal === 'function' && !originalOpenRegister) {
      originalOpenRegister = window.openRegisterModal;
      window.openRegisterModal = function () {
        var out = originalOpenRegister.apply(this, arguments);
        setTimeout(function () {
          injectRegistrationTerms();
          var checkbox = byId('acRegTermsAccepted');
          if (checkbox) checkbox.checked = false;
          var button = byId('registerBtn');
          if (button) button.disabled = true;
        }, 0);
        return out;
      };
    }
  }

  function installHeaderTrigger() {
    var label = byId('headerUserLabel');
    if (!label || label.getAttribute('data-ac-lazy-trigger') === '1') return;
    label.setAttribute('data-ac-lazy-trigger', '1');
    label.classList.add('ac-profile-trigger');
    label.setAttribute('role', 'button');
    label.setAttribute('tabindex', '0');
    label.setAttribute('aria-label', 'Buka profil akun');
    label.addEventListener('click', openProfileStub);
    label.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openProfileStub();
      }
    });
  }

  function init() {
    installCenterStubs();
    installRegistrationContract();
    installHeaderTrigger();
    loadManualPaymentRuntime();
    loadVoucherClaimRuntime();
    setTimeout(function () { installRegistrationContract(); installHeaderTrigger(); }, 700);
    setTimeout(function () { installRegistrationContract(); installHeaderTrigger(); }, 2200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})();