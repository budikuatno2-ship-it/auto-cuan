(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanUiBugfixPackV1 = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var STYLE_ID = 'autocuanUiBugfixPackV1';
  var STYLE_TEXT = [
    '/* AUTO_CUAN_UI_BUGFIX_PACK_V1 */',
    '/* Desktop Analisis Saham uses the document as its only vertical scroll owner.',
    '   This prevents wheel/touchpad input from being trapped by an unconstrained',
    '   nested overflow container while preserving the mobile layout. */',
    '@media (min-width:1024px){',
    '  #page-analisis{height:auto!important;min-height:0!important;overflow:visible!important;}',
    '  #page-analisis #analisisResult{height:auto!important;max-height:none!important;min-height:0!important;overflow-y:visible!important;flex:0 0 auto!important;}',
    '}',
    '',
    '/* Portfolio tabs share equal tracks on wide screens. The compact layout keeps',
    '   horizontal scrolling below the breakpoint, so long labels never collide. */',
    '@media (min-width:1181px){',
    '  #tabStrip.tab-strip{display:grid!important;grid-template-columns:repeat(7,minmax(0,1fr))!important;overflow:visible!important;}',
    '  #tabStrip.tab-strip>.tab{width:100%!important;min-width:0!important;max-width:none!important;flex:none!important;padding-left:8px!important;padding-right:8px!important;white-space:normal!important;text-align:center!important;}',
    '}',
    '@media (max-width:1180px){',
    '  #tabStrip.tab-strip{display:flex!important;overflow-x:auto!important;}',
    '  #tabStrip.tab-strip>.tab{width:auto!important;min-width:max-content!important;flex:0 0 auto!important;white-space:nowrap!important;}',
    '}'
  ].join('\n');

  function install(targetRoot) {
    var doc = targetRoot && targetRoot.document;
    if (!doc || !doc.head) return false;
    if (doc.getElementById(STYLE_ID)) return false;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    doc.head.appendChild(style);
    return true;
  }

  return {
    STYLE_ID: STYLE_ID,
    STYLE_TEXT: STYLE_TEXT,
    install: install
  };
});
