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

function publicTermsMetadata() {
  return {
    version: CURRENT_TERMS_VERSION,
    title: TERMS_TITLE,
    effective_date: TERMS_EFFECTIVE_DATE
  };
}

module.exports = {
  CURRENT_TERMS_VERSION,
  TERMS_TITLE,
  TERMS_EFFECTIVE_DATE,
  registrationAcceptance,
  publicTermsMetadata
};
