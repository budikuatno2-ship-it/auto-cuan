'use strict';

// ===========================================================================
// P0 regression: signed-out visitors could not log in OR register, on desktop
// and mobile alike.
//
// ROOT CAUSE (pre-fix): #loginModal, #registerModal and #selfResetModal were
// authored INSIDE #dashboardScreen in public/index.html. setTopLevelView()
// (public/index.html) hides every non-active top-level view with
//   el.classList.toggle('hidden', !active)   -> display:none
//   el.inert = !active                       -> whole subtree non-interactive
// so on the landing page — the only place a signed-out visitor can be —
// #dashboardScreen was display:none AND inert. openLoginModal() /
// openRegisterModal() / openSelfResetModal() only clear .hidden on the modal
// itself, never on the ancestor, so the modal stayed invisible and dead.
//
// This test rebuilds the real element tree from public/index.html, runs the
// REAL setTopLevelView() and the REAL open*Modal() sources in a vm against a
// minimal DOM, and asserts the opened modal is actually visible and
// interactive. It fails on the pre-fix markup and passes on the fix.
//
// LOCAL / STATIC ONLY. No browser, no network, no backend.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(INDEX_HTML, 'utf8');

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);
// Elements whose content is raw text, so markup inside them is not structure.
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

// --- Minimal, quote-aware HTML structure parser ----------------------------
// Only what this test needs: element nesting, id and class. Attribute values
// may legitimately contain '>' (inline onclick handlers do), so the scanner
// tracks quoting instead of searching for the next '>'.
function parseStructure(source) {
  const root = { tagName: 'ROOT', id: null, classes: [], parent: null, children: [] };
  let current = root;
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) break;

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    const closing = source[lt + 1] === '/';
    const nameStart = lt + (closing ? 2 : 1);
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(source.slice(nameStart, nameStart + 64));
    if (!nameMatch) { i = lt + 1; continue; }
    const tagName = nameMatch[0].toLowerCase();

    // Walk to the tag's '>' while respecting quoted attribute values.
    let j = nameStart + nameMatch[0].length;
    let quote = null;
    while (j < source.length) {
      const ch = source[j];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      j++;
    }
    const rawAttrs = source.slice(nameStart + nameMatch[0].length, j);
    const selfClosing = rawAttrs.trimEnd().endsWith('/');
    i = j + 1;

    if (closing) {
      for (let node = current; node && node !== root; node = node.parent) {
        if (node.tagName === tagName) { current = node.parent; break; }
      }
      continue;
    }

    const idMatch = /\bid\s*=\s*"([^"]*)"/.exec(rawAttrs) || /\bid\s*=\s*'([^']*)'/.exec(rawAttrs);
    const classMatch = /\bclass\s*=\s*"([^"]*)"/.exec(rawAttrs) || /\bclass\s*=\s*'([^']*)'/.exec(rawAttrs);
    const node = {
      tagName,
      id: idMatch ? idMatch[1] : null,
      classes: classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [],
      parent: current,
      children: []
    };
    current.children.push(node);

    if (VOID_ELEMENTS.has(tagName) || selfClosing) continue;
    if (RAW_TEXT_ELEMENTS.has(tagName)) {
      const closeIdx = source.toLowerCase().indexOf('</' + tagName, i);
      if (closeIdx !== -1) {
        const closeEnd = source.indexOf('>', closeIdx);
        i = closeEnd === -1 ? source.length : closeEnd + 1;
      }
      continue;
    }
    current = node;
  }

  return root;
}

// --- Minimal DOM over the parsed structure ---------------------------------
function buildDom(root) {
  const byId = new Map();

  function decorate(node) {
    const classes = new Set(node.classes);
    node.inert = false;
    node.attributes = Object.create(null);
    node.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      }
    };
    node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
    node.getAttribute = (name) => (name in node.attributes ? node.attributes[name] : null);
    if (node.id && !byId.has(node.id)) byId.set(node.id, node);
    node.children.forEach(decorate);
  }
  decorate(root);

  return {
    document: {
      getElementById: (id) => byId.get(id) || null
    },
    byId
  };
}

// Visible only when neither the element nor any ancestor is display:none.
function hiddenAncestor(node) {
  for (let el = node; el && el.tagName !== 'ROOT'; el = el.parent) {
    if (el.classList.contains('hidden')) return el;
  }
  return null;
}

function inertAncestor(node) {
  for (let el = node; el && el.tagName !== 'ROOT'; el = el.parent) {
    if (el.inert === true) return el;
  }
  return null;
}

// --- Extract real functions out of the inline <script> --------------------
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'expected to find ' + signature + ' in public/index.html');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces for ' + signature);
}

