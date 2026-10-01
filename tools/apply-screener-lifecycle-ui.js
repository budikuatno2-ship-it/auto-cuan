'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = '/screener-lifecycle-ui.js?v=20260816-v1';
const INDEX_MARKER = '<script src="' + SCRIPT_PATH + '"></script>';

function applyIndexPatch(targetPath) {
  const source = fs.readFileSync(targetPath, 'utf8');
  if (source.includes(INDEX_MARKER)) return { changed: false, targetPath };
  if (!source.includes('</body>')) throw new Error('index body closing tag not found');
  const next = source.replace(/<\/body>\s*<\/html>\s*$/, INDEX_MARKER + '\n</body>\n</html>\n');
  if (next === source) throw new Error('lifecycle UI script injection failed');
  fs.writeFileSync(targetPath, next, 'utf8');
  return { changed: true, targetPath };
}

function applyAll(rootDir) {
  const root = rootDir || path.join(__dirname, '..');
  return applyIndexPatch(path.join(root, 'public', 'index.html'));
}

if (require.main === module) {
  const result = applyAll();
  console.log('SCREENER_LIFECYCLE_UI=' + (result.changed ? 'APPLIED' : 'ALREADY_PRESENT'));
}

module.exports = {
  SCRIPT_PATH,
  INDEX_MARKER,
  applyIndexPatch,
  applyAll
};
