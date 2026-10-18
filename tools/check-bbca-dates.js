'use strict';

const fs = require('fs');
const path = require('path');

const baseDir = '/home/ubuntu/auto-cuan/data/arjum-data';
const broksumDir = path.join(baseDir, 'broker-summary');

['2026-09-04.json', '2026-09-25.json', '2026-09-11.json'].forEach(f => {
  const p = path.join(broksumDir, 'BBCA', f);
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf8');
    const d = JSON.parse(raw);
    console.log(f, {
      all_data: d.all_data,
      flow: d.flow,
      brokers_count: d.brokers ? d.brokers.length : 0,
      levels_count: d.broker_levels ? d.broker_levels.length : 0,
      sample_top_buyer: d.brokers ? d.brokers[0] : (d.broker_levels && d.broker_levels[0] ? d.broker_levels[0].buy : null)
    });
  } else {
    console.log(f, 'NOT_EXISTS');
  }
});
