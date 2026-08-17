'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getEntitlements } = require('../lib/entitlements');

const root = path.join(__dirname, '..');
const authSource = fs.readFileSync(path.join(root, 'lib', 'subscription-auth.js'), 'utf8');
const portfolioSource = fs.readFileSync(path.join(root, 'lib', 'portfolio-state-handler.js'), 'utf8');
const analyzeSource = fs.readFileSync(path.join(root, 'api', 'analyze.js'), 'utf8');
const adminApiSource = fs.readFileSync(path.join(root, 'api', 'admin-users.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(root, 'public', 'website-approved-access.js'), 'utf8');
const accessUiSource = fs.readFileSync(path.join(root, 'public', 'subscription-access-gate-v1.js'), 'utf8');
const lazySource = fs.readFileSync(path.join(root, 'public', 'account-center-lazy-loader-v1.js'), 'utf8');

const NOW = Date.parse('2026-08-16T12:00:00Z');
const before = new Date(NOW - 60 * 60 * 1000).toISOString();
const after = new Date(NOW + 60 * 60 * 1000).toISOString();
const expired = new Date(NOW - 1000).toISOString();

function account(username) {
  return { id:'00000000-0000-4000-8000-000000000001', username:username || 'userbot123', is_approved:true, is_blocked:false };
}

test('entitlement resolver keeps an approved account Free without an active entitlement', () => {
  const result = getEntitlements({ username:'userbot123' }, account(), [], NOW);
  assert.equal(result.premium, false);
  assert.equal(result.access_level, 'free');
  assert.equal(result.entitlement_status, 'none');
});

test('active trial, paid term, lifetime, and protected admin resolve premium access', () => {
  const trial = getEntitlements({ username:'trialuser' }, account('trialuser'), [{
    plan_code:'PREMIUM_1_MONTH', source:'trial', status:'active', starts_at:before, expires_at:after, lifetime:false
  }], NOW);
  assert.equal(trial.premium, true);
  assert.equal(trial.trial_state, 'active');

  const paid = getEntitlements({ username:'paiduser' }, account('paiduser'), [{
    plan_code:'PREMIUM_1_MONTH', source:'purchase', status:'active', starts_at:before, expires_at:after, lifetime:false
  }], NOW);
  assert.equal(paid.premium, true);
  assert.equal(paid.current_plan, 'PREMIUM_1_MONTH');

  const lifetime = getEntitlements({ username:'lifeuser' }, account('lifeuser'), [{
    plan_code:'LIFETIME', source:'voucher', status:'active', starts_at:before, expires_at:null, lifetime:true
  }], NOW);
  assert.equal(lifetime.premium, true);
  assert.equal(lifetime.lifetime_state, 'active');

  const admin = getEntitlements({ username:'budi' }, account('budi'), [], NOW);
  assert.equal(admin.premium, true);
  assert.equal(admin.access_level, 'admin');
});

test('expired subscription fails closed back to Free', () => {
  const result = getEntitlements({ username:'expireduser' }, account('expireduser'), [{
    plan_code:'PREMIUM_1_MONTH', source:'purchase', status:'active', starts_at:before, expires_at:expired, lifetime:false
  }], NOW);
  assert.equal(result.premium, false);
  assert.equal(result.access_level, 'free');
});

test('premium server guard no longer treats admin approval as a subscription', () => {
  assert.match(authSource, /SUBSCRIPTION_REQUIRED/);
  assert.match(authSource, /access\.premium !== true/);
  assert.match(authSource, /requirePremiumEntitlement/);
  assert.doesNotMatch(authSource, /access_level:'approved'/);
});

test('portfolio API and analysis API both enforce server-owned premium entitlement', () => {
  assert.match(portfolioSource, /requirePremiumEntitlement/);
  assert.match(portfolioSource, /await requirePremiumEntitlement\(req, supabase\)/);
  assert.match(analyzeSource, /requirePremiumEntitlement/);
  assert.match(analyzeSource, /await requirePremiumEntitlement\(req, db\)/);
  assert.match(analyzeSource, /PREMIUM_ACCESS_UNAVAILABLE/);
});

test('portfolio access handshake rejects Free users before standalone workspace reveal', () => {
  assert.match(adminApiSource, /function resolvePremiumPortfolioAccess\(req, res\)/);
  assert.match(adminApiSource, /return resolvePremiumPortfolioAccess\(req, res\)/);
  assert.match(adminApiSource, /requirePremiumEntitlement\(req, supabase\)/);
  assert.match(adminApiSource, /SUBSCRIPTION_REQUIRED|PREMIUM_ACCESS_DENIED/);
});

test('dashboard premium UX is sourced from signed account profile, not approval-only state', () => {
  assert.match(bootstrapSource, /subscription-access-gate-v1\.js/);
  assert.match(accessUiSource, /action:'account-profile'/);
  assert.match(accessUiSource, /ent\.premium === true/);
  assert.match(accessUiSource, /p\.is_admin === true/);
  assert.match(accessUiSource, /window\.loadPremiumAccess = loadPremiumAccessFromSubscription/);
});

test('Account Center is not eagerly parsed or mounted during dashboard startup', () => {
  assert.match(bootstrapSource, /account-center-lazy-loader-v1\.js/);
  assert.doesNotMatch(bootstrapSource, /loadScriptOnce\('\/account-center-v1\.js/);
  assert.match(lazySource, /function loadCenter\(tab\)/);
  assert.match(lazySource, /script\.src = '\/account-center-v1\.js\?v=20260816-v2'/);
  assert.match(lazySource, /backdrop-filter:none!important/);
});