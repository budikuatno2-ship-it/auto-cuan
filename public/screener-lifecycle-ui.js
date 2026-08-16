(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanScreenerLifecycleUI = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VERSION = '20260816-lifecycle-ui-v1';
  var PHASE_META = {
    REVERSAL_EARLY: { short: 'Fase 1/4 · Reversal', tone: '#fbbf24', bg: 'rgba(245,158,11,.10)', border: 'rgba(245,158,11,.24)' },
    PRE_BREAKOUT: { short: 'Fase 2/4 · Pre-Breakout', tone: '#7dd3fc', bg: 'rgba(56,189,248,.10)', border: 'rgba(56,189,248,.24)' },
    BREAKOUT_CONFIRMED: { short: 'Fase 3/4 · Breakout', tone: '#6ee7b7', bg: 'rgba(16,185,129,.11)', border: 'rgba(16,185,129,.26)' },
    POST_BREAKOUT_CONTINUATION: { short: 'Fase 4/4 · Continuation', tone: '#c4b5fd', bg: 'rgba(139,92,246,.10)', border: 'rgba(139,92,246,.24)' },
    INVALIDATED: { short: 'Lifecycle · Diblokir', tone: '#fca5a5', bg: 'rgba(239,68,68,.09)', border: 'rgba(239,68,68,.22)' }
  };

  function cleanTicker(value) {
    return String(value == null ? '' : value).trim().toUpperCase().replace(/\.JK$/, '');
  }

  function phaseMeta(row) {
    var phase = String(row && row.setup_phase || '').toUpperCase();
    return PHASE_META[phase] || null;
  }

  function phaseSummary(row) {
    var meta = phaseMeta(row);
    if (!meta) return null;
    var confidence = Number(row && row.phase_confidence);
    var suffix = Number.isFinite(confidence) ? ' · ' + Math.round(confidence) + '%' : '';
    return meta.short + suffix;
  }

  function dataMap(root, kind) {
    if (kind === 'daytrade') return root._dtCardData || {};
    if (kind === 'konglo') return root._kgCardData || {};
    if (kind === 'nonkonglo') return root._nkCardData || {};
    return {};
  }

  function kindForCard(card) {
    if (!card) return null;
    if (card.classList.contains('dt-card-item')) return 'daytrade';
    if (card.classList.contains('kg-card-item')) return 'konglo';
    if (card.classList.contains('nk-card-item')) return 'nonkonglo';
    return null;
  }

  function rowForCard(root, card) {
    var kind = kindForCard(card);
    var ticker = cleanTicker(card && card.getAttribute('data-ticker'));
    if (!kind || !ticker) return null;
    return dataMap(root, kind)[ticker] || null;
  }

  function ensureCardChip(root, card) {
    var row = rowForCard(root, card);
    var meta = phaseMeta(row);
    var current = card && card.querySelector('[data-lifecycle-chip="1"]');
    if (!meta) {
      if (current) current.remove();
      return;
    }
    if (!current) {
      current = root.document.createElement('div');
      current.setAttribute('data-lifecycle-chip', '1');
      current.style.cssText = 'display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:0 0 9px 0;font-size:10px;line-height:1.35';
      var freshness = card.querySelector('[data-freshness-chip], .freshness-chip');
      if (freshness && freshness.parentNode) freshness.parentNode.insertAdjacentElement('afterend', current);
      else if (card.children.length > 1) card.insertBefore(current, card.children[1].nextSibling);
      else card.appendChild(current);
    }
    current.replaceChildren();
    var chip = root.document.createElement('span');
    chip.style.cssText = 'display:inline-flex;align-items:center;padding:3px 7px;border-radius:999px;font-weight:750;letter-spacing:.01em;border:1px solid ' + meta.border + ';background:' + meta.bg + ';color:' + meta.tone;
    chip.textContent = phaseSummary(row);
    chip.title = String(row.setup_phase_label || meta.short) + (row.phase_reason ? ' — ' + row.phase_reason : '');
    current.appendChild(chip);

    if (row.chase_risk === 'HIGH' || row.chase_risk === 'MEDIUM') {
      var chase = root.document.createElement('span');
      chase.style.cssText = 'color:' + (row.chase_risk === 'HIGH' ? '#fca5a5' : '#fcd34d') + ';font-weight:650';
      chase.textContent = 'Chase ' + row.chase_risk;
      current.appendChild(chase);
    }
  }

  function syncGrid(root, grid) {
    if (!grid) return;
    Array.prototype.forEach.call(grid.querySelectorAll('.dt-card-item,.kg-card-item,.nk-card-item'), function (card) {
      ensureCardChip(root, card);
    });
  }

  function detailValue(value) {
    var text = String(value == null ? '' : value).trim();
    return text || '—';
  }

  function appendDetail(root, row) {
    var content = root.document.getElementById('scrDetailContent');
    var meta = phaseMeta(row);
    if (!content || !meta) return;
    var old = content.querySelector('[data-lifecycle-detail="1"]');
    if (old) old.remove();

    var panel = root.document.createElement('section');
    panel.setAttribute('data-lifecycle-detail', '1');
    panel.style.cssText = 'margin:0 0 16px;padding:12px;border:1px solid ' + meta.border + ';border-radius:12px;background:' + meta.bg;

    var title = root.document.createElement('div');
    title.style.cssText = 'font-size:12px;font-weight:800;color:' + meta.tone + ';margin-bottom:8px';
    title.textContent = detailValue(row.setup_phase_label || meta.short) + (Number.isFinite(Number(row.phase_confidence)) ? ' · ' + Math.round(Number(row.phase_confidence)) + '%' : '');
    panel.appendChild(title);

    var metrics = root.document.createElement('div');
    metrics.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-bottom:8px;font-size:10px;color:#94a3b8';
    [
      ['Volume', row.volume_quality],
      ['Breakout', row.breakout_quality],
      ['Chase', row.chase_risk]
    ].forEach(function (item) {
      var cell = root.document.createElement('div');
      cell.style.cssText = 'padding:7px;border-radius:8px;background:rgba(2,6,23,.25);min-width:0';
      var label = root.document.createElement('span');
      label.style.cssText = 'display:block;color:#64748b;margin-bottom:2px';
      label.textContent = item[0];
      var value = root.document.createElement('strong');
      value.style.cssText = 'display:block;color:#e5e7eb;overflow-wrap:anywhere';
      value.textContent = detailValue(item[1]);
      cell.appendChild(label); cell.appendChild(value); metrics.appendChild(cell);
    });
    panel.appendChild(metrics);

    if (row.phase_reason) {
      var reason = root.document.createElement('p');
      reason.style.cssText = 'margin:0;color:#cbd5e1;font-size:10.5px;line-height:1.5';
      reason.textContent = row.phase_reason;
      panel.appendChild(reason);
    }

    content.insertBefore(panel, content.firstChild ? content.firstChild.nextSibling : null);
  }

  function install(root) {
    if (!root || !root.document || root.__AUTOCUAN_SCREENER_LIFECYCLE_UI__) return false;
    root.__AUTOCUAN_SCREENER_LIFECYCLE_UI__ = VERSION;
    var doc = root.document;
    ['dtCardGrid', 'kgCardGrid', 'nkCardGrid'].forEach(function (id) {
      var grid = doc.getElementById(id);
      if (!grid) return;
      syncGrid(root, grid);
      new root.MutationObserver(function () { syncGrid(root, grid); }).observe(grid, { childList: true });
    });

    doc.addEventListener('click', function (event) {
      var card = event.target && event.target.closest ? event.target.closest('.dt-card-item,.kg-card-item,.nk-card-item') : null;
      if (!card) return;
      var row = rowForCard(root, card);
      if (!row) return;
      root.setTimeout(function () { appendDetail(root, row); }, 0);
    });
    return true;
  }

  return {
    VERSION: VERSION,
    PHASE_META: PHASE_META,
    cleanTicker: cleanTicker,
    phaseMeta: phaseMeta,
    phaseSummary: phaseSummary,
    install: install
  };
});
