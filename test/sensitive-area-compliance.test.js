'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const landingShowcase = require('../lib/landing-showcase-service');
const { verifyRecaptcha, RECAPTCHA_SCORE_THRESHOLD } = require('../lib/recaptcha-verify');

const accountCenterSource = fs.readFileSync(path.join(root, 'public', 'account-center-v1.js'), 'utf8');
const lazyLoaderSource = fs.readFileSync(path.join(root, 'public', 'account-center-lazy-loader-v1.js'), 'utf8');
const manualPaymentSource = fs.readFileSync(path.join(root, 'public', 'subscription-manual-payment-v1.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const loginUserSource = fs.readFileSync(path.join(root, 'api', 'login-user.js'), 'utf8');
const registerUserSource = fs.readFileSync(path.join(root, 'api', 'register-user.js'), 'utf8');

test('Item 6.1: Landing showcase service outputs sanitized read-only review data', async () => {
  const mockSupabase = {
    from(table) {
      if (table === 'sector_hot_latest') {
        return {
          select() {
            return {
              order() {
                return {
                  limit() {
                    return Promise.resolve({
                      data: [
                        { group_code: 'IDXBASIC', group_name: 'Basic Materials', score: 8.5, avg_change_pct: 1.45, calculated_at: new Date().toISOString() }
                      ],
                      error: null
                    });
                  }
                };
              }
            };
          }
        };
      }
      if (table === 'telegram_daily_picks') {
        return {
          select() {
            return {
              gte() {
                return {
                  order() {
                    return {
                      limit() {
                        return Promise.resolve({
                          data: [
                            {
                              ticker: 'BRPT',
                              raw_payload: JSON.stringify({ signal_type: 'DT', entry: 1200, tp: 1280, sl: 1160, rr: 2.0, secret_token: 'LEAK_ME' }),
                              created_at: new Date().toISOString()
                            }
                          ],
                          error: null
                        });
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }
      if (table === 'kv_store') {
        return {
          upsert() { return Promise.resolve({ error: null }); }
        };
      }
      throw new Error('Unexpected table ' + table);
    }
  };

  const res = await landingShowcase.refreshSnapshot(mockSupabase);
  assert.equal(res.ok, true);
  assert.ok(res.snapshot);
  assert.equal(res.snapshot.source, 'review_data');
  assert.equal(res.snapshot.sectors[0].code, 'IDXBASIC');
  assert.equal(res.snapshot.dt_signals[0].ticker, 'BRPT');
  assert.equal(res.snapshot.dt_signals[0].secret_token, undefined);
  assert.equal(res.snapshot.dt_signals[0].user_id, undefined);
  assert.equal(res.snapshot.dt_signals[0].password_hash, undefined);
});

function assertSingleRegistrationConsent(html, account, lazy, server) {
  const form = html.match(/<form\b[^>]*\bid="registerFormFields"[^>]*>([\s\S]*?)<\/form>/);
  assert.ok(form, 'native registration form exists');
  const inputs = form[1].match(/<input\b[^>]*\btype="checkbox"[^>]*>/g) || [];
  assert.equal(inputs.length, 1, 'one visible native consent owner');
  assert.match(inputs[0], /\bid="regTermsAccepted"/);
  assert.equal((html.match(/\bid="regTermsAccepted"/g) || []).length, 1);
  assert.match(form[1], /<button\b[^>]*id="regOpenTerms"[^>]*>Syarat &amp; Ketentuan Layanan Auto-Cuan<\/button>/);
  for (const source of [account, lazy]) assert.doesNotMatch(source, /acRegTermsAccepted/, 'Account Center must not inject another registration consent');
  const start = server.indexOf('const termsAcceptance = accountTerms.registrationAcceptance(req.body);');
  const end = server.indexOf('// Ensure we always have a non-null device ID', start);
  assert.ok(start >= 0 && end > start, 'server acceptance guard exists');
  const guard = new Function('req', 'res', 'accountTerms', server.slice(start, end) + '\nreturn { allowed: true };');
  const terms = require('../lib/account-terms');
  const decide = body => guard({ body }, { status(status) { return { json(payload) { return { status, payload }; } }; } }, terms);
  for (const body of [{}, { termsAccepted: false, termsVersion: terms.CURRENT_TERMS_VERSION }, { termsAccepted: true, termsVersion: 'obsolete' }]) {
    const result = decide(body); assert.equal(result.status, 400); assert.equal(result.payload.code, 'TERMS_ACCEPTANCE_REQUIRED');
  }
  assert.equal(decide({ termsAccepted: true, termsVersion: terms.CURRENT_TERMS_VERSION }).allowed, true);
}
test('Item 6.3: one authoritative native registration consent, server validation and independent payment terms', () => {
  assertSingleRegistrationConsent(indexSource, accountCenterSource, lazyLoaderSource, registerUserSource);
  assert.match(accountCenterSource, /Saya memahami Kebijakan Pembayaran, Refund, dan Disclaimer Risiko Finansial/);
  assert.match(manualPaymentSource, /Saya memahami Kebijakan Pembayaran, Refund, dan Disclaimer Risiko Finansial/);
  assert.doesNotMatch(accountCenterSource, /var TERMS_EFFECTIVE/);
  assert.doesNotMatch(accountCenterSource, /16 Agustus 2026/);
});
test('registration consent negative controls detect missing/duplicate owners and missing server enforcement', () => {
  const check = (html, account = accountCenterSource, server = registerUserSource) => assertSingleRegistrationConsent(html, account, lazyLoaderSource, server);
  const input = indexSource.match(/<input\b[^>]*id="regTermsAccepted"[^>]*>/)[0];
  assert.throws(() => check(indexSource.replace(input, '')), assert.AssertionError);
  assert.throws(() => check(indexSource.replace(input, input + input.replace('regTermsAccepted', 'duplicateConsent'))), assert.AssertionError);
  assert.throws(() => check(indexSource, accountCenterSource + ' acRegTermsAccepted'), assert.AssertionError);
  assert.throws(() => check(indexSource, accountCenterSource, registerUserSource.replace('if (!termsAcceptance.ok)', 'if (false)')), assert.AssertionError);
});

test('Item 6.5: reCAPTCHA v3 verification logic, fail-open, review bypass', async () => {
  const reviewRes = await verifyRecaptcha({ username: 'review', token: '' });
  assert.equal(reviewRes.ok, true);
  assert.equal(reviewRes.bypassed, true);
  assert.equal(reviewRes.score, 1.0);

  const origSecret = process.env.RECAPTCHA_SECRET_KEY;
  delete process.env.RECAPTCHA_SECRET_KEY;
  try {
    const unconfiguredRes = await verifyRecaptcha({ username: 'normal_user', token: 'fake_tok' });
    assert.equal(unconfiguredRes.ok, true);
    assert.equal(unconfiguredRes.failOpen, true);
    assert.equal(unconfiguredRes.score, 1.0);
  } finally {
    if (origSecret) process.env.RECAPTCHA_SECRET_KEY = origSecret;
  }

  assert.match(loginUserSource, /verifyRecaptcha/);
  assert.match(loginUserSource, /usernameLower/);
  assert.match(registerUserSource, /verifyRecaptcha/);
});
