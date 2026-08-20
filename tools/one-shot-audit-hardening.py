from pathlib import Path
import re


def once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, got {count}')
    return text.replace(old, new, 1)


def regex_once(text, pattern, repl, label, flags=0):
    out, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label}: expected one regex match, got {count}')
    return out

# ------------------------------------------------------------------
# Active login path: route through the device-bound login handler.
# ------------------------------------------------------------------
p = Path('api/reset-password.js')
s = p.read_text()
s = once(s,
    "const accountProfileHandler = require('../lib/account-profile-handler');\n",
    "const accountProfileHandler = require('../lib/account-profile-handler');\nconst loginUserHandler = require('./login-user');\n",
    'reset gateway login import')
s = once(s,
    "  if (req.method === 'POST' && bodyAction === 'admin-command-device-poll') {\n",
    "  if (req.method === 'POST' && bodyAction === 'login') {\n    return loginUserHandler(req, res);\n  }\n  if (req.method === 'POST' && bodyAction === 'admin-command-device-poll') {\n",
    'reset gateway login route')
p.write_text(s)

# Browser keeps a stable random ID per browser profile and sends it on login.
p = Path('public/auth-v2.js')
s = p.read_text()
s = once(s,
    "  var retryTimer = null;\n" if "  var retryTimer = null;\n" in s else "  var authReadyResolve;\n",
    ("  var retryTimer = null;\n" if "  var retryTimer = null;\n" in s else "  var authReadyResolve;\n") +
    "\n  function loginDeviceId() {\n"
    "    var key = 'autocuan_login_device_id_v1';\n"
    "    try {\n"
    "      var current = String(localStorage.getItem(key) || '').trim();\n"
    "      if (/^[A-Za-z0-9_-]{16,128}$/.test(current)) return current;\n"
    "      var id = '';\n"
    "      if (window.crypto && typeof window.crypto.randomUUID === 'function') id = 'dev_' + window.crypto.randomUUID().replace(/-/g, '');\n"
    "      else if (window.crypto && typeof window.crypto.getRandomValues === 'function') {\n"
    "        var bytes = new Uint8Array(18); window.crypto.getRandomValues(bytes);\n"
    "        id = 'dev_' + Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');\n"
    "      }\n"
    "      if (!id) return '';\n"
    "      localStorage.setItem(key, id);\n"
    "      return id;\n"
    "    } catch (_) { return ''; }\n"
    "  }\n",
    'auth-v2 device helper')
s = once(s,
    "        passwordHash: passwordHash,\n        userAgent: navigator.userAgent\n",
    "        passwordHash: passwordHash,\n        deviceId: loginDeviceId(),\n        userAgent: navigator.userAgent\n",
    'auth-v2 login device payload')
p.write_text(s)

# ------------------------------------------------------------------
# Server-side KDF: stored DB credential is no longer replayable client hash.
# ------------------------------------------------------------------
p = Path('api/login-user.js')
s = p.read_text()
s = once(s,
    "const securityGuard = require('../lib/security-guard');\n",
    "const securityGuard = require('../lib/security-guard');\nconst passwordCredential = require('../lib/password-credential');\n",
    'login credential import')
s = once(s,
    "    const databasePasswordMatches = user.password_hash === passwordHash;\n",
    "    const credentialCheck = passwordCredential.verifyStoredCredential(user.password_hash, passwordHash);\n    const databasePasswordMatches = credentialCheck.ok;\n",
    'login credential verify')
needle = """      return res.status(400).json({ success: false, error: GENERIC_CREDENTIAL_ERROR });
    }

"""
pos = s.find(needle, s.find('const credentialCheck'))
if pos < 0:
    raise SystemExit('login post-password-failure anchor not found')
pos += len(needle)
upgrade = """    // Transparent migration: legacy rows stored the client SHA-256 prehash itself,
    // which made a DB read equivalent to a login credential. After successful
    // verification, replace it with a salted server-side scrypt credential.
    if (credentialCheck.needsUpgrade) {
      try {
        const protectedCredential = passwordCredential.protectClientHash(passwordHash);
        const upgraded = await supabase
          .from('app_users')
          .update({ password_hash: protectedCredential })
          .eq('id', user.id)
          .eq('password_hash', user.password_hash);
        if (upgraded.error) console.error('login-user credential migration failed');
      } catch (_) {
        console.error('login-user credential migration failed');
      }
    }

"""
s = s[:pos] + upgrade + s[pos:]
p.write_text(s)

p = Path('api/register-user.js')
s = p.read_text()
s = once(s,
    "const accountTerms = require('../lib/account-terms');\n",
    "const accountTerms = require('../lib/account-terms');\nconst passwordCredential = require('../lib/password-credential');\n",
    'register credential import')
s = once(s,
    "        passwordHash: passwordHash,\n        deviceId: normalizedDeviceId,\n",
    "        passwordHash: passwordCredential.protectClientHash(passwordHash),\n        deviceId: normalizedDeviceId,\n",
    'register protected credential')
