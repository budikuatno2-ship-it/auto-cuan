// Final visual spacing adjustment for the mobile launcher.
// Keeps drag behaviour unchanged while moving the snapped idle position farther
// from the physical screen edge for a more comfortable AssistiveTouch-like feel.
(function (root) {
  'use strict';
  if (!root || !root.document || root.__AUTOCUAN_UI_RUNTIME_V6__) return;
  root.__AUTOCUAN_UI_RUNTIME_V6__ = '20260803-mobile-ui-runtime-v6';

  var doc = root.document;
  var style = doc.createElement('style');
  style.id = 'acMobileUiRuntimeV6Css';
  style.textContent = [
    '@media (max-width:1023px){',
    '  #acNavLauncher:not(.ac-v5-dragging)[data-side="left"]{left:max(24px,env(safe-area-inset-left,0px))!important;right:auto!important}',
    '  #acNavLauncher:not(.ac-v5-dragging)[data-side="right"]{left:auto!important;right:max(24px,env(safe-area-inset-right,0px))!important}',
    '}'
  ].join('\n');
  doc.head.appendChild(style);
})(typeof window !== 'undefined' ? window : null);
