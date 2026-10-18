'use strict';

const fs = require('fs');
const path = require('path');
const baseDir = '/home/ubuntu/auto-cuan/data/arjum-data';

const bFiles = [
  path.join(baseDir, 'broker-summary', 'BBCA', '2026-09-11.json'),
  path.join(baseDir, 'broker-summary', 'BBCA', '2026-09-25.json')
];

bFiles.forEach(f => {
  if (fs.existsSync(f)) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    console.log(f, {
      all_data: d.all_data,
      flow: d.flow,
      total_turnover: d.total_turnover,
      total_volume: d.total_volume,
      brokers_count: d.brokers ? d.brokers.length : 0,
      levels_count: d.broker_levels ? d.broker_levels.length : 0
    });
  }
});
