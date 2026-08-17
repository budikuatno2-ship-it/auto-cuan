(function (root) {
  'use strict';
  if (!root || !root.document) return;

  function boot(attempt) {
    var Ui = root.AutoCuanUiStability;
    var doc = root.document;
    var Safety = root.AutoCuanPatternSafety;
    var Visual = root.AutoCuanPatternVisual;
    if (!Ui || !doc.getElementById('dashboardScreen') || !root.PatternMap || !root.PatternMapAdminAccess ||
        !Safety || !Visual || typeof root.navigateTo !== 'function') {
      if (attempt < 240) root.setTimeout(function () { boot(attempt + 1); }, 50);
      return;
    }
    if (root.__AUTOCUAN_PATTERN_STABLE__) return;
    root.__AUTOCUAN_PATTERN_STABLE__ = '20260813-pattern-stable-v6';

    var originalNavigate = root.navigateTo;
    var originalLogout = typeof root.logout === 'function' ? root.logout : null;
    var state = {
      allowed:false, checked:false, loading:false, loaded:false, rows:[], total:0,
      version:0, urls:{}, controllers:{}, cacheHydrated:false
    };

    function esc(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
        return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
      });
    }
    // One price format for the whole feature. Levels the engine derives from ATR
    // and Fibonacci projections are genuinely fractional, so they are not rounded
    // to integers — but a level that *is* whole is never padded with ",00", which
    // is what made one card read "1.060" next to "933,21".
    function num(value) {
      return Visual.priceText(value);
    }
    function headers() {
      var result = {};
      try {
        result['X-User-Id'] = root.localStorage.getItem('autocuan_user_id') || '';
        result['X-Username'] = root.localStorage.getItem('autocuan_user') || '';
      } catch (_) {}
      return result;
    }
    async function json(url) {
      var response = await root.fetch(url, { credentials:'same-origin', cache:'no-store', headers:headers() });
      var data = await response.json().catch(function () { return null; });
      return response.ok && data && data.success !== false ? data : null;
    }
    function jakartaDateKey() {
      try {
        return new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Jakarta', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
      } catch (_) { return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10); }
    }
    function cacheKey() {
      var uid = '';
      try { uid = root.localStorage.getItem('autocuan_user_id') || 'session'; } catch (_) { uid = 'session'; }
      return 'autocuan_pattern_scan_cache_v3_' + uid;
    }
    function clearCache() {
      try { root.sessionStorage.removeItem(cacheKey()); } catch (_) {}
    }
    function persistCache() {
      try {
        root.sessionStorage.setItem(cacheKey(), JSON.stringify({
          version:3,
          dateKey:jakartaDateKey(),
          savedAt:Date.now(),
          total:state.total,
          rows:state.rows
        }));
      } catch (_) {}
    }
    function hydrateCache() {
      if (state.cacheHydrated) return state.loaded;
      state.cacheHydrated = true;
      try {
        var raw = root.sessionStorage.getItem(cacheKey());
        var cached = raw ? JSON.parse(raw) : null;
        if (!cached || cached.version !== 3 || cached.dateKey !== jakartaDateKey() || !Array.isArray(cached.rows)) return false;
        state.rows = cached.rows;
        state.total = Number(cached.total) || 0;
        state.loaded = true;
        state.loading = false;
        render();
        progress(state.total, state.total, 'Hasil scan hari ini dipulihkan. Tekan Scan Ulang hanya bila diperlukan.');
        return true;
      } catch (_) { return false; }
    }

    function addStyles() {
      if (doc.getElementById('patternStableStyles')) return;
      var style = doc.createElement('style');
      style.id = 'patternStableStyles';
      style.textContent = [
        '#patternChartTab,#patternPageContainer{display:none!important}',
        '.ps-shell{padding:20px;border:1px solid var(--ac-line,rgba(148,163,184,.12));border-radius:var(--ac-radius-xl,20px);background:var(--ac-surface-1,linear-gradient(145deg,rgba(18,25,36,.98),rgba(8,14,22,.98)));box-shadow:var(--ac-shadow-2,0 24px 68px rgba(0,0,0,.22))}',
        '.ps-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}',
        '.ps-eyebrow{font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#6ee7b7}',
        '.ps-title{margin-top:6px;font-size:24px;line-height:1.15;font-weight:800;letter-spacing:-.02em;color:#f8fafc}.ps-sub{margin-top:6px;max-width:62ch;font-size:12.5px;line-height:1.6;color:#94a3b8}.ps-actions,.ps-card-actions{display:flex;gap:8px;flex-wrap:wrap}',
        '.ps-btn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:10px 14px;border:1px solid rgba(52,211,153,.30);border-radius:12px;background:rgba(16,185,129,.10);color:#6ee7b7;font-size:12.5px;font-weight:700;cursor:pointer;transition:background .15s ease,border-color .15s ease}.ps-btn:hover:not(:disabled){background:rgba(16,185,129,.16);border-color:rgba(52,211,153,.45)}.ps-btn.alt{border-color:rgba(148,163,184,.18);background:rgba(15,23,42,.58);color:#cbd5e1}.ps-btn.alt:hover:not(:disabled){background:rgba(30,41,59,.72)}.ps-btn:disabled{opacity:.5;cursor:not-allowed}',
        '.ps-progress{margin-top:18px;padding:13px 15px;border:1px solid rgba(148,163,184,.12);border-radius:14px;background:rgba(2,6,23,.38)}.ps-progress-row{display:flex;justify-content:space-between;gap:12px;font-size:11.5px;color:#94a3b8}.ps-track{height:6px;margin-top:9px;overflow:hidden;border-radius:999px;background:#151a23}.ps-fill{height:100%;width:0;background:linear-gradient(90deg,#10b981,#22d3ee);transition:width .18s}',
        '.ps-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));gap:14px;margin-top:18px}',
        '.ps-card{display:flex;flex-direction:column;min-width:0;padding:16px;border:1px solid rgba(148,163,184,.13);border-radius:var(--ac-radius-lg,16px);background:var(--ac-surface-2,rgba(15,23,42,.52));box-shadow:var(--ac-shadow-1,0 10px 28px rgba(0,0,0,.18));transition:border-color .15s ease,transform .15s ease}.ps-card:hover{transform:translateY(-1px)}.ps-card.bullish{border-color:rgba(52,211,153,.26)}.ps-card.bearish{border-color:rgba(248,113,113,.24)}.ps-card.bilateral{border-color:rgba(96,165,250,.24)}',
        '.ps-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.ps-ticker{font-size:21px;line-height:1.1;font-weight:800;letter-spacing:-.01em;color:#f8fafc}.ps-name{margin-top:3px;font-size:12px;line-height:1.5;color:#94a3b8}',
        // The verdict pill carries meaning, so each state gets its own colour
        // rather than the single blue treatment every state used to share.
        '.ps-badge{flex:0 0 auto;padding:5px 10px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.02em;white-space:nowrap;border:1px solid}',
        '.ps-badge[data-tone="ok"]{border-color:rgba(52,211,153,.32);background:rgba(16,185,129,.12);color:#6ee7b7}',
        '.ps-badge[data-tone="wait"]{border-color:rgba(96,165,250,.30);background:rgba(59,130,246,.10);color:#93c5fd}',
        '.ps-badge[data-tone="muted"]{border-color:rgba(148,163,184,.22);background:rgba(148,163,184,.08);color:#94a3b8}',
        '.ps-badge[data-tone="danger"]{border-color:rgba(248,113,113,.30);background:rgba(239,68,68,.10);color:#fca5a5}',
        '.ps-card[data-tone="muted"],.ps-card[data-tone="danger"]{opacity:.86}',
        '.ps-verdict{margin-top:12px;padding:10px 12px;border-radius:12px;border:1px solid rgba(148,163,184,.14);background:rgba(2,6,23,.34);color:#a9b6c9;font-size:11.5px;line-height:1.6}',
        '.ps-verdict[data-tone="ok"]{border-color:rgba(52,211,153,.22);background:rgba(16,185,129,.06);color:#b7ead4}',
        '.ps-verdict[data-tone="danger"]{border-color:rgba(248,113,113,.22);background:rgba(239,68,68,.06);color:#fecaca}',
        '.ps-pattern-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.ps-pattern-chip{display:inline-flex;align-items:center;min-height:26px;padding:4px 10px;border:1px solid rgba(96,165,250,.20);border-radius:999px;background:rgba(59,130,246,.075);color:#bfdbfe;font-size:10.5px;font-weight:700}.ps-pattern-chip.bullish{border-color:rgba(52,211,153,.24);background:rgba(16,185,129,.08);color:#a7f3d0}.ps-pattern-chip.bearish{border-color:rgba(248,113,113,.24);background:rgba(239,68,68,.07);color:#fecaca}.ps-pattern-note{margin-top:10px;color:#8395ab;font-size:11px;line-height:1.6}',
        // The pattern picture is the reason this page exists, so it is part of the
        // card rather than something hidden behind a button.
        '.ps-figure{margin-top:12px;border:1px solid rgba(148,163,184,.12);border-radius:14px;background:rgba(2,6,23,.44);overflow:hidden}',
        '.ps-figure svg{display:block;width:100%;height:auto}',
        '.ps-figure-empty{padding:26px 14px;color:#7c8ba1;font-size:11.5px;text-align:center}',
        '.ps-levels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:12px}',
        // A price must never be hyphen-free-wrapped mid-number: "1.090" split
        // across two lines reads as "1.09" followed by a stray "0". The value
        // is nowrap and the label is what gives way when space runs out.
        '.ps-level{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:8px 11px;border:1px solid rgba(148,163,184,.10);border-radius:11px;background:rgba(2,6,23,.34)}',
        '.ps-level span{min-width:0;color:#7c8ba1;font-size:9.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;overflow-wrap:break-word}',
        '.ps-level b{flex:0 0 auto;white-space:nowrap;color:#e8edf5;font-size:13px;font-variant-numeric:tabular-nums;text-align:right}',
        '.ps-level[data-role="confirmation"] b{color:#6ee7b7}.ps-level[data-role="invalidation"] b{color:#fca5a5}.ps-level[data-role="tp1"] b,.ps-level[data-role="tp2"] b{color:#fcd34d}.ps-level[data-role="prz"] b{color:#d8b4fe}',
        '.ps-level.wide{grid-column:1 / -1}',
        '.ps-card-actions{margin-top:auto;padding-top:14px}',
        '.ps-map-tools{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}',
        '.ps-map-tool{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:9px 13px;border:1px solid rgba(148,163,184,.18);border-radius:11px;background:rgba(15,23,42,.66);color:#cbd5e1;font-size:11.5px;font-weight:700;text-decoration:none;cursor:pointer}.ps-map-tool:hover{border-color:rgba(52,211,153,.40);color:#6ee7b7}',
        '@media(max-width:520px){.ps-map-tools .ps-map-tool{flex:1 1 0}}',
        '.ps-empty{margin-top:18px;padding:36px 18px;border:1px dashed rgba(148,163,184,.18);border-radius:16px;background:rgba(2,6,23,.30);color:#94a3b8;font-size:12.5px;line-height:1.6;text-align:center}',
        '.ps-legend{display:flex;flex-wrap:wrap;gap:10px 16px;margin-top:14px;color:#7c8ba1;font-size:10.5px}',
        '.ps-legend i{display:inline-block;width:16px;height:0;margin-right:6px;vertical-align:middle;border-top:2px dashed currentColor}',
        '.ps-legend b{font-weight:700;color:#94a3b8}',
        '@media(max-width:760px){.ps-grid{grid-template-columns:1fr;gap:12px}.ps-shell{padding:16px;border-radius:18px}.ps-title{font-size:21px}.ps-actions{width:100%}.ps-actions .ps-btn{flex:1 1 0}.ps-card-actions .ps-btn{flex:1 1 0}}',
        '@media(max-width:420px){.ps-levels{grid-template-columns:1fr;gap:6px}.ps-level span{font-size:10px}}',
        '@media(prefers-reduced-motion:reduce){.ps-card{transition:none}.ps-card:hover{transform:none}.ps-fill{transition:none}}'
      ].join('');
      doc.head.appendChild(style);
    }

    function pageHtml() {
      return '<section class="ps-shell">' +
        '<div class="ps-head"><div>' +
        '<p class="ps-eyebrow">Analisis Teknikal</p>' +
        '<h2 class="ps-title">Pattern Radar</h2>' +
        '<p class="ps-sub">Memindai saham di hasil Screener terbaru dan menampilkan yang membentuk pola ABCD atau pola chart klasik pada data harian T-1. Kartu diurutkan mulai dari yang masih relevan untuk dipantau. Pola adalah konfirmasi teknikal, bukan sinyal beli.</p>' +
        '</div><div class="ps-actions">' +
        '<button type="button" id="psRefresh" class="ps-btn">Scan ulang</button>' +
        '<button type="button" id="psTechnical" class="ps-btn alt">Buka Chart</button>' +
        '</div></div>' +
        '<div class="ps-progress"><div class="ps-progress-row"><span id="psStatus">Siap memindai.</span><span id="psCount" aria-live="polite">0 saham berpola</span></div>' +
        '<div class="ps-track" role="progressbar" aria-labelledby="psStatus" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="psTrack"><div id="psFill" class="ps-fill"></div></div></div>' +
        '<div id="psGrid" class="ps-grid"></div>' +
        '<div id="psEmpty" class="ps-empty">Belum ada hasil scan Pattern hari ini.</div>' +
        '<div id="psLegend" class="ps-legend" hidden>' +
        '<span style="color:#6ee7b7"><i></i><b>Konfirmasi</b> — level yang harus ditembus close harian</span>' +
        '<span style="color:#fca5a5"><i></i><b>Invalidasi</b> — pola batal bila tersentuh</span>' +
        '<span style="color:#fcd34d"><i></i><b>Target 1 & 2</b> — proyeksi dari panjang kaki C–D</span>' +
        '<span style="color:#d8b4fe"><i></i><b>PRZ</b> — zona tempat titik D diperkirakan terbentuk</span>' +
        '</div></section>';
    }
    function place(node) {
      var screen = doc.getElementById('dashboardScreen');
      var footer = screen && screen.querySelector('footer');
      if (!screen || !node) return node;
      if (node.parentNode !== screen) footer ? screen.insertBefore(node, footer) : screen.appendChild(node);
      else if (footer && node.nextSibling !== footer) screen.insertBefore(node, footer);
      return node;
    }
    // Visibility is three attributes, not one. `applyPremiumAccessUi` in
    // index.html used to set `hidden` + `aria-hidden` + `inert` on this page
    // (it was tagged `data-premium-page`) while only `hidden` was ever cleared,
    // which left Pattern rendered but completely dead to touch. The page is no
    // longer premium-tagged — its access is owned by the stricter signed-admin
    // gate below — and every transition now moves all three together, which also
    // heals a node left inert by a cached older build.
    function setPageVisible(node, visible) {
      if (!node) return node;
      node.classList.toggle('hidden', !visible);
      if (visible) {
        node.removeAttribute('aria-hidden');
        if ('inert' in node) node.inert = false;
        else node.removeAttribute('inert');
      } else {
        node.setAttribute('aria-hidden', 'true');
        if ('inert' in node) node.inert = true;
        else node.setAttribute('inert', '');
      }
      return node;
    }

    function page() {
      var node = doc.getElementById('page-pattern');
      if (!node) {
        node = doc.createElement('div');
        node.id = 'page-pattern';
        node.className = 'page-content hidden flex-1 max-w-[1200px] w-full mx-auto px-3 sm:px-5 py-4';
        node.innerHTML = pageHtml();
        place(node);
        doc.getElementById('psRefresh').onclick = function () { clearCache(); state.cacheHydrated = true; scan(true); };
        doc.getElementById('psTechnical').onclick = function () { root.navigateTo('chart'); };
        node.addEventListener('click', function (event) {
          var zoomButton = event.target.closest('[data-ps-zoom]');
          if (zoomButton) expand(zoomButton.getAttribute('data-ps-zoom'));
          var chartButton = event.target.closest('[data-ps-chart]');
          if (chartButton) openChart(chartButton.getAttribute('data-ps-chart'));
        });
      }
      return place(node);
    }

    function makeNav(id, mobile) {
      var button = doc.createElement('button');
      button.id = id; button.type = 'button'; button.className = 'nav-btn' + (mobile ? ' flex-shrink-0' : '');
      button.setAttribute('data-page', 'pattern');
      button.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 18l4-5 4 3 4-8 4 4M4 21h16"/></svg><span>Pattern</span>';
      button.onclick = function () { root.navigateTo('pattern'); };
      return button;
    }
    function insertNav(container, button) {
      if (!container || !button) return;
      var chart = container.querySelector('[data-page="chart"]');
      chart ? container.insertBefore(button, chart) : container.appendChild(button);
    }
    function removeNav() {
      ['patternStableDesktopNav','patternStableMobileNav','patternRadarDesktopNav','patternRadarMobileNav'].forEach(function (id) { var node = doc.getElementById(id); if (node) node.remove(); });
    }
    function ensureNav() {
      if (!state.allowed) return;
      ['patternRadarDesktopNav','patternRadarMobileNav'].forEach(function (id) { var old = doc.getElementById(id); if (old) old.remove(); });
      if (!doc.getElementById('patternStableDesktopNav')) insertNav(doc.querySelector('.desktop-nav'), makeNav('patternStableDesktopNav', false));
      if (!doc.getElementById('patternStableMobileNav')) insertNav(doc.getElementById('mainNav'), makeNav('patternStableMobileNav', true));
    }
    async function access(force) {
      var allowed = await root.PatternMapAdminAccess.refresh(force === true).catch(function () { return false; });
      state.checked = true;
      state.allowed = allowed === true && root.PatternMapAdminAccess.isAllowed() === true;
      if (state.allowed) ensureNav(); else { removeNav(); hide(); }
      return state.allowed;
    }
    function hide() { setPageVisible(doc.getElementById('page-pattern'), false); }
    function show() {
      originalNavigate('chart');
      doc.querySelectorAll('.page-content').forEach(function (node) { node.classList.add('hidden'); });
      setPageVisible(page(), true);
      doc.querySelectorAll('.nav-btn[data-page]').forEach(function (button) { button.classList.toggle('active', button.getAttribute('data-page') === 'pattern'); });
      try { root.history.replaceState({}, '', '/pattern'); } catch (_) {}
      if (typeof root.closeSidebar === 'function') root.closeSidebar();
      root.scrollTo({ top:0, behavior:'smooth' });
    }

    function progress(done, total, overrideText) {
      state.total = total;
      var status = doc.getElementById('psStatus');
      if (status) status.textContent = overrideText || (state.loading ? 'Memindai ' + done + ' dari ' + total + ' saham Screener…' : (total ? 'Selesai memindai ' + total + ' saham Screener.' : 'Screener belum punya ticker untuk dipindai.'));
      var count = doc.getElementById('psCount');
      if (count) {
        var actionable = state.rows.filter(function (row) { return row.safety && row.safety.actionable; }).length;
        count.textContent = state.rows.length + ' saham berpola' + (state.rows.length ? ' · ' + actionable + ' siap dipantau' : '');
      }
      var percent = total ? Math.round(done / total * 100) : 0;
      var fill = doc.getElementById('psFill');
      if (fill) fill.style.width = percent + '%';
      var track = doc.getElementById('psTrack');
      if (track) {
        track.setAttribute('aria-valuenow', String(percent));
        // A permanently full bar communicates nothing once the scan has ended.
        track.hidden = !state.loading && percent >= 100;
      }
    }
    function patternChips(row) {
      var patterns = Array.isArray(row.classicPatterns) ? row.classicPatterns : [];
      if (!patterns.length) return '';
      var chips = patterns.map(function (pattern) {
        var bias = String(pattern.bias || '').toLowerCase();
        var cls = bias.indexOf('bull') >= 0 ? ' bullish' : (bias.indexOf('bear') >= 0 ? ' bearish' : '');
        return '<span class="ps-pattern-chip' + cls + '">' + esc(pattern.label || pattern.type) + '</span>';
      }).join('');
      var primary = patterns[0] || {};
      return '<div class="ps-pattern-chips">' + chips + '</div>' + (primary.reason ? '<p class="ps-pattern-note">' + esc(primary.reason) + ' Pattern adalah konfirmasi teknikal, bukan sinyal BUY otomatis.</p>' : '');
    }
    // Levels are labelled by what they mean for the pattern's own direction, and
    // the same six slots appear in the same order on every card so two cards can
    // be compared at a glance.
    function levelsHtml(c, direction) {
      var up = direction !== 'bearish';
      var rows = [
        ['current', 'Harga terakhir', num(c.currentPrice), false],
        ['confirmation', up ? 'Konfirmasi naik' : 'Konfirmasi turun', num(c.confirmation), false],
        ['tp1', 'Target 1', num(c.tp1), false],
        ['tp2', 'Target 2', num(c.tp2), false],
        ['invalidation', up ? 'Invalidasi — di bawah' : 'Invalidasi — di atas', num(c.invalidation), true]
      ];
      var html = rows.map(function (row) {
        return '<div class="ps-level' + (row[3] ? ' wide' : '') + '" data-role="' + row[0] + '"><span>' + esc(row[1]) + '</span><b>' + row[2] + '</b></div>';
      }).join('');
      var low = c.prz && c.prz.low, high = c.prz && c.prz.high;
      if (Number.isFinite(Number(low)) && Number.isFinite(Number(high))) {
        html += '<div class="ps-level wide" data-role="prz"><span>Zona pembentukan D (PRZ)</span><b>' + num(low) + ' – ' + num(high) + '</b></div>';
      }
      return '<div class="ps-levels">' + html + '</div>';
    }

    function figureHtml(row) {
      var svg = '';
      try { svg = Visual.buildPatternSvg(row, { width: 420, height: 208 }); } catch (_) { svg = ''; }
      if (!svg) return '<div class="ps-figure"><div class="ps-figure-empty">Bentuk pola belum bisa digambar dari data harian yang tersedia.</div></div>';
      return '<div class="ps-figure">' + svg + '</div>';
    }

    // "Keyakinan" used to be a bare percentage. On a chart pattern that reads as
    // a probability of profit, which it is not — it is how cleanly the formation
    // matches its rule. The label now says so.
    function confidenceText(primary) {
      var value = Number(primary && primary.confidence);
      if (!Number.isFinite(value)) return '—';
      return Math.round(value * 100) + '%';
    }

    function card(row) {
      var c = row.candidate;
      var patterns = Array.isArray(row.classicPatterns) ? row.classicPatterns : [];
      var primary = patterns[0] || {};
      var verdict = row.safety || Safety.evaluateRow(row, row.plan || null);
      var direction = verdict.direction === 'bearish' ? 'bearish' : (verdict.direction === 'bullish' ? 'bullish' : 'bilateral');
      var text = Safety.statusText(verdict.status);
      var head = '<div class="ps-card-head"><div><div class="ps-ticker">' + esc(row.ticker) + '</div>' +
        '<div class="ps-name">' + esc((c && c.name) || primary.label || 'Pola chart klasik') + ' · data T-1 ' + esc(row.dataDate || '—') + '</div></div>' +
        '<span class="ps-badge" data-tone="' + esc(text.tone) + '">' + esc(text.badge) + '</span></div>';
      var verdictBox = '<p class="ps-verdict" data-tone="' + esc(text.tone) + '">' + esc(text.note) + '</p>';
      var actions = '<div class="ps-card-actions"><button type="button" class="ps-btn" data-ps-zoom="' + esc(row.ticker) + '">Perbesar</button>' +
        '<button type="button" class="ps-btn alt" data-ps-chart="' + esc(row.ticker) + '">Buka Chart</button></div>';

      if (!c) {
        return '<article class="ps-card ' + direction + '" data-classic-only="1" data-tone="' + esc(text.tone) + '" data-pattern-status="' + esc(verdict.status) + '">' +
          head + verdictBox + patternChips(row) + figureHtml(row) +
          '<div class="ps-levels">' +
          '<div class="ps-level" data-role="current"><span>Harga terakhir</span><b>' + num(row.currentPrice) + '</b></div>' +
          '<div class="ps-level"><span>Arah pola</span><b>' + esc(primary.bias || 'Bilateral') + '</b></div>' +
          '<div class="ps-level wide"><span>Kecocokan bentuk pola</span><b>' + confidenceText(primary) + '</b></div>' +
          '</div>' + actions + '</article>';
      }
      return '<article class="ps-card ' + direction + '" data-tone="' + esc(text.tone) + '" data-pattern-status="' + esc(verdict.status) + '">' +
        head + verdictBox + patternChips(row) + figureHtml(row) + levelsHtml(c, direction) + actions + '</article>';
    }

    function render() {
      state.rows.forEach(function (row) { row.safety = Safety.evaluateRow(row, row.plan || null); });
      state.rows.sort(function (a, b) {
        var ar = Safety.statusRank(a.safety && a.safety.status);
        var br = Safety.statusRank(b.safety && b.safety.status);
        if (ar !== br) return ar - br;
        var ag = a.candidate ? 1 : 0, bg = b.candidate ? 1 : 0;
        if (ag !== bg) return bg - ag;
        var af = a.classicPatterns && a.classicPatterns[0] ? Number(a.classicPatterns[0].confidence) || 0 : 0;
        var bf = b.classicPatterns && b.classicPatterns[0] ? Number(b.classicPatterns[0].confidence) || 0 : 0;
        return (bf - af) || a.ticker.localeCompare(b.ticker);
      });
      var grid = doc.getElementById('psGrid');
      if (grid) grid.innerHTML = state.rows.map(card).join('');
      var empty = doc.getElementById('psEmpty');
      if (empty) {
        empty.classList.toggle('hidden', state.rows.length > 0);
        if (!state.rows.length) empty.textContent = state.loading ? 'Sedang memindai saham dari hasil Screener terbaru…' : (state.total ? 'Tidak ada pola yang lolos aturan konservatif pada hasil Screener saat ini.' : 'Belum ada ticker dari Screener yang bisa dipindai.');
      }
      var legend = doc.getElementById('psLegend');
      if (legend) legend.hidden = state.rows.length === 0;
    }
    async function universe() {
      var stamp = Date.now();
      return Ui.collectTickers(await Promise.all([
        json('/api/sector-hot?action=screener&t=' + stamp).catch(function () { return null; }),
        json('/api/sector-hot?action=nk-screener-results&t=' + stamp).catch(function () { return null; }),
        json('/api/sector-hot?action=daytrade-screener&t=' + stamp).catch(function () { return null; })
      ]));
    }
    async function scan(force) {
      if (state.loading || (state.loaded && force !== true) || !await access(force === true)) return;
      var version = ++state.version;
      var previousRows = state.rows.slice();
      state.loading = true;
      var refresh = doc.getElementById('psRefresh');
      if (refresh) { refresh.disabled = true; refresh.textContent = 'Memindai…'; }
      try {
        var tickers = await universe();
        if (version !== state.version) return;
        progress(0, tickers.length);
        var results = await Ui.mapBounded(tickers, Ui.constants.SCAN_CONCURRENCY, async function (ticker) {
          var data = await json('/api/candles?ticker=' + encodeURIComponent(ticker));
          if (version !== state.version || !data || !Array.isArray(data.candles)) return null;
          var classicPatterns = Array.isArray(data.classicPatterns) ? data.classicPatterns.filter(function (pattern) { return pattern && pattern.label; }).slice(0, 3) : [];
          var candidate = null;
          var dataDate = String(data.actual_data_date || (data.patternMap && data.patternMap.dataDate) || (data.latest && data.latest.date) || '');
          var context = { ticker:ticker, timeframe:'1D', dataDate:dataDate, candles:data.candles };
          if (data.patternMap) {
            var validation = root.PatternMap.validateCandidate(data.patternMap, context);
            if (validation && validation.valid === true) candidate = data.patternMap;
          }
          if (!candidate && !classicPatterns.length) return null;
          return { ticker:ticker, candidate:candidate, classicPatterns:classicPatterns, context:context, dataDate:dataDate, currentPrice:data.latest && data.latest.last };
        }, function (done, total) { if (version === state.version) progress(done, total); });
        if (version !== state.version) return;
        state.rows = results.filter(Boolean);
        state.total = tickers.length;
        state.loaded = true;
        render(); persistCache();
      } catch (_) {
        state.rows = previousRows;
        state.loaded = previousRows.length > 0;
        render();
      } finally {
        if (version === state.version) {
          state.loading = false;
          progress(state.total, state.total, state.loaded ? 'Hasil Pattern hari ini siap. Scan tidak diulang saat keluar–masuk halaman.' : 'Scan belum berhasil.');
          if (refresh) { refresh.disabled = false; refresh.textContent = 'Scan Ulang'; }
        }
      }
    }

    // The fullscreen viewer prefers the interactive chart engine, which is itself
    // lazily fetched from a CDN. Handing it the same SVG as a data: URI means the
    // fallback path still shows the real pattern when that fetch cannot complete,
    // instead of "Visual chart belum tersedia untuk ditampilkan."
    function svgDataUri(row) {
      var svg = '';
      try { svg = Visual.buildPatternSvg(row, { width: 1100, height: 520 }); } catch (_) { return null; }
      if (!svg) return null;
      try {
        return { src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), width: 1100, height: 520 };
      } catch (_) { return null; }
    }
    // Pattern geometry expressed as chart overlays, so the fullscreen viewer draws the
    // same levels the card lists — on the real chart engine the Chart page uses.
    function viewerPriceLines(candidate) {
      if (!candidate) return [];
      var lines = [
        ['Konfirmasi', candidate.confirmation, '#22c55e'],
        ['Invalidasi', candidate.invalidation, '#ef4444'],
        ['TP1', candidate.tp1, '#f59e0b'],
        ['TP2', candidate.tp2, '#fbbf24'],
        ['PRZ atas', candidate.prz && candidate.prz.high, '#c084fc'],
        ['PRZ bawah', candidate.prz && candidate.prz.low, '#c084fc']
      ];
      return lines.map(function (line) {
        return { title:line[0], price:Number(line[1]), color:line[2], lineWidth:1, lineStyle:2 };
      }).filter(function (line) { return Number.isFinite(line.price); });
    }
    function viewerMarkers(candidate) {
      if (!candidate || !candidate.points) return [];
      return ['X', 'A', 'B', 'C', 'D'].map(function (name) {
        var point = candidate.points[name];
        if (!point || !point.time) return null;
        var below = point.priceField === 'low';
        return {
          time:point.time,
          position:below ? 'belowBar' : 'aboveBar',
          color:'#38bdf8',
          shape:below ? 'arrowUp' : 'arrowDown',
          text:name
        };
      }).filter(Boolean);
    }
    function expand(ticker) {
      var row = state.rows.find(function (item) { return item.ticker === ticker; });
      if (!row || typeof root.openChartViewer !== 'function') return;
      var primary = (row.classicPatterns && row.classicPatterns[0]) || {};
      var name = (row.candidate && row.candidate.name) || primary.label || 'Pola chart';
      var image = svgDataUri(row);
      if (image) image.alt = 'Bentuk pola ' + row.ticker + ' dari data harian T-1';
      root.openChartViewer({
        title:row.ticker + ' · ' + name,
        subtitle:'Data T-1 ' + (row.dataDate || '') + ' · konfirmasi manual tetap diperlukan',
        ticker:row.ticker,
        candles:(row.context && Array.isArray(row.context.candles)) ? row.context.candles : [],
        priceLines:viewerPriceLines(row.candidate),
        markers:viewerMarkers(row.candidate),
        image:image
      });
    }
    function openChart(ticker) {
      root.navigateTo('chart');
      var input = doc.getElementById('chartTickerInput');
      if (input) input.value = ticker;
      if (typeof root.loadChartPage === 'function') root.loadChartPage();
    }
    async function open() {
      if (!await access(true)) return false;
      show();
      if (!hydrateCache()) scan(false);
      return true;
    }

    addStyles(); page();
    root.navigateTo = function (name) {
      if (name === 'pattern') return open();
      hide();
      if (root.location && root.location.pathname === '/pattern') { try { root.history.replaceState({}, '', '/dashboard'); } catch (_) {} }
      return originalNavigate.apply(root, arguments);
    };
    if (originalLogout) root.logout = function () { state.allowed=false; state.checked=true; state.version+=1; clearCache(); hide(); removeNav(); return originalLogout.apply(root, arguments); };
    access(false).then(function (allowed) { if (allowed && root.location && root.location.pathname === '/pattern') open(); });
    root.setInterval(function () {
      // Access checks are only useful while the document is visible. Skipping
      // hidden-tab ticks avoids waking the page every second and prevents
      // needless auth requests/state churn while preserving the foreground
      // guard for an active pattern surface.
      if (doc.visibilityState === 'hidden') return;
      if (!state.checked || root.PatternMapAdminAccess.isAllowed()) return;
      state.allowed=false; removeNav();
      var node=doc.getElementById('page-pattern');
      if (node && !node.classList.contains('hidden')) root.navigateTo('chart');
    }, 1000);
    root.addEventListener('focus', function () { access(true); });
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible') access(true); });
  }

  boot(0);
})(typeof window !== 'undefined' ? window : null);
