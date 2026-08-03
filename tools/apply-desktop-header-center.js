'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MARKER = '/* AUTO_CUAN_DESKTOP_HEADER_CENTER_V1 */';
const PATCH = `${MARKER}
/* Keep the navigation centered on the viewport instead of centering it only
   inside the space left between unequal brand and account groups. */
@media (min-width: 1280px) {
  .app-header > .header-shell > .flex {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    column-gap: 16px;
  }

  .app-header > .header-shell > .flex > :first-child {
    justify-self: start;
  }

  .app-header > .header-shell > .flex > .desktop-nav {
    justify-self: center;
    width: max-content;
    max-width: none;
    flex: none;
  }

  .app-header > .header-shell > .flex > :last-child {
    justify-self: end;
  }
}`;

function applyHeaderCenter(targetPath) {
  const source = fs.readFileSync(targetPath, 'utf8');
  if (source.includes(MARKER)) {
    return { changed: false, targetPath };
  }

  const next = source.replace(/\s*$/, '') + '\n\n' + PATCH + '\n';
  fs.writeFileSync(targetPath, next, 'utf8');
  return { changed: true, targetPath };
}

if (require.main === module) {
  const targetPath = path.join(__dirname, '..', 'public', 'ui-theme.css');
  const result = applyHeaderCenter(targetPath);
  console.log(result.changed ? 'DESKTOP_HEADER_CENTER_PATCH=APPLIED' : 'DESKTOP_HEADER_CENTER_PATCH=ALREADY_PRESENT');
}

module.exports = {
  MARKER,
  PATCH,
  applyHeaderCenter
};
