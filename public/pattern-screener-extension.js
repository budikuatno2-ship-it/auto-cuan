(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanPatternScreenerExtension = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VERSION = '20260729-pattern-screener-v6';
  var TICKER_RE = /^[A-Z]{3,5}$/;
  var SOURCES = [
    { name:'Swing Konglo', url:'/api/sector-hot?action=screener' },
    { name:'Swing Non-Konglo', url:'/api/sector-hot?action=nk-screener-results' },
    { name:'Day Trade', url:'/api/sector-hot?action=daytrade-screener' }
  ];
  var SOURCE_PRIORITY = { 'Day Trade':3, 'Swing Konglo':2, 'Swing Non-Konglo':1 };
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
  function finite(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function planContainers(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    var result = [row];
    [row.raw_payload, row.trade_plan, row.tradePlan, row.levels].forEach(function (value) {
      if (value && typeof value === 'object' && !Array.isArray(value)) result.push(value);
    });
    if (row.raw_payload && typeof row.raw_payload === 'object' && !Array.isArray(row.raw_payload)) {
      [row.raw_payload.trade_plan, row.raw_payload.tradePlan, row.raw_payload.levels].forEach(function (value) {
        if (value && typeof value === 'object' && !Array.isArray(value)) result.push(value);
      });
    }
    return result;
  }
  function firstFinite(containers, keys) {
    for (var i = 0; i < containers.length; i += 1) {
      for (var j = 0; j < keys.length; j += 1) {
        var value = finite(containers[i][keys[j]]);
        if (value != null) return value;
      }
    }
    return null;
  }
  function officialTradePlan(row, sourceName) {
    var containers = planContainers(row);
    if (!containers.length) return null;
    var plan = {
      source:String(sourceName || 'Screener'),
      entry_low:firstFinite(containers, ['entry_low','entryLow','entry_1','entry1']),
      entry_high:firstFinite(containers, ['entry_high','entryHigh','entry_2','entry2']),
      stop_loss:firstFinite(containers, ['stop_loss','stopLoss','sl','invalidation']),
      tp1:firstFinite(containers, ['tp1','target1','target_1','take_profit_1']),
      tp2:firstFinite(containers, ['tp2','target2','target_2','take_profit_2']),
      risk_reward:firstFinite(containers, ['risk_reward','riskReward','rr'])
    };
    if ([plan.entry_low, plan.entry_high, plan.stop_loss, plan.tp1, plan.tp2, plan.risk_reward].every(function (value) { return value == null; })) return null;
    if (plan.entry_low == null && plan.entry_high != null) plan.entry_low = plan.entry_high;
    if (plan.entry_high == null && plan.entry_low != null) plan.entry_high = plan.entry_low;
    return plan;
  }
  function planCompleteness(plan) {
    if (!plan) return 0;
    return ['entry_low','entry_high','stop_loss','tp1','tp2','risk_reward'].reduce(function (score, key) {
      return score + (finite(plan[key]) == null ? 0 : 1);
    }, 0);
  }
  function chooseTradePlan(plans) {
    var list = (Array.isArray(plans) ? plans : []).filter(Boolean).slice();
    list.sort(function (left, right) {
      return (planCompleteness(right) - planCompleteness(left)) ||
        ((SOURCE_PRIORITY[right.source] || 0) - (SOURCE_PRIORITY[left.source] || 0));
    });
    return list[0] || null;
  }
  function extractScreenerSetups(sources) {
    var map = Object.create(null);
    (Array.isArray(sources) ? sources : []).forEach(function (source) {
      var sourceName = String(source && source.name || 'Screener').trim() || 'Screener';
      rowsFromPayload(source && source.payload).forEach(function (row) {
        var ticker = normalizeTicker(row && (row.ticker || row.symbol || row.code));
        var labels = officialSetupLabels(row);
        var plan = officialTradePlan(row, sourceName);
        if (!ticker || (!labels.length && !plan)) return;
        if (!map[ticker]) map[ticker] = { ticker:ticker, labels:[], sources:[], plans:[] };
        labels.forEach(function (label) { if (map[ticker].labels.indexOf(label) < 0) map[ticker].labels.push(label); });
        if (map[ticker].sources.indexOf(sourceName) < 0) map[ticker].sources.push(sourceName);
        if (plan) {
          var existingIndex = map[ticker].plans.findIndex(function (item) { return item.source === sourceName; });
          if (existingIndex < 0) map[ticker].plans.push(plan);
          else if (planCompleteness(plan) > planCompleteness(map[ticker].plans[existingIndex])) map[ticker].plans[existingIndex] = plan;
        }
      });
    });
    return Object.keys(map).sort().map(function (ticker) {
      var item = map[ticker];
      return { ticker:item.ticker, labels:item.labels, sources:item.sources, tradePlan:chooseTradePlan(item.plans) };
    });
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
  function number(value) {
    var n = finite(value);
    return n == null ? '—' : n.toLocaleString('id-ID', { maximumFractionDigits:2 });
  }
  function entryText(plan) {
    if (!plan) return '—';
    var low = finite(plan.entry_low), high = finite(plan.entry_high);
    if (low == null && high == null) return '—';
    if (low == null) low = high;
    if (high == null) high = low;
    return low === high ? number(low) : number(low) + '–' + number(high);
  }
  function setupSignature(setup) {
    var plan = setup.tradePlan || {};
    return setup.ticker + '|' + setup.labels.join('|') + '|' + setup.sources.join('|') + '|' +
      [plan.source, plan.entry_low, plan.entry_high, plan.stop_loss, plan.tp1, plan.tp2, plan.risk_reward].join('|');
  }

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
        '.ps-screener-plan{margin-top:12px;padding:10px;border:1px solid rgba(56,189,248,.16);border-radius:12px;background:rgba(14,116,144,.055)}',
        '.ps-screener-plan-title{margin-bottom:7px;color:#7dd3fc;font-size:9px;font-weight:850;text-transform:uppercase;letter-spacing:.04em}',
        '.ps-screener-levels{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px}',
        '.ps-screener-level{min-width:0;padding:7px;border:1px solid rgba(148,163,184,.09);border-radius:9px;background:rgba(2,6,23,.32)}',
        '.ps-screener-level span{display:block;color:#64748b;font-size:8px;text-transform:uppercase}.ps-screener-level b{display:block;margin-top:2px;color:#e5e7eb;font-size:11px;overflow-wrap:anywhere}',
        '@media(max-width:760px){.ps-screener-levels{grid-template-columns:repeat(2,minmax(0,1fr))}}',
        '.ps-screener-plan.direction-conflict{border-color:rgba(248,113,113,.28);background:rgba(239,68,68,.07)}',
        '.ps-screener-plan.direction-conflict .ps-screener-plan-title{color:#fca5a5}',
        '.ps-screener-conflict-text{margin:0;color:#fecaca;font-size:10px;line-height:1.55}',
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
    // The Pattern card owns one direction. A Screener plan pointing the other way
    // must never sit inside it looking like confluence.
    //
    // This check used to live in pattern-direction-safety.js, which recovered the
    // plan by reading the rendered "1.302–1.329" / "1.263" strings back out of the
    // DOM and re-parsing them. The numbers are right here, unformatted, so the
    // guard now runs on them directly — same rule, no string round trip.
    function planConflict(card, plan) {
      var safety = root.AutoCuanPatternSafety;
      if (!safety || !plan) return null;
      var direction = safety.cardDirection(card);
      var planDirection = safety.tradePlanDirection(plan);
      if (safety.directionsCompatible(direction, planDirection)) {
        return { conflict:false, planDirection:planDirection };
      }
      return { conflict:true, direction:direction, planDirection:planDirection };
    }

    function directionWord(value) {
      if (value === 'bullish') return 'naik/long';
      if (value === 'bearish') return 'turun/short';
      return 'tidak konsisten';
    }

    function syncTradePlan(card, plan) {
      var box = card.querySelector('.ps-screener-plan');
      if (!plan) { if (box) box.remove(); return; }
      if (!box) {
        box = doc.createElement('div');
        box.className = 'ps-screener-plan';
        var actions = card.querySelector('.ps-card-actions');
        actions ? card.insertBefore(box, actions) : card.appendChild(box);
      }
      var verdict = planConflict(card, plan);
      if (verdict && verdict.conflict) {
        box.classList.add('direction-conflict');
        box.setAttribute('data-direction-conflict', '1');
        box.setAttribute('data-plan-direction', verdict.planDirection);
        box.innerHTML = '<div class="ps-screener-plan-title">Konflik arah · level Screener disembunyikan</div>' +
          '<p class="ps-screener-conflict-text">Pola ini ' + esc(directionWord(verdict.direction)) + ', sedangkan rencana ' +
          esc(plan.source) + ' bersifat ' + esc(directionWord(verdict.planDirection)) +
          '. Keduanya tidak digabung menjadi satu setup masuk.</p>';
        return;
      }
      box.classList.remove('direction-conflict');
      box.removeAttribute('data-direction-conflict');
      if (verdict) box.setAttribute('data-plan-direction', verdict.planDirection);
      var suffix = verdict && verdict.planDirection !== 'unknown'
        ? ' · ' + (verdict.planDirection === 'bullish' ? 'Naik/Long' : 'Turun/Short')
        : '';
      box.innerHTML = '<div class="ps-screener-plan-title">Level Screener · ' + esc(plan.source) + esc(suffix) + '</div>' +
        '<div class="ps-screener-levels">' +
        '<div class="ps-screener-level"><span>Entry</span><b>' + entryText(plan) + '</b></div>' +
        '<div class="ps-screener-level"><span>Stop Loss</span><b>' + number(plan.stop_loss) + '</b></div>' +
        '<div class="ps-screener-level"><span>TP1</span><b>' + number(plan.tp1) + '</b></div>' +
        '<div class="ps-screener-level"><span>TP2</span><b>' + number(plan.tp2) + '</b></div>' +
        '<div class="ps-screener-level"><span>R/R</span><b>' + number(plan.risk_reward) + '</b></div>' +
        '</div>';
    }
    function syncCard(card, setup) {
      var signature = setupSignature(setup);
      if (card.getAttribute('data-setup-signature') === signature) return;
      card.setAttribute('data-setup-signature', signature);
      var chips = card.querySelector('.ps-setup-chips');
      var source = card.querySelector('.ps-setup-source');
      if (setup.labels.length) {
        if (!chips) {
          chips = doc.createElement('div');
          chips.className = 'ps-setup-chips';
          var actions = card.querySelector('.ps-card-actions');
          actions ? card.insertBefore(chips, actions) : card.appendChild(chips);
        }
        var safety = root.AutoCuanPatternSafety;
        var direction = safety ? safety.cardDirection(card) : 'unknown';
        var split = safety ? safety.filterLabelsForDirection(setup.labels, direction) : { accepted:setup.labels, rejected:[] };
        chips.innerHTML = split.accepted.map(function (label) { return '<span class="ps-setup-chip">' + esc(label) + '</span>'; }).join('');
        if (!source) {
          source = doc.createElement('p'); source.className = 'ps-setup-source';
          chips.parentNode.insertBefore(source, chips.nextSibling);
        }
        if (split.rejected.length && !split.accepted.length) {
          source.textContent = 'Label Screener untuk ' + setup.ticker + ' berlawanan arah dengan pola ini, jadi tidak ditampilkan sebagai penguat.';
        } else if (split.rejected.length) {
          source.textContent = 'Juga terdeteksi oleh: ' + setup.sources.join(', ') + '. ' + split.rejected.length + ' label berlawanan arah disembunyikan.';
        } else {
          source.textContent = 'Juga terdeteksi oleh: ' + setup.sources.join(', ') + '. Label ini hanya memperkuat konteks.';
        }
      } else {
        if (chips) chips.remove();
        if (source) source.remove();
      }
      syncTradePlan(card, setup.tradePlan);
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
    officialTradePlan:officialTradePlan,
    chooseTradePlan:chooseTradePlan,
    extractScreenerSetups:extractScreenerSetups,
    isStandaloneArtifact:isStandaloneArtifact,
    isRedundantChartControl:isRedundantChartControl,
    setupSignature:setupSignature,
    entryText:entryText,
    install:install
  };
});
