'use strict';

const CURRENT_TERMS_VERSION = '2026-08-16-v1';
const TERMS_TITLE = 'Peraturan & Ketentuan Penggunaan Auto-Cuan';
const TERMS_EFFECTIVE_DATE = '2026-08-16';

function registrationAcceptance(body) {
  const input = body && typeof body === 'object' ? body : {};
  const accepted = input.termsAccepted === true;
  const version = typeof input.termsVersion === 'string' ? input.termsVersion.trim() : '';
  return {
    ok: accepted && version === CURRENT_TERMS_VERSION,
    accepted,
    version
  };
}

function paymentAcceptance(body) {
  const input = body && typeof body === 'object' ? body : {};
  const accepted = input.paymentTermsAccepted === true || input.termsAccepted === true;
  const version = typeof input.termsVersion === 'string' ? input.termsVersion.trim() : '';
  return {
    ok: accepted && version === CURRENT_TERMS_VERSION,
    accepted,
    version
  };
}

async function recordTermsAcceptance(db, userId, source) {
  if (!db || !userId) return false;
  try {
    const validSources = new Set(['registration', 'profile', 'payment', 'voucher']);
    const safeSource = validSources.has(source) ? source : 'profile';
    const res = await db.from('account_terms_acceptances').upsert({
      user_id: userId,
      terms_version: CURRENT_TERMS_VERSION,
      acceptance_source: safeSource,
      accepted_at: new Date().toISOString()
    }, { onConflict: 'user_id,terms_version,acceptance_source' });
    if (res.error) {
      // Fallback in case unique index has not been updated yet
      await db.from('account_terms_acceptances').insert({
        user_id: userId,
        terms_version: CURRENT_TERMS_VERSION,
        acceptance_source: safeSource
      });
    }
    return true;
  } catch (_) {
    return false;
  }
}

function publicTermsMetadata() {
  return {
    version: CURRENT_TERMS_VERSION,
    title: TERMS_TITLE
  };
}

module.exports = {
  CURRENT_TERMS_VERSION,
  TERMS_TITLE,
  TERMS_EFFECTIVE_DATE,
  registrationAcceptance,
  paymentAcceptance,
  recordTermsAcceptance,
  publicTermsMetadata
};
