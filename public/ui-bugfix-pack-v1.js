(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanUiBugfixPackV1 = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var STYLE_ID = 'autocuanUiBugfixPackV1';
  var SANITIZER_HARDENING_VERSION = '20260813-ai-url-sanitizer-v1';
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

  function decodeNumericEntities(value) {
    return String(value == null ? '' : value)
      .replace(/&#x([0-9a-f]+);?/gi, function (_, hex) {
        var code = parseInt(hex, 16);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      })
      .replace(/&#(\d+);?/g, function (_, dec) {
        var code = parseInt(dec, 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      });
  }

  // Runtime uses the browser's own HTML parser to obtain the same attribute value
  // that innerHTML would expose after named-entity decoding. The explicit fallback
  // handles the security-relevant named references in non-DOM unit tests too.
  function decodeHtmlEntities(value, doc) {
    var decoded = decodeNumericEntities(value);
    if (doc && typeof doc.createElement === 'function') {
      try {
        var textarea = doc.createElement('textarea');
        textarea.innerHTML = decoded;
        decoded = typeof textarea.value === 'string' ? textarea.value : String(textarea.textContent || '');
      } catch (_) {}
    }
    return String(decoded)
      .replace(/&colon;?/gi, ':')
      .replace(/&tab;?/gi, '\t')
      .replace(/&newline;?/gi, '\n')
      .replace(/&amp;?/gi, '&');
  }

  function normalizedUrl(value, doc) {
    return decodeHtmlEntities(value, doc)
      .replace(/[\s\u0000-\u001f\u007f]+/g, '')
      .toLowerCase();
  }

  function dangerousUrl(value, doc) {
    return /^(?:javascript|vbscript|data):/.test(normalizedUrl(value, doc));
  }

  function dangerousSrcset(value, doc) {
    var decoded = decodeHtmlEntities(value, doc);
    // Check each candidate before interpreting its density/width descriptor.
    // dangerousUrl removes embedded whitespace/control characters, so
    // "java<TAB>script:" cannot be split into the harmless token "java" first.
    return decoded.split(',').some(function (candidate) {
      return dangerousUrl(candidate, doc);
    });
  }

  function hardenUrlAttributes(html, doc) {
    return String(html == null ? '' : html).replace(
      /\s(href|src|xlink:href|action|formaction|data|poster|srcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      function (match, attr, _raw, dq, sq, bare) {
        var value = dq != null ? dq : (sq != null ? sq : (bare || ''));
        var unsafe = String(attr).toLowerCase() === 'srcset'
          ? dangerousSrcset(value, doc)
          : dangerousUrl(value, doc);
        if (!unsafe) return match;
        return String(attr).toLowerCase() === 'srcset' ? ' ' + attr + '=""' : ' ' + attr + '="#"';
      }
    );
  }

  function installSanitizerHardening(targetRoot) {
    if (!targetRoot || typeof targetRoot.sanitizeAIHtml !== 'function') return false;
    var base = targetRoot.sanitizeAIHtml;
    if (base.__autocuanUrlHardening === SANITIZER_HARDENING_VERSION) return true;

    function hardenedSanitizeAIHtml(html) {
      return hardenUrlAttributes(base(html), targetRoot.document);
    }
    hardenedSanitizeAIHtml.__autocuanUrlHardening = SANITIZER_HARDENING_VERSION;
    hardenedSanitizeAIHtml.__baseSanitizer = base;
    targetRoot.sanitizeAIHtml = hardenedSanitizeAIHtml;
    return true;
  }

  function install(targetRoot) {
    var doc = targetRoot && targetRoot.document;
    if (!doc || !doc.head) return false;

    // This script is loaded at the end of index.html, after sanitizeAIHtml is
    // declared and before a user can submit an AI request. Patch the actual global
    // sink synchronously; do not rely on a later MutationObserver cleanup.
    installSanitizerHardening(targetRoot);

    if (doc.getElementById(STYLE_ID)) return true;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    doc.head.appendChild(style);
    return true;
  }

  return {
    STYLE_ID: STYLE_ID,
    STYLE_TEXT: STYLE_TEXT,
    SANITIZER_HARDENING_VERSION: SANITIZER_HARDENING_VERSION,
    decodeHtmlEntities: decodeHtmlEntities,
    normalizedUrl: normalizedUrl,
    dangerousUrl: dangerousUrl,
    dangerousSrcset: dangerousSrcset,
    hardenUrlAttributes: hardenUrlAttributes,
    installSanitizerHardening: installSanitizerHardening,
    install: install
  };
});
