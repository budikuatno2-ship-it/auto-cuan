(function () {
  'use strict';

  if (window.__AUTOCUAN_APPROVED_WEBSITE_RUNTIME__) return;
  window.__AUTOCUAN_APPROVED_WEBSITE_RUNTIME__ = true;

  function hideSubscriptionUi() {
    document.querySelectorAll('[data-page="subscription"],#page-subscription,#subscriptionIdentityCard,#subscriptionPlansAdminButton').forEach(function (el) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    document.querySelectorAll('button[onclick*="openSubscriptionPage"],a[onclick*="openSubscriptionPage"]').forEach(function (el) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  }

  function loadScriptOnce(src, marker) {
    if (document.querySelector('script[' + marker + ']')) return;
    var script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.setAttribute(marker, '1');
    document.head.appendChild(script);
  }

  function init() {
    hideSubscriptionUi();

    loadScriptOnce('/maintenance-auth-guard.js?v=20260816-v1', 'data-autocuan-maintenance-auth-guard');
    loadScriptOnce('/auth-v2.js?v=20260801-v1', 'data-autocuan-auth-v2');
    loadScriptOnce('/account-center-lazy-loader-v1.js?v=20260816-v1', 'data-autocuan-account-center-lazy');
    loadScriptOnce('/subscription-access-gate-v1.js?v=20260816-v1', 'data-autocuan-subscription-access-gate');

    // Maintenance code runtime v8: only watches while a maintenance/status gate
    // is actually visible, bounds network stalls, and moves Telegram notification
    // work off the browser login critical path.
    loadScriptOnce('/admin-maintenance-code.js?v=20260822-v8', 'data-autocuan-maintenance-code');

    // Compatibility fallback only. Code mode suppresses pairing polling while
    // maintenance-code mode is active.
    loadScriptOnce('/admin-zero-link-pairing.js?v=20260821-v3', 'data-autocuan-zero-link-pairing');
    loadScriptOnce('/fast-watcher-live-refresh.js?v=20260822-v2', 'data-autocuan-fast-watcher-refresh');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
