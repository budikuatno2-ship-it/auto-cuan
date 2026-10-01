'use strict';

/**
 * Background Broker Hunter Indexer
 *
 * Aggregates the 957-stock broker summaries into pre-computed JSON indices
 * for all major brokers for ranges: 1d, 7d, 30d.
 *
 * Usage:
 *   node tools/run-broker-hunter-indexer.js
 *   node tools/run-broker-hunter-indexer.js --ranges 1d,7d
 *   node tools/run-broker-hunter-indexer.js --brokers AK,BK,CC,YP,RX
 */

const path = require('node:path');
const brokerHunterService = require('../lib/broker-hunter-service');

async function main(argv = process.argv.slice(2)) {
  let ranges = ['1d', '7d', '30d'];
  const rangeIdx = argv.indexOf('--ranges');
  if (rangeIdx >= 0 && argv[rangeIdx + 1]) {
    ranges = argv[rangeIdx + 1].split(',').map(r => r.trim()).filter(Boolean);
  }

  let brokers = Object.keys(brokerHunterService.BROKER_NAMES);
  const brokerIdx = argv.indexOf('--brokers');
  if (brokerIdx >= 0 && argv[brokerIdx + 1]) {
    brokers = argv[brokerIdx + 1].split(',').map(b => b.trim().toUpperCase()).filter(Boolean);
  }

  console.log('=== AUTO-CUAN BROKER HUNTER INDEXER ===');
  console.log(`Ranges: ${ranges.join(', ')}`);
  console.log(`Brokers: ${brokers.length} brokers (${brokers.slice(0, 8).join(', ')}...)`);
  console.log(`Output Directory: ${brokerHunterService.HUNTER_CACHE_DIR}`);
  console.log('Starting indexing...\n');

  const start = Date.now();
  const summary = await brokerHunterService.generateBrokerHunterIndex({ ranges, brokers });
  const duration = ((Date.now() - start) / 1000).toFixed(2);

  console.log(`✅ Indexing completed in ${duration}s!`);
  console.log(`- Brokers Indexed: ${summary.brokers_indexed}`);
  console.log(`- Files Written: ${summary.files_written}`);

  return summary;
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal indexing error:', err);
    process.exit(1);
  });
}

module.exports = { main };
