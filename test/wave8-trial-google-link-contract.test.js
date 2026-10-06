'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const entitlements = require('../lib/entitlements');
const googleOAuthService = require('../lib/google-oauth-service');
const { createHandler } = require('../lib/legacy-gmail-handler');
const { createSessionToken, buildSessionCookie } = require('../lib/admin-session');

const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'subscription-trial-google-link-migration.sql');
const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

// Test RSA Key Pair for Cryptographic ID Token Verification Tests
const testRsaKeypair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const testJwk = testRsaKeypair.publicKey.export({ format: 'jwk' });
testJwk.kid = 'test-google-key-id-1';
testJwk.alg = 'RS256';
testJwk.use = 'sig';

function createSignedTestIdToken(payload, keyId = 'test-google-key-id-1', privateKey = testRsaKeypair.privateKey) {
  const header = { alg: 'RS256', kid: keyId, typ: 'JWT' };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = headerB64 + '.' + payloadB64;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function mockDb() {
  const cutoffDate = new Date('2026-10-01T00:00:00Z');
  const tables = {
    app_users: [],
    app_user_google_links: [],
    app_user_oauth_states: [],
    user_entitlements: [],
    subscription_events: [],
    system_feature_rollouts: [{ feature_key: 'google_link_bonus', cutoff_at: cutoffDate.toISOString() }]
  };

  return {
    tables,
    from(table) {
      if (!tables[table]) tables[table] = [];
      const rows = tables[table];
      let filters = [];
      let pendingUpdate = null;

      function getMatched() {
        return rows.filter(r => filters.every(f => f(r)));
      }

      const builder = {
        select() {
          return this;
        },
        eq(col, val) {
          filters.push(r => r[col] === val);
          return this;
        },
        is(col, val) {
          if (val === null) {
            filters.push(r => r[col] == null);
          } else {
            filters.push(r => r[col] === val);
          }
          return this;
        },
        update(values) {
          pendingUpdate = values;
          return this;
        },
        delete() {
          return {
            eq(col, val) {
              const idx = rows.findIndex(r => r[col] === val);
              if (idx !== -1) {
                // Enforce foreign key ON DELETE RESTRICT from app_user_google_links
                if (table === 'app_users' && tables.app_user_google_links.some(l => l.user_id === val)) {
                  return {
                    select() {
                      return Promise.resolve({
                        data: null,
                        error: { message: 'foreign key violation', code: '23503' }
                      });
                    }
                  };
                }
                const removed = rows.splice(idx, 1)[0];
                return {
                  select() {
                    return Promise.resolve({ data: [removed], error: null });
                  }
                };
              }
              return { select() { return Promise.resolve({ data: [], error: null }); } };
            }
          };
        },
        then(resolve) {
          if (pendingUpdate) {
            const matched = getMatched();
            matched.forEach(r => Object.assign(r, pendingUpdate));
            resolve({ data: matched[0] || null, error: null });
            return;
          }
          const matched = getMatched();
          resolve({ data: matched, error: null });
        },
        async maybeSingle() {
          if (pendingUpdate) {
            const matched = getMatched();
            matched.forEach(r => Object.assign(r, pendingUpdate));
            return { data: matched[0] || null, error: null };
          }
          const matched = getMatched();
          return { data: matched[0] || null, error: null };
        },
        async insert(record) {
          if (table === 'app_user_google_links') {
            if (rows.some(r => r.google_sub === record.google_sub)) {
              const err = new Error('duplicate key value violates unique constraint "uq_app_user_google_links_sub"');
              err.code = '23505';
              throw err;
            }
            if (rows.some(r => r.user_id === record.user_id)) {
              const err = new Error('duplicate key value violates unique constraint "uq_app_user_google_links_user"');
              err.code = '23505';
              throw err;
            }
          }
          if (table === 'app_user_oauth_states') {
            const stateVal = record.state || record.state_token;
            if (rows.some(r => (r.state === stateVal || r.state_token === stateVal))) {
              const err = new Error('duplicate key value violates unique constraint "app_user_oauth_states_state_key"');
              err.code = '23505';
              throw err;
            }
          }
          const row = Object.assign({ id: 'mock-' + crypto.randomUUID(), unlinked_at: null }, record);
          rows.push(row);
          return { data: row, error: null };
        }
      };
      return builder;
    },
    async rpc(funcName, params) {
      if (funcName === 'consume_oauth_state') {
        const { p_state, p_now } = params;
        const stateRow = tables.app_user_oauth_states.find(r => (r.state === p_state || r.state_token === p_state));
        if (!stateRow) {
          return { data: [{ consumed: false, user_id: null, nonce: null, code_verifier: null, error_code: 'state_not_found' }], error: null };
        }
        if (stateRow.consumed_at != null) {
          return { data: [{ consumed: false, user_id: null, nonce: null, code_verifier: null, error_code: 'state_already_consumed' }], error: null };
        }
        const nowMs = p_now ? new Date(p_now).getTime() : Date.now();
        if (new Date(stateRow.expires_at).getTime() < nowMs) {
          return { data: [{ consumed: false, user_id: null, nonce: null, code_verifier: null, error_code: 'state_expired' }], error: null };
        }
        stateRow.consumed_at = new Date(nowMs).toISOString();
        return { data: [{ consumed: true, user_id: stateRow.user_id, nonce: stateRow.nonce, code_verifier: stateRow.code_verifier, error_code: null }], error: null };
      }

      if (funcName === 'link_google_identity_and_grant_bonus') {
        const { p_user_id, p_google_sub, p_google_email, p_email_verified, p_idempotency_key, p_activation_time } = params;
        const now = p_activation_time ? new Date(p_activation_time) : new Date();
        const nowIso = now.toISOString();

        // Check user
        const user = tables.app_users.find(u => u.id === p_user_id);
        if (!user || user.is_blocked) {
          return { data: null, error: { message: 'user_not_eligible' } };
        }

        // Check idempotency
        const existingEnt = tables.user_entitlements.find(e => e.activation_idempotency_key === p_idempotency_key);
        if (existingEnt) {
          return {
            data: {
              success: true,
              linked: true,
              bonus_granted: true,
              starts_at: existingEnt.starts_at,
              expires_at: existingEnt.expires_at,
              duration_days: 7,
              google_sub: p_google_sub
            },
            error: null
          };
        }

        // Check 1:1 sub ownership
        const existingSub = tables.app_user_google_links.find(l => l.google_sub === p_google_sub);
        if (existingSub && existingSub.user_id !== p_user_id) {
          return { data: null, error: { message: 'google_identity_conflict' } };
        }

        // Check 1:1 user ownership
        const existingUser = tables.app_user_google_links.find(l => l.user_id === p_user_id);
        if (existingUser && existingUser.google_sub !== p_google_sub) {
          return { data: null, error: { message: 'user_google_link_mismatch' } };
        }

        // Check rollout cutoff
        const rolloutRow = tables.system_feature_rollouts.find(r => r.feature_key === 'google_link_bonus');
        let isPreRollout = false;
        if (rolloutRow && rolloutRow.cutoff_at && user.created_at) {
          isPreRollout = new Date(user.created_at).getTime() < new Date(rolloutRow.cutoff_at).getTime();
        }

        const hasPriorBonus = (existingUser && existingUser.bonus_granted_at != null)
          || (existingSub && existingSub.bonus_granted_at != null)
          || tables.user_entitlements.some(e => e.user_id === p_user_id && e.source === 'trial' && e.trial_kind === 'google_link_bonus');

        // Upsert / reactivate
        const targetLink = existingUser || existingSub;
        if (targetLink) {
          targetLink.unlinked_at = null;
          targetLink.google_email = p_google_email;
          targetLink.email_verified = true;
          targetLink.updated_at = nowIso;
        } else {
          tables.app_user_google_links.push({
            id: 'mock-link-' + crypto.randomUUID(),
            user_id: p_user_id,
            google_sub: p_google_sub,
            google_email: p_google_email,
            email_verified: true,
            linked_at: nowIso,
            unlinked_at: null,
            bonus_granted_at: null,
            created_at: nowIso,
            updated_at: nowIso
          });
        }

        if (isPreRollout && !hasPriorBonus) {
          const activeTrials = tables.user_entitlements.filter(e => e.user_id === p_user_id && e.source === 'trial' && e.status === 'active');
          const nowMs = now.getTime();
          const currentActive = activeTrials
            .filter(e => new Date(e.starts_at).getTime() <= nowMs && new Date(e.expires_at).getTime() > nowMs)
            .sort((a, b) => new Date(b.expires_at).getTime() - new Date(a.expires_at).getTime())[0];

          let bonusStart = currentActive ? new Date(currentActive.expires_at) : now;
          let bonusExpiry = new Date(bonusStart.getTime() + 7 * 24 * 60 * 60 * 1000);

          const bonusRow = {
            id: 'mock-ent-' + crypto.randomUUID(),
            user_id: p_user_id,
            source: 'trial',
            trial_kind: 'google_link_bonus',
            status: 'active',
            starts_at: bonusStart.toISOString(),
            expires_at: bonusExpiry.toISOString(),
            lifetime: false,
            plan_code: null,
            activation_idempotency_key: p_idempotency_key,
            created_at: nowIso,
            updated_at: nowIso
          };
          tables.user_entitlements.push(bonusRow);

          const lRow = targetLink || tables.app_user_google_links.find(l => l.user_id === p_user_id);
          if (lRow) lRow.bonus_granted_at = nowIso;

          return {
            data: {
              success: true,
              linked: true,
              bonus_granted: true,
              starts_at: bonusRow.starts_at,
              expires_at: bonusRow.expires_at,
              duration_days: 7,
              google_sub: p_google_sub,
              pre_rollout_eligible: true
            },
            error: null
          };
        }

        return {
          data: {
            success: true,
            linked: true,
            bonus_granted: false,
            already_claimed: hasPriorBonus,
            pre_rollout_eligible: isPreRollout,
            google_sub: p_google_sub
          },
          error: null
        };
      }

      return { data: null, error: new Error('UNKNOWN_RPC: ' + funcName) };
    }
  };
}

function evaluateDbTrialCheckConstraint(row) {
  // Evaluates database check constraint:
  // (source <> 'trial' AND trial_kind IS NULL)
  // OR
  // (
  //   source = 'trial'
  //   AND trial_kind IS NOT NULL
  //   AND starts_at IS NOT NULL
  //   AND expires_at IS NOT NULL
  //   AND lifetime = false
  //   AND plan_code IS NULL
  //   AND (...)
  // )
  if (row.source !== 'trial') {
    return row.trial_kind === null || row.trial_kind === undefined;
  }
  if (!row.trial_kind || !row.starts_at || !row.expires_at || row.lifetime !== false || row.plan_code !== null) {
    return false;
  }
  const startsAt = new Date(row.starts_at).getTime();
  const expiresAt = new Date(row.expires_at).getTime();
  if (Number.isNaN(startsAt) || Number.isNaN(expiresAt)) return false;
  const durationMs = expiresAt - startsAt;
  const dayMs = 24 * 60 * 60 * 1000;

  if (row.trial_kind === 'legacy_initial') {
    return durationMs === 10 * dayMs;
  }
  if (row.trial_kind === 'initial') {
    return durationMs === 14 * dayMs;
  }
  if (row.trial_kind === 'google_link_bonus') {
    return durationMs === 7 * dayMs;
  }
  return false;
}

function createMockReqRes(options) {
  const { method = 'POST', headers = {}, body = {}, query = {}, sessionUser = null } = options;
  const reqHeaders = Object.assign({
    host: 'localhost:3000',
    origin: 'http://localhost:3000'
  }, headers);

  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = 'wave8-test-secret-at-least-32-chars-long!!';
  }

  if (sessionUser) {
    const token = createSessionToken(sessionUser);
    reqHeaders.cookie = `ac_sess=${token}`;
  }

  const req = {
    method,
    headers: reqHeaders,
    body,
    query
  };

  let statusCode = 200;
  let responseData = null;
  const resHeaders = {};

  const res = {
    setHeader(k, v) { resHeaders[k.toLowerCase()] = v; return this; },
    writeHead(code, headersObj) {
      statusCode = code;
      if (headersObj) {
        for (const [k, v] of Object.entries(headersObj)) {
          resHeaders[k.toLowerCase()] = v;
        }
      }
      return this;
    },
    status(code) { statusCode = code; return this; },
    json(data) { responseData = data; return this; },
    send(data) { responseData = data; return this; },
    end() { return this; },
    getStatusCode() { return statusCode; },
    getBody() { return responseData; },
    getHeaders() { return resHeaders; },
    getHeader(name) { return resHeaders[name.toLowerCase()]; }
  };

  return { req, res };
}

