'use strict';

/**
 * Google reCAPTCHA v3 Invisible Verifier
 *
 * Security Requirements:
 * - Minimum score threshold: 0.5
 * - Fail-open: If Google reCAPTCHA endpoint times out (3000ms), encounters network error,
 *   or RECAPTCHA_SECRET_KEY is not configured, allow the request through so genuine users
 *   are never locked out.
 * - Bypass: Account 'review' is automatically bypassed.
 */

const RECAPTCHA_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';
const DEFAULT_TIMEOUT_MS = 3000;
const RECAPTCHA_SCORE_THRESHOLD = 0.5;

function getSecretKey() {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  return (typeof secret === 'string' && secret.trim().length > 0) ? secret.trim() : null;
}

/**
 * Verify reCAPTCHA token against Google's API.
 *
 * @param {object} opts
 * @param {string} [opts.token]
 * @param {string} [opts.remoteIp]
 * @param {string} [opts.expectedAction]
 * @param {string} [opts.username]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok: boolean, score: number, failOpen?: boolean, bypassed?: boolean, error?: string, raw?: object}>}
 */
async function verifyRecaptcha(opts) {
  const options = opts || {};
  const username = String(options.username || '').trim().toLowerCase();

  // 1. Automatic bypass for user 'review'
  if (username === 'review') {
    return { ok: true, score: 1.0, bypassed: true, reason: 'review_bypass' };
  }

  const secretKey = getSecretKey();
  // 2. Fail-open if RECAPTCHA_SECRET_KEY is not configured
  if (!secretKey) {
    return { ok: true, score: 1.0, failOpen: true, reason: 'unconfigured_secret' };
  }

  const token = typeof options.token === 'string' ? options.token.trim() : '';
  if (!token) {
    return { ok: false, score: 0.0, error: 'Token reCAPTCHA tidak ditemukan.' };
  }

  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let signal;
  try {
    signal = AbortSignal.timeout(timeoutMs);
  } catch (_) {
    signal = undefined;
  }

  try {
    const params = new URLSearchParams();
    params.append('secret', secretKey);
    params.append('response', token);
    if (options.remoteIp) {
      params.append('remoteip', options.remoteIp);
    }

    const response = await fetch(RECAPTCHA_VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString(),
      signal: signal
    });

    if (!response.ok) {
      return { ok: true, score: 1.0, failOpen: true, reason: 'http_error_' + response.status };
    }

    const data = await response.json();
    if (!data || data.success !== true) {
      return {
        ok: false,
        score: typeof data?.score === 'number' ? data.score : 0.0,
        error: 'Verifikasi reCAPTCHA gagal.',
        raw: data
      };
    }

    const score = typeof data.score === 'number' ? data.score : 1.0;
    if (score < RECAPTCHA_SCORE_THRESHOLD) {
      return {
        ok: false,
        score: score,
        error: 'Skor keamanan interaksi tidak mencukupi (bot terdeteksi).',
        raw: data
      };
    }

    return {
      ok: true,
      score: score,
      action: data.action,
      raw: data
    };
  } catch (err) {
    return {
      ok: true,
      score: 1.0,
      failOpen: true,
      reason: 'network_fail_open'
    };
  }
}

module.exports = {
  verifyRecaptcha,
  RECAPTCHA_SCORE_THRESHOLD,
  DEFAULT_TIMEOUT_MS
};
