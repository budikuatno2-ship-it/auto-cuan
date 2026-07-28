(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanPatternScreenerExtension = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VERSION = '20260728-pattern-screener-v2';
  var TICKER_RE = /^[A-Z]{3,5}$/;
  var SOURCES = [
    { name:'Swing Konglo', url:'/api/sector-hot?action=screener' },
    { name:'Swing Non-Konglo', url:'/api/sector-hot?action=nk-screener-results' },
    { name:'Day Trade', url:'/api/sector-hot?action=daytrade-screener' }
  ];

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

  function officialSetupLabels(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    var containers = [row];
    if (row.raw_payload && typeof row.raw_payload === 'object' && !Array.isArray(row.raw_payload)) containers.push(row.raw_payload);
    var labels = [];
    containers.forEach(function (container) {
      if (Array.isArray(container.smart_setup_labels)) container.smart_setup_labels.forEach(function (label) {
        label = String(label == null ? '' : label).trim();
        if (label && labels.indexOf(label) < 0) labels.push(label);
      });
      var primary = String(container.primary_smart_setup == null ? '' : container.primary_smart_setup).trim();
      if (primary && labels.indexOf(primary) < 0) labels.push(primary);
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

  function isRedundantChartControl(value, id, dataPage) {
    return String(value == null ? '' : value).trim() === 'Technical Chart' &&
      String(id || '') !== 'technicalChartTab' && String(dataPage || '') !== 'chart';
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char];
    });
  }

  function setupSignature(setup) {
    return setup.ticker + '|' + setup.labels.join('|') + '|' + setup.sources.join('|');
  }

  function setupOnlyCardHtml(setup) {
    return '<article class="ps-card ps-setup-only" data-screener-only="1" data-setup-ticker="' + esc(setup.ticker) + '" data-setup-signature="' + esc(setupSignature(setup)) + '">' +
      '<div class="ps-card-head"><div><div class="ps-ticker">' + esc(setup.ticker) + '</div><div class="ps-name">Setup resmi dari Screener terbaru</div></div><span class="ps-badge">Setup Screener</span></div>' +
      '<div class="ps-setup-chips">' + setup.labels.map(function (label) { return '<span class="ps-setup-chip">' + esc(label) + '</span>'; }).join('') + '</div>' +
      '<p class="ps-setup-source">Sumber: ' + esc(setup.sources.join(', ')) + '. Label setup bukan sinyal BUY.</p>' +
      '<div class="ps-card-actions"><button class="ps-btn alt" data-setup-chart="' + esc(setup.ticker) + '">Buka Chart</button></div></article>';
  }

  function install(root) {
    if (!root || !root.document || root.__AUTOCUAN_PATTERN_SCREENER_EXTENSION__) return false;
    root.__AUTOCUAN_PATTERN_SCREENER_EXTENSION__ = VERSION;
    var doc = root.document;
    var state = { active:root.location && root.location.pathname === '/pattern', setups:[], loading:false, loadedAt:0, rendering:false, generation:0 };

    function addStyles() {
      if (doc.getElementById('patternScreenerExtensionStyles')) return;
      var style = doc.createElement('style');
      style.id = 'patternScreenerExtensionStyles';
      style.textContent = [
        '.ps-setup-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:13px}',
        '.ps-setup-chip{display:inline-flex;align-items:center;min-height:27px;padding:5px 9px;border:1px solid rgba(52,211,153,.22);border-radius:999px;background:rgba(16,185,129,.075);color:#9ff3d3;font-size:10px;font-weight:800}',
        '.ps-setup-source{margin-top:10px;color:#7f8da3;font-size:10px;line-height:1.55}',
        '.ps-setup-only{border-color:rgba(96,165,250,.17);background:linear-gradient(145deg,rgba(13,24,39,.72),rgba(11,18,29,.64))}',
        '.ps-setup-only .ps-badge{border-color:rgba(52,211,153,.23);background:rgba(16,185,129,.08);color:#86efca}',
        '[data-ui-artifact="1"]{display:none!important}'
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
      if (state.loading) return state.setups;
      if (!force && state.loadedAt && Date.now() - state.loadedAt < 30000) return state.setups;
      state.loading = true;
      try {
        var payloads = await Promise.all(SOURCES.map(function (source) { return fetchJson(source.url).catch(function () { return null; }); }));
        state.setups = extractScreenerSetups(SOURCES.map(function (source, index) { return { name:source.name, payload:payloads[index] }; }));
        state.loadedAt = Date.now();
        syncSetups();
        return state.setups;
      } finally { state.loading = false; }
    }

    function scanFinished() {
      var status = doc.getElementById('psStatus');
      return !!status && /^Selesai memindai\b/.test(String(status.textContent || '').trim());
    }

    function existingAbcdCards(grid) {
      var map = Object.create(null);
      Array.prototype.forEach.call(grid.querySelectorAll('.ps-card:not([data-screener-only="1"])'), function (card) {
        var ticker = normalizeTicker(card.querySelector('.ps-ticker') && card.querySelector('.ps-ticker').textContent);
        if (ticker) map[ticker] = card;
      });
      return map;
    }

    function syncAbcdCard(card, setup) {
      var signature = setupSignature(setup);
      if (card.getAttribute('data-setup-signature') === signature) return;
      card.setAttribute('data-setup-signature', signature);
      card.setAttribute('data-has-screener-setup', '1');
      var chips = card.querySelector('.ps-setup-chips');
      if (!chips) {
        chips = doc.createElement('div');
        chips.className = 'ps-setup-chips';
        var levels = card.querySelector('.ps-levels');
        if (levels) levels.parentNode.insertBefore(chips, levels);
        else card.appendChild(chips);
      }
      var chipHtml = setup.labels.map(function (label) { return '<span class="ps-setup-chip">' + esc(label) + '</span>'; }).join('');
      if (chips.innerHTML !== chipHtml) chips.innerHTML = chipHtml;
      var source = card.querySelector('.ps-setup-source');
      if (!source) {
        source = doc.createElement('p'); source.className = 'ps-setup-source';
        chips.parentNode.insertBefore(source, chips.nextSibling);
      }
      var text = 'Juga terdeteksi oleh: ' + setup.sources.join(', ') + '.';
      if (source.textContent !== text) source.textContent = text;
    }

    function syncSetups() {
      if (state.rendering || !state.setups.length) return;
      var grid = doc.getElementById('psGrid');
      if (!grid) return;
      state.rendering = true;
      try {
        var abcd = existingAbcdCards(grid);
        var desiredOnly = Object.create(null);
        state.setups.forEach(function (setup) {
          if (abcd[setup.ticker]) syncAbcdCard(abcd[setup.ticker], setup);
          else if (scanFinished()) desiredOnly[setup.ticker] = setup;
        });
        var currentOnly = Object.create(null);
        Array.prototype.forEach.call(grid.querySelectorAll('[data-screener-only="1"]'), function (card) {
          var ticker = normalizeTicker(card.getAttribute('data-setup-ticker'));
          if (!ticker || !desiredOnly[ticker]) { card.remove(); return; }
          currentOnly[ticker] = card;
          if (card.getAttribute('data-setup-signature') !== setupSignature(desiredOnly[ticker])) {
            card.insertAdjacentHTML('afterend', setupOnlyCardHtml(desiredOnly[ticker]));
            card.remove();
          }
        });
        Object.keys(desiredOnly).forEach(function (ticker) {
          if (!currentOnly[ticker]) grid.insertAdjacentHTML('beforeend', setupOnlyCardHtml(desiredOnly[ticker]));
        });
        var subtitle = doc.querySelector('#page-pattern .ps-sub');
        var subtitleText = 'Menampilkan ABCD T-1 valid serta setup resmi yang sudah dihasilkan Screener terbaru. Tidak ada pencarian ticker manual.';
        if (subtitle && subtitle.textContent !== subtitleText) subtitle.textContent = subtitleText;
        if (scanFinished()) {
          var tickers = Object.create(null);
          Array.prototype.forEach.call(grid.querySelectorAll('.ps-ticker'), function (node) { var ticker = normalizeTicker(node.textContent); if (ticker) tickers[ticker] = true; });
          var countText = Object.keys(tickers).length + ' saham pattern';
          var count = doc.getElementById('psCount');
          if (count && count.textContent !== countText) count.textContent = countText;
        }
      } finally { state.rendering = false; }
    }

    function allowed() {
      return !root.PatternMapAdminAccess || typeof root.PatternMapAdminAccess.isAllowed !== 'function' || root.PatternMapAdminAccess.isAllowed() === true;
    }

    function ensureVisible() {
      if (!state.active || !allowed()) return;
      var page = doc.getElementById('page-pattern');
      var screen = doc.getElementById('dashboardScreen');
      if (!page || !screen) return;
      var footer = screen.querySelector('footer');
      if (page.parentNode !== screen) footer ? screen.insertBefore(page, footer) : screen.appendChild(page);
      else if (footer && page.nextSibling !== footer) screen.insertBefore(page, footer);
      Array.prototype.forEach.call(doc.querySelectorAll('.page-content'), function (node) { node.classList.toggle('hidden', node !== page); });
      page.classList.remove('hidden');
      Array.prototype.forEach.call(doc.querySelectorAll('.nav-btn[data-page]'), function (button) { button.classList.toggle('active', button.getAttribute('data-page') === 'pattern'); });
      syncSetups();
    }

    function recoverReentry() {
      var generation = ++state.generation;
      [0, 40, 120, 260, 500, 900, 1500].forEach(function (delay) {
        root.setTimeout(function () { if (generation === state.generation) ensureVisible(); }, delay);
      });
    }

    function removeRedundantChartControl() {
      var input = doc.getElementById('chartTickerInput');
      var page = input && input.closest ? input.closest('.page-content') : doc.getElementById('page-chart');
      if (!page) return;
      Array.prototype.forEach.call(page.querySelectorAll('button'), function (button) {
        if (isRedundantChartControl(button.textContent, button.id, button.getAttribute('data-page'))) button.remove();
      });
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
      if (node.querySelectorAll) Array.prototype.forEach.call(node.querySelectorAll('p,div,span,li'), function (part) {
        if (!part.children.length && isStandaloneArtifact(part.textContent)) { part.setAttribute('data-ui-artifact', '1'); part.remove(); }
      });
    }

    function openChart(ticker) {
      state.active = false; state.generation += 1;
      root.navigateTo('chart');
      var input = doc.getElementById('chartTickerInput');
      if (input) input.value = ticker;
    }

    addStyles(); cleanArtifacts(doc.body); removeRedundantChartControl();
    var priorNavigate = root.navigateTo;
    if (typeof priorNavigate === 'function') root.navigateTo = function (pageName) {
      state.active = pageName === 'pattern';
      if (!state.active) state.generation += 1;
      var result = priorNavigate.apply(root, arguments);
      if (state.active) {
        loadSetups(false); recoverReentry();
        Promise.resolve(result).then(recoverReentry, recoverReentry);
      }
      return result;
    };

    doc.addEventListener('click', function (event) {
      var chartButton = event.target.closest && event.target.closest('[data-setup-chart]');
      if (chartButton) { event.preventDefault(); openChart(chartButton.getAttribute('data-setup-chart')); return; }
      if (event.target.closest && event.target.closest('#psRefresh')) loadSetups(true);
    });

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
        if (state.active) ensureVisible();
        syncSetups();
      }, 20);
    }).observe(doc.body, { childList:true, subtree:true, attributes:true, attributeFilter:['class'] });

    if (state.active) { loadSetups(false); recoverReentry(); }
    return true;
  }

  return {
    version:VERSION,
    normalizeTicker:normalizeTicker,
    rowsFromPayload:rowsFromPayload,
    officialSetupLabels:officialSetupLabels,
    extractScreenerSetups:extractScreenerSetups,
    isStandaloneArtifact:isStandaloneArtifact,
    isRedundantChartControl:isRedundantChartControl,
    setupSignature:setupSignature,
    setupOnlyCardHtml:setupOnlyCardHtml,
    install:install
  };
});
