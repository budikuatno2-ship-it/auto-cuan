'use strict';

/**
 * Next.js Standalone Configuration — Auto-Cuan VPS Production
 * ============================================================
 * - output: 'standalone' menghasilkan .next/standalone/server.js yang ringan
 *   dan self-contained (hanya butuh node_modules minimal + .next/static).
 * - Memori stabil <100MB karena tidak membawa dev dependencies dan
 *   menggunakan output tracing.
 * - Kompatibel dengan PM2: PORT=3000 HOSTNAME=127.0.0.1
 *
 * Catatan: Proyek saat ini menggunakan vanilla HTML + Express-like
 * local-dev-server (tools/local-dev-server.js) sebagai origin utama.
 * File ini disiapkan untuk migrasi bertahap ke Next.js App Router
 * tanpa memutus build Vercel yang sudah ada. Jika Next.js belum
 * terinstal, `npm run build` tetap menjalankan test suite via
 * tools/run-build-test-suite.js (lihat package.json).
 */

 /** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Kompresi gzip ditangani Nginx (langkah 2), Next tetap aktifkan compress
  // untuk fallback saat dijalankan tanpa reverse proxy.
  compress: true,
  // Minimal tracing untuk standalone yang ringan
  outputFileTracing: true,
  // Strict mode untuk stabilitas
  reactStrictMode: true,
  // Powered-by header dimatikan untuk keamanan
  poweredByHeader: false,
  // Env yang diteruskan ke standalone server
  env: {
    NEXT_STANDALONE: 'true',
  },
  // Headers keamanan (mirror vercel.json)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
