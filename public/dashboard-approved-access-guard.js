(function () {
  'use strict';

  if (window.__AUTOCUAN_APPROVED_ACCESS_GUARD__) return;
  window.__AUTOCUAN_APPROVED_ACCESS_GUARD__ = true;

  function apply() {
    document.querySelectorAll('[data-premium-nav="true"]').forEach(function (el) {
      el.classList.remove('hidden');
      el.removeAttribute('hidden');
      el.setAttribute('aria-hidden', 'false');
      el.style.setProperty('display', el.classList.contains('action-card') ? 'block' : 'flex', 'important');
    });

    document.querySelectorAll('[data-page="subscription"],#page-subscription,#subscriptionIdentityCard').forEach(function (el) {
      el.remove();
    });

    document.querySelectorAll('[data-page="portofolio"]').forEach(function (el) {
      if (el.dataset.approvedPortfolioWired === 'true') return;
      el.dataset.approvedPortfolioWired = 'true';
      el.onclick = function (event) {
        if (event) event.preventDefault();
        window.location.href = '/portfolio-planner';
        return false;
      };
    });
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
    [100, 300, 750, 1500, 3000, 6000].forEach(function (delay) {
      setTimeout(apply, delay);
    });

    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(scheduleApply).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'style']
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
