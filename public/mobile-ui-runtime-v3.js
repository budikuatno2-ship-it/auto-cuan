// Auto-Cuan mobile/desktop UI stabilization pass.
//
// This runtime intentionally layers on top of the first two redesign passes. It
// corrects defects observed on real Android screenshots without changing access,
// navigation destinations, APIs, trading logic, or the Pattern admin gate.
(function (root) {
  'use strict';
  if (!root || !root.document || root.__AUTOCUAN_UI_RUNTIME_V3__) return;
  root.__AUTOCUAN_UI_RUNTIME_V3__ = '20260802-mobile-ui-runtime-v3';

  var doc = root.document;
  var STORAGE_KEY = 'autocuan_nav_launcher_pos_v3';
  var TAP_THRESHOLD = 18;
  var EDGE_GAP = 14;
  var FAB_SIZE = 56;
  var menuOpen = false;
  var quickOverlay = null;
  var launcher = null;
  var drag = null;
  var position = null;
  var lastPointerToggle = 0;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function visualBox() {
    var vv = root.visualViewport;
    return {
      left: vv ? vv.offsetLeft : 0,
      top: vv ? vv.offsetTop : 0,
      width: vv ? vv.width : (root.innerWidth || 390),
      height: vv ? vv.height : (root.innerHeight || 720)
    };
  }

  function syncVisualViewport() {
    var box = visualBox();
    var style = doc.documentElement.style;
    style.setProperty('--ac-vv-left', box.left + 'px');
    style.setProperty('--ac-vv-top', box.top + 'px');
    style.setProperty('--ac-vv-width', box.width + 'px');
    style.setProperty('--ac-vv-height', box.height + 'px');
    if (launcher && position) applyLauncherPosition(true);
    if (menuOpen) placeQuickMenu();
  }

  function injectCss() {
    if (doc.getElementById('acMobileUiRuntimeV3Css')) return;
    var style = doc.createElement('style');
    style.id = 'acMobileUiRuntimeV3Css';
    style.textContent = [
      '/* Desktop: status chips are already repeated in the dashboard hero. Keeping',
      '   them in the one-line header caused them to overlap Portfolio/navigation. */',
      '@media (min-width:1024px){',
      '  .header-shell>.flex{gap:10px!important;min-width:0}',
      '  .desktop-nav{justify-content:flex-start!important;gap:2px!important;overflow:hidden!important;min-width:0!important}',
      '  .desktop-nav .nav-btn{flex:0 1 auto!important;min-width:0!important;padding-left:8px!important;padding-right:8px!important;white-space:nowrap!important}',
      '  .desktop-header-chips{display:none!important}',
      '  .header-account{margin-left:auto!important}',
      '}',
      '@media (min-width:1024px) and (max-width:1320px){',
      '  .header-shell .brand-mark+div p{display:none!important}',
      '  .desktop-nav .nav-btn{font-size:11px!important;padding-left:6px!important;padding-right:6px!important}',
      '}',
      '',
      '/* The old panel is intentionally retired. It rendered as one oversized,',
      '   semi-transparent rectangle and exposed the page/chart behind it. */',
      '#acNavPanel{display:none!important}',
      '@media (max-width:1023px){',
      '  #acNavLauncher{opacity:.78!important;touch-action:none!important;-webkit-tap-highlight-color:transparent!important;user-select:none!important}',
      '  #acNavLauncher:active{opacity:1!important;transform:scale(.96)!important}',
      '  .ac-v3-overlay{position:fixed;inset:0;z-index:84;pointer-events:auto}',
      '  .ac-v3-backdrop{position:absolute;inset:0;border:0;background:rgba(2,6,14,.42);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}',
      '  .ac-v3-cluster{position:fixed;z-index:85;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;width:min(316px,calc(100vw - 28px));pointer-events:auto}',
      '  .ac-v3-action,.ac-v3-close{display:flex;align-items:center;gap:9px;min-height:48px;border:1px solid rgba(148,163,184,.22);background:rgba(13,18,27,.94);box-shadow:0 12px 32px rgba(0,0,0,.38);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);color:#dbe7f3}',
      '  .ac-v3-action{padding:11px 13px;border-radius:999px;font-size:13px;font-weight:700;text-align:left}',
      '  .ac-v3-action svg{width:18px;height:18px;flex:0 0 auto}',
      '  .ac-v3-action.active{border-color:rgba(52,211,153,.55);background:rgba(6,78,59,.78);color:#6ee7b7}',
      '  .ac-v3-action:active{transform:scale(.97)}',
      '  .ac-v3-close{position:fixed;z-index:86;justify-content:center;width:48px;height:48px;border-radius:999px;font-size:24px;line-height:1}',
      '}',
      '',
      '/* Fullscreen follows the visual viewport, not the layout viewport. This keeps',
      '   the chart directly below its compact header while Android/iOS browser chrome',
      '   expands or collapses. */',
      '.ac-viewer{inset:auto!important;left:var(--ac-vv-left,0px)!important;top:var(--ac-vv-top,0px)!important;width:var(--ac-vv-width,100vw)!important;height:var(--ac-vv-height,100dvh)!important;min-height:0!important}',
      '.ac-viewer-body{min-height:0!important}',
      '@media (max-width:639px){',
      '  .ac-viewer-head{padding:6px 8px!important;min-height:46px!important;align-items:center!important}',
      '  .ac-viewer-heading{max-width:48vw!important}',
      '  .ac-viewer-title{font-size:13px!important;line-height:1.2!important}',
      '  .ac-viewer-subtitle{font-size:9.5px!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}',
      '  .ac-viewer-actions{gap:5px!important}',
      '  .ac-viewer-btn{min-height:34px!important;padding:6px 8px!important;font-size:10.5px!important;border-radius:9px!important}',
      '  .ac-viewer-metrics{padding:5px 7px!important;font-size:9px!important}',
      '  .ac-viewer-hint{padding:3px 7px 5px!important;font-size:9px!important}',
      '}',
      '@media (orientation:landscape) and (max-height:520px){',
      '  .ac-viewer-subtitle,.ac-viewer-hint{display:none!important}',
      '  .ac-viewer-head{min-height:40px!important;padding:4px 7px!important}',
      '  .ac-viewer-btn{min-height:30px!important;padding:4px 7px!important}',
      '  .ac-viewer-metrics{padding:3px 6px!important}',
      '}'
    ].join('\n');
    doc.head.appendChild(style);
  }

  function visibleNavButtons() {
    var source = doc.getElementById('mainNav');
    if (!source) return [];
    return Array.prototype.filter.call(source.querySelectorAll('.nav-btn[data-page]'), function (button) {
      return !button.disabled && !button.classList.contains('hidden') && button.getAttribute('aria-hidden') !== 'true';
    });
  }

  function readPosition() {
    try {
      var parsed = JSON.parse(root.localStorage.getItem(STORAGE_KEY) || 'null');
      if (parsed && Number.isFinite(parsed.y) && (parsed.side === 'left' || parsed.side === 'right')) return parsed;
    } catch (_) {}
    return { side: 'right', y: visualBox().top + visualBox().height * .58 };
  }

  function savePosition() {
    try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify({ side: position.side, y: position.y })); } catch (_) {}
  }

  function launcherBounds() {
    var box = visualBox();
    return {
      minX: box.left + EDGE_GAP,
      maxX: box.left + box.width - FAB_SIZE - EDGE_GAP,
      minY: box.top + EDGE_GAP,
      maxY: box.top + box.height - FAB_SIZE - EDGE_GAP
    };
  }

  function applyLauncherPosition(keepSide) {
    if (!launcher || !position) return;
    var bounds = launcherBounds();
    if (!keepSide && Number.isFinite(position.x)) {
      position.side = position.x + FAB_SIZE / 2 < visualBox().left + visualBox().width / 2 ? 'left' : 'right';
    }
    position.y = clamp(position.y, bounds.minY, bounds.maxY);
    position.x = position.side === 'left' ? bounds.minX : bounds.maxX;
    launcher.style.left = position.x + 'px';
    launcher.style.top = position.y + 'px';
    launcher.setAttribute('data-side', position.side);
  }

  function closeQuickMenu() {
    menuOpen = false;
    if (quickOverlay && quickOverlay.parentNode) quickOverlay.parentNode.removeChild(quickOverlay);
    quickOverlay = null;
    if (launcher) {
      launcher.setAttribute('aria-expanded', 'false');
      launcher.focus({ preventScroll: true });
    }
    doc.removeEventListener('keydown', onQuickKey, true);
  }

  function onQuickKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeQuickMenu();
    }
  }

  function placeQuickMenu() {
    if (!quickOverlay || !launcher) return;
    var cluster = quickOverlay.querySelector('.ac-v3-cluster');
    var close = quickOverlay.querySelector('.ac-v3-close');
    if (!cluster || !close) return;
    var box = visualBox();
    var rect = launcher.getBoundingClientRect();
    var width = Math.min(316, box.width - 28);
    var itemCount = visibleNavButtons().length;
    var rows = Math.max(1, Math.ceil(itemCount / 2));
    var height = rows * 58 - 10;
    var top = clamp(rect.top + rect.height / 2 - height / 2, box.top + 14, box.top + box.height - height - 14);
    cluster.style.top = top + 'px';
    cluster.style.width = width + 'px';
    if (position.side === 'right') {
      cluster.style.left = Math.max(box.left + 14, rect.left - width - 14) + 'px';
    } else {
      cluster.style.left = Math.min(box.left + box.width - width - 14, rect.right + 14) + 'px';
    }
    close.style.left = rect.left + 'px';
    close.style.top = rect.top + 'px';
  }

  function openQuickMenu() {
    if (menuOpen) { closeQuickMenu(); return; }
    var buttons = visibleNavButtons();
    if (!buttons.length) return;
    menuOpen = true;
    quickOverlay = doc.createElement('div');
    quickOverlay.className = 'ac-v3-overlay';

    var backdrop = doc.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'ac-v3-backdrop';
    backdrop.setAttribute('aria-label', 'Tutup navigasi cepat');
    backdrop.addEventListener('click', closeQuickMenu);

    var cluster = doc.createElement('div');
    cluster.className = 'ac-v3-cluster';
    cluster.setAttribute('role', 'dialog');
    cluster.setAttribute('aria-label', 'Navigasi cepat');

    buttons.forEach(function (source) {
      var action = doc.createElement('button');
      action.type = 'button';
      action.className = 'ac-v3-action' + (source.classList.contains('active') ? ' active' : '');
      var svg = source.querySelector('svg');
      if (svg) action.appendChild(svg.cloneNode(true));
      var label = doc.createElement('span');
      var sourceLabel = source.querySelector('span');
      label.textContent = (sourceLabel ? sourceLabel.textContent : source.textContent || '').trim();
      action.appendChild(label);
      action.addEventListener('click', function () {
        closeQuickMenu();
        source.click();
      });
      cluster.appendChild(action);
    });

    var close = doc.createElement('button');
    close.type = 'button';
    close.className = 'ac-v3-close';
    close.setAttribute('aria-label', 'Tutup navigasi cepat');
    close.textContent = '×';
    close.addEventListener('click', closeQuickMenu);

    quickOverlay.appendChild(backdrop);
    quickOverlay.appendChild(cluster);
    quickOverlay.appendChild(close);
    doc.body.appendChild(quickOverlay);
    launcher.setAttribute('aria-expanded', 'true');
    placeQuickMenu();
    doc.addEventListener('keydown', onQuickKey, true);
    var first = cluster.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }

  function installLauncherFix() {
    var current = doc.getElementById('acNavLauncher');
    if (!current || current.getAttribute('data-ac-v3') === 'true') return Boolean(current);

    // Replacing the node removes the previous 6px pointer listeners. A real finger
    // commonly jitters more than 6px, which made normal taps get classified as drags.
    launcher = current.cloneNode(true);
    launcher.setAttribute('data-ac-v3', 'true');
    launcher.setAttribute('aria-expanded', 'false');
    current.parentNode.replaceChild(launcher, current);
    position = readPosition();
    applyLauncherPosition(true);

    launcher.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: position.x,
        originY: position.y,
        moved: false
      };
      try { launcher.setPointerCapture(event.pointerId); } catch (_) {}
    });

    launcher.addEventListener('pointermove', function (event) {
      if (!drag || drag.id !== event.pointerId) return;
      var dx = event.clientX - drag.startX;
      var dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < TAP_THRESHOLD) return;
      drag.moved = true;
      position.x = drag.originX + dx;
      position.y = drag.originY + dy;
      launcher.style.left = position.x + 'px';
      launcher.style.top = position.y + 'px';
      event.preventDefault();
    }, { passive: false });

    launcher.addEventListener('pointerup', function (event) {
      if (!drag || drag.id !== event.pointerId) return;
      var moved = drag.moved;
      drag = null;
      lastPointerToggle = Date.now();
      if (moved) {
        applyLauncherPosition(false);
        savePosition();
      } else {
        openQuickMenu();
      }
      event.preventDefault();
    }, { passive: false });

    launcher.addEventListener('pointercancel', function () { drag = null; });
    launcher.addEventListener('click', function (event) {
      // Fallback for browsers that synthesize click but lose pointerup. Ignore the
      // click that naturally follows our own pointerup.
      if (Date.now() - lastPointerToggle < 500) { event.preventDefault(); return; }
      openQuickMenu();
      event.preventDefault();
    });
    return true;
  }

  function installChartHeightFix() {
    if (typeof root.chartDims !== 'function' || root.chartDims.__acV3) return false;
    var original = root.chartDims;
    var replacement = function (variant, viewportWidth, viewportHeight) {
      if (variant !== 'fullscreen') return original(variant, viewportWidth, viewportHeight);
      var box = visualBox();
      var width = Number(viewportWidth) > 0 ? Number(viewportWidth) : box.width;
      var height = box.height || (Number(viewportHeight) > 0 ? Number(viewportHeight) : 720);
      var mobile = width < 640;
      var rsi = mobile ? 64 : 82;
      // Compact header + metrics + hint. The old fixed 168px subtraction left the
      // usable chart lower and smaller than necessary on phones with browser chrome.
      var chrome = mobile ? 104 : 118;
      return { main: Math.max(mobile ? 260 : 340, Math.floor(height - chrome - rsi)), rsi: rsi };
    };
    replacement.__acV3 = true;
    replacement.__original = original;
    root.chartDims = replacement;
    return true;
  }

  injectCss();
  syncVisualViewport();

  var attempts = 0;
  var timer = root.setInterval(function () {
    attempts += 1;
    var launcherReady = installLauncherFix();
    var chartReady = installChartHeightFix();
    if ((launcherReady && chartReady) || attempts > 240) root.clearInterval(timer);
  }, 50);

  root.addEventListener('resize', syncVisualViewport, { passive: true });
  root.addEventListener('orientationchange', function () { root.setTimeout(syncVisualViewport, 80); }, { passive: true });
  if (root.visualViewport) {
    root.visualViewport.addEventListener('resize', syncVisualViewport, { passive: true });
    root.visualViewport.addEventListener('scroll', syncVisualViewport, { passive: true });
  }
})(typeof window !== 'undefined' ? window : null);
