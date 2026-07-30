(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VERSION = '20260731-admin-tools-v1';

  function securityMissingSteps(text) {
    var value = String(text == null ? '' : text).toUpperCase();
    var steps = [];
    if (value.indexOf('DATABASE BELUM SIAP') >= 0) {
      steps.push({ key:'database', title:'Aktifkan database security', detail:'Jalankan migration supabase/security-phase-1-migration.sql pada project Supabase produksi.' });
    }
    if (value.indexOf('PEPPER BELUM ADA') >= 0) {
      steps.push({ key:'pepper', title:'Pasang pepper rahasia', detail:'Tambahkan SECURITY_EVENT_PEPPER minimal 32 karakter pada environment produksi. Nilainya tidak boleh ditaruh di source code atau browser.' });
    }
    if (value.indexOf('MODE OFF') >= 0) {
      steps.push({ key:'mode', title:'Mulai dalam mode shadow', detail:'Set SECURITY_GUARD_MODE=shadow setelah database dan pepper siap. Evaluasi log sebelum beralih ke enforce.' });
    }
    if (value.indexOf('ADMIN FAIL-OPEN') >= 0) {
      steps.push({ key:'admin', title:'Aktifkan proteksi admin', detail:'Set SECURITY_GUARD_FAIL_CLOSED_ADMIN=1 setelah mode shadow terbukti stabil agar serangan ke akun admin tidak dibiarkan lewat.' });
    }
    if (value.indexOf('ALERT BELUM SIAP') >= 0) {
      steps.push({ key:'alert', title:'Siapkan alert Telegram', detail:'Opsional tetapi disarankan: SECURITY_ALERTS_ENABLED=1, SECURITY_TELEGRAM_BOT_TOKEN, dan SECURITY_TELEGRAM_CHAT_ID khusus keamanan.' });
    }
    return steps;
  }

  function buttonRow(doc) {
    var panel = doc && doc.getElementById('adminPanel');
    return panel && panel.querySelector('.flex.flex-wrap.gap-2');
  }

  function makeForeignButton(root, doc) {
    if (doc.querySelector('[data-admin-foreign-button]')) return true;
    var row = buttonRow(doc);
    if (!row) return false;
    var button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute('data-admin-foreign-button', 'true');
    button.className = 'px-4 py-2 rounded-lg text-sm font-medium text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/10 transition-all';
    button.textContent = '🌐 Foreign Data';
    button.addEventListener('click', function () {
      root.location.assign('/admin-foreign.html');
    });
    var security = row.querySelector('[data-security-center-button]');
    security ? row.insertBefore(button, security) : row.appendChild(button);
    return true;
  }

  function guideHtml(steps) {
    var list = steps.map(function (step) {
      return '<li class="rounded-xl border border-dark-600/40 bg-dark-800/50 p-3">' +
        '<p class="text-xs font-semibold text-gray-200">' + step.title + '</p>' +
        '<p class="mt-1 text-[11px] leading-relaxed text-gray-500">' + step.detail + '</p>' +
      '</li>';
    }).join('');
    return '<details class="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-4" data-security-setup-guide open>' +
      '<summary class="cursor-pointer text-sm font-semibold text-amber-300">Aktivasi Security Center belum selesai</summary>' +
      '<p class="mt-2 text-xs leading-relaxed text-gray-500">Status merah/kuning di atas bukan bug tampilan. Proteksi sengaja tetap OFF sampai migration dan environment produksi benar-benar siap.</p>' +
      '<ol class="mt-3 grid gap-2 sm:grid-cols-2">' + list + '</ol>' +
      '<p class="mt-3 text-[11px] text-gray-500">Jangan memasukkan pepper, token, password database, atau chat ID ke halaman ini. Semua nilai rahasia harus dipasang langsung pada environment server.</p>' +
    '</details>';
  }

  function enhanceSecurityGuide(doc) {
    var container = doc && doc.getElementById('adminLogsContainer');
    if (!container) return false;
    var text = String(container.textContent || '');
    if (text.indexOf('Security Center') < 0) return false;
    var steps = securityMissingSteps(text);
    var existing = container.querySelector('[data-security-setup-guide]');
    if (!steps.length) {
      if (existing) existing.remove();
      return true;
    }
    if (existing) return true;
    var host = doc.createElement('div');
    host.innerHTML = guideHtml(steps);
    var guide = host.firstElementChild;
    if (!guide) return false;
    var first = container.firstElementChild;
    if (first) first.insertAdjacentElement('afterend', guide);
    else container.appendChild(guide);
    return true;
  }

  function install(root) {
    if (!root || !root.document || root.__AUTOCUAN_ADMIN_TOOLS_RUNTIME__) return false;
    root.__AUTOCUAN_ADMIN_TOOLS_RUNTIME__ = VERSION;
    var doc = root.document;
    var scheduled = false;

    function sync() {
      makeForeignButton(root, doc);
      enhanceSecurityGuide(doc);
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      root.setTimeout(function () {
        scheduled = false;
        sync();
      }, 40);
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', sync, { once:true });
    else sync();

    new root.MutationObserver(schedule).observe(doc.body, { childList:true, subtree:true });
    return true;
  }

  return {
    version:VERSION,
    securityMissingSteps:securityMissingSteps,
    guideHtml:guideHtml,
    install:install
  };
});
