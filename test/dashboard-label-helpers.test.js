'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadDashboardHelpers() {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const start = html.indexOf('function safeDisplayText');
  const end = html.indexOf('function fmtForeignFlowVal');
  const execStart = html.indexOf('function dashSignedPct');
  const execEnd = html.indexOf('function dashTpRealismLine');
  assert.ok(start >= 0 && end > start && execStart >= 0 && execEnd > execStart);
  const sandbox = { isFinite, Number, String, Array, Object };
  vm.createContext(sandbox);
  vm.runInContext(html.slice(start, end) + '\n' + html.slice(execStart, execEnd), sandbox);
  return sandbox;
}

const helpers = loadDashboardHelpers();

test('dashboard risk label normalization keeps canonical public labels', () => {
  const cases = [
    ['LOW', 'Low Risk'],
    ['low risk', 'Low Risk'],
    ['medium', 'Medium Risk'],
    ['MODERATE_RISK', 'Medium Risk'],
    ['high-risk', 'High Risk'],
    ['very_high', 'Very High Risk'],
    ['EXTREME RISK', 'Very High Risk'],
    ['avoid', 'Hindari'],
    ['HINDARI', 'Hindari']
  ];
  for (const [input, expected] of cases) assert.equal(helpers.normalizeRiskLabel(input), expected);
});

test('dashboard action/status label normalization keeps canonical public labels', () => {
  const cases = [
    ['avoid', 'Hindari'],
    ['AVOID_DULU', 'Hindari'],
    ['watch', 'Watchlist'],
    ['WATCHLIST', 'Watchlist'],
    ['pantau', 'Pantau'],
    ['signal', 'Signal'],
    ['early_radar', 'Radar'],
    ['locked', 'Final / Locked'],
    ['preview_provisional', 'Preview / Provisional']
  ];
  for (const [input, expected] of cases) assert.equal(helpers.normalizeActionLabel(input), expected);
});

test('dashboard risk colors are consistent and unsafe labels are not positive', () => {
  assert.equal(helpers.getRiskColor('low'), '#6ee7b7');
  assert.equal(helpers.getRiskColor('medium'), '#fbbf24');
  assert.equal(helpers.getRiskColor('high'), '#fb923c');
  assert.equal(helpers.getRiskColor('very high'), '#fca5a5');
  assert.equal(helpers.getRiskColor('avoid'), '#fca5a5');
});

test('dashboard execution reality wording dedupes repeated realistic price notes', () => {
  const line = helpers.dashExecutionRealityLine({ execution_reality_label: 'Butuh harga realistis', execution_reality_status: 'UNKNOWN_LIMITS' });
  assert.equal(line, 'Butuh harga realistis');
});
