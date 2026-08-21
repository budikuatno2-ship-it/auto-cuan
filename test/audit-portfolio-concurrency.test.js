'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('portfolio saves use optimistic concurrency and surface conflicts', () => {
  const server = fs.readFileSync('lib/portfolio-state-handler.js', 'utf8');
  const client = fs.readFileSync('public/portfolio-supabase-sync.js', 'utf8');
  assert.match(server, /expected_updated_at/);
  assert.match(server, /\.eq\('updated_at', expectedUpdatedAt\)/);
  assert.match(server, /PORTFOLIO_STATE_CONFLICT/);
  assert.doesNotMatch(server, /\.upsert\(\{ user_id: account\.id, state/);
  assert.match(client, /expected_updated_at:\s*cloudRevision/);
  assert.match(client, /error\.status === 409/);
  assert.match(client, /setStatus\('conflict'/);
});
