(function () {
  'use strict';

  if (window.__AUTOCUAN_APPROVED_ACCESS_GUARD__) return;
  window.__AUTOCUAN_APPROVED_ACCESS_GUARD__ = true;

  var APPROVED_PAGES = { sektor: true, screener: true, portofolio: true };
  var originalNavigateTo = typeof window.navigateTo === 'function' ? window.navigateTo : null;

  function unlockElement(el) {
    if (!el) return;
    el.classList.remove('hidden', 'opacity-40', 'opacity-50', 'opacity-60', 'cursor-not-allowed', 'pointer-events-none', 'grayscale');
    el.removeAttribute('hidden');
    el.removeAttribute('disabled');
    el.disabled = false;
    el.setAttribute('aria-hidden', 'false');
    el.setAttribute('aria-disabled', 'false');
    el.tabIndex = 0;
    el.style.setProperty('display', el.classList.contains('action-card') ? 'block' : 'flex', 'important');
    el.style.setProperty('opacity', '1', 'important');
    el.style.setProperty('pointer-events', 'auto', 'important');
    el.style.setProperty('cursor', 'pointer', 'important');
    el.style.removeProperty('filter');
  }

  function removeSubscription() {
    document.querySelectorAll('[data-page="subscription"],#page-subscription,#subscriptionIdentityCard').forEach(function (el) {
      el.remove();
    });
  }

  function setActiveNav(page) {
    document.querySelectorAll('.nav-btn').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-page') === page);
    });
  }

  function showPage(page) {
    if (page === 'portofolio') {
      window.location.href = '/portfolio-planner';
      return;
    }

    var target = document.getElementById('page-' + page);
    if (!target) return;

    try { window.currentPage = page; } catch (_) {}
    document.querySelectorAll('.page-content').forEach(function (el) {
      el.classList.add('hidden');
    });
    target.classList.remove('hidden');
    target.classList.add('flex-1');
    setActiveNav(page);

    if (page === 'sektor') {
      var sektorGate = document.getElementById('sektorLoginGate');
      var sektorContent = document.getElementById('sektorContent');
      if (sektorGate) sektorGate.classList.add('hidden');
      if (sektorContent) sektorContent.classList.remove('hidden');
      if (typeof window.loadSektorHot === 'function') window.loadSektorHot();
    }

    if (page === 'screener') {
      var screenerGate = document.getElementById('screenerLoginGate');
      var screenerContent = document.getElementById('screenerContent');
      if (screenerGate) screenerGate.classList.add('hidden');
      if (screenerContent) screenerContent.classList.remove('hidden');
      if (typeof window.loadSwingScreener === 'function') window.loadSwingScreener();
    }

    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function approvedNavigateTo(page) {
    page = String(page || '');
    if (APPROVED_PAGES[page]) {
      showPage(page);
      return;
    }
    if (page === 'subscription') {
      showPage('dashboard');
      return;
    }
    if (originalNavigateTo) return originalNavigateTo(page);
  }

  function overrideLegacyPremiumGate() {
    try {
      window.hasConfirmedPremiumAccess = function () { return true; };
      window.isPremiumFeaturePage = function () { return false; };
      window.premiumAccessState = {
        state: 'ready',
        premium: true,
        accessLevel: 'approved_website',
        checkedAt: Date.now(),
        expiresAt: null
      };
      window.loadPremiumAccess = async function () { return window.premiumAccessState; };
      window.navigateTo = approvedNavigateTo;
    } catch (_) {}
  }

  function wireDirectClicks() {
    document.querySelectorAll('[data-premium-nav="true"]').forEach(function (el) {
      unlockElement(el);
      var page = el.getAttribute('data-page');
      if (!APPROVED_PAGES[page]) return;
      if (el.dataset.approvedDirectClick === 'true') return;
      el.dataset.approvedDirectClick = 'true';
      el.onclick = function (event) {
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }
        approvedNavigateTo(page);
        return false;
      };
    });
  }

  function apply() {
    overrideLegacyPremiumGate();
    removeSubscription();
    wireDirectClicks();
  }

  var scheduled = false;
  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      apply();
    });
  }

  function init() {
    apply();
    [50, 150, 300, 750, 1500, 3000, 6000].forEach(function (delay) {
      setTimeout(apply, delay);
    });

    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(scheduleApply).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'style', 'disabled', 'aria-disabled']
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
