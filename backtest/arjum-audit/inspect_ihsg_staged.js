'use strict';
const fs = require('fs');
const p = '/home/ubuntu/auto-cuan/data/arjum-data/_staging/ihsg-test/IHSG.json';
const res = JSON.parse(fs.readFileSync(p, 'utf8'));
const rows = res.data && (res.data.rows || res.data);
console.log('Sample first row:', rows[0]);
console.log('Sample last row:', rows[rows.length - 1]);
