'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MARKER = '/* AUTO_CUAN_DESKTOP_HEADER_CENTER_V1 */';
/* PR1 layout fix: the analisis-saham.html header does NOT use the
   .header-shell wrapper — it is `.app-header > .brand + .header-actions`.
   The old selector never matched that page, so its header had no balanced
   grid and the tab strip offset drifted. Both selector shapes are now
   supported so the center rule applies on every host page. */
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

  /* analisis-saham.html direct children: brand left, actions right, keeping
     a symmetric gutter so the sticky offset (--analisis-header-h) stays stable. */
  .app-header:not(:has(.header-shell)) {
    justify-content: space-between;
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
