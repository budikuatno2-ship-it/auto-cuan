/* Dashboard v2 market sheet (canvas Main.dc.html "Kondisi pasar").
   Fills the IHSG, breadth and session cells and the provenance row from the
   existing endpoints. Nothing is invented: a missing value stays "—". */
(function (root) {
  'use strict';
  var doc = root.document;
  var NIL = '<span class="nil" title="Tidak tersedia di sumber" aria-label="kosong">&mdash;</span>';
  var MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  var SECTORS = {
    'Energy': 'Energi', 'Non-Cyclical': 'Barang primer', 'Cyclical': 'Barang non-primer', 'Finance': 'Keuangan',
    'Infrastrucures': 'Infrastruktur', 'Infrastructures': 'Infrastruktur', 'Property': 'Properti', 'Basic Mat': 'Barang baku',
    'Transport': 'Transportasi', 'Industrial': 'Perindustrian', 'Technology': 'Teknologi', 'Health': 'Kesehatan'
  };
  var $ = function (id) { return doc.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var num = function (v, d) { return Number(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }); };

  function wibParts(date) {
    var p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
    var dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
    return { key: p.year + '-' + p.month + '-' + p.day, dow: dow, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
  }
  function longDate(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
    return m ? Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1] : '';
  }
  function shortDate(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
    return m ? Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1].slice(0, 3) + ' ' + m[1] : '';
  }

  // Greeting kicker: today's date in WIB (the page header, not a data stamp).
  function renderKick(now) {
    var el = $('dashKickDate');
    if (!el) return;
    el.textContent = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now || new Date());
  }

  // IDX schedule. Phases: pre-opening, session 1, break, session 2, post-closing.
  function sessionOf(now, calendar) {
    var w = wibParts(now);
    if (w.dow === 0 || w.dow === 6) return { name: 'Bursa tutup', note: 'Akhir pekan', idx: -1 };
    if (calendar && calendar.date === w.key && calendar.is_trading_day === false) return { name: 'Bursa tutup', note: 'Hari libur bursa', idx: -1 };
    var fri = w.dow === 5, t = w.minutes;
    var s1End = fri ? 690 : 720, s2Start = fri ? 840 : 810;
    var bounds = [[525, 540, 'Pra-pembukaan'], [540, s1End, 'Sesi 1'], [s1End, s2Start, 'Istirahat'], [s2Start, 950, 'Sesi 2'], [950, 975, 'Pasca-penutupan']];
    for (var i = 0; i < bounds.length; i++) if (t >= bounds[i][0] && t < bounds[i][1]) return { name: bounds[i][2], note: '', idx: i };
    return t < 525 ? { name: 'Belum dibuka', note: 'Pra-pembukaan 08.45 WIB', idx: -1, before: true } : { name: 'Bursa tutup', note: 'Sesi hari ini selesai', idx: 5 };
  }
  function renderSession(calendar, breadth) {
    var s = sessionOf(new Date(), calendar);
    var name = $('dashSessionName'), bar = $('dashSessionBar'), note = $('dashSessionNote');
    if (name) name.textContent = s.name;
    if (bar) Array.prototype.forEach.call(bar.children, function (cell, i) {
      cell.className = s.idx < 0 ? '' : (i < s.idx ? 'done' : (i === s.idx ? 'cur' : ''));
    });
    if (!note) return;
    var strongest = strongestSector(breadth);
    note.textContent = s.note && !strongest ? s.note : (strongest ? 'Sektor terkuat: ' + strongest : s.note);
  }
  // From the breadth payload: the sector with the largest share of rising
  // stocks (at least 10 members, at least one riser). No sector, no claim.
  function strongestSector(b) {
    if (!b || !b.sectorCounts) return '';
    var best = null;
    Object.keys(b.sectorCounts).forEach(function (k) {
      var c = b.sectorCounts[k];
      if (!c || !(c.total >= 10) || !(c.gainers > 0)) return;
      var share = c.gainers / c.total;
      if (!best || share > best.share) best = { name: SECTORS[k] || k, share: share, c: c };
    });
    return best ? best.name + ' (' + best.c.gainers + ' dari ' + best.c.total + ' naik)' : '';
  }

  function renderBreadth(b) {
    var counts = $('dashBreadthCounts'), bar = $('dashBreadthBar'), sub = $('dashBreadthSub'), prov = $('dashProvDate');
    var ok = b && b.success && b.data_available !== false && b.gainers != null;
    if (prov) prov.innerHTML = ok && b.asOfDate ? esc(shortDate(b.asOfDate)) : NIL;
    if (!ok) {
      if (counts) counts.innerHTML = NIL;
      if (bar) bar.hidden = true;
      if (sub) sub.textContent = b && b.data_available === false ? 'Data pasar belum tersedia' : '';
      return;
    }
    if (counts) counts.innerHTML = '<span class="pos">' + num(b.gainers, 0) + ' naik</span><span class="neg">' + num(b.losers, 0) + ' turun</span><span class="mut">' + num(b.unchanged, 0) + ' flat</span>';
    if (bar) {
      var parts = { up: b.gainers, flat: b.unchanged, down: b.losers };
      Object.keys(parts).forEach(function (k) { var i = bar.querySelector('[data-part="' + k + '"]'); if (i) i.style.flex = Math.max(0, Number(parts[k]) || 0) + ' 1 0%'; });
      bar.setAttribute('aria-label', num(b.gainers, 0) + ' naik, ' + num(b.unchanged, 0) + ' flat, ' + num(b.losers, 0) + ' turun');
      bar.hidden = false;
    }
    if (sub) {
      var bits = [];
      if (b.totalTurnoverDisplay) bits.push('Nilai transaksi ' + b.totalTurnoverDisplay);
      if (b.foreignFlowStatus) bits.push(String(b.foreignFlowStatus).toLowerCase().replace('net buy asing', 'asing net buy').replace('net sell asing', 'asing net sell'));
      sub.textContent = bits.join(' · ');
    }
  }

  var marketInFlight = null;
  function loadMarket() {
    renderKick();
    if (marketInFlight) return marketInFlight;
    marketInFlight = fetch('/api/sector-hot?action=market-breadth')
      .then(function (r) { return r.json(); })
      .then(function (b) {
        renderBreadth(b);
        renderSession(b && b.market_calendar, b);
        if (root.AutoCuanMarketIntelligence && typeof root.AutoCuanMarketIntelligence.renderMarketBreadth === 'function') {
          root.AutoCuanMarketIntelligence.renderMarketBreadth('dashboardMarketBreadthWrap', b);
        }
      })
      .catch(function () { renderBreadth(null); renderSession(null, null); })
      .then(function () { marketInFlight = null; });
    loadIhsg();
    return marketInFlight;
  }

  // IHSG: last and change from /api/quote, the line from the last 30 closes.
  function sparkPath(closes) {
    var lo = Math.min.apply(null, closes), hi = Math.max.apply(null, closes), span = hi - lo || 1;
    return closes.map(function (c, i) {
      return (i ? 'L' : 'M') + (i / (closes.length - 1) * 120).toFixed(1) + ' ' + (26 - (c - lo) / span * 24).toFixed(1);
    }).join(' ');
  }
  function loadIhsg() {
    var headers = typeof root.getAuthHeaders === 'function' ? root.getAuthHeaders() : {};
    var lastEl = $('ihsgLast'), chgEl = $('ihsgChange'), trendEl = $('dashIhsgTrend'), cell = $('dashIhsgCell'), spark = $('dashIhsgSpark');
    fetch('/api/quote?ticker=IHSG', { headers: headers }).then(function (r) { return r.json(); }).then(function (q) {
      var last = Number(q && q.last), prev = Number(q && q.prevClose);
      if (!(q && q.success !== false && last > 0)) throw new Error('no quote');
      if (lastEl) lastEl.textContent = num(last, 2);
      if (prev > 0 && chgEl) {
        var d = last - prev, pct = d / prev * 100, up = d >= 0;
        chgEl.className = up ? 'pos' : 'neg';
        chgEl.textContent = (up ? '▲ +' : '▼ −') + num(Math.abs(d), 2) + ' (' + (up ? '+' : '−') + num(Math.abs(pct), 2) + '%)';
        if (cell) cell.setAttribute('data-ihsg-chg', pct.toFixed(2));
      } else if (chgEl) { chgEl.innerHTML = NIL; }
      if (trendEl) {
        var bar = q.latestBarDate || q.actual_data_date;
        trendEl.textContent = bar ? ' · bar ' + shortDate(bar) + (q.t1_verified === false ? ', belum terverifikasi' : '') : '';
      }
    }).catch(function () {
      if (lastEl) lastEl.innerHTML = NIL;
      if (chgEl) chgEl.textContent = '';
      if (trendEl) trendEl.textContent = '';
      if (cell) cell.removeAttribute('data-ihsg-chg');
    });
    fetch('/api/candles?ticker=IHSG&limit=30', { headers: headers }).then(function (r) { return r.json(); }).then(function (c) {
      var list = (c && (c.candles || c.data || c.rows)) || [];
      var closes = list.map(function (x) { return Number(x.close != null ? x.close : x.c); }).filter(function (v) { return v > 0; }).slice(-30);
      if (!spark || closes.length < 2) return;
      var path = spark.querySelector('path');
      path.setAttribute('d', sparkPath(closes));
      path.setAttribute('stroke', closes[closes.length - 1] >= closes[0] ? 'var(--ac-pos)' : 'var(--ac-neg)');
      spark.hidden = false;
    }).catch(function () { if (spark) spark.hidden = true; });
  }

  root.AutoCuanDashboardV2 = { loadMarket: loadMarket, loadIhsg: loadIhsg, sessionOf: sessionOf, strongestSector: strongestSector, renderKick: renderKick };
})(window);