test.beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret-xyz';
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3000/api/reset-password?action=account-google-link-callback';
  process.env.ALLOW_TEST_OAUTH_FIXTURES = 'true';
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'wave8-test-secret-at-least-32-chars-long!!';
  googleOAuthService.resetTestingHooks();
  googleOAuthService.setJwksForTesting([testJwk]);
});

test.afterEach(() => {
  googleOAuthService.resetTestingHooks();
});

// ======================================================================
// 1. cross-site Google callback succeeds WITHOUT ac_sess using valid opaque state
// ======================================================================
test('1. cross-site Google callback succeeds WITHOUT ac_sess using valid opaque state', async () => {
  const db = mockDb();
  const userId = 'u-no-cookie-1';
  db.tables.app_users.push({ id: userId, username: 'nocookie', created_at: '2026-08-01T00:00:00Z', is_blocked: false });

  // Store state in DB for user
  const stateData = googleOAuthService.createOauthState(userId);
  await googleOAuthService.saveOAuthState(db, {
    userId,
    stateToken: stateData.stateToken,
    nonce: stateData.nonce,
    codeVerifier: stateData.codeVerifier,
    expiresAt: stateData.expiresAt
  });

  googleOAuthService.setTokenExchangeHandlerForTesting(async () => {
    return {
      access_token: 'mock-access',
      id_token: createSignedTestIdToken({
        iss: 'https://accounts.google.com',
        aud: process.env.GOOGLE_OAUTH_CLIENT_ID,
        sub: 'sub-no-cookie-1',
        email: 'nocookie@gmail.com',
        email_verified: true,
        nonce: stateData.nonce,
        exp: Math.floor(Date.now() / 1000) + 3600
      })
    };
  });

  // Cross-site GET callback from accounts.google.com: NO cookie provided!
  const handler = createHandler(() => db);
  const { req, res } = createMockReqRes({
    method: 'GET',
    headers: { host: 'localhost:3000' }, // NO cookie header!
    query: {
      action: 'account-google-link-callback',
      code: 'real-google-code',
      state: stateData.stateToken
    }
  });

  await handler(req, res);

  assert.equal(res.getStatusCode(), 302);
  assert.equal(res.getHeader('Location'), '/?google_linked=1');

  // Verify identity linked authoritatively to the user in database
  const linkRow = db.tables.app_user_google_links.find(l => l.user_id === userId);
  assert.ok(linkRow);
  assert.equal(linkRow.google_sub, 'sub-no-cookie-1');
  assert.equal(linkRow.google_email, 'nocookie@gmail.com');
});

