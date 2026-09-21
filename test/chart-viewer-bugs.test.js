const assert = require('assert');

// Mock browser environment for testing chart-viewer.js
function createMockDom() {
  const listeners = {};
  const doc = {
    activeElement: null,
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        className: '',
        style: {},
        attributes: {},
        children: [],
        parentNode: null,
        setAttribute(k, v) { this.attributes[k] = String(v); },
        getAttribute(k) { return this.attributes[k]; },
        hasAttribute(k) { return k in this.attributes; },
        removeAttribute(k) { delete this.attributes[k]; },
        appendChild(child) {
          child.parentNode = this;
          this.children.push(child);
          return child;
        },
        removeChild(child) {
          const idx = this.children.indexOf(child);
          if (idx >= 0) this.children.splice(idx, 1);
          child.parentNode = null;
          return child;
        },
        querySelectorAll(selector) {
          const found = [];
          function search(node) {
            if (node.tagName === 'BUTTON' || node.tagName === 'A') found.push(node);
            for (const c of node.children) search(c);
          }
          search(el);
          return found;
        },
        addEventListener(type, fn) {
          if (!this._listeners) this._listeners = {};
          this._listeners[type] = fn;
        },
        focus() {
          doc.activeElement = el;
        }
      };
      return el;
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    removeEventListener(type, fn) {
      delete listeners[type];
    }
  };
  doc.body = doc.createElement('body');

  const root = {
    document: doc,
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    __listeners: listeners
  };
  return root;
}

async function runTests() {
  console.log('--- Running public/chart-viewer.js Bug Reproduction Tests ---');

  const chartViewer = require('../public/chart-viewer');

  // BUG-CV-01: Focus trap in onKeydown allows Tab to escape modal when activeElement is outside overlay
  console.log('\nTesting BUG-CV-01: Focus trap leak...');
  try {
    const mockRoot = createMockDom();
    const externalInput = mockRoot.document.createElement('button');
    mockRoot.document.activeElement = externalInput; // Focus is currently on an outside element

    const viewer = chartViewer.open(mockRoot, {
      title: 'Test Chart',
      candles: []
    });

    const onKeydown = mockRoot.__listeners['keydown'];
    assert.ok(onKeydown, 'keydown listener must be attached');

    let prevented = false;
    const tabEvent = {
      key: 'Tab',
      shiftKey: false,
      preventDefault() { prevented = true; }
    };

    onKeydown(tabEvent);

    // When focus is outside overlay, onKeydown fails to capture and trap focus inside overlay
    assert.strictEqual(
      prevented,
      true,
      `BUG-CV-01 PROVEN: Tab key event while activeElement is outside modal was not trapped (preventDefault was not called)`
    );
  } catch (err) {
    console.log('   [FAIL - BUG PROVEN]', err.message);
  }

  // BUG-CV-02: Race condition & orphaned rendering when viewer is closed before chart finishes loading
  console.log('\nTesting BUG-CV-02: Disposed chart viewer orphaned execution...');
  try {
    const mockRoot = createMockDom();
    let chartRenderedAfterClose = false;

    mockRoot.renderLightweightChart = function() {
      chartRenderedAfterClose = true;
      return Promise.resolve();
    };

    let resolveChartsLoading;
    mockRoot.loadLightweightCharts = function() {
      return new Promise(resolve => {
        resolveChartsLoading = resolve;
      });
    };

    const viewer = chartViewer.open(mockRoot, {
      title: 'Interactive Chart',
      candles: [{ time: '2026-03-29', open: 100, high: 110, low: 90, close: 105 }, { time: '2026-03-30', open: 105, high: 115, low: 100, close: 110 }]
    });

    // Close the viewer immediately before loading completes
    viewer.close();

    // Now complete the delayed script loading
    resolveChartsLoading();
    await new Promise(r => setTimeout(r, 50));

    assert.strictEqual(
      chartRenderedAfterClose,
      false,
      `BUG-CV-02 PROVEN: renderInteractive executed renderLightweightChart even though viewer had already been closed/disposed`
    );
  } catch (err) {
    console.log('   [FAIL - BUG PROVEN]', err.message);
  }

  // BUG-CV-03: Export PNG button remains active in actions bar when chart engine fails and falls back to image
  console.log('\nTesting BUG-CV-03: Stale export PNG button after chart failure...');
  try {
    const mockRoot = createMockDom();
    mockRoot.downloadChartPng = function() {};
    mockRoot.renderLightweightChart = function() {
      return Promise.reject(new Error('WebGL context lost'));
    };

    const viewer = chartViewer.open(mockRoot, {
      title: 'Fallback Chart',
      candles: [{ time: '2026-03-29', close: 100 }, { time: '2026-03-30', close: 105 }],
      image: { src: 'https://example.com/chart.png' }
    });

    await new Promise(r => setTimeout(r, 50));

    const exportButtons = viewer.overlay.querySelectorAll('button').filter(b => b.textContent === 'Simpan PNG');
    assert.strictEqual(
      exportButtons.length,
      0,
      `BUG-CV-03 PROVEN: Export PNG button remained visible in actions toolbar calling downloadChartPng after chart engine failed and fell back to static image`
    );
  } catch (err) {
    console.log('   [FAIL - BUG PROVEN]', err.message);
  }

  // BUG-CV-04: Drag-pan broken after releasing second finger during pinch-zoom
  console.log('\nTesting BUG-CV-04: Drag-pan broken after lifting second finger...');
  try {
    const mockRoot = createMockDom();
    chartViewer.open(mockRoot, {
      title: 'Image Chart',
      candles: [],
      image: { src: 'https://example.com/chart.png' }
    });

    const frame = mockRoot.document.body.children[0].children[1].children[0]; // overlay -> body -> frame
    assert.ok(frame, 'Image frame element must exist');

    const pointerDown = frame._listeners['pointerdown'];
    const pointerMove = frame._listeners['pointermove'];
    const pointerUp = frame._listeners['pointerup'];
    assert.ok(pointerDown && pointerMove && pointerUp, 'Pointer event listeners must exist');

    // Start 2-finger pinch
    pointerDown({ pointerId: 1, clientX: 100, clientY: 100 });
    pointerDown({ pointerId: 2, clientX: 200, clientY: 200 });

    // Release pointer 2
    pointerUp({ pointerId: 2 });

    // Move pointer 1 (attempt to drag pan with remaining finger)
    let panOccurred = false;
    const initialStyle = frame.children[0].style.transform;
    pointerMove({
      pointerId: 1,
      clientX: 150,
      clientY: 150,
      preventDefault() { panOccurred = true; }
    });

    assert.strictEqual(
      panOccurred,
      true,
      `BUG-CV-04 PROVEN: Pointer move with remaining 1 finger failed to pan because dragStart remained null after releasing second finger`
    );
  } catch (err) {
    console.log('   [FAIL - BUG PROVEN]', err.message);
  }
}

runTests();
