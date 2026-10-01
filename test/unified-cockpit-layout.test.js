'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rootDir = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
const cockpitCss = fs.readFileSync(path.join(rootDir, 'public', 'unified-cockpit.css'), 'utf8');
const cockpitJs = fs.readFileSync(path.join(rootDir, 'public', 'unified-cockpit-runtime.js'), 'utf8');
const stockAiJs = fs.readFileSync(path.join(rootDir, 'public', 'stock-analysis-ai.js'), 'utf8');
const chartAnalysisJs = fs.readFileSync(path.join(rootDir, 'public', 'chart-analysis-runtime.js'), 'utf8');

test('Unified Cockpit: HTML structure contains 2-column cockpit with all required DOM elements', () => {
  // Shell and Grid
  assert.ok(indexHtml.includes('id="page-analisis"'), '#page-analisis exists');
  assert.ok(indexHtml.includes('class="unified-top-bar'), '.unified-top-bar exists in top bar');
  assert.ok(indexHtml.includes('class="unified-cockpit-grid"'), '.unified-cockpit-grid exists');
  assert.ok(indexHtml.includes('class="unified-primary-col"'), '.unified-primary-col exists');
  assert.ok(indexHtml.includes('class="unified-chat-col"'), '.unified-chat-col exists');

  // Top Bar controls
  assert.ok(indexHtml.includes('id="analisisInput"'), '#analisisInput preserved');
  assert.ok(indexHtml.includes('id="unifiedActiveTickerBadge"'), '#unifiedActiveTickerBadge exists');
  assert.ok(indexHtml.includes('UnifiedCockpit.handleUnifiedAnalisisSubmit()'), 'Submit handler hooked up');
  assert.ok(indexHtml.includes('UnifiedCockpit.handleUnifiedChartAiSubmit()'), 'AI Chart button in top bar hooked up');

  // Primary Column (Chart + Subtabs + Results + Ranking)
  assert.ok(indexHtml.includes('id="unifiedChartContainer"'), '#unifiedChartContainer exists');
  assert.ok(indexHtml.includes('id="tabAnalisisText"'), '#tabAnalisisText subtab button exists');
  assert.ok(indexHtml.includes('id="tabAnalisisVision"'), '#tabAnalisisVision subtab button exists');
  assert.ok(indexHtml.includes('id="panelAnalisisText"'), '#panelAnalisisText panel exists');
  assert.ok(indexHtml.includes('id="panelAnalisisVision"'), '#panelAnalisisVision panel exists');
  assert.ok(indexHtml.includes('id="analisisResult"'), '#analisisResult preserved for text analysis format');
  assert.ok(indexHtml.includes('id="unifiedAiChartResultWrap"'), '#unifiedAiChartResultWrap exists for 5-section AI vision format');
  assert.ok(indexHtml.includes('id="rankingSearchInput"'), '#rankingSearchInput preserved');
  assert.ok(indexHtml.includes('id="rankingTableWrap"'), '#rankingTableWrap preserved');

  // Companion Column (Chat + Composer)
  assert.ok(indexHtml.includes('id="chatActiveTickerTag"'), '#chatActiveTickerTag exists');
  assert.ok(indexHtml.includes('id="unifiedChatMessages"'), '#unifiedChatMessages exists');
  assert.ok(indexHtml.includes('id="analisisFollowUp"'), '#analisisFollowUp composer wrapper preserved');
  assert.ok(indexHtml.includes('id="analysisChatInput"'), '#analysisChatInput preserved');
  assert.ok(indexHtml.includes('id="analysisFileInput"'), '#analysisFileInput preserved');
  assert.ok(indexHtml.includes('id="analysisUploadBtn"'), '#analysisUploadBtn preserved');
  assert.ok(indexHtml.includes('id="analysisSendBtn"'), '#analysisSendBtn preserved');

  // Standalone Chart Page Preservation
  assert.ok(indexHtml.includes('id="page-chart"'), '#page-chart preserved for plain chart viewing');
  assert.ok(indexHtml.includes('id="chartSection"'), '#chartSection preserved on chart page');
  assert.ok(indexHtml.includes('id="chartTickerInput"'), '#chartTickerInput preserved');
});

