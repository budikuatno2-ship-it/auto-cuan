(function () {
  'use strict';

  if (window.__AUTOCUAN_APPROVED_WEBSITE_RUNTIME__) return;
  window.__AUTOCUAN_APPROVED_WEBSITE_RUNTIME__ = true;

  var approved = false;
  var originalNavigate = null;
  var originalStartupFallback = null;
  var scheduled = false;

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

  function enableElement(el) {
    if (!el) return;
    ['hidden','opacity-40','opacity-50','opacity-60','cursor-not-allowed','pointer-events-none','grayscale'].forEach(function (name) {
      if (el.classList.contains(name)) el.classList.remove(name);
    });
    ['hidden','disabled'].forEach(function (name) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    });
    if (el.getAttribute('aria-hidden') !== 'false') el.setAttribute('aria-hidden', 'false');
    if (el.getAttribute('aria-disabled') !== 'false') el.setAttribute('aria-disabled', 'false');
    if (el.style.display === 'none') el.style.removeProperty('display');
    if (el.style.opacity) el.style.removeProperty('opacity');
    if (el.style.pointerEvents) el.style.removeProperty('pointer-events');
    if (el.style.cursor) el.style.removeProperty('cursor');
    if (el.style.filter) el.style.removeProperty('filter');
  }

  function revealApprovedFeatures() {
    if (!approved) return;
    document.querySelectorAll('[data-premium-nav="true"]').forEach(enableElement);
    var badge = document.getElementById('approvedBadge');
    if (badge) enableElement(badge);
  }

  function wireNavigation() {
    if (!approved || typeof window.navigateTo !== 'function') return;
    if (!originalNavigate) originalNavigate = window.navigateTo;
    if (window.navigateTo && window.navigateTo.__approvedWebsiteWrapper) return;

    function approvedNavigate(page) {
      if (page === 'subscription') return false;
      if (page === 'portofolio') {
        window.location.assign('/portfolio-planner');
        return false;
      }
      return originalNavigate.apply(this, arguments);
    }
    approvedNavigate.__approvedWebsiteWrapper = true;
    window.navigateTo = approvedNavigate;
    window.hasConfirmedPremiumAccess = function () { return true; };
  }

  function apply() {
    hideSubscriptionUi();
    revealApprovedFeatures();
    wireNavigation();
  }

  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(function () {
      scheduled = false;
      apply();
    });
  }

  function keepDashboardOpen() {
    if (!approved || !isDashboardRoute()) return;
    try {
      localStorage.setItem('autocuan_logged_in', 'true');
      localStorage.setItem('autocuan_entered_app', 'true');
    } catch (_) {}

    var landing = document.getElementById('landingPage');
    if (landing) landing.classList.add('hidden');
    var fallback = document.getElementById('startupFallbackNotice');
    if (fallback && fallback.parentNode) fallback.parentNode.removeChild(fallback);

    if (typeof window.enterApp === 'function') {
      try { window.enterApp({ replaceHistory: true }); } catch (_) {}
    } else if (typeof window.showDashboard === 'function') {
      try { window.showDashboard(); } catch (_) {}
    }
  }

  function protectStartupFallback() {
    if (typeof window.renderStartupFallback !== 'function') return;
    if (!originalStartupFallback) originalStartupFallback = window.renderStartupFallback;
    if (window.renderStartupFallback.__approvedWebsiteWrapper) return;

    function safeFallback() {
      if (approved || (isDashboardRoute() && localStorage.getItem('autocuan_logged_in') === 'true')) {
        keepDashboardOpen();
        return;
      }
      return originalStartupFallback.apply(this, arguments);
    }
    safeFallback.__approvedWebsiteWrapper = true;
    window.renderStartupFallback = safeFallback;
  }

  async function restoreApprovedSession() {
    hideSubscriptionUi();
    protectStartupFallback();
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

      approved = true;
      window.__AUTOCUAN_APPROVED_WEBSITE_ACCESS__ = {
        userId: String(data.user_id),
        username: String(data.username || '')
      };
      localStorage.setItem('autocuan_user_id', String(data.user_id));
      localStorage.setItem('autocuan_user', String(data.username || '').toLowerCase());
      localStorage.setItem('autocuan_logged_in', 'true');
      localStorage.setItem('autocuan_login_time', localStorage.getItem('autocuan_login_time') || String(Date.now()));
      apply();
      keepDashboardOpen();
      [100, 350, 900, 1800].forEach(function (delay) { setTimeout(apply, delay); });
    } catch (_) {
      // A transient status check must never force a logout or send the user to landing.
    }
  }

  function init() {
    hideSubscriptionUi();
    protectStartupFallback();
    restoreApprovedSession();

    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(scheduleApply).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class','hidden','disabled','aria-hidden','aria-disabled','style']
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
