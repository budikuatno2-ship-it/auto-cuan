/* Screener v2 detail summary (canvas Screener.dc.html, aside.pane).
   Builds the top of the detail pane: identity, price, trading plan ladder and
   levels, position size from the user's own capital/risk settings, gate
   evidence, actions. The full legacy detail stays below it under
   "Rincian lengkap". Values come from the row; nothing is computed that the
   old pane did not already show, except percentages to the levels. */
(function (root) {
  'use strict';
  var NIL = '<span class="nil" title="Tidak tersedia di sumber" aria-label="kosong">&mdash;</span>';

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function n(v) { var x = Number(v); return v != null && v !== '' && isFinite(x) ? x : null; }
  function px(v) { var x = n(v); return x != null && x > 0 ? x.toLocaleString('id-ID') : null; }
  function pct(to, from) { var a = n(to), b = n(from); if (!(a > 0) || !(b > 0)) return ''; var p = (a - b) / b * 100; return (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%'; }
  function rp(v) { var x = n(v); return x != null ? 'Rp ' + Math.round(x).toLocaleString('id-ID') : null; }

  function levels(r) {
    if (typeof root.normalizeDisplayLevels === 'function') {
      var l = root.normalizeDisplayLevels(r) || {};
      return { e1: n(l.e1), e2: n(l.e2), sl: n(l.sl), t1: n(l.t1), t2: n(l.t2), rr: n(l.rr) };
    }
    return { e1: n(r.entry1 || r.entry_high), e2: n(r.entry2 || r.entry_low), sl: n(r.stop_loss || r.sl), t1: n(r.tp1), t2: n(r.tp2), rr: n(r.risk_reward) };
  }

  // Price ladder: TP2, TP1, current, SL placed on one vertical scale (canvas .ladder).
  function ladderHtml(l, last) {
    var marks = [['TP2', l.t2, 'pos'], ['TP1', l.t1, 'pos'], ['Kini', last, 'now'], ['SL', l.sl, 'neg']].filter(function (m) { return n(m[1]) > 0; });
    if (marks.length < 3) return '';
    var vals = marks.map(function (m) { return Number(m[1]); });
    var hi = Math.max.apply(null, vals), lo = Math.min.apply(null, vals), span = hi - lo || 1;
    return '<div class="scr-ladder" aria-hidden="true">' + marks.map(function (m) {
      var top = 8 + (hi - Number(m[1])) / span * 84;
      return '<div class="is-' + m[2] + '" style="top:' + top.toFixed(1) + '%"><span class="num mono">' + px(m[1]) + '</span><i></i><span>' + m[0] + '</span></div>';
    }).join('') + '</div>';
  }

  function kv(label, value, cls) { return '<div class="kv"><span>' + label + '</span><span class="num' + (cls ? ' ' + cls : '') + '">' + (value == null || value === '' ? NIL : value) + '</span></div>'; }

  function positionHtml(r) {
    var PS = root.PositionSizing;
    if (!PS || typeof PS.calculatePosition !== 'function') return '';
    var s = PS.getSettings ? PS.getSettings() : null;
    var p = PS.calculatePosition(r) || {};
    var head = '<div class="ph2">Ukuran posisi' + (s ? ' <span class="mut">· modal ' + esc(PS.fmtRpCompact ? PS.fmtRpCompact(s.capital) : rp(s.capital)) + ', risiko ' + esc(String(s.riskPct).replace('.', ',')) + '%</span>' : '') + '</div>';
    if (!p.isValid) return head + '<p class="scr-help">' + esc(p.reason || 'Level rencana belum lengkap untuk menghitung ukuran posisi.') + '</p>';
    return head +
      kv('Risiko per lot', rp(p.riskPerLotKini != null ? p.riskPerLotKini : p.riskPerLot), 'mono') +
      kv('Ukuran maksimal', p.lots != null ? esc(p.lots.toLocaleString('id-ID') + ' lot (' + (p.lots * 100).toLocaleString('id-ID') + ' lembar)') : null) +
      kv('Modal dibutuhkan', rp(p.positionValue), 'mono') +
      kv('Potensi di TP1', p.profitTp1Idr > 0 ? rp(p.profitTp1Idr) : null, 'mono pos');
  }

  function gatesHtml(r, type) {
    var G = root.SignalGateTransparency;
    if (!G || typeof G.evaluateGates !== 'function') return '';
    var ev = G.evaluateGates(r, type) || {};
    var list = ev.gates || [];
    if (!list.length) return '';
    return '<div class="ph2">Bukti gate <span class="mut">· ' + (ev.passedCount || 0) + ' dari ' + (ev.totalCount || list.length) + ' terpenuhi</span></div>' + list.map(function (g) {
      var icon = g.passed === true
        ? '<span class="gi y"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg></span>'
        : '<span class="gi ' + (g.passed === false ? 'x' : 'n') + '" aria-hidden="true">' + (g.passed === false ? '×' : '?') + '</span>';
      var state = g.passed === true ? 'terpenuhi' : (g.passed === false ? 'belum terpenuhi' : 'belum terverifikasi');
      var detail = [g.actual, g.threshold ? 'batas ' + g.threshold : ''].filter(Boolean).join(' · ');
      return '<div class="gate">' + icon + '<div><b>' + esc(g.title) + '</b> <span class="sr-only">' + state + '</span><div class="mut">' + esc(detail || g.note || '') + '</div></div></div>';
    }).join('');
  }

  function summaryHtml(r, type) {
    if (!r) return '';
    var l = levels(r);
    var last = n(r.last_price != null ? r.last_price : (r.current_price != null ? r.current_price : r.close));
    var isDt = type === 'daytrade';
    var tier = isDt ? (typeof root.formatDtStatus === 'function' ? root.formatDtStatus(r.status) : r.status) : (typeof root.swingTierShort === 'function' ? root.swingTierShort(r.swing_tier) : r.swing_tier);
    var exec = r.confidence || (typeof root.getSignalQualityGrade === 'function' ? root.getSignalQualityGrade(r) : '');
    var score = isDt ? (r.daytrade_score != null ? r.daytrade_score : r.score) : r.score;
    var name = r.company_name || r.stock_name || (r.group_code ? 'Grup ' + r.group_code : '');
    var chg = n(r.change_pct);
    var starred = !!(root.__AUTOCUAN_WATCHLIST_SET__ && root.__AUTOCUAN_WATCHLIST_SET__.has(r.ticker));
    var minRr = isDt ? 1.2 : 1.5;
    var entry = (l.e1 && l.e2 && l.e1 !== l.e2) ? px(Math.min(l.e1, l.e2)) + ' – ' + px(Math.max(l.e1, l.e2)) : px(l.e1 || l.e2);
    var t = esc(r.ticker);
    var tJs = esc(String(r.ticker || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"));

    var html = '<div class="scr-sum" data-ac-ui="v2">';
    html += '<div class="scr-sum-head"><div><div class="scr-sum-id"><span class="tk mono">' + t + '</span>' + (tier || exec ? '<span class="chip b">' + esc([tier, exec ? 'Exec ' + exec : ''].filter(Boolean).join(' · ')) + '</span>' : '') + '</div>' + (name ? '<div class="mut scr-sum-name">' + esc(name) + '</div>' : '') + '</div>';
    html += '<button type="button" class="vbtn sm wl-star-btn scr-star' + (starred ? ' active on-star' : '') + '" data-ticker="' + t + '" aria-pressed="' + starred + '" aria-label="' + (starred ? 'Hapus ' + t + ' dari Watchlist' : 'Simpan ' + t + ' ke Watchlist') + '" title="Simpan ke Watchlist" onclick="window.toggleWatchlistTicker(\'' + tJs + '\', null, event)"><svg width="15" height="15" viewBox="0 0 24 24" fill="' + (starred ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg></button></div>';
    html += '<div class="scr-sum-px"><span class="num mono">' + (px(last) ? 'Rp ' + px(last) : NIL) + '</span>' + (chg != null ? '<span class="num ' + (chg > 0 ? 'pos' : chg < 0 ? 'neg' : 'mut') + '">' + (chg > 0 ? '+' : chg < 0 ? '−' : '') + Math.abs(chg).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%</span>' : '') + '<span class="mut num scr-sum-score">Skor <b>' + (score != null ? esc(score) : '—') + '</b></span></div>';

    html += '<div class="ph2">Rencana trading <span class="mut">· basis harga terakhir</span></div>';
    html += ladderHtml(l, last);
    html += kv('Area entry', entry, 'mono');
    html += kv('Stop loss', px(l.sl) ? px(l.sl) + (pct(l.sl, last) ? ' <span class="scr-pct">(' + pct(l.sl, last) + ')</span>' : '') : null, 'mono neg');
    html += kv('Target 1', px(l.t1) ? px(l.t1) + (pct(l.t1, last) ? ' <span class="scr-pct">(' + pct(l.t1, last) + ')</span>' : '') : null, 'mono pos');
    html += kv('Target 2', px(l.t2), 'mono pos');
    html += kv('Risk / Reward', l.rr != null ? '1 : ' + l.rr.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null, 'scr-strong');
    if (l.rr != null && l.rr < minRr) html += '<p class="scr-help warn-t">R/R di bawah batas minimum 1 : ' + String(minRr).replace('.', ',') + '. Tinjau ulang sebelum entry.</p>';

    html += positionHtml(r);
    html += gatesHtml(r, type);

    html += '<a class="vbtn p scr-open" href="/analisis-saham?ticker=' + encodeURIComponent(r.ticker) + '" onclick="if(typeof closeScrDetail===\'function\')closeScrDetail();if(typeof quickAnalisis===\'function\'){quickAnalisis(\'' + tJs + '\');return false;}">Buka Chart &amp; Analisis</a>';
    html += '<button type="button" class="vbtn scr-open-ws" onclick="openScreenerInChartWorkstation(\'' + tJs + '\',\'' + esc(type) + '\')">Buka di Chart Workstation</button>';
    html += '<p class="scr-disclaimer">Bukan rekomendasi. Konfirmasi manual wajib sebelum eksekusi.</p>';
    html += '</div>';
    return html;
  }

  /* ---------- Sort and column density (canvas "Urutkan" and "Kolom") ----------
     Sorting is display only: the screener's own order ("Bawaan", tier then
     quality) stays the default; Skor and Perubahan sort the filtered rows,
     rows without the value go last. "Ringkas" hides the wide columns. */
  var view = { sort: 'default', compact: false };
  try { var saved = JSON.parse(root.localStorage.getItem('ac-scr-view') || '{}'); if (saved.sort) view.sort = saved.sort; view.compact = saved.compact === true; } catch (_) {}
  var SORTS = ['default', 'score', 'chg'];
  var SORT_LABEL = { default: 'Bawaan', score: 'Skor ↓', chg: 'Perubahan ↓' };
  function persist() { try { root.localStorage.setItem('ac-scr-view', JSON.stringify(view)); } catch (_) {} }
  function num(v) { var x = Number(v); return v != null && v !== '' && isFinite(x) ? x : null; }
  function scoreOf(r, type) {
    if (type === 'daytrade') return num(r.daytrade_score != null ? r.daytrade_score : (r.score != null ? r.score : (r.unified_score != null ? r.unified_score : r.setup_score)));
    return num(r.score);
  }
  function sortRows(rows, type) {
    if (!Array.isArray(rows) || view.sort === 'default') return rows;
    var key = view.sort === 'chg' ? function (r) { return num(r.change_pct); } : function (r) { return scoreOf(r, type); };
    return rows.map(function (r, i) { return { r: r, i: i, k: key(r) }; }).sort(function (a, b) {
      if ((a.k == null) !== (b.k == null)) return a.k == null ? 1 : -1;
      if (a.k != null && a.k !== b.k) return b.k - a.k;
      return a.i - b.i;
    }).map(function (o) { return o.r; });
  }
  function currentType() { return root._currentScreenerType || 'konglo'; }
  function syncControls() {
    var doc = root.document;
    Array.prototype.forEach.call(doc.querySelectorAll('[data-scr-sort]'), function (b) {
      b.textContent = 'Urutkan: ' + SORT_LABEL[view.sort];
      b.setAttribute('aria-label', 'Urutan tabel: ' + SORT_LABEL[view.sort] + '. Ketuk untuk mengganti');
    });
    Array.prototype.forEach.call(doc.querySelectorAll('[data-scr-cols]'), function (b) {
      b.textContent = 'Kolom: ' + (view.compact ? 'Ringkas' : 'Lengkap');
      b.setAttribute('aria-pressed', String(view.compact));
    });
    var page = doc.getElementById('page-screener');
    if (page) page.classList.toggle('scr-compact', view.compact);
  }
  function rerender() { if (typeof root.applyScreenerUiFilters === 'function') root.applyScreenerUiFilters(currentType()); }
  function setSort(s) { if (SORT_LABEL[s] == null) return; view.sort = s; persist(); syncControls(); rerender(); }
  function cycleSort() { setSort(SORTS[(SORTS.indexOf(view.sort) + 1) % SORTS.length]); }
  // Docked detail pane: from 1280 px; with compact columns also below that,
  // as long as the 502 px compact table still fits beside the 360 px pane
  // (measured on the canvas rows). Below 1024 px it never fits.
  var DOCK_FULL = 1280, DOCK_COMPACT = 1024, PANE_W = 360, COMPACT_TABLE_W = 502;
  function splitWidth() {
    var list = root.document ? root.document.querySelectorAll('#page-screener .ac-split-view') : [];
    for (var i = 0; i < list.length; i++) { var w = list[i].getBoundingClientRect().width; if (w > 0) return w; }
    return 0;
  }
  function isDocked() {
    var w = root.innerWidth || 0, on = w >= DOCK_FULL;
    if (!on && view.compact && w >= DOCK_COMPACT) on = splitWidth() - PANE_W >= COMPACT_TABLE_W;
    var page = root.document && root.document.getElementById('page-screener');
    if (page) page.classList.toggle('scr-dock', on && w < DOCK_FULL);
    return on;
  }
  function setCompact(on) { view.compact = Boolean(on); persist(); syncControls(); isDocked(); }
  function syncModeSlots(type) {
    var doc = root.document;
    if (!doc) return;
    var prefix = type === 'daytrade' ? 'dt' : (type === 'nonkonglo' ? 'nk' : 'kg');
    var rrLabel = doc.querySelector('#page-screener .scr-rr-min');
    var rrSlot = doc.getElementById(prefix + 'RrSlot');
    if (rrLabel && rrSlot && rrLabel.parentNode !== rrSlot) rrSlot.appendChild(rrLabel);
    var sharedAdv = doc.getElementById('scrSharedAdv');
    var advSlot = doc.getElementById(prefix + 'SharedAdvSlot');
    if (sharedAdv && advSlot && sharedAdv.parentNode !== advSlot) advSlot.appendChild(sharedAdv);
  }
  if (typeof root.addEventListener === 'function') {
    var dockRaf = 0;
    root.addEventListener('resize', function () { if (dockRaf) return; dockRaf = root.requestAnimationFrame(function () { dockRaf = 0; isDocked(); }); });
  }
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', syncControls); else syncControls();
    if (typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var openAdv = root.document.querySelector('#page-screener details.scr-adv[open]');
        if (!openAdv) return;
        var modal = root.document.getElementById('scrDetailModal');
        if (modal && !modal.classList.contains('hidden')) return;
        e.preventDefault();
        openAdv.open = false;
        var sum = openAdv.querySelector('summary');
        if (sum && typeof sum.focus === 'function') sum.focus({ preventScroll: true });
      });
    }
  }

  root.AutoCuanScreenerV2 = {
    summaryHtml: summaryHtml, sortRows: sortRows, setSort: setSort, cycleSort: cycleSort,
    setCompact: setCompact, isDocked: isDocked, DOCK_FULL: DOCK_FULL, DOCK_COMPACT: DOCK_COMPACT, toggleCompact: function () { setCompact(!view.compact); }, syncModeSlots: syncModeSlots, view: view, SORT_LABEL: SORT_LABEL
  };
})(window);
