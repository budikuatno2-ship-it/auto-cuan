'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const handler = require('../lib/portfolio-state-handler');
const helpers = handler.__test;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('portfolio state normalizer keeps expected sections and bounded collections', function () {
  const plans = Array.from({ length: 260 }, (_, i) => ({ id: 'p' + i, ticker: 'BBCA' }));
  const journal = Array.from({ length: 260 }, (_, i) => ({ id: 'j' + i, ticker: 'BBRI' }));
  const state = helpers.normalizePortfolioState({
    plans,
    prices: { BBCA: 9000, BBRI: 5000 },
    price_meta: { BBCA: { at: 123 } },
    journal,
    snapshot: { plans: [{ ticker: 'BBCA' }] },
    changes: [{ type: 'BASELINE' }],
    price_updated_at: 1786870000000
  });

  assert.equal(state.version, 1);
  assert.equal(state.plans.length, 200);
  assert.equal(state.journal.length, 200);
  assert.equal(state.prices.BBCA, 9000);
  assert.equal(state.price_meta.BBCA.at, 123);
  assert.equal(state.price_updated_at, 1786870000000);
});

test('portfolio state rejects payloads that are too large', function () {
  assert.throws(function () {
    helpers.normalizePortfolioState({
      journal: [{ id: 'huge', note: 'x'.repeat(helpers.MAX_STATE_BYTES + 1024) }]
    });
  }, /terlalu besar/i);
});

test('portfolio persistence database is RLS-protected and server-role only', function () {
  const sql = read('supabase/portfolio-state-persistence-migration.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.app_user_portfolio_state/);
  assert.match(sql, /REFERENCES public\.app_users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public\.app_user_portfolio_state FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.app_user_portfolio_state TO service_role/);
});

test('portfolio API derives identity from signed session and requires server premium entitlement', function () {
  const source = read('lib/portfolio-state-handler.js');
  const auth = read('lib/subscription-auth.js');
  assert.match(source, /requirePremiumEntitlement\(req, supabase\)/);
  assert.match(source, /isSameOrigin\(req\)/);
  assert.doesNotMatch(source, /req\.body\.user_id/);

  // Signed-session identity and account matching now live in the shared premium
  // authorization boundary rather than being duplicated by Portfolio.
  assert.match(auth, /requireAuthenticatedSession\(req\)/);
  assert.match(auth, /\.eq\('id', auth\.user\.id\)/);
  assert.match(auth, /storedUsername !== signedUsername/);
  assert.match(auth, /SUBSCRIPTION_REQUIRED/);
});

test('portfolio persistence reuses the existing reset-password Vercel function slot', function () {
  const api = read('api/reset-password.js');
  assert.match(api, /portfolio-state-load/);
  assert.match(api, /portfolio-state-save/);
  assert.match(api, /portfolioStateHandler/);
  assert.equal(fs.existsSync(path.join(ROOT, 'api', 'portfolio-state.js')), false);
});

test('portfolio V2 boot is time-boxed and loads the Supabase sync runtime', function () {
  const html = read('public/portfolio-command-center-v2.html');
  assert.match(html, /BOOT_TIMEOUT_MS\s*=\s*15000/);
  assert.match(html, /FETCH_TIMEOUT_MS\s*=\s*7000/);
  assert.match(html, /ASSET_TIMEOUT_MS\s*=\s*5000/);
  assert.match(html, /portfolio-supabase-sync\.js\?v=/);
  assert.match(html, /Tidak ada proses yang dibiarkan loading tanpa batas/);
  assert.match(html, /portfolioRetry/);
});

test('Supabase sync hydrates cloud state before watching local changes and preserves local fallback', function () {
  const source = read('public/portfolio-supabase-sync.js');
  assert.match(source, /portfolio-state-load/);
  assert.match(source, /portfolio-state-save/);
  assert.match(source, /bootstrap:\s*bootstrap/);
  assert.match(source, /applyRemoteState\(uid, data\.state/);
  assert.match(source, /hydrated\s*=\s*true/);
  assert.match(source, /local-fallback/);
  assert.match(source, /pagehide/);
  assert.match(source, /keepalive:\s*true/);
});
