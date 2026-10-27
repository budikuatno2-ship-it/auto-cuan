'use strict';

// Redesign v2 icon set (HANDOFF §2.2): canvas SVG paths in one module,
// 1.7px round strokes, no icon library.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const Icons = require(path.join(ROOT, 'public', 'ac-icons.js'));

test('every sidebar destination from the canvas has an icon', () => {
  const required = [
    'dashboard', 'screener', 'sektor-hot', 'catatan-admin', 'analisis', 'bandarmologi',
    'intel', 'hunter', 'insider', 'ranking', 'financial', 'struktur-pasar',
    'watchlist', 'portfolio', 'track-record', 'kelola-keuangan', 'pattern-radar', 'admin-console'
  ];
  for (const name of required) assert.ok(Icons.has(name), 'missing icon ' + name);
});

test('paths are the canvas paths, not redrawn approximations', () => {
  // The handoff folder is excluded from the branch, so the comparison only
  // runs where it is checked out; elsewhere the other tests still cover render.
  const canvasFile = path.join(ROOT, 'handoff-redesign', 'design', 'project', 'Main.dc.html');
  if (fs.existsSync(canvasFile)) {
    const canvas = fs.readFileSync(canvasFile, 'utf8');
    for (const name of ['dashboard', 'screener', 'watchlist', 'admin-console']) {
      const inner = Icons.svg(name).replace(/^<svg[^>]*>|<\/svg>$/g, '');
      assert.ok(canvas.includes(inner), name + ' path must match the canvas');
    }
  }
});

test('icons render with 1.7px round strokes and are decorative by default', () => {
  const out = Icons.svg('screener');
  assert.match(out, /stroke-width="1\.7"/);
  assert.match(out, /stroke-linecap="round"/);
  assert.match(out, /stroke-linejoin="round"/);
  assert.match(out, /aria-hidden="true"/);
  assert.match(out, /stroke="currentColor"/);
});

test('a label turns the icon into an accessible image and is escaped', () => {
  const out = Icons.svg('search', { label: 'Cari <emiten>' });
  assert.match(out, /role="img" aria-label="Cari emiten"/);
  assert.doesNotMatch(out, /aria-hidden/);
});

test('unknown names render nothing', () => {
  assert.equal(Icons.svg('sparkle'), '');
  assert.equal(Icons.has('sparkle'), false);
});

test('no icon library is installed', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  for (const lib of ['lucide', 'lucide-react', 'lucide-static', 'heroicons', '@heroicons/react', 'feather-icons']) {
    assert.ok(!(lib in deps), lib + ' must not be a dependency');
  }
});
