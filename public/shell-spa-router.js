'use strict';

/**
 * FASE 8 & 9 — ZERO-DUMMY SPA ROUTER
 * ============================================================================
 * The sidebar tree-view used to be cosmetic: clicking "Bandarmologi" ran a
 * scrollIntoView() on the analysis page and changed nothing on the canvas.
 * The real Bandarmologi / Intel / Hunter / Insider / Ranking / Pattern views,
 * and the whole Portfolio Command Center, live in two self-contained pages
 * (`/analisis-saham` and `/portfolio-command-center`).
 *
 * This module embeds those pages — the ACTUAL pages, with their own runtime,
 * charts and data contracts — inside the workspace as a same-origin iframe,
 * then drives their own tab APIs from the sidebar. Nothing is reimplemented
 * and no data logic is copied: the standalone pages keep 100% of their
 * calculation, parsing and persistence code.
 *
 * Contract with the host page (public/index.html):
 *   - container:  #workspaceViewHost        (created here if absent)
 *   - page content blocks with [data-spa-page] get hidden while a view is open
 *   - sidebar items carry data-subview="chart|bandarmologi|intel|hunter|
 *     insider|ranking|pattern" and portfolio: "today|planner|watch|risk|
 *     scenarios|journal|ai"
 *   - switchAnalisisSubView(sub) / switchPortfolioSubView(sub) call into here
 *   - returning to a native page calls closeWorkspaceView()
 *
 * Exposed as window.AutoCuanShellSpa. No dependencies.
 */

