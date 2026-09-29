'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
let count = 0;
for (const match of fs.readFileSync('public/index.html', 'utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
  if (/\bsrc\s*=|application\/(?:ld\+)?json/i.test(match[1]) || !match[2].trim()) continue;
  new vm.Script(match[2], { filename: 'index-inline-' + (++count) });
}
console.log(count + ' inline JavaScript blocks parsed.');
