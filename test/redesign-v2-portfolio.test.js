const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PARTIAL_PATH = path.join(__dirname, '..', 'partials', 'portfolio-command-center.partial.html');
const PUBLIC_PARTIAL_PATH = path.join(__dirname, '..', 'public', 'partials', 'portfolio-command-center.partial.html');
const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const CSS_PATH = path.join(__dirname, '..', 'public', 'ac-v2.css');
const RUNTIME_PATH = path.join(__dirname, '..', 'public', 'portfolio-command-center.js');

test('Portfolio redesign: partials and public partials are identical and in sync', () => {
  const partialHtml = fs.readFileSync(PARTIAL_PATH, 'utf8');
  const publicPartialHtml = fs.readFileSync(PUBLIC_PARTIAL_PATH, 'utf8');
  assert.equal(partialHtml, publicPartialHtml, 'Partial in partials/ and public/partials/ must be identical');
});

test('Portfolio redesign: tabStrip defines all 7 primary tabs matching Portfolio.dc.html', () => {
  const partialHtml = fs.readFileSync(PARTIAL_PATH, 'utf8');
  const expectedTabs = ['today', 'planner', 'watch', 'risk', 'scenarios', 'journal', 'ai'];

  expectedTabs.forEach(tab => {
    assert.ok(
      partialHtml.includes(`data-tab="${tab}"`),
      `Portfolio tabStrip must include data-tab="${tab}"`
    );
  });

  // Verify tab order in tabStrip
  const tabStripMatch = partialHtml.match(/<nav id="tabStrip"[\s\S]*?<\/nav>/);
  assert.ok(tabStripMatch, 'tabStrip must exist in partial');
  const tabStrip = tabStripMatch[0];

  const matches = [...tabStrip.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(matches, expectedTabs, 'tabStrip must contain strictly 7 tabs in order');
});

test('Portfolio redesign: mobile section selector includes all 7 options', () => {
  const partialHtml = fs.readFileSync(PARTIAL_PATH, 'utf8');
  const selectMatch = partialHtml.match(/<select id="pccMobileSectionSelect"[\s\S]*?<\/select>/);
  assert.ok(selectMatch, 'pccMobileSectionSelect must exist');
  const selectHtml = selectMatch[0];

  const expectedOptions = ['today', 'planner', 'watch', 'risk', 'scenarios', 'journal', 'ai'];
  const matches = [...selectHtml.matchAll(/value="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(matches, expectedOptions, 'pccMobileSectionSelect must contain all 7 options');
});

test('Portfolio redesign: header subtitle and badge match truthful data contract', () => {
  const partialHtml = fs.readFileSync(PARTIAL_PATH, 'utf8');
  assert.ok(
    partialHtml.includes('Rencana dan posisi mandiri. Tidak ada eksekusi broker otomatis.'),
    'Header subtitle must match canvas'
  );
  assert.ok(
    partialHtml.includes('Data asli'),
    'Header must carry Data asli badge'
  );
  // No internal nicknames or DB table names
  assert.equal(partialHtml.includes('Arjum'), false, 'UI must never expose internal names like Arjum');
  assert.equal(partialHtml.includes('arjum-data'), false, 'UI must never expose internal paths');
});

test('Portfolio redesign: legacy planner tools are organized in Alat lanjutan fold', () => {
  const partialHtml = fs.readFileSync(PARTIAL_PATH, 'utf8');
  assert.ok(
    partialHtml.includes('<details class="adv-tools">'),
    'Legacy extra planner tools must be preserved in <details class="adv-tools">'
  );
  assert.ok(
    partialHtml.includes('<summary>Alat lanjutan'),
    'Collapsible details must have summary Alat lanjutan'
  );
  // All original tool IDs must be retained
  assert.ok(partialHtml.includes('id="budgetCapital"'), 'budgetCapital ID retained');
  assert.ok(partialHtml.includes('id="calculateBudget"'), 'calculateBudget ID retained');
  assert.ok(partialHtml.includes('id="ownedTicker"'), 'ownedTicker ID retained');
  assert.ok(partialHtml.includes('id="saveOwned"'), 'saveOwned ID retained');
});

test('Portfolio redesign: table containers have horizontal scroll (.tw) and zero overflow', () => {
  const partialHtml = fs.readFileSync(PARTIAL_PATH, 'utf8');
  assert.ok(
    partialHtml.includes('id="watchTable" class="table-wrap tw'),
    'watchTable container must have table-wrap and tw classes for horizontal scroll'
  );

  const css = fs.readFileSync(CSS_PATH, 'utf8');
  assert.ok(
    css.includes('.rng'),
    'ac-v2.css must define .rng slider'
  );
  assert.ok(
    css.includes('.verd'),
    'ac-v2.css must define .verd verdict banner'
  );
  assert.ok(
    css.includes('.out'),
    'ac-v2.css must define .out key-value rows'
  );
  assert.ok(
    css.includes('.tl'),
    'ac-v2.css must define .tl timeline'
  );
  assert.ok(
    css.includes('.act'),
    'ac-v2.css must define .act action item'
  );
});

test('Portfolio redesign: index.html template stays aligned with 7 primary tabs and truthful labels', () => {
  const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const tplMatch = indexHtml.match(/<template id="tpl-portfolio-command-center">([\s\S]*?)<\/template>/);
  assert.ok(tplMatch, 'tpl-portfolio-command-center must exist in index.html');
  const tpl = tplMatch[1];

  const expectedTabs = ['today', 'planner', 'watch', 'risk', 'scenarios', 'journal', 'ai'];
  const tabStripMatch = tpl.match(/<nav id="tabStrip"[\s\S]*?<\/nav>/);
  assert.ok(tabStripMatch, 'tabStrip must exist in tpl-portfolio-command-center');
  const matches = [...tabStripMatch[0].matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(matches, expectedTabs, 'tpl-portfolio-command-center tabStrip must match 7 tabs');
});
