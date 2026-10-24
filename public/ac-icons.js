/* Auto-Cuan icon set (redesign v2, HANDOFF §2.2).
   Paths are copied verbatim from the canvas (sidebar, bottom tabs, top bar,
   state panels). Stroke 1.7px with round caps and joins so the glyphs match
   the chart lines. No icon library. Markup can use <i data-ac-icon="name">,
   which hydrate() turns into an inline SVG. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.AutoCuanIcons = api;
    if (root.document) {
      var run = function () { api.hydrate(root.document); };
      if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', run);
      else run();
    }
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var PATHS = {
    // Sidebar destinations (canvas .side .nav)
    'dashboard': '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z"/>',
    'screener': '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    'sektor-hot': '<path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5"/>',
    'catatan-admin': '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h4"/>',
    'analisis': '<path d="M3 3v18h18M7 15l4-5 3 3 5-7"/>',
    'bandarmologi': '<path d="M5 20V10M12 20V4M19 20v-7"/>',
    'intel': '<circle cx="12" cy="12" r="8"/><path d="M12 12l5-5"/>',
    'hunter': '<path d="M4 7h16M4 12h16M4 17h10"/>',
    'insider': '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5M17 11a3 3 0 000-6M21 20c0-2-1.5-4-4-4.6"/>',
    'ranking': '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    'financial': '<path d="M4 20h16M6 20V9l6-5 6 5v11M10 20v-6h4v6"/>',
    'struktur-pasar': '<path d="M12 3v9h9A9 9 0 1112 3z"/>',
    'watchlist': '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    'portfolio': '<path d="M4 8h16v11H4zM9 8V5h6v3"/>',
    'track-record': '<path d="M4 12l5 5L20 6"/>',
    'kelola-keuangan': '<path d="M3 7h16a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2zM3 7l2-3h12M16 14h2"/>',
    'pattern-radar': '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    'admin-console': '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    // Shell controls (canvas .brand, .sbt, .search, .thm, .acct, .mtab)
    'logo': '<path d="M3 17l5-6 4 4 8-9"/>',
    'sidebar': '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16M15 10l-2 2 2 2"/>',
    'search': '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    'moon': '<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>',
    'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6"/>',
    'menu': '<path d="M4 7h16M4 12h16M4 17h16"/>',
    // State panels (canvas motion.js ST)
    'state-empty': '<path d="M4 7h16M4 12h10M4 17h6"/>',
    'state-error': '<path d="M12 8v5M12 16.5v.5M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/>'
  };

  function has(name) { return Object.prototype.hasOwnProperty.call(PATHS, name); }

  // Returns an inline SVG string. Decorative by default (aria-hidden); pass
  // { label: '…' } when the icon is the only content of a control.
  function svg(name, opts) {
    if (!has(name)) return '';
    var o = opts || {};
    var size = Number(o.size) > 0 ? Number(o.size) : 17;
    var width = o.strokeWidth || 1.7;
    var cls = o.className ? ' class="' + String(o.className).replace(/"/g, '') + '"' : '';
    var a11y = o.label
      ? ' role="img" aria-label="' + String(o.label).replace(/[<>"&]/g, '') + '"'
      : ' aria-hidden="true" focusable="false"';
    return '<svg' + cls + ' width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + width + '" stroke-linecap="round" stroke-linejoin="round"' + a11y + '>' + PATHS[name] + '</svg>';
  }

  // Replaces every <i data-ac-icon="name" [data-size] [data-label]> under
  // root with its SVG. Unknown names are left untouched so a typo stays
  // visible in review instead of silently rendering nothing.
  function hydrate(root) {
    if (!root || !root.querySelectorAll) return 0;
    var nodes = root.querySelectorAll('i[data-ac-icon]');
    var done = 0;
    Array.prototype.forEach.call(nodes, function (node) {
      var name = node.getAttribute('data-ac-icon');
      if (!has(name)) return;
      var html = svg(name, { size: node.getAttribute('data-size'), label: node.getAttribute('data-label'), className: node.className });
      var tmp = root.createElement ? root.createElement('span') : node.ownerDocument.createElement('span');
      tmp.innerHTML = html;
      if (tmp.firstChild) { node.parentNode.replaceChild(tmp.firstChild, node); done++; }
    });
    return done;
  }

  return { svg: svg, has: has, hydrate: hydrate, names: function () { return Object.keys(PATHS); } };
});
