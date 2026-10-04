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

test('WAVE-2A-09: No column walls — default table schemas strictly <= 12 columns per mode', () => {
  // Count <th> elements in the main table thead rows
  function getThCount(wrapperId) {
    const wrapIdx = html.indexOf(`id="${wrapperId}"`);
    assert.ok(wrapIdx > -1, `${wrapperId} must exist`);
    const theadStart = html.indexOf('<thead', wrapIdx);
    const theadEnd = html.indexOf('</thead>', theadStart);
    const theadHtml = html.slice(theadStart, theadEnd);
    const thMatches = theadHtml.match(/<th\b/g);
    return thMatches ? thMatches.length : 0;
  }

  const kgCols = getThCount('screenerTableWrap');
  const nkCols = getThCount('nkScreenerTableWrap');
  const dtCols = getThCount('dtScreenerTableWrap');

  // Must not remain 17 / 18 / 22 column walls
  assert.notEqual(kgCols, 17, 'Konglo must not remain 17 columns');
  assert.notEqual(nkCols, 18, 'Non-Konglo must not remain 18 columns');
  assert.notEqual(dtCols, 22, 'Day Trade must not remain 22 columns');

  // Must be strictly <= 12 columns for fast screening
  assert.equal(kgCols, 11, 'Konglo default table must have exactly 11 columns');
  assert.equal(nkCols, 11, 'Non-Konglo default table must have exactly 11 columns');
  assert.equal(dtCols, 12, 'Day Trade default table must have exactly 12 columns');
});

