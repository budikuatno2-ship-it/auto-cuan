'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function workflowFiles() {
  return fs.readdirSync(path.join(ROOT, '.github', 'workflows'))
    .filter((name) => /\.ya?ml$/i.test(name))
    .map((name) => '.github/workflows/' + name);
}

test('every GitHub Actions workflow declares explicit token permissions', () => {
  for (const file of workflowFiles()) {
    const src = read(file);
    assert.match(src, /^permissions:\s*(?:\{|$)/m, file + ' must declare explicit permissions');
  }
});

test('every remote GitHub Action is pinned to an immutable commit SHA', () => {
  for (const file of workflowFiles()) {
    const src = read(file);
    for (const match of src.matchAll(/\buses:\s*([^\s#]+)/g)) {
      const spec = match[1];
      if (spec.startsWith('./') || spec.startsWith('docker://')) continue;
      const at = spec.lastIndexOf('@');
      assert.ok(at > 0, file + ' has action without ref: ' + spec);
      const ref = spec.slice(at + 1);
      assert.match(ref, /^[0-9a-f]{40}$/i, file + ' uses mutable action ref: ' + spec);
    }
  }
});

test('security automation and dependency updates target the production branch', () => {
  const dependabot = read('.github/dependabot.yml');
  assert.match(dependabot, /package-ecosystem:\s*"npm"/);
  assert.match(dependabot, /package-ecosystem:\s*"github-actions"/);
  assert.ok((dependabot.match(/target-branch:\s*"feat\/daytrade-screener-v1"/g) || []).length >= 2);

  const codeql = read('.github/workflows/codeql-security.yml');
  assert.match(codeql, /security-events:\s*write/);
  assert.match(codeql, /languages:\s*javascript-typescript/);
});

test('retired GitHub foreign-flow debugging cannot receive Supabase service-role credentials', () => {
  const workflow = read('.github/workflows/sync-foreign-flow.yml');
  assert.doesNotMatch(workflow, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(workflow, /secrets\.SUPABASE_URL/);
  assert.match(workflow, /910b8db70893b93920a1bba331d00a1a245907c6/);
});

test('Vercel hardening prevents caching sensitive API responses and adds isolation headers', () => {
  const config = JSON.parse(read('vercel.json'));
  const global = config.headers.find((entry) => entry.source === '/(.*)');
  assert.ok(global, 'global security headers missing');
  const globalHeaders = Object.fromEntries(global.headers.map((h) => [h.key.toLowerCase(), h.value]));
  assert.equal(globalHeaders['x-content-type-options'], 'nosniff');
  assert.equal(globalHeaders['x-frame-options'], 'DENY');
  assert.equal(globalHeaders['cross-origin-opener-policy'], 'same-origin');
  assert.equal(globalHeaders['cross-origin-resource-policy'], 'same-origin');
  assert.equal(globalHeaders['origin-agent-cluster'], '?1');
  assert.match(globalHeaders['content-security-policy'] || '', /object-src 'none'/);
  assert.match(globalHeaders['content-security-policy'] || '', /base-uri 'self'/);
  assert.match(globalHeaders['content-security-policy'] || '', /frame-ancestors 'none'/);

  const api = config.headers.find((entry) => entry.source === '/api/(.*)');
  assert.ok(api, 'API no-store header missing');
  const cache = api.headers.find((h) => h.key.toLowerCase() === 'cache-control');
  assert.ok(cache);
  assert.match(cache.value, /no-store/);

  const assets = config.headers.find((entry) => entry.source === '/assets/(.*)');
  assert.ok(assets, 'static asset cache policy missing');
  const assetCache = assets.headers.find((h) => h.key.toLowerCase() === 'cache-control');
  assert.match(assetCache.value, /public/);
  assert.doesNotMatch(assetCache.value, /no-store/);
});
