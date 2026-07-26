(function () {
  'use strict';

  // Single source of truth for restoring an approved website session when the
  // signed HttpOnly cookie is still valid but localStorage UI state is missing
  // (new tab, cleared storage, hard refresh). Feature gating itself lives in
  // index.html (loadPremiumAccess -> action:portfolio_access); this script only
  // rehydrates the UI session and removes dormant subscription UI.
  //
  // localStorage is written here ONLY as non-authoritative UI persistence.
  // Every data API still authorizes against the signed server session.

  if (window.__AUTOCUAN_APPROVED_WEBSITE_RUNTIME__) return;
  window.__AUTOCUAN_APPROVED_WEBSITE_RUNTIME__ = true;

  function isDashboardRoute() {
    return window.location.pathname === '/dashboard' || window.location.pathname === '/dashboard/';
  }

  function hideSubscriptionUi() {
    document.querySelectorAll('[data-page="subscription"],#page-subscription,#subscriptionIdentityCard,#subscriptionPlansAdminButton').forEach(function (el) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    document.querySelectorAll('button[onclick*="openSubscriptionPage"],a[onclick*="openSubscriptionPage"]').forEach(function (el) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  }

  function markApprovedAccess() {
    if (typeof window.applyPremiumAccessUi !== 'function') return;
    window.premiumAccessState = {
      state: 'ready',
      premium: true,
      accessLevel: 'approved',
      checkedAt: Date.now(),
      expiresAt: null
    };
    try { window.applyPremiumAccessUi(); } catch (_) {}
  }

  function keepDashboardOpen() {
    var fallback = document.getElementById('startupFallbackNotice');
    if (fallback && fallback.parentNode) fallback.parentNode.removeChild(fallback);
    if (typeof window.updateLandingCtas === 'function') {
      try { window.updateLandingCtas(); } catch (_) {}
    }
    if (!isDashboardRoute()) return;
    if (typeof window.closeAuthChoiceModal === 'function') {
      try { window.closeAuthChoiceModal(); } catch (_) {}
    }
    if (typeof window.enterApp === 'function') {
      try { window.enterApp({ replaceHistory: true }); } catch (_) {}
    }
  }

  async function restoreApprovedSession() {
    try {
      var response = await fetch('/api/admin-users', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        body: JSON.stringify({ action: 'portfolio_access' })
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || data.success !== true || !data.user_id) return;

      window.__AUTOCUAN_APPROVED_WEBSITE_ACCESS__ = {
        userId: String(data.user_id),
        username: String(data.username || '')
      };
      try {
        localStorage.setItem('autocuan_user_id', String(data.user_id));
        localStorage.setItem('autocuan_user', String(data.username || '').toLowerCase());
        localStorage.setItem('autocuan_logged_in', 'true');
        localStorage.setItem('autocuan_login_time', localStorage.getItem('autocuan_login_time') || String(Date.now()));
      } catch (_) {}

      markApprovedAccess();
      keepDashboardOpen();
    } catch (_) {
      // A transient status check must never force a logout or send the user
      // to the landing page; index.html keeps its own retry schedule.
    }
  }

  function init() {
    hideSubscriptionUi();
    restoreApprovedSession();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
