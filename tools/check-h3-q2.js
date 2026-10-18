'use strict';

const fs = require('fs');
const path = require('path');

const d = JSON.parse(fs.readFileSync('/home/ubuntu/auto-cuan/data/arjum-data/broker-summary/BBCA/2026-09-08.json', 'utf8'));

console.log('Top 3 brokers in all response:');
console.log(JSON.stringify(d.brokers.slice(0, 3), null, 2));

// Check if any broker has foreign fields
let foreignFieldNames = new Set();
d.brokers.forEach(b => {
  Object.keys(b).forEach(k => {
    if (k.toLowerCase().includes('for') || k.toLowerCase().includes('f_') || k.toLowerCase().includes('dom') || k.toLowerCase().includes('type')) {
      foreignFieldNames.add(k);
    }
  });
});

console.log('Foreign/domestic fields found in brokers:', Array.from(foreignFieldNames));
console.log('Top-level keys in all response:', Object.keys(d));
