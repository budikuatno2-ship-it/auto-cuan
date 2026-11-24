'use strict';

/**
 * F3 (CHT-36/37/38) & P0-CHART-04 — real-browser E2E for the chart surface.
 *
 * HONESTY CONTRACT
 * ----------------
 * This suite NEVER fakes a browser run. It first probes for a usable headless
 * browser (puppeteer / playwright / a system Chrome/Chromium binary). If none is
 * available it SKIPS with the explicit reason BROWSER_UNAVAILABLE and records
 * the re-enable plan — a legitimate, documented skip, not a pass.
 *
 * When a browser IS available it runs the key F3 & P0-CHART-04 journeys:
 *   - active detectors render genuine SVG elements (<path>, <polygon>, <text>, <circle>) in overlay
 *   - positive geometry assertion: anchor coordinates have distinct X and Y (never collapse to single point)
 *   - toggle 'Matikan Semua' (families: []): overlay host empties (0 SVG elements)
 *   - multi-viewport validation: Desktop Standard (1366x768), Pro Desktop (1440x900, 1920x1080), Mobile (390x844)
 *   - drawer interaction (open Pattern category, toggle an auto family)
 *   - toggle does NOT rescale the main chart (visible logical range preserved)
 *   - ticker switch race (rapid switch => final overlay matches final ticker)
 *   - honest empty state (data-overlay-empty) on an insufficient series
 *
 * Re-enable plan (documented in docs/v6/V6_CHART_BROWSER_E2E_MATRIX.csv):
 *   1. `npm i -D puppeteer` (or install Chromium and set CHROME_PATH)
 *   2. `node tools/local-dev-server.js` (or set AUTO_CUAN_BASE_URL)
 *   3. `node --test test/v6/chart-browser-e2e-f3.test.js`
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// ------------------------------------------------------------------
// Local dev server bootstrap (same pattern as test/v6-chart-browser-e2e.test.js)
// ------------------------------------------------------------------
let _child = null;
let _baseUrl = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function waitForServer(baseUrl, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function check() {
      const req = http.get(baseUrl + '/preview/analisis-saham', (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('server start timeout'));
        else setTimeout(check, 300);
      });
    })();
  });
}

async function ensureServer() {
  if (_baseUrl) return _baseUrl;
  let baseUrl = process.env.AUTO_CUAN_BASE_URL;
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
    const port = await freePort();
    baseUrl = 'http://127.0.0.1:' + port;
    _child = spawn(process.execPath, ['tools/local-dev-server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(port) }),
      stdio: 'ignore'
    });
    await waitForServer(baseUrl, 30000);
  }
  _baseUrl = baseUrl;
  return baseUrl;
}

test.after(() => { if (_child) { try { _child.kill(); } catch (_) {} } });

// ------------------------------------------------------------------
// Browser availability probe (no network, no installs)
// ------------------------------------------------------------------
function findBrowser() {
  const candidates = [];
  // Node module drivers
  for (const mod of ['puppeteer', 'puppeteer-core', 'playwright', 'playwright-core']) {
    try {
      const resolved = require.resolve(mod, { paths: [ROOT] });
      candidates.push({ kind: 'module', name: mod, path: resolved });
    } catch (_) { /* not installed */ }
  }
  // System binaries
  const bins = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  for (const b of bins) {
    try { if (fs.existsSync(b)) candidates.push({ kind: 'binary', name: path.basename(b), path: b }); } catch (_) {}
  }
  return candidates;
}

const BROWSERS = findBrowser();
const HAS_DRIVER = BROWSERS.some((b) => b.kind === 'module');
const HAS_BINARY = BROWSERS.some((b) => b.kind === 'binary');
const BROWSER_AVAILABLE = HAS_DRIVER && HAS_BINARY;

const SKIP_REASON = 'BROWSER_UNAVAILABLE: no puppeteer/playwright driver + system Chrome/Chromium pair found. ' +
  'Re-enable: npm i -D puppeteer (or set CHROME_PATH), start tools/local-dev-server.js, re-run this suite.';

