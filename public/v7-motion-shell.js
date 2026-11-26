/* Auto-Cuan V7 Motion & Overlay Choreography Runtime
   Coordinates motion/mini (3.23 KB gz), @floating-ui/dom, focus-trap, and WAAPI
   under strict prefers-reduced-motion compliance. */
(function (root) {
  'use strict';
  if (!root || !root.document || root.__AUTOCUAN_V7_MOTION_SHELL__) return;
  root.__AUTOCUAN_V7_MOTION_SHELL__ = true;

  var doc = root.document;
  var reduced = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false, addEventListener: function () {} };
  var state = {
    version: 'v7-4a',
    active: true,
    engine: 'css-spring+waapi',
    reducedMotion: Boolean(reduced && reduced.matches),
    animatedCount: 0,
    indicatorsBound: 0,
    trapsBound: 0
  };

  function isReduced() {
    return Boolean(reduced && reduced.matches);
  }

  function animateEl(el, keyframes, opts) {
    if (!el || isReduced()) return null;
    try {
      state.animatedCount += 1;
      if (root.MotionMini && typeof root.MotionMini.animate === 'function') {
        state.engine = 'motion/mini+waapi';
        return root.MotionMini.animate(el, keyframes, opts || { duration: 0.24 });
      }
      if (typeof el.animate === 'function') {
        var waapiOpts = Object.assign({
          duration: 240,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'none'
        }, opts || {});
        return el.animate(keyframes, waapiOpts);
      }
    } catch (_) {}
    return null;
  }

  function animateRevealBatch(selector) {
    var nodes = Array.from(doc.querySelectorAll(selector || ''));
    if (!nodes.length || isReduced()) return;
    nodes.forEach(function (el, idx) {
      if (el.dataset && el.dataset.v7Revealed === '1') return;
      if (el.dataset) el.dataset.v7Revealed = '1';
      animateEl(el, {
        opacity: [0.92, 1],
        transform: ['translateY(6px)', 'translateY(0px)']
      }, {
        duration: 0.24,
        delay: Math.min(idx, 6) * 0.035,
        easing: [0.22, 1, 0.36, 1]
      });
    });
  }

  /* Fluid Sliding Indicator for tab strips & segmented groups */
  function syncSlidingIndicator(containerSelector, activeSelector) {
    var container = typeof containerSelector === 'string' ? doc.querySelector(containerSelector) : containerSelector;
    if (!container) return;
    var active = container.querySelector(activeSelector || '.active, [aria-selected="true"], .on, .is-active');
    if (!active) return;

    var pill = container.querySelector('.v7-sliding-pill');
    if (!pill) {
      pill = doc.createElement('span');
      pill.className = 'v7-sliding-pill';
      pill.setAttribute('aria-hidden', 'true');
      container.classList.add('v7-seg-track');
      container.insertBefore(pill, container.firstChild);
      state.indicatorsBound += 1;
    }

    var left = active.offsetLeft;
    var top = active.offsetTop;
    var w = active.offsetWidth;
    var h = active.offsetHeight;
    if (w <= 0 || h <= 0) {
      pill.style.opacity = '0';
      return;
    }
    pill.style.opacity = '1';
    pill.style.width = w + 'px';
    pill.style.height = h + 'px';
    pill.style.transform = 'translate3d(' + left + 'px, ' + top + 'px, 0)';
  }

  function refreshAllIndicators() {
    [
      ['#landingPage .landing-preview-tabs', '.preview-tab.active, .preview-tab[aria-selected="true"]'],
      ['#landingPage .landing-preview-subtabs', '.preview-tab.active, .preview-tab[aria-selected="true"]'],
      ['#page-dashboard .dash-top5-tabs', 'button.on'],
      ['#page-dashboard .dash-hist-bar .segx', 'button.on']
    ].forEach(function (pair) {
      syncSlidingIndicator(pair[0], pair[1]);
    });
  }

  /* Focus Trap integration for Command Palette & Dynamic Modals */
  var activeTrap = null;
  function activateFocusTrap(el) {
    if (!el || !root.focusTrap || typeof root.focusTrap.createFocusTrap !== 'function') return;
    try {
      if (activeTrap && typeof activeTrap.deactivate === 'function') {
        activeTrap.deactivate({ returnFocus: false });
      }
      activeTrap = root.focusTrap.createFocusTrap(el, {
        allowOutsideClick: true,
        escapeDeactivates: false,
        fallbackFocus: el
      });
      activeTrap.activate();
      state.trapsBound += 1;
    } catch (_) {}
  }

  function deactivateFocusTrap() {
    if (activeTrap && typeof activeTrap.deactivate === 'function') {
      try { activeTrap.deactivate({ returnFocus: true }); } catch (_) {}
    }
    activeTrap = null;
  }

  /* Wrap global Command Palette & Account Center modal open/close smoothly */
  function patchModalChoreography() {
    if (root.AutoCuanCommandPalette && !root.AutoCuanCommandPalette.__v7Wrapped) {
      var origOpen = root.AutoCuanCommandPalette.open;
      var origClose = root.AutoCuanCommandPalette.close;
      root.AutoCuanCommandPalette.open = function () {
        origOpen.apply(this, arguments);
        var container = doc.querySelector('#commandPaletteModal .ac-command-palette-container');
        if (container) animateEl(container, { opacity: [0.4, 1], transform: ['scale(0.97) translateY(-6px)', 'scale(1) translateY(0)'] }, { duration: 0.2, easing: [0.22, 1, 0.36, 1] });
        var modal = doc.getElementById('commandPaletteModal');
        if (modal) activateFocusTrap(modal);
      };
      root.AutoCuanCommandPalette.close = function () {
        deactivateFocusTrap();
        origClose.apply(this, arguments);
      };
      root.AutoCuanCommandPalette.__v7Wrapped = true;
    }

    ['openLoginModal', 'openRegisterModal', 'openSelfResetModal'].forEach(function (fnName) {
      var orig = root[fnName];
      if (typeof orig !== 'function' || orig.__v7Wrapped) return;
      var wrapped = function () {
        orig.apply(this, arguments);
        var id = fnName === 'openLoginModal' ? 'loginModal' : (fnName === 'openRegisterModal' ? 'registerModal' : 'selfResetModal');
        var card = doc.querySelector('#' + id + ' > div');
        if (card) animateEl(card, { opacity: [0.45, 1], transform: ['scale(0.97) translateY(8px)', 'scale(1) translateY(0)'] }, { duration: 0.22, easing: [0.22, 1, 0.36, 1] });
      };
      wrapped.__v7Wrapped = true;
      root[fnName] = wrapped;
    });

    if (typeof root.navigateTo === 'function' && !root.navigateTo.__v7Wrapped) {
      var origNav = root.navigateTo;
      var wrappedNav = function () {
        var ret = origNav.apply(this, arguments);
        setTimeout(function () {
          refreshAllIndicators();
          var vis = doc.querySelector('.page-content:not(.hidden)');
          if (vis) animateEl(vis, { opacity: [0.7, 1], transform: ['translateY(6px)', 'translateY(0)'] }, { duration: 0.2, easing: [0.22, 1, 0.36, 1] });
        }, 16);
        return ret;
      };
      wrappedNav.__v7Wrapped = true;
      root.navigateTo = wrappedNav;
    }
  }

  /* License Attribution Modal (Apache-2.0 NOTICE summary) */
  function openAttributionModal() {
    var existing = doc.getElementById('v7NoticeModal');
    if (existing) {
      existing.classList.remove('hidden');
      existing.style.display = 'flex';
      activateFocusTrap(existing);
      return;
    }
    var modal = doc.createElement('div');
    modal.id = 'v7NoticeModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'v7NoticeTitle');
    modal.style.cssText = 'position:fixed;inset:0;z-index:100060;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--ac-backdrop);backdrop-filter:blur(10px);';
    modal.innerHTML = [
      '<div style="width:min(600px,100%);max-height:85dvh;overflow:auto;background:var(--ac-surface);color:var(--ac-ink);border:1px solid var(--ac-line-soft);border-radius:16px;padding:22px;box-shadow:var(--ac-shadow-modal)">',
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid var(--ac-line-hairline);padding-bottom:12px">',
      '<div><p style="margin:0;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--ac-brand)">Kepatuhan Lisensi</p><h2 id="v7NoticeTitle" style="margin:4px 0 0;font-size:18px;font-weight:800">Lisensi &amp; Atribusi Upstream (NOTICE)</h2></div>',
      '<button type="button" id="v7NoticeClose" aria-label="Tutup" style="min-width:44px;min-height:44px;border-radius:8px;border:1px solid var(--ac-line-hairline);background:var(--ac-surface-raised);color:var(--ac-ink);font-size:20px;cursor:pointer">&times;</button>',
      '</div>',
      '<ul style="margin:14px 0;padding-left:18px;font-size:12.5px;line-height:1.65;color:var(--ac-text-secondary)">',
      '<li><strong>TradingView Lightweight Charts™</strong> (Apache-2.0): <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noopener noreferrer" style="color:var(--ac-brand)">tradingview.com/lightweight-charts</a></li>',
      '<li><strong>Apache ECharts</strong> (Apache-2.0): The Apache Software Foundation</li>',
      '<li><strong>trawangan UX Patterns</strong> (Apache-2.0): Based on trawangan (Created by Kaleksanan Barqi Aji Massani)</li>',
      '<li><strong>Style Dictionary</strong> (Apache-2.0), <strong>Motion</strong>, <strong>Floating UI</strong>, <strong>focus-trap</strong>, <strong>NumberFlow</strong> (MIT)</li>',
      '</ul>',
      '<p style="margin:0;font-size:11.5px;color:var(--ac-text-muted)">Salinan lengkap tersedia di berkas <code>NOTICE</code> root repositori.</p>',
      '</div>'
    ].join('');
    doc.body.appendChild(modal);
    function closeNotice() {
      deactivateFocusTrap();
      modal.classList.add('hidden');
      modal.style.display = 'none';
    }
    doc.getElementById('v7NoticeClose').addEventListener('click', closeNotice);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeNotice(); });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeNotice();
    });
    activateFocusTrap(modal);
  }

  /* Collision-safe dropdown positioning helper using @floating-ui/dom */
  function positionPopover(triggerEl, popoverEl, opts) {
    if (!triggerEl || !popoverEl || !root.FloatingUIDOM) return Promise.resolve();
    var F = root.FloatingUIDOM;
    return F.computePosition(triggerEl, popoverEl, {
      placement: (opts && opts.placement) || 'bottom-end',
      middleware: [F.offset(6), F.flip(), F.shift({ padding: 8 })]
    }).then(function (pos) {
      popoverEl.style.left = Math.round(pos.x) + 'px';
      popoverEl.style.top = Math.round(pos.y) + 'px';
    }).catch(function () {});
  }

  function init() {
    state.reducedMotion = isReduced();
    patchModalChoreography();
    refreshAllIndicators();
    animateRevealBatch('#landingPage .preview-pane, #page-dashboard .sheet');
    Array.from(doc.querySelectorAll('#landingPage .landing-hero-note')).forEach(function (el) {
      el.style.setProperty('color', 'var(--ac-text-secondary)', 'important');
    });

    doc.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.landing-preview-tabs, .landing-preview-subtabs, .dash-top5-tabs, .segx')) {
        setTimeout(refreshAllIndicators, 20);
      }
      if (e.target.closest && e.target.closest('[data-v7-open-notice]')) {
        e.preventDefault();
        openAttributionModal();
      }
    });

    root.addEventListener('resize', refreshAllIndicators, { passive: true });
    if (reduced && typeof reduced.addEventListener === 'function') {
      reduced.addEventListener('change', function () { state.reducedMotion = isReduced(); });
    }
  }

  root.AutoCuanV7Motion = {
    getState: function () { return Object.assign({}, state); },
    animate: animateEl,
    revealBatch: animateRevealBatch,
    syncIndicator: syncSlidingIndicator,
    refreshIndicators: refreshAllIndicators,
    positionPopover: positionPopover,
    openAttributionModal: openAttributionModal
  };
  root.openV7NoticeModal = openAttributionModal;

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(typeof window !== 'undefined' ? window : null);
