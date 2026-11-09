#!/usr/bin/env node
'use strict';

/**
 * tools/watchdog.js
 * Proxy wrapper pointing to scripts/watchdog.js (FASE V4-F02).
 * Istilah resmi: Kuota API data.
 */

const watchdog = require('../scripts/watchdog');

if (require.main === module) {
  watchdog.main();
}

module.exports = watchdog;
