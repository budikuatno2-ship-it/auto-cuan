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

    // ---- Wave 2: Mobile Bottom Bar & More Sheet -----------------------------
    var v2BottomBar = doc.createElement('nav');
    v2BottomBar.id = 'acBottomBar';
    v2BottomBar.className = 'ac-bottom-bar';
    v2BottomBar.setAttribute('data-ac-ui', 'v2');
    v2BottomBar.setAttribute('aria-label', 'Navigasi Bawah');

    var v2SheetBackdrop = doc.createElement('div');
    v2SheetBackdrop.id = 'acMoreSheetBackdrop';
    v2SheetBackdrop.className = 'ac-sheet-backdrop';
    v2SheetBackdrop.hidden = true;

    var v2MoreSheet = doc.createElement('div');
    v2MoreSheet.id = 'acMoreSheet';
    v2MoreSheet.className = 'ac-more-sheet';
    v2MoreSheet.setAttribute('role', 'dialog');
    v2MoreSheet.setAttribute('aria-modal', 'true');
    v2MoreSheet.setAttribute('aria-label', 'Menu Navigasi Lainnya');
    v2MoreSheet.setAttribute('data-ac-ui', 'v2');
    v2MoreSheet.hidden = true;

    function makeBottomBtn(page, label, svgPath, isMore) {
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'ac-bottom-nav-item';
      if (!isMore) btn.setAttribute('data-page', page);
      btn.setAttribute('aria-label', label);
      if (isMore) {
        btn.id = 'acBottomMoreBtn';
        btn.setAttribute('aria-haspopup', 'dialog');
        btn.setAttribute('aria-expanded', 'false');
      }
      var iconWrap = doc.createElement('span');
      iconWrap.className = 'ac-bottom-icon';
      iconWrap.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + svgPath + '</svg>';
      var textWrap = doc.createElement('span');
      textWrap.className = 'ac-bottom-text';
      textWrap.textContent = label;
      btn.appendChild(iconWrap);
      btn.appendChild(textWrap);
      return btn;
    }

    var dashBtn = makeBottomBtn('dashboard', 'Dashboard', '<path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>', false);
    var screenerBtn = makeBottomBtn('screener', 'Screener', '<path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>', false);
    screenerBtn.setAttribute('data-premium-nav', 'true');
    var watchlistBtn = makeBottomBtn('watchlist', 'Watchlist', '<path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>', false);
    watchlistBtn.setAttribute('data-premium-nav', 'true');
    var moreBtn = makeBottomBtn('more', 'Lainnya', '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>', true);

    function clickNav(page, targetId) {
      closeMoreSheet(false);
      if (targetId) {
        var el = doc.getElementById(targetId);
        if (el && typeof el.click === 'function') {
          el.click();
          return;
        }
      }
      activate(page);
    }

    dashBtn.addEventListener('click', function () { clickNav('dashboard'); });
    screenerBtn.addEventListener('click', function () { clickNav('screener'); });
    watchlistBtn.addEventListener('click', function () { clickNav('watchlist'); });

    v2BottomBar.appendChild(dashBtn);
    v2BottomBar.appendChild(screenerBtn);
    v2BottomBar.appendChild(watchlistBtn);
    v2BottomBar.appendChild(moreBtn);

    var sheetHead = doc.createElement('div');
    sheetHead.className = 'ac-sheet-head';
    var sheetTitle = doc.createElement('p');
    sheetTitle.className = 'ac-sheet-title';
    sheetTitle.textContent = 'Menu Navigasi';
    var sheetClose = doc.createElement('button');
    sheetClose.type = 'button';
    sheetClose.className = 'ac-sheet-close';
    sheetClose.setAttribute('aria-label', 'Tutup menu');
    sheetClose.textContent = '×';
    sheetHead.appendChild(sheetTitle);
    sheetHead.appendChild(sheetClose);

    var sheetBody = doc.createElement('div');
    sheetBody.className = 'ac-sheet-body';

    v2MoreSheet.appendChild(sheetHead);
    v2MoreSheet.appendChild(sheetBody);

    doc.body.appendChild(v2BottomBar);
    doc.body.appendChild(v2SheetBackdrop);
    doc.body.appendChild(v2MoreSheet);

    var lastSheetTrigger = null;
    function isMoreSheetOpen() { return !v2MoreSheet.hidden; }

    function isDestAuthorized(idOrSelector) {
      var el = typeof idOrSelector === 'string'
        ? (doc.getElementById(idOrSelector) || doc.querySelector(idOrSelector))
        : idOrSelector;
      if (!el) return false;
      if (el.classList.contains('hidden') || el.hasAttribute('hidden')) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      if (el.style.display === 'none') return false;
      return true;
    }

    function syncBottomNavVisibility() {
      var screenerAllowed = isDestAuthorized('tabScreener') || isDestAuthorized('#appSidebar [data-sidebar-page="screener"]');
      var watchlistAllowed = isDestAuthorized('tabWatchlist') || isDestAuthorized('#appSidebar [data-sidebar-page="watchlist"]');
      screenerBtn.classList.toggle('hidden', !screenerAllowed);
      watchlistBtn.classList.toggle('hidden', !watchlistAllowed);
    }

    function openMoreSheet() {
      lastSheetTrigger = (doc.activeElement && doc.activeElement !== doc.body) ? doc.activeElement : moreBtn;
      syncBottomNavVisibility();
      renderMoreSheetContent();
      v2SheetBackdrop.hidden = false;
      v2MoreSheet.hidden = false;
      moreBtn.setAttribute('aria-expanded', 'true');
      var appContent = doc.getElementById('appContent');
      if (appContent) appContent.setAttribute('aria-hidden', 'true');
      scrollLock(true);
      if (sheetClose && typeof sheetClose.focus === 'function') sheetClose.focus();
    }
    function closeMoreSheet(restoreFocus) {
      if (!isMoreSheetOpen()) return;
      v2SheetBackdrop.hidden = true;
      v2MoreSheet.hidden = true;
      moreBtn.setAttribute('aria-expanded', 'false');
      var appContent = doc.getElementById('appContent');
      if (appContent) appContent.removeAttribute('aria-hidden');
      scrollLock(false);
      if (restoreFocus !== false && lastSheetTrigger && typeof lastSheetTrigger.focus === 'function') {
        try { lastSheetTrigger.focus(); } catch (_) {}
      }
    }

    moreBtn.addEventListener('click', function () {
      if (isMoreSheetOpen()) closeMoreSheet(true);
      else openMoreSheet();
    });
    v2SheetBackdrop.addEventListener('click', function () { closeMoreSheet(true); });
    sheetClose.addEventListener('click', function () { closeMoreSheet(true); });

    doc.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isMoreSheetOpen()) {
        event.preventDefault();
        closeMoreSheet(true);
      }
    });

    // Trap focus inside More sheet when open
    v2MoreSheet.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var focusables = v2MoreSheet.querySelectorAll('button:not([disabled]):not([hidden]), [tabindex="0"]');
      if (!focusables || focusables.length === 0) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey) {
        if (doc.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (doc.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    if (root.visualViewport && typeof root.visualViewport.addEventListener === 'function') {
      root.visualViewport.addEventListener('resize', function () {
        var isKeyboard = root.visualViewport.height < (root.innerHeight || 720) * 0.75;
        if (v2BottomBar) {
          if (isKeyboard) v2BottomBar.classList.add('ac-keyboard-active');
          else v2BottomBar.classList.remove('ac-keyboard-active');
        }
      });
    }

    function makeSheetItem(label, iconSvg, onClick, isActive, badgeText) {
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'ac-sheet-item' + (isActive ? ' active' : '');
      if (isActive) btn.setAttribute('aria-current', 'page');
      var icon = doc.createElement('span');
      icon.className = 'ac-sheet-item-icon';
      icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + iconSvg + '</svg>';
      var text = doc.createElement('span');
      text.className = 'ac-sheet-item-text';
      text.textContent = label;
      btn.appendChild(icon);
      btn.appendChild(text);
      if (badgeText) {
        var badge = doc.createElement('span');
        badge.className = 'ac-sheet-badge';
        badge.textContent = badgeText;
        btn.appendChild(badge);
      }
      btn.addEventListener('click', function () {
        closeMoreSheet(false);
        onClick();
      });
      return btn;
    }

    function renderMoreSheetContent() {
      sheetBody.textContent = '';
      var curPage = root.currentPage || 'dashboard';
      var curSubTab = root.__ACTIVE_ANALISIS_SUBTAB__ || 'analisis-chart';
      var isAdm = typeof root.isAdmin === 'function' && root.isAdmin();

      // 1. DISCOVER GROUP
      var sektorAllowed = isDestAuthorized('tabSektor') || isDestAuthorized('#appSidebar [data-sidebar-page="sektor"]');
      if (sektorAllowed) {
        var groupDiscover = doc.createElement('div');
        groupDiscover.className = 'ac-sheet-group';
        var gDiscLabel = doc.createElement('p');
        gDiscLabel.className = 'ac-sheet-group-label';
        gDiscLabel.textContent = 'Discover';
        groupDiscover.appendChild(gDiscLabel);

        groupDiscover.appendChild(makeSheetItem('Sektor Hot', '<path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>', function () {
          clickNav('sektor', 'tabSektorHot');
        }, curPage === 'sektor'));
        sheetBody.appendChild(groupDiscover);
      }

      // 2. RESEARCH GROUP
      var groupResearch = doc.createElement('div');
      groupResearch.className = 'ac-sheet-group';
      var gResLabel = doc.createElement('p');
      gResLabel.className = 'ac-sheet-group-label';
      gResLabel.textContent = 'Research';
      groupResearch.appendChild(gResLabel);

      var researchItems = [
        { label: 'Analisis & Chart', subTab: 'analisis-chart', elId: 'tabAnalisisChart', icon: '<path d="M4 17V7m5 10V3m5 14v-5m5 5V8"/>' },
        { label: 'Bandarmologi', subTab: 'bandarmologi', elId: 'tabBandarmologi', icon: '<path d="M3 17l6-6 4 4 8-10M15 5h6v6"/>' },
        { label: 'Sinyal Intelijen', subTab: 'intel', elId: 'tabSinyalIntelijen', icon: '<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>' },
        { label: 'Broker Hunter', subTab: 'hunter', elId: 'tabBrokerHunter', icon: '<path d="M21 21l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0114 0z"/>' },
        { label: 'Insider', subTab: 'insider', elId: 'tabJejaringInsider', icon: '<path d="M8 7l8 4M8 17l8-4M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0M20 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0M8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0"/>' },
        { label: 'Ranking', subTab: 'ranking', elId: 'tabRankingHarian', icon: '<path d="M4 20V10h4v10M10 20V4h4v16M16 20v-7h4v7"/>' },
        { label: 'Financial', subTab: 'financial', elId: 'tabFinancial', icon: '<path d="M4 19V5m0 14h16M8 15l3-4 3 2 4-6"/>' },
        { label: 'Struktur Pasar', subTab: 'market-structure', elId: 'tabMarketStructure', icon: '<circle cx="8" cy="8" r="3"/><circle cx="16" cy="16" r="3"/><path d="M10.5 10.5l3 3M16 5v5M5 16h5"/>' }
      ];

      researchItems.forEach(function (r) {
        var isAct = curPage === 'analisis' && curSubTab === r.subTab;
        groupResearch.appendChild(makeSheetItem(r.label, r.icon, function () {
          clickNav('analisis', r.elId);
        }, isAct));
      });

      if (isAdm && isDestAuthorized('tabAnalisisPattern')) {
        groupResearch.appendChild(makeSheetItem('Pattern Radar', '<path d="M3 12h4l3-7 4 14 3-7h4"/>', function () {
          clickNav('analisis', 'tabAnalisisPattern');
        }, curPage === 'analisis' && curSubTab === 'pattern', 'ADMIN'));
      }
      sheetBody.appendChild(groupResearch);

      // 3. MONITOR GROUP
      var portfolioAllowed = isDestAuthorized('tabPortfolio') || isDestAuthorized('#appSidebar [data-sidebar-page="portofolio"]');
      var trackrecordAllowed = isDestAuthorized('tabTrackRecord') || isDestAuthorized('#appSidebar [data-sidebar-page="trackrecord"]');
      if (portfolioAllowed || trackrecordAllowed) {
        var groupMonitor = doc.createElement('div');
        groupMonitor.className = 'ac-sheet-group';
        var gMonLabel = doc.createElement('p');
        gMonLabel.className = 'ac-sheet-group-label';
        gMonLabel.textContent = 'Monitor';
        groupMonitor.appendChild(gMonLabel);

        if (portfolioAllowed) {
          groupMonitor.appendChild(makeSheetItem('Portfolio', '<path d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/>', function () {
            clickNav('portofolio');
          }, curPage === 'portofolio'));
        }

        if (trackrecordAllowed) {
          groupMonitor.appendChild(makeSheetItem('Track Record', '<path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>', function () {
            clickNav('trackrecord');
          }, curPage === 'trackrecord'));
        }
        sheetBody.appendChild(groupMonitor);
      }

      // 4. AKUN & PREFERENSI GROUP
      var groupAccount = doc.createElement('div');
      groupAccount.className = 'ac-sheet-group';
      var gAccLabel = doc.createElement('p');
      gAccLabel.className = 'ac-sheet-group-label';
      gAccLabel.textContent = 'Akun & Preferensi';
      groupAccount.appendChild(gAccLabel);

      groupAccount.appendChild(makeSheetItem('Account Center', '<circle cx="12" cy="7" r="4"/><path d="M5.5 21a8.5 8.5 0 0 1 13 0"/>', function () {
        if (typeof root.openAccountProfile === 'function') root.openAccountProfile();
      }, false));

      groupAccount.appendChild(makeSheetItem('Ganti Tema (Terang / Gelap)', '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>', function () {
        if (typeof root.toggleAppTheme === 'function') root.toggleAppTheme();
      }, false));

      groupAccount.appendChild(makeSheetItem('Logout', '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>', function () {
        if (typeof root.logout === 'function') root.logout();
      }, false));
      sheetBody.appendChild(groupAccount);
    }

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
      if (v2BottomBar) {
        v2BottomBar.classList.toggle('ac-hidden', !onShell);
        if (!onShell) closeMoreSheet(false);

        var cur = (root.currentPage) || (model.active && model.active.page) || 'dashboard';
        var isDirect = (cur === 'dashboard' || cur === 'screener' || cur === 'watchlist');

        dashBtn.classList.toggle('active', cur === 'dashboard');
        if (cur === 'dashboard') dashBtn.setAttribute('aria-current', 'page'); else dashBtn.removeAttribute('aria-current');

        screenerBtn.classList.toggle('active', cur === 'screener');
        if (cur === 'screener') screenerBtn.setAttribute('aria-current', 'page'); else screenerBtn.removeAttribute('aria-current');

        watchlistBtn.classList.toggle('active', cur === 'watchlist');
        if (cur === 'watchlist') watchlistBtn.setAttribute('aria-current', 'page'); else watchlistBtn.removeAttribute('aria-current');

        moreBtn.classList.toggle('active', !isDirect);
        if (!isDirect) moreBtn.setAttribute('data-active-child', cur); else moreBtn.removeAttribute('data-active-child');

        var screenerSrc = byPage['screener'];
        if (screenerSrc && screenerSrc.hidden) {
          screenerBtn.classList.add('hidden');
        } else if (screenerSrc) {
          screenerBtn.classList.remove('hidden');
        }
        var watchlistSrc = byPage['watchlist'];
        if (watchlistSrc && watchlistSrc.hidden) {
          watchlistBtn.classList.add('hidden');
        } else if (watchlistSrc) {
          watchlistBtn.classList.remove('hidden');
        }
      }

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
