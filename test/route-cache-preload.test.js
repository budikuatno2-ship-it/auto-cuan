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
const privateAliases = ['/dashboard', '/pattern', '/review', '/portfolio-planner'];
const privateDocuments = ['/index.html', '/portfolio-planner.html', '/portfolio-command-center.html', '/portfolio-command-center-v2.html'];
const publicMetadata = ['/trust.html', '/404.html', '/robots.txt', '/sitemap.xml', '/.well-known/security.txt', '/favicon.ico'];
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

test('private route aliases and direct private documents stay out of crawler indexes', () => {
  for (const source of [...privateAliases, ...privateDocuments]) {
    assert.equal(header(source, 'X-Robots-Tag'), 'noindex, nofollow');
  }
  assert.equal((row('/').headers || []).some((entry) => entry.key.toLowerCase() === 'x-robots-tag'), false);
});

test('application entry routes preload versioned workstation layers', () => {
  for (const source of appRoutes) {
    const value = header(source, 'Link');
    assert.ok(value.includes(preloadCore), `${source} must preload workstation core`);
    assert.ok(value.includes(preloadV6), `${source} must preload workstation v6`);
  }
});

test('public identity surfaces have explicit public cache policy', () => {
  for (const source of publicMetadata) {
    const value = header(source, 'Cache-Control');
    assert.match(value, /public/);
    assert.doesNotMatch(value, /private|no-store/);
  }
  assert.match(header('/trust.html', 'Cache-Control'), /max-age=300/);
  assert.match(header('/favicon.ico', 'Cache-Control'), /max-age=86400/);
});

test('standalone public HTML is locked to a no-script no-connect CSP', () => {
  for (const source of ['/trust.html', '/404.html']) {
    const csp = header(source, 'Content-Security-Policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /style-src 'unsafe-inline'/);
    assert.match(csp, /script-src 'none'/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'none'/);
  }
  assert.equal(header('/404.html', 'X-Robots-Tag'), 'noindex, nofollow');
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
