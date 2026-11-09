'use strict';

/**
 * lib/secret-redaction.js — central secret redaction layer.
 *
 * Used by api/log.js ingestion, console wrappers, and the Telegram dry-run sink.
 * See module header there for full contract; this module is the single source
 * of masking rules:
 *   - Key-based: any field whose key matches /token|secret|key|password|authorization|cookie/i
 *     is masked (first4...last4 when >= 16 chars, else [REDACTED]).
 *   - Value-shaped: bearer schemes, Telegram bot tokens, and secret-ish
 *     key=value / key: value pairs embedded in free text.
 * Never throws; safe on circular structures.
 */

const SECRET_KEY_RE = /(token|secret|key|password|authorization|cookie)/i;
const REDACTED = '[REDACTED]';

function maskLong(value) {
  const s = String(value);
  if (s.length >= 16) return s.slice(0, 4) + '...' + s.slice(-4);
  return REDACTED;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    (v.constructor === Object || v.constructor === undefined || Object.getPrototypeOf(v) === Object.prototype ||
     Object.getPrototypeOf(v) === null);
}

function redactValue(key, value, depth, seen) {
  depth = depth || 0;
  seen = seen || new WeakSet();
  try {
    if (value === null || value === undefined) return value;
    if (typeof key === 'string' && SECRET_KEY_RE.test(key)) {
      if (typeof value === 'string') return maskLong(value);
      if (typeof value === 'number' || typeof value === 'boolean') return REDACTED;
    }
    if (depth > 12) return '[MAX_DEPTH]';
    if (Array.isArray(value)) {
      if (seen.has(value)) return '[CIRCULAR]';
      seen.add(value);
      return value.map(function (v) { return redactValue(key, v, depth + 1, seen); });
    }
    if (isPlainObject(value) || (typeof value === 'object' && !(value instanceof Date) && !(value instanceof RegExp))) {
      if (seen.has(value)) return '[CIRCULAR]';
      seen.add(value);
      const out = {};
      for (const k of Object.keys(value)) {
        try { out[k] = redactValue(k, value[k], depth + 1, seen); }
        catch (_) { out[k] = REDACTED; }
      }
      return out;
    }
    if (value instanceof Error) {
      return { name: value.name, message: redactString(value.message), stack: redactString(String(value.stack || '')) };
    }
    return value;
  } catch (_) {
    return REDACTED;
  }
}

function redactString(str) {
  let s = String(str == null ? '' : str);
  try {
    s = s.replace(/(bearer|basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi, function (m, scheme) {
      return scheme + ' ' + maskLong(m.split(/\s+/)[1]);
    });
    s = s.replace(/bot(\d{6,}:[A-Za-z0-9_\-]{20,})/g, function (m, tok) {
      return 'bot' + maskLong(tok);
    });
    s = s.replace(
      /([A-Za-z0-9_]*(?:token|secret|key|password|authorization|cookie)[A-Za-z0-9_]*)\s*([=:])\s*("?)[^\s"',;\\]{4,}(\3)/gi,
      function (m, k, sep, q) { return k + sep + ' ' + q + REDACTED + q; }
    );
    return s;
  } catch (_) {
    return REDACTED;
  }
}

function redactObject(obj) {
  return redactValue('', obj, 0, new WeakSet());
}

function safeStringify(obj) {
  try {
    return JSON.stringify(redactObject(obj));
  } catch (_) {
    return JSON.stringify({ redacted: true });
  }
}

function redactIngestedText(str, maxLen) {
  let s = redactString(str);
  if (typeof maxLen === 'number' && maxLen >= 0) s = s.slice(0, maxLen);
  return s;
}

const consolePatched = Symbol.for('autocuan.secret-redaction.installed');

function installConsoleRedaction(opts) {
  const o = opts || {};
  const c = console;
  if (c[consolePatched] && !o.force) return false;
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  for (const m of methods) {
    if (typeof c[m] !== 'function') continue;
    const original = c[m].bind(c);
    c[m] = function (...args) {
      const safe = args.map(function (a) {
        if (typeof a === 'string') return redactString(a);
        if (a instanceof Error) {
          const err = new Error(redactString(a.message));
          err.stack = redactString(String(a.stack || ''));
          return err;
        }
        return redactValue('', a, 0, new WeakSet());
      });
      original(...safe);
    };
  }
  try { c[consolePatched] = true; } catch (_) {}
  return true;
}

module.exports = {
  SECRET_KEY_RE,
  REDACTED,
  maskLong,
  redactValue,
  redactString,
  redactObject,
  safeStringify,
  redactIngestedText,
  installConsoleRedaction
};