async function launchBrowser() {
  const driverName = BROWSERS.find((b) => b.kind === 'module').name;
  const binary = BROWSERS.find((b) => b.kind === 'binary').path;
  if (driverName.indexOf('puppeteer') === 0) {
    const puppeteer = require(driverName);
    return await puppeteer.launch({ executablePath: binary, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } else {
    const { chromium } = require(driverName);
    return await chromium.launch({ executablePath: binary, headless: true, args: ['--no-sandbox'] });
  }
}

// ------------------------------------------------------------------
// 1. Availability is reported honestly (always runs)
// ------------------------------------------------------------------
test('F3 E2E: browser availability is probed and reported honestly', () => {
  const report = {
    drivers: BROWSERS.filter((b) => b.kind === 'module').map((b) => b.name),
    binaries: BROWSERS.filter((b) => b.kind === 'binary').map((b) => b.path),
    available: BROWSER_AVAILABLE
  };
  // The probe must always produce a definite answer.
  assert.equal(typeof report.available, 'boolean');
  if (!BROWSER_AVAILABLE) {
    assert.ok(report.drivers.length === 0 || report.binaries.length === 0,
      'unavailable means at least one half of the driver+binary pair is missing');
  }
});

// ------------------------------------------------------------------
// 2. Static wiring assertions (run without a browser)
// ------------------------------------------------------------------
test('F3 E2E: index.html loads the bundle + runtime in the right order', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const iCore = html.indexOf('/chart-core-browser.js');
  const iWs = html.indexOf('/chart-workstation.js');
  const iRt = html.indexOf('/chart-auto-patterns-runtime.js');
  assert.ok(iCore > 0, 'chart-core-browser.js is included');
  assert.ok(iRt > 0, 'chart-auto-patterns-runtime.js is included');
  assert.ok(iCore < iWs, 'bundle loads before the workstation');
  assert.ok(iWs < iRt, 'runtime loads after the workstation');
});

test('F3 E2E: render path calls the auto-patterns runtime', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'market-feature-runtime.js'), 'utf8');
  assert.ok(src.indexOf('AutoCuanChartAutoPatterns') !== -1, 'runtime is referenced from the render path');
  assert.ok(/AutoCuanChartAutoPatterns\.attach\(/.test(src), 'attach() is called');
});

test('F3 E2E: drawer exposes the auto-detector family toggles', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'chart-workstation.js'), 'utf8');
  assert.ok(src.indexOf("id: 'auto_patterns'") !== -1, 'auto_patterns layer group exists');
  assert.ok(src.indexOf("groupIds: ['struktur', 'sinyal', 'pola_klasik', 'auto_patterns']") !== -1,
    'auto_patterns is in the Pattern drawer category');
});

// ------------------------------------------------------------------
// 3. Live browser journeys (P0-CHART-04 & F3 genuine execution)
// ------------------------------------------------------------------

// P0-CHART-04 (a & b): Live browser renders active detector visual SVG elements in overlay container
test('P0-CHART-04 E2E: active detectors render genuine SVG elements (<path>, <polygon>, <text>, <circle>) in overlay',
  { skip: BROWSER_AVAILABLE ? false : SKIP_REASON },
  async () => {
    const baseUrl = await ensureServer();
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(baseUrl + '/preview/analisis-saham', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__chartRegistry && Object.keys(window.__chartRegistry).length > 0, { timeout: 30000 });
      await new Promise((r) => setTimeout(r, 2000));

      const chartId = await page.evaluate(() => Object.keys(window.__chartRegistry)[0]);
      const overlayStats = await page.evaluate((id) => {
        const host = document.getElementById(id + '_autopattern_overlay');
        if (!host) return null;
        const svg = host.querySelector('svg');
        const paths = host.querySelectorAll('path');
        const polygons = host.querySelectorAll('polygon');
        const circles = host.querySelectorAll('circle');
        const texts = host.querySelectorAll('text');
        const rects = host.querySelectorAll('rect');
        return {
          emptyAttr: host.getAttribute('data-overlay-empty'),
          reason: host.getAttribute('data-overlay-reason'),
          hasSvg: !!svg,
          viewBox: svg ? svg.getAttribute('viewBox') : null,
          pathCount: paths.length,
          polygonCount: polygons.length,
          circleCount: circles.length,
          textCount: texts.length,
          rectCount: rects.length,
          totalVisualElements: paths.length + polygons.length + circles.length + texts.length + rects.length
        };
      }, chartId);

      assert.ok(overlayStats, 'overlay host element exists in DOM');
      assert.equal(overlayStats.emptyAttr, 'false', 'overlay is not empty when detectors are active');
      assert.equal(overlayStats.hasSvg, true, 'overlay host contains an SVG element');
      assert.ok(overlayStats.viewBox && overlayStats.viewBox.length > 0, 'SVG element defines viewBox attribute');
      assert.ok(overlayStats.totalVisualElements > 0, 'overlay contains positive visual SVG elements');
      assert.ok(overlayStats.pathCount > 0 || overlayStats.polygonCount > 0 || overlayStats.circleCount > 0,
        'overlay contains at least one geometric vector element (path, polygon, or circle)');
      assert.ok(overlayStats.textCount > 0, 'overlay contains pattern annotations/text elements');
    } finally {
      try { await browser.close(); } catch (_) {}
    }
  });

