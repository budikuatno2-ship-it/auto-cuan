'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rootDir = path.join(__dirname, '..');
const standaloneHtml = fs.readFileSync(path.join(rootDir, 'public', 'analisis-saham.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
const runtimeJs = fs.readFileSync(path.join(rootDir, 'public', 'analisis-saham-runtime.js'), 'utf8');
const vercelConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'vercel.json'), 'utf8'));
const robotsTxt = fs.readFileSync(path.join(rootDir, 'public', 'robots.txt'), 'utf8');

test('Standalone Analisis Saham: HTML structure contains 2-column cockpit with all required DOM elements', () => {
  // Page shell & Header
  assert.ok(standaloneHtml.includes('id="page-analisis"'), '#page-analisis exists as main container');
  assert.ok(standaloneHtml.includes('href="/dashboard"'), 'Header provides link back to Dashboard');
  assert.ok(standaloneHtml.includes('openAiApiKeyModal()'), 'Header provides BYOK API Key button');
  assert.ok(standaloneHtml.includes('id="toastContainer"'), '#toastContainer exists for user feedback');

  // Top Bar controls
  assert.ok(standaloneHtml.includes('class="unified-top-bar'), '.unified-top-bar exists in top bar');
  assert.ok(standaloneHtml.includes('id="analisisInput"'), '#analisisInput preserved');
  assert.ok(standaloneHtml.includes('id="unifiedActiveTickerBadge"'), '#unifiedActiveTickerBadge exists');
  assert.ok(standaloneHtml.includes('UnifiedCockpit.handleUnifiedAnalisisSubmit()'), 'Submit handler hooked up');
  assert.ok(standaloneHtml.includes('UnifiedCockpit.handleUnifiedChartAiSubmit()'), 'AI Chart button in top bar hooked up');

  // Popular ticker chips
  ['IHSG', 'BBCA', 'BBRI', 'BMRI', 'TLKM', 'ASII'].forEach((ticker) => {
    assert.ok(standaloneHtml.includes(`'${ticker}'`), `Popular chip for ${ticker} exists`);
  });

  // Sub-Tab Strip and 3 Isolated Panels
  assert.ok(standaloneHtml.includes('class="analisis-tab-strip'), '.analisis-tab-strip navigation exists');
  assert.ok(standaloneHtml.includes('data-tab="analisis"'), 'Sub-tab for Analisis Saham exists');
  assert.ok(standaloneHtml.includes('data-tab="chart"'), 'Sub-tab for Chart exists');
  assert.ok(standaloneHtml.includes('data-tab="ranking"'), 'Sub-tab for Ranking Harian exists');
  assert.ok(standaloneHtml.includes('id="panel-tab-analisis"'), '#panel-tab-analisis panel exists');
  assert.ok(standaloneHtml.includes('id="panel-tab-chart"'), '#panel-tab-chart panel exists');
  assert.ok(standaloneHtml.includes('id="panel-tab-ranking"'), '#panel-tab-ranking panel exists');

  // Strict Tab Isolation Checks
  const panelAnalisisMatch = standaloneHtml.match(/<section[^>]+id="panel-tab-analisis"[^>]*>([\s\S]*?)<\/section>/i);
  assert.ok(panelAnalisisMatch, 'Found panel-tab-analisis section');
  assert.ok(panelAnalisisMatch[1].includes('id="analisisResult"'), 'Tab Analisis Saham contains text analysis result');
  assert.ok(!panelAnalisisMatch[1].includes('id="unifiedChartContainer"'), 'Tab Analisis Saham does NOT contain chart');

  const panelChartMatch = standaloneHtml.match(/<section[^>]+id="panel-tab-chart"[^>]*>([\s\S]*?)<\/section>/i);
  assert.ok(panelChartMatch, 'Found panel-tab-chart section');
  assert.ok(panelChartMatch[1].includes('id="unifiedChartContainer"'), 'Tab Chart contains candlestick chart');
  assert.ok(panelChartMatch[1].includes('id="unifiedAiChartResultWrap"'), 'Tab Chart contains AI Vision results');
  assert.ok(!panelChartMatch[1].includes('id="analisisResult"'), 'Tab Chart does NOT contain text analysis');

  const panelRankingMatch = standaloneHtml.match(/<section[^>]+id="panel-tab-ranking"[^>]*>([\s\S]*?)<\/section>/i);
  assert.ok(panelRankingMatch, 'Found panel-tab-ranking section');
  assert.ok(panelRankingMatch[1].includes('id="rankingPaywallGate"'), 'Tab Ranking contains paywall gate');
  assert.ok(panelRankingMatch[1].includes('id="rankingContentWrap"'), 'Tab Ranking contains ranking content wrap');
  assert.ok(panelRankingMatch[1].includes('id="rankingTableWrap"'), 'Tab Ranking contains ranking table wrap');

  // Primary & Subtab elements
  assert.ok(standaloneHtml.includes('class="unified-primary-col"'), '.unified-primary-col exists');
  assert.ok(standaloneHtml.includes('id="unifiedChartContainer"'), '#unifiedChartContainer exists');
  assert.ok(standaloneHtml.includes('id="tabAnalisisText"'), '#tabAnalisisText subtab button exists');
  assert.ok(standaloneHtml.includes('id="tabAnalisisVision"'), '#tabAnalisisVision subtab button exists');
  assert.ok(standaloneHtml.includes('id="panelAnalisisText"'), '#panelAnalisisText panel exists');
  assert.ok(standaloneHtml.includes('id="panelAnalisisVision"'), '#panelAnalisisVision panel exists');
  assert.ok(standaloneHtml.includes('id="analisisResult"'), '#analisisResult preserved for text analysis');
  assert.ok(standaloneHtml.includes('id="unifiedAiChartResultWrap"'), '#unifiedAiChartResultWrap exists for 5-section AI vision');
  assert.ok(standaloneHtml.includes('id="rankingCardOuterWrap"'), '#rankingCardOuterWrap exists');
  assert.ok(standaloneHtml.includes('id="rankingSearchInput"'), '#rankingSearchInput preserved');
  assert.ok(standaloneHtml.includes('id="rankingTableWrap"'), '#rankingTableWrap preserved');

  // Companion Column (Chat + Composer)
  assert.ok(standaloneHtml.includes('class="unified-chat-col"'), '.unified-chat-col exists');
  assert.ok(standaloneHtml.includes('id="chatActiveTickerTag"'), '#chatActiveTickerTag exists');
  assert.ok(standaloneHtml.includes('id="unifiedChatMessages"'), '#unifiedChatMessages exists');
  assert.ok(standaloneHtml.includes('id="analisisFollowUp"'), '#analisisFollowUp composer wrapper preserved');
  assert.ok(standaloneHtml.includes('id="analysisChatInput"'), '#analysisChatInput preserved');
  assert.ok(standaloneHtml.includes('id="analysisFileInput"'), '#analysisFileInput preserved');
  assert.ok(standaloneHtml.includes('id="analysisUploadBtn"'), '#analysisUploadBtn preserved');
  assert.ok(standaloneHtml.includes('id="analysisSendBtn"'), '#analysisSendBtn preserved');

  // Modals & BYOK
  assert.ok(standaloneHtml.includes('id="aiApiKeyModal"'), '#aiApiKeyModal exists');
  assert.ok(standaloneHtml.includes('id="aiApiKeyInput"'), '#aiApiKeyInput exists');
  assert.ok(standaloneHtml.includes('saveUserAiApiKey()'), 'Save API key button wired');

  // Scripts inclusion
  assert.ok(standaloneHtml.includes('/market-feature-runtime.js'), 'Loads market-feature-runtime.js');
  assert.ok(standaloneHtml.includes('/chart-analysis-runtime.js'), 'Loads chart-analysis-runtime.js');
  assert.ok(standaloneHtml.includes('/unified-cockpit-runtime.js'), 'Loads unified-cockpit-runtime.js');
  assert.ok(standaloneHtml.includes('/ai-chat-renderer.js'), 'Loads ai-chat-renderer.js');
  assert.ok(standaloneHtml.includes('/analisis-saham-runtime.js'), 'Loads analisis-saham-runtime.js');
  assert.ok(standaloneHtml.includes('/stock-analysis-ai.js'), 'Loads stock-analysis-ai.js');
});

