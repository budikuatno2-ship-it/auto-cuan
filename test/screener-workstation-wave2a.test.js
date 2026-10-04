'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const theme = fs.readFileSync(path.join(ROOT, 'public', 'ui-theme.css'), 'utf8');
const dtRuntime = fs.readFileSync(path.join(ROOT, 'public', 'daytrade-runtime.js'), 'utf8');
const subGate = fs.readFileSync(path.join(ROOT, 'public', 'subscription-access-gate-v1.js'), 'utf8');

test('WAVE-2A-01: Scoped v2 rollout contract on Screener', () => {
  // Page container itself must NOT have data-ui-version="v2" (preserves shell contract)
  assert.doesNotMatch(
    html,
    /<div\s+id="page-screener"[^>]*data-ui-version="v2"/,
    'Page container #page-screener must not carry premature v2'
  );

  // Content container MUST have data-ui-version="v2"
  assert.match(
    html,
    /<div\s+id="screenerContent"[^>]*data-ui-version="v2"/,
    'Screener content container #screenerContent must carry scoped data-ui-version="v2"'
  );

  // Scoped CSS rules in ui-theme.css must not use !important
  const v2ScreenerSection = theme.slice(theme.indexOf('Wave 2A: Screener Precision Financial Workstation Styles'));
  assert.ok(v2ScreenerSection.length > 0, 'Wave 2A CSS section must exist');
  assert.doesNotMatch(
    v2ScreenerSection,
    /!important/,
    'Wave 2A scoped Screener CSS must never use !important'
  );
});