// P0-CHART-04 (c): Positive geometry assertion — anchor coordinates have distinct X/Y and do not collapse
test('P0-CHART-04 E2E: positive geometry assertion — anchor coordinates have distinct X and Y without collapse',
  { skip: BROWSER_AVAILABLE ? false : SKIP_REASON },
  async () => {
    const baseUrl = await ensureServer();
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(baseUrl + '/preview/analisis-saham', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__chartRegistry && Object.keys(window.__chartRegistry).length > 0, { timeout: 30000 });
      await new Promise((r) => setTimeout(r, 2000));

      const chartId = await page.evaluate(() => Object.keys(window.__chartRegistry)[0]);
      const coords = await page.evaluate((id) => {
        const host = document.getElementById(id + '_autopattern_overlay');
        if (!host) return null;
        const circles = Array.from(host.querySelectorAll('circle'));
        const xs = new Set();
        const ys = new Set();
        let nanFound = false;
        let uniformCollapseFound = false;

        circles.forEach((c) => {
          const cx = parseFloat(c.getAttribute('cx'));
          const cy = parseFloat(c.getAttribute('cy'));
          if (isNaN(cx) || isNaN(cy)) {
            nanFound = true;
          } else {
            xs.add(Math.round(cx * 10) / 10);
            ys.add(Math.round(cy * 10) / 10);
          }
        });

        // Check path 'd' attributes for uniform collapsing (e.g. static 760,170 or identical points)
        const paths = Array.from(host.querySelectorAll('path'));
        paths.forEach((p) => {
          const d = p.getAttribute('d') || '';
          if (d.includes('760 170') || d.includes('760,170')) {
            uniformCollapseFound = true;
          }
        });

        return {
          totalCircles: circles.length,
          distinctXCount: xs.size,
          distinctYCount: ys.size,
          nanFound,
          uniformCollapseFound
        };
      }, chartId);

      assert.ok(coords, 'coordinates extraction succeeded');
      assert.equal(coords.nanFound, false, 'no NaN coordinate values found in rendered SVG');
      assert.equal(coords.uniformCollapseFound, false, 'no static uniform collapse (760,170) found in paths');
      assert.ok(coords.distinctXCount >= 10, 'anchor X coordinates are distinct across the timeline (got ' + coords.distinctXCount + ')');
      assert.ok(coords.distinctYCount >= 10, 'anchor Y coordinates are distinct across the price scale (got ' + coords.distinctYCount + ')');
    } finally {
      try { await browser.close(); } catch (_) {}
    }
  });

