'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const uiThemeCss = fs.readFileSync(path.join(root, 'public', 'ui-theme.css'), 'utf8');
const landingCss = fs.readFileSync(path.join(root, 'public', 'landing-experience.css'), 'utf8');
const accountCenterCss = fs.readFileSync(path.join(root, 'public', 'account-center-v1.css'), 'utf8');
const accountHardeningCss = fs.readFileSync(path.join(root, 'public', 'account-hardening.css'), 'utf8');
const authV2Js = fs.readFileSync(path.join(root, 'public', 'auth-v2.js'), 'utf8');
const accountCenterJs = fs.readFileSync(path.join(root, 'public', 'account-center-v1.js'), 'utf8');
const legacyGmailJs = fs.readFileSync(path.join(root, 'public', 'legacy-gmail-runtime.js'), 'utf8');

// ===========================================================================
// WAVE 8 — 1. AUTHENTICATION SURFACES & TOP-LEVEL MODALS
// ===========================================================================

test('auth modals are direct top-level siblings outside #dashboardScreen', () => {
  const dashIndex = html.indexOf('<div id="dashboardScreen"');
  assert.ok(dashIndex > 0, '#dashboardScreen must exist');

  ['authChoiceModal', 'loginModal', 'registerModal', 'selfResetModal'].forEach((id) => {
    const modalIndex = html.indexOf(`id="${id}"`);
    assert.ok(modalIndex > 0, `#${id} must exist in index.html`);
    assert.ok(modalIndex < dashIndex, `#${id} must be mounted before #dashboardScreen so inert cannot trap it`);
  });
});

