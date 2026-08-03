'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = '/ui-bugfix-pack-v1.js?v=20260803-v1';
const INDEX_MARKER = '<script src="' + SCRIPT_PATH + '"></script>';
const PORTFOLIO_ASSET = "'/ui-bugfix-pack-v1.js?v=20260803-v1'";

function applyIndexPatch(targetPath) {
  const source = fs.readFileSync(targetPath, 'utf8');
  if (source.includes(INDEX_MARKER)) return { changed: false, targetPath };
  if (!source.includes('</body>')) throw new Error('index body closing tag not found');
  const next = source.replace(/<\/body>\s*<\/html>\s*$/, INDEX_MARKER + '\n</body>\n</html>\n');
  if (next === source) throw new Error('index script injection failed');
  fs.writeFileSync(targetPath, next, 'utf8');
  return { changed: true, targetPath };
}

function applyPortfolioPatch(targetPath) {
  const source = fs.readFileSync(targetPath, 'utf8');
  if (source.includes(PORTFOLIO_ASSET)) return { changed: false, targetPath };
  const anchor = "'/portfolio-runtime-fix.js?v=20260728-portfolio-runtime-fix-v1'";
  if (!source.includes(anchor)) throw new Error('portfolio asset anchor not found');
  const next = source.replace(anchor, anchor + ',\n    ' + PORTFOLIO_ASSET);
  fs.writeFileSync(targetPath, next, 'utf8');
  return { changed: true, targetPath };
}

function applyAll(rootDir) {
  const root = rootDir || path.join(__dirname, '..');
  return {
    index: applyIndexPatch(path.join(root, 'public', 'index.html')),
    portfolio: applyPortfolioPatch(path.join(root, 'public', 'portfolio-command-center-v2.html'))
  };
}

if (require.main === module) {
  const result = applyAll();
  console.log('UI_BUGFIX_INDEX=' + (result.index.changed ? 'APPLIED' : 'ALREADY_PRESENT'));
  console.log('UI_BUGFIX_PORTFOLIO=' + (result.portfolio.changed ? 'APPLIED' : 'ALREADY_PRESENT'));
}

module.exports = {
  SCRIPT_PATH,
  INDEX_MARKER,
  PORTFOLIO_ASSET,
  applyIndexPatch,
  applyPortfolioPatch,
  applyAll
};