test('Standalone Analisis Saham: Routing and caching config in vercel.json and robots.txt', () => {
  // Rewrite rule
  const rewrites = Array.isArray(vercelConfig.rewrites) ? vercelConfig.rewrites : [];
  const rewrite = rewrites.find(r => r.source === '/analisis-saham');
  assert.ok(rewrite, 'Rewrite for /analisis-saham exists');
  assert.equal(rewrite.destination, '/analisis-saham.html');

  // Header security and caching rules
  const headers = Array.isArray(vercelConfig.headers) ? vercelConfig.headers : [];
  const routeHeader = headers.find(h => h.source === '/analisis-saham' || h.source === '/(analisis-saham|analisis-saham\\.html)');
  assert.ok(routeHeader, 'Headers for /analisis-saham exist');
  const headerMap = {};
  routeHeader.headers.forEach(entry => { headerMap[entry.key.toLowerCase()] = entry.value; });
  assert.match(headerMap['cache-control'] || '', /no-store/);
  assert.match(headerMap['x-robots-tag'] || '', /noindex/);

  // Robots.txt
  assert.match(robotsTxt, /Disallow:\s*\/analisis-saham/);
});

test('Standalone Analisis Saham: Navigation in index.html directs to /analisis-saham and keeps Chart page separate', () => {
  // Navigation redirection
  assert.ok(indexHtml.includes("window.location.assign('/analisis-saham');"), "navigateTo('analisis') redirects to /analisis-saham");
  assert.ok(indexHtml.includes("window.location.assign('/analisis-saham?ticker=' + encodeURIComponent(ticker));"), 'quickAnalisis redirects to /analisis-saham?ticker=...');
  assert.ok(indexHtml.includes("window.location.assign('/analisis-saham?ticker=IHSG')"), 'IHSG dashboard tile links to /analisis-saham?ticker=IHSG');

  // Chart page isolation
  assert.ok(indexHtml.includes('id="page-chart"'), '#page-chart preserved for plain chart viewing');
  assert.ok(indexHtml.includes('id="chartSection"'), '#chartSection preserved on chart page');
  assert.ok(indexHtml.includes('id="chartTickerInput"'), '#chartTickerInput preserved');
  assert.ok(!indexHtml.includes("navigateTo('chart')\n        window.location.assign('/analisis-saham')"), 'Chart navigation is untouched');
});

