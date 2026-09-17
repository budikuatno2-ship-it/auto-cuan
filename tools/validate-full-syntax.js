'use strict';

/**
 * Batch 17 — Full-Repo Syntax Validation
 *
 * Parse-checks every `.js` file in the repository (lib, tools, api, test,
 * scripts, public, server.js) WITHOUT executing it, using `node:vm`. This is
 * the same guarantee as `node --check` for every file at once, so a syntax
 * error can never slip past CI because it simply was not hand-checked.
 *
 * Also verifies that every entry in curated-build-tests.json points to a file
 * that actually exists — the suite runner silently drops missing paths, which
 * could quietly shrink coverage.
 *
 * Usage:
 *   node tools/validate-full-syntax.js            # check + summary
 *   node tools/validate-full-syntax.js --json
 *
 * Exit code 0 = all clean, 1 = at least one failure.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['lib', 'tools', 'api', 'test', 'scripts', 'public'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel', 'tmp_investigasi']);

function collectJsFiles(root, relDirs) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
  };
  for (const rel of relDirs) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) walk(abs);
  }
  const serverJs = path.join(root, 'server.js');
  if (fs.existsSync(serverJs)) out.push(serverJs);
  return out.sort();
}

/**
 * Parse a single file. Returns {file, ok, error}.
 * Uses vm.Script so the file is compiled but never executed.
 */
function checkFile(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { file, ok: false, error: 'read_failed: ' + err.message };
  }
  try {
    // eslint-disable-next-line no-new
    new vm.Script(source, { filename: file });
    return { file, ok: true, error: null };
  } catch (err) {
    return { file, ok: false, error: err.message };
  }
}

function checkSyntax(files) {
  const failures = [];
  for (const f of files) {
    const r = checkFile(f);
    if (!r.ok) failures.push(r);
  }
  return { checked: files.length, failures };
}

function checkCuratedTestList(root) {
  const cfg = path.join(root, 'tools', 'curated-build-tests.json');
  if (!fs.existsSync(cfg)) return { listed: 0, missing: ['tools/curated-build-tests.json'] };
  const list = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  const missing = list.filter((rel) => !fs.existsSync(path.join(root, rel)));
  return { listed: list.length, missing };
}

function main(argv) {
  const asJson = argv.includes('--json');
  const files = collectJsFiles(ROOT, SCAN_ROOTS);
  const { checked, failures } = checkSyntax(files);
  const curated = checkCuratedTestList(ROOT);

  const summary = {
    js_files_checked: checked,
    syntax_failures: failures.length,
    curated_tests_listed: curated.listed,
    curated_tests_missing: curated.missing.length,
    failures: failures.map((f) => ({ file: path.relative(ROOT, f.file), error: f.error })),
    missing_curated_tests: curated.missing
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Full syntax check: ${checked} .js files parsed.`);
    console.log(`Curated test list: ${curated.listed} entries, ${curated.missing.length} missing.`);
    if (failures.length) {
      console.error(`\nSYNTAX FAILURES (${failures.length}):`);
      for (const f of failures) console.error(` - ${path.relative(ROOT, f.file)}: ${f.error}`);
    }
    if (curated.missing.length) {
      console.error('\nMISSING CURATED TEST FILES:');
      for (const m of curated.missing) console.error(` - ${m}`);
    }
    if (!failures.length && !curated.missing.length) console.log('\nAll .js files parsed cleanly.');
  }

  return (failures.length || curated.missing.length) ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { collectJsFiles, checkFile, checkSyntax, checkCuratedTestList, SCAN_ROOTS };
