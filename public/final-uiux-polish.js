/* Auto-Cuan final UI/UX runtime polish.
   Performance-only layer: prefetch + interaction readiness.
   It intentionally does not own auth, data, scoring, or navigation state. */
(function (root) {
  'use strict';
  if (!root || !root.document || root.__AUTO_CUAN_FINAL_UIUX__) return;
  root.__AUTO_CUAN_FINAL_UIUX__ = '20260930-v1';

  var doc = root.document;
  var prefetched = new Set();
  var reduced = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)');

  var routeAssets = {
    analisis: [
      '/partials/analisis-saham.partial.html'
    ],
    portofolio: [
      '/partials/portfolio-command-center.partial.html'
    ]
  };

  function prefetchUrl(url) {
    if (!url || prefetched.has(url)) return;
    prefetched.add(url);
    try {
      root.fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'force-cache',
        priority: 'low'
      }).catch(function () {
        prefetched.delete(url);
      });
    } catch (_) {
      prefetched.delete(url);
    }
  }

  function prefetchPage(page) {
    var urls = routeAssets[String(page || '')];
    if (!urls) return;
    urls.forEach(prefetchUrl);
  }

  function pageFromTarget(target) {
    if (!target || !target.closest) return '';
    var item = target.closest('[data-sidebar-page],[data-page]');
    if (!item) return '';
    var page = item.getAttribute('data-sidebar-page') || item.getAttribute('data-page') || '';
    if (page === 'ranking' || page === 'bandarmologi' || page === 'intel' ||
        page === 'hunter' || page === 'insider' || page === 'pattern') {
      return 'analisis';
    }
    return page;
  }

  function proximityPrefetch(event) {
    var page = pageFromTarget(event.target);
    if (page) prefetchPage(page);
  }

  doc.addEventListener('pointerover', proximityPrefetch, { passive: true });
  doc.addEventListener('focusin', proximityPrefetch);

  function idleWarm() {
    prefetchPage('analisis');
    prefetchPage('portofolio');
  }

  if ('requestIdleCallback' in root) {
    root.requestIdleCallback(idleWarm, { timeout: 2200 });
  } else {
    root.setTimeout(idleWarm, 1200);
  }

  /* Keep active pointer feedback compositor-only. This makes dense dashboard
     controls feel responsive without creating layout work or long animations. */
  doc.addEventListener('pointerdown', function (event) {
    var el = event.target && event.target.closest
      ? event.target.closest('button,.sidebar-item,.action-card,[role="button"]')
      : null;
    if (!el || (reduced && reduced.matches)) return;
    el.classList.add('ac-pressing');
  }, { passive: true });

  function releasePress(event) {
    var el = event.target && event.target.closest
      ? event.target.closest('button,.sidebar-item,.action-card,[role="button"]')
      : null;
    if (el) el.classList.remove('ac-pressing');
  }
  doc.addEventListener('pointerup', releasePress, { passive: true });
  doc.addEventListener('pointercancel', releasePress, { passive: true });

  root.AutoCuanFinalUiux = {
    prefetchPage: prefetchPage
  };
})(window);
