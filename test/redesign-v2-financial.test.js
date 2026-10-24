const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createMockDom() {
  const elements = {};
  function makeEl(id) {
    return {
      id,
      innerHTML: '',
      textContent: '',
      style: {},
      attributes: {},
      children: [],
      classList: {
        add(c) { this._classes = this._classes || new Set(); this._classes.add(c); },
        remove(c) { if (this._classes) this._classes.delete(c); },
        contains(c) { return !!(this._classes && this._classes.has(c)); },
        toggle(c, v) { if (v) this.add(c); else this.remove(c); }
      },
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k]; }
    };
  }

  const elIds = [
    'panel-tab-financial', 'financialTickerInput', 'financialTickerMissMsg',
    'financialSnapshotSheet', 'financialTickerBadge', 'financialCompanyName',
    'financialSectorName', 'financialCoverageBadge', 'btnFinancialRefresh',
    'financialSnapshotBody', 'financialCategoryCompleteness', 'financialPbvVal',
    'financialPbvNote', 'financialBvpsVal', 'financialCapVal', 'financialCapNote',
    'financialSharesVal', 'financialSnapshotProv', 'financialLatestPeriodVal',
    'financialFreeFloatVal', 'financialImportedVal', 'financialSnapshotWarning',
    'financialWarningText', 'financialSnapshotEmpty', 'financialEmptyTitle',
    'financialStatementsSheet', 'financialStatementsSubtitle', 'financialCategoryTabs',
    'financialCategoryTabInd', 'finCat0', 'finCat1', 'finCat2', 'finCat3',
    'financialFreqTabs', 'financialFreqTabInd', 'finFreq0', 'finFreq1',
    'btnToggleEmptyRows', 'finEmptyRowsCount', 'btnToggleYoy', 'financialTableWrapper',
    'financialStatementsTable', 'financialStatementsThead', 'financialStatementsTbody',
    'financialStatementsFootnote', 'finFootCat', 'finFootFreq', 'finSrcChip',
    'financialTrendContainer', 'financialTrendSummary', 'financialTrendLabel',
    'financialTrendSubtitle', 'financialTrendLatest', 'financialTrendDeltaVal',
    'financialTrendDeltaLabel', 'financialTrendAvg', 'financialTrendRange',
    'financialBarChartContainer', 'financialBarSvg', 'financialZeroLine',
    'financialSvgBarsGroup', 'financialHtmlLabelsGroup', 'financialPeerSection',
    'financialPeerSubtitle', 'financialPeerTable', 'financialPeerTbody'
  ];
  for (const id of elIds) {
    elements[id] = makeEl(id);
  }

  const sandbox = {
    window: {},
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => makeEl('created-' + tag),
      querySelectorAll: () => []
    },
    console,
    URL,
    Intl,
    Date,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    }
  };
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.document = sandbox.document;
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);

  const runtimeSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'analisis-saham-runtime.js'), 'utf8');
  vm.runInContext(runtimeSrc, sandbox);

  return { sandbox, elements };
}

test('Financial: renders BRPT real data with honest "—" for missing equity', () => {
  const { sandbox, elements } = createMockDom();
  sandbox.window.selectFinancialTicker('BRPT');

  assert.equal(elements['financialTickerBadge'].textContent, 'BRPT');
  assert.equal(elements['financialCompanyName'].textContent, 'Barito Pacific Tbk');
  assert.equal(elements['financialPbvVal'].textContent, '—');
  assert.ok(elements['financialPbvNote'].textContent.includes('Total Ekuitas'));
  assert.equal(elements['financialLatestPeriodVal'].textContent, 'Q1 2026');
  assert.ok(elements['financialCoverageBadge'].textContent.includes('Data Sebagian'));
});

test('Financial: category tabs switch statements data correctly', () => {
  const { sandbox, elements } = createMockDom();
  sandbox.window.selectFinancialTicker('BRPT');

  // Cat 0: Laba Rugi
  sandbox.window.setFinStatementCat(0);
  assert.equal(elements['finFootCat'].textContent, 'Laba Rugi');
  assert.ok(elements['financialStatementsTbody'].innerHTML.includes('Pendapatan Usaha'));

  // Cat 1: Neraca
  sandbox.window.setFinStatementCat(1);
  assert.equal(elements['finFootCat'].textContent, 'Neraca');
  assert.ok(elements['financialStatementsTbody'].innerHTML.includes('Kas &amp; Setara Kas') || elements['financialStatementsTbody'].innerHTML.includes('Kas & Setara Kas'));

  // Cat 2: Arus Kas
  sandbox.window.setFinStatementCat(2);
  assert.equal(elements['finFootCat'].textContent, 'Arus Kas');
  assert.ok(elements['financialStatementsTbody'].innerHTML.includes('Arus Kas dari Aktivitas Operasi'));
});

test('Financial: §5c HTML overlay labels generated with percentage positioning over SVG', () => {
  const { sandbox, elements } = createMockDom();
  sandbox.window.selectFinancialTicker('BRPT');
  sandbox.window.setFinStatementCat(0);

  const htmlLabels = elements['financialHtmlLabelsGroup'].innerHTML;
  assert.ok(htmlLabels.includes('class="glb fq"'), 'contains fq class for period labels');
  assert.ok(htmlLabels.includes('style="left:'), 'contains percentage left style');
  assert.ok(htmlLabels.includes('top:'), 'contains percentage top style');

  const svgBars = elements['financialSvgBarsGroup'].innerHTML;
  assert.ok(svgBars.includes('<rect class="bb'), 'contains animated svg bar rects');
});

test('Financial: unlisted ticker renders empty state with link to market structure', () => {
  const { sandbox, elements } = createMockDom();
  sandbox.window.selectFinancialTicker('GOTO');

  assert.equal(elements['financialSnapshotEmpty'].style.display, 'flex');
  assert.equal(elements['financialStatementsSheet'].style.display, 'none');
  assert.ok(elements['financialEmptyTitle'].textContent.includes('GOTO'));
});
