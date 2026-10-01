'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('HTML: analisis-saham.html contains headerTierBadge inside headerAccountSection', () => {
  const html = read('public/analisis-saham.html');
  assert.ok(html.includes('id="headerAccountSection"'), 'Contains headerAccountSection');
  assert.ok(html.includes('id="headerUserLabel"'), 'Contains headerUserLabel');
  assert.ok(html.includes('id="headerUsername"'), 'Contains headerUsername');
  assert.ok(html.includes('id="headerTierBadge"'), 'Contains headerTierBadge');
});

test('Header Profile Lock: syncHeaderUsername sets correct tier badges for Guest, Free, Pro, and Admin', () => {
  const runtimeSource = read('public/analisis-saham-runtime.js');

  function createEnv(user, isAdmin, premiumAccessState) {
    const store = {
      autocuan_user: user,
      autocuan_is_admin: isAdmin ? 'true' : 'false'
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

    mockEl('headerUsername');
    mockEl('headerUserLabel');
    mockEl('headerTierBadge');
    mockEl('logoutBtn');
    mockEl('tabAnalisisPattern');
    mockEl('panel-tab-pattern');

    const sandbox = {
      window: {
        location: { pathname: '/analisis-saham', search: '', href: 'http://localhost/analisis-saham' },
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
    vm.runInContext(runtimeSource, sandbox);

    return { sandbox, elements, store };
  }

  // Case 1: Guest
  {
    const { sandbox, elements } = createEnv('guest', false, null);
    sandbox.window.syncHeaderUsername();
    assert.equal(elements.headerUsername.textContent, 'Guest');
    assert.equal(elements.headerTierBadge.textContent, 'FREE');
    assert.equal(elements.logoutBtn.textContent, 'Login');
  }

  // Case 2: Regular Free User
  {
    const { sandbox, elements } = createEnv('trader_cuan', false, { premium: false, accessLevel: 'free' });
    sandbox.window.syncHeaderUsername();
    assert.equal(elements.headerUsername.textContent, 'trader_cuan');
    assert.equal(elements.headerTierBadge.textContent, 'FREE');
    assert.equal(elements.logoutBtn.textContent, 'Logout');
  }

  // Case 3: Pro / Subscribed User
  {
    const { sandbox, elements } = createEnv('pro_trader', false, { premium: true, accessLevel: 'premium' });
    sandbox.window.syncHeaderUsername();
    assert.equal(elements.headerUsername.textContent, 'pro_trader');
    assert.equal(elements.headerTierBadge.textContent, '⭐ PRO');
    assert.equal(elements.logoutBtn.textContent, 'Logout');
  }

  // Case 4: Admin User (user === 'budi' or isAdmin === true)
  {
    const { sandbox, elements } = createEnv('budi', true, { premium: true, accessLevel: 'admin', isAdmin: true });
    sandbox.window.syncHeaderUsername();
    assert.equal(elements.headerUsername.textContent, 'budi');
    assert.equal(elements.headerTierBadge.textContent, '👑 ADMIN');
  }

  // Case 5: Admin username with isAdmin flag
  {
    const { sandbox, elements } = createEnv('superadmin', true, null);
    sandbox.window.syncHeaderUsername();
    assert.equal(elements.headerUsername.textContent, 'superadmin');
    assert.equal(elements.headerTierBadge.textContent, '👑 ADMIN');
  }
});

test('verifySubscriptionStatus: updates localStorage, premiumAccessState, and refreshes header and pattern radar', async () => {
  const runtimeSource = read('public/analisis-saham-runtime.js');

  const store = {};
  const elements = {};
  function mockEl(id) {
    if (!elements[id]) {
      elements[id] = {
        id,
        style: {},
        className: '',
        classList: {
          _classes: new Set(['hidden']),
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

  mockEl('headerUsername');
  mockEl('headerUserLabel');
  mockEl('headerTierBadge');
  mockEl('logoutBtn');
  mockEl('tabAnalisisPattern');
  mockEl('panel-tab-pattern');

  const sandbox = {
    window: {
      location: { pathname: '/analisis-saham', search: '', href: 'http://localhost/analisis-saham' },
      history: { replaceState: () => {} },
      dispatchEvent: () => {},
      addEventListener: () => {},
      premiumAccessState: null
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
    fetch: async (url, opts) => {
      if (url === '/api/reset-password') {
        return {
          json: async () => ({
            success: true,
            profile: {
              username: 'budi',
              is_admin: true,
              is_approved: true,
              subscription: { entitlement: { premium: true, access_level: 'admin' } }
            }
          })
        };
      }
      return { json: async () => ({}) };
    },
    setTimeout: (fn) => setTimeout(fn, 10),
    clearTimeout: (id) => clearTimeout(id),
    Date,
    console
  };
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(runtimeSource, sandbox);

  const res = await sandbox.window.verifySubscriptionStatus();
  assert.equal(res, true, 'verifySubscriptionStatus returns true for admin');
  assert.equal(store.autocuan_user, 'budi', 'Persisted username');
  assert.equal(store.autocuan_is_admin, 'true', 'Persisted is_admin');
  assert.equal(sandbox.window.premiumAccessState.isAdmin, true, 'Sets isAdmin flag in state');
  assert.equal(elements.headerUsername.textContent, 'budi', 'Header username updated');
  assert.equal(elements.headerTierBadge.textContent, '👑 ADMIN', 'Header badge updated to ADMIN');
  assert.equal(elements.tabAnalisisPattern.classList.contains('hidden'), false, 'Pattern tab unhidden');
  assert.equal(elements.tabAnalisisPattern.style.display, 'inline-flex', 'Pattern tab display set to inline-flex');
});

test('Pattern Radar Unhide: checkPatternTabVisibility toggles tabAnalisisPattern correctly', () => {
  const runtimeSource = read('public/analisis-saham-runtime.js');

  function checkVisibility(user, isAdmin) {
    const store = {
      autocuan_user: user,
      autocuan_is_admin: isAdmin ? 'true' : 'false'
    };
    const elements = {};
    function mockEl(id) {
      if (!elements[id]) {
        elements[id] = {
          id,
          style: {},
          className: '',
          classList: {
            _classes: new Set(['hidden']),
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
    mockEl('tabAnalisisPattern');
    mockEl('panel-tab-pattern');
    mockEl('headerUsername');
    mockEl('headerTierBadge');
    mockEl('logoutBtn');

    const sandbox = {
      window: {
        location: { pathname: '/analisis-saham', search: '' },
        history: { replaceState: () => {} },
        dispatchEvent: () => {},
        addEventListener: () => {}
      },
      document: {
        addEventListener: () => {},
        readyState: 'complete',
        getElementById: mockEl,
        querySelectorAll: () => []
      },
      localStorage: {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); }
      },
      Date,
      console
    };
    sandbox.globalThis = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(runtimeSource, sandbox);

    sandbox.window.checkPatternTabVisibility();
    return {
      isHidden: elements.tabAnalisisPattern.classList.contains('hidden'),
      display: elements.tabAnalisisPattern.style.display
    };
  }

  // Non-admin / guest -> hidden
  const guestResult = checkVisibility('guest', false);
  assert.equal(guestResult.isHidden, true, 'Guest should have hidden pattern tab');
  assert.equal(guestResult.display, 'none');

  // Non-admin regular user -> hidden
  const regularResult = checkVisibility('investor_1', false);
  assert.equal(regularResult.isHidden, true, 'Regular user should have hidden pattern tab');
  assert.equal(regularResult.display, 'none');

  // Admin user budi -> visible
  const budiResult = checkVisibility('budi', true);
  assert.equal(budiResult.isHidden, false, 'Admin budi should have unhidden pattern tab');
  assert.equal(budiResult.display, 'inline-flex');

  // User with isAdmin === true -> visible
  const adminResult = checkVisibility('admin_user', true);
  assert.equal(adminResult.isHidden, false, 'Admin user should have unhidden pattern tab');
  assert.equal(adminResult.display, 'inline-flex');
});

test('Pattern Radar Mount: ensurePatternRadarMounted renders into patternSubTabContainer for admin', () => {
  const patternStable = read('public/pattern-stable-runtime.js');

  const store = {
    autocuan_user: 'budi',
    autocuan_is_admin: 'true'
  };
  const elements = {};
  function mockEl(id) {
    if (!elements[id]) {
      const el = {
        _id: id,
        get id() { return this._id; },
        set id(val) {
          this._id = val;
          elements[val] = this;
        },
        remove() {},
        style: {},
        className: '',
        children: [],
        parentNode: null,
        appendChild(child) {
          child.parentNode = this;
          this.children.push(child);
          return child;
        },
        insertBefore(child, ref) {
          child.parentNode = this;
          this.children.push(child);
          return child;
        },
        querySelector() { return null; },
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
        removeAttribute: () => {},
        getAttribute: () => null,
        addEventListener: () => {},
        innerHTML: '',
        textContent: ''
      };
      elements[id] = el;
    }
    return elements[id];
  }

  const container = mockEl('patternSubTabContainer');
  mockEl('panel-tab-pattern');
  mockEl('tabAnalisisPattern');

  const sandbox = {
    window: {
      location: { pathname: '/analisis-saham', search: '' },
      history: { replaceState: () => {} },
      dispatchEvent: () => {},
      addEventListener: () => {},
      setInterval: () => {},
      setTimeout: () => {},
      AutoCuanUiStability: {
        collectTickers: () => [],
        constants: { SCAN_CONCURRENCY: 4 }
      },
      AutoCuanPatternSafety: {
        evaluateRow: () => ({ status: 'valid', direction: 'bullish' }),
        statusText: () => ({ tone: 'good', badge: 'Terbentuk', note: 'Pola konfirmasi' })
      },
      AutoCuanPatternVisual: {
        priceText: (v) => String(v),
        buildPatternSvg: () => '<svg></svg>'
      },
      PatternMap: {},
      PatternMapAdminAccess: {
        isAllowed: () => true,
        refresh: async () => true
      },
      switchAnalisisTab: () => {}
    },
    document: {
      addEventListener: () => {},
      readyState: 'complete',
      getElementById: mockEl,
      createElement: (tag) => mockEl(tag + '-' + Math.random().toString(36).slice(2)),
      head: { appendChild: () => {} },
      querySelectorAll: () => []
    },
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    Date,
    console
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.sessionStorage = sandbox.sessionStorage;
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(patternStable, sandbox);

  assert.equal(typeof sandbox.window.ensurePatternRadarMounted, 'function', 'Exposes ensurePatternRadarMounted');
  sandbox.window.ensurePatternRadarMounted(container);

  assert.ok(elements['page-pattern'], 'Creates page-pattern element');
  assert.equal(elements['page-pattern'].style.display, 'block', 'page-pattern is displayed block');
  assert.equal(elements['page-pattern'].classList.contains('hidden'), false, 'page-pattern hidden class removed');
});