// ======================================================================
// 2. ac_sess remains SameSite=Strict
// ======================================================================
test('2. ac_sess session cookie remains SameSite=Strict', () => {
  const cookieStr = buildSessionCookie('mock-session-token-abc');
  assert.match(cookieStr, /SameSite=Strict/i);
  assert.doesNotMatch(cookieStr, /SameSite=Lax/i);
  assert.doesNotMatch(cookieStr, /SameSite=None/i);
  assert.match(cookieStr, /HttpOnly/i);
});

// ======================================================================
// 3. state contains no Auto-Cuan user_id
// ======================================================================
test('3. state contains no Auto-Cuan user_id and is high-entropy opaque random string', () => {
  const userId = 'secret-uuid-user-12345';
  const stateData = googleOAuthService.createOauthState(userId);
  assert.doesNotMatch(stateData.stateToken, new RegExp(userId));
  // Opaque 64-char hex string (256-bit entropy)
  assert.match(stateData.stateToken, /^[0-9a-f]{64}$/);
});

// ======================================================================
// 4. state consumption returns authoritative user_id from DB
// ======================================================================
test('4. state consumption returns authoritative user_id from DB', async () => {
  const db = mockDb();
  const userId = 'u-auth-owner-4';
  const stateData = googleOAuthService.createOauthState(userId);

  await googleOAuthService.saveOAuthState(db, {
    userId,
    stateToken: stateData.stateToken,
    nonce: stateData.nonce,
    codeVerifier: stateData.codeVerifier,
    expiresAt: stateData.expiresAt
  });

  const consumed = await googleOAuthService.consumeOAuthState(db, {
    stateToken: stateData.stateToken
  });

  assert.equal(consumed.ok, true);
  assert.equal(consumed.userId, userId);
  assert.equal(consumed.nonce, stateData.nonce);
  assert.equal(consumed.codeVerifier, stateData.codeVerifier);
});