p.write_text(s)

p = Path('lib/reset-password-legacy-handler.js')
s = p.read_text()
s = once(s,
    "const { generateApprovalCode, maskUsername } = require('../lib/free-user-approval');\n",
    "const { generateApprovalCode, maskUsername } = require('../lib/free-user-approval');\nconst passwordCredential = require('./password-credential');\n",
    'reset credential import')
s = once(s,
    "    p_new_password_hash: newPasswordHash\n",
    "    p_new_password_hash: passwordCredential.protectClientHash(newPasswordHash)\n",
    'reset protected credential')
p.write_text(s)

# Security guard should enforce when its DB support is configured; explicit env
# can still choose shadow/off for controlled diagnostics.
p = Path('lib/security-guard.js')
s = p.read_text()
s = once(s,
    "SECURITY_GUARD_MODE || 'off'",
    "SECURITY_GUARD_MODE || 'enforce'",
    'security guard default')
p.write_text(s)

# ------------------------------------------------------------------
# Optimistic concurrency for portfolio cloud state.
# ------------------------------------------------------------------
p = Path('lib/portfolio-state-handler.js')
s = p.read_text()
new_save = r'''async function saveState(req, res, supabase, account) {
  let state;
  try {
    state = normalizePortfolioState(req.body && req.body.portfolio_state);
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, error: error.message });
  }

  const expectedUpdatedAt = String(req.body && req.body.expected_updated_at || '').trim();
  if (!expectedUpdatedAt) {
    return res.status(409).json({
      success: false,
      code: 'PORTFOLIO_STATE_CONFLICT',
      error: 'Versi portofolio cloud belum diketahui. Muat ulang sebelum menyimpan.'
    });
  }

  const updatedAt = new Date().toISOString();
  const result = await supabase
    .from('app_user_portfolio_state')
    .update({ state, updated_at: updatedAt })
    .eq('user_id', account.id)
    .eq('updated_at', expectedUpdatedAt)
    .select('updated_at')
    .maybeSingle();

  if (result.error) {
    console.error('portfolio state save error:', result.error);
    return res.status(503).json({ success: false, error: 'Portofolio belum berhasil disimpan ke cloud.' });
  }

  if (!result.data) {
    const latest = await supabase
      .from('app_user_portfolio_state')
      .select('updated_at')
      .eq('user_id', account.id)
      .maybeSingle();
    return res.status(409).json({
      success: false,
      code: 'PORTFOLIO_STATE_CONFLICT',
      error: 'Portofolio berubah di perangkat lain. Perubahan lokal tidak ditimpa.',
      current_updated_at: latest && latest.data ? latest.data.updated_at : null
    });
  }

  return res.status(200).json({
    success: true,
    storage: 'supabase',
    user_id: account.id,
    access_level: account.access_level,
    updated_at: result.data.updated_at || updatedAt
  });
}

async function portfolioStateHandler'''
s = regex_once(s, r"async function saveState\(req, res, supabase, account\) \{.*?\n\}\n\nasync function portfolioStateHandler", new_save, 'portfolio save function', re.S)
p.write_text(s)

p = Path('public/portfolio-supabase-sync.js')
s = p.read_text()
s = once(s,
    "  var retryTimer = null;\n",
    "  var retryTimer = null;\n  var cloudRevision = null;\n",
    'portfolio revision var')
s = once(s,
    "      applyRemoteState(uid, data.state || {});\n      hydrated = true;\n",
    "      applyRemoteState(uid, data.state || {});\n      cloudRevision = String(data.updated_at || '').trim() || null;\n      hydrated = true;\n",
    'portfolio hydrate revision')
s = once(s,
    "      await post('portfolio-state-save', { portfolio_state: snapshot });\n",
    "      var saveData = await post('portfolio-state-save', { portfolio_state: snapshot, expected_updated_at: cloudRevision });\n      cloudRevision = String(saveData.updated_at || '').trim() || cloudRevision;\n",
    'portfolio save revision')
old_catch = """    } catch (error) {
      dirty = true;
      setStatus('local-fallback', error && error.message || 'Belum tersimpan ke cloud');
      setTimeout(scheduleSave, 2500);
      return false;
"""
new_catch = """    } catch (error) {
      dirty = true;
      if (error && error.status === 409) {
        // Do not auto-overwrite a newer cloud revision. Keep the local edits in
        // this browser and stop retrying until a deliberate reload/reconciliation.
        setStatus('conflict', error.message || 'Portofolio berubah di perangkat lain. Muat ulang untuk rekonsiliasi.');
        return false;
      }
      setStatus('local-fallback', error && error.message || 'Belum tersimpan ke cloud');
      setTimeout(scheduleSave, 2500);
      return false;
"""
s = once(s, old_catch, new_catch, 'portfolio conflict catch')
s = once(s,
    "      var remote = normalizeState(data.state || {});\n",
    "      cloudRevision = String(data.updated_at || '').trim() || cloudRevision;\n      var remote = normalizeState(data.state || {});\n",
    'portfolio refresh revision')
