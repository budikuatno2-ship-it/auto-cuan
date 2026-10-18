'use strict';
const { execFileSync } = require('child_process');
try {
  const out = execFileSync('node', ['--test', 'test/backfill-refactor.test.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  console.log(out);
} catch (e) {
  console.log('STDOUT:', e.stdout || '');
  console.log('STDERR:', e.stderr || '');
}
