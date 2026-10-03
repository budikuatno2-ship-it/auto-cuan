/**
 * AUTO-CUAN CANONICAL ANALYSIS TOOL REGISTRY
 *
 * Single source of truth for all active analysis destinations across:
 * - App shell sidebar navigation (Riset Pasar)
 * - Standalone Analisis Saham (/analisis-saham)
 * - Mobile navigation drawer
 * - Deep-link router mapping
 *
 * Requirements:
 * - Identical tool names, route keys, and SVG icon semantics
 * - Clean logical subgroups to minimize cognitive load
 * - Strict admin gates (Pattern Radar is never exposed publicly)
 * - Shared across Browser and Node.js test environments
 */

(function (root) {
  'use strict';

  var SVG_ICONS = {
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17V7m5 10V3m5 14v-5m5 5V8"/></svg>',
    bandarmologi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-10M15 5h6v6"/></svg>',
    hunter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 21l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0"/></svg>',
    intel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-13h-7z"/></svg>',
    insider: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l8 4M8 17l8-4M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0M20 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0M8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0"/></svg>',
    financial: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19V5m0 14h16M8 15l3-4 3 2 4-6"/></svg>',
    marketStructure: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="3"/><circle cx="16" cy="16" r="3"/><path d="M10.5 10.5l3 3M16 5v5M5 16h5"/></svg>',
    ranking: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V10h4v10M10 20V4h4v16M16 20v-7h4v7"/></svg>',
    sektor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
    pattern: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>',
    news: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1m2 13a2 2 0 0 1-2-2V7m2 13a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2m-4-3H9M7 16h6M7 8h6m-6 4h10"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 2-2 2m-1.5 1.5L14 9l-1.5-1.5L11 9l-1.5-1.5L8 9M3 21l9-9"/></svg>'
  };

  var SUBGROUPS = [
    { id: 'chart', label: 'Teknikal & Chart' },
    { id: 'flow', label: 'Arus Dana & Bandar' },
    { id: 'intel', label: 'Intelijen & Relasi' },
    { id: 'structure', label: 'Fundamental & Struktur' },
    { id: 'ranking', label: 'Peringkat & Sektor' },
    { id: 'admin', label: 'Khusus Admin' }
  ];

  var REGISTRY = [
    {
      id: 'analisis-chart',
      label: 'Analisis Saham',
      subgroup: 'chart',
      subgroupLabel: 'Teknikal & Chart',
      routeKey: 'analisis-chart',
      standaloneTab: 'analisis-chart',
      sidebarTabId: 'tabAnalisisChart',
      iconSvg: SVG_ICONS.chart,
      description: 'Chart interaktif dan analisis teknikal AI'
    },
    {
      id: 'bandarmologi',
      label: 'Bandarmologi',
      subgroup: 'flow',
      subgroupLabel: 'Arus Dana & Bandar',
      routeKey: 'bandarmologi',
      standaloneTab: 'bandarmologi',
      sidebarTabId: 'tabBandarmologi',
      iconSvg: SVG_ICONS.bandarmologi,
      description: 'Peta akumulasi dan distribusi broker summary'
    },
    {
      id: 'hunter',
      label: 'Broker Hunter',
      subgroup: 'flow',
      subgroupLabel: 'Arus Dana & Bandar',
      routeKey: 'hunter',
      standaloneTab: 'hunter',
      sidebarTabId: 'tabBrokerHunter',
      iconSvg: SVG_ICONS.hunter,
      description: 'Lacak jejak transaksi broker dominan'
    },
    {
      id: 'intel',
      label: 'Sinyal Intelijen',
      subgroup: 'intel',
      subgroupLabel: 'Intelijen & Relasi',
      routeKey: 'intel',
      standaloneTab: 'intel',
      sidebarTabId: 'tabSinyalIntelijen',
      iconSvg: SVG_ICONS.intel,
      description: 'Deteksi anomali volume dan konfluensi sinyal'
    },
    {
      id: 'insider',
      label: 'Jejaring Insider',
      subgroup: 'intel',
      subgroupLabel: 'Intelijen & Relasi',
      routeKey: 'insider',
      standaloneTab: 'insider',
      sidebarTabId: 'tabJejaringInsider',
      iconSvg: SVG_ICONS.insider,
      description: 'Transaksi orang dalam dan kepemilikan direksi/komisaris'
    },
    {
      id: 'financial',
      label: 'Financial',
      subgroup: 'structure',
      subgroupLabel: 'Fundamental & Struktur',
      routeKey: 'financial',
      standaloneTab: 'financial',
      sidebarTabId: 'tabFinancial',
      iconSvg: SVG_ICONS.financial,
      description: 'Laporan keuangan, rasio valuasi, dan neraca emiten'
    },
    {
      id: 'market-structure',
      label: 'Struktur Pasar',
      subgroup: 'structure',
      subgroupLabel: 'Fundamental & Struktur',
      routeKey: 'market-structure',
      standaloneTab: 'market-structure',
      sidebarTabId: 'tabMarketStructure',
      iconSvg: SVG_ICONS.marketStructure,
      description: 'Peta konglomerasi, pengendali, dan free float'
    },
    {
      id: 'ranking',
      label: 'Ranking Harian',
      subgroup: 'ranking',
      subgroupLabel: 'Peringkat & Sektor',
      routeKey: 'ranking',
      standaloneTab: 'ranking',
      sidebarTabId: 'tabRankingHarian',
      badge: 'PRO',
      proRequired: true,
      iconSvg: SVG_ICONS.ranking,
      description: 'Peringkat pasar harian teratas'
    },
    {
      id: 'sektor',
      label: 'Sektor Hot',
      subgroup: 'ranking',
      subgroupLabel: 'Peringkat & Sektor',
      routeKey: 'sektor',
      standaloneTab: null,
      sidebarTabId: 'tabSektorHot',
      iconSvg: SVG_ICONS.sektor,
      description: 'Peta rotasi dan arus modal sektoral'
    },
    {
      id: 'pattern',
      label: 'Pattern Radar',
      subgroup: 'admin',
      subgroupLabel: 'Khusus Admin',
      routeKey: 'pattern',
      standaloneTab: 'pattern',
      sidebarTabId: 'tabAnalisisPattern',
      badge: 'ADMIN',
      adminOnly: true,
      iconSvg: SVG_ICONS.pattern,
      description: 'Deteksi pola chart (khusus admin)'
    }
  ];

  var api = {
    getAll: function () {
      return REGISTRY.slice();
    },
    getActive: function (isAdmin) {
      return REGISTRY.filter(function (tool) {
        return !tool.adminOnly || isAdmin;
      });
    },
    getSubgroups: function () {
      return SUBGROUPS.slice();
    },
    getById: function (id) {
      for (var i = 0; i < REGISTRY.length; i++) {
        if (REGISTRY[i].id === id || REGISTRY[i].routeKey === id || REGISTRY[i].standaloneTab === id) {
          return REGISTRY[i];
        }
      }
      return null;
    },
    getIcons: function () {
      return SVG_ICONS;
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.AutoCuanToolRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
