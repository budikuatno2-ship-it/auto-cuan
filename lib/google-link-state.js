'use strict';

async function readGoogleLinkState(db, account) {
  const exempt = ['budi', 'review'].includes(String(account.username || '').toLowerCase());
  try {
    const result = await db.from('app_user_google_links')
      .select('*').eq('user_id', account.id).maybeSingle();
    if (!result || result.error || result.data === undefined) throw new Error('Google-link lookup unavailable');
    const row = result.data;
    const linked = Boolean(row && row.unlinked_at == null);
    return { state: linked ? 'linked' : (exempt ? 'exempt' : 'unlinked'), linked, required: !linked && !exempt, row };
  } catch (_) {
    // Unknown link state must not become a mandatory onboarding decision.
    return { state: 'unavailable', linked: null, required: false, row: null };
  }
}

module.exports = { readGoogleLinkState };
