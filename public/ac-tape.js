/* Price tape under the top bar (HANDOFF §4a, canvas motion.js "ticker tape").
   Data: /api/sector-hot?action=tape (last completed session). Moves with a
   transform at about 45 px/s, stops on hover/focus, has a pause button that is
   remembered, and stays still under prefers-reduced-motion. Clicking an item
   opens Analisis for that ticker. Desktop on every app page; on phones only on
   the Dashboard (canvas Mobile). */
(function (root) {
  'use strict';
  var doc = root.document;
  var KEY = 'ac-tape-paused';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  var data = null, loading = null, lastLoad = 0;

  function store(k, v) { try { if (v === undefined) return root.localStorage.getItem(k); root.localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function px(n, idx) { return Number(n).toLocaleString('id-ID', idx ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 }); }
  function chg(c) { return (c > 0 ? '+' : c < 0 ? '−' : '') + Math.abs(c).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%'; }
  function dateLabel(key) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || '')); return m ? Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] : ''; }
  function paused() { return store(KEY) === '1'; }

  function item(x, isIdx) {
    var c = x.change_pct > 0 ? 'pos' : x.change_pct < 0 ? 'neg' : 'flat';
    var arrow = x.change_pct > 0 ? '▲ ' : x.change_pct < 0 ? '▼ ' : '';
    return '<a class="tp' + (isIdx ? ' idx' : '') + '" href="/analisis-saham?ticker=' + encodeURIComponent(x.ticker) + '" data-ticker="' + esc(x.ticker) + '" aria-label="' + esc(x.ticker + ' ' + px(x.close, isIdx) + ', ' + chg(x.change_pct)) + '">' +
      '<b>' + esc(x.ticker) + '</b><span class="px">' + px(x.close, isIdx) + '</span><span class="ch ' + c + '">' + arrow + chg(x.change_pct) + '</span></a>';
  }
  function itemsHtml(d) {
    return (d.ihsg ? item(d.ihsg, true) : '') + d.items.map(function (x) { return item(x, false); }).join('');
  }

  function fill(el) {
    if (!data || !data.success || !data.data_available) { el.hidden = true; return; }
    var p = paused();
    var once = itemsHtml(data);
    el.innerHTML = '<span class="tape-l"><small>Penutupan ' + esc(dateLabel(data.as_of_date)) + '</small></span>' +
      '<div class="tape-v"><div class="tape-in">' + once + '<span aria-hidden="true" style="display:contents">' + once.replace(/<a /g, '<a tabindex="-1" ') + '</span></div></div>' +
      '<button class="tape-x" type="button" aria-pressed="' + p + '" aria-label="' + (p ? 'Jalankan strip harga' : 'Jeda strip harga') + '" title="' + (p ? 'Jalankan' : 'Jeda') + '">' + (p ? '▶' : '❚❚') + '</button>';
    el.classList.toggle('paused', p);
    el.hidden = false;
    var inner = el.querySelector('.tape-in');
    root.requestAnimationFrame(function () { inner.style.setProperty('--tape-dur', Math.max(30, Math.round(inner.scrollWidth / 2 / 45)) + 's'); });
  }

  function onClick(e) {
    var el = e.currentTarget;
    var btn = e.target.closest('.tape-x');
    if (btn) { store(KEY, paused() ? '0' : '1'); fill(el); return; }
    var a = e.target.closest('a.tp');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
    if (typeof root.quickAnalisis === 'function') { e.preventDefault(); root.quickAnalisis(a.getAttribute('data-ticker')); }
  }

  function load() {
    var el = doc.getElementById('acTape');
    if (!el) return null;
    if (data && Date.now() - lastLoad < 60000) { if (!el.querySelector('.tape-in')) fill(el); return null; }
    if (loading) return loading;
    loading = fetch('/api/sector-hot?action=tape').then(function (r) { return r.json(); })
      .then(function (d) { data = d; lastLoad = Date.now(); fill(el); })
      .catch(function () { el.hidden = true; })
      .then(function () { loading = null; });
    return loading;
  }

  function init() {
    var el = doc.getElementById('acTape');
    if (!el || el.__acTape) return;
    el.__acTape = true;
    el.addEventListener('click', onClick);
    load();
    // Refresh once a minute while the tab is visible; the server caches 60 s.
    root.setInterval(function () { if (!doc.hidden) load(); }, 60000);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
  root.AutoCuanTape = { load: load, init: init };
})(window);
