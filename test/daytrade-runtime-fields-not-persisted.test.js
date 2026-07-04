'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RUNTIME_ONLY_FIELDS = [
  'major_respect_zone_notes',
  'major_demand_level',
  'major_supply_level',
  'major_zone_window',
  'volume_profile_poc',
  'volume_profile_note'
];

test('daytrade_screener_latest insert rows do not persist major-zone runtime-only fields', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'sector-hot.js'), 'utf8');
  const tableIndex = source.indexOf("from('daytrade_screener_latest').insert(batchRows)");
  assert.notEqual(tableIndex, -1, 'daytrade_screener_latest batch insert should exist');

  const mapStart = source.lastIndexOf('var batchRows = passedResults.map(function(r) {', tableIndex);
  assert.notEqual(mapStart, -1, 'batchRows mapper should exist before insert');

  const mapBlock = source.slice(mapStart, tableIndex);
  assert.match(mapBlock, /ticker:\s*r\.ticker/, 'sanity check: mapper block should include persisted ticker');
  assert.match(mapBlock, /quality_grade:\s*r\.quality_grade/, 'sanity check: mapper block should include known persisted quality field');

  for (const field of RUNTIME_ONLY_FIELDS) {
    assert.equal(mapBlock.includes(field), false, field + ' must remain runtime-only and must not be inserted');
  }
});
