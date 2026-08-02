// Auto-Cuan real-device UI stabilization follow-up.
// Keeps the v3 launcher aligned with the signed-in dashboard shell after the
// original mobile-nav node was replaced to fix Android tap-vs-drag behaviour.
// Presentation only: no access, API, trading, database, Telegram, or runtime changes.
(function (root) {
  'use strict';
  if (!root || !root.document || root.__AUTOCUAN_UI_RUNTIME_V4__) return;
  root.__AUTOCUAN_UI_RUNTIME_V4__ = '20260803-mobile-ui-runtime-v4';

  var doc = root.document;
  var observer = null;
  var timer = null;

  function visualHeight() {
    return root.visualViewport && root.visualViewport.height
      ? root.visualViewport.height
      : (root.innerHeight || 720);
  }

  function dashboardVisible() {
    var shell = doc.getElementById('dashboardScreen');
    if (!shell) return false;
    if (shell.classList.contains('hidden')) return false;
    if (shell.getAttribute('aria-hidden') === 'true') return false;
    return root.innerWidth < 1024;
  }

  function closeQuickOverlay() {
    var overlay = doc.querySelector('.ac-v3-overlay');
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    var launcher = doc.getElementById('acNavLauncher');
    if (launcher) launcher.setAttribute('aria-expanded', 'false');
  }

  function syncLauncherVisibility() {
    var launcher = doc.getElementById('acNavLauncher');
    if (!launcher) return false;
    var visible = dashboardVisible();
    launcher.classList.toggle('ac-hidden', !visible);
    launcher.setAttribute('aria-hidden', visible ? 'false' : 'true');
    launcher.tabIndex = visible ? 0 : -1;
    if (!visible) closeQuickOverlay();
    return true;
  }

  function installChartSizing() {
    if (typeof root.chartDims !== 'function' || root.chartDims.__acV4) return false;
    var previous = root.chartDims;
    var replacement = function (variant, viewportWidth, viewportHeight) {
      if (variant !== 'fullscreen') return previous(variant, viewportWidth, viewportHeight);
      var width = Number(viewportWidth) > 0 ? Number(viewportWidth) : (root.innerWidth || 390);
      var height = visualHeight();
      var mobile = width < 640;
      var rsi = mobile ? 58 : 78;
      var chrome = mobile ? 92 : 112;
      var minimum = height < 500 ? 170 : (mobile ? 220 : 320);
      return { main: Math.max(minimum, Math.floor(height - chrome - rsi)), rsi: rsi };
    };
    replacement.__acV4 = true;
    replacement.__previous = previous;
    root.chartDims = replacement;
    return true;
  }

  function injectCss() {
    if (doc.getElementById('acMobileUiRuntimeV4Css')) return;
    var style = doc.createElement('style');
    style.id = 'acMobileUiRuntimeV4Css';
    style.textContent = [
      '@media (max-width:1023px){',
      '  .ac-v3-cluster{max-height:calc(var(--ac-vv-height,100dvh) - 28px);overflow-y:auto;overscroll-behavior:contain;padding:2px;background:transparent!important;box-shadow:none!important;border:0!important}',
      '  .ac-v3-action{isolation:isolate}',
      '  #acNavLauncher[aria-hidden="true"]{display:none!important}',
      '}',
      '@media (max-width:420px){',
      '  .ac-v3-cluster{width:min(300px,calc(100vw - 84px))!important;grid-template-columns:1fr!important}',
      '  .ac-v3-action{min-height:46px!important}',
      '}',
      '.ac-viewer-chart{height:100%!important;min-height:0!important}',
      '.ac-viewer-main{min-height:0!important}',
      '@media (max-width:639px){',
      '  .ac-viewer-head{flex:0 0 auto!important}',
      '  .ac-viewer-body{flex:1 1 auto!important;min-height:0!important}',
      '}'
    ].join('\n');
    doc.head.appendChild(style);
  }

  function observeShell() {
    var shell = doc.getElementById('dashboardScreen');
    if (!shell || typeof MutationObserver === 'undefined') return false;
    if (observer) observer.disconnect();
    observer = new MutationObserver(syncLauncherVisibility);
    observer.observe(shell, { attributes: true, attributeFilter: ['class', 'aria-hidden', 'style'] });
    return true;
  }

  injectCss();
  installChartSizing();
  syncLauncherVisibility();
  observeShell();

  var attempts = 0;
  timer = root.setInterval(function () {
    attempts += 1;
    var launcherReady = syncLauncherVisibility();
    var chartReady = installChartSizing();
    var shellReady = observeShell();
    if ((launcherReady && chartReady && shellReady) || attempts > 240) {
      root.clearInterval(timer);
      timer = null;
    }
  }, 50);

  root.addEventListener('resize', syncLauncherVisibility, { passive: true });
  root.addEventListener('orientationchange', function () {
    root.setTimeout(function () {
      syncLauncherVisibility();
      installChartSizing();
    }, 80);
  }, { passive: true });
  doc.addEventListener('visibilitychange', syncLauncherVisibility, { passive: true });
})(typeof window !== 'undefined' ? window : null);
