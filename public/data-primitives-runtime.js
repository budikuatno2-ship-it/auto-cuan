/* Auto-Cuan Data Primitives Runtime (§76.4, §76.11, §76.12, §82)
   Provides deterministic client-side helpers for:
   - Detail pane / mobile sheet activation and focus restoration
   - Interactive table row selection (brand-soft affordance, non-destructive)
   - Filter bar chip lifecycle & overflow management
   - Provenance row text normalization
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AutoCuanDataPrimitives = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Updates interactive table row selection state without touching financial semantic colors.
   * @param {HTMLTableElement} table
   * @param {HTMLTableRowElement|null} targetRow
   */
  function selectTableRow(table, targetRow) {
    if (!table) return;
    const rows = table.querySelectorAll('tbody tr');
    rows.forEach(function (r) {
      if (r === targetRow) {
        r.classList.add('is-selected');
        r.setAttribute('aria-selected', 'true');
      } else {
        r.classList.remove('is-selected');
        r.removeAttribute('aria-selected');
      }
    });
  }

  /**
   * Opens detail pane on desktop or bottom sheet on mobile, preserving the originating element
   * to guarantee focus restoration upon dismissal (§76.12).
   * @param {Object} options
   * @param {HTMLElement} [options.originElement]
   * @param {HTMLElement} [options.paneElement]
   * @param {HTMLElement} [options.sheetElement]
   */
  function openDetail(options) {
    options = options || {};
    var origin = options.originElement || null;
    var pane = options.paneElement || null;
    var sheet = options.sheetElement || null;

    if (pane) {
      pane.classList.add('is-open');
      pane.setAttribute('aria-hidden', 'false');
      if (origin) {
        pane._originElement = origin;
      }
      var closeBtn = pane.querySelector('.ac-detail-pane__close');
      if (closeBtn && typeof closeBtn.focus === 'function') {
        closeBtn.focus();
      }
    }

    if (sheet) {
      sheet.classList.add('is-open');
      sheet.setAttribute('aria-hidden', 'false');
      if (origin) {
        sheet._originElement = origin;
      }
      var sheetClose = sheet.querySelector('.ac-detail-pane__close, .ac-sheet__close');
      if (sheetClose && typeof sheetClose.focus === 'function') {
        sheetClose.focus();
      }
    }
  }

  /**
   * Closes detail pane/sheet and returns focus to originating row/element (§76.12).
   * @param {Object} options
   * @param {HTMLElement} [options.paneElement]
   * @param {HTMLElement} [options.sheetElement]
   */
  function closeDetail(options) {
    options = options || {};
    var pane = options.paneElement || null;
    var sheet = options.sheetElement || null;
    var restoreTarget = null;

    if (pane) {
      pane.classList.remove('is-open');
      pane.setAttribute('aria-hidden', 'true');
      if (pane._originElement) {
        restoreTarget = pane._originElement;
        delete pane._originElement;
      }
    }

    if (sheet) {
      sheet.classList.remove('is-open');
      sheet.setAttribute('aria-hidden', 'true');
      if (sheet._originElement) {
        restoreTarget = restoreTarget || sheet._originElement;
        delete sheet._originElement;
      }
    }

    if (restoreTarget && typeof restoreTarget.focus === 'function') {
      restoreTarget.focus();
    }
  }

  /**
   * Formats canonical provenance items according to DESIGN.md §76.11 and §78.2:
   * "Per tanggal | Sumber | Diperbarui | Ketersediaan/kualitas"
   * @param {Object} meta
   * @param {string} [meta.asOf]
   * @param {string} [meta.source]
   * @param {string} [meta.updatedAt]
   * @param {string} [meta.quality]
   * @returns {string} Aligned metadata text
   */
  function formatProvenanceText(meta) {
    if (!meta) return '';
    var parts = [];
    if (meta.source) parts.push(meta.source);
    if (meta.asOf) parts.push('Per tanggal ' + meta.asOf);
    if (meta.updatedAt) parts.push('Diperbarui ' + meta.updatedAt);
    if (meta.quality) parts.push(meta.quality);
    return parts.join(' \u00b7 ');
  }

  return {
    selectTableRow: selectTableRow,
    openDetail: openDetail,
    closeDetail: closeDetail,
    formatProvenanceText: formatProvenanceText
  };
});
