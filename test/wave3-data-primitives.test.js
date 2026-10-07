'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), 'utf8');

const THEME_CSS = read('public/ui-theme.css');
const INDEX_HTML = read('public/index.html');
const RUNTIME = require('../public/data-primitives-runtime.js');

test('Wave 3: Table primitives contract (§14, §76.9, §82)', () => {
  // Dense row target height: 36-40px (canonical --ac-row-dense: 38px)
  assert.match(
    THEME_CSS,
    /\.ac-table--dense\s+td[\s\S]*?height:\s*var\(--ac-row-dense,\s*38px\)/,
    'Dense table rows must target --ac-row-dense (38px)'
  );

  // Comfort row target height: 40-44px (canonical --ac-row-comfort: 42px)
  assert.match(
    THEME_CSS,
    /\.ac-table--comfort\s+td[\s\S]*?height:\s*var\(--ac-row-comfort,\s*42px\)/,
    'Comfort table rows must target --ac-row-comfort (42px)'
  );

  // Sticky header with raised background & z-index
  assert.match(
    THEME_CSS,
    /\.ac-table\s+th[\s\S]*?position:\s*sticky[\s\S]*?top:\s*0[\s\S]*?z-index:\s*var\(--ac-z-sticky,\s*20\)/,
    'Table header th must be sticky top: 0 with z-index'
  );

  // Numeric alignment and tabular-nums
  assert.match(
    THEME_CSS,
    /\.ac-table\s+td\.ac-td-num[\s\S]*?text-align:\s*right[\s\S]*?font-variant-numeric:\s*tabular-nums\s+lining-nums/,
    'Numeric td cells must be right aligned with tabular-nums lining-nums'
  );

  // Selected interactive row uses brand-soft + brand edge indicator without whole-row color fills
  assert.match(
    THEME_CSS,
    /\.ac-table\s+tbody\s+tr\.is-selected[\s\S]*?background:\s*var\(--ac-brand-soft\)[\s\S]*?box-shadow:\s*inset\s+3px\s+0\s+0\s+var\(--ac-brand\)/,
    'Selected rows must use brand-soft background with inset brand edge indicator'
  );

  // Sortable headers & sort icons
  assert.ok(THEME_CSS.includes('.ac-th--sortable'), 'Table th sortable class must exist');
  assert.ok(THEME_CSS.includes('.ac-sort-icon'), 'Table sort icon class must exist');

  // Empty cell displays em-dash, never 0 (§78.1)
  assert.ok(THEME_CSS.includes('.ac-cell-empty'), 'Empty table cell class must exist');
});

test('Wave 3: Filter bar order & overflow contract (§76.4)', () => {
  // Canonical order: Search -> primary filters -> sort -> view/options -> result/freshness status
  assert.ok(THEME_CSS.includes('.ac-filter-bar'), 'Filter bar container must exist');
  assert.ok(THEME_CSS.includes('.ac-filter-bar__search'), 'Search filter slot must exist');
  assert.ok(THEME_CSS.includes('.ac-filter-bar__primary'), 'Primary filters slot must exist');
  assert.ok(THEME_CSS.includes('.ac-filter-bar__sort'), 'Sort filter slot must exist');
  assert.ok(THEME_CSS.includes('.ac-filter-bar__view'), 'View modes slot must exist');
  assert.ok(THEME_CSS.includes('.ac-filter-bar__status'), 'Status/freshness slot must exist');

  // Removable chips grammar
  assert.ok(THEME_CSS.includes('.ac-filter-chips'), 'Active chips container must exist');
  assert.ok(THEME_CSS.includes('.ac-filter-chip'), 'Filter chip element must exist');
  assert.ok(THEME_CSS.includes('.ac-filter-chip__remove'), 'Filter chip remove button must exist');

  // Overflow / advanced filter trigger
  assert.ok(THEME_CSS.includes('.ac-filter-more-btn'), 'Filter more button for popover/sheet overflow must exist');
});