function makeRuntime() {
  const dom = buildDom(parseStructure(html));
  const sandbox = {
    document: dom.document,
    // The landing page is the signed-out view: maintenance resolved OFF and no
    // admin session, exactly the state a visitor clicking "Login" is in.
    maintenanceLockActive: () => false,
    serviceStatusUnverified: () => false,
    isServerVerifiedAdmin: () => false,
    applyMaintenanceGate: () => {},
    updateLandingCtas: () => {},
    resetRegisterApprovalView: () => {},
    loadPremiumAccess: () => {},
    resetPremiumAccess: () => {},
    setTimeout: (fn) => { fn(); return 0; }
  };
  vm.createContext(sandbox);
  [
    'function setTopLevelView(',
    'function openLoginModal(',
    'function closeLoginModal(',
    'function openRegisterModal(',
    'function openSelfResetModal('
  ].forEach((signature) => {
    vm.runInContext(extractFunction(html, signature), sandbox);
  });
  return { sandbox, byId: dom.byId };
}

test('the three signed-out auth modals are not nested inside #dashboardScreen', () => {
  const { byId } = makeRuntime();
  ['loginModal', 'registerModal', 'selfResetModal'].forEach((id) => {
    const modal = byId.get(id);
    assert.ok(modal, '#' + id + ' must exist in public/index.html');
    const ancestors = [];
    for (let el = modal.parent; el && el.tagName !== 'ROOT'; el = el.parent) {
      if (el.id) ancestors.push(el.id);
    }
    assert.ok(
      !ancestors.includes('dashboardScreen'),
      '#' + id + ' must NOT be a descendant of #dashboardScreen (found ancestors: ' +
        (ancestors.join(' > ') || 'none') + '). setTopLevelView() hides and inerts ' +
        '#dashboardScreen on the landing page, which is where a signed-out visitor ' +
        'opens this modal from.'
    );
  });
});

test('openLoginModal() on the landing page yields a visible, interactive login modal', () => {
  const { sandbox, byId } = makeRuntime();
  sandbox.setTopLevelView('landing');

  const dashboard = byId.get('dashboardScreen');
  assert.equal(dashboard.classList.contains('hidden'), true, 'landing view must hide the dashboard');
  assert.equal(dashboard.inert, true, 'landing view must inert the dashboard');

  sandbox.openLoginModal();

  const modal = byId.get('loginModal');
  const blockedBy = hiddenAncestor(modal);
  assert.equal(blockedBy, null,
    'login modal is display:none' + (blockedBy && blockedBy.id ? ' via #' + blockedBy.id : ''));
  const inertBy = inertAncestor(modal);
  assert.equal(inertBy, null,
    'login modal is inert' + (inertBy && inertBy.id ? ' via #' + inertBy.id : ''));

  // The credential fields the user has to type into must be reachable too.
  ['loginUsername', 'loginPassword', 'loginBtn'].forEach((id) => {
    const field = byId.get(id);
    assert.ok(field, '#' + id + ' must exist');
    assert.equal(hiddenAncestor(field), null, '#' + id + ' must be visible once the modal is open');
    assert.equal(inertAncestor(field), null, '#' + id + ' must be interactive once the modal is open');
  });
});

test('openRegisterModal() on the landing page yields a visible, interactive register modal', () => {
  const { sandbox, byId } = makeRuntime();
  sandbox.setTopLevelView('landing');
  sandbox.openRegisterModal();

  const modal = byId.get('registerModal');
  assert.equal(hiddenAncestor(modal), null, 'register modal must not sit under a display:none ancestor');
  assert.equal(inertAncestor(modal), null, 'register modal must not sit under an inert ancestor');

  // Registration cannot succeed without the terms checkbox: the server rejects
  // any payload that does not echo the current terms version.
  ['regUsername', 'regPassword', 'regPasswordConfirm', 'regTermsAccepted', 'registerBtn'].forEach((id) => {
    const field = byId.get(id);
    assert.ok(field, '#' + id + ' must exist');
    assert.equal(hiddenAncestor(field), null, '#' + id + ' must be visible once the modal is open');
    assert.equal(inertAncestor(field), null, '#' + id + ' must be interactive once the modal is open');
  });
});

test('openSelfResetModal() on the landing page yields a visible, interactive reset modal', () => {
  const { sandbox, byId } = makeRuntime();
  sandbox.setTopLevelView('landing');
  sandbox.openSelfResetModal();

  const modal = byId.get('selfResetModal');
  assert.equal(hiddenAncestor(modal), null, 'self-reset modal must not sit under a display:none ancestor');
  assert.equal(inertAncestor(modal), null, 'self-reset modal must not sit under an inert ancestor');
});

test('the auth modals stay hidden until they are opened', () => {
  const { sandbox, byId } = makeRuntime();
  sandbox.setTopLevelView('landing');
  ['loginModal', 'registerModal', 'selfResetModal'].forEach((id) => {
    assert.equal(byId.get(id).classList.contains('hidden'), true,
      '#' + id + ' must carry .hidden in the authored markup so it does not cover the landing page');
  });
});

test('closing the login modal hides it again', () => {
  const { sandbox, byId } = makeRuntime();
  sandbox.setTopLevelView('landing');
  sandbox.openLoginModal();
  assert.equal(byId.get('loginModal').classList.contains('hidden'), false);
  sandbox.closeLoginModal();
  assert.equal(byId.get('loginModal').classList.contains('hidden'), true);
});
