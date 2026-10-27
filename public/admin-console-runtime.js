/**
 * Admin Console Runtime - Auto-Cuan Redesign V2
 * Manages operational dashboard, online users (IP-free), account approval,
 * maintenance mode, vouchers, data health inspection, and audit logs.
 */
(function(root) {
  'use strict';

  var activeAdminTab = 0;
  var currentOnlineFilter = 'all';
  var onlineRefreshTimer = null;
  var pendingConfirmAction = null;
  var targetConfirmWord = 'KONFIRMASI';

  // Check Admin Authorization
  async function verifyAdminAuth() {
    try {
      var res = await fetch('/api/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'admin_console_stats' })
      });
      if (!res.ok) {
        showUnauthorized();
        return;
      }
      var data = await res.json().catch(function() { return {}; });
      if (!data || data.success !== true) {
        showUnauthorized();
        return;
      }

      // Authorized!
      var unauth = document.getElementById('unauthorizedScreen');
      if (unauth) unauth.style.display = 'none';
      var mainContent = document.getElementById('adminMainContent');
      if (mainContent) mainContent.style.display = 'block';
      var badge = document.getElementById('adminUserBadge');
      if (badge) badge.textContent = 'Admin: ' + (data.admin || 'budi');

      applyStats(data);
      loadOnlineList();
      startAutoRefresh();
    } catch (_) {
      showUnauthorized();
    }
  }

  function showUnauthorized() {
    var mainContent = document.getElementById('adminMainContent');
    if (mainContent) mainContent.style.display = 'none';
    var unauth = document.getElementById('unauthorizedScreen');
    if (unauth) unauth.style.display = 'grid';
  }

  function applyStats(data) {
    if (data.quota) {
      var q = data.quota;
      var el = document.getElementById('statQuotaNum');
      if (el) el.innerHTML = Number(q.used).toLocaleString('id-ID') + '<span class="mut" style="font-size:14px;font-weight:600"> / ' + Number(q.limit).toLocaleString('id-ID') + '</span>';
      var bar = document.getElementById('statQuotaBar');
      if (bar) bar.style.width = q.pct + '%';
    }
    if (data.online_summary) {
      var s = data.online_summary;
      var nowEl = document.getElementById('statOnlineNow');
      if (nowEl) nowEl.textContent = s.online_now;
      var onNowEl = document.getElementById('onSummaryNow');
      if (onNowEl) onNowEl.textContent = s.online_now;
      var on15m = document.getElementById('onSummary15m');
      if (on15m) on15m.textContent = s.active_15m;
      var onToday = document.getElementById('onSummaryToday');
      if (onToday) onToday.textContent = s.today;
      var onIdle = document.getElementById('onSummaryIdle7d');
      if (onIdle) onIdle.textContent = s.idle_7d;
      var tabOn = document.getElementById('tabOnlineCount');
      if (tabOn) tabOn.textContent = s.online_now;
    }
    if (data.data_health) {
      renderDataHealth(data.data_health);
    }
  }

  // Tab Switching
  root.switchAdminTab = function(idx) {
    activeAdminTab = idx;
    var tabs = document.querySelectorAll('#adminNavTabs .tbtn');
    tabs.forEach(function(btn, i) {
      if (i === idx) btn.classList.add('on');
      else btn.classList.remove('on');
    });
    for (var i = 0; i <= 6; i++) {
      var panel = document.getElementById('panelTab' + i);
      if (panel) {
        if (i === idx) panel.style.display = 'block';
        else panel.style.display = 'none';
      }
    }
    if (idx === 1) loadOnlineList();
    if (idx === 5) root.refreshDataHealth();
  };

  // Data Health Inspector
  root.refreshDataHealth = async function() {
    var btn = document.getElementById('btnRefreshDataHealth');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Memeriksa...';
    }
    try {
      var res = await fetch('/api/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'data_health_inspect' })
      });
      if (res.ok) {
        var data = await res.json().catch(function() { return {}; });
        if (data && data.success && data.data_health) {
          renderDataHealth(data.data_health);
        }
      }
    } catch (_) {}
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-2px"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>Periksa Ulang Status Data';
    }
  };

  function renderDataHealth(health) {
    if (!health) return;

    var badge = document.getElementById('healthOverallBadge');
    if (badge) {
      badge.className = 'st ' + (health.overall_status === 'ok' ? 'g' : (health.overall_status === 'warn' ? 'a' : 'r'));
      badge.textContent = health.overall_label;
    }

    var okEl = document.getElementById('statHealthOk');
    if (okEl) okEl.textContent = health.ok_count;
    var warnEl = document.getElementById('statHealthWarn');
    if (warnEl) warnEl.textContent = health.warn_count;

    var timeEl = document.getElementById('healthLastChecked');
    if (timeEl) timeEl.textContent = health.inspected_at_formatted || '—';

    var tbody = document.getElementById('dataHealthTbody');
    if (!tbody || !health.categories) return;

    tbody.innerHTML = health.categories.map(function(c) {
      var metricsHtml = '';
      var m = c.metrics || {};
      if (c.id === 'broker_summary_all') {
        metricsHtml = '<b class="num">' + m.complete_count + '</b> / ' + m.total_universe + ' emiten (' + m.coverage_pct + '%)<span class="mut" style="display:block;font-size:11px">' + escapeHtml(c.details) + '</span>';
      } else if (c.id === 'broker_summary_foreign') {
        metricsHtml = '<span class="mut">Ketercakupan:</span> <b class="num">' + (m.foreign_archive_count === '—' ? '—' : m.foreign_archive_count + ' / ' + m.total_universe) + '</b><span class="mut" style="display:block;font-size:11px">' + escapeHtml(c.details) + '</span>';
      } else if (c.id === 'broker_summary_domestic') {
        metricsHtml = '<span class="mono mut">Rumus: ' + escapeHtml(m.calculation_formula) + '</span> · <span class="mut">Menunggu:</span> <b class="num">' + m.waiting_foreign_count + '</b> emiten<span class="mut" style="display:block;font-size:11px">' + escapeHtml(c.details) + '</span>';
      } else if (c.id === 'candle_eod_volume') {
        metricsHtml = '<b class="num">' + m.active_candle_count + '</b> emiten aktif (' + m.total_candles + ' bar) · <span class="num mut">' + m.anomaly_bars_count + ' anomali/vol 0</span><span class="mut" style="display:block;font-size:11px">' + escapeHtml(m.ihsg_status) + '</span>';
      } else if (c.id === 'broker_accumulation_hunter') {
        metricsHtml = '<b class="num">' + m.hunter_indexes_count + '</b> berkas indeks hunter · <span class="mut">' + m.accumulation_horizons.join(', ') + '</span><span class="mut" style="display:block;font-size:11px">' + escapeHtml(c.details) + '</span>';
      } else if (c.id === 'insider_network_ksei') {
        metricsHtml = '<b class="num">' + Number(m.total_entities).toLocaleString('id-ID') + '</b> entitas · <b class="num">' + m.total_tickers + '</b> emiten<span class="mut" style="display:block;font-size:11px">' + escapeHtml(c.details) + '</span>';
      } else if (c.id === 'hot_sectors_intel_screener') {
        metricsHtml = '<b class="num">' + m.intel_catalogs_count + '</b> katalog aktif · <span class="mut">Snapshot ' + escapeHtml(m.snapshot_freshness) + '</span><span class="mut" style="display:block;font-size:11px">' + escapeHtml(c.details) + '</span>';
      } else {
        metricsHtml = '<span class="mut">' + escapeHtml(c.details) + '</span>';
      }

      var dateStr = '—';
      if (m.latest_trade_date) dateStr = m.latest_trade_date;
      else if (m.latest_foreign_date) dateStr = m.latest_foreign_date;
      else if (m.latest_candle_date) dateStr = m.latest_candle_date;
      else if (m.latest_compilation) dateStr = m.latest_compilation;
      else if (m.ksei_release_date) dateStr = m.ksei_release_date;
      else if (m.last_signal_scan) dateStr = m.last_signal_scan;

      return '<tr>' +
        '<td><b style="font-size:13.5px">' + escapeHtml(c.name) + '</b></td>' +
        '<td>' + metricsHtml + '</td>' +
        '<td class="num mut" style="font-size:12px">' + escapeHtml(dateStr) + '</td>' +
        '<td><span class="' + escapeHtml(c.badge_class) + '">' + escapeHtml(c.status_label) + '</span></td>' +
      '</tr>';
    }).join('');
  }

  // Online Tab & Heartbeat
  async function loadOnlineList() {
    try {
      var query = document.getElementById('onlineSearchInput') ? document.getElementById('onlineSearchInput').value : '';
      var res = await fetch('/api/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'online_list', filter: currentOnlineFilter, query: query })
      });
      var data = await res.json().catch(function() { return {}; });
      if (data && data.success && data.rows) {
        renderOnlineTable(data.rows);
        var updated = document.getElementById('onlineLastUpdated');
        if (updated) {
          var now = new Date();
          updated.textContent = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ' WIB';
        }
      }
    } catch (_) {}
  }

  function renderOnlineTable(rows) {
    var tbody = document.getElementById('onlineTableTbody');
    if (!tbody) return;
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">Tidak ada pengguna pada filter ini.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function(u) {
      var dot = u.status_code === 'online' ? '<span class="live"></span>' : '<span class="live" style="background:#F59E0B;box-shadow:none"></span>';
      return '<tr>' +
        '<td><b>' + escapeHtml(u.username) + '</b><span class="mut" style="display:block;font-size:11px">' + escapeHtml(u.role) + '</span></td>' +
        '<td><span class="st ' + (u.status_code === 'online' ? 'g' : 'a') + '">' + dot + escapeHtml(u.status_label) + '</span></td>' +
        '<td class="mono mut" style="font-size:12px">' + escapeHtml(u.page) + '</td>' +
        '<td class="mut">' + escapeHtml(u.device) + '</td>' +
        '<td class="r num">' + escapeHtml(u.session_duration) + '</td>' +
        '<td class="num mut">' + escapeHtml(u.last_seen_formatted) + '</td>' +
      '</tr>';
    }).join('');
  }

  root.filterOnline = function(f, btn) {
    currentOnlineFilter = f;
    var btns = document.querySelectorAll('.ofc');
    btns.forEach(function(b) { b.classList.remove('on'); });
    if (btn) btn.classList.add('on');
    loadOnlineList();
  };

  root.onOnlineSearch = function() {
    loadOnlineList();
  };

  function startAutoRefresh() {
    if (onlineRefreshTimer) clearInterval(onlineRefreshTimer);
    onlineRefreshTimer = setInterval(function() {
      if (document.visibilityState === 'visible' && activeAdminTab === 1) {
        loadOnlineList();
      }
    }, 30000);
  }

  // Maintenance Toggle
  root.toggleMaintenanceMode = function() {
    var btn = document.getElementById('maintenanceSwitchBtn');
    if (!btn) return;
    var isChecked = btn.getAttribute('aria-checked') === 'true';
    var next = !isChecked;
    promptAction({
      title: next ? 'Aktifkan Mode Maintenance?' : 'Matikan Mode Maintenance?',
      body: next ? 'Pengguna non-admin akan dialihkan ke layar pemeliharaan secara instan.' : 'Aplikasi akan kembali dibuka untuk semua pengguna.',
      word: 'MAINTENANCE',
      action: function(reason) {
        btn.setAttribute('aria-checked', next ? 'true' : 'false');
        if (next) btn.classList.add('on');
        else btn.classList.remove('on');
        var banner = document.getElementById('mBanner');
        if (banner) banner.style.display = next ? 'flex' : 'none';
        recordAuditLog('budi', (next ? 'Aktifkan' : 'Nonaktifkan') + ' Mode Maintenance', reason);
      }
    });
  };

  root.saveMaintenanceSettings = function() {
    var msg = document.getElementById('mMessageInput') ? document.getElementById('mMessageInput').value : '';
    recordAuditLog('budi', 'Simpan Pengaturan Maintenance', 'Pesan: ' + msg.slice(0, 30));
    alert('Pengaturan pemeliharaan berhasil disimpan.');
  };

  // Voucher / Kupon Actions
  root.createVoucherAction = function() {
    var codeInput = document.getElementById('vCodeInput');
    var code = codeInput ? (codeInput.value || '').trim().toUpperCase() : '';
    var plan = document.getElementById('vPlanSelect') ? document.getElementById('vPlanSelect').value : 'pro_30';
    var quotaInput = document.getElementById('vQuotaInput');
    var quotaParsed = quotaInput ? parseInt(quotaInput.value, 10) : 1;
    var quota = (Number.isFinite(quotaParsed) && quotaParsed > 0) ? quotaParsed : 1;
    var expInput = document.getElementById('vExpiryInput');
    var exp = expInput ? (expInput.value || '').trim() : '';
    if (!code) { alert('Kode tidak boleh kosong'); return; }

    var planLabel = plan === 'lifetime' ? 'Pro Trader · Lifetime' : (plan === 'pro_90' ? 'Pro Trader · 90 hari' : 'Pro Trader · 30 hari');
    var tbody = document.getElementById('adminCouponsTableTbody') || document.getElementById('vouchersTableTbody');
    if (tbody) {
      var tr = document.createElement('tr');

      var tdCode = document.createElement('td');
      tdCode.className = 'mono';
      tdCode.style.fontWeight = '600';
      tdCode.textContent = code;

      var tdPlan = document.createElement('td');
      tdPlan.className = 'mut';
      tdPlan.textContent = planLabel;

      var tdQuota = document.createElement('td');
      tdQuota.className = 'r num';
      tdQuota.textContent = '0 / ' + quota;

      var tdExp = document.createElement('td');
      tdExp.className = 'num mut';
      tdExp.textContent = exp || '—';

      var tdAction = document.createElement('td');
      tdAction.className = 'r';
      var btn = document.createElement('button');
      btn.className = 'btn sm';
      btn.textContent = 'Nonaktifkan';
      btn.onclick = function() {
        (window.revokeKupon || window.revokeVoucher || root.revokeVoucher)(code);
      };
      tdAction.appendChild(btn);

      tr.appendChild(tdCode);
      tr.appendChild(tdPlan);
      tr.appendChild(tdQuota);
      tr.appendChild(tdExp);
      tr.appendChild(tdAction);

      if (tbody.firstChild) {
        tbody.insertBefore(tr, tbody.firstChild);
      } else {
        tbody.appendChild(tr);
      }
    }
    recordAuditLog('budi', 'Buat Kupon/Akses ' + code, 'Paket: ' + planLabel + ', Kuota: ' + quota);
    alert('Kode ' + code + ' berhasil diterbitkan.');
  };
  root.createKuponAction = root.createVoucherAction;

  root.revokeVoucher = function(code) {
    promptAction({
      title: 'Nonaktifkan Kode ' + code + '?',
      body: 'Pengguna baru tidak akan bisa menukarkan kode ini lagi.',
      word: 'REVOKE',
      action: function(reason) {
        recordAuditLog('budi', 'Nonaktifkan Kode ' + code, reason);
        alert('Kode ' + code + ' telah dinonaktifkan.');
      }
    });
  };
  root.revokeKupon = root.revokeVoucher;

  // Confirmation Dialog
  function promptAction(opts) {
    pendingConfirmAction = opts.action;
    targetConfirmWord = opts.word || 'KONFIRMASI';

    var dTitle = document.getElementById('dialogTitle');
    if (dTitle) dTitle.textContent = opts.title;
    var dBody = document.getElementById('dialogBody');
    if (dBody) dBody.textContent = opts.body;
    var dWord = document.getElementById('dialogWordTarget');
    if (dWord) dWord.textContent = targetConfirmWord;
    var dInput = document.getElementById('dialogConfirmInput');
    if (dInput) dInput.value = '';
    var dReason = document.getElementById('dialogReasonInput');
    if (dReason) dReason.value = '';
    var dSubmit = document.getElementById('dialogSubmitBtn');
    if (dSubmit) dSubmit.disabled = true;

    var overlay = document.getElementById('confirmDialogOverlay');
    if (overlay) {
      overlay.style.display = 'grid';
      if (dInput) dInput.focus();
    }
  }

  root.checkConfirmWord = function() {
    var dInput = document.getElementById('dialogConfirmInput');
    var typed = dInput ? (dInput.value || '').trim().toUpperCase() : '';
    var dReason = document.getElementById('dialogReasonInput');
    var reason = dReason ? (dReason.value || '').trim() : '';
    var btn = document.getElementById('dialogSubmitBtn');
    if (btn) {
      btn.disabled = !(typed === targetConfirmWord && reason.length >= 10);
    }
  };

  root.closeConfirmDialog = function() {
    var overlay = document.getElementById('confirmDialogOverlay');
    if (overlay) overlay.style.display = 'none';
    pendingConfirmAction = null;
  };

  root.executeConfirmedAction = function() {
    var dReason = document.getElementById('dialogReasonInput');
    var reason = dReason ? (dReason.value || '').trim() : '';
    if (pendingConfirmAction) {
      pendingConfirmAction(reason);
    }
    root.closeConfirmDialog();
  };

  function recordAuditLog(actor, action, target) {
    var tbody = document.getElementById('auditLogsTbody');
    if (!tbody) return;
    var now = new Date();
    var timeStr = 'Hari ini ' + now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    var tr = document.createElement('tr');

    var tdTime = document.createElement('td');
    tdTime.className = 'num mut';
    tdTime.textContent = timeStr;

    var tdActor = document.createElement('td');
    tdActor.style.fontWeight = '600';
    tdActor.textContent = String(actor || '');

    var tdAction = document.createElement('td');
    tdAction.textContent = String(action || '');

    var tdTarget = document.createElement('td');
    tdTarget.className = 'mono mut';
    tdTarget.textContent = String(target || '');

    tr.appendChild(tdTime);
    tr.appendChild(tdActor);
    tr.appendChild(tdAction);
    tr.appendChild(tdTarget);

    if (tbody.firstChild) {
      tbody.insertBefore(tr, tbody.firstChild);
    } else {
      tbody.appendChild(tr);
    }
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function(m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // Client Heartbeat (60 seconds, only when tab is visible)
  setInterval(function() {
    if (document.visibilityState === 'visible') {
      fetch('/api/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'heartbeat', page: location.pathname, device: 'Browser · Web' })
      }).catch(function() {});
    }
  }, 60000);

  root.initAdminConsole = function() {
    verifyAdminAuth();
  };

  // Auto-init on standalone admin page
  if (typeof window !== 'undefined' && window.location && window.location.pathname.indexOf('admin') !== -1) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', verifyAdminAuth);
    } else {
      verifyAdminAuth();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
