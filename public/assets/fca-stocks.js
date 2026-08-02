// FCA (Full Call Auction) / Papan Pemantauan Khusus Stock Mapping
// LEGACY UI HINT ONLY. Supabase stock_boards via /api/quote remains the source of truth.
window.FCA_STOCKS = {
  "LUCK": { name: "Sentral Mitra Informatika Tbk.", reason: "Papan Pemantauan Khusus" },
  "MAHA": { name: "Mahaka Radio Integra Tbk.", reason: "Papan Pemantauan Khusus" },
  "RATU": { name: "Mitra Tirta Buwana Tbk.", reason: "Papan Pemantauan Khusus" },
  "ZBRA": { name: "Zebra Nusantara Tbk.", reason: "Papan Pemantauan Khusus" },
  "GHON": { name: "Gihon Telekomunikasi Indonesia Tbk.", reason: "Papan Pemantauan Khusus" },
  "CLAY": { name: "Citra Putra Realty Tbk.", reason: "Papan Pemantauan Khusus" },
  "KOTA": { name: "DMS Propertindo Tbk.", reason: "Papan Pemantauan Khusus" },
  "BOSS": { name: "Borneo Olah Sarana Sukses Tbk.", reason: "Papan Pemantauan Khusus" }
};

(function loadStablePatternRuntime() {
  'use strict';
  if (typeof document === 'undefined') return;
  function append(src, marker, onload) {
    var existing = document.querySelector('script[' + marker + ']');
    if (existing) { if (onload) onload(); return; }
    var script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.setAttribute(marker, 'true');
    if (onload) script.onload = onload;
    document.head.appendChild(script);
  }
  function load() {
    // Independent admin-only enhancement. Loading it never gates Pattern or the
    // rest of the website; its API remains protected by the signed admin session.
    append('/security-admin-runtime.js?v=20260729-security-admin-v1', 'data-security-admin-loader', function () {
      append('/admin-tools-runtime.js?v=20260731-admin-tools-v1', 'data-admin-tools-loader');
    });
    // Mobile bottom navigation. Independent of Pattern: it mirrors whatever
    // #mainNav currently exposes, so it never gates or unlocks a destination.
    append('/mobile-nav.js?v=20260802-mobile-nav-v1', 'data-mobile-nav-loader');
    append('/ui-stability-fix.js?v=20260802-ui-stability-v2', 'data-ui-stability-loader', function () {
      append('/pattern-tab-resume-guard.js?v=20260802-pattern-tab-resume-v2', 'data-pattern-tab-resume-loader', function () {
        append('/pattern-stable-runtime.js?v=20260802-pattern-stable-v4', 'data-pattern-stable-loader', function () {
          append('/pattern-screener-extension.js?v=20260728-pattern-screener-v5&rev=20260729-pattern-screener-v6', 'data-pattern-screener-extension-loader', function () {
            append('/pattern-direction-safety.js?v=20260731-pattern-direction-safety-v1', 'data-pattern-direction-safety-loader');
          });
        });
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();
