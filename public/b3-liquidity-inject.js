(function (root) {
  var CACHE = {};
  // B3: badge likuiditas dihitung dari data baris screener yang SUDAH ada
  // (avg_tx_value_7d/20d), tanpa fetch /api/candles tambahan per baris.
  // Ini menghilangkan ratusan request paralel yang memicu 429 nginx (10r/s)
  // saat tabel me-render — badge tetap akurat karena memakai nilai transaksi
  // yang sama dengan mesin screener. Fallback fetch hanya untuk header chart
  // (1 ticker) dengan antrean 1 worker + jeda 500ms.
  var QUEUE = [];
  var ACTIVE = 0;
  var MAX_WORKERS = 1;
  var GAP_MS = 500;
  function pump() {
    while (ACTIVE < MAX_WORKERS && QUEUE.length) {
      var job = QUEUE.shift();
      ACTIVE++;
      (function (j) {
        fetch("/api/candles?ticker=" + encodeURIComponent(j.ticker))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            var candles = (d && (d.candles || d.data || d.rows)) || [];
            var liq = computeLiquidity(candles);
            settle(j.ticker, liq);
          })
          .catch(function () { settle(j.ticker, null); })
          .finally(function () { setTimeout(function () { ACTIVE--; pump(); }, GAP_MS); });
      })(job);
    }
  }
  function median(vals) {
    if (!vals.length) return 0;
    var s = vals.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    if (s.length % 2) return s[m];
    return (s[m - 1] + s[m]) / 2;
  }
  function computeLiquidity(candles) {
    var vals = [];
    var use = candles.slice(-20);
    for (var i = 0; i < use.length; i++) {
      var c = use[i];
      var close = Number(c.close);
      var vol = Number(c.volume || 0);
      if (!(close > 0)) continue;
      var v = (c.value != null && Number(c.value) > 0) ? Number(c.value) : vol * close;
      vals.push(v);
    }
    var med = median(vals);
    var tier = med >= 5000000000 ? "LIKUID" : (med >= 100000000 ? "NON_LIKUID" : "ILLIQUID");
    var tip = "Median 20H: " + (root.B3LiquidityBadge ? root.B3LiquidityBadge.fmtRp(med) : med);
    return { tier: tier, medianValue20d: Math.round(med), tooltip: tip };
  }
  function badgeHtml(liq) {
    if (root.B3LiquidityBadge) return root.B3LiquidityBadge.badgeHtml(liq);
    var t = liq.tier === "LIKUID" ? "Likuid" : (liq.tier === "NON_LIKUID" ? "Non-Likuid" : "-");
    return "<span class=\"b3-liq\">" + t + "</span>";
  }
  function liqFromRow(row) {
    if (!row || typeof row !== "object") return null;
    var v7 = Number(row.avg_tx_value_7d);
    var v20 = Number(row.avg_tx_value_20d);
    var v1 = Number(row.tx_value_1d);
    var med = v7 > 0 ? v7 : (v20 > 0 ? v20 : (v1 > 0 ? v1 : 0));
    if (!(med > 0)) return null;
    var tier = med >= 5000000000 ? "LIKUID" : (med >= 100000000 ? "NON_LIKUID" : "ILLIQUID");
    var tip = "Median 7H: " + (root.B3LiquidityBadge ? root.B3LiquidityBadge.fmtRp(med) : med);
    return { tier: tier, medianValue20d: Math.round(med), tooltip: tip };
  }
  function rowForTicker(ticker) {
    try {
      var cands = [
        (typeof _screenerCache !== "undefined" && _screenerCache && _screenerCache.results) || null,
        (typeof _nkScreenerCache !== "undefined" && _nkScreenerCache && _nkScreenerCache.results) || null,
        (typeof _dtScreenerCache !== "undefined" && _dtScreenerCache && (_dtScreenerCache.results || _dtScreenerCache.data)) || null,
        (typeof _kgCardData !== "undefined" && _kgCardData) || null
      ];
      for (var k = 0; k < cands.length; k++) {
        var c = cands[k];
        if (!c) continue;
        if (Array.isArray(c)) {
          for (var i = 0; i < c.length; i++) {
            if (c[i] && String(c[i].ticker || "").toUpperCase() === ticker) return c[i];
          }
        } else if (typeof c === "object" && c[ticker]) {
          return c[ticker];
        }
      }
    } catch (_) {}
    return null;
  }
  function ensureBadgeInRow(tr, ticker) {
    if (!tr || tr.querySelector(".b3-liq")) return;
    var t = String(ticker || "").toUpperCase();
    if (!t) return;
    var cell = tr.querySelector("td");
    if (!cell) return;
    var row = rowForTicker(t);
    var liq = liqFromRow(row);
    var span = document.createElement("span");
    if (liq) {
      span.className = "b3-liq";
      span.innerHTML = badgeHtml(liq);
      span.setAttribute("data-b3-ticker", t);
      cell.appendChild(span);
      return;
    }
    span.className = "b3-liq b3-liq--unknown";
    span.textContent = "...";
    span.setAttribute("data-b3-ticker", t);
    cell.appendChild(span);
  }
  var INFLIGHT = {};
  function loadFor(ticker, el) {
    if (CACHE[ticker]) { paint(el, CACHE[ticker]); return; }
    if (INFLIGHT[ticker]) { INFLIGHT[ticker].push(el); return; }
    INFLIGHT[ticker] = [el];
    QUEUE.push({ ticker: ticker });
    pump();
  }
  function settle(ticker, liq) {
    var els = INFLIGHT[ticker] || [];
    delete INFLIGHT[ticker];
    if (liq) CACHE[ticker] = liq;
    for (var i = 0; i < els.length; i++) {
      if (liq) paint(els[i], liq);
    }
  }
  function paint(el, liq) {
    if (!el || !el.isConnected) return;
    var tmp = document.createElement("span");
    tmp.innerHTML = badgeHtml(liq);
    var b = tmp.firstChild;
    if (b) el.replaceWith(b);
  }
  function scanTables() {
    var ids = ["screenerTableBody", "nkScreenerTableBody", "dtScreenerTableBody"];
    for (var k = 0; k < ids.length; k++) {
      var tb = document.getElementById(ids[k]);
      if (!tb) continue;
      var rows = tb.querySelectorAll("tr[data-ticker]");
      for (var i = 0; i < rows.length; i++) {
        ensureBadgeInRow(rows[i], rows[i].getAttribute("data-ticker"));
      }
    }
  }
  function scanHeader() {
    var badge = document.getElementById("unifiedActiveTickerBadge");
    if (!badge) return;
    if (badge.parentNode && badge.parentNode.querySelector(".b3-liq-head")) return;
    var t = String(badge.textContent || "").trim().toUpperCase();
    if (!t) return;
    var wrap = document.createElement("span");
    wrap.className = "b3-liq-head";
    wrap.setAttribute("data-ticker", t);
    wrap.innerHTML = "<span class=\"b3-liq b3-liq--unknown\">...</span>";
    badge.parentNode.insertBefore(wrap, badge.nextSibling);
    loadFor(t, wrap.firstChild);
  }
  function scan() { try { scanTables(); } catch (e) {} try { scanHeader(); } catch (e2) {} }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
  try {
    var mo = new MutationObserver(function () { scan(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  root.B3LiquidityInject = { scan: scan };
})(typeof window !== "undefined" ? window : globalThis);
