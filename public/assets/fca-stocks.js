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
      append('/admin-tools-runtime.js?v=20260803-admin-tools-v2', 'data-admin-tools-loader');
    });

    // Load the original navigation and shared chart viewer first, then one
    // consolidated real-device stabilizer. This avoids competing runtime patches.
    append('/mobile-nav.js?v=20260802-mobile-nav-v2', 'data-mobile-nav-loader', function () {
      append('/chart-viewer.js?v=20260802-chart-viewer-v1', 'data-chart-viewer-loader', function () {
        append('/mobile-ui-runtime-v5.js?v=20260803-mobile-ui-runtime-v5', 'data-mobile-ui-runtime-v5-loader', function () {
          append('/mobile-ui-runtime-v6.js?v=20260803-mobile-ui-runtime-v6', 'data-mobile-ui-runtime-v6-loader');
        });
      });
    });

    // Dashboard presentation now exposes only the already-computed final Top 5.
    // It does not recalculate candidates or read individual screener outputs.
    append('/dashboard-top5-only-ui.js?v=20260803-top5-only-ui-v1', 'data-dashboard-top5-only-ui-loader');

    // UI, resume and SVG rendering remain parallel. Pattern's safety hardening is
    // the only prerequisite: it installs a setter before the safety model is
    // assigned, so null/blank/boolean values can never be coerced into a numeric
    // zero during trade-plan or pattern-level decisions. Once that tiny local
    // module is ready, safety/runtime/extension still load in parallel.
    append('/ui-stability-fix.js?v=20260802-ui-stability-v2', 'data-ui-stability-loader');
    append('/pattern-tab-resume-guard.js?v=20260802-pattern-tab-resume-v2', 'data-pattern-tab-resume-loader');
    append('/pattern-visual.js?v=20260813-pattern-visual-v1', 'data-pattern-visual-loader');
    append('/pattern-safety-hardening-v1.js?v=20260813-v1', 'data-pattern-safety-hardening-loader', function () {
      append('/pattern-direction-safety.js?v=20260813-pattern-direction-safety-v2', 'data-pattern-direction-safety-loader');
      append('/pattern-stable-runtime.js?v=20260813-pattern-stable-v6', 'data-pattern-stable-loader');
      append('/pattern-screener-extension.js?v=20260813-pattern-screener-v7', 'data-pattern-screener-extension-loader');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();
