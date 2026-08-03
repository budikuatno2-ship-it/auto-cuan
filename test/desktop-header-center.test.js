'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MARKER,
  applyHeaderCenter
} = require('../tools/apply-desktop-header-center');

test('desktop header patch centers navigation with equal grid side tracks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cuan-header-'));
  const target = path.join(dir, 'ui-theme.css');
  fs.writeFileSync(target, '.app-header{}\n', 'utf8');

  const first = applyHeaderCenter(target);
  const second = applyHeaderCenter(target);
  const output = fs.readFileSync(target, 'utf8');

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(output.split(MARKER).length - 1, 1);
  assert.match(output, /grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
  assert.match(output, /> \.desktop-nav\s*\{[\s\S]*justify-self:\s*center/);
  assert.match(output, /@media \(min-width: 1280px\)/);
});
