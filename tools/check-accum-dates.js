'use strict';

const fs = require('fs');
const path = require('path');

const baseDir = '/home/ubuntu/auto-cuan/data/arjum-data';
const accumDir = path.join(baseDir, 'broker-accumulation');

const bbcaAccum = JSON.parse(fs.readFileSync(path.join(accumDir, 'BBCA', 'series.json'), 'utf8'));

const yuSeries = bbcaAccum.series.find(s => s.broker_code === 'YU');
console.log('start_date:', bbcaAccum.start_date);
console.log('end_date:', bbcaAccum.end_date);
console.log('total_nval in top_buyers:', bbcaAccum.top_buyers.find(b => b.broker_code === 'YU'));
console.log('points[0]:', yuSeries.points[0]);
console.log('points[1]:', yuSeries.points[1]);
console.log('points[last]:', yuSeries.points[yuSeries.points.length - 1]);

// Check sum of nval across all points in points array
const sumNval = yuSeries.points.reduce((acc, p) => acc + p.nval, 0);
console.log('Sum of nval across all 80 points:', sumNval);
console.log('Difference between sumNval and total_nval in header:', sumNval - bbcaAccum.top_buyers.find(b => b.broker_code === 'YU').total_nval);