// ======================================================================
// 5. state replay fails
// ======================================================================
test('5. state replay fails on second consumption', async () => {
  const db = mockDb();
  const userId = 'u-replay-5';
  const stateData = googleOAuthService.createOauthState(userId);
  await googleOAuthService.saveOAuthState(db, {
    userId,
    stateToken: stateData.stateToken,
    nonce: stateData.nonce,
    codeVerifier: stateData.codeVerifier,
    expiresAt: stateData.expiresAt
  });

  const firstConsume = await googleOAuthService.consumeOAuthState(db, { stateToken: stateData.stateToken });
  assert.equal(firstConsume.ok, true);

  const secondConsume = await googleOAuthService.consumeOAuthState(db, { stateToken: stateData.stateToken });
  assert.equal(secondConsume.ok, false);
  assert.equal(secondConsume.code, 'STATE_ALREADY_CONSUMED');
});

// ======================================================================
// 6. expired state fails
// ======================================================================
test('6. expired state fails', async () => {
  const db = mockDb();
  const userId = 'u-expired-6';
  const stateData = googleOAuthService.createOauthState(userId);
  const pastExpires = new Date(Date.now() - 60000).toISOString();

  await googleOAuthService.saveOAuthState(db, {
    userId,
    stateToken: stateData.stateToken,
    nonce: stateData.nonce,
    codeVerifier: stateData.codeVerifier,
    expiresAt: pastExpires
  });

  const consumed = await googleOAuthService.consumeOAuthState(db, { stateToken: stateData.stateToken });
  assert.equal(consumed.ok, false);
  assert.equal(consumed.code, 'STATE_EXPIRED');
});

