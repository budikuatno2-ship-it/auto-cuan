(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanUiBugfixPackV1 = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var STYLE_ID = 'autocuanUiBugfixPackV1';
  var SANITIZER_HARDENING_VERSION = '20260822-ai-dom-allowlist-v2';
  var WHEEL_HANDOFF_VERSION = '20260813-site-wheel-handoff-v1';
  var TELEGRAM_ADMIN_DEVICE_POLL_VERSION = '20260816-telegram-admin-device-poll-v1';
  var STYLE_TEXT = [
    '/* AUTO_CUAN_UI_BUGFIX_PACK_V1 */',
    '/* Admin access is Telegram-command-first. Do not expose a public website',
    '   trigger that can open Telegram or create admin challenges. */',
    '.maintenance-admin{display:none!important;}',
    '',
    '/* Desktop Analisis Saham uses the document as its only vertical scroll owner.',
    '   This prevents wheel/touchpad input from being trapped by an unconstrained',
    '   nested overflow container while preserving the mobile layout. */',
    '@media (min-width:1024px){',
    '  #page-analisis{height:auto!important;min-height:0!important;overflow:visible!important;}',
    '  #page-analisis #analisisResult{height:auto!important;max-height:none!important;min-height:0!important;overflow-y:visible!important;flex:0 0 auto!important;}',
    '}',
    '',
    '/* Let a finished inner scroller hand wheel/touchpad motion back to the page.',
    '   The JS fallback below covers browsers/layouts where CSS scroll chaining is',
    '   still blocked by a nested overflow owner. Horizontal table/tab scrolling',
    '   remains untouched. */',
    'html,body{overscroll-behavior-y:auto!important;}',
    '#analisisResult,#aiMessages,.chat-messages,.ai-messages,.table-wrap{overscroll-behavior-y:auto!important;}',
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
    '}',
    '',
    '/* Keep one active-tab accent. Older portfolio polish could leave a cyan',
    '   underline under the green selected state, producing the double-accent seen',
    '   on the Asisten AI tab. */',
    '#tabStrip.tab-strip>.tab{position:relative!important;}',
    '#tabStrip.tab-strip>.tab::after{content:none!important;}',
    '#tabStrip.tab-strip>.tab.active::after,#tabStrip.tab-strip>.tab[aria-selected="true"]::after{content:""!important;position:absolute!important;left:25%!important;right:25%!important;bottom:6px!important;height:2px!important;border:0!important;border-radius:999px!important;background:#34d399!important;box-shadow:none!important;transform:none!important;opacity:1!important;}'
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

  var ALLOWED_AI_TAGS = Object.freeze({
    A: true, B: true, BLOCKQUOTE: true, BR: true, CODE: true, DIV: true,
    EM: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true,
    HR: true, I: true, LI: true, OL: true, P: true, PRE: true, S: true,
    SPAN: true, STRONG: true, TABLE: true, TBODY: true, TD: true, TH: true,
    THEAD: true, TR: true, U: true, UL: true
  });
  var DROP_AI_TAGS = Object.freeze({
    BASE: true, BUTTON: true, EMBED: true, FORM: true, IFRAME: true, INPUT: true,
    LINK: true, MATH: true, META: true, OBJECT: true, OPTION: true, SCRIPT: true,
    SELECT: true, STYLE: true, SVG: true, TEMPLATE: true, TEXTAREA: true
  });

  function safeAnchorHref(value, doc) {
    var decoded = decodeHtmlEntities(value, doc).trim();
    var compact = normalizedUrl(decoded, doc);
    if (!decoded || dangerousUrl(decoded, doc)) return '#';
    if (/^(?:https?:|mailto:|tel:)/.test(compact)) return decoded;
    if (/^(?:#|\/|\.\/|\.\.\/|\?)/.test(decoded)) return decoded;
    if (/^[a-z][a-z0-9+.-]*:/i.test(compact)) return '#';
    return decoded;
  }

  function sanitizeAllowedHtml(html, doc) {
    var hardened = hardenUrlAttributes(html, doc);
    if (!doc || typeof doc.createElement !== 'function') return hardened;
    var template;
    try {
      template = doc.createElement('template');
      template.innerHTML = hardened;
    } catch (_) {
      return hardened;
    }
    var content = template.content || template;
    if (!content || typeof content.querySelectorAll !== 'function') return hardened;
    var nodes = Array.prototype.slice.call(content.querySelectorAll('*'));
    nodes.forEach(function (node) {
      if (!node || !node.tagName || !node.parentNode) return;
      var tag = String(node.tagName).toUpperCase();
      if (DROP_AI_TAGS[tag]) {
        node.parentNode.removeChild(node);
        return;
      }
      if (!ALLOWED_AI_TAGS[tag]) {
        var parent = node.parentNode;
        while (node.firstChild) parent.insertBefore(node.firstChild, node);
        parent.removeChild(node);
        return;
      }
      Array.prototype.slice.call(node.attributes || []).forEach(function (attr) {
        var name = String(attr.name || '').toLowerCase();
        var keep = name === 'title' || name === 'class' || name === 'aria-label' ||
          (tag === 'A' && (name === 'href' || name === 'target' || name === 'rel')) ||
          ((tag === 'TD' || tag === 'TH') && (name === 'colspan' || name === 'rowspan'));
        if (/^on/i.test(name) || name === 'style' || name === 'id' || !keep) {
          node.removeAttribute(attr.name);
        }
      });
      if (tag === 'A') {
        node.setAttribute('href', safeAnchorHref(node.getAttribute('href') || '', doc));
        var target = String(node.getAttribute('target') || '').toLowerCase();
        if (target && target !== '_blank' && target !== '_self') node.removeAttribute('target');
        if (target === '_blank') node.setAttribute('rel', 'noopener noreferrer');
      }
      if (node.hasAttribute && node.hasAttribute('class')) {
        var safeClass = String(node.getAttribute('class') || '').replace(/[^a-z0-9_\- ]/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
        if (safeClass) node.setAttribute('class', safeClass); else node.removeAttribute('class');
      }
    });
    return typeof template.innerHTML === 'string' ? template.innerHTML : hardened;
  }

  function installSanitizerHardening(targetRoot) {
    if (!targetRoot || typeof targetRoot.sanitizeAIHtml !== 'function') return false;
    var base = targetRoot.sanitizeAIHtml;
    if (base.__autocuanUrlHardening === SANITIZER_HARDENING_VERSION) return true;

    function hardenedSanitizeAIHtml(html) {
      return sanitizeAllowedHtml(base(html), targetRoot.document);
    }
    hardenedSanitizeAIHtml.__autocuanUrlHardening = SANITIZER_HARDENING_VERSION;
    hardenedSanitizeAIHtml.__baseSanitizer = base;
    targetRoot.sanitizeAIHtml = hardenedSanitizeAIHtml;
    return true;
  }

  function scrollRoot(doc) {
    return doc && (doc.scrollingElement || doc.documentElement || doc.body);
  }

  function overflowCanScroll(value) {
    return /^(?:auto|scroll|overlay)$/.test(String(value || '').toLowerCase());
  }

  function canScrollY(node, deltaY) {
    if (!node || !deltaY) return false;
    var max = Math.max(0, Number(node.scrollHeight || 0) - Number(node.clientHeight || 0));
    var top = Number(node.scrollTop || 0);
    if (max <= 1) return false;
    return deltaY < 0 ? top > 1 : top < max - 1;
  }

  function nearestScrollableY(target, targetRoot) {
    var doc = targetRoot && targetRoot.document;
    var rootNode = scrollRoot(doc);
    var node = target && target.nodeType === 1 ? target : (target && target.parentElement);
    while (node && node !== doc && node !== doc.body && node !== doc.documentElement) {
      var style = null;
      try { style = targetRoot.getComputedStyle(node); } catch (_) {}
      if (style && overflowCanScroll(style.overflowY) && Number(node.scrollHeight || 0) > Number(node.clientHeight || 0) + 1) {
        return node;
      }
      node = node.parentElement;
    }
    return rootNode;
  }

  function normalizedWheelDelta(event, viewportHeight) {
    var delta = Number(event && event.deltaY) || 0;
    if (!delta) return 0;
    if (event.deltaMode === 1) return delta * 16;
    if (event.deltaMode === 2) return delta * Math.max(240, Number(viewportHeight || 0));
    return delta;
  }

  function pageScrollLocked(doc, targetRoot) {
    if (!doc || !targetRoot) return false;
    var body = doc.body;
    var html = doc.documentElement;
    try {
      var bodyStyle = body ? targetRoot.getComputedStyle(body) : null;
      var htmlStyle = html ? targetRoot.getComputedStyle(html) : null;
      return Boolean(
        (bodyStyle && bodyStyle.overflowY === 'hidden') ||
        (htmlStyle && htmlStyle.overflowY === 'hidden')
      );
    } catch (_) { return false; }
  }

  function installWheelHandoff(targetRoot) {
    var doc = targetRoot && targetRoot.document;
    if (!doc || typeof targetRoot.addEventListener !== 'function') return false;
    if (targetRoot.__autocuanWheelHandoff === WHEEL_HANDOFF_VERSION) return true;

    function onWheel(event) {
      if (!event || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (Math.abs(Number(event.deltaX) || 0) > Math.abs(Number(event.deltaY) || 0)) return;
      if (pageScrollLocked(doc, targetRoot)) return;

      var delta = normalizedWheelDelta(event, targetRoot.innerHeight || (doc.documentElement && doc.documentElement.clientHeight));
      if (!delta) return;

      var rootNode = scrollRoot(doc);
      var owner = nearestScrollableY(event.target, targetRoot);
      if (!rootNode || !owner || owner === rootNode || owner === doc.body || owner === doc.documentElement) return;
      if (canScrollY(owner, delta)) return;
      if (!canScrollY(rootNode, delta)) return;

      event.preventDefault();
      rootNode.scrollTop = Number(rootNode.scrollTop || 0) + delta;
    }

    targetRoot.addEventListener('wheel', onWheel, { capture: true, passive: false });
    targetRoot.__autocuanWheelHandoff = WHEEL_HANDOFF_VERSION;
    return true;
  }

  function maintenanceGateVisible(doc) {
    if (!doc) return false;
    var maintenance = doc.getElementById('maintenanceScreen');
    var status = doc.getElementById('serviceStatusScreen');
    function visible(el) {
      if (!el || !el.classList) return false;
      return !el.classList.contains('hidden');
    }
    return visible(maintenance) || visible(status);
  }

  function installTelegramAdminDevicePoll(targetRoot) {
    var doc = targetRoot && targetRoot.document;
    if (!doc || typeof targetRoot.fetch !== 'function' || typeof targetRoot.setTimeout !== 'function') return false;
    if (targetRoot.__autocuanTelegramAdminDevicePoll === TELEGRAM_ADMIN_DEVICE_POLL_VERSION) return true;
    targetRoot.__autocuanTelegramAdminDevicePoll = TELEGRAM_ADMIN_DEVICE_POLL_VERSION;

    var stopped = false;
    var inFlight = false;

    async function tick() {
      if (stopped) return;
      if (!maintenanceGateVisible(doc) || inFlight) {
        targetRoot.setTimeout(tick, 3000);
        return;
      }

      inFlight = true;
      try {
        var response = await targetRoot.fetch('/api/reset-password', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'admin-command-device-poll' })
        });
        var data = await response.json();
        if (data && data.success === true && data.state === 'approved') {
          stopped = true;
          targetRoot.location.reload();
          return;
        }
      } catch (_) {
      } finally {
        inFlight = false;
      }

      if (!stopped) targetRoot.setTimeout(tick, 3000);
    }

    targetRoot.setTimeout(tick, 1200);
    return true;
  }

  function install(targetRoot) {
    var doc = targetRoot && targetRoot.document;
    if (!doc || !doc.head) return false;

    installSanitizerHardening(targetRoot);
    installWheelHandoff(targetRoot);
    installTelegramAdminDevicePoll(targetRoot);

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
    WHEEL_HANDOFF_VERSION: WHEEL_HANDOFF_VERSION,
    TELEGRAM_ADMIN_DEVICE_POLL_VERSION: TELEGRAM_ADMIN_DEVICE_POLL_VERSION,
    ALLOWED_AI_TAGS: ALLOWED_AI_TAGS,
    decodeHtmlEntities: decodeHtmlEntities,
    normalizedUrl: normalizedUrl,
    dangerousUrl: dangerousUrl,
    dangerousSrcset: dangerousSrcset,
    hardenUrlAttributes: hardenUrlAttributes,
    safeAnchorHref: safeAnchorHref,
    sanitizeAllowedHtml: sanitizeAllowedHtml,
    installSanitizerHardening: installSanitizerHardening,
    scrollRoot: scrollRoot,
    overflowCanScroll: overflowCanScroll,
    canScrollY: canScrollY,
    nearestScrollableY: nearestScrollableY,
    normalizedWheelDelta: normalizedWheelDelta,
    pageScrollLocked: pageScrollLocked,
    installWheelHandoff: installWheelHandoff,
    maintenanceGateVisible: maintenanceGateVisible,
    installTelegramAdminDevicePoll: installTelegramAdminDevicePoll,
    install: install
  };
});
