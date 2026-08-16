'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(root, 'public', 'portfolio-command-center-v2.html'), 'utf8');
const workspaceCss = fs.readFileSync(path.join(root, 'public', 'portfolio-ai-workspace-v1.css'), 'utf8');
const workspaceJs = fs.readFileSync(path.join(root, 'public', 'portfolio-ai-workspace-v1.js'), 'utf8');

function arraySource(name) {
  const start = shell.indexOf('var ' + name + ' = [');
  assert.ok(start >= 0, name + ' declaration must exist');
  const end = shell.indexOf('];', start);
  assert.ok(end > start, name + ' declaration must close');
  return shell.slice(start, end + 2);
}

test('portfolio core boot does not depend on optional polish assets', () => {
  const critical = arraySource('criticalAssets');
  const optional = arraySource('optionalAssets');

  assert.match(critical, /portfolio-supabase-sync\.js/);
  assert.match(critical, /portfolio-command-center\.js/);
  assert.match(critical, /portfolio-runtime-fix\.js/);
  assert.doesNotMatch(critical, /ui-stability-fix\.js/);
  assert.doesNotMatch(critical, /ui-bugfix-pack-v1\.js/);

  assert.match(optional, /ui-stability-fix\.js/);
  assert.match(optional, /ui-bugfix-pack-v1\.js/);
  assert.match(optional, /portfolio-ai-workspace-v1\.js/);
  assert.match(shell, /console\.warn\('portfolio optional asset skipped'/);
});

test('portfolio shell still has a bounded critical boot and reviewed source shell', () => {
  assert.match(shell, /var BOOT_TIMEOUT_MS = 15000/);
  assert.match(shell, /var FETCH_TIMEOUT_MS = 7000/);
  assert.match(shell, /var ASSET_TIMEOUT_MS = 5000/);
  assert.match(shell, /fetch\('\/portfolio-command-center\.html\?v=20260727-v1'/);
  assert.match(shell, /Portfolio belum berhasil dibuka/);
});

test('AI workspace uses viewport height and keeps composer inside the chat card', () => {
  assert.match(workspaceCss, /#page-ai \.ai-chat/);
  assert.match(workspaceCss, /height:\s*clamp\(560px, calc\(100dvh - 96px\), 820px\)/);
  assert.match(workspaceCss, /#page-ai \.ai-compose/);
  assert.match(workspaceCss, /#page-ai \.ai-shell > aside/);
});

test('opening the AI tab automatically aligns the workspace', () => {
  assert.match(workspaceJs, /closest\('\[data-tab="ai"\]'\)/);
  assert.match(workspaceJs, /scrollIntoView/);
  assert.match(workspaceJs, /setTimeout\(focusWorkspace, 0\)/);
});