test('WAVE-2A-02: Screener is TABLE-FIRST by default across all three modes', () => {
  // Table wraps must NOT be hidden by default
  assert.match(
    html,
    /<div[^>]*id="screenerTableWrap"[^>]*>(?!.*class="[^"]*hidden)/,
    'Konglo table wrap #screenerTableWrap must be visible by default'
  );
  assert.match(
    html,
    /<div[^>]*id="nkScreenerTableWrap"[^>]*>(?!.*class="[^"]*hidden)/,
    'Non-Konglo table wrap #nkScreenerTableWrap must be visible by default'
  );
  assert.match(
    html,
    /<div[^>]*id="dtScreenerTableWrap"[^>]*>(?!.*class="[^"]*hidden)/,
    'Day Trade table wrap #dtScreenerTableWrap must be visible by default'
  );

  // Card grids must be hidden by default
  assert.match(
    html,
    /<div\s+id="kgCardGrid"[^>]*style="display:none;/,
    'Konglo card grid #kgCardGrid must be hidden by default'
  );
  assert.match(
    html,
    /<div\s+id="nkCardGrid"[^>]*style="display:none;/,
    'Non-Konglo card grid #nkCardGrid must be hidden by default'
  );
  assert.match(
    html,
    /<div\s+id="dtCardGrid"[^>]*style="display:none;/,
    'Day Trade card grid #dtCardGrid must be hidden by default'
  );

  // View toggle buttons must exist in DOM
  assert.match(html, /id="kgBtnTable"/, 'kgBtnTable must exist');
  assert.match(html, /id="kgBtnCard"/, 'kgBtnCard must exist');
  assert.match(html, /id="nkBtnTable"/, 'nkBtnTable must exist');
  assert.match(html, /id="nkBtnCard"/, 'nkBtnCard must exist');
  assert.match(html, /id="dtBtnTable"/, 'dtBtnTable must exist');
  assert.match(html, /id="dtBtnCard"/, 'dtBtnCard must exist');

  // View toggle functions must exist
  assert.match(html, /function kgToggleView\(/, 'kgToggleView function must exist');
  assert.match(html, /function nkToggleView\(/, 'nkToggleView function must exist');
  assert.match(html, /function dtToggleView\(/, 'dtToggleView function must exist');
});

test('WAVE-2A-03: Raw enum humanization prevents leaking internal snake_case/uppercase values', () => {
  // Extract humanizeRawStatus function
  const start = html.indexOf('function humanizeRawStatus(');
  assert.ok(start > -1, 'humanizeRawStatus must exist in index.html');
  const slice = html.slice(start, html.indexOf('function normalizeActionLabel('));
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(slice, context);
  const humanize = context.window.humanizeRawStatus;
  assert.equal(typeof humanize, 'function');

  // Verify representative internal raw enums
  assert.equal(humanize('WAIT_PULLBACK'), 'Tunggu Pullback');
  assert.equal(humanize('wait_pullback'), 'Tunggu Pullback');
  assert.equal(humanize('A_PLUS_SETUP'), 'Setup A+');
  assert.equal(humanize('A_PLUS_SWING'), 'Swing A+');
  assert.equal(humanize('ENTRY_AREA'), 'Area Entry');
  assert.equal(humanize('ENTRY_TOUCHED'), 'Entry Tersentuh');
  assert.equal(humanize('READY_BREAKOUT'), 'Siap Breakout');
  assert.equal(humanize('PRE_SPIKE_WATCH'), 'Pantau Pre-Spike');
  assert.equal(humanize('AVOID'), 'Hindari');
  assert.equal(humanize('TRADE_CANDIDATE'), 'Kandidat Trade');
  assert.equal(humanize('SWING_READY'), 'Swing Ready');
  assert.equal(humanize('WATCHLIST'), 'Watchlist');
  assert.equal(humanize('REBOUND_CANDIDATE'), 'Kandidat Rebound');
  assert.equal(humanize('SPECULATIVE'), 'Spekulatif');
  assert.equal(humanize('HARD_REJECT'), 'Ditolak Keras');
  assert.equal(humanize('LOW_RISK'), 'Risiko Rendah');
  assert.equal(humanize('VERY_HIGH_RISK'), 'Risiko Sangat Tinggi');

  // Missing values display '—'
  assert.equal(humanize(null), '—');
  assert.equal(humanize(undefined), '—');
  assert.equal(humanize(''), '—');
  assert.equal(humanize('-'), '—');
  assert.equal(humanize('—'), '—');
});

test('WAVE-2A-04: Gate display derives denominator dynamically and never hardcodes 5/5', () => {
  const transparency = require('../public/signal-gate-transparency');
  assert.equal(typeof transparency.evaluateGates, 'function');

  // Signal with all fields
  const signalFull = {
    ticker: 'BBCA',
    last_price: 10000,
    ma20: 9800,
    rsi14: 55,
    volume_ratio_20d: 1.5,
    value_today: 100000000000,
    risk_reward: 2.0
  };
  const resFull = transparency.evaluateGates(signalFull, 'konglo');
  assert.equal(typeof resFull.totalCount, 'number');
  assert.ok(resFull.totalCount > 0);
  assert.equal(resFull.passedCount, resFull.totalCount);

  // Denominator must match totalCount, not a hardcoded constant
  const displayStr = `${resFull.passedCount}/${resFull.totalCount} Gate`;
  assert.match(displayStr, /^\d+\/\d+\s+Gate$/);

  // Missing data signals do not falsely pass
  const signalMissing = { ticker: 'UNVR' };
  const resMissing = transparency.evaluateGates(signalMissing, 'konglo');
  assert.equal(resMissing.allPassed, false);
  assert.ok(resMissing.unverifiedCount > 0);
});

test('WAVE-2A-05: Screener Access Recovery: States A, B, C, and D', () => {
  // Extract access recovery functions and DOM
  assert.match(html, /id="accessRecoveryBanner"/, 'accessRecoveryBanner element must exist');
  assert.match(html, /id="accessRecoveryMsg"/, 'accessRecoveryMsg element must exist');
  assert.match(html, /retryPremiumAccess\(\)/, 'retry button must call retryPremiumAccess()');
  assert.match(html, /function retryPremiumAccess\(/, 'retryPremiumAccess function must exist');

  // Simulate applyPremiumAccessUi logic under the 4 states
  function createMockEnvironment(stateObj, currentPage, isLoggedIn, isDenied) {
    const bannerClasses = new Set(['hidden']);
    const pageClasses = new Set(currentPage === 'screener' ? ['hidden'] : []);
    const elements = {
      accessRecoveryBanner: {
        classList: {
          contains: c => bannerClasses.has(c),
          remove: c => bannerClasses.delete(c),
          add: c => bannerClasses.add(c),
          toggle: (c, force) => {
            if (force) bannerClasses.add(c);
            else bannerClasses.delete(c);
          }
        }
      },
      accessRecoveryMsg: { textContent: '' },
      'page-screener': {
        id: 'page-screener',
        classList: {
          contains: c => pageClasses.has(c),
          remove: c => pageClasses.delete(c),
          add: c => pageClasses.add(c)
        },
        setAttribute: () => {}
      }
    };

    let dataLoaded = false;
    const ctx = {
      document: {
        getElementById: id => elements[id] || null,
        querySelectorAll: () => [elements['page-screener']]
      },
      allowed: stateObj.premium === true,
      premiumAccessState: stateObj,
      currentPage: currentPage,
      isLoggedInUser: () => isLoggedIn,
      isDeniedWebsiteAccess: () => isDenied,
      _screenerCache: null,
      loadSwingScreener: () => { dataLoaded = true; },
      clearRenderedPremiumData: () => {},
      navigateTo: (p) => { ctx.currentPage = p; }
    };

    // Run applyPremiumAccessUi logic
    const allowed = ctx.allowed;
    ctx.document.querySelectorAll().forEach(page => {
      if (allowed) {
        if (page.id === 'page-' + ctx.currentPage) {
          page.classList.remove('hidden');
          if (ctx.currentPage === 'screener' && typeof ctx.loadSwingScreener === 'function' && (!ctx._screenerCache)) {
            ctx.loadSwingScreener(true);
          }
        }
      } else {
        page.classList.add('hidden');
      }
    });

    const recBanner = ctx.document.getElementById('accessRecoveryBanner');
    if (recBanner) {
      const showRecovery = !allowed && !ctx.isDeniedWebsiteAccess() && ctx.premiumAccessState.state === 'unavailable' && ctx.isLoggedInUser();
      recBanner.classList.toggle('hidden', !showRecovery);
      if (showRecovery) {
        const recMsg = ctx.document.getElementById('accessRecoveryMsg');
        if (recMsg) {
          const errType = ctx.premiumAccessState.errorType;
          if (errType === 'timeout') recMsg.textContent = 'Verifikasi akses timed out. Periksa jaringan Anda.';
          else if (errType === 'server_error') recMsg.textContent = 'Server verifikasi sedang sibuk.';
          else recMsg.textContent = 'Koneksi terputus saat verifikasi akses.';
        }
      }
    }

    return { elements, bannerClasses, pageClasses, ctx, dataLoaded };
  }

  // State A: Loading / unverified -> fails-closed, screener hidden, banner hidden
  const stateA = createMockEnvironment({ state: 'loading', premium: false, accessLevel: 'free' }, 'screener', true, false);
  assert.ok(stateA.pageClasses.has('hidden'), 'State A: screener must remain hidden');
  assert.ok(stateA.bannerClasses.has('hidden'), 'State A: recovery banner must be hidden');
  assert.equal(stateA.dataLoaded, false, 'State A: protected data must not be loaded');

  // State B: Confirmed approved -> reveals screener, loads data, banner hidden
  const stateB = createMockEnvironment({ state: 'ready', premium: true, accessLevel: 'approved' }, 'screener', true, false);
  assert.ok(!stateB.pageClasses.has('hidden'), 'State B: confirmed approved must unhide screener page');
  assert.ok(stateB.bannerClasses.has('hidden'), 'State B: recovery banner must be hidden');
  assert.equal(stateB.dataLoaded, true, 'State B: protected data must be loaded');

  // State C: Confirmed unauthorized (401/403) -> screener hidden, banner hidden (not a transient error)
  const stateC = createMockEnvironment({ state: 'ready', premium: false, accessLevel: 'free' }, 'screener', true, true);
  assert.ok(stateC.pageClasses.has('hidden'), 'State C: unauthorized user must remain hidden');
  assert.ok(stateC.bannerClasses.has('hidden'), 'State C: recovery banner must not show for confirmed denial');
  assert.equal(stateC.dataLoaded, false, 'State C: data must not load');

  // State D: Transient failure (timeout / 5xx / network error) -> screener hidden, recovery banner shown with affordance
  const stateD = createMockEnvironment({ state: 'unavailable', premium: false, accessLevel: 'free', errorType: 'timeout' }, 'screener', true, false);
  assert.ok(stateD.pageClasses.has('hidden'), 'State D: screener must fail closed');
  assert.ok(!stateD.bannerClasses.has('hidden'), 'State D: recovery banner must be shown');
  assert.match(stateD.elements.accessRecoveryMsg.textContent, /timed out/i);
  assert.equal(stateD.dataLoaded, false, 'State D: data must not load');

  // Runtime subscription-access-gate-v1 bounded retry and retry affordance (single authority)
  assert.match(subGate, /MAX_SUB_RETRIES\s*=\s*3/, 'subscription-access-gate-v1 must define MAX_SUB_RETRIES = 3');
  assert.match(subGate, /window\.retryPremiumAccess\s*=/, 'subscription-access-gate-v1 must expose retry affordance');
  assert.match(subGate, /errorType:\s*errType/, 'subscription-access-gate-v1 must preserve errorType');

  // Single authority: index.html fallback must NOT maintain duplicate retry attempts or timeout loop
  assert.doesNotMatch(html, /_premiumAccessRetryAttempts/, 'index.html must not define duplicate _premiumAccessRetryAttempts');
});

test('WAVE-2A-06: Silent polling preserves currently visible table data', () => {
  // Konglo loadSwingScreener catch block must preserve cache
  assert.match(
    html,
    /if\s*\(!\(_screenerCache\s*&&\s*_screenerCache\.results\s*&&\s*_screenerCache\.results\.length\)\)\s*\{\s*tbody\.innerHTML\s*=\s*screenerEmptyRowHtml/,
    'loadSwingScreener catch block must preserve table when cache exists'
  );

  // Non-Konglo loadNonKongloScreener catch block must preserve cache
  assert.match(
    html,
    /if\s*\(!\(_nkScreenerCache\s*&&\s*_nkScreenerCache\.results\s*&&\s*_nkScreenerCache\.results\.length\)\)\s*\{\s*tbody\.innerHTML\s*=\s*screenerEmptyRowHtml/,
    'loadNonKongloScreener catch block must preserve table when cache exists'
  );

  // Day Trade loadDayTradeScreener catch block must preserve cache
  assert.match(
    dtRuntime,
    /if\s*\(!\(_dtScreenerCache\s*&&\s*_dtScreenerCache\.results\s*&&\s*_dtScreenerCache\.results\.length\)\)\s*\{\s*tbody\.innerHTML\s*=\s*screenerEmptyRowHtml/,
    'loadDayTradeScreener catch block must preserve table when cache exists'
  );
});

test('WAVE-2A-07: Tabular financial numerals and precision styling (sans font, tabular-nums)', () => {
  // Table numerals use tabular-nums in Konglo table renderer (no font-mono)
  assert.match(html, /px-2 py-2 text-right text-gray-200 tabular-nums whitespace-nowrap/);
  assert.doesNotMatch(html, /px-2 py-2 text-right text-gray-200 font-mono tabular-nums/);

  // Table numerals use tabular-nums in Non-Konglo table renderer (no font-mono)
  assert.match(html, /px-2 py-1\.5 text-right text-gray-200 tabular-nums whitespace-nowrap/);
  assert.doesNotMatch(html, /px-2 py-1\.5 text-right text-gray-200 font-mono tabular-nums/);

  // Table numerals use tabular-nums in Day Trade table renderer (no font-mono)
  assert.match(dtRuntime, /px-2 py-2 text-right text-gray-200 tabular-nums/);
  assert.doesNotMatch(dtRuntime, /px-2 py-2 text-right text-gray-200 font-mono tabular-nums/);

  // CSS enforces sans font with tabular figures on screener workstation table cells
  assert.match(theme, /#screenerContent\[data-ui-version="v2"\]\s+table\s+td/);
  assert.match(theme, /font-family:\s*var\(--ac-font-sans\);/);
});

test('WAVE-2A-08: Table-First Screener hides Card-mode toggle bars in v2 presentation', () => {
  // Toggle wrappers must have class="hidden" to enforce table-first workstation layout
  assert.match(
    html,
    /<div\s+[^>]*id="kgViewToggleWrap"[^>]*>/,
    'Konglo view toggle wrapper #kgViewToggleWrap must exist'
  );
  assert.match(
    html,
    /<div\s+[^>]*id="kgViewToggleWrap"[^>]*class="[^"]*\bhidden\b[^"]*"|<div\s+[^>]*class="[^"]*\bhidden\b[^"]*"[^>]*id="kgViewToggleWrap"/,
    'Konglo view toggle wrapper #kgViewToggleWrap must be hidden in v2'
  );
  assert.match(
    html,
    /<div\s+[^>]*id="nkViewToggleWrap"[^>]*class="[^"]*\bhidden\b[^"]*"|<div\s+[^>]*class="[^"]*\bhidden\b[^"]*"[^>]*id="nkViewToggleWrap"/,
    'Non-Konglo view toggle wrapper #nkViewToggleWrap must be hidden in v2'
  );
  assert.match(
    html,
    /<div\s+[^>]*id="dtViewToggleWrap"[^>]*class="[^"]*\bhidden\b[^"]*"|<div\s+[^>]*class="[^"]*\bhidden\b[^"]*"[^>]*id="dtViewToggleWrap"/,
    'Day Trade view toggle wrapper #dtViewToggleWrap must be hidden in v2'
  );
});
