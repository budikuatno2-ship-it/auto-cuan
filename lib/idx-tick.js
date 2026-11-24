'use strict';

/**
 * lib/idx-tick.js
 * ============================================================================
 * Node-side entry point for the SINGLE official IDX tick-fraction helper.
 *
 * The implementation lives in public/ac-trade-plan.js so the backend engine
 * and the browser table/detail renderers share byte-identical rounding and
 * R/R derivation. This file only re-exports it for `require()` callers.
 * ============================================================================
 */

module.exports = require('../public/ac-trade-plan.js');
