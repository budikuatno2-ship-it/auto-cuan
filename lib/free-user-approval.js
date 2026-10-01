'use strict';

const crypto = require('crypto');

// ===========================================================================
// Version scope
// ---------------------------------------------------------------------------
// v1 (this module): AC-XXXXXX is a deterministic, PUBLIC RECOGNITION CODE only.
// It helps a user and an admin refer to the same pending registration. It is
// NOT a secret, NOT an authentication credential, NOT a session token, and it
// grants no access on its own. It is derived from non-sensitive, immutable
// identifiers and never from a password, hash, device id, or session.
//
// v2 (NOT implemented here, explicitly out of scope): secure self-service
// verification will require a SEPARATE one-time SECRET verification code and a
// dedicated flow. v2 is the only place that may introduce a Telegram bot
// webhook, code entry through a bot, Telegram user-id binding, channel
// membership verification, or invite-link generation. None of those exist in
// v1, and v1 adds no new SQL columns or tables. Do not treat the v1 recognition
// code as if it were the v2 secret verification code.
// ===========================================================================

/**
 * Build a deterministic public recognition code for a free-user registration.
 * This code is not a credential, session token, or authentication factor.
 */
function generateApprovalCode(user) {
  user = user || {};

  var immutableId = user.id == null ? '' : String(user.id).trim();
  var source;
  if (immutableId) {
    source = 'id:' + immutableId;
  } else {
    var username = user.username == null ? '' : String(user.username).trim().toLowerCase();
    var createdAt = user.created_at instanceof Date
      ? user.created_at.toISOString()
      : (user.created_at == null ? '' : String(user.created_at).trim());
    if (!username || !createdAt) {
      throw new TypeError('Approval code requires an immutable user id or username with created_at.');
    }
    source = 'fallback:' + username + '|' + createdAt;
  }

  var digest = crypto
    .createHash('sha256')
    .update('auto-cuan-free-user-approval-v1|' + source, 'utf8')
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
  return 'AC-' + digest;
}

function maskUsername(rawUsername) {
  // Usernames predate a strict character allowlist, so remove characters that
  // could inject lines or alter text direction in a public Telegram message.
  var safeUsername = rawUsername == null ? '' : String(rawUsername).trim();
  safeUsername = safeUsername.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, '');
  var chars = Array.from(safeUsername);
  if (chars.length === 0) return '*';
  if (chars.length === 1) return '*';
  if (chars.length === 2) return chars[0] + '*';
  if (chars.length === 3) return chars[0] + '*' + chars[2];
  return chars[0] + chars[1] + '*'.repeat(chars.length - 3) + chars[chars.length - 1];
}

function normalizeTelegramChannelUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    var parsed = new URL(rawUrl.trim());
    var host = parsed.hostname.toLowerCase();
    var isTelegramHost = host === 't.me' || host === 'telegram.me' || host === 'www.telegram.me';
    if (parsed.protocol !== 'https:' || !isTelegramHost || !parsed.pathname || parsed.pathname === '/') return null;
    return parsed.toString();
  } catch (e) {
    return null;
  }
}

module.exports = {
  generateApprovalCode: generateApprovalCode,
  maskUsername: maskUsername,
  normalizeTelegramChannelUrl: normalizeTelegramChannelUrl
};