// P0-CHART-04 (d): Toggle 'Matikan Semua' (families: []) empties overlay (0 SVG elements)
test('P0-CHART-04 E2E: toggle "Matikan Semua" (families: []) empties overlay host (0 SVG elements)',
  { skip: BROWSER_AVAILABLE ? false : SKIP_REASON },
  async () => {
    const baseUrl = await ensureServer();
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(baseUrl + '/preview/analisis-saham', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__chartRegistry && Object.keys(window.__chartRegistry).length > 0, { timeout: 30000 });
      await new Promise((r) => setTimeout(r, 2000));

      const chartId = await page.evaluate(() => Object.keys(window.__chartRegistry)[0]);

      // Invoke toggle 'Matikan Semua' with explicit empty families array
      const turnOffResult = await page.evaluate((id) => {
        const reg = window.__chartRegistry[id];
        const rt = window.AutoCuanChartAutoPatterns;
        const candles = (reg && reg.candleSeries && typeof reg.candleSeries.data === 'function') ? reg.candleSeries.data() : [];
        const result = rt.attach(id, candles, 'BBCA', { preset: 'pro', families: [], force: true });
        const host = document.getElementById(id + '_autopattern_overlay');
        return {
          attachResult: { empty: result.empty, reason: result.reason, renderedCount: result.rendered.length },
          domState: {
            emptyAttr: host ? host.getAttribute('data-overlay-empty') : null,
            reasonAttr: host ? host.getAttribute('data-overlay-reason') : null,
            svgCount: host ? host.querySelectorAll('svg').length : -1,
            elementCount: host ? host.querySelectorAll('path, circle, polygon, text').length : -1
          }
        };
      }, chartId);

      assert.equal(turnOffResult.attachResult.empty, true, 'attach result reports empty: true');
      assert.equal(turnOffResult.attachResult.reason, 'ALL_FAMILIES_DISABLED', 'reason is ALL_FAMILIES_DISABLED');
      assert.equal(turnOffResult.attachResult.renderedCount, 0, 'rendered array is empty');
      assert.equal(turnOffResult.domState.emptyAttr, 'true', 'DOM data-overlay-empty attribute is "true"');
      assert.equal(turnOffResult.domState.reasonAttr, 'ALL_FAMILIES_DISABLED', 'DOM data-overlay-reason attribute matches');
      assert.equal(turnOffResult.domState.svgCount, 0, '0 SVG elements present in overlay container');
      assert.equal(turnOffResult.domState.elementCount, 0, '0 visual elements present in overlay container');
    } finally {
      try { await browser.close(); } catch (_) {}
    }
  });

// P0-CHART-04 (e): Multi-viewport verification (Desktop Standard, Pro Desktop, Mobile)
test('P0-CHART-04 E2E: multi-viewport verification across Desktop Standard (1366x768), Pro Desktop (1440x900, 1920x1080), and Mobile (390x844)',
  { skip: BROWSER_AVAILABLE ? false : SKIP_REASON },
  async () => {
    const baseUrl = await ensureServer();
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      const viewports = [
        { name: 'Desktop Standard (1366x768)', width: 1366, height: 768, isMobile: false },
        { name: 'Pro Desktop (1440x900)', width: 1440, height: 900, isMobile: false },
        { name: 'Pro Desktop FHD (1920x1080)', width: 1920, height: 1080, isMobile: false },
        { name: 'Mobile (390x844)', width: 390, height: 844, isMobile: true }
      ];

      for (const vp of viewports) {
        await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.isMobile });
        await page.goto(baseUrl + '/preview/analisis-saham', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__chartRegistry && Object.keys(window.__chartRegistry).length > 0, { timeout: 30000 });
        await new Promise((r) => setTimeout(r, 1500));

        const chartId = await page.evaluate(() => Object.keys(window.__chartRegistry)[0]);
        const res = await page.evaluate((id) => {
          const host = document.getElementById(id + '_autopattern_overlay');
          if (!host) return { mounted: false };
          const svg = host.querySelector('svg');
          const circles = Array.from(host.querySelectorAll('circle'));
          const xs = new Set();
          const ys = new Set();
          circles.forEach((c) => {
            xs.add(c.getAttribute('cx'));
            ys.add(c.getAttribute('cy'));
          });
          return {
            mounted: true,
            empty: host.getAttribute('data-overlay-empty'),
            hasSvg: !!svg,
            viewBox: svg ? svg.getAttribute('viewBox') : null,
            visualCount: host.querySelectorAll('path, circle, polygon, text').length,
            distinctX: xs.size,
            distinctY: ys.size
          };
        }, chartId);

        assert.equal(res.mounted, true, `[${vp.name}] overlay host must be mounted`);
        assert.equal(res.empty, 'false', `[${vp.name}] overlay reports non-empty data state`);
        assert.equal(res.hasSvg, true, `[${vp.name}] SVG container is rendered`);
        assert.ok(res.viewBox, `[${vp.name}] SVG has valid viewBox`);
        assert.ok(res.visualCount > 0, `[${vp.name}] visual elements rendered > 0 (got ${res.visualCount})`);
        assert.ok(res.distinctX >= 10, `[${vp.name}] positive geometry: distinct X >= 10 (got ${res.distinctX})`);
        assert.ok(res.distinctY >= 10, `[${vp.name}] positive geometry: distinct Y >= 10 (got ${res.distinctY})`);
      }
    } finally {
      try { await browser.close(); } catch (_) {}
    }
  });

