'use strict';

const fs = require('fs');
const path = require('path');

const baseDir = '/home/ubuntu/auto-cuan/data/arjum-data';
const accumDir = path.join(baseDir, 'broker-accumulation');
const broksumDir = path.join(baseDir, 'broker-summary');

const bbcaAccum = JSON.parse(fs.readFileSync(path.join(accumDir, 'BBCA', 'series.json'), 'utf8'));

// Check broker YU
const yuSeries = bbcaAccum.series.find(s => s.broker_code === 'YU');
const comparisons = [];

if (yuSeries && yuSeries.points) {
  for (let i = yuSeries.points.length - 1; i >= Math.max(0, yuSeries.points.length - 10); i--) {
    const pt = yuSeries.points[i];
    const dFile = path.join(broksumDir, 'BBCA', `${pt.date}.json`);
    let dayBval = null, daySval = null, dayNval = null, dayBvol = null, daySvol = null, dayNvol = null;
    let bavg = null, savg = null;
    if (fs.existsSync(dFile)) {
      const dData = JSON.parse(fs.readFileSync(dFile, 'utf8'));
      if (Array.isArray(dData.brokers)) {
        const b = dData.brokers.find(x => x.broker_code === 'YU');
        if (b) {
          dayBval = b.bval;
          daySval = b.sval;
          dayNval = b.nval !== undefined ? b.nval : (b.bval - b.sval);
          dayBvol = b.bvol;
          daySvol = b.svol;
          dayNvol = b.nvol !== undefined ? b.nvol : (b.bvol - b.svol);
          bavg = b.bavg;
          savg = b.savg;
        }
      }
    }

    comparisons.push({
      date: pt.date,
      pointNval: pt.nval,
      broksumNval: dayNval,
      diffNval: pt.nval - dayNval,
      pointNvol: pt.nvol,
      broksumNvol: dayNvol,
      diffNvol: pt.nvol - dayNvol,
      pointBavg: pt.bavg,
      broksumBavg: bavg
    });
  }
}

console.log(JSON.stringify(comparisons, null, 2));
