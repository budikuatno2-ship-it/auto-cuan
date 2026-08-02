// Floating mobile navigation launcher for the Auto-Cuan dashboard.
//
// WHY THIS EXISTS
// The mobile header nav (`#mainNav`) is a horizontal scroll strip. On a 390px phone
// its buttons total ~680px, so anything past the fourth item — including the
// admin-only Pattern button, injected before Chart — sits off-screen behind a faint
// gradient. The feature was effectively undiscoverable on a phone.
//
// This runtime mirrors `#mainNav` into a draggable, edge-snapping circular launcher
// (AssistiveTouch-style) that opens a compact popover with every available
// destination. `#mainNav` stays in the DOM (hidden by CSS below 1024px) as the single
// source of truth, so other runtimes keep injecting into it and a MutationObserver
// picks those changes up automatically.
//
// Taps delegate to the original button's own click handler, so navigateTo(), the
// Pattern navigation wrapper, login gates and approval-based hiding all keep working.
// This file adds no navigation logic of its own.
//
// Unlike a fixed bottom bar, a floating control reserves no layout space, so it
// cannot create the body-padding / 100vh conflict that produced a dead band at the
// foot of every page.
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanMobileNav = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VERSION = '20260802-mobile-nav-v2';
  var STORAGE_KEY = 'autocuan_nav_launcher_pos_v1';
  var FAB_SIZE = 56;
  var EDGE_GAP = 12;
  // Below this movement a pointer interaction is a tap, not a drag. Distance rather
  // than a timer, so a slow deliberate tap still opens the menu.
  var DRAG_THRESHOLD = 6;

  // Destinations the launcher lists first. Anything not named still appears, in
  // source order, after the ranked ones.
  var PRIORITY = ['dashboard', 'analisis', 'pattern', 'chart', 'screener', 'sektor', 'portofolio'];

  // Pure: turn nav buttons into the launcher model. Hidden buttons are dropped (that
  // is how the approval gate and the Pattern admin gate express "no access"),
  // duplicates collapse to the first occurrence.
  function buildNavModel(items) {
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
    return { all: ranked, active: ranked.filter(function (item) { return item.active; })[0] || null };
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

  // Pure: snap a dragged launcher to an edge and keep it fully inside the safe
  // area, so it can never end up partly or wholly unreachable.
  //
  // `preferredSide` pins the edge instead of deriving it from the current centre.
  // Rotation uses it: a control parked on the right must stay on the right, even
  // though its old x lands in the left half of the now-wider viewport.
  function snapPosition(pos, viewport, preferredSide) {
    var size = viewport.size || FAB_SIZE;
    var insets = viewport.insets || { top: 0, right: 0, bottom: 0, left: 0 };
    var minX = EDGE_GAP + insets.left;
    var maxX = Math.max(minX, viewport.width - size - EDGE_GAP - insets.right);
    var minY = EDGE_GAP + insets.top;
    var maxY = Math.max(minY, viewport.height - size - EDGE_GAP - insets.bottom);
    var side = preferredSide === 'left' || preferredSide === 'right'
      ? preferredSide
      : (pos.x + size / 2 < viewport.width / 2 ? 'left' : 'right');
    var y = pos.y < minY ? minY : (pos.y > maxY ? maxY : pos.y);
    return { x: side === 'left' ? minX : maxX, y: y, side: side };
  }

  // Pure: the popover opens away from the launcher so it never covers it, and flips
  // vertically when there is not enough room below.
  function panelPlacement(pos, viewport) {
    var size = viewport.size || FAB_SIZE;
    var side = pos.x + size / 2 < viewport.width / 2 ? 'left' : 'right';
    var below = viewport.height - (pos.y + size);
    return { side: side, origin: below > 260 ? 'below' : 'above' };
  }

  function readStoredPosition(root) {
    try {
      var raw = root.localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || !Number.isFinite(Number(parsed.x)) || !Number.isFinite(Number(parsed.y))) return null;
      return { x: Number(parsed.x), y: Number(parsed.y), side: parsed.side === 'left' ? 'left' : 'right' };
    } catch (_) { return null; }
  }

  function writeStoredPosition(root, pos) {
    try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: pos.x, y: pos.y, side: pos.side })); } catch (_) {}
  }

  function readInset(root, name) {
    try {
      var probe = root.document.createElement('div');
      probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;height:env(' + name + ',0px)';
      root.document.body.appendChild(probe);
      var value = probe.getBoundingClientRect ? probe.getBoundingClientRect().height : 0;
      probe.parentNode.removeChild(probe);
      return Number.isFinite(value) ? value : 0;
    } catch (_) { return 0; }
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
    function div(className) {
      var node = doc.createElement('div');
      node.className = className;
      return node;
    }

    // Built with createElement rather than innerHTML: no markup string carries a
    // label, so nothing here can become an injection surface.
    var launcher = doc.createElement('button');
    launcher.type = 'button';
    launcher.id = 'acNavLauncher';
    launcher.className = 'ac-launcher ac-hidden';
    launcher.setAttribute('aria-haspopup', 'dialog');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', 'Buka menu navigasi');
    var launcherRing = div('ac-launcher-ring');
    var launcherIcon = div('ac-launcher-icon');
    // Static markup, no interpolated values.
    launcherIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="3.2" stroke-width="1.6"/><circle cx="12" cy="12" r="8.4" stroke-width="1.2" opacity=".55"/></svg>';
    launcher.appendChild(launcherRing);
    launcher.appendChild(launcherIcon);

    var panel = doc.createElement('div');
    panel.id = 'acNavPanel';
    panel.className = 'ac-navpanel hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', 'Navigasi cepat');

    var backdrop = div('ac-navpanel-backdrop');
    var card = div('ac-navpanel-card');
    var head = div('ac-navpanel-head');
    var title = doc.createElement('p');
    title.className = 'ac-navpanel-title';
    title.textContent = 'Buka Halaman';
    var closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ac-navpanel-close';
    closeBtn.setAttribute('aria-label', 'Tutup menu navigasi');
    closeBtn.textContent = '×';
    var grid = div('ac-navpanel-grid');
    head.appendChild(title);
    head.appendChild(closeBtn);
    card.appendChild(head);
    card.appendChild(grid);
    panel.appendChild(backdrop);
    panel.appendChild(card);

    doc.body.appendChild(launcher);
    doc.body.appendChild(panel);

    var insets = { top: readInset(root, 'safe-area-inset-top'), right: readInset(root, 'safe-area-inset-right'),
      bottom: readInset(root, 'safe-area-inset-bottom'), left: readInset(root, 'safe-area-inset-left') };

    function viewport() {
      return {
        width: root.innerWidth || 390,
        height: root.innerHeight || 720,
        size: launcher.offsetHeight || FAB_SIZE,
        insets: insets
      };
    }

    var stored = readStoredPosition(root);
    var position = stored || { x: 1e6, y: (root.innerHeight || 720) - 180, side: 'right' };
    // `keepSide` re-snaps to the remembered edge (rotation, resize); a finished drag
    // passes nothing so the edge is re-derived from where the finger let go.
    function applyPosition(keepSide) {
      var next = snapPosition(position, viewport(), keepSide === false ? null : position.side);
      position = { x: next.x, y: next.y, side: next.side };
      launcher.style.left = next.x + 'px';
      launcher.style.top = next.y + 'px';
      launcher.setAttribute('data-side', next.side);
    }
    applyPosition();

    // ---- Panel open / close -------------------------------------------------
    var lastFocus = null;
    function isOpen() { return !panel.classList.contains('hidden'); }

    // The popover has a full-screen backdrop, so the page behind it must not
    // scroll or rubber-band. Reuses the viewer's iOS-safe lock when it is loaded;
    // the two are appended independently, so the presence check is required.
    function scrollLock(locked) {
      var api = root.AutoCuanChartViewer;
      if (!api) return;
      try { locked ? api.lockScroll(root) : api.unlockScroll(root); } catch (_) {}
    }

    function closePanel(restoreFocus) {
      if (!isOpen()) return;
      panel.classList.add('hidden');
      scrollLock(false);
      launcher.setAttribute('aria-expanded', 'false');
      launcher.classList.remove('ac-launcher-open');
      if (restoreFocus !== false && lastFocus && typeof lastFocus.focus === 'function') {
        try { lastFocus.focus(); } catch (_) {}
      }
    }

    function openPanel() {
      render();
      var place = panelPlacement(position, viewport());
      panel.setAttribute('data-side', place.side);
      panel.setAttribute('data-origin', place.origin);
      card.style.left = place.side === 'left' ? (EDGE_GAP + insets.left) + 'px' : '';
      card.style.right = place.side === 'right' ? (EDGE_GAP + insets.right) + 'px' : '';
      var size = viewport().size;
      if (place.origin === 'below') {
        card.style.top = (position.y + size + 10) + 'px';
        card.style.bottom = '';
      } else {
        card.style.bottom = ((root.innerHeight || 720) - position.y + 10) + 'px';
        card.style.top = '';
      }
      lastFocus = doc.activeElement;
      panel.classList.remove('hidden');
      scrollLock(true);
      launcher.setAttribute('aria-expanded', 'true');
      launcher.classList.add('ac-launcher-open');
      var first = grid.children[0];
      if (first && typeof first.focus === 'function') first.focus();
    }

    backdrop.addEventListener('click', function () { closePanel(); });
    closeBtn.addEventListener('click', function () { closePanel(); });
    doc.addEventListener('keydown', function (event) {
      if (!isOpen()) return;
      if (event.key === 'Escape') { event.preventDefault(); closePanel(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      // Roving arrow-key navigation between destination chips.
      var items = Array.prototype.slice.call(grid.children);
      var index = items.indexOf(doc.activeElement);
      if (index < 0) return;
      event.preventDefault();
      var next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      if (items[next] && items[next].focus) items[next].focus();
    });

    // ---- Drag ---------------------------------------------------------------
    var drag = null;
    launcher.addEventListener('pointerdown', function (event) {
      // Keyboard activation never produces a pointerdown, so keyboard users simply
      // get the popover with no drag behaviour attached.
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: position.x,
        originY: position.y,
        moved: false
      };
      if (launcher.setPointerCapture) { try { launcher.setPointerCapture(event.pointerId); } catch (_) {} }
    });

    launcher.addEventListener('pointermove', function (event) {
      if (!drag || drag.id !== event.pointerId) return;
      var dx = event.clientX - drag.startX;
      var dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      launcher.classList.add('ac-launcher-dragging');
      position = { x: drag.originX + dx, y: drag.originY + dy, side: position.side };
      launcher.style.left = position.x + 'px';
      launcher.style.top = position.y + 'px';
      event.preventDefault();
    });

    function endDrag(event) {
      if (!drag || drag.id !== event.pointerId) return;
      var moved = drag.moved;
      drag = null;
      launcher.classList.remove('ac-launcher-dragging');
      if (moved) {
        applyPosition(false);
        writeStoredPosition(root, position);
        return;
      }
      if (isOpen()) closePanel(); else openPanel();
    }
    launcher.addEventListener('pointerup', endDrag);
    launcher.addEventListener('pointercancel', function (event) {
      if (drag && drag.id === event.pointerId) { drag = null; launcher.classList.remove('ac-launcher-dragging'); }
    });
    // Keyboard / assistive activation: pointer events never fired, so handle it here.
    launcher.addEventListener('click', function (event) {
      if (event.detail !== 0) return;
      if (isOpen()) closePanel(); else openPanel();
    });

    // ---- Rendering ----------------------------------------------------------
    // Delegating to the original button keeps every existing handler, gate and side
    // effect intact — this runtime never calls navigateTo itself.
    function activate(page, origin) {
      var target = origin;
      if (!target && /^[a-z0-9-]+$/.test(String(page))) {
        target = source.querySelector('.nav-btn[data-page="' + page + '"]');
      }
      closePanel(false);
      if (target && typeof target.click === 'function') target.click();
    }

    function makeItem(item) {
      var button = doc.createElement('button');
      button.type = 'button';
      button.className = 'ac-navpanel-item' + (item.active ? ' active' : '');
      button.setAttribute('data-page', item.page);
      if (item.active) button.setAttribute('aria-current', 'page');
      var svg = item.source && item.source.querySelector ? item.source.querySelector('svg') : null;
      if (svg) {
        var wrap = div('ac-nav-icon');
        wrap.appendChild(svg.cloneNode(true));
        button.appendChild(wrap);
      }
      var text = doc.createElement('span');
      text.className = 'ac-nav-label';
      text.textContent = item.label;
      button.appendChild(text);
      button.addEventListener('click', function () { activate(item.page, item.source); });
      return button;
    }

    // The launcher belongs to the signed-in dashboard shell only. The landing page,
    // the blocked screen and the maintenance screen share the same <body>, so
    // without this check a logged-out visitor would get app navigation.
    var shell = doc.getElementById('dashboardScreen');
    function shellVisible() {
      return Boolean(shell && shell.classList && !shell.classList.contains('hidden'));
    }
    function applyShellVisibility() {
      var visible = shellVisible();
      launcher.classList.toggle('ac-hidden', !visible);
      if (!visible) closePanel(false);
      return visible;
    }

    var lastSignature = null;
    function render() {
      var onShell = applyShellVisibility();
      var items = readNavItems(source);
      var model = buildNavModel(items);
      var byPage = Object.create(null);
      items.forEach(function (item) { byPage[item.page] = item; });

      var signature = model.all.map(function (item) {
        return item.page + (item.active ? '!' : '');
      }).join(',') + '|' + (onShell ? '1' : '0');
      if (signature === lastSignature) return model;
      lastSignature = signature;

      grid.textContent = '';
      model.all.forEach(function (item) {
        grid.appendChild(makeItem({
          page: item.page, label: item.label, active: item.active,
          source: byPage[item.page] && byPage[item.page].source
        }));
      });
      launcher.setAttribute('aria-label',
        model.active ? 'Buka menu navigasi. Halaman aktif: ' + model.active.label : 'Buka menu navigasi');
      return model;
    }

    render();

    // `#mainNav` is mutated at runtime: the approval gate toggles `hidden`, the
    // Pattern runtime injects and removes its button, and navigateTo moves the
    // `active` class. Observing it keeps the launcher honest without any coupling.
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

    // Rotation and resize change what "the edge" means; re-snap and close the popover
    // rather than leaving it anchored to a stale position.
    function onViewportChange() {
      closePanel(false);
      applyPosition();
    }
    root.addEventListener('resize', onViewportChange);
    root.addEventListener('orientationchange', onViewportChange);

    root.AutoCuanMobileNavRuntime = {
      version: VERSION, render: render, openPanel: openPanel, closePanel: closePanel,
      launcher: launcher, panel: panel, grid: grid,
      position: function () { return { x: position.x, y: position.y }; }
    };
  }

  return {
    version: VERSION,
    STORAGE_KEY: STORAGE_KEY,
    FAB_SIZE: FAB_SIZE,
    EDGE_GAP: EDGE_GAP,
    DRAG_THRESHOLD: DRAG_THRESHOLD,
    PRIORITY: PRIORITY,
    buildNavModel: buildNavModel,
    readNavItems: readNavItems,
    snapPosition: snapPosition,
    panelPlacement: panelPlacement,
    install: install
  };
});