test('Unified Cockpit: CSS implements responsive 2-column desktop and stacked mobile layout', () => {
  // Grid layout rules
  assert.match(cockpitCss, /\.unified-cockpit-grid\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
  assert.match(cockpitCss, /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*\.unified-cockpit-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1\.45fr\)\s*minmax\(0,\s*1fr\)/);

  // Column safety (min-width: 0 prevents grid blowout)
  assert.match(cockpitCss, /\.unified-primary-col\s*\{[^}]*min-width:\s*0/);
  assert.match(cockpitCss, /\.unified-chat-col\s*\{[^}]*min-width:\s*0/);

  // Chat container scrollability
  assert.match(cockpitCss, /\.unified-chat-messages\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(cockpitCss, /\.unified-chat-messages\s*\{[^}]*overscroll-behavior-y:\s*auto/);

  // Subtab buttons active styling
  assert.match(cockpitCss, /\.unified-subtab-btn\.active/);
  assert.match(cockpitCss, /\.unified-subtab-btn\.vision-tab\.active/);
});

test('Unified Cockpit Runtime: Exposes complete UnifiedCockpit API on global scope', () => {
  const sandbox = {
    window: {},
    document: {
      addEventListener: () => {},
      readyState: 'complete',
      getElementById: () => null
    }
  };
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(cockpitJs, sandbox);

  const api = sandbox.window.UnifiedCockpit;
  assert.ok(api, 'UnifiedCockpit object exported');
  assert.equal(typeof api.getActiveTicker, 'function');
  assert.equal(typeof api.syncActiveTicker, 'function');
  assert.equal(typeof api.switchAnalysisSubTab, 'function');
  assert.equal(typeof api.loadUnifiedChart, 'function');
  assert.equal(typeof api.handleUnifiedAnalisisSubmit, 'function');
  assert.equal(typeof api.handleUnifiedChartAiSubmit, 'function');
  assert.equal(typeof api.sendQuickPrompt, 'function');
  assert.equal(typeof api.clearAnalysisChatHistory, 'function');
  assert.equal(typeof api.openFullscreen, 'function');
});

test('Unified Cockpit Runtime: switchAnalysisSubTab toggles active states and panel visibility', () => {
  const elements = {
    tabAnalisisText: { classList: new Set(['active']) },
    tabAnalisisVision: { classList: new Set() },
    panelAnalisisText: { style: { display: 'block' } },
    panelAnalisisVision: { style: { display: 'none' } }
  };

  const sandbox = {
    window: {},
    document: {
      addEventListener: () => {},
      readyState: 'complete',
      getElementById: (id) => {
        const el = elements[id];
        if (!el) return null;
        return {
          classList: {
            add: (cls) => el.classList.add(cls),
            remove: (cls) => el.classList.delete(cls),
            contains: (cls) => el.classList.has(cls)
          },
          style: el.style
        };
      }
    }
  };
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(cockpitJs, sandbox);

  const api = sandbox.window.UnifiedCockpit;

  // Switch to vision
  api.switchAnalysisSubTab('vision');
  assert.equal(elements.tabAnalisisText.classList.has('active'), false);
  assert.equal(elements.tabAnalisisVision.classList.has('active'), true);
  assert.equal(elements.panelAnalisisText.style.display, 'none');
  assert.equal(elements.panelAnalisisVision.style.display, 'block');

  // Switch back to text
  api.switchAnalysisSubTab('text');
  assert.equal(elements.tabAnalisisText.classList.has('active'), true);
  assert.equal(elements.tabAnalisisVision.classList.has('active'), false);
  assert.equal(elements.panelAnalisisText.style.display, 'block');
  assert.equal(elements.panelAnalisisVision.style.display, 'none');
});

test('Unified Cockpit Runtime: syncActiveTicker updates input elements, badges, and follow-up composer', () => {
  const elements = {
    analisisInput: { value: '' },
    chartTickerInput: { value: '' },
    unifiedActiveTickerBadge: { textContent: '' },
    chatActiveTickerTag: { textContent: '' },
    analisisFollowUp: { classList: new Set(['hidden']) }
  };

  const sandbox = {
    window: {},
    document: {
      addEventListener: () => {},
      readyState: 'complete',
      getElementById: (id) => {
        const el = elements[id];
        if (!el) return null;
        return {
          set value(v) { el.value = v; },
          get value() { return el.value; },
          set textContent(v) { el.textContent = v; },
          get textContent() { return el.textContent; },
          classList: {
            remove: (cls) => el.classList.delete(cls),
            contains: (cls) => el.classList.has(cls)
          }
        };
      }
    }
  };
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(cockpitJs, sandbox);

  const api = sandbox.window.UnifiedCockpit;

  api.syncActiveTicker('bbca', { loadChart: false });

  assert.equal(sandbox.window.activeTicker, 'BBCA');
  assert.equal(elements.analisisInput.value, 'BBCA');
  assert.equal(elements.chartTickerInput.value, 'BBCA');
  assert.equal(elements.unifiedActiveTickerBadge.textContent, 'BBCA');
  assert.equal(elements.chatActiveTickerTag.textContent, 'BBCA');
  assert.equal(elements.analisisFollowUp.classList.has('hidden'), false, 'Follow-up composer unhidden');
});

test('Integration: stock-analysis-ai routes follow-up chat bubbles to unifiedChatMessages', () => {
  assert.ok(stockAiJs.includes("function getChatRoot()"), 'stock-analysis-ai defines getChatRoot');
  assert.ok(stockAiJs.includes("byId('unifiedChatMessages') || byId('analisisResult')"), 'Prioritizes unifiedChatMessages with fallback to analisisResult');
  assert.ok(stockAiJs.includes("window.UnifiedCockpit.getActiveTicker()"), 'Reads active ticker from UnifiedCockpit when present');
  assert.ok(stockAiJs.includes("byId('unifiedAiChartResultWrap') || byId('aiChartAnalysisResultWrap')"), 'Snapshot reads AI vision results when available');
});

test('Integration: chart-analysis-runtime targets unifiedAiChartResultWrap on analysis page and switches subtab', () => {
  assert.ok(chartAnalysisJs.includes("unifiedAiChartResultWrap"), 'Targets unifiedAiChartResultWrap');
  assert.ok(chartAnalysisJs.includes("UnifiedCockpit.switchAnalysisSubTab('vision')"), 'Switches to vision subtab automatically on analysis page');
  assert.ok(chartAnalysisJs.includes("aiChartAnalysisResultWrap"), 'Preserves aiChartAnalysisResultWrap fallback for chart page');
});
