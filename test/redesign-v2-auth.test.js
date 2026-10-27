const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'ui-theme.css'), 'utf8');
const authV2Js = fs.readFileSync(path.join(ROOT, 'public', 'auth-v2.js'), 'utf8');
const legacyGmailJs = fs.readFileSync(path.join(ROOT, 'public', 'legacy-gmail-runtime.js'), 'utf8');

test('Masuk (Login Modal) adheres to canvas and security specifications', () => {
  const modalStart = html.indexOf('id="loginModal"');
  assert.ok(modalStart >= 0, 'loginModal must exist');
  const modalEnd = html.indexOf('<!-- REGISTER MODAL', modalStart);
  const loginHtml = html.slice(modalStart, modalEnd);

  // Direct child of body before dashboardScreen
  const dashboardStart = html.indexOf('id="dashboardScreen"');
  assert.ok(modalStart < dashboardStart, 'loginModal must be before dashboardScreen');

  // Canvas titles and structure
  assert.match(loginHtml, /Masuk ke Auto-Cuan/);
  assert.match(loginHtml, /Akses meja kerja riset saham IDX\./);
  assert.match(loginHtml, /id="loginModalTitle"/);
  assert.match(loginHtml, /onclick="closeLoginModal\(\)"/);

  // Form inputs
  assert.match(loginHtml, /for="loginUsername"[^>]*>Email atau username<\/label>/);
  assert.match(loginHtml, /id="loginUsername"[^>]*autocomplete="username"/);
  assert.match(loginHtml, /placeholder="email atau username"/);
  assert.match(loginHtml, /Gunakan Gmail terdaftar\. Username lama masih didukung\./);

  // Password and eye toggle
  assert.match(loginHtml, /id="loginPassword"[^>]*autocomplete="current-password"/);
  assert.match(loginHtml, /id="loginPasswordToggle"/);
  assert.match(loginHtml, />Lupa Password\?</);

  // Generic credential error banner
  assert.match(loginHtml, /id="loginError"/);

  // ZERO Google login controls (owner decision 20 Oct)
  assert.ok(!loginHtml.includes('loginGoogleBtn'), 'No Google button in login');
  assert.ok(!loginHtml.includes('Masuk dengan Google'), 'No Google CTA in login');
  assert.ok(!loginHtml.includes('login-google-divider'), 'No Google divider in login');

  // Register link
  assert.match(loginHtml, /Belum punya akun\?/);
  assert.match(loginHtml, /openRegisterModal\(\)/);
});

test('Daftar (Register Modal) adheres to canvas specifications and multi-step indicator', () => {
  const modalStart = html.indexOf('id="registerModal"');
  assert.ok(modalStart >= 0, 'registerModal must exist');
  const modalEnd = html.indexOf('<!-- SELF-SERVICE RESET', modalStart);
  const registerHtml = html.slice(modalStart, modalEnd);

  // Title and subtitle
  assert.match(registerHtml, /Daftar akun baru/);
  assert.match(registerHtml, /Wajib menyertakan Gmail aktif sebagai identitas akun\./);
  assert.match(registerHtml, /onclick="closeRegisterModal\(\)"/);

  // 3-step indicator
  assert.match(registerHtml, /1 · Buat akun/);
  assert.match(registerHtml, /2 · Verifikasi Telegram/);
  assert.match(registerHtml, /3 · Persetujuan admin/);

  // Form fields
  assert.match(registerHtml, /id="regEmail"[^>]*required/);
  assert.match(registerHtml, /placeholder="nama@gmail\.com"/);
  assert.match(registerHtml, /id="regUsername"/);
  assert.match(registerHtml, /id="regPassword"/);
  assert.match(registerHtml, /id="regPasswordConfirm"/);
  assert.match(registerHtml, /id="regPwStrength"/);
  assert.match(registerHtml, /id="regPwHint"/);

  // Toggles
  assert.match(registerHtml, /id="regPasswordToggle"/);
  assert.match(registerHtml, /id="regPasswordConfirmToggle"/);

  // Terms and CTA
  assert.match(registerHtml, /id="regTermsAccepted"/);
  assert.match(registerHtml, /id="regOpenTerms"/);
  assert.match(registerHtml, /id="registerBtn"/);

  // Approval Panel
  assert.match(registerHtml, /id="registerApprovalPanel"/);
  assert.match(registerHtml, /Akun dibuat/);
  assert.match(registerHtml, /id="registerVerificationCode"/);
  assert.match(registerHtml, /id="copyApprovalCodeBtn"/);
  assert.match(registerHtml, /approval-active-status/);
  assert.match(registerHtml, /approval-state-pending/);
  assert.match(registerHtml, /Menunggu Persetujuan Admin/);

  // No demo controls
  assert.doesNotMatch(registerHtml, /Kembali ke formulir \(demo\)/);
  assert.doesNotMatch(registerHtml, /Ulangi demo/);
});

