#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const fp = path.join(__dirname, '..', 'public', 'admin-console.html');
let s = fs.readFileSync(fp, 'utf8');
const amp = String.fromCharCode(38);
const oldStr = '<button class="tbtn" onclick="switchAdminTab(5)" data-admin-tab="5">Job ' + amp + 'amp; Data Pipeline</button>';
const newStr = '<button class="tbtn" role="tab" aria-selected="false" onclick="switchAdminTab(6)" data-admin-tab="6">Job ' + amp + 'amp; Data Pipeline</button>';
if (!s.includes(oldStr)) { console.log('NOT FOUND'); process.exit(1); }
s = s.split(oldStr).join(newStr);
fs.writeFileSync(fp, s);
console.log('FIXED admin tab 6 (8 tab unik)');
