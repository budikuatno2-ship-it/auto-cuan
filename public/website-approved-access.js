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

    // Cookie-first authentication runtime. It validates the signed server session
    // before rehydrating any local UI state, clears orphaned users such as deleted
    // accounts, removes device binding from login, and owns Telegram recovery UI.
    loadScriptOnce('/auth-v2.js?v=20260801-v1', 'data-autocuan-auth-v2');

    // Existing live refresh remains independent from authentication recovery.
    loadScriptOnce('/fast-watcher-live-refresh.js?v=20260730-v1', 'data-autocuan-fast-watcher-refresh');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
