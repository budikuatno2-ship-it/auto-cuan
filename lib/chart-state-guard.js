'use strict';

/**
 * lib/chart-state-guard.js
 * ============================================================================
 * Server-side entry point for the V5 P0-009 / P1-024 chart identity guard.
 * ============================================================================
 *
 * The implementation lives in `public/chart-state-guard.js` because the static
 * asset responder (`lib/static-assets.js`) only serves `public/`, and the
 * browser modules (`unified-cockpit-runtime`, `analisis-v2`,
 * `chart-analysis-runtime`, `market-feature-runtime`) must be able to load the
 * guard with a plain `<script src="/chart-state-guard.js">`.
 *
 * Re-exporting (instead of copying) guarantees the tested module and the served
 * module are literally the same object. `test/v5/chart-state-guard.test.js`
 * asserts that identity, so the two paths can never drift.
 * ============================================================================
 */

module.exports = require('../public/chart-state-guard.js');