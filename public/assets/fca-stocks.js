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

(function loadUiStabilityFix() {
  'use strict';
  if (typeof document === 'undefined') return;
  function load() {
    if (document.querySelector('script[data-ui-stability-loader]')) return;
    var script = document.createElement('script');
    script.src = '/ui-stability-fix.js?v=20260728-ui-stability-v1';
    script.async = true;
    script.setAttribute('data-ui-stability-loader', 'true');
    document.head.appendChild(script);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();