test('Wave 3: Status, freshness & provenance row grammar (§6.2, §76.8, §76.11, §78.2, §97)', () => {
  // Text-first status badges
  assert.ok(THEME_CSS.includes('.ac-status-badge--neutral'), 'Neutral status badge must exist');
  assert.ok(THEME_CSS.includes('.ac-status-badge--positive'), 'Positive status badge must exist');
  assert.ok(THEME_CSS.includes('.ac-status-badge--negative'), 'Negative status badge must exist');
  assert.ok(THEME_CSS.includes('.ac-status-badge--warning'), 'Warning status badge must exist');
  assert.ok(THEME_CSS.includes('.ac-status-badge--info'), 'Info status badge must exist');

  // Status dots
  assert.ok(THEME_CSS.includes('.ac-status-dot'), 'Status dot base class must exist');
  assert.ok(THEME_CSS.includes('.ac-status-dot--live'), 'Live status dot with glow must exist');

  // Freshness classes
  assert.ok(THEME_CSS.includes('.ac-freshness'), 'Freshness indicator container must exist');
  assert.ok(THEME_CSS.includes('.ac-freshness--live'), 'Freshness live class must exist');
  assert.ok(THEME_CSS.includes('.ac-freshness--stale'), 'Freshness stale class must exist');

  // Provenance row grammar: Per tanggal | Sumber | Diperbarui | Ketersediaan
  assert.ok(THEME_CSS.includes('.ac-provenance-row'), 'Provenance row container must exist');
  assert.ok(THEME_CSS.includes('.ac-provenance-item'), 'Provenance item must exist');
  assert.ok(THEME_CSS.includes('.ac-provenance-label'), 'Provenance label must exist');
  assert.ok(THEME_CSS.includes('.ac-provenance-value'), 'Provenance value must exist');
  assert.ok(THEME_CSS.includes('.ac-provenance-sep'), 'Provenance separator must exist');
});

