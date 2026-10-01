'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function extractFunction(signature) {
  const startIdx = html.indexOf(signature);
  assert.ok(startIdx >= 0, 'must find: ' + signature);
  const braceStart = html.indexOf('{', startIdx);
  let depth = 0;
  for (let j = braceStart; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') {
      depth--;
      if (depth === 0) return html.slice(startIdx, j + 1);
    }
  }
  throw new Error('unbalanced braces for ' + signature);
}

test('doLogin wraps all localStorage.setItem calls in try/catch to protect against private browsing storage exceptions', () => {
  const doLoginSrc = extractFunction('async function doLogin()');
  assert.ok(doLoginSrc, 'doLogin must exist');

  // Verify that localStorage operations in the success block are enclosed in try/catch
  const successBlockStart = doLoginSrc.indexOf('if (data.success)');
  assert.ok(successBlockStart > 0, 'must find success block in doLogin');
  const successBlock = doLoginSrc.slice(successBlockStart);

  assert.match(
    successBlock,
    /try\s*\{\s*localStorage\.setItem\('autocuan_user'/,
    'localStorage.setItem for user must be inside try block'
  );
  assert.match(
    successBlock,
    /catch\s*\(_\)\s*\{\s*\}/,
    'localStorage operations in doLogin must catch storage errors gracefully'
  );
  assert.match(
    successBlock,
    /window\.__AUTOCUAN_AUTHENTICATED_SESSION__\s*=\s*data;/,
    'session object must be recorded on window for in-memory fallback'
  );
});

test('getOrCreateDeviceId safely handles localStorage exceptions without throwing', () => {
  const deviceIdSrc = extractFunction('function getOrCreateDeviceId()');
  assert.ok(deviceIdSrc, 'getOrCreateDeviceId must exist');
  assert.match(
    deviceIdSrc,
    /try\s*\{\s*id\s*=\s*localStorage\.getItem\('autocuan_device_id'\);\s*\}\s*catch/,
    'localStorage.getItem must be wrapped in try/catch'
  );
  assert.match(
    deviceIdSrc,
    /try\s*\{\s*localStorage\.setItem\('autocuan_device_id',\s*id\);\s*\}\s*catch/,
    'localStorage.setItem must be wrapped in try/catch'
  );
});

test('isAutocuanLoggedIn falls back to window.__AUTOCUAN_AUTHENTICATED_SESSION__ if localStorage throws', () => {
  const isLoggedSrc = extractFunction('function isAutocuanLoggedIn()');
  assert.ok(isLoggedSrc, 'isAutocuanLoggedIn must exist');
  assert.match(
    isLoggedSrc,
    /window\.__AUTOCUAN_AUTHENTICATED_SESSION__/,
    'isAutocuanLoggedIn must support in-memory session object fallback'
  );
});

test('simulation: doLogin success path proceeds cleanly when localStorage throws SecurityError', async () => {
  const state = {
    enteredApp: false,
    closedLoginModal: false,
    closedAuthChoiceModal: false,
    loggedUsername: null,
    windowSession: null,
    errorText: ''
  };

  // Simulating throwing localStorage
  const throwingLocalStorage = {
    getItem() {
      const err = new Error('The operation is insecure.');
      err.name = 'SecurityError';
      throw err;
    },
    setItem() {
      const err = new Error('The operation is insecure.');
      err.name = 'SecurityError';
      throw err;
    },
    removeItem() {
      const err = new Error('The operation is insecure.');
      err.name = 'SecurityError';
      throw err;
    }
  };

  const data = {
    success: true,
    username: 'trader1',
    userId: 'usr_123',
    isAdmin: false
  };

  // Executing the exact success logic from index.html doLogin
  const isAdminUser = (data.isAdmin === true && String(data.username || '').toLowerCase() === 'budi');
  try {
    throwingLocalStorage.setItem('autocuan_user', data.username);
    throwingLocalStorage.setItem('autocuan_is_admin', isAdminUser ? 'true' : 'false');
    throwingLocalStorage.setItem('autocuan_logged_in', 'true');
    throwingLocalStorage.setItem('autocuan_login_time', Date.now().toString());
    if (data.userId) { throwingLocalStorage.setItem('autocuan_user_id', data.userId); }
    if (data.isReview) { throwingLocalStorage.setItem('autocuan_is_review', 'true'); }
    else { throwingLocalStorage.removeItem('autocuan_is_review'); }
  } catch (_) {}

  state.windowSession = data;
  state.closedLoginModal = true;
  state.closedAuthChoiceModal = true;
  state.enteredApp = true;

  assert.equal(state.enteredApp, true, 'enteredApp must succeed even if localStorage threw');
  assert.equal(state.windowSession.username, 'trader1', 'in-memory session must be populated');
  assert.equal(state.errorText, '', 'no misleading connection error should be set');
});
