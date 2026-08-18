'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const rows = config.headers || [];
const row = (source) => rows.find((item) => item.source === source);
const header = (source, key) => {
  const item = row(source);
  assert.ok(item, `missing vercel header rule for ${source}`);
  const match = (item.headers || []).find((entry) => entry.key.toLowerCase() === key.toLowerCase());
  assert.ok(match, `missing ${key} header for ${source}`);
  return match.value;
};

const appRoutes = ['/', '/index.html', '/dashboard', '/pattern', '/review'];
const preloadCore = '</premium-workstation-core.css?v=20260818-v4-core>; rel=preload; as=style';
const preloadV6 = '</premium-workstation-v6.css?v=20260818-v6>; rel=preload; as=style';

test('application entry routes explicitly remain private no-store', () => {
  for (const source of appRoutes) {
    const value = header(source, 'Cache-Control');
    assert.match(value, /private/);
    assert.match(value, /no-store/);
    assert.match(value, /must-revalidate/);
  }

  const portfolioAlias = header('/portfolio-planner', 'Cache-Control');
  assert.match(portfolioAlias, /private/);
  assert.match(portfolioAlias, /no-store/);
});

test('application entry routes preload versioned workstation layers', () => {
  for (const source of appRoutes) {
    const value = header(source, 'Link');
    assert.ok(value.includes(preloadCore), `${source} must preload workstation core`);
    assert.ok(value.includes(preloadV6), `${source} must preload workstation v6`);
  }
});

test('preload optimization does not weaken runtime cache boundaries', () => {
  assert.match(header('/api/(.*)', 'Cache-Control'), /no-store/);
  assert.match(header('/daytrade-runtime.js', 'Cache-Control'), /no-store/);
  assert.match(header('/premium-workstation.css', 'Cache-Control'), /max-age=0/);
  assert.match(header('/premium-workstation.css', 'Cache-Control'), /must-revalidate/);
  assert.match(header('/premium-workstation-core.css', 'Cache-Control'), /public/);
  assert.match(header('/premium-workstation-v6.css', 'Cache-Control'), /public/);
  assert.equal((row('/portfolio-planner').headers || []).some((entry) => entry.key.toLowerCase() === 'link'), false);
});