test('auth modals share consistent surface tokens and safe-area padding', () => {
  assert.match(
    landingCss,
    /:is\(#loginModal,#registerModal,#selfResetModal,#resetPasswordModal,#authChoiceModal\)[^}]*padding:\s*max\(12px,\s*env\(safe-area-inset-top\)\)/,
    'modals must have safe-area padding'
  );
  assert.match(
    landingCss,
    /:is\(#loginModal,#registerModal,#selfResetModal,#resetPasswordModal,#authChoiceModal\)\s*>\s*div[^}]*background:\s*var\(--surface\)/,
    'modals must use canonical theme surface variable'
  );
});

test('auth choice modal presents calm institutional choices and compliance notice', () => {
  const choiceModal = html.slice(html.indexOf('<div id="authChoiceModal"'), html.indexOf('<!-- ===== AUTHENTICATION MODALS'));
  assert.match(choiceModal, /role="dialog"/);
  assert.match(choiceModal, /aria-modal="true"/);
  assert.match(choiceModal, /id="authChoiceTitle"/);
  assert.match(choiceModal, /id="authChoiceMessage"/);
  assert.match(choiceModal, /openLoginModal\(\)/);
  assert.match(choiceModal, /openRegisterModal\(\)/);
  assert.match(choiceModal, /Bukan rekomendasi beli\/jual\. Data bisa terlambat\. Konfirmasi manual wajib\./);
});

test('password inputs feature accessible toggle buttons with aria labels', () => {
  assert.match(html, /id="loginPasswordToggle"[^>]*aria-label="Show password"/);
  assert.match(html, /id="regPasswordToggle"[^>]*aria-label="Show password"/);
  assert.match(html, /id="regPasswordConfirmToggle"[^>]*aria-label="Show password"/);
});

// ===========================================================================
// WAVE 8 — 2. ACCOUNT CENTER & PROFILE CONTRACTS
// ===========================================================================

test('account center markup exposes profile, subscription, and terms tabs', () => {
  assert.match(accountCenterJs, /data-ac-tab="profile"/);
  assert.match(accountCenterJs, /data-ac-tab="subscription"/);
  assert.match(accountCenterJs, /data-ac-tab="terms"/);
  assert.match(accountCenterJs, /switchTab\(tab \|\| 'profile'\)/);
  assert.match(accountCenterJs, /switchTab\('subscription'\)/);
  assert.match(accountCenterJs, /switchTab\('terms'\)/);
});

test('account center displays read-only admin reference for budi without fake action triggers', () => {
  assert.match(accountCenterJs, /p\.is_admin \? adminCommandsSectionHtml\(\) : ''/);
  assert.match(accountCenterJs, /Referensi Perintah Bot Admin/);
  assert.match(accountCenterJs, /Daftar ini hanya referensi baca/);
});

test('account center light mode tokens enforce WCAG AA contrast for inline text values', () => {
  assert.match(uiThemeCss, /html\.light #acAccountCenter \.ac-card span\[style\*="6ee7b7"\]/);
  assert.match(uiThemeCss, /html\.light #acAccountCenter \.ac-card span\[style\*="93c5fd"\]/);
  assert.match(uiThemeCss, /html\.light #acAccountCenter div\[style\*="94a3b8"\]/);
  assert.match(uiThemeCss, /color:\s*#047857 !important/, 'light mode currency values must be high contrast emerald-700');
  assert.match(uiThemeCss, /color:\s*#1d4ed8 !important/, 'light mode risk values must be high contrast blue-700');
});

test('registration terms checkbox and copy adapt cleanly to light mode', () => {
  assert.match(uiThemeCss, /html\.light #acTermsRegistration/);
  assert.match(uiThemeCss, /html\.light \.ac-reg-terms-copy/);
  assert.match(uiThemeCss, /html\.light \.ac-reg-terms-link/);
  assert.match(uiThemeCss, /color:\s*#0f7458 !important/, 'terms link must be dark emerald on light surface');
});

test('account center mobile sheet defines full width and touch targets', () => {
  assert.match(accountCenterCss, /@media\s*\(max-width:\s*760px\)\s*\{[^}]*#acAccountCenter\s*\{[^}]*place-items:\s*end center/);
  assert.match(accountCenterCss, /\.ac-center-shell\s*\{[^}]*border-radius:\s*24px 24px 0 0/);
});

// ===========================================================================
// WAVE 8 — 3. LEGACY GMAIL COMPLETION FLOW
// ===========================================================================

test('legacy gmail dialog triggers when session requires email completion', () => {
  assert.match(legacyGmailJs, /root\.__AUTOCUAN_AUTHENTICATED_SESSION__\.email_required===true/);
  assert.match(legacyGmailJs, /id=['"]legacyGmailDialog['"]/);
  assert.match(legacyGmailJs, /id=['"]legacyGmailLogout['"]/);
  assert.match(legacyGmailJs, /request\(['"]account-email-complete['"]/);
});

test('legacy gmail dialog adapts to both light and dark mode with high contrast', () => {
  assert.match(uiThemeCss, /html\.light \.legacy-gmail-dialog\s*\{[^}]*background:\s*#ffffff !important/);
  assert.match(uiThemeCss, /html\.light \.legacy-gmail-dialog h2\s*\{[^}]*color:\s*#0f172a !important/);
  assert.match(uiThemeCss, /html\.light \.legacy-gmail-dialog p\s*\{[^}]*color:\s*#334155 !important/);
  assert.match(uiThemeCss, /html:not\(\.light\) \.legacy-gmail-dialog h2,\s*html\.dark \.legacy-gmail-dialog h2\s*\{[^}]*color:\s*#f1f5f9 !important/);
});

// ===========================================================================
// WAVE 8 — 4. ACCESS GATING, ADMIN GATING, AND BYOK MODAL
// ===========================================================================

test('Pattern Radar is gated by server admin status and is hidden from regular users', () => {
  assert.match(html, /id="tabAnalisisPattern"[^>]*class="sidebar-item hidden"/);
  assert.match(html, /<span class="sidebar-label">Pattern Radar<\/span><span class="sidebar-badge">ADMIN<\/span>/);
});

test('AI BYOK modal explains AES-256-GCM encryption and adapts to light mode', () => {
  assert.match(html, /id="aiApiKeyModal"/);
  assert.match(html, /AES-256-GCM/);
  assert.match(html, /Bring Your Own Key/);
  assert.match(uiThemeCss, /html\.light #aiApiKeyModal > div\s*\{[^}]*background:\s*#ffffff !important/);
  assert.match(uiThemeCss, /html\.light #aiApiKeyModal h3\s*\{[^}]*color:\s*#0f172a !important/);
});

// ===========================================================================
// WAVE 8 — 5. SESSION EXPIRY AND AUTH REDIRECTION
// ===========================================================================

test('auth-v2 session expiration clears local state and prompts auth choice modal', () => {
  assert.match(authV2Js, /result\.response\.status === 401 \|\| result\.response\.status === 403/);
  assert.match(authV2Js, /returnToGuest\(\{ skipHistory: true \}\)/);
  assert.match(authV2Js, /openAuthChoiceModal\('Sesi sudah tidak berlaku\. Silakan login kembali\.'\)/);
});

test('openAuthChoiceModal updates modal message dynamically', () => {
  assert.match(html, /function openAuthChoiceModal\(message\)\s*\{/);
  assert.match(html, /var msg = document\.getElementById\('authChoiceMessage'\);/);
  assert.match(html, /if \(msg && message\) msg\.textContent = message;/);
});

// ===========================================================================
// WAVE 8 — 6. SYSTEM LIFECYCLE & MAINTENANCE STATES
// ===========================================================================

test('maintenance screen and service status screen exist with proper ARIA semantics', () => {
  assert.match(html, /<div id="maintenanceScreen"[^>]*>/);
  assert.match(html, /<div id="serviceStatusScreen"[^>]*>/);
  assert.match(html, /id="maintenanceMessage"/);
  assert.match(html, /id="serviceStatusRetry"/);
  assert.match(html, /id="maintenanceAdminBtn"/);
  assert.match(html, /id="serviceStatusAdminBtn"/);
});

test('maintenance and service status cards adapt cleanly to light mode without dark clashing', () => {
  assert.match(uiThemeCss, /html\.light #maintenanceScreen,\s*html\.light #serviceStatusScreen,\s*html\.light #blockedScreen\s*\{[^}]*background-color:\s*#f3f5f4 !important/);
  assert.match(uiThemeCss, /html\.light \.maintenance-card\s*\{[^}]*background:\s*#ffffff !important/);
  assert.match(uiThemeCss, /html\.light \.maintenance-title\s*\{[^}]*color:\s*#0f172a !important/);
  assert.match(uiThemeCss, /html\.light \.maintenance-message\s*\{[^}]*color:\s*#334155 !important/);
  assert.match(uiThemeCss, /html\.light \.maintenance-facts\s*\{[^}]*background:\s*#f8fafc !important/);
  assert.match(uiThemeCss, /html\.light \.maintenance-facts li\s*\{[^}]*color:\s*#334155 !important/);
});

test('maintenance and service status cards preserve crisp readability in dark mode', () => {
  assert.match(uiThemeCss, /html:not\(\.light\) \.maintenance-title,\s*html\.dark \.maintenance-title\s*\{[^}]*color:\s*#f1f5f9 !important/);
  assert.match(uiThemeCss, /html:not\(\.light\) \.maintenance-message,\s*html\.dark \.maintenance-message\s*\{[^}]*color:\s*#cbd5e1 !important/);
  assert.match(uiThemeCss, /html:not\(\.light\) \.maintenance-facts li,\s*html\.dark \.maintenance-facts li\s*\{[^}]*color:\s*#94a3b8 !important/);
});

// ===========================================================================
// WAVE 8 — 7. PRESERVE FROZEN SHELL OWNERSHIP CONTRACTS (WAVES 1-7)
// ===========================================================================

test('desktop account entry remains in sidebar footer only', () => {
  assert.match(html, /<button type="button" class="user-profile-badge sidebar-profile-button"/);
  assert.match(html, /onclick="[^"]*openAccountProfile\(\)/);
});

test('mobile account entry remains in top header and mobile drawer has no duplicate account entry', () => {
  assert.match(html, /id="headerAccountSection"/);
  assert.match(html, /id="headerUserLabel"[^>]*title="Buka Profil Akun"/);
  const chatSidebar = html.slice(html.indexOf('<aside id="chatSidebar"'), html.indexOf('</aside>'));
  assert.doesNotMatch(chatSidebar, /doLogout|logoutBtn/i, 'mobile drawer must not contain duplicate logout button');
});
