'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'api', 'quote.js');
let s = fs.readFileSync(p, 'utf8');
const oldBlock = "    var filePath = path.join(__dirname, '..', 'data', 'arjum-data', 'stock-boards.json');\n    if (fs.existsSync(filePath)) {\n      BOARD_LOCAL_CACHE = JSON.parse(fs.readFileSync(filePath, 'utf8'));";
const newBlock = "    var filePath = path.join(__dirname, '..', 'data', 'arjum-data', 'stock-boards.json');\n    if (fs.existsSync(filePath)) {\n      try {\n        if (c10FileCache) { BOARD_LOCAL_CACHE = c10FileCache.getJsonFile(filePath, 30000).data; }\n        else { BOARD_LOCAL_CACHE = JSON.parse(fs.readFileSync(filePath, 'utf8')); }";
if (s.includes(oldBlock)) {
  s = s.replace(oldBlock, newBlock);
  fs.writeFileSync(p, s);
  console.log('board wired');
} else console.log('board already wired or pattern missing');