s = once(s,
    "        body: JSON.stringify({ action: 'portfolio-state-save', portfolio_state: readLocalState(uid) })\n",
    "        body: JSON.stringify({ action: 'portfolio-state-save', portfolio_state: readLocalState(uid), expected_updated_at: cloudRevision })\n",
    'portfolio pagehide revision')
p.write_text(s)

# ------------------------------------------------------------------
# CRON secret only in Authorization header; never request URL.
# Also make daily-pick rows carry the plan identity whenever derivable so they
# actually participate in the DB partial unique index.
# ------------------------------------------------------------------
p = Path('api/sector-hot.js')
s = p.read_text()
s = once(s,
    """  var querySecret = req && req.query ? String(req.query.secret || '').trim() : '';
  if (querySecret && querySecret === secret) return true;
  if (!token) return false;
  return token === secret;
""",
    """  if (!token) return false;
  const tokenBuf = Buffer.from(token, 'utf8');
  const secretBuf = Buffer.from(secret, 'utf8');
  if (tokenBuf.length !== secretBuf.length) return false;
  return crypto.timingSafeEqual(tokenBuf, secretBuf);
""",
    'cron query secret')
old_row = """function dailyPickInsertRowFromCandidate(candidate, date, firstSentAt) {
  return { date: date, ticker: candidate.ticker, category: candidate.category, entry1: candidate.entry1, entry2: candidate.entry2, tp1: candidate.tp1n, tp2: candidate.tp2n, sl: candidate.sl, status: 'WAITING', first_sent_at: firstSentAt || null, raw_payload: candidate };
}
"""
new_row = """function dailyPickInsertRowFromCandidate(candidate, date, firstSentAt) {
  candidate = candidate || {};
  var row = { date: date, ticker: candidate.ticker, category: candidate.category, entry1: candidate.entry1, entry2: candidate.entry2, tp1: candidate.tp1n, tp2: candidate.tp2n, sl: candidate.sl, status: 'WAITING', first_sent_at: firstSentAt || null, raw_payload: candidate };
  // The DB uniqueness guarantee is intentionally partial and only applies when
  // both identity fields are non-null. Populate them at the shared row-builder
  // boundary so lock-only/fallback inserts cannot silently bypass that index.
  var identity = buildMonitorPlanIdentity(candidate, date, candidate.monitor_source || candidate.category || 'daily_top5');
  if (identity && identity.valid) {
    row.monitor_source = identity.monitor_source;
    row.plan_lock_id = identity.plan_lock_id;
  }
  return row;
}
"""
s = once(s, old_row, new_row, 'daily pick row identity')
p.write_text(s)

# ------------------------------------------------------------------
# Focused source-contract regressions.
# ------------------------------------------------------------------
Path('test/audit-auth-device-route.test.js').write_text(r'''\
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('active auth-v2 login sends stable device identity and gateway uses hardened login', () => {
  const client = fs.readFileSync('public/auth-v2.js', 'utf8');
  const gateway = fs.readFileSync('api/reset-password.js', 'utf8');
  assert.match(client, /deviceId:\s*loginDeviceId\(\)/);
  assert.match(gateway, /bodyAction === 'login'/);
  assert.match(gateway, /return loginUserHandler\(req, res\)/);
});

test('new and reset passwords are protected server-side before DB storage', () => {
  const register = fs.readFileSync('api/register-user.js', 'utf8');
  const reset = fs.readFileSync('lib/reset-password-legacy-handler.js', 'utf8');
  const login = fs.readFileSync('api/login-user.js', 'utf8');
  assert.match(register, /protectClientHash\(passwordHash\)/);
  assert.match(reset, /protectClientHash\(newPasswordHash\)/);
  assert.match(login, /verifyStoredCredential\(user\.password_hash, passwordHash\)/);
  assert.match(login, /credentialCheck\.needsUpgrade/);
});
''')

Path('test/audit-portfolio-concurrency.test.js').write_text(r'''\
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
''')

Path('test/audit-cron-and-top5-lock.test.js').write_text(r'''\
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('api/sector-hot.js', 'utf8');

test('CRON_SECRET is accepted only from Bearer authorization, not query string', () => {
  const start = source.indexOf('function verifyCronSecret(req)');
  const end = source.indexOf('function isWithinNkRunWindow', start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /req\.query\.secret|querySecret/);
  assert.match(block, /authorization/);
  assert.match(block, /timingSafeEqual/);
});

test('shared daily-pick row builder populates DB lock identity when derivable', () => {
  const start = source.indexOf('function dailyPickInsertRowFromCandidate');
  const end = source.indexOf('function normalizeMonitorSourceValue', start);
  const block = source.slice(start, end);
  assert.match(block, /buildMonitorPlanIdentity/);
  assert.match(block, /row\.monitor_source = identity\.monitor_source/);
  assert.match(block, /row\.plan_lock_id = identity\.plan_lock_id/);
});
''')
