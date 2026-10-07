/* Auto-Cuan Canonical Motion & Interaction Runtime (Wave 10 Final).
   Performance & interaction layer: canonical panel motion, prefetch, and press feedback.
   Strictly presentation-only: does not own auth, data, scoring, or navigation state. */
(function (root) {
  'use strict';
  if (!root || !root.document || root.__AUTOCUAN_CANONICAL_MOTION__) return;
  root.__AUTOCUAN_CANONICAL_MOTION__ = '20261006-v1';

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

  function getMotionConfig() {
    var duration = 260;
    var easing = 'cubic-bezier(.16,1,.3,1)';
    if (root.getComputedStyle && doc.documentElement) {
      try {
        var style = root.getComputedStyle(doc.documentElement);
        var durVal = (style.getPropertyValue('--motion-panel') || '').trim();
        var easeVal = (style.getPropertyValue('--ease-emphasized') || '').trim();
        if (durVal) {
          var parsed = parseFloat(durVal);
          if (durVal.endsWith('s') && !durVal.endsWith('ms')) {
            parsed = parsed * 1000;
          }
          if (Number.isFinite(parsed) && parsed > 0) {
            duration = parsed;
          }
        }
        if (easeVal) {
          easing = easeVal;
        }
      } catch (_) {}
    }
    return { duration: duration, easing: easing };
  }

  var lastAnimation = null;
  function enterPanel(panel) {
    if (!panel || !panel.animate || (reduced && reduced.matches)) return;
    if (lastAnimation) {
      try { lastAnimation.cancel(); } catch (_) {}
    }
    var config = getMotionConfig();
    lastAnimation = panel.animate(
      [
        { opacity: 0, transform: 'translate3d(0,8px,0) scale(.998)' },
        { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' }
      ],
      { duration: config.duration, easing: config.easing }
    );
  }

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

  /* Keep active pointer feedback compositor-only with canonical --motion-press */
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

  var api = {
    prefetchPage: prefetchPage,
    enterPanel: enterPanel
  };

  root.AutoCuanMotion = api;
  /* Compatibility facade for legacy consumers */
  root.AutoCuanFinalUiux = api;
})(typeof window !== 'undefined' ? window : this);
