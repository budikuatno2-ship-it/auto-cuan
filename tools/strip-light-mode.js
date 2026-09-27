#!/usr/bin/env node
'use strict';

/**
 * FASE 1 — Pure dark mode enforcement.
 *
 * Removes every light-mode rule block from a CSS file:
 *   - selectors mentioning html.light / body.light / [data-theme="light"]
 *   - @media (prefers-color-scheme: light) blocks (nested-safe)
 *
 * The stripper is brace-matched, not line-based, so multi-selector blocks and
 * nested at-rules are removed whole. A selector only counts as "light" when the
 * token stands alone — `.highlight` and `.lighter` are untouched.
 *
 * Usage: node tools/strip-light-mode.js public/ui-theme.css [more.css ...]
 */

const fs = require('fs');
const path = require('path');

const LIGHT_TOKEN = /(^|[^\w-])light([^\w-]|$)/;

function isLightSelector(selector) {
  const sel = selector.replace(/\s+/g, ' ').trim();
  if (!sel) return false;
  if (/prefers-color-scheme\s*:\s*light/i.test(sel)) return true;
  // html.light / body.light / .light scoping
  if (/html\s*\.light|body\s*\.light|^\.light\b/.test(sel)) return true;
  // [data-theme="light"] in any position
  if (/\[data-theme\s*=\s*["']?light["']?\]/.test(sel)) return true;
  return false;
}

/**
 * Remove whole rule blocks whose selector is light-scoped.
 * Walks the sheet once, tracking brace depth so nested @media bodies survive
 * or die as a unit.
 */
function stripLightBlocks(css) {
  let out = '';
  let i = 0;
  let lastEnd = 0;
  const len = css.length;

  while (i < len) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      // Skip comments wholesale — they are re-emitted verbatim.
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? len : close + 2;
      continue;
    }
    if (ch === '{') {
      // Selector = text between the previous block end and this brace.
      const selector = css.slice(lastEnd, i);
      const bodyStart = i;
      // Find matching close brace with depth counting.
      let depth = 0;
      let j = i;
      while (j < len) {
        const c = css[j];
        if (c === '/' && css[j + 1] === '*') {
          const close = css.indexOf('*/', j + 2);
          j = close === -1 ? len : close + 2;
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      const blockEnd = j; // index of closing brace
      const isAtRule = /^\s*@/.test(selector);
      const atLightMedia = isAtRule && /prefers-color-scheme\s*:\s*light/i.test(selector);

      if (atLightMedia) {
        // Drop the entire at-rule; skip to the brace that closes it.
        i = blockEnd + 1;
        lastEnd = i;
        continue;
      }

      if (!isAtRule && isLightSelector(selector)) {
        // Drop the whole rule, including the trailing newline.
        let end = blockEnd + 1;
        while (end < len && (css[end] === '\n' || css[end] === '\r')) end++;
        i = end;
        lastEnd = end;
        continue;
      }

      // Keep: emit up to and including the closing brace, then continue.
      out += css.slice(lastEnd, blockEnd + 1);
      i = blockEnd + 1;
      lastEnd = i;
      continue;
    }
    i++;
  }

  // Tail after the last kept block (comments, stray text).
  out += css.slice(lastEnd);
  return out;
}

/** Collapse runs of blank lines left behind by the stripper. */
function tidyBlankLines(css) {
  return css.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n');
}

function processFile(file) {
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error('skip (missing): ' + file);
    return;
  }
  const original = fs.readFileSync(abs, 'utf8');
  const stripped = tidyBlankLines(stripLightBlocks(original));
  if (stripped === original) {
    console.log('unchanged: ' + file);
    return;
  }
  fs.writeFileSync(abs, stripped);
  const removed = original.length - stripped.length;
  console.log('stripped: ' + file + ' (-' + removed + ' bytes)');
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node tools/strip-light-mode.js <file.css> [...]');
  process.exit(1);
}
files.forEach(processFile);
