'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function makeClassList(initial) {
  const values = new Set(initial || []);
  return {
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
    toggle: (name, force) => force ? values.add(name) : values.delete(name)
  };
}

function makeElement(page, classes) {
  const attributes = new Map([
    ['data-page', page],
    ['disabled', ''],
    ['hidden', '']
  ]);
  return {
    classList: makeClassList(classes),
    dataset: {},
    disabled: true,
    tabIndex: -1,
    removed: false,
    textContent: '',
    onclick: null,
    style: {
      values: {},
      setProperty(name, value) { this.values[name] = value; },
      removeProperty(name) { delete this.values[name]; }
    },
    removeAttribute(name) { attributes.delete(name); },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    remove() { this.removed = true; }
  };
}

test('dashboard loader establishes approved access before legacy dashboard boot', () => {
  const loader = read('public/dashboard-loader.html');

  assert.match(loader, /action:'portfolio_access'/);
  assert.match(loader, /premium-access-status/);
  assert.match(loader, /premium:true/);
  assert.match(loader, /access_level:'approved_website'/);
  assert.match(loader, /doc\.head\.insertBefore\(bootstrap, doc\.head\.firstChild\)/);
  assert.match(loader, /if \(isPremiumFeaturePage\(page\) && !hasConfirmedPremiumAccess\(\)\)/);
  assert.match(loader, /if \(!allowed && isPremiumFeaturePage\(currentPage\)\)/);
  assert.match(loader, /\[data-page="subscription"\],#page-subscription,#subscriptionIdentityCard/);
  assert.match(loader, /window\.location\.href='\/portfolio-planner'/);
});

test('approved guard unlocks website features without replacing native navigation', () => {
  const guard = read('public/dashboard-approved-access-guard.js');

  assert.doesNotMatch(guard, /window\.navigateTo\s*=/);
  assert.doesNotMatch(guard, /window\.loadPremiumAccess\s*=/);
  assert.doesNotMatch(guard, /window\.hasConfirmedPremiumAccess\s*=/);

  const sector = makeElement('sektor', ['hidden', 'opacity-50', 'pointer-events-none']);
  const screener = makeElement('screener', ['hidden', 'cursor-not-allowed']);
  const portfolio = makeElement('portofolio', ['action-card', 'hidden', 'grayscale']);
  const subscription = makeElement('subscription', []);
  const subtitle = { textContent: 'Posisi manual' };

  const document = {
    readyState: 'complete',
    documentElement: {},
    querySelectorAll(selector) {
      if (selector === '[data-premium-nav="true"]') return [sector, screener, portfolio];
      if (selector === '[data-page="subscription"],#page-subscription,#subscriptionIdentityCard') return [subscription];
      if (selector === '[data-page="portofolio"]') return [portfolio];
      if (selector === '.action-card[data-page="portofolio"] p') return [subtitle];
      return [];
    },
    addEventListener() {}
  };

  const window = { location: { href: '/dashboard' } };
  const sandbox = {
    window,
    document,
    Date,
    console,
    requestAnimationFrame(callback) { callback(); },
    setTimeout(callback) { callback(); return 1; },
    MutationObserver: class { observe() {} }
  };

  vm.createContext(sandbox);
  vm.runInContext(guard, sandbox);

  for (const element of [sector, screener, portfolio]) {
    assert.equal(element.disabled, false);
    assert.equal(element.classList.contains('hidden'), false);
    assert.equal(element.style.values['pointer-events'], 'auto');
  }

  assert.equal(subscription.removed, true);
  assert.equal(window.premiumAccessState.premium, true);
  assert.equal(subtitle.textContent, 'Decision Center');
  portfolio.onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(window.location.href, '/portfolio-planner');
});

test('website data APIs use approval-based server access', () => {
  const auth = read('lib/subscription-auth.js');
  const sectorHot = read('lib/sector-hot-legacy.js');
  const adminUsers = read('api/admin-users.js');

  assert.match(auth, /access\.account\.is_approved !== true/);
  assert.match(auth, /access_level:'approved'/);
  assert.match(sectorHot, /requirePremiumEntitlement\(req, supabase\)/);
  assert.match(adminUsers, /action === 'portfolio_access'/);
  assert.match(adminUsers, /account\.is_approved !== true/);
  assert.match(adminUsers, /account\.is_blocked === true/);
});
