'use strict';

/**
 * public/manual-screener-runtime.js
 * ============================================================================
 * V6 (W2b / Feature 13E) — Manual Screener rule-builder UI.
 *
 * Renders a rule builder (add/remove rule, AND/OR toggle, field/op/value
 * selects, live result count, sortable result table, save/load presets per
 * user, clear filters, "why matched" explanation, source_as_of badge) and
 * posts to /api/manual-screener.
 *
 * Presets are stored per user in localStorage (key includes the session user
 * id when available). The server endpoint is the source of truth for results;
 * presets are a client convenience only.
 * ============================================================================
 */

(function (root) {
  var VERSION = 'v6-w2b-13e-1';

  var FIELDS = [
    { key: 'price', label: 'Harga', kind: 'number' },
    { key: 'change_pct', label: 'Perubahan %', kind: 'number' },
    { key: 'volume', label: 'Volume', kind: 'number' },
    { key: 'value_traded', label: 'Nilai transaksi', kind: 'number' },
    { key: 'market_cap', label: 'Kapitalisasi pasar', kind: 'number' },
    { key: 'pbv', label: 'PBV', kind: 'number' },
    { key: 'per', label: 'PER', kind: 'number' },
    { key: 'roe_ttm', label: 'ROE TTM', kind: 'number' },
    { key: 'der', label: 'DER', kind: 'number' },
    { key: 'eps', label: 'EPS', kind: 'number' },
    { key: 'foreign_net', label: 'Net asing', kind: 'number' },
    { key: 'broker_concentration_cr3', label: 'Konsentrasi broker CR3', kind: 'number' },
    { key: 'hsc_status', label: 'Status HSC', kind: 'enum' },
    { key: 'free_float_pct', label: 'Free float %', kind: 'number' },
    { key: 'atr14_pct', label: 'ATR14 %', kind: 'number' },
    { key: 'rsi14', label: 'RSI14', kind: 'number' },
    { key: 'ma20_distance_pct', label: 'Jarak MA20 %', kind: 'number' }
  ];

  var OPS = [
    { key: 'gt', label: '>' },
    { key: 'gte', label: '≥' },
    { key: 'lt', label: '<' },
    { key: 'lte', label: '≤' },
    { key: 'eq', label: '=' },
    { key: 'neq', label: '≠' },
    { key: 'between', label: 'antara' },
    { key: 'is_null', label: 'kosong' },
    { key: 'not_null', label: 'terisi' }
  ];

  function esc(s) {
    // Built from char codes so the source never contains literal HTML entities
    // that a formatter could re-decode.
    var AMP = String.fromCharCode(38);
    var LT = String.fromCharCode(60);
    var GT = String.fromCharCode(62);
    var QUOT = String.fromCharCode(34);
    var APOS = String.fromCharCode(39);
    return String(s == null ? '' : s)
      .split(AMP).join(AMP + 'amp;')
      .split(LT).join(AMP + 'lt;')
      .split(GT).join(AMP + 'gt;')
      .split(QUOT).join(AMP + 'quot;')
      .split(APOS).join(AMP + '#39;');
  }

  function fieldDef(key) {
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].key === key) return FIELDS[i];
    return FIELDS[0];
  }

  function presetKey(userId) {
    return 'ac_manual_screener_presets::' + (userId || 'anon');
  }

  function loadPresets(userId) {
    try {
      var raw = localStorage.getItem(presetKey(userId));
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function savePresets(userId, presets) {
    try { localStorage.setItem(presetKey(userId), JSON.stringify(presets)); return true; } catch (_) { return false; }
  }

  function newRule() {
    return { field: 'price', op: 'gt', value: '' };
  }

  function create(container, options) {
    if (!container) return null;
    var opts = options || {};
    var state = {
      logic: 'AND',
      rules: [newRule()],
      sort: { field: 'change_pct', dir: 'desc' },
      lastResult: null,
      userId: opts.userId || null
    };

    container.innerHTML =
      '<div class="ms-root" style="display:flex;flex-direction:column;gap:10px">' +
        '<div class="ms-toolbar" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
          '<div class="ms-logic" role="group" aria-label="Logika gabungan">' +
            '<button type="button" data-logic="AND" class="ms-btn on" aria-pressed="true">AND</button>' +
            '<button type="button" data-logic="OR" class="ms-btn" aria-pressed="false">OR</button>' +
          '</div>' +
          '<button type="button" data-action="add" class="ms-btn">+ Aturan</button>' +
          '<button type="button" data-action="run" class="ms-btn primary">Terapkan</button>' +
          '<button type="button" data-action="clear" class="ms-btn">Bersihkan</button>' +
          '<span class="ms-count" aria-live="polite" data-role="count">—</span>' +
          '<span class="ms-asof" data-role="asof"></span>' +
        '</div>' +
        '<div class="ms-rules" data-role="rules"></div>' +
        '<div class="ms-presets" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
          '<input data-role="presetName" placeholder="Nama preset" aria-label="Nama preset" style="padding:4px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:transparent;color:inherit;font-size:12px">' +
          '<button type="button" data-action="savePreset" class="ms-btn">Simpan preset</button>' +
          '<select data-role="presetSelect" aria-label="Muat preset" style="padding:4px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:transparent;color:inherit;font-size:12px"></select>' +
          '<button type="button" data-action="loadPreset" class="ms-btn">Muat</button>' +
        '</div>' +
        '<div class="ms-results" data-role="results"></div>' +
      '</div>';

    var elRules = container.querySelector('[data-role="rules"]');
    var elCount = container.querySelector('[data-role="count"]');
    var elAsof = container.querySelector('[data-role="asof"]');
    var elResults = container.querySelector('[data-role="results"]');
    var elPresetSelect = container.querySelector('[data-role="presetSelect"]');
    var elPresetName = container.querySelector('[data-role="presetName"]');

    function renderRules() {
      var html = '';
      state.rules.forEach(function (r, i) {
        var def = fieldDef(r.field);
        html += '<div class="ms-rule" data-index="' + i + '" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px">';
        html += '<select data-role="field" aria-label="Field aturan ' + (i + 1) + '">';
        FIELDS.forEach(function (f) {
          html += '<option value="' + f.key + '"' + (f.key === r.field ? ' selected' : '') + '>' + esc(f.label) + '</option>';
        });
        html += '</select>';
        html += '<select data-role="op" aria-label="Operator aturan ' + (i + 1) + '">';
        OPS.forEach(function (o) {
          html += '<option value="' + o.key + '"' + (o.key === r.op ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        });
        html += '</select>';
        if (r.op !== 'is_null' && r.op !== 'not_null') {
          if (r.op === 'between') {
            var v = Array.isArray(r.value) ? r.value : ['', ''];
            html += '<input data-role="value0" value="' + esc(v[0]) + '" aria-label="Nilai bawah" style="width:80px">';
            html += '<input data-role="value1" value="' + esc(v[1]) + '" aria-label="Nilai atas" style="width:80px">';
          } else if (def.kind === 'enum') {
            html += '<select data-role="value" aria-label="Nilai aturan ' + (i + 1) + '">' +
              '<option value="HSC"' + (r.value === 'HSC' ? ' selected' : '') + '>HSC</option>' +
              '<option value="NON_HSC"' + (r.value === 'NON_HSC' ? ' selected' : '') + '>NON_HSC</option>' +
              '</select>';
          } else {
            html += '<input data-role="value" value="' + esc(r.value) + '" aria-label="Nilai aturan ' + (i + 1) + '" style="width:100px">';
          }
        }
        html += '<button type="button" data-action="remove" data-index="' + i + '" class="ms-btn" aria-label="Hapus aturan ' + (i + 1) + '">×</button>';
        html += '</div>';
      });
      elRules.innerHTML = html;
    }

    function renderPresets() {
      var presets = loadPresets(state.userId);
      var html = '<option value="">— pilih preset —</option>';
      presets.forEach(function (p, i) {
        html += '<option value="' + i + '">' + esc(p.name) + '</option>';
      });
      elPresetSelect.innerHTML = html;
    }

    function collectRules() {
      var out = [];
      var nodes = elRules.querySelectorAll('.ms-rule');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var field = n.querySelector('[data-role="field"]').value;
        var op = n.querySelector('[data-role="op"]').value;
        var rule = { field: field, op: op };
        if (op === 'between') {
          rule.value = [
            Number(n.querySelector('[data-role="value0"]').value),
            Number(n.querySelector('[data-role="value1"]').value)
          ];
        } else if (op !== 'is_null' && op !== 'not_null') {
          var vEl = n.querySelector('[data-role="value"]');
          rule.value = fieldDef(field).kind === 'enum' ? vEl.value : Number(vEl.value);
        }
        out.push(rule);
      }
      return out;
    }

    function renderResults(result) {
      if (!result || !result.matched) { elResults.innerHTML = ''; return; }
      var cols = ['ticker', 'price', 'change_pct', 'volume', 'rsi14', 'foreign_net', 'hsc_status'];
      var html = '<div class="ms-table-wrap" style="overflow:auto;max-height:420px">';
      html += '<table class="ms-table" style="width:100%;border-collapse:collapse;font-size:12px">';
      html += '<thead><tr>';
      cols.forEach(function (c) {
        html += '<th style="text-align:left;padding:6px;border-bottom:1px solid rgba(255,255,255,0.1);cursor:pointer" data-sort="' + c + '">' + esc(c) + '</th>';
      });
      html += '<th style="text-align:left;padding:6px;border-bottom:1px solid rgba(255,255,255,0.1)">alasan</th>';
      html += '</tr></thead><tbody>';
      result.matched.forEach(function (m) {
        html += '<tr>';
        cols.forEach(function (c) {
          var v = m.values ? m.values[c] : null;
          html += '<td style="padding:6px;border-bottom:1px solid rgba(255,255,255,0.05)">' + esc(v == null ? '—' : v) + '</td>';
        });
        html += '<td style="padding:6px;border-bottom:1px solid rgba(255,255,255,0.05);color:#94a3b8">' + esc(m.matched_rules_explanation) + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
      elResults.innerHTML = html;
    }

    // M-P1a: honest coverage counters (no silent truncation) + UNKNOWN bucket.
    function renderCoverage(data) {
      if (!data || !data.success) return;
      var parts = [
        'universe=' + data.total_universe,
        'scanned=' + (data.scanned != null ? data.scanned : data.total_universe),
        'stale=' + data.excluded_stale,
        'false=' + data.excluded_null,
        'unknown=' + (data.excluded_unknown != null ? data.excluded_unknown : 0),
        'synthetic=' + (data.excluded_synthetic != null ? data.excluded_synthetic : 0),
        data.universe_truncated === false ? '[full]' : '[TRUNCATED]'
      ];
      var cov = document.getElementById('msCoverage');
      if (cov) cov.textContent = parts.join(' · ');
      // Notify any host page listening for coverage updates.
      try {
        document.dispatchEvent(new CustomEvent('ac-manual-screener-result', { detail: data }));
      } catch (_) {}
    }

    function run() {
      var payload = {
        rules: { logic: state.logic, rules: collectRules() },
        limit: 50,
        sort: state.sort
      };
      elCount.textContent = 'Memuat…';
      fetch('/api/manual-screener', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (!data || !data.success) {
          elCount.textContent = 'Gagal: ' + ((data && data.error) || 'tidak diketahui');
          return;
        }
        state.lastResult = data;
        elCount.textContent = data.matched_count + ' cocok · ' + data.total_universe + ' universe · ' +
          data.excluded_null + ' false · ' + data.excluded_stale + ' stale · ' +
          (data.excluded_unknown != null ? data.excluded_unknown : 0) + ' unknown';
        elAsof.textContent = data.source_as_of ? ('per ' + data.source_as_of) : '';
        renderCoverage(data);
        renderResults(data);
      }).catch(function () {
        elCount.textContent = 'Gagal memuat';
      });
    }

    container.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var logic = t.getAttribute('data-logic');
      var action = t.getAttribute('data-action');
      if (logic) {
        state.logic = logic;
        container.querySelectorAll('[data-logic]').forEach(function (b) {
          var on = b.getAttribute('data-logic') === logic;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      } else if (action === 'add') {
        state.rules.push(newRule());
        renderRules();
      } else if (action === 'remove') {
        var idx = Number(t.getAttribute('data-index'));
        state.rules.splice(idx, 1);
        if (!state.rules.length) state.rules.push(newRule());
        renderRules();
      } else if (action === 'run') {
        run();
      } else if (action === 'clear') {
        state.rules = [newRule()];
        state.logic = 'AND';
        renderRules();
        elResults.innerHTML = '';
        elCount.textContent = '—';
        elAsof.textContent = '';
      } else if (action === 'savePreset') {
        var name = (elPresetName.value || '').trim();
        if (!name) return;
        var presets = loadPresets(state.userId);
        presets.push({ name: name, logic: state.logic, rules: collectRules() });
        savePresets(state.userId, presets);
        elPresetName.value = '';
        renderPresets();
      } else if (action === 'loadPreset') {
        var sel = elPresetSelect.value;
        if (sel === '') return;
        var list = loadPresets(state.userId);
        var p = list[Number(sel)];
        if (!p) return;
        state.logic = p.logic || 'AND';
        state.rules = (p.rules || []).map(function (r) { return Object.assign({}, r); });
        if (!state.rules.length) state.rules = [newRule()];
        renderRules();
      }
    });

    elRules.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var role = t.getAttribute('data-role');
      if (role === 'field' || role === 'op') {
        // Re-render so the value input matches the new field/op kind.
        state.rules = collectRules();
        renderRules();
      }
    });

    renderRules();
    renderPresets();

    return {
      version: VERSION,
      state: state,
      run: run,
      getRules: collectRules,
      setUserId: function (id) { state.userId = id; renderPresets(); }
    };
  }

  var api = { VERSION: VERSION, FIELDS: FIELDS, OPS: OPS, create: create, loadPresets: loadPresets, savePresets: savePresets };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.AutoCuanManualScreener = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
