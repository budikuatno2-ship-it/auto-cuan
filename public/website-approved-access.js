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
    // v2 -> v3: auth-v2 now preserves guest-permitted routes (FINAL-HC-002) and
    // re-enters protected SPA routes after session restore. The query string is
    // the cache key: Nginx serves .js as `max-age=604800, immutable` behind a
    // Cloudflare edge cache, so the version must move with the file or the fix
    // stays pinned to the old copy for up to seven days.
    loadScriptOnce('/auth-v2.js?v=20261003-dialog-v3', 'data-autocuan-auth-v2');
    loadScriptOnce('/account-center-lazy-loader-v1.js?v=20260816-v1', 'data-autocuan-account-center-lazy');
    loadScriptOnce('/legacy-gmail-runtime.js?v=20261001-v1', 'data-autocuan-legacy-gmail');
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
