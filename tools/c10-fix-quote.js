'use strict';
// C10 fix: perbaiki referensi cached/cachedQuote yang bisa ReferenceError + lengkapi TS board cache.
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'api', 'quote.js');
let s = fs.readFileSync(p, 'utf8');
// Ganti pola generik dengan aman: pakai (typeof cachedQuote !== 'undefined' ? (cached || cachedQuote) : cached)
s = s.split('c10EtagForPayload(cached || cachedQuote)').join("c10EtagForPayload((typeof cachedQuote !== 'undefined' && cachedQuote) ? cachedQuote : (typeof cached !== 'undefined' ? cached : null))");
fs.writeFileSync(p, s);
console.log('quote fixed:', !s.includes('cached || cachedQuote'));
