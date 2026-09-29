'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '../public/spreadsheet-grade.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
test('spreadsheet CSS closes every rule and at-rule', () => {
  let depth=0;
  for(const c of css){ if(c==='{')depth++; if(c==='}')depth--; assert.ok(depth>=0); }
  assert.equal(depth,0,'Unclosed reduced-motion block would silently absorb later rules');
});
test('reduced motion cannot change finance colors or sidebar profile geometry', () => {
  const reduced=css.slice(css.lastIndexOf('@media (prefers-reduced-motion'));
  assert.match(reduced,/transition:\s*none/);
  assert.doesNotMatch(reduced,/flex-direction:|background:|background-color:|color:/);
});