test('Wave 3: Desktop detail pane (320-380px) & mobile detail sheet (§63, §76.12, §76.13)', () => {
  // Desktop split view layout
  assert.ok(THEME_CSS.includes('.ac-split-view'), 'Split view container must exist');
  assert.ok(THEME_CSS.includes('.ac-split-view__main'), 'Split view main content column must exist');
  assert.ok(THEME_CSS.includes('.ac-split-view__pane'), 'Split view pane column must exist');

  // Desktop width target: 320-380px
  assert.match(
    THEME_CSS,
    /\.ac-detail-pane[\s\S]*?width:\s*clamp\(320px,\s*25vw,\s*380px\)[\s\S]*?min-width:\s*320px[\s\S]*?max-width:\s*380px/,
    'Detail pane width must target 320-380px range per DESIGN.md §63'
  );

  // Independent scrolling & sticky placement
  assert.match(
    THEME_CSS,
    /\.ac-detail-pane[\s\S]*?overflow-y:\s*auto[\s\S]*?position:\s*sticky/,
    'Detail pane must be sticky and scroll independently'
  );

  // Mobile detail sheet transitions and safe area under max-width: 1023px
  assert.match(
    THEME_CSS,
    /@media\s*\(\s*max-width:\s*1023px\s*\)\s*\{[\s\S]*?\.ac-detail-sheet[\s\S]*?position:\s*fixed[\s\S]*?bottom/,
    'Detail pane must convert to mobile bottom sheet on small viewports'
  );
  assert.match(
    THEME_CSS,
    /@media\s*\(\s*max-width:\s*1023px\s*\)\s*\{[\s\S]*?\.ac-sheet-content[\s\S]*?padding-bottom:\s*max\([\s\S]*?safe-area-inset-bottom/,
    'Mobile detail sheet must respect safe-area-inset-bottom'
  );
  assert.match(
    THEME_CSS,
    /@media\s*\(\s*max-width:\s*1023px\s*\)\s*\{[\s\S]*?\.ac-sheet-handle[\s\S]*?width:\s*36px/,
    'Mobile detail sheet must include a handle bar'
  );
  assert.match(
    THEME_CSS,
    /@media\s*\(\s*max-width:\s*1023px\s*\)\s*\{[\s\S]*?\.ac-detail-pane__close[\s\S]*?min-height:\s*var\(--ac-touch-target,\s*44px\)/,
    'Mobile detail close control must satisfy >=44px touch target'
  );
});

test('Wave 3: Overlay grammar - Modal, Popover, Toast (§76.13, §62, §1005)', () => {
  // Modal / Dialog for focused decisions
  assert.ok(THEME_CSS.includes('.ac-modal-overlay'), 'Modal overlay must exist');
  assert.ok(THEME_CSS.includes('.ac-modal'), 'Modal container must exist');
  assert.ok(THEME_CSS.includes('.ac-modal__header'), 'Modal header must exist');
  assert.ok(THEME_CSS.includes('.ac-modal__body'), 'Modal body must exist');
  assert.ok(THEME_CSS.includes('.ac-modal__footer'), 'Modal footer must exist');

  // Popover for short anchored choices
  assert.match(
    THEME_CSS,
    /\.ac-popover[\s\S]*?position:\s*absolute[\s\S]*?z-index:\s*var\(--ac-z-popover,\s*60\)/,
    'Popover must be absolutely positioned anchored overlay'
  );

  // Toast for transient notices
  assert.ok(THEME_CSS.includes('.ac-toast-container'), 'Toast container must exist');
  assert.ok(THEME_CSS.includes('.ac-toast'), 'Toast element must exist');
});

test('Wave 3: Lifecycle and feedback grammar (§76.14, §78.1, §78.4)', () => {
  // Shape-matched skeletons with shimmer
  assert.ok(THEME_CSS.includes('.ac-skeleton'), 'Skeleton primitive must exist');
  assert.ok(THEME_CSS.includes('.ac-skeleton-text'), 'Text skeleton must exist');
  assert.ok(THEME_CSS.includes('.ac-skeleton-num'), 'Numeric skeleton must exist');
  assert.ok(THEME_CSS.includes('.ac-skeleton-rect'), 'Rectangular skeleton must exist');
  assert.ok(THEME_CSS.includes('.ac-skeleton-circle'), 'Circular skeleton must exist');

  // Reduced motion safety on skeletons and spinners
  assert.match(
    THEME_CSS,
    /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\.ac-skeleton[\s\S]*?animation:\s*none/,
    'Skeleton animation must be suppressed under prefers-reduced-motion: reduce'
  );
  assert.match(
    THEME_CSS,
    /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\.ac-refresh-spinner[\s\S]*?animation:\s*none/,
    'Spinner animation must be suppressed under prefers-reduced-motion: reduce'
  );

  // Inline refresh banner
  assert.ok(THEME_CSS.includes('.ac-refresh-banner'), 'Inline refresh banner must exist');

  // Empty state distinct from error state
  assert.ok(THEME_CSS.includes('.ac-empty-state'), 'Empty state container must exist');
  assert.ok(THEME_CSS.includes('.ac-empty-state__icon'), 'Empty state icon must exist');
  assert.ok(THEME_CSS.includes('.ac-empty-state__title'), 'Empty state title must exist');
  assert.ok(THEME_CSS.includes('.ac-empty-state__desc'), 'Empty state description must exist');

  // Local scoped error state
  assert.ok(THEME_CSS.includes('.ac-error-state'), 'Local error state container must exist');
  assert.ok(THEME_CSS.includes('.ac-error-state__retry'), 'Error retry action button must exist');

  // Stale data banner
  assert.ok(THEME_CSS.includes('.ac-stale-banner'), 'Stale data banner must exist');
});

test('Wave 3: Client runtime helper operates cleanly', () => {
  // formatProvenanceText produces canonical formatted text
  const provText = RUNTIME.formatProvenanceText({
    source: 'IDX ownership',
    asOf: '31 Agu 2026',
    updatedAt: '15:30 WIB'
  });
  assert.equal(provText, 'IDX ownership · Per tanggal 31 Agu 2026 · Diperbarui 15:30 WIB');

  // selectTableRow manages is-selected and aria-selected
  const makeMockRow = () => {
    const row = {
      selectedClass: null,
      attributes: {},
      classList: {
        add(c) { row.selectedClass = c; },
        remove(c) { if (row.selectedClass === c) row.selectedClass = null; }
      },
      setAttribute(k, v) { row.attributes[k] = v; },
      removeAttribute(k) { delete row.attributes[k]; }
    };
    return row;
  };
  const dummyRows = [makeMockRow(), makeMockRow()];
  const dummyTable = {
    querySelectorAll: () => dummyRows
  };
  RUNTIME.selectTableRow(dummyTable, dummyRows[0]);
  assert.equal(dummyRows[0].selectedClass, 'is-selected');
  assert.equal(dummyRows[0].attributes['aria-selected'], 'true');
  assert.equal(dummyRows[1].selectedClass, null);
  assert.equal(dummyRows[1].attributes['aria-selected'], undefined);

  // openDetail & closeDetail manage focus restoration (§76.12)
  let focused = null;
  const origin = { focus: () => { focused = 'origin'; } };
  const pane = {
    classList: { add: () => {}, remove: () => {} },
    setAttribute: () => {},
    querySelector: () => ({ focus: () => { focused = 'closeBtn'; } })
  };
  RUNTIME.openDetail({ originElement: origin, paneElement: pane });
  assert.equal(focused, 'closeBtn');

  RUNTIME.closeDetail({ paneElement: pane });
  assert.equal(focused, 'origin', 'Closing detail must restore focus to originating row element (§76.12)');
});

test('Wave 3: Script registered in public/index.html', () => {
  assert.ok(
    INDEX_HTML.includes('src="/data-primitives-runtime.js'),
    'index.html must include data-primitives-runtime.js'
  );
});
