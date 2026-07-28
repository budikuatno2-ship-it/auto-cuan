// FCA (Full Call Auction) / Papan Pemantauan Khusus Stock Mapping
// ============================================================
// LEGACY FILE — kept for old UI compatibility only.
// This file is NOT the source of truth for board/FCA status.
// Source of truth: Supabase stock_boards table → exposed via /api/quote boardResult.
//
// Risk Guard and server-side analysis use ONLY boardResult from Supabase.
// This file is used ONLY by the frontend isFCAStock() for quick UI hints.
// If Supabase board data contradicts this file, Supabase wins.
//
// Corrections applied 2025-06:
//   - NAYZ removed: actual board = AKSELERASI (not Pemantauan Khusus)
//   - WMUU removed: actual board = PENGEMBANGAN (not Pemantauan Khusus, not FCA)
//
// Only keep tickers here if they are CONFIRMED Pemantauan Khusus / FCA
// from official BEI/IDX announcement AND verified in Supabase stock_boards.
// ============================================================
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

// The Pattern Radar is an optional admin-only presentation module. Load it
// after the base document exists so it can safely attach to the existing nav,
// Pattern authorization gate, and Technical Chart functions without blocking
// the initial dashboard render.
(function loadPatternRadar() {
  if (typeof document === 'undefined') return;
  function load() {
    if (document.querySelector('script[data-pattern-radar-loader]')) return;
    var script = document.createElement('script');
    script.src = '/pattern-radar.js?v=20260728-radar2';
    script.async = true;
    script.setAttribute('data-pattern-radar-loader', 'true');
    document.head.appendChild(script);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();

// Defense in depth for exact session expiry. PatternMapAdminAccess owns the
// signed-session clock; this small watcher removes the discovery UI as soon as
// that gate is no longer fresh, even when the page stays open without focus or
// visibility events.
(function watchPatternRadarAccess() {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof window.setInterval !== 'function') return;
  window.setInterval(function () {
    var gate = window.PatternMapAdminAccess;
    if (!gate || typeof gate.isAllowed !== 'function' || gate.isAllowed()) return;
    ['patternRadarDesktopNav', 'patternRadarMobileNav'].forEach(function (id) {
      var nav = document.getElementById(id);
      if (nav) nav.remove();
    });
    var page = document.getElementById('page-pattern');
    if (!page || page.classList.contains('hidden')) return;
    page.classList.add('hidden');
    if (typeof window.navigateTo === 'function') window.navigateTo('chart');
  }, 1000);
})();
