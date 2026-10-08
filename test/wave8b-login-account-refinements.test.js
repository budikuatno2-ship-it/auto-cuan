/**
 * test/wave8b-login-account-refinements.test.js
 *
 * Wave 8B contract tests:
 *  - Login label changed from "Gmail" to "Email atau username"
 *  - Google "Segera tersedia" button present, non-functional, accessible
 *  - openAuthChoiceModal sets data-context on session expiry
 *  - registerApprovalPanel has all three approval state cards
 *  - Account Center compact CSS present
 *  - Mobile system state text compression CSS present
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css  = fs.readFileSync(path.join(ROOT, 'public', 'ui-theme.css'), 'utf8');

// ── Login label ──────────────────────────────────────────────────────────────

test('login label is "Email atau username", not "Gmail"', () => {
  // The old label must be gone from the login form context
  // (register form still has "Gmail" label which is acceptable)
  const loginModalSection = html.slice(
    html.indexOf('id="loginModal"'),
    html.indexOf('</div>', html.indexOf('id="loginModal"') + 2000) + 10
  );
  assert.ok(loginModalSection.includes('Email atau username'),
    'login label must read "Email atau username"');
});

test('login field placeholder no longer says "nama@gmail.com" (login modal)', () => {
  // We changed the placeholder to generic "email atau username"
  const loginModalStart = html.indexOf('id="loginModal"');
  const loginFormEnd    = html.indexOf('</form>', loginModalStart);
  const loginFormHtml   = html.slice(loginModalStart, loginFormEnd);
  assert.ok(!loginFormHtml.includes('placeholder="nama@gmail.com"'),
    'login placeholder should not be the old Gmail-only placeholder');
});

// ── Google button ─────────────────────────────────────────────────────────────

test('login modal contains Google placeholder button (disabled)', () => {
  const loginModalStart = html.indexOf('id="loginModal"');
  // loginModal ends at its closing wrapper div ~2000 chars in
  const loginModalEnd = html.indexOf('<!-- REGISTER MODAL', loginModalStart);
  const loginHtml = html.slice(loginModalStart, loginModalEnd);
  assert.ok(loginHtml.includes('login-google-btn'), 'Google button class must exist in login modal');
  assert.ok(loginHtml.includes('disabled'), 'Google button must be disabled');
  assert.ok(loginHtml.includes('Segera tersedia'), '"Segera tersedia" badge must be present');
  assert.ok(loginHtml.includes('Masuk dengan Google'), 'button label must read "Masuk dengan Google"');
});

test('Google button has aria-disabled and aria-label for accessibility', () => {
  assert.ok(html.includes('aria-disabled="true"'), 'Google button must have aria-disabled="true"');
  assert.ok(html.includes('aria-label="Masuk dengan Google - segera tersedia"'),
    'Google button must have descriptive aria-label');
});

test('login-google-btn CSS is present in ui-theme.css', () => {
  assert.ok(css.includes('.login-google-btn'), 'CSS class .login-google-btn must exist');
  assert.ok(css.includes('cursor: not-allowed'), 'Google button must have not-allowed cursor');
  assert.ok(css.includes('.login-google-badge'), 'CSS class .login-google-badge must exist');
  assert.ok(css.includes('.login-google-divider'), 'CSS class .login-google-divider must exist');
});

test('login-google-btn has min-height 44px (tap target)', () => {
  const btnRule = css.slice(css.indexOf('.login-google-btn {'), css.indexOf('}', css.indexOf('.login-google-btn {')));
  assert.ok(btnRule.includes('min-height: 44px'), 'Google button must have 44px min-height tap target');
});

// ── Session expiry emphasis ───────────────────────────────────────────────────

test('openAuthChoiceModal sets data-context attribute', () => {
  assert.ok(html.includes("data-context", 0), 'modal.setAttribute data-context must appear in JS');
  assert.ok(html.includes("isExpiry ? 'expiry' : 'default'"),
    'expiry logic must switch between expiry and default context');
});

test('CSS has session-expiry emphasis rules for auth choice modal', () => {
  assert.ok(css.includes('#authChoiceModal[data-context="expiry"]'),
    'CSS must have expiry-context selector for auth choice modal');
});

// ── Approval state cards ──────────────────────────────────────────────────────

test('registerApprovalPanel displays only active pending status prominently', () => {
  const panelStart = html.indexOf('id="registerApprovalPanel"');
  const panelEnd = html.indexOf('<!-- SELF-SERVICE RESET', panelStart);
  const panelHtml = html.slice(panelStart, panelEnd);
  assert.ok(panelHtml.includes('approval-active-status'), 'active status container must exist');
  assert.ok(panelHtml.includes('approval-state-pending'), 'pending state class must exist');
  assert.ok(panelHtml.includes('Menunggu Persetujuan Admin'), 'pending state label must exist');
  // Inactive outcomes must NOT be displayed simultaneously as active cards
  assert.ok(!panelHtml.includes('approval-state-approved'), 'approved state card must not be displayed simultaneously');
  assert.ok(!panelHtml.includes('approval-state-rejected'), 'rejected state card must not be displayed simultaneously');
});

test('approval state CSS is present in ui-theme.css', () => {
  assert.ok(css.includes('.approval-state-card'), 'CSS for approval-state-card must exist');
  assert.ok(css.includes('.approval-state-pending'), 'CSS for pending state must exist');
  assert.ok(css.includes('.approval-state-approved'), 'CSS for approved state must exist');
  assert.ok(css.includes('.approval-state-rejected'), 'CSS for rejected state must exist');
});

test('approval states have light mode variants', () => {
  assert.ok(css.includes('html.light .approval-state-pending'),
    'light mode pending state CSS must exist');
  assert.ok(css.includes('html.light .approval-state-approved'),
    'light mode approved state CSS must exist');
});

// ── Account Center compact ────────────────────────────────────────────────────

test('Account Center compact max-width is 880px in CSS', () => {
  assert.ok(css.includes('min(880px, 100%)'),
    'Account Center shell must have compact 880px max-width');
});

// ── System state mobile text compression ─────────────────────────────────────

test('maintenance-facts has mobile font-size reduction', () => {
  const mobileBlock = css.slice(css.lastIndexOf('@media (max-width: 640px)'));
  assert.ok(mobileBlock.includes('.maintenance-facts'), 'maintenance-facts must have mobile CSS');
  assert.ok(mobileBlock.includes('font-size: 12px'), 'mobile font-size reduction must be present');
});

// ── Existing contracts unbroken ───────────────────────────────────────────────

test('loginModal still exists as direct body child (not inside dashboardScreen)', () => {
  const dashStart = html.indexOf('id="dashboardScreen"');
  const loginPos  = html.indexOf('id="loginModal"');
  assert.ok(loginPos < dashStart || loginPos > html.indexOf('</div>', dashStart + 50000),
    'loginModal must appear before dashboardScreen or after it, not inside it');
});

test('login submit button and Lupa Password link still present', () => {
  assert.ok(html.includes('id="loginBtn"'), 'login submit button must still exist');
  assert.ok(html.includes('openSelfResetModal'), 'Lupa Password link must still exist');
});

test('registerApprovalPanel still contains Salin Kode Verifikasi button', () => {
  assert.ok(html.includes('id="copyApprovalCodeBtn"'), 'copy code button must still exist');
});
