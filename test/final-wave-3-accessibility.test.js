'use strict';

/**
 * AUTO-CUAN — FINAL REPAIR WAVE 3 TARGETED TEST SUITE
 *
 * Covers:
 *   FINAL-BUG-008: Authentication credentials wrapped in semantic <form> containers with native submit
 *   FINAL-A11Y-001: Bypass navigation skip-link targeting active main content container
 *   FINAL-A11Y-002: Modal focus restoration & focus stack safety across all dismissal paths
 *   FINAL-A11Y-003: Programmatic accessible names on all 27 audited interactive controls
 *   FINAL-A11Y-004: Keyboard-scrollable horizontal table overflow containers with visible focus
 *   FINAL-POLISH-004: Active-view heading semantics without false positive WCAG violations
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML_PATH = path.join(ROOT, 'public', 'index.html');
const AUTH_V2_PATH = path.join(ROOT, 'public', 'auth-v2.js');

const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const authV2Js = fs.readFileSync(AUTH_V2_PATH, 'utf8');

// =========================================================================
// 1. SKIP LINK & MAIN TARGETS (FINAL-A11Y-001)
// =========================================================================

test('FINAL-A11Y-001: skip link does not use dead anchor href="#" and targets valid main container', () => {
  assert.doesNotMatch(indexHtml, /<a href="#" class="skip-link"/, 'Dead href="#" skip link must not exist');
  assert.match(indexHtml, /<a href="#appMain" id="skipToContentLink" class="skip-link"/, 'Skip link must point to a valid ID anchor');
  assert.ok(indexHtml.includes('id="landingMain"'), 'Landing container must have id="landingMain"');
  assert.ok(indexHtml.includes('id="appMain"'), 'App shell must have id="appMain"');
});

test('FINAL-A11Y-001: setTopLevelView updates skip link href dynamically for current view', () => {
  assert.match(indexHtml, /skipLink\.setAttribute\('href',\s*'#'\s*\+\s*targetId\)/, 'setTopLevelView must sync skip link href to active container');
});

test('FINAL-A11Y-001: skipToMainContent manages temporary tabindex="-1" cleanly without leaving tabstop', () => {
  assert.match(indexHtml, /window\.skipToMainContent\s*=\s*function/, 'skipToMainContent must be defined');
  assert.match(indexHtml, /target\.setAttribute\('tabindex',\s*'-1'\)/, 'Must temporarily set tabindex="-1" on unfocusable target');
  assert.match(indexHtml, /target\.removeAttribute\('tabindex'\)/, 'Must clean up temporary tabindex on blur');
});

// =========================================================================
// 2. AUTH MODAL SEMANTIC FORMS & AUTOCOMPLETE (FINAL-BUG-008)
// =========================================================================

test('FINAL-BUG-008: login modal credentials reside inside a semantic <form>', () => {
  const loginModalSlice = indexHtml.slice(indexHtml.indexOf('id="loginModal"'), indexHtml.indexOf('id="registerModal"'));
  assert.match(loginModalSlice, /<form id="loginForm" class="space-y-3" onsubmit="event\.preventDefault\(\);doLogin\(\);return false;">/, 'loginForm must wrap inputs with onsubmit prevention');
  assert.match(loginModalSlice, /<input type="text" id="loginUsername" name="username" autocomplete="username"/, 'loginUsername must have name and autocomplete');
  assert.match(loginModalSlice, /<input type="password" id="loginPassword" name="password" autocomplete="current-password"/, 'loginPassword must have name and autocomplete');
  assert.match(loginModalSlice, /<button type="submit" id="loginBtn"/, 'loginBtn must have type="submit"');
  assert.match(loginModalSlice, /<\/form>/, 'loginForm must have closing tag');
});

test('FINAL-BUG-008: register modal credentials reside inside a semantic <form>', () => {
  const regModalSlice = indexHtml.slice(indexHtml.indexOf('id="registerModal"'), indexHtml.indexOf('id="selfResetModal"'));
  assertRegisterSubmitContract(regModalSlice);
  assert.match(regModalSlice, /id="regEmail" name="email" autocomplete="email"/, 'regEmail must have name and autocomplete');
  assert.match(regModalSlice, /id="regUsername" name="username" autocomplete="username"/, 'regUsername must have name and autocomplete');
  assert.match(regModalSlice, /id="regPassword" name="password" autocomplete="new-password"/, 'regPassword must have name and autocomplete');
  assert.match(regModalSlice, /id="regPasswordConfirm" name="passwordConfirm" autocomplete="new-password"/, 'regPasswordConfirm must have name and autocomplete');
  assert.match(regModalSlice, /<button type="submit" id="registerBtn"/, 'registerBtn must have type="submit"');
  assert.match(regModalSlice, /<\/form>/, 'registerFormFields must have closing tag');
});

test('FINAL-BUG-008: self-service reset modal credentials reside inside a semantic <form>', () => {
  const resetSlice = indexHtml.slice(indexHtml.indexOf('id="selfResetModal"'), indexHtml.indexOf('id="dashboardScreen"'));
  assert.match(resetSlice, /<form id="selfResetForm" class="space-y-4" onsubmit="event\.preventDefault\(\);doSelfResetPassword\(\);return false;">/, 'selfResetForm must be a form with onsubmit prevention');
  assert.match(resetSlice, /id="selfResetUsername" name="username" autocomplete="username"/, 'selfResetUsername must have name and autocomplete');
  assert.match(resetSlice, /id="selfResetPw" name="password" autocomplete="new-password"/, 'selfResetPw must have name and autocomplete');
  assert.match(resetSlice, /id="selfResetPwConfirm" name="passwordConfirm" autocomplete="new-password"/, 'selfResetPwConfirm must have name and autocomplete');
  assert.match(resetSlice, /<button type="submit" id="selfResetSubmitBtn"/, 'selfResetSubmitBtn must have type="submit"');
});

test('FINAL-BUG-008: user reset modal credentials reside inside a semantic <form>', () => {
  const adminResetSlice = indexHtml.slice(indexHtml.indexOf('id="resetPasswordModal"'), indexHtml.indexOf('id="deviceDetailsModal"'));
  assert.match(adminResetSlice, /<form id="resetPasswordForm" class="space-y-4" onsubmit="event\.preventDefault\(\);doResetPassword\(\);return false;">/, 'resetPasswordForm must be a form with onsubmit prevention');
  assert.match(adminResetSlice, /id="resetPwInput" name="password" autocomplete="new-password"/, 'resetPwInput must have name and autocomplete');
  assert.match(adminResetSlice, /id="resetPwConfirm" name="passwordConfirm" autocomplete="new-password"/, 'resetPwConfirm must have name and autocomplete');
  assert.match(adminResetSlice, /<button type="submit" id="resetPwSubmitBtn"/, 'resetPwSubmitBtn must have type="submit"');
});

test('FINAL-BUG-008: auth-v2 dynamic password reset dialogues reside inside semantic <form> elements', () => {
  assert.match(authV2Js, /<form id="authV2ResetRequestForm"/, 'authV2 reset request must use <form>');
  assert.match(authV2Js, /<button type="submit" id="authV2ResetRequestBtn"/, 'authV2 request button must be type="submit"');
  assert.match(authV2Js, /<form id="authV2ResetCompleteForm"/, 'authV2 reset complete must use <form>');
  assert.match(authV2Js, /<button type="submit" id="authV2ResetCompleteBtn"/, 'authV2 complete button must be type="submit"');
});

test('FINAL-BUG-008: no nested <form> elements exist in source', () => {
  assert.doesNotMatch(indexHtml, /<form[^>]*>[^<]*<form/i, 'index.html must have zero nested forms');
  assert.doesNotMatch(authV2Js, /<form[^>]*>[^<]*<form/i, 'auth-v2.js must have zero nested forms');
});

// =========================================================================
// 3. MODAL FOCUS RESTORATION & FOCUS STACK (FINAL-A11Y-002)
// =========================================================================

test('FINAL-A11Y-002: modal management maintains a focus stack across modal handoffs', () => {
  assert.match(indexHtml, /function resolveTriggerOutsideModals\(candidate\)/, 'Modal focus routine must resolve ancestor trigger for nested modals');
  assert.match(indexHtml, /function findSafeFallbackControl\(\)/, 'Modal focus routine must define deterministic safe control fallback');
  assert.match(indexHtml, /lastFocusByModal\[id\] = restore \|\| document\.activeElement/, 'Modal opener must preserve direct trigger for nested dialogs');
  assert.doesNotMatch(indexHtml, /var resolvedTrigger = restore \|\| resolveTriggerOutsideModals/, 'Must not resolve outside trigger for newly opened modals');
});

test('FINAL-A11Y-002: modal dismissal falls back to deterministic safe control rather than document.body', () => {
  assert.match(indexHtml, /var fallback = findSafeFallbackControl\(\);/, 'Modal dismissal must query safe fallback control');
  assert.match(indexHtml, /fallback\.focus\(\{ preventScroll: true \}\)/, 'Fallback control must receive focus');
});

test('FINAL-A11Y-002: authV2ResetModal is mapped in MODAL_CLOSERS and exports window.closeAuthV2ResetModal', () => {
  assert.match(indexHtml, /authV2ResetModal:\s*'(closeAuthV2ResetModal|closeSelfResetModal)'/, 'MODAL_CLOSERS must map authV2ResetModal to a valid closer');
  assert.match(authV2Js, /window\.closeAuthV2ResetModal = closeResetModal;/, 'auth-v2.js must expose closeAuthV2ResetModal');
});

// =========================================================================
// 4. ACCESSIBLE NAMES ON 27 INTERACTIVE CONTROLS (FINAL-A11Y-003)
// =========================================================================

test('FINAL-A11Y-003: all screener risk, status, type and search filters have accessible names', () => {
  const ids = [
    'kgRiskFilter', 'kgStatusFilter', 'kgTypeFilter', 'kgTickerSearch',
    'nkRiskFilter', 'nkStatusFilter', 'nkTypeFilter', 'nkTickerSearch',
    'dtRiskFilter', 'dtStatusFilter', 'dtTypeFilter', 'dtTickerSearch'
  ];
  for (const id of ids) {
    const re = new RegExp(`id="${id}"[^>]*aria-label="[^"]+"`);
    assert.match(indexHtml, re, `${id} must define an aria-label`);
  }
});

test('FINAL-A11Y-003: chart and news ticker search inputs have accessible names', () => {
  assert.match(indexHtml, /id="chartTickerInput"[^>]*aria-label="[^"]+"/, 'chartTickerInput must define aria-label');
  assert.match(indexHtml, /id="newsTickerInput"[^>]*aria-label="[^"]+"/, 'newsTickerInput must define aria-label');
});

test('FINAL-A11Y-003: track record filter and search controls have accessible names', () => {
  assert.match(indexHtml, /id="trStatusFilter"[^>]*aria-label="[^"]+"/, 'trStatusFilter must define aria-label');
  assert.match(indexHtml, /id="trSearchInput"[^>]*aria-label="[^"]+"/, 'trSearchInput must define aria-label');
});

test('FINAL-A11Y-003: backtest parameters have explicit label associations via for="..." attribute', () => {
  const labels = [
    'btCategoryFilter', 'btPeriodFilter', 'btMinRrFilter', 'btTargetStrategyFilter',
    'btInitialCapitalInput', 'btSizingModeFilter', 'btPositionAmountInput'
  ];
  for (const id of labels) {
    const re = new RegExp(`<label for="${id}"`, 'i');
    assert.match(indexHtml, re, `Preceding label must have for="${id}"`);
  }
});

test('FINAL-A11Y-003: composer file/chat inputs and watchlist hidden inputs define accessible names', () => {
  assert.match(indexHtml, /id="generalFileInput"[^>]*aria-label="[^"]+"/, 'generalFileInput must define aria-label');
  assert.match(indexHtml, /id="generalChatInput"[^>]*aria-label="[^"]+"/, 'generalChatInput must define aria-label');
  assert.match(indexHtml, /id="wlAlertId"[^>]*aria-label="[^"]+"/, 'wlAlertId must define aria-label');
  assert.match(indexHtml, /id="wlNotesTicker"[^>]*aria-label="[^"]+"/, 'wlNotesTicker must define aria-label');
});

// =========================================================================
// 5. KEYBOARD TABLE OVERFLOW CONTAINERS (FINAL-A11Y-004)
// =========================================================================

test('FINAL-A11Y-004: data table overflow containers define tabindex="0" and role="region"', () => {
  const tableWrappers = [
    'screenerTableWrap',
    'nkScreenerTableWrap',
    'dtScreenerTableWrap',
    'trTableWrap',
    'trBacktestTradesWrap'
  ];
  for (const id of tableWrappers) {
    const re = new RegExp(`id="${id}"[^>]*tabindex="0"[^>]*role="region"|id="${id}"[^>]*role="region"[^>]*tabindex="0"`);
    assert.match(indexHtml, re, `${id} must define tabindex="0" and role="region"`);
  }
});

test('FINAL-A11Y-004: dynamic screener tables define tabindex="0" and role="region"', () => {
  assert.match(indexHtml, /tabindex="0" role="region" aria-label="Tabel data screener swing konglomerasi"/, 'renderShareKonglo must create focusable region');
  assert.match(indexHtml, /tabindex="0" role="region" aria-label="Tabel data screener swing non-konglomerasi"/, 'renderShareNonKonglo must create focusable region');
  assert.match(indexHtml, /tabindex="0" role="region" aria-label="Tabel data day trade screener"/, 'renderShareDaytrade must create focusable region');
});

test('FINAL-A11Y-004: keyboard arrow navigation listener is attached to overflowing table wrappers', () => {
  assert.match(indexHtml, /wrap\.classList\.contains\('overflow-x-auto'\)/, 'Table keyboard scroll handler must target overflow-x-auto');
  assert.match(indexHtml, /wrap\.scrollLeft\s*\+=\s*40/, 'ArrowRight must advance scrollLeft');
  assert.match(indexHtml, /wrap\.scrollLeft\s*-=\s*40/, 'ArrowLeft must reduce scrollLeft');
});

// =========================================================================
// 6. FALSE POSITIVE PRESERVATION (FINAL-POLISH-004 & RECHALLENGES)
// =========================================================================

test('RECHALLENGE: simple tables are NOT falsely forced to have redundant scope="col" attributes', () => {
  // Verifies that false positive claim from Phase 4 is not reintroduced
  assert.ok(indexHtml.includes('<th class="px-2 py-2.5 text-left text-gray-400 font-medium whitespace-nowrap sticky left-0 bg-dark-700/95 z-30">Ticker</th>'));
});

test('FINAL-POLISH-004: active landing view heading hierarchy has single clear top-level heading', () => {
  assert.match(indexHtml, /<h1 id="landingTitle">Baca pasar\.<br>Susun rencana\.<br><span>Jaga konteks\.<\/span><\/h1>/, 'Landing page must preserve its canonical top-level heading');
});

function assertRegisterSubmitContract(source) {
  const form = source.match(/<form\b[^>]*\bid="registerFormFields"[^>]*>([\s\S]*?)<\/form>/);
  assert.ok(form, 'registration requires a semantic form');
  const opening = form[0].slice(0, form[0].indexOf('>') + 1);
  const attr = name => opening.match(new RegExp('\\b' + name + '="([^\"]*)"'))?.[1];
  const handler = attr('onsubmit'); assert.ok(handler, 'native submit handler exists');
  const calls = { prevented: 0, submitted: 0, synced: 0 };
  const context = { event: { preventDefault() { calls.prevented++; } }, doRegister() { calls.submitted++; }, syncRegistrationConsent() { calls.synced++; } };
  const result = vm.runInNewContext('(function(){' + handler + '})()', context);
  assert.equal(result, false); assert.equal(calls.prevented, 1); assert.equal(calls.submitted, 1);
  for (const name of ['oninput', 'onchange']) {
    const sync = attr(name); assert.ok(sync, name + ' sync exists');
    const prior = calls.synced; vm.runInNewContext(sync, context); assert.equal(calls.synced, prior + 1);
  }
  const button = form[1].match(/<button\b[^>]*\bid="registerBtn"[^>]*>/)?.[0];
  assert.ok(button); assert.match(button, /\btype="submit"/);
  assert.doesNotMatch(button, /\bonclick=/, 'submit button must not duplicate form dispatch');
}
test('registration form negative controls reject missing prevention, duplicate dispatch and broken sync', () => {
  for (const broken of [
    indexHtml.replace('<form id="registerFormFields"', '<div id="registerFormFields"'),
    indexHtml.replace('event.preventDefault();doRegister();return false;', 'doRegister();return false;'),
    indexHtml.replace('doRegister();return false;', 'doRegister();doRegister();return false;'),
    indexHtml.replace('oninput="syncRegistrationConsent()"', ''),
    indexHtml.replace('type="submit" id="registerBtn"', 'type="submit" onclick="doRegister()" id="registerBtn"')
  ]) assert.throws(() => assertRegisterSubmitContract(broken), assert.AssertionError);
});
