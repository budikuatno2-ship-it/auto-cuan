'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const theme = fs.readFileSync(path.join(ROOT, 'public', 'ui-theme.css'), 'utf8');
const dtRuntime = fs.readFileSync(path.join(ROOT, 'public', 'daytrade-runtime.js'), 'utf8');

test('Wave 5 §82: Table-first is default presentation for all screener modes and Sektor Hot', () => {
  // Sektor Hot defaults to table-first overview
  assert.ok(html.includes('id="sektorTableWrap"') && html.includes('overflow-x-auto'));
  assert.doesNotMatch(html, /id="sektorTableWrap"[^>]*class="[^"]*hidden/);
  assert.match(html, /id="sektorGroupsGrid"[^>]*class="[^"]*hidden/);
  assert.match(html, /id="sektorBtnTable"[^>]*class="[^"]*is-active/);

  // Konglo Screener defaults to table-first
  assert.ok(html.includes('id="screenerTableWrap"') && html.includes('overflow-x-auto'));
  assert.doesNotMatch(html, /id="screenerTableWrap"[^>]*class="[^"]*hidden/);
  assert.match(html, /id="kgCardGrid"[^>]*class="[^"]*hidden/);
  assert.match(html, /id="kgBtnTable"[^>]*class="[^"]*is-active/);

  // Non-Konglo Screener defaults to table-first
  assert.ok(html.includes('id="nkScreenerTableWrap"') && html.includes('overflow-x-auto'));
  assert.doesNotMatch(html, /id="nkScreenerTableWrap"[^>]*class="[^"]*hidden/);
  assert.match(html, /id="nkCardGrid"[^>]*class="[^"]*hidden/);
  assert.match(html, /id="nkBtnTable"[^>]*class="[^"]*is-active/);

  // Day Trade Screener defaults to table-first
  assert.ok(html.includes('id="dtScreenerTableWrap"') && html.includes('overflow-x-auto'));
  assert.doesNotMatch(html, /id="dtScreenerTableWrap"[^>]*class="[^"]*hidden/);
  assert.match(html, /id="dtCardGrid"[^>]*class="[^"]*hidden/);
  assert.match(html, /id="dtBtnTable"[^>]*class="[^"]*is-active/);
});

test('Wave 5 §82: Split-view layout and desktop docked detail panes exist across modes', () => {
  // Konglo split view & detail pane
  assert.match(html, /class="ac-split-view"[^>]*id="kgSplitView"/);
  assert.match(html, /class="ac-detail-pane"[^>]*id="screenerDetailPane"/);
  assert.match(html, /id="screenerDetailTicker"/);
  assert.match(html, /id="screenerDetailTierBadge"/);
  assert.match(html, /id="screenerDetailBody"/);

  // Non-Konglo split view & detail pane
  assert.match(html, /class="ac-split-view"[^>]*id="nkSplitView"/);
  assert.match(html, /class="ac-detail-pane"[^>]*id="nkDetailPane"/);
  assert.match(html, /id="nkDetailTicker"/);
  assert.match(html, /id="nkDetailTierBadge"/);
  assert.match(html, /id="nkDetailBody"/);

  // Day Trade split view & detail pane
  assert.match(html, /class="ac-split-view"[^>]*id="dtSplitView"/);
  assert.match(html, /class="ac-detail-pane"[^>]*id="dtDetailPane"/);
  assert.match(html, /id="dtDetailTicker"/);
  assert.match(html, /id="dtDetailTierBadge"/);
  assert.match(html, /id="dtDetailBody"/);

  // Split-view and detail pane CSS contracts
  assert.match(theme, /\[data-ac-ui="v2"\] \.ac-split-view/);
  assert.match(theme, /\[data-ac-ui="v2"\] \.ac-split-view__pane/);
  assert.match(theme, /\[data-ac-ui="v2"\] \.ac-detail-pane/);
});

