(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VERSION = '20260728-final-ui-v1';
  var SKIP_TAGS = /^(?:SCRIPT|STYLE|TEXTAREA|INPUT|SELECT|OPTION|CODE|PRE|NOSCRIPT)$/;

  function artifactOnly(value) {
    return /^(?:;|；|\||[-*_]{3,}|#{1,6}|\*\*|__)$/.test(String(value == null ? '' : value).trim());
  }

  function pruneArtifacts(node) {
    if (!node) return 0;
    if (node.nodeType === 3) {
      if (!artifactOnly(node.nodeValue)) return 0;
      if (node.parentNode) node.parentNode.removeChild(node);
      return 1;
    }
    if (node.nodeType !== 1 || SKIP_TAGS.test(node.tagName || '')) return 0;
    var removed = 0;
    Array.prototype.slice.call(node.childNodes || []).forEach(function (child) {
      removed += pruneArtifacts(child);
    });
    if (!node.children.length && artifactOnly(node.textContent)) {
      if (node.parentNode) node.parentNode.removeChild(node);
      removed += 1;
    }
    return removed;
  }

  function installArtifactCleaner(root) {
    var doc = root.document;
    if (!doc || doc.__AUTOCUAN_GLOBAL_ARTIFACT_CLEANER__) return false;
    doc.__AUTOCUAN_GLOBAL_ARTIFACT_CLEANER__ = VERSION;
    pruneArtifacts(doc.body);
    if (typeof root.MutationObserver !== 'function') return true;
    var observer = new root.MutationObserver(function (records) {
      records.forEach(function (record) {
        Array.prototype.forEach.call(record.addedNodes || [], pruneArtifacts);
      });
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    return true;
  }

  function installChartCleanup(root) {
    var doc = root.document;
    if (!doc || doc.getElementById('autocuanFinalChartCleanup')) return false;
    var style = doc.createElement('style');
    style.id = 'autocuanFinalChartCleanup';
    style.textContent = '#technicalChartTab{display:none!important}';
    doc.head.appendChild(style);
    return true;
  }

  function markPatternCoverage(doc) {
    var subtitle = doc.querySelector('#page-pattern .ps-sub');
    if (subtitle) subtitle.textContent = 'Detector aktif saat ini: Bullish ABCD dan Bearish ABCD pada candle harian T-1 dari hasil Screener terbaru.';
    var title = doc.querySelector('#page-pattern .ps-title');
    if (title && !title.querySelector('.ps-coverage-label')) {
      var label = doc.createElement('span');
      label.className = 'ps-coverage-label';
      label.textContent = 'ABCD v1';
      label.style.cssText = 'display:inline-flex;margin-left:9px;padding:4px 8px;vertical-align:middle;border:1px solid rgba(96,165,250,.25);border-radius:999px;background:rgba(59,130,246,.08);color:#93c5fd;font-size:10px;font-weight:800;letter-spacing:0';
      title.appendChild(label);
    }
  }

  function installPatternReentry(root, attempt) {
    var doc = root.document;
    var page = doc && doc.getElementById('page-pattern');
    if (!doc || !page || typeof root.navigateTo !== 'function') {
      if ((attempt || 0) < 240) root.setTimeout(function () { installPatternReentry(root, (attempt || 0) + 1); }, 50);
      return false;
    }
    if (root.__AUTOCUAN_PATTERN_REENTRY_FIX__) return true;
    root.__AUTOCUAN_PATTERN_REENTRY_FIX__ = VERSION;

    var stablePatternNavigate = root.navigateTo;

    function visible() {
      var node = doc.getElementById('page-pattern');
      var active = doc.querySelector('.nav-btn[data-page="pattern"].active');
      return !!(node && !node.classList.contains('hidden') && active);
    }

    function ensurePattern() {
      markPatternCoverage(doc);
      if (!root.location || root.location.pathname !== '/pattern' || visible()) return;
      Promise.resolve(stablePatternNavigate('pattern')).catch(function () {});
    }

    doc.addEventListener('click', function (event) {
      var button = event.target && event.target.closest ? event.target.closest('.nav-btn[data-page="pattern"]') : null;
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      Promise.resolve(stablePatternNavigate('pattern')).then(function () { markPatternCoverage(doc); }).catch(function () {});
    }, true);

    var originalEnterApp = typeof root.enterApp === 'function' ? root.enterApp : null;
    if (originalEnterApp && !originalEnterApp.__AUTOCUAN_PATTERN_REENTRY_WRAPPED__) {
      var wrappedEnterApp = function () {
        var result = originalEnterApp.apply(root, arguments);
        Promise.resolve(result).finally(function () { root.setTimeout(ensurePattern, 0); });
        return result;
      };
      wrappedEnterApp.__AUTOCUAN_PATTERN_REENTRY_WRAPPED__ = true;
      root.enterApp = wrappedEnterApp;
    }

    root.addEventListener('pageshow', ensurePattern);
    root.addEventListener('popstate', ensurePattern);
    root.addEventListener('focus', ensurePattern);
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible') ensurePattern(); });
    [0, 150, 600, 1500].forEach(function (delay) { root.setTimeout(ensurePattern, delay); });
    markPatternCoverage(doc);
    return true;
  }

  function install(root) {
    if (!root || !root.document) return false;
    var artifact = installArtifactCleaner(root);
    var chart = installChartCleanup(root);
    installPatternReentry(root, 0);
    return artifact || chart;
  }

  return {
    version: VERSION,
    artifactOnly: artifactOnly,
    pruneArtifacts: pruneArtifacts,
    installArtifactCleaner: installArtifactCleaner,
    installChartCleanup: installChartCleanup,
    installPatternReentry: installPatternReentry,
    install: install
  };
});
