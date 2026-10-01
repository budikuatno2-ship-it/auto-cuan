(function () {
  'use strict';
  if (window.__AUTOCUAN_PORTFOLIO_AI_WORKSPACE_V1__) return;
  window.__AUTOCUAN_PORTFOLIO_AI_WORKSPACE_V1__ = true;

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function focusWorkspace() {
    var page = document.getElementById('page-ai');
    if (!page || !page.classList.contains('active')) return;
    try {
      page.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    } catch (_) {
      page.scrollIntoView(true);
    }
  }

  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-tab="ai"]') : null;
    if (!button) return;
    // Command Center switches the page in its own click handler. Run after it.
    setTimeout(focusWorkspace, 0);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var button = event.target && event.target.closest ? event.target.closest('[data-tab="ai"]') : null;
    if (!button) return;
    setTimeout(focusWorkspace, 0);
  });
})();
