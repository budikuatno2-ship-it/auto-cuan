'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('HTML Parity: index.html and analisis-saham.html have identical #headerAccountSection markup', () => {
  const indexHtml = read('public/index.html');
  const analisisHtml = read('public/analisis-saham.html');

  // Verify elements exist in both pages
  for (const [pageName, html] of [['index.html', indexHtml], ['analisis-saham.html', analisisHtml]]) {
    assert.ok(html.includes('id="headerAccountSection"'), pageName + ' contains headerAccountSection');
    assert.ok(html.includes('id="headerUserLabel"'), pageName + ' contains headerUserLabel');
    assert.ok(html.includes('id="headerUsername"'), pageName + ' contains headerUsername');
    assert.ok(html.includes('id="headerTierBadge"'), pageName + ' contains headerTierBadge');
    assert.ok(html.includes('id="logoutBtn"'), pageName + ' contains logoutBtn');
    assert.ok(html.includes('class="w-2 h-2 rounded-full bg-emerald-400"'), pageName + ' contains emerald status dot');
  }

  // Verify class attributes match
  const sectionClassRegex = /<div\s+id="headerAccountSection"\s+class="([^"]+)"/;
  const indexMatch = indexHtml.match(sectionClassRegex);
  const analisisMatch = analisisHtml.match(sectionClassRegex);

  assert.ok(indexMatch, 'index.html matches headerAccountSection class');
  assert.ok(analisisMatch, 'analisis-saham.html matches headerAccountSection class');
  assert.equal(indexMatch[1], analisisMatch[1], 'headerAccountSection classes must be 100% identical');
  assert.ok(indexMatch[1].includes('border-l border-dark-600/40'), 'headerAccountSection includes divider styling');
});

test('CSS Parity: index-shell.css defines #headerAccountSection styling', () => {
  const css = read('public/index-shell.css');
  assert.ok(css.includes('#headerAccountSection'), 'index-shell.css contains #headerAccountSection rule');
  assert.ok(css.includes('display: inline-flex'), 'index-shell.css specifies inline-flex for headerAccountSection');
});

test('Dashboard Header Runtime: syncHeaderUsername displays 👑 ADMIN tier badge for budi', () => {
  const indexHtml = read('public/index.html');

  assert.ok(indexHtml.includes('function syncHeaderUsername()'), 'index.html defines syncHeaderUsername');
  assert.ok(indexHtml.includes('function isSubscribedUser()'), 'index.html defines isSubscribedUser');

  function createEnv(user, isAdmin, premiumAccessState) {
    const store = {
      autocuan_user: user,
      autocuan_is_admin: isAdmin ? 'true' : 'false',
      autocuan_logged_in: user !== 'guest' ? 'true' : 'false'
    };
    const elements = {};
    function mockEl(id) {
      if (!elements[id]) {
        elements[id] = {
          id,
          style: {},
          className: '',
          classList: {
            _classes: new Set(),
            add(c) { this._classes.add(c); },
            remove(c) { this._classes.delete(c); },
            toggle(c, force) {
              if (force === undefined) {
                if (this._classes.has(c)) this._classes.delete(c);
                else this._classes.add(c);
              } else if (force) {
                this._classes.add(c);
              } else {
                this._classes.delete(c);
              }
            },
            contains(c) { return this._classes.has(c); }
          },
          setAttribute: () => {},
          addEventListener: () => {},
          innerHTML: '',
          textContent: ''
        };
      }
      return elements[id];
    }

    mockEl('headerAccountSection');
    mockEl('headerUserLabel');
    mockEl('headerUsername');
    mockEl('headerTierBadge');
    mockEl('logoutBtn');
    mockEl('headerLoginBtn');
    mockEl('headerRegisterBtn');

    const sandbox = {
      window: {
        location: { pathname: '/dashboard', search: '', href: 'http://localhost/dashboard' },
        history: { replaceState: () => {} },
        dispatchEvent: () => {},
        addEventListener: () => {},
        premiumAccessState: premiumAccessState || null
      },
      document: {
        addEventListener: () => {},
        readyState: 'complete',
        getElementById: mockEl,
        querySelectorAll: () => []
      },
      localStorage: {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
      },
      setTimeout: (fn) => setTimeout(fn, 10),
      clearTimeout: (id) => clearTimeout(id),
      Date,
      console
    };
    sandbox.globalThis = sandbox.window;
    vm.createContext(sandbox);

    const scriptStart = indexHtml.indexOf('// ===== DAILY USAGE LIMIT SYSTEM =====');
    const scriptEnd = indexHtml.indexOf('// Phase 6A: catalogue and account facts are loaded only from existing server endpoints.');
    const code = indexHtml.slice(scriptStart, scriptEnd);
    vm.runInContext(code, sandbox);

    return { sandbox, elements, store };
  }

  // Case 1: Admin budi
  {
    const { sandbox, elements } = createEnv('budi', true, { premium: true, accessLevel: 'admin', isAdmin: true });
    sandbox.window.syncHeaderUsername();
    assert.equal(elements.headerUsername.textContent, 'budi');
    assert.equal(elements.headerTierBadge.textContent, '👑 ADMIN');
    assert.ok(elements.headerTierBadge.className.includes('text-emerald-400'), 'Tier badge has emerald color');
    assert.ok(elements.headerTierBadge.className.includes('bg-emerald-500/10'), 'Tier badge has emerald background');
    assert.equal(elements.logoutBtn.textContent, 'Logout');
    assert.equal(elements.headerAccountSection.classList.contains('hidden'), false);
    assert.equal(elements.headerLoginBtn.classList.contains('hidden'), true);
    assert.equal(elements.headerRegisterBtn.classList.contains('hidden'), true);
  }

  // Case 2: Subscribed Pro User
  {
    const { sandbox, elements } = createEnv('pro_user', false, { premium: true, accessLevel: 'premium' });
    sandbox.window.syncHeaderUsername();
    assert.equal(elements.headerUsername.textContent, 'pro_user');
    assert.equal(elements.headerTierBadge.textContent, '⭐ PRO');
    assert.ok(elements.headerTierBadge.className.includes('text-amber-300'), 'Tier badge has amber color');
    assert.ok(elements.headerTierBadge.className.includes('bg-amber-500/10'), 'Tier badge has amber background');
    assert.equal(elements.logoutBtn.textContent, 'Logout');
  }

  // Case 3: Regular Free User
  {
    const { sandbox, elements } = createEnv('free_trader', false, { premium: false, accessLevel: 'free' });
    sandbox.window.syncHeaderUsername();
    assert.equal(elements.headerUsername.textContent, 'free_trader');
    assert.equal(elements.headerTierBadge.textContent, 'FREE');
    assert.ok(elements.headerTierBadge.className.includes('text-gray-400'), 'Tier badge has gray color');
    assert.equal(elements.logoutBtn.textContent, 'Logout');
  }

  // Case 4: Guest User
  {
    const { sandbox, elements } = createEnv('guest', false, null);
    sandbox.window.syncHeaderUsername();
    assert.equal(elements.headerUsername.textContent, 'Guest');
    assert.equal(elements.headerAccountSection.classList.contains('hidden'), true);
    assert.equal(elements.headerLoginBtn.classList.contains('hidden'), false);
    assert.equal(elements.headerRegisterBtn.classList.contains('hidden'), false);
  }
});
