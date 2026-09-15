'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-t4-'));
const ticker = 'DBGT4';
const dir = path.join(base, 'broker-summary', ticker);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, '2026-09-14.json'), JSON.stringify({
  stock_code: ticker, date: '2026-09-14', broker_start_date: '2026-09-14',
  brokers: [
    { broker_code: 'YP', bval: 1000, bvol: 100, sval: 0, svol: 0 },
    { broker_code: 'CC', bval: 500, bvol: 5, sval: 400, svol: 4 }
  ]
}, null, 2));

process.env.ARJUM_DATA_DIR = base;
const service = require('../lib/bandarmologi-service');

(async () => {
  for (const spec of [['1d', 1], ['5d', 5], ['7d', 7], ['30d', 30]]) {
    const res = await service.getBandarmologiData(ticker, { range: spec[0], days: spec[1] });
    const bs = res.broker_summary || {};
    console.log(spec[0],
      '| label=', bs.range_label,
      '| date=', bs.date,
      '| buy_val=', bs.total_buy_val,
      '| synthetic=', bs.synthetic_scaling,
      '| is_demo=', res.is_demo,
      '| is_empty=', res.is_empty,
      '| from_disk=', res.from_disk);
  }
  fs.rmSync(base, { recursive: true, force: true });
})();
