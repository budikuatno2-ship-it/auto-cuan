(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanUiStability = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var TICKER_RE = /^[A-Z]{3,5}$/;
  var SCAN_CONCURRENCY = 4;
  var SCRIPT_VERSION = '20260802-ui-stability-v2';

  function normalizeTicker(value) {
    var ticker = String(value == null ? '' : value).trim().toUpperCase().replace(/\.JK$/, '');
    return TICKER_RE.test(ticker) ? ticker : null;
  }

  function rowsFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return [];
    var keys = ['results', 'rows', 'data', 'picks', 'top5', 'radar_candidates'];
    for (var i = 0; i < keys.length; i += 1) {
      if (Array.isArray(payload[keys[i]])) return payload[keys[i]];
    }
    return [];
  }

  function collectTickers(payloads) {
    var seen = Object.create(null);
    var tickers = [];
    (Array.isArray(payloads) ? payloads : []).forEach(function (payload) {
      rowsFromPayload(payload).forEach(function (row) {
        var value = typeof row === 'string' ? row : row && (row.ticker || row.symbol || row.code);
        var ticker = normalizeTicker(value);
        if (!ticker || seen[ticker]) return;
        seen[ticker] = true;
        tickers.push(ticker);
      });
    });
    return tickers;
  }

  function cleanVisibleArtifacts(value) {
    return String(value == null ? '' : value)
      .replace(/(^|\n)\s*(?:[;|]+|[-*_]{3,}|#{1,6}|\*\*|__)\s*(?:\n|$)/g, '$1')
      .replace(/^\s*;\s*/gm, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function formatPrice(value) {
    if (value == null || value === '') return null;
    var number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString('id-ID', { maximumFractionDigits: 2 }) : null;
  }

  // Levels are only useful if the reader can tell which price each dashed line
  // marks. Printing the value into the legend label removes that guesswork.
  function levelLabel(name, value) {
    var price = formatPrice(value);
    return price == null ? name : name + '  ' + price;
  }

  // The Chart.js config builder that lived here produced input for a
  // quickchart.io PNG render. Pattern figures are now drawn locally as inline
  // SVG by pattern-visual.js, so both the config builder and its per-viewport
  // raster presentation table went away with that dependency.


  async function mapBounded(items, concurrency, worker, onProgress) {
    var list = Array.isArray(items) ? items : [];
    var next = 0;
    var completed = 0;
    var results = new Array(list.length);
    var count = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
    async function runWorker() {
      while (next < list.length) {
        var index = next;
        next += 1;
        try { results[index] = await worker(list[index], index); }
        catch (_) { results[index] = null; }
        completed += 1;
        if (typeof onProgress === 'function') onProgress(completed, list.length, results[index]);
      }
    }
    await Promise.all(Array.from({ length: count }, runWorker));
    return results;
  }

  function installPortfolioPolish(root) {
    var doc = root.document;
    if (!doc.getElementById('tabStrip') || doc.getElementById('autocuanPortfolioPolish')) return false;

    var style = doc.createElement('style');
    style.id = 'autocuanPortfolioPolish';
    style.textContent = [
      '.tab-strip{top:10px;padding:6px;margin:14px 0 18px;border:1px solid rgba(148,163,184,.15);border-radius:16px;background:rgba(9,15,24,.86);backdrop-filter:blur(18px);box-shadow:0 14px 36px rgba(0,0,0,.22);gap:4px}',
      '.tab-strip:before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(90deg,rgba(52,211,153,.045),transparent 36%,rgba(59,130,246,.035))}',
      '.tab{position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:1 1 auto;min-height:44px;padding:9px 12px;border:0;border-radius:11px;background:transparent;color:#8fa0b7;font-size:12px;font-weight:760;box-shadow:none}',
      '.tab:hover{border:0;background:rgba(148,163,184,.07);color:#d9e4f2}',
      '.tab.active,.tab[aria-selected=true]{border:0;color:#ecfdf5;background:linear-gradient(135deg,rgba(16,185,129,.22),rgba(34,211,238,.105));box-shadow:inset 0 0 0 1px rgba(52,211,153,.28),0 8px 22px rgba(2,44,34,.18)}',
      '.tab.active:after,.tab[aria-selected=true]:after{content:"";position:absolute;left:22%;right:22%;bottom:3px;height:2px;border-radius:999px;background:linear-gradient(90deg,#34d399,#22d3ee)}',
      '.tab-icon{width:17px;height:17px;flex:0 0 auto;opacity:.8}.tab.active .tab-icon,.tab[aria-selected=true] .tab-icon{opacity:1;filter:drop-shadow(0 0 7px rgba(52,211,153,.28))}',
      '.ai-shell{gap:18px}.ai-chat{border-color:rgba(96,165,250,.18);background:radial-gradient(circle at 92% 0,rgba(59,130,246,.09),transparent 28%),linear-gradient(180deg,rgba(15,25,38,.99),rgba(8,15,24,.99))}',
      '.ai-chat>.card-head{padding:2px 2px 14px}.ai-chat>.card-head h2{font-size:19px}.ai-quick{padding:12px 0 10px;gap:8px}.ai-quick .btn{border-color:rgba(96,165,250,.18);background:rgba(30,64,175,.08);color:#cfe2ff}.ai-quick .btn:hover{border-color:rgba(96,165,250,.38);background:rgba(37,99,235,.13)}',
      '.ai-messages{padding:15px 8px 18px 2px}.ai-message{box-shadow:0 9px 24px rgba(0,0,0,.13)}.ai-assistant{border-color:rgba(96,165,250,.17);background:linear-gradient(145deg,rgba(9,18,30,.96),rgba(12,24,39,.9))}.ai-user{background:linear-gradient(145deg,rgba(5,150,105,.18),rgba(8,95,76,.14))}',
      '.ai-compose{padding:12px;border:1px solid rgba(148,163,184,.12);border-radius:14px;background:rgba(4,10,18,.54)}.ai-compose textarea{border:0;background:transparent;box-shadow:none!important;padding:7px 8px}.ai-compose .btn{min-width:86px}',
      '.ai-shell>aside{border-color:rgba(96,165,250,.15);background:linear-gradient(180deg,rgba(14,23,35,.98),rgba(9,16,25,.98))}.ai-data-card{border-color:rgba(96,165,250,.12);background:rgba(8,17,29,.7)}',
      '.ai-rich-text p:empty,.ai-rich-text p[data-artifact=true]{display:none!important}',
      '@media(max-width:1180px){.tab{flex:0 0 auto}.tab-strip{overflow-x:auto}}',
      '@media(max-width:760px){.tab-strip{top:6px;padding:5px;margin-top:10px}.tab{min-height:42px;padding:8px 11px}.tab-icon{width:16px;height:16px}.ai-compose{grid-template-columns:1fr}.ai-compose .btn{width:100%}}'
    ].join('');
    doc.head.appendChild(style);

    var icons = {
      today: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 13h5l2-7 3 12 2-5h4"/>',
      planner: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M5 4h14v16H5zM8 8h8M8 12h3M14 12h2M8 16h8"/>',
      watch: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M2.8 12s3.4-5 9.2-5 9.2 5 9.2 5-3.4 5-9.2 5-9.2-5-9.2-5Z"/><circle cx="12" cy="12" r="2.4"/>',
      risk: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 3 5 6v5c0 4.6 2.7 7.8 7 10 4.3-2.2 7-5.4 7-10V6l-7-3Z"/><path stroke-linecap="round" stroke-width="1.8" d="M9 12h6M12 9v6"/>',
      scenarios: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M6 4v6a2 2 0 0 0 2 2h8M6 20v-4a2 2 0 0 1 2-2h8M16 8l4 4-4 4"/>',
      journal: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z"/><path stroke-linecap="round" stroke-width="1.8" d="M8 8h7M8 12h7M8 16h4"/>',
      ai: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="m12 3 1.2 3.3L16.5 7.5l-3.3 1.2L12 12l-1.2-3.3-3.3-1.2 3.3-1.2L12 3ZM18 13l.8 2.2L21 16l-2.2.8L18 19l-.8-2.2L15 16l2.2-.8L18 13ZM6 14l1 2.7 2.7 1L7 18.7 6 21l-1-2.3-2.7-1 2.7-1L6 14Z"/>'
    };
    Array.prototype.forEach.call(doc.querySelectorAll('#tabStrip [data-tab]'), function (button) {
      if (button.querySelector('.tab-icon')) return;
      var key = button.getAttribute('data-tab');
      var label = button.textContent.trim();
      button.innerHTML = '<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">' + (icons[key] || icons.today) + '</svg><span>' + label + '</span>';
    });
    var aiHead = doc.querySelector('.ai-chat>.card-head>div');
    if (aiHead && !aiHead.querySelector('.eyebrow')) {
      var eyebrow = doc.createElement('p');
      eyebrow.className = 'eyebrow';
      eyebrow.textContent = 'PORTFOLIO COPILOT';
      aiHead.insertBefore(eyebrow, aiHead.firstChild);
    }

    function artifactOnly(value) {
      return /^(?:;|\||[-*_]{3,}|#{1,6}|\*\*|__)$/.test(String(value == null ? '' : value).trim());
    }

    function pruneStandaloneArtifacts(container) {
      if (!container || !container.childNodes) return;
      Array.prototype.slice.call(container.childNodes).forEach(function (child) {
        if (child.nodeType === 3) {
          if (artifactOnly(child.nodeValue)) child.remove();
          return;
        }
        if (child.nodeType !== 1 || /^(?:SCRIPT|STYLE|TEXTAREA|INPUT|SELECT|OPTION)$/.test(child.tagName || '')) return;
        if (!child.children.length && artifactOnly(child.textContent)) {
          child.setAttribute('data-artifact', 'true');
          child.remove();
          return;
        }
        pruneStandaloneArtifacts(child);
      });
    }

    function cleanNode(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        var parent = node.parentElement;
        if (parent && parent.closest && parent.closest('#app') && artifactOnly(node.nodeValue)) node.remove();
        return;
      }
      if (node.nodeType !== 1) return;

      var appScope = node.id === 'app' ? node : (node.closest && node.closest('#app')) || (node.querySelector && node.querySelector('#app'));
      if (appScope) pruneStandaloneArtifacts(appScope === true ? node : appScope);

      var targets = [];
      if (node.matches && node.matches('.ai-message.ai-assistant,.ai-content.ai-followup,.ai-rich-text')) targets.push(node);
      if (node.querySelectorAll) Array.prototype.push.apply(targets, node.querySelectorAll('.ai-message.ai-assistant,.ai-content.ai-followup,.ai-rich-text'));
      targets.forEach(function (target) {
        if (target.hasAttribute('data-ui-cleaning')) return;
        target.setAttribute('data-ui-cleaning', 'true');
        try {
          Array.prototype.forEach.call(target.querySelectorAll('p,li,h3,div'), function (part) {
            if (artifactOnly(part.textContent)) {
              part.setAttribute('data-artifact', 'true');
              part.remove();
            }
          });
          if (!target.children.length) {
            var cleaned = cleanVisibleArtifacts(target.textContent || '');
            if (cleaned !== target.textContent) target.textContent = cleaned;
          }
        } finally {
          target.removeAttribute('data-ui-cleaning');
        }
      });
    }

    cleanNode(doc.body);
    var observer = new MutationObserver(function (records) {
      records.forEach(function (record) {
        Array.prototype.forEach.call(record.addedNodes || [], function (node) { cleanNode(node); });
      });
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    return true;
  }

  function install(root) {
    if (!root || !root.document) return false;
    return installPortfolioPolish(root);
  }

  return {
    version: SCRIPT_VERSION,
    normalizeTicker: normalizeTicker,
    rowsFromPayload: rowsFromPayload,
    collectTickers: collectTickers,
    cleanVisibleArtifacts: cleanVisibleArtifacts,
    formatPrice: formatPrice,
    levelLabel: levelLabel,
    mapBounded: mapBounded,
    install: install,
    constants: { SCAN_CONCURRENCY: SCAN_CONCURRENCY }
  };
});
