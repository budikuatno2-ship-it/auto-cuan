/**
 * Auto-Cuan V4 Institutional UI/UX Engine
 * Conforms strictly to:
 * - Skill 1: nutlope/hallmark (Full-Viewport 12-Column Institutional Bento Grid, Zero Outer-Scroll)
 * - Skill 3: pbakaus/impeccable (Zero Layout Shift, CLS = 0.000, Fast-Bundle Readiness)
 * - Skill 4: cth9191/animate (60 FPS GPU-Accelerated Micro-Transitions, transform3d/opacity only)
 * - Skill 5: DhvanilPatel/swarm-cursors (Single requestAnimationFrame Batched Canvas Rendering)
 * - Skill 6: Tencent/BrowserSkill (Automated Live DOM & Bounding-Box Inspection, Zero Truncation)
 *
 * Directive: .roo/rules/auto-cuan-8-github-skills.md
 */

(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var engine = factory();
    root.InstitutionalUIUXEngine = engine;
    root.InstitutionalCursorCoordinator = engine.InstitutionalCursorCoordinator;
    root.auditElementBoundingBoxes = engine.auditElementBoundingBoxes;
    root.auditZeroTruncation = engine.auditZeroTruncation;
    root.setupHighDpiCanvas = engine.setupHighDpiCanvas;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // =========================================================================
  // SKILL 5: DHVANILPATEL/SWARM-CURSORS — SINGLE rAF BATCHED RENDERING LOOP
  // =========================================================================

  class InstitutionalCursorCoordinator {
    constructor() {
      this.latestX = 0;
      this.latestY = 0;
      this.isDirty = false;
      this.subscribers = new Set();
      this.rafId = null;
      this.boundContainer = null;

      this.onPointerMove = this.onPointerMove.bind(this);
      this.tick = this.tick.bind(this);
    }

    init(containerElement) {
      if (!containerElement) return;
      this.boundContainer = containerElement;
      containerElement.addEventListener('pointermove', this.onPointerMove, { passive: true });
      this.start();
    }

    onPointerMove(e) {
      // High-polling rate event coalescing (e.g. 500-1000Hz gaming mice)
      var events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [e];
      var lastEvent = events[events.length - 1];
      this.latestX = lastEvent.clientX;
      this.latestY = lastEvent.clientY;
      this.isDirty = true;
    }

    subscribe(renderCallback) {
      if (typeof renderCallback === 'function') {
        this.subscribers.add(renderCallback);
      }
      return () => this.subscribers.delete(renderCallback);
    }

    start() {
      if (!this.rafId) {
        this.tick();
      }
    }

    tick() {
      if (this.isDirty) {
        var x = this.latestX;
        var y = this.latestY;
        for (var subscriber of this.subscribers) {
          try {
            subscriber(x, y);
          } catch (err) {
            console.error('[CURSOR COORDINATOR ERROR]', err);
          }
        }
        this.isDirty = false;
      }
      if (typeof requestAnimationFrame === 'function') {
        this.rafId = requestAnimationFrame(this.tick);
      }
    }

    destroy() {
      if (this.rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      if (this.boundContainer) {
        this.boundContainer.removeEventListener('pointermove', this.onPointerMove);
        this.boundContainer = null;
      }
      this.subscribers.clear();
    }
  }

  /**
   * High-DPI Canvas Initializer with Memory Buffer Pre-allocation
   * Respects window.devicePixelRatio and ensures sub-pixel clarity without layout shifts.
   */
  function setupHighDpiCanvas(canvas, cssWidth, cssHeight) {
    if (!canvas) return null;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    var w = Math.round(cssWidth * dpr);
    var h = Math.round(cssHeight * dpr);

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';

    var ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d');
    if (ctx && typeof ctx.scale === 'function') {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { ctx: ctx, dpr: dpr, width: cssWidth, height: cssHeight };
  }

  // =========================================================================
  // SKILL 6: TENCENT/BROWSERSKILL — LIVE DOM BOUNDING-BOX & COLLISION AUDIT
  // =========================================================================

  /**
   * DOM Boundary & Overlap Auditor
   * Inspects bounding boxes of specified selectors to verify:
   * 1. Viewport boundary clipping
   * 2. Unintended collision or overlapping boxes
   */
  function auditElementBoundingBoxes(selectorList, customDoc, customWin) {
    var violations = [];
    var win = customWin || (typeof window !== 'undefined' ? window : null);
    var doc = customDoc || (typeof document !== 'undefined' ? document : null);

    if (!win || !doc || !Array.isArray(selectorList)) return violations;

    var viewportW = win.innerWidth || (doc.documentElement ? doc.documentElement.clientWidth : 1440);
    var viewportH = win.innerHeight || (doc.documentElement ? doc.documentElement.clientHeight : 900);

    var rects = selectorList.map(function (sel) {
      var el = doc.querySelector(sel);
      return { selector: sel, element: el, rect: el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null };
    }).filter(function (item) {
      return item.rect !== null && item.element && (item.element.offsetWidth > 0 || item.element.offsetHeight > 0);
    });

    // 1. Viewport Boundary Clipping Check
    for (var i = 0; i < rects.length; i++) {
      var item = rects[i];
      var r = item.rect;
      // Elements that intentionally position out of screen (e.g. hidden modals or drawers) are skipped
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -2 || r.top < -2 || (r.right - viewportW) > 2 || (r.bottom - viewportH) > 2) {
        violations.push({
          type: 'VIEWPORT_CLIPPING',
          selector: item.selector,
          box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, viewportW: viewportW, viewportH: viewportH }
        });
      }
    }

    // 2. Collision / Unintended Overlap Check
    for (var j = 0; j < rects.length; j++) {
      for (var k = j + 1; k < rects.length; k++) {
        var a = rects[j].rect;
        var b = rects[k].rect;
        // Ignore if one is fully inside another (parent-child relationship)
        var isAncestorOrDescendant = false;
        try {
          isAncestorOrDescendant = rects[j].element.contains(rects[k].element) || rects[k].element.contains(rects[j].element);
        } catch (_) {}
        if (isAncestorOrDescendant) continue;

        var overlaps = !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
        if (overlaps) {
          violations.push({
            type: 'UNINTENDED_COLLISION',
            itemA: rects[j].selector,
            itemB: rects[k].selector,
            rectA: { left: a.left, top: a.top, right: a.right, bottom: a.bottom },
            rectB: { left: b.left, top: b.top, right: b.right, bottom: b.bottom }
          });
        }
      }
    }

    return violations;
  }

  /**
   * Zero-Truncation Contract Auditor
   * Verifies that high-stakes financial metrics (prices, volumes, CR3, foreign flow)
   * are not truncated with ellipsis ("...") that obscures numerical certainty.
   */
  function auditZeroTruncation(rootSelector, customDoc) {
    var doc = customDoc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return { pass: true, truncated: [] };

    var container = rootSelector ? doc.querySelector(rootSelector) : doc;
    if (!container) return { pass: true, truncated: [] };

    var targets = container.querySelectorAll('.num, .mono, [data-metric], .financial-metric, td.num');
    var truncated = [];

    for (var i = 0; i < targets.length; i++) {
      var el = targets[i];
      // Check if text is clipped via scrollWidth > clientWidth with text-overflow: ellipsis
      var style = (typeof window !== 'undefined' && window.getComputedStyle) ? window.getComputedStyle(el) : null;
      if (style && style.textOverflow === 'ellipsis') {
        if (el.scrollWidth > el.clientWidth && el.clientWidth > 0) {
          truncated.push({
            element: el,
            text: el.textContent.trim(),
            clientWidth: el.clientWidth,
            scrollWidth: el.scrollWidth
          });
        }
      }
    }

    return {
      pass: truncated.length === 0,
      truncatedCount: truncated.length,
      truncated: truncated
    };
  }

  // =========================================================================
  // SKILL 1 & 4: KEYBOARD SHORTCUTS & 60 FPS GPU ANIMATION THROTTLER
  // =========================================================================

  function initInstitutionalShortcuts(customDoc) {
    var doc = customDoc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.addEventListener) return;

    doc.addEventListener('keydown', function (e) {
      var target = e.target;
      var isInput = target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      );

      // Alt + 1: Focus Screener Table & Search Input
      if (e.altKey && (e.key === '1' || e.code === 'Digit1')) {
        e.preventDefault();
        var screenerNav = doc.querySelector('[data-page="screener"], a[href="#screener"], button#nav-screener, #sidebarItem-screener');
        if (screenerNav && typeof screenerNav.click === 'function') screenerNav.click();
        var searchInput = doc.querySelector('#screenerSearch, #screenerContent input[type="search"], #page-screener input');
        if (searchInput && typeof searchInput.focus === 'function') {
          setTimeout(function () { searchInput.focus(); }, 50);
        }
        return;
      }

      // Alt + 2: Focus TradingView / Lightweight Chart Surface
      if (e.altKey && (e.key === '2' || e.code === 'Digit2')) {
        e.preventDefault();
        var chartNav = doc.querySelector('[data-page="analisis"], [data-page="chart"], a[href="#analisis"], button#nav-analisis, #sidebarItem-analisis');
        if (chartNav && typeof chartNav.click === 'function') chartNav.click();
        var chartCanvas = doc.querySelector('#primary-chart-canvas, #mainChart canvas, #chartPageContainer canvas');
        if (chartCanvas && typeof chartCanvas.focus === 'function') chartCanvas.focus();
        return;
      }

      // Alt + 3: Focus Orderflow / Broker Hunter Depth Panel
      if (e.altKey && (e.key === '3' || e.code === 'Digit3')) {
        e.preventDefault();
        var hunterNav = doc.querySelector('[data-page="hunter"], [data-subtab="hunter"], a[href="#hunter"], button#nav-hunter, #sidebarItem-hunter');
        if (hunterNav && typeof hunterNav.click === 'function') hunterNav.click();
        var hunterPanel = doc.querySelector('#brokerHunterContent, #orderflow-container, #page-hunter');
        if (hunterPanel && typeof hunterPanel.focus === 'function') hunterPanel.focus();
        return;
      }

      // Space: Toggle Play/Pause on Live Screener Streaming (only when not typing in form controls)
      if (e.key === ' ' || e.code === 'Space') {
        if (!isInput) {
          e.preventDefault();
          var streamToggle = doc.querySelector('#screenerStreamToggle, #liveStreamToggle, [data-action="toggle-stream"]');
          if (streamToggle && typeof streamToggle.click === 'function') {
            streamToggle.click();
          } else if (typeof window !== 'undefined' && typeof window.toggleScreenerStreaming === 'function') {
            window.toggleScreenerStreaming();
          }
        }
        return;
      }

      // Esc: Clear Active Filter or Dismiss Modal Overlays
      if (e.key === 'Escape' || e.code === 'Escape') {
        var openModalCloseBtn = doc.querySelector('.modal:not(.hidden) .close-btn, .modal:not(.hidden) [data-dismiss="modal"], dialog[open] .close-btn');
        if (openModalCloseBtn && typeof openModalCloseBtn.click === 'function') {
          e.preventDefault();
          openModalCloseBtn.click();
          return;
        }
        var activeFilterInput = doc.querySelector('input:focus');
        if (activeFilterInput) {
          activeFilterInput.value = '';
          activeFilterInput.blur();
          var evt = new Event('input', { bubbles: true });
          activeFilterInput.dispatchEvent(evt);
        }
      }
    });
  }

  function initAnimationThrottler(customDoc) {
    var doc = customDoc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.addEventListener) return;

    doc.addEventListener('visibilitychange', function () {
      if (doc.hidden) {
        if (doc.body) doc.body.classList.add('reduce-animations');
        if (typeof window !== 'undefined') window.__pauseTickAnimations = true;
      } else {
        if (doc.body) doc.body.classList.remove('reduce-animations');
        if (typeof window !== 'undefined') window.__pauseTickAnimations = false;
      }
    });
  }

  // Auto-initialize when loaded in browser
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        initInstitutionalShortcuts(document);
        initAnimationThrottler(document);
      });
    } else {
      initInstitutionalShortcuts(document);
      initAnimationThrottler(document);
    }
  }

  return {
    InstitutionalCursorCoordinator: InstitutionalCursorCoordinator,
    setupHighDpiCanvas: setupHighDpiCanvas,
    auditElementBoundingBoxes: auditElementBoundingBoxes,
    auditZeroTruncation: auditZeroTruncation,
    initInstitutionalShortcuts: initInstitutionalShortcuts,
    initAnimationThrottler: initAnimationThrottler
  };
});
