'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

test('FIX-17: All partials pairs in partials/ and public/partials/ are 100% byte-identical', () => {
  const root = path.resolve(__dirname, '..');
  const pairs = [
    ['partials/analisis-saham.partial.html', 'public/partials/analisis-saham.partial.html'],
    ['partials/money-management.partial.html', 'public/partials/money-management.partial.html'],
    ['partials/portfolio-command-center.partial.html', 'public/partials/portfolio-command-center.partial.html']
  ];

  for (const [p1, p2] of pairs) {
    const f1 = path.join(root, p1);
    const f2 = path.join(root, p2);

    assert.ok(fs.existsSync(f1), `File ${p1} must exist`);
    assert.ok(fs.existsSync(f2), `File ${p2} must exist`);

    const buf1 = fs.readFileSync(f1);
    const buf2 = fs.readFileSync(f2);

    assert.equal(buf1.length, buf2.length, `File ${p1} and ${p2} must have identical byte length`);

    const hash1 = crypto.createHash('sha1').update(buf1).digest('hex');
    const hash2 = crypto.createHash('sha1').update(buf2).digest('hex');

    assert.equal(hash1, hash2, `File ${p1} (${hash1}) and ${p2} (${hash2}) must have identical SHA-1 hashes`);
  }
});
