'use strict';

// Keep the large, validated endpoint intact while applying one narrow dashboard
// compatibility fix at load time. This does not add a Vercel function.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const sourcePath = path.join(__dirname, '..', 'lib', 'sector-hot-legacy.js');
const virtualPath = path.join(__dirname, 'sector-hot-legacy.virtual.js');
let source = fs.readFileSync(sourcePath, 'utf8');
const oldCode = "return row.is_locked === true || row.locked === true || row.is_final === true || !!row.first_sent_at ||\n    text.indexOf('locked') >= 0 || text.indexOf('final') >= 0;";
const newCode = "var payload = getDashboardLockedRowPayload(row);\n  return row.is_locked === true || row.locked === true || row.is_final === true || !!row.first_sent_at ||\n    !!payload.web_daily_locked_at || !!payload.telegram_daily_sent_at ||\n    text.indexOf('locked') >= 0 || text.indexOf('final') >= 0;";

if (!source.includes(oldCode)) {
  throw new Error('sector-hot dashboard lock patch target not found');
}
source = source.replace(oldCode, newCode);

const compiled = new Module(virtualPath, module);
compiled.filename = virtualPath;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(source, virtualPath);
module.exports = compiled.exports;
