(function installSecurityAdminRuntime(root) {
  'use strict';

  if (!root || !root.document || root.__AUTOCUAN_SECURITY_ADMIN_RUNTIME__) return;
  root.__AUTOCUAN_SECURITY_ADMIN_RUNTIME__ = '20260729-security-admin-v1';

  var doc = root.document;
  var loading = false;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char];
    });
  }

  function number(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('id-ID') : '0';
  }

  function when(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Jakarta'
    }).format(date) + ' WIB';
  }

  function pill(label, tone) {
    var classes = {
      green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
      red: 'border-red-500/30 bg-red-500/10 text-red-300',
      amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
      blue: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
      gray: 'border-gray-600 bg-gray-800/60 text-gray-400'
    };
    return '<span class="inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-semibold ' + (classes[tone] || classes.gray) + '">' + esc(label) + '</span>';
  }

  function modeTone(mode) {
    if (mode === 'enforce') return 'green';
    if (mode === 'shadow') return 'amber';
    return 'gray';
  }

  function severityTone(value) {
    if (value === 'critical') return 'red';
    if (value === 'high') return 'amber';
    if (value === 'medium') return 'blue';
    return 'gray';
  }

  function metric(label, value, hint) {
    return '<div class="rounded-xl border border-dark-600/40 bg-dark-700/60 p-3">' +
      '<p class="text-[10px] uppercase tracking-wide text-gray-500">' + esc(label) + '</p>' +
      '<p class="mt-1 text-xl font-bold text-gray-100">' + esc(value) + '</p>' +
      (hint ? '<p class="mt-1 text-[10px] text-gray-500">' + esc(hint) + '</p>' : '') +
      '</div>';
  }

  function reasonText(reasons) {
    var rows = Array.isArray(reasons) ? reasons : [];
    if (!rows.length) return '—';
    return rows.slice(0, 5).map(function (row) {
      return String(row.reason || 'unknown') + ' (' + Number(row.count || 0) + ')';
    }).join(', ');
  }

  function ipCard(item) {
    var active = item.active_block === true;
    var agents = Array.isArray(item.user_agents) ? item.user_agents : [];
    var targets = Array.isArray(item.targets) ? item.targets : [];
    var routes = Array.isArray(item.routes) ? item.routes : [];
    return '<article class="rounded-2xl border ' + (active ? 'border-red-500/30 bg-red-500/[0.04]' : 'border-dark-600/40 bg-[#0f1319]') + ' p-4">' +
      '<div class="flex flex-wrap items-start justify-between gap-3">' +
        '<div><div class="flex flex-wrap items-center gap-2">' +
          '<code class="text-sm font-semibold text-gray-100">' + esc(item.ip || 'tidak tersedia') + '</code>' +
          pill(String(item.severity || 'low').toUpperCase(), severityTone(item.severity)) +
          (active ? pill('DIBLOKIR AKTIF', 'red') : '') +
        '</div>' +
        '<p class="mt-1 text-xs text-gray-500">Terakhir terlihat ' + esc(when(item.last_seen)) + '</p></div>' +
        '<div class="text-right"><p class="text-lg font-bold text-gray-100">' + number(item.hits) + '</p><p class="text-[10px] text-gray-500">percobaan / 24 jam</p></div>' +
      '</div>' +
      '<div class="mt-4 grid gap-3 sm:grid-cols-2">' +
        '<div><p class="text-[10px] uppercase text-gray-500">Target akun tersamarkan</p><p class="mt-1 break-words text-xs text-gray-300">' + esc(targets.join(', ') || '—') + '</p></div>' +
        '<div><p class="text-[10px] uppercase text-gray-500">Alasan</p><p class="mt-1 break-words text-xs text-gray-300">' + esc(reasonText(item.reasons)) + '</p></div>' +
        '<div><p class="text-[10px] uppercase text-gray-500">Route</p><p class="mt-1 break-words text-xs text-gray-300">' + esc(routes.join(', ') || '—') + '</p></div>' +
        '<div><p class="text-[10px] uppercase text-gray-500">Blokir sampai</p><p class="mt-1 text-xs text-gray-300">' + esc(when(item.blocked_until)) + '</p></div>' +
      '</div>' +
      '<details class="mt-3 rounded-xl border border-dark-600/30 bg-dark-800/60 p-3">' +
        '<summary class="cursor-pointer text-xs text-gray-400">User-Agent (' + number(agents.length) + ')</summary>' +
        '<div class="mt-2 space-y-1">' + (agents.length ? agents.map(function (agent) { return '<p class="break-all text-[10px] text-gray-500">' + esc(agent) + '</p>'; }).join('') : '<p class="text-[10px] text-gray-500">Tidak tersedia</p>') + '</div>' +
      '</details>' +
    '</article>';
  }

  function render(payload) {
    var container = doc.getElementById('adminLogsContainer');
    if (!container) return;

    var status = payload.securityStatus || {};
    var summary = payload.securitySummary || {};
    var ips = Array.isArray(summary.suspicious_ips) ? summary.suspicious_ips : [];
    var mode = String(status.mode || 'off');

    var readiness = [];
    readiness.push(pill('MODE ' + mode.toUpperCase(), modeTone(mode)));
    readiness.push(pill(status.available ? 'DATABASE SIAP' : 'DATABASE BELUM SIAP', status.available ? 'green' : 'red'));
    readiness.push(pill(status.pepper_ready ? 'PEPPER SIAP' : 'PEPPER BELUM ADA', status.pepper_ready ? 'green' : 'red'));
    readiness.push(pill(status.alerts_ready ? 'ALERT TELEGRAM SIAP' : 'ALERT BELUM SIAP', status.alerts_ready ? 'green' : 'amber'));
    readiness.push(pill(status.admin_fail_closed ? 'ADMIN FAIL-CLOSED' : 'ADMIN FAIL-OPEN', status.admin_fail_closed ? 'green' : 'amber'));

    var html = '<div class="space-y-4">' +
      '<div class="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4">' +
        '<div class="flex flex-wrap items-center justify-between gap-3">' +
          '<div><h3 class="text-sm font-semibold text-emerald-300">Security Center</h3>' +
          '<p class="mt-1 text-xs leading-relaxed text-gray-500">Percobaan login dicatat server-side. Password, cookie, token, dan device ID tidak pernah ditampilkan.</p></div>' +
          '<button type="button" data-security-refresh class="rounded-lg border border-emerald-500/30 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/10">Muat ulang</button>' +
        '</div>' +
        '<div class="mt-3 flex flex-wrap gap-2">' + readiness.join('') + '</div>' +
        (!status.available ? '<p class="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 text-xs text-amber-300">Security schema belum aktif. Kode tetap aman dalam mode OFF sampai migration dan environment variable dipasang.</p>' : '') +
      '</div>' +
      '<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">' +
        metric('Percobaan mencurigakan', number(summary.total_events_24h), '24 jam terakhir') +
        metric('IP unik', number(summary.unique_ips_24h), '24 jam terakhir') +
        metric('Ditolak/diblokir', number(summary.blocked_events_24h), '24 jam terakhir') +
        metric('Blokir aktif', number(summary.active_blocks), 'berdasarkan waktu server') +
        metric('Target admin', number(summary.admin_target_events_24h), '24 jam terakhir') +
      '</div>' +
      '<div><div class="mb-3 flex items-center justify-between gap-3"><h4 class="text-sm font-semibold text-gray-200">Aktivitas IP mencurigakan</h4><span class="text-xs text-gray-500">Dikelompokkan per IP</span></div>' +
        (ips.length ? '<div class="space-y-3">' + ips.map(ipCard).join('') + '</div>' : '<div class="rounded-2xl border border-dark-600/40 bg-dark-700/40 p-6 text-center text-sm text-gray-500">Belum ada aktivitas mencurigakan dalam 24 jam terakhir.</div>') +
      '</div>' +
    '</div>';

    container.innerHTML = html;
    var refresh = container.querySelector('[data-security-refresh]');
    if (refresh) refresh.addEventListener('click', function () { root.loadSecurityCenter(); });
  }

  async function loadSecurityCenter() {
    if (loading) return;
    loading = true;
    var container = doc.getElementById('adminLogsContainer');
    if (container) container.innerHTML = '<div class="py-8 text-center text-sm text-gray-500">Memuat Security Center…</div>';
    try {
      var response = await root.fetch('/api/admin-logs', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      var payload = null;
      try { payload = await response.json(); } catch (_) {}
      if (!response.ok || !payload || payload.success !== true) {
        throw new Error(payload && payload.error || 'Security Center tidak tersedia.');
      }
      render(payload);
    } catch (error) {
      if (container) container.innerHTML = '<div class="rounded-xl border border-red-500/20 bg-red-500/[0.05] p-4 text-sm text-red-300">' + esc(error && error.message || 'Security Center tidak tersedia.') + '</div>';
    } finally {
      loading = false;
    }
  }

  function installButton() {
    if (doc.querySelector('[data-security-center-button]')) return true;
    var panel = doc.getElementById('adminPanel');
    if (!panel) return false;
    var buttonRow = panel.querySelector('.flex.flex-wrap.gap-2');
    if (!buttonRow) return false;
    var button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute('data-security-center-button', 'true');
    button.className = 'px-4 py-2 rounded-lg text-sm font-medium text-red-300 border border-red-500/30 hover:bg-red-500/10 transition-all';
    button.textContent = '🛡️ Security Center';
    button.addEventListener('click', loadSecurityCenter);
    buttonRow.appendChild(button);
    return true;
  }

  root.loadSecurityCenter = loadSecurityCenter;

  function boot() {
    if (installButton()) return;
    var attempts = 0;
    var timer = root.setInterval(function () {
      attempts += 1;
      if (installButton() || attempts >= 40) root.clearInterval(timer);
    }, 250);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})(typeof window !== 'undefined' ? window : null);
