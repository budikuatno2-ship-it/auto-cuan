(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanPatternScreenerExtension = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VERSION = '20260728-pattern-screener-v5';
  var TICKER_RE = /^[A-Z]{3,5}$/;
  var SOURCES = [
    { name:'Swing Konglo', url:'/api/sector-hot?action=screener' },
    { name:'Swing Non-Konglo', url:'/api/sector-hot?action=nk-screener-results' },
    { name:'Day Trade', url:'/api/sector-hot?action=daytrade-screener' }
  ];
  var GENERIC_PATTERN_LABELS = /^(?:no clear pattern|insufficient data|none|null|unknown|no pattern)$/i;

  function normalizeTicker(value) {
    var ticker = String(value == null ? '' : value).trim().toUpperCase().replace(/\.JK$/, '');
    return TICKER_RE.test(ticker) ? ticker : null;
  }
  function rowsFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return [];
    var keys = ['results', 'rows', 'data', 'picks', 'top5'];
    for (var i = 0; i < keys.length; i += 1) if (Array.isArray(payload[keys[i]])) return payload[keys[i]];
    return [];
  }
  function labelText(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      value = value.setup_label || value.pattern_label || value.label || value.name || value.setup_type || value.type || value.pattern;
    }
    value = String(value == null ? '' : value).trim();
    if (!value || value === '[object Object]' || GENERIC_PATTERN_LABELS.test(value)) return null;
    return value;
  }
  function appendLabel(labels, value) {
    var label = labelText(value);
    if (label && labels.indexOf(label) < 0) labels.push(label);
  }
  function officialSetupLabels(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    var containers = [row];
    if (row.raw_payload && typeof row.raw_payload === 'object' && !Array.isArray(row.raw_payload)) containers.push(row.raw_payload);
    var labels = [];
    containers.forEach(function (container) {
      [container.smart_setup_labels, container.classic_chart_patterns, container.classicPatterns, container.chart_patterns].forEach(function (values) {
        (Array.isArray(values) ? values : []).forEach(function (value) { appendLabel(labels, value); });
      });
      [container.primary_smart_setup, container.primary_classic_pattern, container.pattern_label, container.candle_pattern, container.candle_pattern_label].forEach(function (value) { appendLabel(labels, value); });
    });
    return labels;
  }
  function extractScreenerSetups(sources) {
    var map = Object.create(null);
    (Array.isArray(sources) ? sources : []).forEach(function (source) {
      var sourceName = String(source && source.name || 'Screener').trim() || 'Screener';
      rowsFromPayload(source && source.payload).forEach(function (row) {
        var ticker = normalizeTicker(row && (row.ticker || row.symbol || row.code));
        var labels = officialSetupLabels(row);
        if (!ticker || !labels.length) return;
        if (!map[ticker]) map[ticker] = { ticker:ticker, labels:[], sources:[] };
        labels.forEach(function (label) { if (map[ticker].labels.indexOf(label) < 0) map[ticker].labels.push(label); });
        if (map[ticker].sources.indexOf(sourceName) < 0) map[ticker].sources.push(sourceName);
      });
    });
    return Object.keys(map).sort().map(function (ticker) { return map[ticker]; });
  }
  function isStandaloneArtifact(value) {
    return /^(?:;|\||[-*_]{3,}|#{1,6}|\*\*|__)$/.test(String(value == null ? '' : value).trim());
  }
  function isRedundantChartControl(value) {
    return String(value == null ? '' : value).trim() === 'Technical Chart';
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char];
    });
  }
  function setupSignature(setup) { return setup.ticker + '|' + setup.labels.join('|') + '|' + setup.sources.join('|'); }

  function install(root) {
    if (!root || !root.document || root.__AUTOCUAN_PATTERN_SCREENER_EXTENSION__) return false;
    root.__AUTOCUAN_PATTERN_SCREENER_EXTENSION__ = VERSION;
    var doc = root.document;
    var state = { setups:[], loading:false, loaded:false, rendering:false };

    function addStyles() {
      if (doc.getElementById('patternScreenerExtensionStyles')) return;
      var style = doc.createElement('style');
      style.id = 'patternScreenerExtensionStyles';
      style.textContent = [
        '.ps-setup-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}',
        '.ps-setup-chip{display:inline-flex;align-items:center;min-height:25px;padding:4px 8px;border:1px solid rgba(52,211,153,.20);border-radius:999px;background:rgba(16,185,129,.065);color:#9ff3d3;font-size:9px;font-weight:800}',
        '.ps-setup-source{margin-top:8px;color:#6f7f96;font-size:9px;line-height:1.5}',
        '[data-ui-artifact="1"],[data-screener-only="1"]{display:none!important}'
      ].join('');
      doc.head.appendChild(style);
    }
    function headers() {
      var value = {};
      try {
        value['X-User-Id'] = root.localStorage.getItem('autocuan_user_id') || '';
        value['X-Username'] = root.localStorage.getItem('autocuan_user') || '';
      } catch (_) {}
      return value;
    }
    async function fetchJson(url) {
      var response = await root.fetch(url + '&t=' + Date.now(), { credentials:'same-origin', cache:'no-store', headers:headers() });
      if (!response.ok) return null;
      var data = await response.json().catch(function () { return null; });
      return data && data.success !== false ? data : null;
    }
    async function loadSetups(force) {
      if (state.loading || (state.loaded && !force)) return state.setups;
      state.loading = true;
      try {
        var payloads = await Promise.all(SOURCES.map(function (source) { return fetchJson(source.url).catch(function () { return null; }); }));
        state.setups = extractScreenerSetups(SOURCES.map(function (source, index) { return { name:source.name, payload:payloads[index] }; }));
        state.loaded = true;
        syncExistingCards();
        return state.setups;
      } finally { state.loading = false; }
    }
    function syncCard(card, setup) {
      var signature = setupSignature(setup);
      if (card.getAttribute('data-setup-signature') === signature) return;
      card.setAttribute('data-setup-signature', signature);
      var chips = card.querySelector('.ps-setup-chips');
      if (!chips) {
        chips = doc.createElement('div');
        chips.className = 'ps-setup-chips';
        var actions = card.querySelector('.ps-card-actions');
        actions ? card.insertBefore(chips, actions) : card.appendChild(chips);
      }
      chips.innerHTML = setup.labels.map(function (label) { return '<span class="ps-setup-chip">' + esc(label) + '</span>'; }).join('');
      var source = card.querySelector('.ps-setup-source');
      if (!source) {
        source = doc.createElement('p'); source.className = 'ps-setup-source';
        chips.parentNode.insertBefore(source, chips.nextSibling);
      }
      source.textContent = 'Juga terdeteksi oleh: ' + setup.sources.join(', ') + '. Label ini hanya memperkuat konteks.';
    }
    function syncExistingCards() {
      if (state.rendering) return;
      var grid = doc.getElementById('psGrid');
      if (!grid) return;
      state.rendering = true;
      try {
        Array.prototype.forEach.call(grid.querySelectorAll('[data-screener-only="1"]'), function (card) { card.remove(); });
        var byTicker = Object.create(null);
        state.setups.forEach(function (setup) { byTicker[setup.ticker] = setup; });
        Array.prototype.forEach.call(grid.querySelectorAll('.ps-card:not([data-screener-only="1"])'), function (card) {
          var tickerNode = card.querySelector('.ps-ticker');
          var ticker = normalizeTicker(tickerNode && tickerNode.textContent);
          if (ticker && byTicker[ticker]) syncCard(card, byTicker[ticker]);
        });
      } finally { state.rendering = false; }
    }
    function cleanArtifacts(scope) {
      var node = scope && scope.nodeType ? scope : doc.body;
      if (!node) return;
      var walker = doc.createTreeWalker(node, 4);
      var textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      textNodes.forEach(function (textNode) {
        var parent = textNode.parentElement;
        if (!parent || /^(?:SCRIPT|STYLE|TEXTAREA|INPUT|SELECT|OPTION|CODE|PRE)$/.test(parent.tagName || '')) return;
        if (isStandaloneArtifact(textNode.nodeValue)) textNode.remove();
      });
    }
    function removeRedundantChartControl() {
      var input = doc.getElementById('chartTickerInput');
      var page = input && input.closest ? input.closest('.page-content') : doc.getElementById('page-chart');
      if (!page) return;
      Array.prototype.forEach.call(page.querySelectorAll('button'), function (button) {
        if (isRedundantChartControl(button.textContent)) button.remove();
      });
    }

    addStyles(); cleanArtifacts(doc.body); removeRedundantChartControl(); loadSetups(false);
    var scheduled = false;
    new MutationObserver(function (records) {
      if (scheduled) return;
      scheduled = true;
      root.setTimeout(function () {
        scheduled = false;
        records.forEach(function (record) { Array.prototype.forEach.call(record.addedNodes || [], function (node) {
          if (node.nodeType === 1) cleanArtifacts(node);
          else if (node.nodeType === 3 && isStandaloneArtifact(node.nodeValue)) node.remove();
        }); });
        removeRedundantChartControl();
        syncExistingCards();
      }, 60);
    }).observe(doc.body, { childList:true, subtree:true });
    return true;
  }

  return {
    version:VERSION,
    normalizeTicker:normalizeTicker,
    rowsFromPayload:rowsFromPayload,
    labelText:labelText,
    officialSetupLabels:officialSetupLabels,
    extractScreenerSetups:extractScreenerSetups,
    isStandaloneArtifact:isStandaloneArtifact,
    isRedundantChartControl:isRedundantChartControl,
    setupSignature:setupSignature,
    install:install
  };
});
