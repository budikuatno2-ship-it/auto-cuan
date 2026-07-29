(function (root) {
  'use strict';
  if (!root || !root.document || root.__AUTOCUAN_PORTFOLIO_RUNTIME_FIX__) return;
  root.__AUTOCUAN_PORTFOLIO_RUNTIME_FIX__ = '20260728-portfolio-runtime-fix-v1';
  var doc = root.document;

  function normalizeTicker(value) {
    var ticker = String(value == null ? '' : value).trim().toUpperCase().replace(/\.JK$/, '');
    return /^[A-Z]{3,5}$/.test(ticker) ? ticker : '';
  }
  function safeParse(value, fallback) {
    try { var parsed = JSON.parse(value); return parsed == null ? fallback : parsed; }
    catch (_) { return fallback; }
  }
  function uid() {
    try { return root.localStorage.getItem('autocuan_user_id') || ''; }
    catch (_) { return ''; }
  }
  function plansKey(userId) { return 'autocuan_portfolio_plans_' + userId; }
  function pricesKey(userId) { return 'autocuan_portfolio_prices_' + userId; }
  function hash(value) {
    var text = String(value == null ? '' : value), result = 2166136261;
    for (var i = 0; i < text.length; i += 1) { result ^= text.charCodeAt(i); result = Math.imul(result, 16777619); }
    return (result >>> 0).toString(36);
  }
  function stableLegacyId(plan, index, used) {
    var ticker = normalizeTicker(plan && plan.ticker) || 'PLAN';
    var base = 'legacy_' + ticker + '_' + hash([plan && plan.createdAt, plan && plan.entryPriceIdr, plan && plan.lots, plan && plan.stopLossIdr, index].join('|'));
    var id = base, suffix = 1;
    while (used[id]) { id = base + '_' + suffix; suffix += 1; }
    used[id] = true;
    return id;
  }
  function migrateLegacyPlans() {
    var userId = uid();
    if (!userId) return false;
    var key = plansKey(userId);
    var plans;
    try { plans = safeParse(root.localStorage.getItem(key), []); } catch (_) { return false; }
    if (!Array.isArray(plans)) return false;
    var used = Object.create(null), changed = false;
    plans.forEach(function (plan) { if (plan && plan.id) used[String(plan.id)] = true; });
    plans = plans.map(function (plan, index) {
      if (!plan || typeof plan !== 'object') return plan;
      if (plan.id != null && String(plan.id).trim()) return plan;
      changed = true;
      return Object.assign({}, plan, { id:stableLegacyId(plan, index, used) });
    });
    if (!changed) return false;
    try { root.localStorage.setItem(key, JSON.stringify(plans)); return true; }
    catch (_) { return false; }
  }
  function toast(message, tone) {
    var host = doc.getElementById('toastHost');
    if (!host) return;
    Array.prototype.forEach.call(host.querySelectorAll('[data-portfolio-fix-toast]'), function (node) { node.remove(); });
    var node = doc.createElement('div');
    node.className = 'toast' + (tone ? ' ' + tone : '');
    node.setAttribute('data-portfolio-fix-toast', '1');
    node.textContent = message;
    host.appendChild(node);
    root.setTimeout(function () { if (node.parentNode) node.remove(); }, 2600);
  }
  function planTickerFromButton(button) {
    var container = button.closest('tr,.position-card,.journal-item,.drawer-section');
    var tickerNode = container && container.querySelector('[data-open-ticker],.ticker-link');
    return normalizeTicker(tickerNode && (tickerNode.getAttribute('data-open-ticker') || tickerNode.textContent));
  }
  function deletePlan(button) {
    var userId = uid();
    if (!userId) { toast('Sesi Portfolio belum siap.', 'danger'); return; }
    var key = plansKey(userId);
    var plans;
    try { plans = safeParse(root.localStorage.getItem(key), []); }
    catch (_) { plans = []; }
    if (!Array.isArray(plans)) plans = [];
    var requestedId = String(button.getAttribute('data-delete-plan') || '');
    var requestedTicker = planTickerFromButton(button) || normalizeTicker(requestedId);
    var removed = null;
    var next = [];
    plans.forEach(function (plan) {
      var planId = String(plan && plan.id != null ? plan.id : '');
      var planTicker = normalizeTicker(plan && plan.ticker);
      var exactId = requestedId && planId === requestedId;
      var legacyFallback = !planId && requestedTicker && planTicker === requestedTicker;
      if (!removed && (exactId || legacyFallback)) { removed = plan; return; }
      next.push(plan);
    });
    if (!removed) {
      migrateLegacyPlans();
      try { plans = safeParse(root.localStorage.getItem(key), []); } catch (_) { plans = []; }
      next = []; removed = null;
      plans.forEach(function (plan) {
        var planId = String(plan && plan.id != null ? plan.id : '');
        var planTicker = normalizeTicker(plan && plan.ticker);
        if (!removed && ((requestedId && planId === requestedId) || (requestedTicker && planTicker === requestedTicker))) { removed = plan; return; }
        next.push(plan);
      });
    }
    if (!removed) { toast('Posisi tidak ditemukan. Muat ulang halaman lalu coba lagi.', 'danger'); return; }
    try {
      root.localStorage.setItem(key, JSON.stringify(next));
      var removedTicker = normalizeTicker(removed.ticker) || requestedTicker || 'Posisi';
      if (removedTicker && !next.some(function (plan) { return normalizeTicker(plan && plan.ticker) === removedTicker; })) {
        var priceKey = pricesKey(userId);
        var prices = safeParse(root.localStorage.getItem(priceKey), {});
        if (prices && typeof prices === 'object' && !Array.isArray(prices) && Object.prototype.hasOwnProperty.call(prices, removedTicker)) {
          delete prices[removedTicker];
          root.localStorage.setItem(priceKey, JSON.stringify(prices));
        }
      }
      root.dispatchEvent(new Event('focus'));
      toast(removedTicker + ' berhasil dihapus.', 'good');
    } catch (_) { toast('Gagal menyimpan penghapusan di browser.', 'danger'); }
  }

  doc.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('[data-delete-plan]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    deletePlan(button);
  }, true);

  new MutationObserver(function (records) {
    records.forEach(function (record) {
      Array.prototype.forEach.call(record.addedNodes || [], function (node) {
        if (node.nodeType !== 1) return;
        var candidates = [];
        if (node.matches && node.matches('.toast')) candidates.push(node);
        if (node.querySelectorAll) Array.prototype.push.apply(candidates, node.querySelectorAll('.toast'));
        candidates.forEach(function (item) {
          if (/^0\s+perubahan\s+dicatat\.?$/i.test(String(item.textContent || '').trim())) item.remove();
        });
      });
    });
  }).observe(doc.body, { childList:true, subtree:true });

  var attempts = 0;
  (function migrateWhenReady() {
    attempts += 1;
    if (migrateLegacyPlans()) {
      root.setTimeout(function () { root.dispatchEvent(new Event('focus')); }, 50);
      return;
    }
    if (!uid() && attempts < 120) root.setTimeout(migrateWhenReady, 100);
  })();
})(typeof window !== 'undefined' ? window : null);
