// Mobile bottom navigation for the Auto-Cuan dashboard.
//
// WHY THIS EXISTS
// The mobile header nav (`#mainNav`) is a horizontal scroll strip. On a 390px
// phone its buttons total roughly 680px, so anything past the fourth item —
// including the admin-only Pattern button, which is injected before Chart —
// sits off-screen behind a faint gradient. The feature was effectively
// undiscoverable on a phone.
//
// This runtime mirrors `#mainNav` into a fixed bottom bar: the highest-priority
// destinations get a permanent slot and a "Menu" sheet lists every available
// page. `#mainNav` stays in the DOM (hidden by CSS below 1024px) so it remains
// the single source of truth — other runtimes keep injecting into it, and a
// MutationObserver picks those changes up automatically.
//
// Taps delegate to the original button's own click handler, so navigateTo(),
// the Pattern navigation wrapper, login gates and approval-based hiding all
// keep working exactly as before. This file adds no navigation logic of its own.
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanMobileNav = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VERSION = '20260802-mobile-nav-v1';
  var PRIMARY_SLOTS = 4;

  // Destinations the bottom bar prefers to surface, most important first.
  // Anything not listed still reaches the bar if a slot is free, and always
  // appears in the Menu sheet.
  var PRIORITY = ['dashboard', 'analisis', 'pattern', 'chart', 'screener', 'sektor', 'portofolio'];

  // The bar has ~72px per slot. Full page names wrap or truncate there, so the
  // bar uses a short form while the sheet keeps the original wording.
  var SHORT_LABELS = {
    analisis: 'Analisis',
    sektor: 'Sektor',
    portofolio: 'Porto'
  };

  function shortLabel(page, label) {
    return SHORT_LABELS[page] || label;
  }

  // Pure: turn the nav buttons into the bar model. Hidden buttons are dropped
  // (that is how the approval gate and the Pattern admin gate express "no
  // access"), duplicates collapse to the first occurrence, and the remaining
  // items are ordered by PRIORITY with unknown pages appended in source order.
  function buildNavModel(items, slots) {
    var limit = Number.isFinite(Number(slots)) ? Number(slots) : PRIMARY_SLOTS;
    var seen = Object.create(null);
    var visible = [];
    (Array.isArray(items) ? items : []).forEach(function (item) {
      if (!item || !item.page || item.hidden === true || seen[item.page]) return;
      seen[item.page] = true;
      visible.push({
        page: item.page,
        label: String(item.label == null ? item.page : item.label).trim() || item.page,
        active: item.active === true
      });
    });
    var ranked = visible.slice().sort(function (left, right) {
      var a = PRIORITY.indexOf(left.page);
      var b = PRIORITY.indexOf(right.page);
      return (a < 0 ? PRIORITY.length : a) - (b < 0 ? PRIORITY.length : b);
    });
    var primaryPages = Object.create(null);
    ranked.slice(0, Math.max(0, limit)).forEach(function (item) { primaryPages[item.page] = true; });
    return {
      // The bar keeps the natural nav order so its slots do not reshuffle when
      // a gated destination appears; only membership is priority-driven.
      primary: visible.filter(function (item) { return primaryPages[item.page]; }),
      all: visible,
      overflow: visible.filter(function (item) { return !primaryPages[item.page]; })
    };
  }

  function buttonLabel(button) {
    var span = button.querySelector ? button.querySelector('span') : null;
    var text = span ? span.textContent : button.textContent;
    return String(text == null ? '' : text).trim();
  }

  function isHidden(button) {
    if (button.classList && typeof button.classList.contains === 'function' && button.classList.contains('hidden')) return true;
    return button.disabled === true || button.getAttribute('aria-hidden') === 'true';
  }

  // Reads `#mainNav` into the shape buildNavModel expects.
  function readNavItems(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return [];
    return Array.prototype.map.call(container.querySelectorAll('.nav-btn[data-page]'), function (button) {
      return {
        page: button.getAttribute('data-page'),
        label: buttonLabel(button),
        hidden: isHidden(button),
        active: Boolean(button.classList && button.classList.contains('active')),
        source: button
      };
    });
  }

  function install(root) {
    if (!root || !root.document || root.__AUTOCUAN_MOBILE_NAV__) return false;
    var doc = root.document;

    function boot(attempt) {
      var source = doc.getElementById('mainNav');
      if (!source || !doc.body) {
        if (attempt < 240) root.setTimeout(function () { boot(attempt + 1); }, 50);
        return;
      }
      if (root.__AUTOCUAN_MOBILE_NAV__) return;
      root.__AUTOCUAN_MOBILE_NAV__ = VERSION;
      start(root, doc, source);
    }

    boot(0);
    return true;
  }

  function start(root, doc, source) {
    var bar = doc.createElement('nav');
    bar.id = 'acMobileNav';
    bar.className = 'ac-mobilenav';
    bar.setAttribute('aria-label', 'Navigasi utama seluler');

    function div(className) {
      var node = doc.createElement('div');
      node.className = className;
      return node;
    }

    // Built with createElement rather than innerHTML: no markup string ever
    // carries a label, so nothing here can become an injection surface.
    var sheet = doc.createElement('div');
    sheet.id = 'acMobileNavSheet';
    sheet.className = 'ac-sheet hidden';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Semua menu');

    var backdrop = div('ac-sheet-backdrop');
    var panel = div('ac-sheet-panel');
    var head = div('ac-sheet-head');
    var title = doc.createElement('h2');
    title.className = 'ac-sheet-title';
    title.textContent = 'Semua Menu';
    var close = doc.createElement('button');
    close.type = 'button';
    close.className = 'ac-sheet-close';
    close.setAttribute('aria-label', 'Tutup menu');
    close.textContent = '×';
    var grid = div('ac-sheet-grid');
    grid.id = 'acMobileNavSheetGrid';

    head.appendChild(title);
    head.appendChild(close);
    panel.appendChild(div('ac-sheet-grip'));
    panel.appendChild(head);
    panel.appendChild(grid);
    sheet.appendChild(backdrop);
    sheet.appendChild(panel);

    bar.classList.add('ac-hidden');
    doc.body.appendChild(bar);
    doc.body.appendChild(sheet);

    var moreButton = null;
    function closeSheet() {
      sheet.classList.add('hidden');
      if (moreButton) moreButton.setAttribute('aria-expanded', 'false');
    }
    function openSheet() {
      render();
      sheet.classList.remove('hidden');
      if (moreButton) moreButton.setAttribute('aria-expanded', 'true');
    }

    backdrop.addEventListener('click', closeSheet);
    close.addEventListener('click', closeSheet);
    doc.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !sheet.classList.contains('hidden')) closeSheet();
    });

    // Delegating to the original button keeps every existing handler, gate and
    // side effect intact — this runtime never calls navigateTo itself.
    function activate(page, origin) {
      // Prefer the node captured at render time; re-query only as a fallback,
      // with the page name constrained to the shape our own markup uses.
      var target = origin;
      if (!target && /^[a-z0-9-]+$/.test(String(page))) {
        target = source.querySelector('.nav-btn[data-page="' + page + '"]');
      }
      closeSheet();
      if (target && typeof target.click === 'function') target.click();
    }

    function iconFor(item) {
      var svg = item.source && item.source.querySelector ? item.source.querySelector('svg') : null;
      return svg ? svg.cloneNode(true) : null;
    }

    function makeItem(item, className, label) {
      var button = doc.createElement('button');
      button.type = 'button';
      button.className = className + (item.active ? ' active' : '');
      button.setAttribute('data-page', item.page);
      if (item.active) button.setAttribute('aria-current', 'page');
      var icon = iconFor(item);
      if (icon) {
        var wrap = doc.createElement('span');
        wrap.className = 'ac-nav-icon';
        wrap.appendChild(icon);
        button.appendChild(wrap);
      }
      var text = doc.createElement('span');
      text.className = 'ac-nav-label';
      text.textContent = label;
      button.appendChild(text);
      button.addEventListener('click', function () { activate(item.page, item.source); });
      return button;
    }

    // The bar belongs to the signed-in dashboard shell only. The landing page,
    // the blocked screen and the maintenance screen share the same <body>, so
    // without this check a logged-out visitor would get app navigation.
    var shell = doc.getElementById('dashboardScreen');
    function shellVisible() {
      return Boolean(shell && shell.classList && !shell.classList.contains('hidden'));
    }
    function applyShellVisibility() {
      var visible = shellVisible();
      bar.classList.toggle('ac-hidden', !visible);
      doc.body.classList.toggle('has-mobile-nav', visible);
      if (!visible) closeSheet();
      return visible;
    }

    var lastSignature = null;
    function render() {
      var onShell = applyShellVisibility();
      var items = readNavItems(source);
      var model = buildNavModel(items, PRIMARY_SLOTS);
      var byPage = Object.create(null);
      items.forEach(function (item) { byPage[item.page] = item; });

      var signature = model.all.map(function (item) {
        return item.page + (item.active ? '!' : '');
      }).join(',') + '|' + model.primary.length + '|' + (onShell ? '1' : '0') +
        '|' + (sheet.classList.contains('hidden') ? '0' : '1');
      if (signature === lastSignature) return model;
      lastSignature = signature;

      bar.textContent = '';
      model.primary.forEach(function (item) {
        var withSource = { page: item.page, label: item.label, active: item.active, source: byPage[item.page] && byPage[item.page].source };
        bar.appendChild(makeItem(withSource, 'ac-mobilenav-item', shortLabel(item.page, item.label)));
      });

      moreButton = doc.createElement('button');
      moreButton.type = 'button';
      moreButton.className = 'ac-mobilenav-item ac-mobilenav-more';
      moreButton.setAttribute('aria-haspopup', 'dialog');
      moreButton.setAttribute('aria-expanded', sheet.classList.contains('hidden') ? 'false' : 'true');
      var moreIcon = div('ac-nav-icon');
      // Static markup, no interpolated values.
      moreIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">' +
        '<path stroke-linecap="round" stroke-width="2" d="M4 7h16M4 12h16M4 17h16"/></svg>';
      var moreLabel = doc.createElement('span');
      moreLabel.className = 'ac-nav-label';
      moreLabel.textContent = 'Menu';
      moreButton.appendChild(moreIcon);
      moreButton.appendChild(moreLabel);
      moreButton.addEventListener('click', function () {
        if (sheet.classList.contains('hidden')) openSheet(); else closeSheet();
      });
      bar.appendChild(moreButton);

      grid.textContent = '';
      model.all.forEach(function (item) {
        var withSource = { page: item.page, label: item.label, active: item.active, source: byPage[item.page] && byPage[item.page].source };
        grid.appendChild(makeItem(withSource, 'ac-sheet-item', item.label));
      });
      return model;
    }

    render();

    // `#mainNav` is mutated at runtime: the approval gate toggles `hidden`, the
    // Pattern runtime injects and removes its button, and navigateTo moves the
    // `active` class. Observing it keeps the bar honest without any coupling.
    var scheduled = false;
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      root.setTimeout(function () { scheduled = false; render(); }, 60);
    }
    var observer = new root.MutationObserver(schedule);
    observer.observe(source, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'aria-hidden'] });
    // Login, logout, blocked and maintenance all flip `hidden` on the shell.
    if (shell) observer.observe(shell, { attributes: true, attributeFilter: ['class'] });

    root.AutoCuanMobileNavRuntime = {
      version: VERSION, render: render, openSheet: openSheet, closeSheet: closeSheet,
      bar: bar, sheet: sheet, grid: grid
    };
  }

  return {
    version: VERSION,
    PRIMARY_SLOTS: PRIMARY_SLOTS,
    PRIORITY: PRIORITY,
    shortLabel: shortLabel,
    buildNavModel: buildNavModel,
    readNavItems: readNavItems,
    install: install
  };
});