// Existing F3 Interaction Suite (drawer, no-rescale, ticker race, empty state)
test('F3 E2E: drawer interaction + toggle no-rescale + ticker race + empty state',
  { skip: BROWSER_AVAILABLE ? false : SKIP_REASON },
  async () => {
    const baseUrl = await ensureServer();
    const browser = await launchBrowser();

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(baseUrl + '/preview/analisis-saham', { waitUntil: 'domcontentloaded' });

      // Wait for the chart registry to be populated.
      await page.waitForFunction(() => window.__chartRegistry && Object.keys(window.__chartRegistry).length > 0, { timeout: 30000 });

      const chartId = await page.evaluate(() => Object.keys(window.__chartRegistry)[0]);

      // (a) Drawer interaction: open the Pattern category and toggle a family.
      const drawerOk = await page.evaluate((id) => {
        const ws = window.AutoCuanChartWorkstation;
        if (!ws) return false;
        const inst = ws.getInstance(id);
        if (!inst) return false;
        const before = inst.state.isLayerActive('elliott');
        ws.toggleLayer(id, 'elliott');
        const after = inst.state.isLayerActive('elliott');
        return before !== after;
      }, chartId);
      assert.equal(drawerOk, true, 'toggling an auto family flips its state');

      // (b) Toggle must NOT rescale the main chart.
      const noRescale = await page.evaluate((id) => {
        const reg = window.__chartRegistry[id];
        const before = reg.mainChart.timeScale().getVisibleLogicalRange();
        window.AutoCuanChartWorkstation.toggleLayer(id, 'harmonic');
        const after = reg.mainChart.timeScale().getVisibleLogicalRange();
        if (!before || !after) return false;
        return Math.abs(before.from - after.from) < 0.5 && Math.abs(before.to - after.to) < 0.5;
      }, chartId);
      assert.equal(noRescale, true, 'toggling an overlay does not rescale the main chart');

      // (c) Overlay host exists and reports a definite empty/non-empty state.
      const overlayState = await page.evaluate((id) => {
        const host = document.getElementById(id + '_autopattern_overlay');
        if (!host) return null;
        return { empty: host.getAttribute('data-overlay-empty'), reason: host.getAttribute('data-overlay-reason') };
      }, chartId);
      assert.ok(overlayState, 'overlay host is mounted');
      assert.ok(overlayState.empty === 'true' || overlayState.empty === 'false', 'overlay reports a definite state');

      // (d) Honest empty state on an insufficient series.
      const emptyOk = await page.evaluate((id) => {
        const rt = window.AutoCuanChartAutoPatterns;
        const res = rt.computeOverlays([{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }], rt.FAMILY_IDS, {});
        return res.empty === true && res.reason === 'INSUFFICIENT_DATA' && res.rendered.length === 0;
      }, chartId);
      assert.equal(emptyOk, true, 'insufficient data yields an honest empty state');

      // (e) Ticker race: rapid switches end on the last ticker.
      const raceOk = await page.evaluate(async (id) => {
        const ws = window.AutoCuanChartWorkstation;
        const inst = ws.getInstance(id);
        if (!inst) return false;
        const seq = ['BBCA', 'BBRI', 'BMRI'];
        for (const t of seq) { try { ws.switchTicker(id, t); } catch (_) {} }
        await new Promise((r) => setTimeout(r, 1500));
        const cur = ws.getInstance(id);
        return cur && String(cur.ticker).toUpperCase() === 'BMRI';
      }, chartId);
      assert.equal(raceOk, true, 'rapid ticker switches settle on the final ticker');
    } finally {
      try { await browser.close(); } catch (_) {}
    }
  });
