(function () {
  'use strict';

  if (window.__AUTOCUAN_APPROVED_ACCESS_GUARD__) return;
  window.__AUTOCUAN_APPROVED_ACCESS_GUARD__ = true;

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
    el.style.setProperty('filter', 'none', 'important');
  }

  function removeSubscription() {
    document.querySelectorAll('[data-page="subscription"],#page-subscription,#subscriptionIdentityCard').forEach(function (el) {
      el.remove();
    });
  }

  function markApprovedState() {
    try {
      window.premiumAccessState = {
        state: 'ready',
        premium: true,
        accessLevel: 'approved_website',
        checkedAt: Date.now(),
        expiresAt: null
      };
    } catch (_) {}
  }

  function wirePortfolio() {
    document.querySelectorAll('[data-page="portofolio"]').forEach(function (el) {
      if (el.dataset.approvedPortfolioWired === 'true') return;
      el.dataset.approvedPortfolioWired = 'true';
      el.onclick = function (event) {
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }
        window.location.href = '/portfolio-planner';
        return false;
      };
    });

    document.querySelectorAll('.action-card[data-page="portofolio"] p').forEach(function (el) {
      if (String(el.textContent || '').trim() === 'Posisi manual') el.textContent = 'Decision Center';
    });
  }

  function apply() {
    markApprovedState();
    removeSubscription();
    document.querySelectorAll('[data-premium-nav="true"]').forEach(unlockElement);
    wirePortfolio();
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
