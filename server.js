'use strict';

/**
 * Auto-Cuan Local Development Server Entry Point
 * Used by npm run dev ("node --watch server.js")
 *
 * FASE V4-F03: Penyatuan Single-Shell SPA (Basmi Dual-Render /admin-console & /analisis-saham)
 * Seluruh rute aplikasi selalu disajikan melalui public/index.html (Workstation Shell).
 */
const quotaManager = require('./lib/quota-manager');
const server = require('./tools/local-dev-server.js');

/**
 * Daftar kanonikal seluruh rute aplikasi yang disajikan ke Workstation Shell SPA.
 * Rute standalone (admin.html, cockpit usang) dibasmi total dari HTTP delivery.
 */
const SPA_SHELL_ROUTES = [
  '/',
  '/index.html',
  '/dashboard',
  '/screener',
  '/watchlist',
  '/sektor',
  '/sektor-hot',
  '/catatan',
  '/catatan-admin',
  '/ranking',
  '/financial',
  '/struktur-pasar',
  '/market-structure',
  '/portfolio',
  '/portofolio',
  '/portfolio-command-center',
  '/portfolio-planner',
  '/kelola-keuangan',
  '/money-management',
  '/pattern',
  '/pattern-radar',
  '/review',
  '/analisis',
  '/analisis-saham',
  '/admin',
  '/admin-console',
  '/admin.html',
  '/admin-console.html',
  '/analisis-saham.html',
  '/chart',
  '/broksum',
  '/broker-summary',
  '/bandarmologi',
  '/track-record',
  '/trackrecord'
];

module.exports = {
  server,
  quotaManager,
  SPA_SHELL_ROUTES
};
