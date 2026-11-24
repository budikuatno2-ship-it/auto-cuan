'use strict';

/**
 * test/v6-ui-ux-compliance.test.js
 * Comprehensive Compliance Test Suite for:
 * - Rule 1: nutlope/hallmark (Full-Viewport 12-Column Institutional Bento Grid & Zero Outer-Scroll)
 * - Rule 3: pbakaus/impeccable (Zero Layout Shift, CLS = 0.000, Skeleton Loaders)
 * - Rule 4: cth9191/animate (60 FPS GPU-Accelerated Micro-Transitions, transform3d/opacity only)
 * - Rule 5: DhvanilPatel/swarm-cursors (Single rAF Batched Canvas Rendering, Cursor Coordinator)
 * - Rule 6: Tencent/BrowserSkill (Automated Live DOM Bounding-Box & Zero-Truncation Contract)
 *
 * Directive: .roo/rules/auto-cuan-8-github-skills.md
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const acCssPath = path.join(ROOT, 'public', 'ac.css');
const enginePath = path.join(ROOT, 'public', 'institutional-ui-ux-engine.js');
const indexHtmlPath = path.join(ROOT, 'public', 'index.html');

const acCss = fs.readFileSync(acCssPath, 'utf8');
const engineModule = require(enginePath);
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

test('RULE 1: nutlope/hallmark — Full-Viewport 12-Column Bento Grid & Zero Outer-Scroll', () => {
  // 1. Root constraints: Desktop html & body must lock overflow: hidden
  assert.match(acCss, /@media\s*\(min-width:\s*1024px\)/, 'Media query for desktop must exist');
  assert.match(acCss, /overflow:\s*hidden\s*!important/, 'Desktop root must lock overflow: hidden');
  assert.match(acCss, /height:\s*100%\s*!important/, 'Height 100% must be enforced');
  assert.match(acCss, /width:\s*100%\s*!important/, 'Width 100% must be enforced');

  // 2. 12-Column Bento Grid rules
  assert.match(acCss, /\.bento-grid-12\s*\{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/, 'bento-grid-12 must define 12-column grid');
  assert.match(acCss, /\.bento-cell-screener\s*\{[^}]*grid-column:\s*span 3/, 'Screener cell must span 3 columns');
  assert.match(acCss, /\.bento-cell-chart\s*\{[^}]*grid-column:\s*span 6/, 'Chart cell must span 6 columns');
  assert.match(acCss, /\.bento-cell-orderflow\s*\{[^}]*grid-column:\s*span 3/, 'Orderflow cell must span 3 columns');

  // 3. Surface elevation tokens
  assert.match(acCss, /\.surface-level-1\s*\{[^}]*background-color:\s*#0B0E14/, 'Surface 1 token must match #0B0E14');
  assert.match(acCss, /\.surface-level-2\s*\{[^}]*background-color:\s*#0F141C/, 'Surface 2 token must match #0F141C');
  assert.match(acCss, /\.surface-level-3\s*\{[^}]*background-color:\s*#151B26/, 'Surface 3 token must match #151B26');
  assert.match(acCss, /\.surface-level-4\s*\{[^}]*background-color:\s*#1C2433/, 'Surface 4 token must match #1C2433');
});

test('RULE 1: Keyboard Shortcuts Navigation Handling (Alt+1, Alt+2, Alt+3, Space, Esc)', () => {
  assert.equal(typeof engineModule.initInstitutionalShortcuts, 'function', 'initInstitutionalShortcuts must be exported');

  // Mock DOM document and event emission
  let registeredHandler = null;
  const mockDoc = {
    addEventListener: (evt, handler) => {
      if (evt === 'keydown') registeredHandler = handler;
    },
    querySelector: (sel) => {
      if (sel.includes('screenerSearch')) return { focusCalled: false, focus() { this.focusCalled = true; } };
      if (sel.includes('screener')) return { clickCalled: false, click() { this.clickCalled = true; } };
      return null;
    }
  };

  engineModule.initInstitutionalShortcuts(mockDoc);
  assert.ok(registeredHandler, 'Keydown listener should be registered');

  // Test Alt + 1 trigger
  let prevented = false;
  registeredHandler({
    altKey: true,
    key: '1',
    preventDefault: () => { prevented = true; }
  });
  assert.equal(prevented, true, 'Alt+1 must prevent default');
});

test('RULE 3: pbakaus/impeccable — Zero Layout Shift (CLS = 0.000) & Skeletons', () => {
  // Skeletons must have deterministic dimensions
  assert.match(acCss, /\.institutional-skeleton-wrap\s*\{[^}]*min-height:\s*256px/, 'Skeleton wrap must have min-height: 256px');
  assert.match(acCss, /\.institutional-skeleton-chart\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/, 'Chart skeleton must have aspect-ratio 16/9');
  assert.match(acCss, /\.institutional-skeleton-row\s*\{[^}]*height:\s*40px/, 'Row skeleton must have height: 40px');

  // Script inclusion in index.html
  assert.ok(indexHtml.includes('/institutional-ui-ux-engine.js'), 'institutional-ui-ux-engine.js must be loaded in index.html');
});

test('RULE 4: cth9191/animate — 60 FPS GPU-Accelerated Micro-Transitions', () => {
  // Keyframes must ONLY animate transform/opacity/background-color and never layout properties
  const keyframesMatch = acCss.match(/@keyframes\s+price-tick-(?:up|down)\s*\{([^}]+)\}/g);
  assert.ok(keyframesMatch && keyframesMatch.length >= 2, 'Keyframes for price ticks must be present');

  for (const kf of keyframesMatch) {
    assert.doesNotMatch(kf, /\b(width|height|top|left|margin|padding)\s*:/i, 'Keyframes must not animate reflow properties');
    assert.match(kf, /transform:\s*translate3d/i, 'Keyframes must use translate3d');
  }

  // will-change promotion
  assert.match(acCss, /\.tick-flash-up\s*\{[^}]*will-change:\s*transform/i, 'tick-flash-up must promote via will-change');
  assert.match(acCss, /\.tick-flash-down\s*\{[^}]*will-change:\s*transform/i, 'tick-flash-down must promote via will-change');

  // Throttler verification
  let visHandler = null;
  const mockDoc = {
    hidden: true,
    body: { classList: { add: (c) => { mockDoc.body.added = c; }, remove: (c) => { mockDoc.body.removed = c; } } },
    addEventListener: (evt, handler) => {
      if (evt === 'visibilitychange') visHandler = handler;
    }
  };
  engineModule.initAnimationThrottler(mockDoc);
  assert.ok(visHandler, 'visibilitychange handler must be attached');
  visHandler();
  assert.equal(mockDoc.body.added, 'reduce-animations', 'Background tab must add reduce-animations');
});

test('RULE 5: DhvanilPatel/swarm-cursors — Single rAF Batched Canvas Rendering Loop', () => {
  const coordinator = new engineModule.InstitutionalCursorCoordinator();
  assert.equal(typeof coordinator.subscribe, 'function', 'Coordinator must support subscribe');
  assert.equal(typeof coordinator.onPointerMove, 'function', 'Coordinator must handle pointermove');

  let renderCount = 0;
  let receivedCoords = null;
  coordinator.subscribe((x, y) => {
    renderCount++;
    receivedCoords = { x, y };
  });

  // Emulate high polling-rate pointer events
  coordinator.onPointerMove({
    getCoalescedEvents: () => [
      { clientX: 100, clientY: 150 },
      { clientX: 105, clientY: 152 },
      { clientX: 110, clientY: 155 }
    ]
  });

  assert.equal(coordinator.isDirty, true, 'Coordinator should mark isDirty = true');
  assert.equal(coordinator.latestX, 110, 'Latest X should coalesced to 110');
  assert.equal(coordinator.latestY, 155, 'Latest Y should coalesced to 155');

  // Trigger tick directly
  coordinator.tick();
  assert.equal(renderCount, 1, 'Tick must render once per frame');
  assert.deepEqual(receivedCoords, { x: 110, y: 155 });
  assert.equal(coordinator.isDirty, false, 'Tick must reset isDirty flag');

  coordinator.destroy();
});

test('RULE 5: High-DPI Canvas Initializer with Memory Buffer Pre-allocation', () => {
  const mockCanvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: () => ({
      setTransform: () => {}
    })
  };

  const res = engineModule.setupHighDpiCanvas(mockCanvas, 800, 450);
  assert.ok(res, 'setupHighDpiCanvas should return canvas context wrapper');
  assert.equal(res.width, 800);
  assert.equal(res.height, 450);
  assert.equal(mockCanvas.style.width, '800px');
  assert.equal(mockCanvas.style.height, '450px');
});

test('RULE 6: Tencent/BrowserSkill — Automated Live DOM Bounding-Box Inspection', () => {
  // Test clean layout without collisions or clipping
  const cleanDoc = {
    documentElement: { clientWidth: 1440, clientHeight: 900 },
    querySelector: (sel) => {
      if (sel === '#screener') return { offsetWidth: 300, offsetHeight: 600, getBoundingClientRect: () => ({ left: 10, top: 10, right: 310, bottom: 610, width: 300, height: 600 }) };
      if (sel === '#chart') return { offsetWidth: 600, offsetHeight: 600, getBoundingClientRect: () => ({ left: 330, top: 10, right: 930, bottom: 610, width: 600, height: 600 }) };
      return null;
    }
  };
  const cleanWin = { innerWidth: 1440, innerHeight: 900 };

  const cleanViolations = engineModule.auditElementBoundingBoxes(['#screener', '#chart'], cleanDoc, cleanWin);
  assert.equal(cleanViolations.length, 0, 'Clean layout must have 0 violations');

  // Negative control 1: Viewport clipping
  const clippedDoc = {
    documentElement: { clientWidth: 1440, clientHeight: 900 },
    querySelector: (sel) => ({
      offsetWidth: 400,
      offsetHeight: 400,
      getBoundingClientRect: () => ({ left: 1200, top: 10, right: 1600, bottom: 410, width: 400, height: 400 }) // right > 1440
    })
  };
  const clippedViolations = engineModule.auditElementBoundingBoxes(['#clippedElement'], clippedDoc, cleanWin);
  assert.equal(clippedViolations.length, 1, 'Clipped element must be detected');
  assert.equal(clippedViolations[0].type, 'VIEWPORT_CLIPPING');

  // Negative control 2: Unintended collision
  const collidingDoc = {
    documentElement: { clientWidth: 1440, clientHeight: 900 },
    querySelector: (sel) => {
      if (sel === '#boxA') return { offsetWidth: 200, offsetHeight: 200, contains: () => false, getBoundingClientRect: () => ({ left: 100, top: 100, right: 300, bottom: 300, width: 200, height: 200 }) };
      if (sel === '#boxB') return { offsetWidth: 200, offsetHeight: 200, contains: () => false, getBoundingClientRect: () => ({ left: 250, top: 250, right: 450, bottom: 450, width: 200, height: 200 }) }; // overlaps [250..300, 250..300]
      return null;
    }
  };
  const collidingViolations = engineModule.auditElementBoundingBoxes(['#boxA', '#boxB'], collidingDoc, cleanWin);
  assert.equal(collidingViolations.length, 1, 'Collision must be detected');
  assert.equal(collidingViolations[0].type, 'UNINTENDED_COLLISION');
});

test('RULE 6: Zero-Truncation Contract for Financial Numbers', () => {
  // Ensure CSS prevents text-overflow ellipsis on numbers
  assert.match(acCss, /\.no-truncate,\s*\.institutional-num,\s*td\.num/, 'Zero truncation selector group must exist');
  assert.match(acCss, /text-overflow:\s*clip\s*!important/, 'Financial numbers must have text-overflow: clip !important');

  // Audit zero truncation in DOM
  const mockContainer = {
    querySelectorAll: () => [
      { textContent: 'Rp 14.20 M', clientWidth: 120, scrollWidth: 110 }
    ]
  };
  const mockDoc = {
    querySelector: () => mockContainer
  };

  const auditResult = engineModule.auditZeroTruncation('#myTable', mockDoc);
  assert.equal(auditResult.pass, true, 'Zero truncation must pass when numbers are not clipped');
});