(function (root) {
  if (!root || root.AutoCuanShellSpa) return;

  var ANALISIS_PAGE = '/analisis-saham';
  var PORTFOLIO_PAGE = '/portfolio-command-center';

  // Sidebar sub-view -> parent page tab id (the standalone pages' own ids).
  var ANALISIS_TAB = {
    chart: 'analisis-chart',
    bandarmologi: 'bandarmologi',
    intel: 'intel',
    hunter: 'hunter',
    insider: 'insider',
    ranking: 'ranking',
    financial: 'financial',
    'market-structure': 'market-structure',
    pattern: 'pattern'
  };
  var PORTFOLIO_TAB = {
    today: 'today',
    planner: 'planner',
    watch: 'watch',
    risk: 'risk',
    scenarios: 'scenarios',
    journal: 'journal',
    ai: 'ai'
  };

  var host = null;          // wrapper element
  var frame = null;         // the <iframe>
  var framePage = null;     // which standalone page is loaded
  var pendingTab = null;    // tab to apply once the frame reports ready
  var readyHandlers = [];
  var lastFocus = null;

  function byId(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------------ host */

  function ensureHost() {
    if (host && host.isConnected !== false && document.body.contains(host)) return host;
    host = byId('workspaceViewHost');
    if (host) return host;

    host = document.createElement('div');
    host.id = 'workspaceViewHost';
    host.className = 'workspace-view-host hidden';
    host.setAttribute('data-spa-host', 'true');
    host.innerHTML =
      '<div class="workspace-view-chrome">' +
        '<span class="workspace-view-title" id="workspaceViewTitle">Workspace</span>' +
        '<button type="button" class="workspace-view-back" id="workspaceViewBack" ' +
          'title="Kembali ke dashboard" aria-label="Kembali ke dashboard">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" ' +
            'stroke-width="2" d="M15 18l-6-6 6-6"/></svg>' +
          '<span>Dashboard</span>' +
        '</button>' +
      '</div>' +
      '<div class="workspace-view-frame-wrap">' +
        // Eager loading on purpose: the view is opened by an explicit user
        // click, and `loading="lazy"` left the frame blank until it was
        // scrolled near the viewport (headless Chrome never loaded it at all).
        '<iframe id="workspaceViewFrame" class="workspace-view-frame" ' +
          'title="Workspace Auto-Cuan" loading="eager" ' +
          'referrerpolicy="same-origin" allow="clipboard-write"></iframe>' +
      '</div>';

    // Mount inside the content column so the fixed rail never covers it.
    var mount = byId('appMain') || document.body;
    mount.appendChild(host);

    var back = byId('workspaceViewBack');
    if (back) {
      back.addEventListener('click', function () {
        if (typeof root.navigateTo === 'function') root.navigateTo('dashboard');
        else closeWorkspaceView();
      });
    }
    frame = byId('workspaceViewFrame');
    if (frame) frame.addEventListener('load', onFrameLoad);
    return host;
  }

  function onFrameLoad() {
    // The standalone pages expose their tab switch on the iframe's window.
    // Apply whatever tab was requested while the frame was still loading.
    if (pendingTab) {
      var t = pendingTab;
      pendingTab = null;
      // Two ticks: the standalone runtimes bind their tabs on DOMContentLoaded.
      setTimeout(function () { applyTab(framePage, t); }, 0);
      setTimeout(function () { applyTab(framePage, t); }, 180);
    }
    readyHandlers.splice(0).forEach(function (fn) { try { fn(); } catch (_) {} });
  }

  /* ------------------------------------------------------------- page open */

  function openPage(page, tab) {
    ensureHost();
    var title = byId('workspaceViewTitle');
    if (title) title.textContent = page === PORTFOLIO_PAGE ? 'Portofolio' : 'Analisis Saham';

    var wasHidden = host.classList.contains('hidden');
    if (wasHidden) {
      lastFocus = document.activeElement;
      host.classList.remove('hidden');
      document.body.classList.add('workspace-view-open');
      hideNativePages(true);
    }

    if (framePage !== page) {
      framePage = page;
      pendingTab = tab || null;
      if (frame) frame.src = page + '?embed=1';
      return;
    }
    if (tab) applyTab(page, tab);
  }

  function applyTab(page, tab) {
    if (!frame || !frame.contentWindow) return;
    var win;
    try { win = frame.contentWindow; } catch (_) { return; }
    if (!win) return;

    if (page === PORTFOLIO_PAGE) {
      var pTab = PORTFOLIO_TAB[tab] || tab;
      // The command center wires its own tab strip on load; click the real
      // button so its internal state (aria-selected, panel visibility, lazy
      // render) stays consistent instead of us poking at styles.
      try {
        var btn = win.document.querySelector('#tabStrip [data-tab="' + pTab + '"]');
        if (btn) { btn.click(); return; }
      } catch (_) {}
      return;
    }

    var aTab = ANALISIS_TAB[tab] || tab;
    try {
      if (typeof win.switchAnalisisTab === 'function') { win.switchAnalisisTab(aTab); return; }
    } catch (_) {}
    try {
      var abtn = win.document.querySelector('.analisis-tab[data-tab="' + aTab + '"]');
      if (abtn) abtn.click();
    } catch (_) {}
  }

  /* ------------------------------------------------------- native page hide */

  var savedDisplay = [];

  function hideNativePages(hide) {
    var blocks = document.querySelectorAll('.page-content');
    if (!blocks || !blocks.length) return;
    if (hide) {
      savedDisplay = [];
      Array.prototype.forEach.call(blocks, function (el, i) {
        savedDisplay[i] = { el: el, display: el.style.display };
        el.style.display = 'none';
      });
    } else {
      savedDisplay.forEach(function (row) {
        if (row && row.el) row.el.style.display = row.display || '';
      });
      savedDisplay = [];
    }
  }

  function closeWorkspaceView() {
    if (!host) return;
    host.classList.add('hidden');
    document.body.classList.remove('workspace-view-open');
    hideNativePages(false);
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (_) {} }
  }

  function isOpen() {
    return Boolean(host && !host.classList.contains('hidden'));
  }

  /* ------------------------------------------------------------- public API */

  root.AutoCuanShellSpa = {
    openAnalisis: function (sub) { openPage(ANALISIS_PAGE, sub || 'chart'); },
    openPortfolio: function (sub) { openPage(PORTFOLIO_PAGE, sub || 'today'); },
    open: openPage,
    close: closeWorkspaceView,
    isOpen: isOpen,
    getFrame: function () { return frame; },
    getPage: function () { return framePage; }
  };
})(typeof window !== 'undefined' ? window : this);
