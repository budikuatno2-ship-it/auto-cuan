// Auto-Cuan real-device UI stabilization.
// Presentation-only: fixes launcher interaction, mobile quick navigation, fullscreen
// chart sizing, and desktop header overflow without changing access or trading logic.
(function (root) {
  'use strict';
  if (!root || !root.document || root.__AUTOCUAN_UI_RUNTIME_V5__) return;
  root.__AUTOCUAN_UI_RUNTIME_V5__ = '20260803-mobile-ui-runtime-v5';

  var doc = root.document;
  var STORAGE_KEY = 'autocuan_nav_launcher_pos_v5';
  var FAB_SIZE = 56;
  var EDGE_GAP = 14;
  var LONG_PRESS_MS = 280;
  var MOVE_TOLERANCE = 14;

  var launcher = null;
  var position = null;
  var press = null;
  var menu = null;
  var suppressClickUntil = 0;
  var shellObserver = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function visualBox() {
    var vv = root.visualViewport;
    return {
      left: vv ? vv.offsetLeft : 0,
      top: vv ? vv.offsetTop : 0,
      width: vv && vv.width ? vv.width : (root.innerWidth || 390),
      height: vv && vv.height ? vv.height : (root.innerHeight || 720)
    };
  }

  function syncViewportVars() {
    var box = visualBox();
    var style = doc.documentElement.style;
    style.setProperty('--ac-vv-left', box.left + 'px');
    style.setProperty('--ac-vv-top', box.top + 'px');
    style.setProperty('--ac-vv-width', box.width + 'px');
    style.setProperty('--ac-vv-height', box.height + 'px');
    if (launcher && position) applyPosition(true);
    if (menu) placeMenu();
    resizeOpenViewer();
  }

  function readPosition() {
    try {
      var value = JSON.parse(root.localStorage.getItem(STORAGE_KEY) || 'null');
      if (value && Number.isFinite(Number(value.y)) && (value.side === 'left' || value.side === 'right')) {
        return { side: value.side, y: Number(value.y), x: 0 };
      }
    } catch (_) {}
    var box = visualBox();
    return { side: 'right', y: box.top + box.height * 0.58, x: 0 };
  }

  function savePosition() {
    try {
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify({ side: position.side, y: position.y }));
    } catch (_) {}
  }

  function bounds() {
    var box = visualBox();
    return {
      minX: box.left + EDGE_GAP,
      maxX: Math.max(box.left + EDGE_GAP, box.left + box.width - FAB_SIZE - EDGE_GAP),
      minY: box.top + EDGE_GAP,
      maxY: Math.max(box.top + EDGE_GAP, box.top + box.height - FAB_SIZE - EDGE_GAP)
    };
  }

  function applyPosition(keepSide) {
    if (!launcher || !position) return;
    var b = bounds();
    var box = visualBox();
    if (!keepSide && Number.isFinite(position.x)) {
      position.side = position.x + FAB_SIZE / 2 < box.left + box.width / 2 ? 'left' : 'right';
    }
    position.x = position.side === 'left' ? b.minX : b.maxX;
    position.y = clamp(position.y, b.minY, b.maxY);
    launcher.style.left = position.x + 'px';
    launcher.style.top = position.y + 'px';
    launcher.setAttribute('data-side', position.side);
  }

  function dashboardVisible() {
    var shell = doc.getElementById('dashboardScreen');
    return Boolean(shell && !shell.classList.contains('hidden') && shell.getAttribute('aria-hidden') !== 'true' && root.innerWidth < 1024);
  }

  function syncLauncherVisibility() {
    if (!launcher) return;
    var visible = dashboardVisible();
    launcher.classList.toggle('ac-hidden', !visible);
    launcher.setAttribute('aria-hidden', visible ? 'false' : 'true');
    launcher.tabIndex = visible ? 0 : -1;
    if (!visible) closeMenu(false);
  }

  function visibleNavButtons() {
    var source = doc.getElementById('mainNav');
    if (!source) return [];
    return Array.prototype.filter.call(source.querySelectorAll('.nav-btn[data-page]'), function (button) {
      return !button.disabled && !button.classList.contains('hidden') && button.getAttribute('aria-hidden') !== 'true';
    });
  }

  function closeMenu(restoreFocus) {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
    if (launcher) {
      launcher.setAttribute('aria-expanded', 'false');
      launcher.classList.remove('ac-v5-open');
      if (restoreFocus !== false && launcher.focus) {
        try { launcher.focus({ preventScroll: true }); } catch (_) { try { launcher.focus(); } catch (_) {} }
      }
    }
  }

  function placeMenu() {
    if (!menu || !launcher) return;
    var cluster = menu.querySelector('.ac-v5-cluster');
    if (!cluster) return;
    var box = visualBox();
    var rect = launcher.getBoundingClientRect();
    var width = Math.min(260, Math.max(190, box.width - FAB_SIZE - 48));
    cluster.style.width = width + 'px';

    var height = Math.min(cluster.scrollHeight || 340, box.height - 28);
    var top = clamp(rect.top + rect.height / 2 - height / 2, box.top + 14, box.top + box.height - height - 14);
    var left;
    if (position.side === 'right') {
      left = rect.left - width - 14;
      if (left < box.left + 14) left = box.left + 14;
    } else {
      left = rect.right + 14;
      if (left + width > box.left + box.width - 14) left = box.left + box.width - width - 14;
    }
    cluster.style.left = left + 'px';
    cluster.style.top = top + 'px';
  }

  function toggleMenu() {
    if (menu) {
      closeMenu();
      return;
    }
    var sources = visibleNavButtons();
    if (!sources.length) return;

    menu = doc.createElement('div');
    menu.className = 'ac-v5-overlay';

    var backdrop = doc.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'ac-v5-backdrop';
    backdrop.setAttribute('aria-label', 'Tutup navigasi cepat');
    backdrop.addEventListener('click', function () { closeMenu(); });

    var cluster = doc.createElement('div');
    cluster.className = 'ac-v5-cluster';
    cluster.setAttribute('role', 'dialog');
    cluster.setAttribute('aria-label', 'Navigasi cepat');

    sources.forEach(function (source) {
      var action = doc.createElement('button');
      action.type = 'button';
      action.className = 'ac-v5-action' + (source.classList.contains('active') ? ' active' : '');
      var icon = source.querySelector('svg');
      if (icon) action.appendChild(icon.cloneNode(true));
      var label = doc.createElement('span');
      var sourceLabel = source.querySelector('span');
      label.textContent = String(sourceLabel ? sourceLabel.textContent : source.textContent || '').trim();
      action.appendChild(label);
      action.addEventListener('click', function () {
        closeMenu(false);
        source.click();
      });
      cluster.appendChild(action);
    });

    menu.appendChild(backdrop);
    menu.appendChild(cluster);
    doc.body.appendChild(menu);
    launcher.setAttribute('aria-expanded', 'true');
    launcher.classList.add('ac-v5-open');
    placeMenu();
  }

  function clearPress() {
    if (!press) return;
    if (press.timer) root.clearTimeout(press.timer);
    press = null;
    if (launcher) launcher.classList.remove('ac-v5-dragging');
  }

  function installLauncher() {
    var current = doc.getElementById('acNavLauncher');
    if (!current) return false;
    if (current.getAttribute('data-ac-v5') === 'true') {
      launcher = current;
      syncLauncherVisibility();
      return true;
    }

    // Clone once to remove the older pointer listeners. A normal tap now opens on
    // pointer-up; moving the control requires an intentional short hold first.
    launcher = current.cloneNode(true);
    launcher.setAttribute('data-ac-v5', 'true');
    launcher.setAttribute('aria-expanded', 'false');
    current.parentNode.replaceChild(launcher, current);
    position = readPosition();
    applyPosition(true);

    launcher.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      clearPress();
      press = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: position.x,
        originY: position.y,
        dragging: false,
        cancelled: false,
        timer: null
      };
      press.timer = root.setTimeout(function () {
        if (!press || press.id !== event.pointerId || press.cancelled) return;
        press.dragging = true;
        launcher.classList.add('ac-v5-dragging');
      }, LONG_PRESS_MS);
      try { launcher.setPointerCapture(event.pointerId); } catch (_) {}
    });

    launcher.addEventListener('pointermove', function (event) {
      if (!press || press.id !== event.pointerId) return;
      var dx = event.clientX - press.startX;
      var dy = event.clientY - press.startY;
      var distance = Math.hypot(dx, dy);
      if (!press.dragging) {
        if (distance > MOVE_TOLERANCE) {
          press.cancelled = true;
          if (press.timer) root.clearTimeout(press.timer);
        }
        return;
      }
      position.x = press.originX + dx;
      position.y = press.originY + dy;
      launcher.style.left = position.x + 'px';
      launcher.style.top = position.y + 'px';
      event.preventDefault();
    }, { passive: false });

    launcher.addEventListener('pointerup', function (event) {
      if (!press || press.id !== event.pointerId) return;
      var wasDragging = press.dragging;
      var wasCancelled = press.cancelled;
      if (press.timer) root.clearTimeout(press.timer);
      press = null;
      launcher.classList.remove('ac-v5-dragging');

      if (wasDragging) {
        applyPosition(false);
        savePosition();
        suppressClickUntil = Date.now() + 700;
        event.preventDefault();
        return;
      }
      if (wasCancelled) {
        suppressClickUntil = Date.now() + 350;
        return;
      }

      // Open immediately on pointer-up. No long press and no synthetic-click delay.
      suppressClickUntil = Date.now() + 700;
      toggleMenu();
      event.preventDefault();
    }, { passive: false });

    launcher.addEventListener('pointercancel', clearPress);
    launcher.addEventListener('click', function (event) {
      if (Date.now() < suppressClickUntil) {
        event.preventDefault();
        return;
      }
      toggleMenu();
      event.preventDefault();
    });

    syncLauncherVisibility();
    return true;
  }

  function installShellObserver() {
    var shell = doc.getElementById('dashboardScreen');
    if (!shell || typeof MutationObserver === 'undefined') return false;
    if (shellObserver) shellObserver.disconnect();
    shellObserver = new MutationObserver(syncLauncherVisibility);
    shellObserver.observe(shell, { attributes: true, attributeFilter: ['class', 'aria-hidden', 'style'] });
    return true;
  }

  function installChartDims() {
    if (typeof root.chartDims !== 'function' || root.chartDims.__acV5) return Boolean(root.chartDims && root.chartDims.__acV5);
    var original = root.chartDims;
    var replacement = function (variant, viewportWidth, viewportHeight) {
      if (variant !== 'fullscreen') return original(variant, viewportWidth, viewportHeight);
      var box = visualBox();
      var width = Number(viewportWidth) > 0 ? Number(viewportWidth) : box.width;
      var body = doc.querySelector('.ac-viewer-body');
      var available = body && body.clientHeight > 120 ? body.clientHeight : box.height - 48;
      var mobile = width < 640;
      var rsi = mobile ? 54 : 72;
      var metricsAndHint = mobile ? 54 : 64;
      var minimum = available < 360 ? 150 : (mobile ? 210 : 300);
      return { main: Math.max(minimum, Math.floor(available - rsi - metricsAndHint)), rsi: rsi };
    };
    replacement.__acV5 = true;
    replacement.__original = original;
    root.chartDims = replacement;
    return true;
  }

  function resizeOpenViewer() {
    var active = root.__AUTOCUAN_CHART_VIEWER__;
    if (!active || !active.chartId || !root.__chartRegistry || typeof root.chartDims !== 'function') return;
    var entry = root.__chartRegistry[active.chartId];
    if (!entry) return;
    var dims = root.chartDims('fullscreen', visualBox().width, visualBox().height);
    var mainEl = doc.getElementById(active.chartId + '_container');
    var rsiEl = doc.getElementById(active.chartId + '_rsi');
    if (mainEl) mainEl.style.height = dims.main + 'px';
    if (rsiEl) rsiEl.style.height = dims.rsi + 'px';
    try { if (entry.mainChart && entry.mainChart.resize) entry.mainChart.resize(mainEl ? mainEl.clientWidth : visualBox().width, dims.main); } catch (_) {}
    try { if (entry.rsiChart && entry.rsiChart.resize) entry.rsiChart.resize(rsiEl ? rsiEl.clientWidth : visualBox().width, dims.rsi); } catch (_) {}
  }

  function injectCss() {
    if (doc.getElementById('acMobileUiRuntimeV5Css')) return;
    var style = doc.createElement('style');
    style.id = 'acMobileUiRuntimeV5Css';
    style.textContent = [
      '@media (min-width:1024px){',
      // .header-shell>.flex keeps !important deliberately: the build-time
      // AUTO_CUAN_DESKTOP_HEADER_CENTER_V1 patch appended to ui-theme.css sets
      // column-gap on `.app-header > .header-shell > .flex`, which outranks this
      // selector on specificity at >=1280px. Dropping it would silently hand the
      // desktop header a different gap.
      '  .header-shell>.flex{gap:10px!important;min-width:0!important}',
      // The three nav rules below no longer need !important. They existed to beat
      // the .nav-btn padding/font-size that the inline sheet of index.html and
      // ui-theme.css were both declaring; that duplication is resolved, and
      // `.desktop-nav .nav-btn` already outranks the remaining single-class rule
      // on specificity while this sheet is appended to <head> after both.
      '  .desktop-nav{justify-content:flex-start;gap:2px;overflow:hidden;min-width:0}',
      '  .desktop-nav .nav-btn{flex:0 1 auto;min-width:0;padding-left:8px;padding-right:8px;white-space:nowrap}',
      '  .desktop-header-chips{display:none!important}',
      '  .header-account{margin-left:auto!important}',
      '}',
      '@media (min-width:1024px) and (max-width:1320px){',
      '  .header-shell .brand-mark+div p{display:none!important}',
      '  .desktop-nav .nav-btn{font-size:11px;padding-left:6px;padding-right:6px}',
      '}',
      '#acNavPanel{display:none!important}',
      '@media (max-width:1023px){',
      '  #acNavLauncher{z-index:93!important;opacity:.82!important;touch-action:none!important;-webkit-tap-highlight-color:transparent!important;user-select:none!important}',
      '  #acNavLauncher.ac-v5-open{opacity:1!important;transform:scale(1.04)!important}',
      '  #acNavLauncher.ac-v5-dragging{opacity:1!important;cursor:grabbing!important;transition:none!important}',
      '  #acNavLauncher[aria-hidden="true"]{display:none!important}',
      '  .ac-v5-overlay{position:fixed;inset:0;z-index:90;pointer-events:auto}',
      '  .ac-v5-backdrop{position:absolute;inset:0;border:0;background:rgba(2,6,14,.46);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}',
      '  .ac-v5-cluster{position:fixed;z-index:91;display:flex;flex-direction:column;gap:8px;max-height:calc(var(--ac-vv-height,100dvh) - 28px);overflow-y:auto;overscroll-behavior:contain;padding:2px;background:transparent;border:0;box-shadow:none}',
      '  .ac-v5-action{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:11px 16px;border:1px solid rgba(148,163,184,.24);border-radius:999px;background:rgba(13,18,27,.96);box-shadow:0 12px 30px rgba(0,0,0,.34);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);color:#e2e8f0;font-size:13px;font-weight:750;text-align:left}',
      '  .ac-v5-action svg{width:19px;height:19px;flex:0 0 auto}',
      '  .ac-v5-action.active{border-color:rgba(52,211,153,.58);background:rgba(6,78,59,.9);color:#6ee7b7}',
      '  .ac-v5-action:active{transform:scale(.97)}',
      '}',
      '.ac-viewer{inset:auto!important;left:var(--ac-vv-left,0px)!important;top:var(--ac-vv-top,0px)!important;width:var(--ac-vv-width,100vw)!important;height:var(--ac-vv-height,100dvh)!important;min-height:0!important}',
      '.ac-viewer-body{min-height:0!important;overflow-y:auto!important;overscroll-behavior:contain!important}',
      '.ac-viewer-chart{min-height:0!important}',
      '.ac-viewer-main,.ac-viewer-rsi{min-height:0!important}',
      '@media (max-width:639px){',
      '  .ac-viewer-head{padding:5px 7px!important;min-height:42px!important;align-items:center!important}',
      '  .ac-viewer-heading{max-width:46vw!important}',
      '  .ac-viewer-title{font-size:12.5px!important;line-height:1.15!important}',
      '  .ac-viewer-subtitle{font-size:9px!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}',
      '  .ac-viewer-actions{gap:4px!important}',
      '  .ac-viewer-btn{min-height:32px!important;padding:5px 7px!important;font-size:10px!important;border-radius:8px!important}',
      '  .ac-viewer-metrics{padding:4px 6px!important;font-size:8.5px!important}',
      '  .ac-viewer-hint{display:none!important}',
      '}',
      '@media (orientation:landscape) and (max-height:520px){',
      '  .ac-viewer-subtitle{display:none!important}',
      '  .ac-viewer-head{min-height:36px!important;padding:3px 6px!important}',
      '  .ac-viewer-btn{min-height:28px!important;padding:3px 6px!important}',
      '  .ac-viewer-metrics{padding:2px 5px!important}',
      '}'
    ].join('\n');
    doc.head.appendChild(style);
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && menu) {
      event.preventDefault();
      closeMenu();
    }
  }

  injectCss();
  syncViewportVars();
  doc.addEventListener('keydown', onKeydown, true);

  var attempts = 0;
  var timer = root.setInterval(function () {
    attempts += 1;
    var launcherReady = installLauncher();
    var shellReady = installShellObserver();
    var chartReady = installChartDims();
    if ((launcherReady && shellReady && chartReady) || attempts > 240) root.clearInterval(timer);
  }, 50);

  root.addEventListener('resize', syncViewportVars, { passive: true });
  root.addEventListener('orientationchange', function () { root.setTimeout(syncViewportVars, 80); }, { passive: true });
  doc.addEventListener('visibilitychange', syncLauncherVisibility, { passive: true });
  if (root.visualViewport) {
    root.visualViewport.addEventListener('resize', syncViewportVars, { passive: true });
    root.visualViewport.addEventListener('scroll', syncViewportVars, { passive: true });
  }
})(typeof window !== 'undefined' ? window : null);