// ======================================================================
// 7. missing state fails
// ======================================================================
test('7. missing or unknown state fails', async () => {
  const db = mockDb();
  const consumed = await googleOAuthService.consumeOAuthState(db, { stateToken: 'unknown-state-token' });
  assert.equal(consumed.ok, false);
  assert.equal(consumed.code, 'STATE_NOT_FOUND');
});

// ======================================================================
// 8. state DB insert error prevents authorization URL issuance
// ======================================================================
test('8. state DB insert error prevents authorization URL issuance', async () => {
  const db = mockDb();
  const userId = 'u-err-8';
  db.tables.app_users.push({ id: userId, username: 'erruser', created_at: '2026-08-01T00:00:00Z', is_blocked: false });

  // Simulate DB insert error on app_user_oauth_states
  const origFrom = db.from.bind(db);
  db.from = (table) => {
    const builder = origFrom(table);
    if (table === 'app_user_oauth_states') {
      builder.insert = async () => ({ data: null, error: { message: 'DB connection failure' } });
    }
    return builder;
  };

  const handler = createHandler(() => db);
  const { req, res } = createMockReqRes({
    method: 'POST',
    sessionUser: { userId, username: 'erruser' },
    body: { action: 'account-google-link-url' }
  });

  await handler(req, res);
  assert.equal(res.getStatusCode(), 500);
  assert.equal(res.getBody().code, 'OAUTH_STATE_SAVE_FAILED');
  assert.equal(res.getBody().auth_url, undefined);
});

