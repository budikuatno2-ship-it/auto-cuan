(function () {
  'use strict';

  if (window.__AUTOCUAN_ACCOUNT_CENTER_LAZY_V1__) return;
  window.__AUTOCUAN_ACCOUNT_CENTER_LAZY_V1__ = true;

  var TERMS_VERSION = '2026-08-16-v1';
  var accountCenterLoad = null;
  var originalDoRegister = null;
  var originalOpenRegister = null;

  function byId(id) { return document.getElementById(id); }

  function notify(message, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(message, kind || 'info'); return; } catch (_) {}
    }
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
      return Promise.resolve(existing());
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
      if (typeof fn === 'function' && fn !== stub) return fn();
      throw new Error('account_center_runtime_unavailable');
    }).catch(function () {});
  }

  function openProfileStub() { return loadCenter('profile'); }
  function openTermsStub() { return loadCenter('terms'); }
  function openSubscriptionStub() { return loadCenter('subscription'); }

  function installCenterStubs() {
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
      '<span style="color:#94a3b8;font-size:11px;line-height:1.55">Saya telah membaca dan menyetujui ',
      '<button type="button" id="acOpenTermsFromRegister" style="padding:0;border:0;background:transparent;color:#6ee7b7;font:inherit;font-weight:800;text-decoration:underline;cursor:pointer">Peraturan &amp; Ketentuan Auto-Cuan</button>',
      ' versi ' + TERMS_VERSION + '.</span></label>'
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
      openTermsStub();
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
    // Account Center checks this class before adding another listener when its
    // full runtime is eventually loaded.
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

    // Auth/login runtimes can re-render header and registration controls. Two
    // bounded idempotent retries are enough; no whole-document MutationObserver.
    setTimeout(function () { installRegistrationContract(); installHeaderTrigger(); }, 700);
    setTimeout(function () { installRegistrationContract(); installHeaderTrigger(); }, 2200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})();