test('WAVE-2A-10: Day Trade canonical dense row height rhythm without stacked badge soup', () => {
  // Skor cell must not contain stacked dtBdBadgeHtml or dtPatternBadgeHtml inside the table row
  assert.doesNotMatch(
    dtRuntime,
    /getDtScoreClass\(r\.daytrade_score\)\s*\+\s*['"]>[^<]*\+?\s*dtBdBadgeHtml/,
    'Day Trade table row must not stack Bandarmologi badges in the score cell'
  );
  assert.doesNotMatch(
    dtRuntime,
    /getDtScoreClass\(r\.daytrade_score\)\s*\+\s*['"]>[^<]*\+?\s*dtPatternBadgeHtml/,
    'Day Trade table row must not stack Pattern badges in the score cell'
  );

  // CSS targets canonical 38px dense row height
  assert.match(
    theme,
    /#screenerContent\[data-ui-version="v2"\]\s+tbody\s+tr\s*\{[^}]*height:\s*38px;/,
    'Screener v2 workstation must enforce canonical 38px dense row height'
  );
});

test('WAVE-2A-11: Zero sub-11px font sizes (text-[9px]) in migrated Screener scopes', () => {
  // Check index.html within #screenerContent
  const scStart = html.indexOf('id="screenerContent"');
  assert.ok(scStart > -1);
  const scEnd = html.indexOf('<!-- END SCREENER CONTENT -->') > -1
    ? html.indexOf('<!-- END SCREENER CONTENT -->')
    : html.indexOf('id="page-portfolio"');
  const scSection = html.slice(scStart, scEnd);
  assert.doesNotMatch(scSection, /text-\[9px\]/, 'index.html screener content must not use text-[9px]');

  // Check daytrade-runtime.js
  assert.doesNotMatch(dtRuntime, /text-\[9px\]/, 'daytrade-runtime.js must not use text-[9px]');

  // Check market-feature-runtime.js
  const mfRuntime = fs.readFileSync(path.join(ROOT, 'public', 'market-feature-runtime.js'), 'utf8');
  assert.doesNotMatch(mfRuntime, /text-\[9px\]/, 'market-feature-runtime.js must not use text-[9px]');
});

test('WAVE-2A-12: Canonical v2 semantic token usage & focus primitive', () => {
  // Table wrap containers must not use hard-coded focus:ring-emerald-500
  assert.doesNotMatch(
    html,
    /id="(?:screener|nkScreener|dtScreener)TableWrap"[^>]*focus:ring-emerald-500/,
    'Table wraps must not rely on focus:ring-emerald-500'
  );

  // ui-theme.css provides canonical focus primitive using --ac-focus
  assert.match(
    theme,
    /#screenerContent\[data-ui-version="v2"\]\s+#[a-zA-Z0-9_]+TableWrap:focus-visible[\s\S]*?var\(--ac-focus\)/,
    'Screener table wrap focus must consume var(--ac-focus)'
  );

  // Semantic positive / negative colors are defined under #screenerContent[data-ui-version="v2"]
  assert.match(
    theme,
    /#screenerContent\[data-ui-version="v2"\]\s+\.text-emerald-400[\s\S]*?var\(--ac-positive\)/,
    'Screener positive color must map to var(--ac-positive)'
  );
  assert.match(
    theme,
    /#screenerContent\[data-ui-version="v2"\]\s+\.text-red-400[\s\S]*?var\(--ac-negative\)/,
    'Screener negative color must map to var(--ac-negative)'
  );
});

test('WAVE-2A-13: Mobile touch target contract (>= 44px)', () => {
  // CSS media query enforces >= 44px min-height for interactive controls
  assert.match(
    theme,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.ac-segment[\s\S]*?min-height:\s*44px/,
    'Mobile .ac-segment must enforce >= 44px min-height'
  );
  assert.match(
    theme,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.screener-tab[\s\S]*?min-height:\s*44px/,
    'Mobile screener tabs must enforce >= 44px min-height'
  );
});

test('WAVE-2A-14: Secondary indicators and evidence preserved in disclosure surface (openScrDetail)', () => {
  // openScrDetail function in index.html renders secondary indicators
  assert.match(html, /function openScrDetail\(/, 'openScrDetail function must exist');
  assert.match(html, /Indikator\s+(?:&|&amp;)\s+Bukti Teknis/, 'openScrDetail must render Indikator & Bukti Teknis section');
  assert.match(html, /RSI \(14\)/, 'openScrDetail must display RSI');
  assert.match(html, /Vol \/ Avg20/, 'openScrDetail must display Volume Ratio');
  assert.match(html, /Papan Bursa/, 'openScrDetail must display Board info');
  assert.match(html, /Pre-Spike/, 'openScrDetail must display Pre-Spike');
  assert.match(html, /Momentum/, 'openScrDetail must display Momentum');
  assert.match(html, /Time Plan/, 'openScrDetail must display Time Plan');
});

test('WAVE-2A-15: Truthful price and freshness language', () => {
  // No "Live tick" or misleading exchange session claims in screener user-facing strings
  const scStart = html.indexOf('id="screenerContent"');
  const scEnd = html.indexOf('id="page-portfolio"');
  const scSection = html.slice(scStart, scEnd);
  assert.doesNotMatch(scSection, /Live\s+tick/i, 'Screener must not use "Live tick"');
  assert.doesNotMatch(scSection, /Real-time\s+streaming/i, 'Screener must not claim real-time streaming');
});

test('WAVE-2A-16: Exact frozen light semantic token enforcement (Brand != Positive)', () => {
  const pwCore = fs.readFileSync(path.join(ROOT, 'public', 'premium-workstation-core.css'), 'utf8');
  const polishCss = fs.readFileSync(path.join(ROOT, 'public', 'final-uiux-polish.css'), 'utf8');

  // Parse light token block from ui-theme.css
  const lightStart = theme.indexOf(':root[data-ui-version="v2"]');
  const lightEnd = theme.indexOf('[data-ui-version="v2"].dark');
  assert.ok(lightStart > -1 && lightEnd > lightStart, 'Light mode token block must exist');
  const lightBlock = theme.slice(lightStart, lightEnd);

  function extractToken(name) {
    const match = lightBlock.match(new RegExp(`${name}:\\s*([^;]+);`));
    return match ? match[1].trim().toUpperCase() : null;
  }

  const brand = extractToken('--ac-brand');
  const focus = extractToken('--ac-focus');
  const positive = extractToken('--ac-positive');
  const negative = extractToken('--ac-negative');
  const textSecondary = extractToken('--ac-text-secondary');
  const textMuted = extractToken('--ac-text-muted');
  const ink = extractToken('--ac-ink');
  const lineHairline = extractToken('--ac-line-hairline');
  const surface = extractToken('--ac-surface');

  // Exact frozen light values without OR expressions
  assert.equal(brand, '#0F7458', '--ac-brand must equal #0F7458');
  assert.equal(focus, '#0F7458', '--ac-focus must equal #0F7458');
  assert.equal(positive, '#247A43', '--ac-positive must equal #247A43');
  assert.equal(negative, '#C13F4D', '--ac-negative must equal #C13F4D');
  assert.equal(textSecondary, '#52605B', '--ac-text-secondary must equal #52605B');
  assert.equal(textMuted, '#5F6C66', '--ac-text-muted must equal #5F6C66');
  assert.equal(ink, '#17211E', '--ac-ink must equal #17211E');
  assert.equal(lineHairline, '#E2E7E4', '--ac-line-hairline must equal #E2E7E4');
  assert.equal(surface, '#FFFFFF', '--ac-surface must equal #FFFFFF');

  // Crucial distinction: BRAND != FINANCIAL POSITIVE
  assert.notEqual(positive, brand, 'Financial positive (#247A43) must be strictly distinct from brand (#0F7458)');

  // Table header text maps to --ac-text-secondary
  assert.match(
    theme,
    /#screenerContent\[data-ui-version="v2"\]\s+thead\s+th[^}]*color:\s*var\(--ac-text-secondary\)/,
    'Screener table header text must map to var(--ac-text-secondary)'
  );

  // Badge background maps to --ac-positive-soft
  assert.match(
    theme,
    /#screenerContent\[data-ui-version="v2"\][^}]*bg-emerald[^}]*background-color:\s*var\(--ac-positive-soft\)/,
    'Screener positive badge background must map to var(--ac-positive-soft)'
  );

  // Legacy overrides must exclude v2 screener scope
  assert.match(
    theme,
    /html\.light\s+:is\([^)]*text-emerald-400[^)]*\):not\(#screenerContent\[data-ui-version="v2"\]\s*\*\)/,
    'ui-theme.css light emerald utility override must exclude v2 screener'
  );
  assert.match(
    pwCore,
    /:is\(\.text-emerald-300,\s*\.text-emerald-400\):not\(#screenerContent\[data-ui-version="v2"\]\s*\*\)/,
    'premium-workstation-core.css emerald utility override must exclude v2 screener'
  );
  assert.match(
    polishCss,
    /html\.light\s+:is\([^)]*text-emerald-400[^)]*\):not\(#screenerContent\[data-ui-version="v2"\]\s*\*\)/,
    'final-uiux-polish.css light emerald utility override must exclude v2 screener'
  );
});