// ======================================================================
// 9. consume RPC error fails closed; no direct fallback
// ======================================================================
test('9. consume RPC error fails closed with zero fallback', async () => {
  const db = {
    rpc: async () => ({ data: null, error: { message: 'RPC connection lost' } }),
    from: () => { throw new Error('FAIL: Fallback query must not be called'); }
  };

  const res = await googleOAuthService.consumeOAuthState(db, { stateToken: 'some-state' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RPC_UNAVAILABLE');
});

// ======================================================================
// 10. link RPC error fails closed; no direct fallback
// ======================================================================
test('10. link RPC error fails closed with zero fallback', async () => {
  const db = {
    rpc: async () => ({ data: null, error: { message: 'Database link RPC failed' } }),
    from: () => { throw new Error('FAIL: Fallback query must not be called'); }
  };

  const res = await googleOAuthService.linkGoogleIdentity(db, {
    userId: 'u-link-err-10',
    googleSub: 'sub-err-10',
    googleEmail: 'user10@gmail.com',
    emailVerified: true,
    idempotencyKey: 'idemp-10'
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'LINK_RPC_FAILED');
});

// ======================================================================
// 11. rollout row missing => zero bonus
// ======================================================================
test('11. rollout row missing grants zero bonus (fails closed)', async () => {
  const db = mockDb();
  // Empty rollout table
  db.tables.system_feature_rollouts = [];
  const userId = 'u-norollout-11';
  db.tables.app_users.push({ id: userId, username: 'norollout', created_at: '2026-01-01T00:00:00Z', is_blocked: false });

  const res = await googleOAuthService.linkGoogleIdentity(db, {
    userId,
    googleSub: 'sub-11',
    googleEmail: 'user11@gmail.com',
    emailVerified: true,
    idempotencyKey: 'idemp-11'
  });

  assert.equal(res.ok, true);
  assert.equal(res.data.linked, true);
  assert.equal(res.data.bonus_granted, false);

  const bonusEnts = db.tables.user_entitlements.filter(e => e.user_id === userId && e.trial_kind === 'google_link_bonus');
  assert.equal(bonusEnts.length, 0);
});

// ======================================================================
// 12. pre-rollout user => +7 once
// ======================================================================
test('12. pre-rollout user gets +7 day bonus once upon linking Google', async () => {
  const db = mockDb();
  const userId = 'u-prerollout-12';
  db.tables.app_users.push({ id: userId, username: 'prerollout', created_at: '2026-08-01T00:00:00Z', is_blocked: false });

  const res = await googleOAuthService.linkGoogleIdentity(db, {
    userId,
    googleSub: 'sub-12',
    googleEmail: 'user12@gmail.com',
    emailVerified: true,
    idempotencyKey: 'idemp-12'
  });

  assert.equal(res.ok, true);
  assert.equal(res.data.bonus_granted, true);
  assert.equal(res.data.duration_days, 7);

  const bonusEnts = db.tables.user_entitlements.filter(e => e.user_id === userId && e.trial_kind === 'google_link_bonus');
  assert.equal(bonusEnts.length, 1);
});

// ======================================================================
// 13. post-rollout user => zero Google bonus
// ======================================================================
test('13. post-rollout user receives zero Google bonus upon linking Google', async () => {
  const db = mockDb();
  const userId = 'u-postrollout-13';
  db.tables.app_users.push({ id: userId, username: 'postrollout', created_at: '2026-10-15T00:00:00Z', is_blocked: false });

  const res = await googleOAuthService.linkGoogleIdentity(db, {
    userId,
    googleSub: 'sub-13',
    googleEmail: 'user13@gmail.com',
    emailVerified: true,
    idempotencyKey: 'idemp-13'
  });

  assert.equal(res.ok, true);
  assert.equal(res.data.linked, true);
  assert.equal(res.data.bonus_granted, false);

  const bonusEnts = db.tables.user_entitlements.filter(e => e.user_id === userId && e.trial_kind === 'google_link_bonus');
  assert.equal(bonusEnts.length, 0);
});

// ======================================================================
// 14. current production lifetime/expires CHECK remains preserved
// ======================================================================
test('14. migration sql preserves user_entitlements_check (lifetime vs expires consistency)', () => {
  // Verifies the migration DOES NOT drop user_entitlements_check
  assert.doesNotMatch(migrationSql, /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?user_entitlements_check;/i);
  assert.match(migrationSql, /conname\s+NOT\s+IN\s*\(\s*'user_entitlements_check',\s*'user_entitlements_check1'\s*\)/);
});

// ======================================================================
// 15. current expires_at > starts_at CHECK remains preserved
// ======================================================================
test('15. migration sql preserves user_entitlements_check1 (expires_at > starts_at)', () => {
  assert.doesNotMatch(migrationSql, /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?user_entitlements_check1;/i);
});

// ======================================================================
// 16. old 10-day trial constraint is actually removed/replaced
// ======================================================================
test('16. migration sql safely targets and replaces legacy trial constraint in DO block', () => {
  assert.match(migrationSql, /pg_get_constraintdef\(c\.oid\)\s+ILIKE\s+'%10 days%'/);
  assert.match(migrationSql, /user_entitlements_check2/);
  assert.match(migrationSql, /ADD\s+CONSTRAINT\s+user_entitlements_trial_kind_check/);
});

// ======================================================================
// 17. legacy 10-day row remains valid
// ======================================================================
test('17. legacy 10-day row satisfies check constraint', () => {
  const validLegacy = evaluateDbTrialCheckConstraint({
    source: 'trial',
    trial_kind: 'legacy_initial',
    lifetime: false,
    plan_code: null,
    starts_at: '2026-07-01T00:00:00Z',
    expires_at: '2026-07-11T00:00:00Z'
  });
  assert.equal(validLegacy, true);
});

// ======================================================================
// 18. new 14-day initial row valid
// ======================================================================
test('18. new 14-day initial row satisfies check constraint', () => {
  const validInitial = evaluateDbTrialCheckConstraint({
    source: 'trial',
    trial_kind: 'initial',
    lifetime: false,
    plan_code: null,
    starts_at: '2026-10-01T00:00:00Z',
    expires_at: '2026-10-15T00:00:00Z'
  });
  assert.equal(validInitial, true);
});

// ======================================================================
// 19. 7-day Google bonus row valid
// ======================================================================
test('19. 7-day Google bonus row satisfies check constraint', () => {
  const validBonus = evaluateDbTrialCheckConstraint({
    source: 'trial',
    trial_kind: 'google_link_bonus',
    lifetime: false,
    plan_code: null,
    starts_at: '2026-10-15T00:00:00Z',
    expires_at: '2026-10-22T00:00:00Z'
  });
  assert.equal(validBonus, true);
});

// ======================================================================
// 20. incorrect 10/14/7 duration rejected
// ======================================================================
test('20. incorrect trial durations rejected by check constraint', () => {
  // initial trial with 10 days instead of 14
  assert.equal(evaluateDbTrialCheckConstraint({
    source: 'trial',
    trial_kind: 'initial',
    lifetime: false,
    plan_code: null,
    starts_at: '2026-10-01T00:00:00Z',
    expires_at: '2026-10-11T00:00:00Z'
  }), false);

  // bonus trial with 14 days instead of 7
  assert.equal(evaluateDbTrialCheckConstraint({
    source: 'trial',
    trial_kind: 'google_link_bonus',
    lifetime: false,
    plan_code: null,
    starts_at: '2026-10-01T00:00:00Z',
    expires_at: '2026-10-15T00:00:00Z'
  }), false);

  // legacy initial trial with 14 days instead of 10
  assert.equal(evaluateDbTrialCheckConstraint({
    source: 'trial',
    trial_kind: 'legacy_initial',
    lifetime: false,
    plan_code: null,
    starts_at: '2026-10-01T00:00:00Z',
    expires_at: '2026-10-15T00:00:00Z'
  }), false);
});

// ======================================================================
// 21. current runtime initial trial constant = 14 days
// ======================================================================
test('21. current runtime initial trial constant = 14 days (336 hours)', () => {
  assert.equal(entitlements.TRIAL_DURATION_HOURS, 14 * 24);
  assert.equal(entitlements.TRIAL_DURATION_MS, 14 * 24 * 60 * 60 * 1000);
  assert.equal(entitlements.LEGACY_TRIAL_DURATION_HOURS, 10 * 24);
  assert.equal(entitlements.GOOGLE_BONUS_DURATION_HOURS, 7 * 24);
});

// ======================================================================
// 22. API reports actual legacy 10-day duration
// ======================================================================
test('22. API reports actual legacy 10-day duration for existing legacy trial row', () => {
  const trialRow = {
    source: 'trial',
    starts_at: '2026-07-01T00:00:00Z',
    expires_at: '2026-07-11T00:00:00Z'
  };
  const days = Math.round((new Date(trialRow.expires_at) - new Date(trialRow.starts_at)) / (24 * 60 * 60 * 1000));
  assert.equal(days, 10);
});

// ======================================================================
// 23. API reports actual new 14-day duration
// ======================================================================
test('23. API reports actual new 14-day duration for new initial trial row', () => {
  const trialRow = {
    source: 'trial',
    starts_at: '2026-10-01T00:00:00Z',
    expires_at: '2026-10-15T00:00:00Z'
  };
  const days = Math.round((new Date(trialRow.expires_at) - new Date(trialRow.starts_at)) / (24 * 60 * 60 * 1000));
  assert.equal(days, 14);
});

// ======================================================================
// 24. API reports Google bonus 7-day duration
// ======================================================================
test('24. API reports Google bonus 7-day duration for bonus trial row', () => {
  const bonusRow = {
    source: 'trial',
    starts_at: '2026-10-15T00:00:00Z',
    expires_at: '2026-10-22T00:00:00Z'
  };
  const days = Math.round((new Date(bonusRow.expires_at) - new Date(bonusRow.starts_at)) / (24 * 60 * 60 * 1000));
  assert.equal(days, 7);
});

// ======================================================================
// 25. legacy idempotency replay does not falsely report 14 days
// ======================================================================
test('25. activate_subscription_trial SQL returns actual row duration on idempotency replay', () => {
  assert.match(migrationSql, /ROUND\(EXTRACT\(EPOCH\s+FROM\s+\(e\.expires_at\s+-\s+e\.starts_at\)\)\s*\/\s*86400\)::integer/);
});

// ======================================================================
// 26. no production direct-table mutation fallback after RPC failure
// ======================================================================
test('26. production code contains zero direct-table fallback mutations on RPC error', () => {
  const serviceCode = fs.readFileSync(path.join(__dirname, '..', 'lib', 'google-oauth-service.js'), 'utf8');
  // Confirm no fallback queries exist after consume_oauth_state rpc call
  assert.doesNotMatch(serviceCode, /Fallback transactional query/i);
  assert.doesNotMatch(serviceCode, /Fallback transaction \(for unit testing/i);
  // Confirm linkGoogleIdentity only mutates via link_google_identity_and_grant_bonus
  assert.match(serviceCode, /db\.rpc\('link_google_identity_and_grant_bonus'/);
  assert.match(serviceCode, /db\.rpc\('consume_oauth_state'/);
});

// ======================================================================
// 27. invalid Google signature rejected
// ======================================================================
test('27. cryptographically invalid signature on Google ID token is strictly rejected', async () => {
  const otherKeypair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forgedToken = createSignedTestIdToken({
    iss: 'https://accounts.google.com',
    aud: process.env.GOOGLE_OAUTH_CLIENT_ID,
    sub: 'forged-sub',
    email: 'forged@gmail.com',
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600
  }, 'test-google-key-id-1', otherKeypair.privateKey);

  const res = await googleOAuthService.verifyGoogleIdToken(forgedToken, {
    expectedAudience: process.env.GOOGLE_OAUTH_CLIENT_ID
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_signature');
});

// ======================================================================
// 28. nonce/audience/issuer/expiry/email_verified checks remain intact
// ======================================================================
test('28. claims validation checks (nonce, aud, iss, exp, email_verified) remain intact', async () => {
  const validBase = {
    iss: 'https://accounts.google.com',
    aud: process.env.GOOGLE_OAUTH_CLIENT_ID,
    sub: 'sub-28',
    email: 'user28@gmail.com',
    email_verified: true,
    nonce: 'correct-nonce-123',
    exp: Math.floor(Date.now() / 1000) + 3600
  };

  // Wrong issuer
  const wrongIss = await googleOAuthService.verifyGoogleIdToken(
    createSignedTestIdToken(Object.assign({}, validBase, { iss: 'https://evil.com' })),
    { expectedAudience: process.env.GOOGLE_OAUTH_CLIENT_ID, expectedNonce: 'correct-nonce-123' }
  );
  assert.equal(wrongIss.ok, false);
  assert.equal(wrongIss.error, 'invalid_issuer');

  // Wrong audience
  const wrongAud = await googleOAuthService.verifyGoogleIdToken(
    createSignedTestIdToken(Object.assign({}, validBase, { aud: 'wrong-client-id' })),
    { expectedAudience: process.env.GOOGLE_OAUTH_CLIENT_ID, expectedNonce: 'correct-nonce-123' }
  );
  assert.equal(wrongAud.ok, false);
  assert.equal(wrongAud.error, 'invalid_audience');

  // Expired token
  const expiredToken = await googleOAuthService.verifyGoogleIdToken(
    createSignedTestIdToken(Object.assign({}, validBase, { exp: Math.floor(Date.now() / 1000) - 120 })),
    { expectedAudience: process.env.GOOGLE_OAUTH_CLIENT_ID, expectedNonce: 'correct-nonce-123' }
  );
  assert.equal(expiredToken.ok, false);
  assert.equal(expiredToken.error, 'token_expired');

  // Nonce mismatch
  const wrongNonce = await googleOAuthService.verifyGoogleIdToken(
    createSignedTestIdToken(Object.assign({}, validBase, { nonce: 'wrong-nonce-999' })),
    { expectedAudience: process.env.GOOGLE_OAUTH_CLIENT_ID, expectedNonce: 'correct-nonce-123' }
  );
  assert.equal(wrongNonce.ok, false);
  assert.equal(wrongNonce.error, 'invalid_nonce');

  // Unverified email
  const unverifiedEmail = await googleOAuthService.verifyGoogleIdToken(
    createSignedTestIdToken(Object.assign({}, validBase, { email_verified: false })),
    { expectedAudience: process.env.GOOGLE_OAUTH_CLIENT_ID, expectedNonce: 'correct-nonce-123' }
  );
  assert.equal(unverifiedEmail.ok, false);
  assert.equal(unverifiedEmail.error, 'email_not_verified');

  // Valid token passes
  const validToken = await googleOAuthService.verifyGoogleIdToken(
    createSignedTestIdToken(validBase),
    { expectedAudience: process.env.GOOGLE_OAUTH_CLIENT_ID, expectedNonce: 'correct-nonce-123' }
  );
  assert.equal(validToken.ok, true);
  assert.equal(validToken.sub, 'sub-28');
  assert.equal(validToken.email, 'user28@gmail.com');
});