test('Standalone Analisis Saham Runtime: Exposes formatters, ranking state, subtabs, paywall, and analysis handlers', () => {
  const elements = {};
  function mockEl(id) {
    if (!elements[id]) {
      elements[id] = {
        id,
        style: {},
        classList: {
          contains: () => false,
          add: () => {},
          remove: () => {},
          toggle: () => {}
        },
        setAttribute: () => {},
        innerHTML: '',
        textContent: ''
      };
    }
    return elements[id];
  }

  const sandbox = {
    window: {
      location: { pathname: '/analisis-saham', search: '' },
      history: { replaceState: () => {} },
      dispatchEvent: () => {}
    },
    document: {
      addEventListener: () => {},
      readyState: 'complete',
      getElementById: mockEl,
      querySelectorAll: () => []
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    setTimeout,
    clearTimeout
  };
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(runtimeJs, sandbox);

  const root = sandbox.window;
  assert.equal(typeof root.mktCtxFmtPrice, 'function');
  assert.equal(typeof root.mktCtxFmtPct, 'function');
  assert.equal(typeof root.mktCtxFmtRatio, 'function');
  assert.equal(typeof root.mktCtxFmtIDR, 'function');
  assert.equal(typeof root.runAnalisisFromDashboard, 'function');
  assert.equal(typeof root.quickAnalisis, 'function');
  assert.equal(typeof root.renderRankingTable, 'function');
  assert.equal(typeof root.ensureRankingTableLoaded, 'function');
  assert.equal(typeof root.showToast, 'function');
  assert.equal(typeof root.switchAnalisisTab, 'function');
  assert.equal(typeof root.isSubscribedUser, 'function');
  assert.equal(typeof root.updateRankingPaywallUi, 'function');
  assert.equal(typeof root.verifySubscriptionStatus, 'function');

  // Test formatters
  assert.equal(root.mktCtxFmtPrice(9850), 'Rp 9.850');
  assert.equal(root.mktCtxFmtPct(2.5), '+2.50%');
  assert.equal(root.mktCtxFmtPct(-1.25), '-1.25%');
  assert.equal(root.mktCtxFmtRatio(1.85), '1.85x');
  assert.match(root.mktCtxFmtIDR(2500000000), /\+2\.50 M/);

  // Test paywall check defaults for free user
  assert.equal(root.isSubscribedUser(), false);

  // Test paywall check for admin or premium
  sandbox.localStorage.getItem = (key) => key === 'autocuan_is_admin' ? 'true' : null;
  assert.equal(root.isSubscribedUser(), true);

  sandbox.localStorage.getItem = () => null;
  sandbox.window.premiumAccessState = { premium: true, accessLevel: 'premium' };
  assert.equal(root.isSubscribedUser(), true);

  // Test tab switching
  root.switchAnalisisTab('chart');
  assert.equal(elements['panel-tab-chart'].style.display, 'block');
  assert.equal(elements['panel-tab-analisis'].style.display, 'none');
  assert.equal(elements['panel-tab-ranking'].style.display, 'none');

  root.switchAnalisisTab('analisis');
  assert.equal(elements['panel-tab-analisis'].style.display, 'block');
  assert.equal(elements['panel-tab-chart'].style.display, 'none');
  assert.equal(elements['panel-tab-ranking'].style.display, 'none');
});

