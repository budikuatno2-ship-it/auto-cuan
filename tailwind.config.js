'use strict';

// Build config for public/tailwind-build.css.
//
// Auto-Cuan used to load the Tailwind Play CDN, which compiles CSS in the
// browser by watching the DOM. That handled classes assembled at runtime for
// free, but cost ~400KB of JavaScript on every load and made an external host a
// hard dependency for the entire layout.
//
// Building the sheet ahead of time means the extractor only sees source text,
// so any class that is assembled from fragments at runtime has to be listed in
// `safelist` below. Each entry names where it comes from.
//
//   npx tailwindcss@3 -c tailwind.config.js -i tailwind.src.css \
//     -o public/tailwind-build.css --minify
//
// tools/apply-production-hotfixes.js fails the build if a class that the
// rendered DOM uses is missing from the generated sheet.

module.exports = {
  content: ['./public/**/*.html', './public/**/*.js'],
  safelist: [
    // renderRankingTable() builds `text-` + col.align for every column.
    'text-left', 'text-right', 'text-center',
    // Column count for the ranking/table grids is chosen at render time.
    'grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4', 'grid-cols-5',
    'sm:grid-cols-2', 'sm:grid-cols-3', 'sm:grid-cols-4',
    'lg:grid-cols-2', 'lg:grid-cols-3', 'lg:grid-cols-4', 'lg:grid-cols-5',
    // Screener/dashboard status colours are chosen from data at render time.
    'text-emerald-300', 'text-emerald-400', 'text-emerald-500',
    'text-red-300', 'text-red-400', 'text-amber-300', 'text-amber-400',
    'text-blue-300', 'text-blue-400', 'text-purple-300', 'text-purple-400',
    'text-orange-400', 'text-cyan-300', 'text-gray-300', 'text-gray-400', 'text-gray-500',
    'bg-emerald-500/10', 'bg-emerald-500/15', 'bg-emerald-500/20',
    'bg-blue-500/10', 'bg-blue-500/15', 'bg-red-500/10', 'bg-red-500/15',
    'bg-amber-500/10', 'bg-amber-500/15', 'bg-purple-500/10', 'bg-purple-500/15',
    'bg-orange-500/10', 'bg-orange-500/15', 'bg-gray-500/10'
  ],
  theme: {
    extend: {
      colors: {
        // Carried over verbatim from the inline tailwind.config the CDN used.
        dark: { 900: '#0b0e14', 800: '#0f1319', 700: '#151a23', 600: '#1c2333', 500: '#242d3d' }
      }
    }
  }
};
