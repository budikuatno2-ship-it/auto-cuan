(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VERSION = '20260802-pattern-tab-resume-v2';

  function patternPath(root) {
    var pathname = root && root.location ? String(root.location.pathname || '') : '';
    return pathname.replace(/\/+$/, '') === '/pattern';
  }

  function createStableGate(gate) {
    var inflight = null;

    function isAllowed() {
      try { return gate && typeof gate.isAllowed === 'function' && gate.isAllowed() === true; }
      catch (_) { return false; }
    }

    function refresh() {
      // A still-fresh signed admin grant must not be turned into a transient
      // denial merely because focus + visibility events fired together.
      if (isAllowed()) return Promise.resolve(true);
      if (inflight) return inflight;
      inflight = Promise.resolve()
        .then(function () { return gate.refresh(false); })
        .then(function (allowed) { return allowed === true || isAllowed(); })
        .catch(function () { return isAllowed(); })
        .finally(function () { inflight = null; });
      return inflight;
    }

    return Object.freeze({
      refresh: refresh,
      isAllowed: isAllowed,
      deny: function () { return gate && typeof gate.deny === 'function' ? gate.deny() : false; }
    });
  }

  function normalizeLevelLabel(value) {
    var label = String(value == null ? '' : value).trim();
    if (label === 'Konfirmasi') return 'Entry / Konfirmasi';
    if (label === 'Invalidasi') return 'Stop Loss / Invalidasi';
    return label;
  }

  function normalizePatternLevels(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return 0;
    var changed = 0;
    Array.prototype.forEach.call(doc.querySelectorAll('#page-pattern .ps-level span'), function (node) {
      var next = normalizeLevelLabel(node.textContent);
      if (next && next !== String(node.textContent || '').trim()) {
        node.textContent = next;
        changed += 1;
      }
    });
    return changed;
  }

  // A page can be hidden three ways at once (`hidden`, `aria-hidden`, `inert`).
  // Clearing only the class restores a page that looks right but ignores every
  // tap, which is exactly how Pattern failed after a mobile tab resume.
  function revealPatternPage(page) {
    if (!page) return false;
    page.classList.remove('hidden');
    page.removeAttribute('aria-hidden');
    if ('inert' in page) page.inert = false;
    else page.removeAttribute('inert');
    return true;
  }

  function restorePatternPage(root) {
    if (!root || !root.document || !patternPath(root)) return false;
    var gate = root.PatternMapAdminAccess;
    if (!gate || typeof gate.isAllowed !== 'function' || gate.isAllowed() !== true) return false;
    var doc = root.document;
    var page = doc.getElementById('page-pattern');
    if (!page) {
      if (typeof root.navigateTo === 'function') root.navigateTo('pattern');
      return false;
    }
    Array.prototype.forEach.call(doc.querySelectorAll('.page-content'), function (node) {
      node.classList.toggle('hidden', node !== page);
    });
    revealPatternPage(page);
    Array.prototype.forEach.call(doc.querySelectorAll('.nav-btn[data-page]'), function (button) {
      button.classList.toggle('active', button.getAttribute('data-page') === 'pattern');
    });
    normalizePatternLevels(doc);
    return true;
  }

  function install(root) {
    if (!root || !root.document || root.__AUTOCUAN_PATTERN_TAB_RESUME_GUARD__) return false;
    var attempt = 0;

    function boot() {
      var gate = root.PatternMapAdminAccess;
      if (!gate || typeof gate.refresh !== 'function' || typeof gate.isAllowed !== 'function') {
        attempt += 1;
        if (attempt < 240) root.setTimeout(boot, 50);
        return;
      }
      if (root.__AUTOCUAN_PATTERN_TAB_RESUME_GUARD__) return;
      root.__AUTOCUAN_PATTERN_TAB_RESUME_GUARD__ = VERSION;
      root.PatternMapAdminAccess = createStableGate(gate);

      var resumeTimer = null;
      function scheduleResume(delay) {
        if (resumeTimer != null) root.clearTimeout(resumeTimer);
        resumeTimer = root.setTimeout(function () {
          resumeTimer = null;
          restorePatternPage(root);
        }, Number.isFinite(Number(delay)) ? Number(delay) : 180);
      }

      root.addEventListener('focus', function () { scheduleResume(220); });
      root.addEventListener('pageshow', function () { scheduleResume(220); });
      root.document.addEventListener('visibilitychange', function () {
        if (root.document.visibilityState === 'visible') scheduleResume(220);
      });

      var observer = new root.MutationObserver(function () {
        normalizePatternLevels(root.document);
        if (patternPath(root)) scheduleResume(80);
      });
      observer.observe(root.document.body, { childList:true, subtree:true });

      root.setInterval(function () {
        if (patternPath(root)) restorePatternPage(root);
      }, 1000);

      scheduleResume(0);
    }

    boot();
    return true;
  }

  return {
    version: VERSION,
    patternPath: patternPath,
    createStableGate: createStableGate,
    normalizeLevelLabel: normalizeLevelLabel,
    normalizePatternLevels: normalizePatternLevels,
    revealPatternPage: revealPatternPage,
    restorePatternPage: restorePatternPage,
    install: install
  };
});