test('Wave 5 §82: Mobile/Tablet detail sheet overlay exists and is accessible', () => {
  assert.match(html, /class="ac-detail-sheet"[^>]*id="screenerMobileSheet"/);
  assert.match(html, /id="screenerSheetBackdrop"/);
  assert.match(html, /id="screenerSheetTicker"/);
  assert.match(html, /id="screenerSheetTierBadge"/);
  assert.match(html, /id="screenerSheetCloseBtn"/);
  assert.match(html, /id="screenerSheetBody"/);
  assert.match(html, /id="screenerSheetActionBtn"/);

  // Responsive: docked pane hidden on <1024px while overlay sheet is handled
  assert.match(theme, /@media \(max-width: 1023px\)[\s\S]*?\.ac-split-view__pane[\s\S]*?display:\s*none/);
  assert.match(theme, /@media \(max-width: 1023px\)[\s\S]*?\.ac-detail-sheet\.is-open/);
});

test('Wave 5 §82: Sektor Hot provides group overview table and constituents link to research', () => {
  // Sektor table exists
  assert.match(html, /<table id="sektorGroupsTable"/);
  assert.match(html, /<tbody id="sektorGroupsTableBody"/);

  // loadSektorHot populates table
  assert.match(html, /var tblBody = document\.getElementById\('sektorGroupsTableBody'\)/);
  assert.match(html, /tRowsHtml \+= '<tr class="border-b border-dark-600\/20/);
  assert.match(html, /showGroupDetail\(/);

  // Constituent member table links to research
  assert.ok(html.includes("screenerTickerClick(") && html.includes("m.ticker"), 'Sektor member table must link to screenerTickerClick');
  assert.match(html, /function toggleSektorView\(viewType\)/);
});

test('Wave 5 §82: Eliminates misleading LIVE badges on daily/EOD screener datasets', () => {
  // Konglo screener badge logic
  assert.doesNotMatch(html, /badge\.textContent = isPreviewRoute \? 'MOCK DATA' : 'LIVE'/);
  assert.match(html, /badge\.textContent = isPreviewRoute \? 'MOCK DATA' : 'EOD · T-1'/);
  assert.match(html, /badge\.textContent = isPreviewRoute \? 'MOCK DATA' : 'EOD · TODAY'/);

  // Non-Konglo screener badge logic
  assert.doesNotMatch(html, /meta\.status === 'published'[\s\S]*?badge\.textContent = isPreviewRouteNk \? 'MOCK DATA' : \(meta\.status_label === 'DAILY\/PUBLISHED' \? 'DAILY\/PUBLISHED' : 'LIVE'\)/);
  assert.match(html, /badge\.textContent = isPreviewRouteNk \? 'MOCK DATA' : 'EOD · T-1'/);
  assert.match(html, /badge\.textContent = isPreviewRouteNk \? 'MOCK DATA' : 'EOD · TODAY'/);
});

test('Wave 5 §82: AutoCuanScreener controller handles row selection, detail views, and preserves trade plan math', () => {
  // AutoCuanScreener object attached to window
  assert.match(html, /window\.AutoCuanScreener = AutoCuanScreener/);
  assert.match(html, /window\.selectScreenerRow = function/);
  assert.match(html, /window\.toggleScreenerView = function/);

  // Table row click integration
  assert.ok(html.includes("selectScreenerRow(\\'konglo\\'") || html.includes("selectScreenerRow('konglo'"), 'Konglo table rows must bind selectScreenerRow');
  assert.ok(html.includes("selectScreenerRow(\\'nonkonglo\\'") || html.includes("selectScreenerRow('nonkonglo'"), 'Non-Konglo table rows must bind selectScreenerRow');
  assert.ok(dtRuntime.includes("selectScreenerRow(\\'daytrade\\'") || dtRuntime.includes("selectScreenerRow('daytrade'"), 'Day Trade table rows must bind selectScreenerRow');

  // Trade plan metrics are formatted directly from row data without recalculation
  assert.match(html, /formatPrice\(r\.entry_low\) \+ ' – ' \+ formatPrice\(r\.entry_high\)/);
  assert.match(html, /r\.stop_loss != null \? formatPrice\(r\.stop_loss\) : '—'/);
  assert.match(html, /r\.tp1 != null \? formatPrice\(r\.tp1\) : '—'/);
  assert.match(html, /r\.tp2 != null \? formatPrice\(r\.tp2\) : '—'/);
  assert.match(html, /r\.risk_reward != null \? Number\(r\.risk_reward\)\.toFixed\(2\) : '—'/);

  // Row selection visual styling in ui-theme.css
  assert.match(theme, /\[data-ac-ui="v2"\] #screenerTableBody tr\.is-selected/);
  assert.match(theme, /\[data-ac-ui="v2"\] #nkScreenerTableBody tr\.is-selected/);
  assert.match(theme, /\[data-ac-ui="v2"\] #dtScreenerTableBody tr\.is-selected/);
});

test('Wave 5B: Screener default tables contain clean scan columns with zero redundant plan columns', () => {
  // Extract theads
  const kgThead = html.slice(html.indexOf('id="screenerTableWrap"'), html.indexOf('id="screenerTableBody"'));
  const nkThead = html.slice(html.indexOf('id="nkScreenerTableWrap"'), html.indexOf('id="nkScreenerTableBody"'));
  const dtThead = html.slice(html.indexOf('id="dtScreenerTableWrap"'), html.indexOf('id="dtScreenerTableBody"'));

  // Ensure no Entry Area, SL, TP1, TP2, RR in theads
  for (const [name, theadHtml] of [['Konglo', kgThead], ['Non-Konglo', nkThead], ['Day Trade', dtThead]]) {
    assert.ok(!theadHtml.includes('>Entry Area<'), `${name} table must NOT have Entry Area header`);
    assert.ok(!theadHtml.includes('>SL<'), `${name} table must NOT have SL header`);
    assert.ok(!theadHtml.includes('>TP1<'), `${name} table must NOT have TP1 header`);
    assert.ok(!theadHtml.includes('>TP2<'), `${name} table must NOT have TP2 header`);
    assert.ok(!theadHtml.includes('>RR<'), `${name} table must NOT have RR header`);
  }

  // Day Trade runtime table does not render redundant entry/sl/tp cells
  assert.doesNotMatch(dtRuntime, /html \+= \'<td[^>]*text-right text-gray-200 text-\[10px\]\'>\' \+ entryStr \+ \'<\/td>\';/);
  assert.doesNotMatch(dtRuntime, /html \+= \'<td[^>]*text-right font-medium[^>]*>\' \+ rrStr \+ \'<\/td>\';/);
});

test('Wave 5B: Day Trade score & status never produce user-visible undefined', () => {
  // Day Trade table guards dtScore and formats properly
  assert.match(dtRuntime, /var dtScore = r\.daytrade_score != null \? r\.daytrade_score : \(r\.score != null \? r\.score :/);
  assert.match(dtRuntime, /var dtScoreStr = \(dtScore != null && !isNaN\(Number\(dtScore\)\)\) \? String\(dtScore\) : \'—\';/);
  assert.doesNotMatch(dtRuntime, /html \+= \'<td[^>]*font-bold[^>]*>\' \+ r\.daytrade_score \+/);
});

test('Wave 5B: Sektor Hot group constituent integrity and member count consistency', () => {
  const mockData = require('../lib/mock-preview-data');
  const sectors = mockData.MOCK_SECTORS;
  assert.ok(sectors && sectors.groups && sectors.groups.length > 0);

  // Overview member count is non-zero for verified groups
  sectors.groups.forEach(g => {
    assert.ok(g.member_count > 0, `Group ${g.group_code} must have non-zero member_count`);
    assert.ok(g.stock_count > 0, `Group ${g.group_code} must have non-zero stock_count`);
    assert.equal(g.member_count, g.stock_count, `Group ${g.group_code} member_count must equal stock_count`);
  });

  // Overview UI uses guarded member count and never defaults to 0
  assert.match(html, /var memberCountVal = g\.stock_count != null \? g\.stock_count : \(g\.member_count != null \? g\.member_count :/);
  assert.match(html, /var memberCountDisplay = \(memberCountVal != null && !isNaN\(Number\(memberCountVal\)\)\) \? String\(memberCountVal\) : \'—\';/);
  assert.match(html, /tRowsHtml \+= \'<td class="px-3 py-2\.5 text-center text-gray-300 text-xs">\' \+ memberCountDisplay \+ \'<\/td>\';/);

  // Group detail uses truthful title and count
  assert.match(html, /var memberCnt = g\.stock_count != null \? g\.stock_count : \(g\.member_count != null \? g\.member_count :/);
  assert.match(html, /var groupTitle = g\.group_name \|\| \(\'Grup \' \+ \(g\.group_code \|\| groupCode\)\);/);
});

