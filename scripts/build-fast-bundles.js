'use strict';
/**
 * scripts/build-fast-bundles.js
 * ============================================================================
 * V4/V3 Unified Fast-Bundle Builder
 * Delegates to scripts/build-fast-bundle.js
 * ============================================================================
 */
const fastBundle = require('../lib/fast-bundle');
const { runBuild } = require('./build-fast-bundle');

// Retain compatibility symbols for V3-F11 gate:
// fastBundle.buildBundle, fastBundle.BUNDLE_DIR, '_build-summary.json'
const BUNDLE_DIR = fastBundle.BUNDLE_DIR;
const buildBundle = fastBundle.buildBundle;
const SUMMARY_NAME = '_build-summary.json';

if (require.main === module) {
  const summary = runBuild();
  if (summary.fail > 0 && summary.ok === 0) process.exit(1);
}

module.exports = {
  runBuild,
  BUNDLE_DIR,
  buildBundle,
  SUMMARY_NAME
};