test('Pemulihan Password (Recovery Wizard) adheres to canvas 3-step wizard specifications', () => {
  // Check index.html selfResetModal
  const modalStart = html.indexOf('id="selfResetModal"');
  assert.ok(modalStart >= 0, 'selfResetModal must exist in index.html');
  const modalEnd = html.indexOf('<!-- GOOGLE COMPLETE', modalStart);
  const resetHtml = html.slice(modalStart, modalEnd);

  assert.match(resetHtml, /Pulihkan password/);
  assert.match(resetHtml, /Verifikasi melalui bot Telegram yang terhubung ke akun Anda\./);
  assert.match(resetHtml, /id="selfResetUsername"/);
  assert.match(resetHtml, /Kode verifikasi dikirim ke Telegram yang sudah tertaut, bukan ke email\./);

  // Check auth-v2.js dynamic wizard
  assert.match(authV2Js, /showResetRequest/);
  assert.match(authV2Js, /showResetCompletion/);
  assert.match(authV2Js, /showResetSuccess/);
  assert.match(authV2Js, /Langkah 1 dari 3/);
  assert.match(authV2Js, /Langkah 3 dari 3/);
  assert.match(authV2Js, /Password diperbarui/);
  assert.match(authV2Js, /Silakan masuk kembali dengan password baru\./);

  // No demo controls
  assert.doesNotMatch(authV2Js, /Ulangi demo/);
  assert.doesNotMatch(resetHtml, /Ulangi demo/);
});

test('Lengkapi Identitas Akun (Gmail Completion) adheres to canvas specifications', () => {
  assert.match(legacyGmailJs, /Langkah wajib · satu kali/);
  assert.match(legacyGmailJs, /Lengkapi identitas akun/);
  assert.match(legacyGmailJs, /Auto-Cuan kini memakai Gmail sebagai identitas akun/);
  assert.match(legacyGmailJs, /Data watchlist, portofolio, dan anggaran Anda tetap utuh\./);
  assert.match(legacyGmailJs, /Username lama masih bisa dipakai untuk masuk\./);
  assert.match(legacyGmailJs, /id=['"]legacyGmailEmail['"]/);
  assert.match(legacyGmailJs, /id=['"]legacyGmailEmailConfirm['"]/);
  assert.match(legacyGmailJs, /id=['"]legacyGmailLogout['"]/);
  assert.match(legacyGmailJs, /account-email-complete/);
  assert.match(legacyGmailJs, /Simpan &amp; lanjutkan/);

  // No Google sign-in button
  assert.doesNotMatch(legacyGmailJs, />Masuk dengan Google</);
});

test('Si Mata Mascot is strictly hidden on all Auth screens', () => {
  // CSS selector hides mascot on loginModal, registerModal, selfResetModal, authV2ResetModal, and legacyGmailDialog
  assert.ok(css.includes('#loginModal:not(.hidden)'), 'loginModal hidden selector exists');
  assert.ok(css.includes('#registerModal:not(.hidden)'), 'registerModal hidden selector exists');
  assert.ok(css.includes('#selfResetModal:not(.hidden)'), 'selfResetModal hidden selector exists');
  assert.ok(css.includes('#authV2ResetModal:not(.hidden)'), 'authV2ResetModal hidden selector exists');
  assert.ok(css.includes('dialog.legacy-gmail-dialog[open]'), 'legacyGmailDialog open selector exists');
  assert.match(css, /body:has\([^}]*\.mm\s*\{\s*display:\s*none\s*!important;\s*\}/);
});
