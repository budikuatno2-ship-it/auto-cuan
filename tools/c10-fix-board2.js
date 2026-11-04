'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'api', 'quote.js');
let s = fs.readFileSync(p, 'utf8');
const bad = "      try {\n        if (c10FileCache) { BOARD_LOCAL_CACHE = c10FileCache.getJsonFile(filePath, 30000).data; }\n        else { BOARD_LOCAL_CACHE = JSON.parse(fs.readFileSync(filePath, 'utf8')); }\n      BOARD_LOCAL_CACHE_TS = Date.now();";
const good = "      if (c10FileCache) { BOARD_LOCAL_CACHE = c10FileCache.getJsonFile(filePath, 30000).data; }\n      else { BOARD_LOCAL_CACHE = JSON.parse(fs.readFileSync(filePath, 'utf8')); }\n      BOARD_LOCAL_CACHE_TS = Date.now();";
if (s.includes(bad)) { s = s.replace(bad, good); fs.writeFileSync(p, s); console.log('board fixed'); }
else console.log('pattern not found');
