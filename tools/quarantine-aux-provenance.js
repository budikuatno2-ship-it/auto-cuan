'use strict';

/**
 * Provenance Quarantine Tool (Wave 2 / W2-01) — move NEVER delete.
 *
 * Moves ONLY files classified VERIFIED_INVALID_PROVENANCE by
 * tools/scan-aux-provenance.js into a date-stamped quarantine directory
 * OUTSIDE the active production read path. Atomic same-filesystem renames are
 * preferred; a copy+unlink fallback is used only when rename is impossible,
 * and the unlink happens only after the copy is verified by sha256.
 *
 * Safety contract:
 *   --dry-run                 : plan only; NOTHING is moved (default when no
 *                               action flag is given)
 *   --manifest <path>         : scanner manifest to consume
 *   --quarantine-root <path>  : destination root (must be OUTSIDE the data root)
 *   --execute                 : actually perform the moves
 *   --restore-manifest <path> : write a restore manifest after moving
 *   --restore <path>          : restore files described by a restore manifest
 *
 * The tool refuses to move a file whose classification is not
 * VERIFIED_INVALID_PROVENANCE, refuses to overwrite an existing quarantine
 * artifact, and preserves relative paths + original filenames.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERIFIED = 'VERIFIED_INVALID_PROVENANCE';

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readManifest(manifestPath) {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const files = Array.isArray(raw.files) ? raw.files : [];
  return { manifest: raw, files };
}

function dateStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * Build the move plan. Pure function over the manifest — no filesystem writes.
 */
function buildPlan(manifestFiles, root) {
  const normalizedRoot = path.resolve(root);
  const plan = [];
  const skipped = [];
  for (const record of manifestFiles) {
    if (!record || record.classification !== VERIFIED) {
      skipped.push({ path: record && record.path, reason: 'not_verified_invalid' });
      continue;
    }
    const abs = path.resolve(record.path);
    if (!abs.startsWith(normalizedRoot + path.sep)) {
      skipped.push({ path: record.path, reason: 'outside_data_root' });
      continue;
    }
    const relative = path.relative(normalizedRoot, abs);
    plan.push({ source: abs, relative, record });
  }
  return { plan, skipped };
}

function executePlan(plan, quarantineRoot, stamp) {
  const moved = [];
  const failures = [];
  for (const item of plan) {
    const destDir = path.join(quarantineRoot, stamp, path.dirname(item.relative));
    const dest = path.join(quarantineRoot, stamp, item.relative);
    try {
      if (fs.existsSync(dest)) {
        failures.push({ source: item.source, reason: 'quarantine_artifact_exists' });
        continue;
      }
      // Review fix (P2): the source must still match the scanned hash at the
      // moment of the move. A file updated between scan and --execute is
      // freshly-corrected data and must NOT be quarantined under a stale
      // manifest (whose restore hash would then reject it).
      if (!fs.existsSync(item.source)) {
        failures.push({ source: item.source, reason: 'source_missing' });
        continue;
      }
      const currentHash = sha256File(item.source);
      if (item.record.sha256 && currentHash !== item.record.sha256) {
        failures.push({ source: item.source, reason: 'source_changed_since_scan' });
        continue;
      }
      ensureDir(destDir);
      let method = 'rename';
      try {
        fs.renameSync(item.source, dest);
      } catch (renameErr) {
        // Cross-device fallback: copy, verify hash, then unlink the source.
        method = 'copy_verify_unlink';
        fs.copyFileSync(item.source, dest);
        const srcHash = sha256File(item.source);
        const dstHash = sha256File(dest);
        if (srcHash !== dstHash) {
          failures.push({ source: item.source, reason: 'copy_hash_mismatch' });
          try { fs.unlinkSync(dest); } catch (_) {}
          continue;
        }
        fs.unlinkSync(item.source);
      }
      moved.push({
        original_path: item.source,
        quarantine_path: dest,
        relative_path: item.relative,
        sha256: item.record.sha256,
        size: item.record.size,
        logical_date: item.record.logical_date,
        ticker: item.record.ticker,
        dataset: item.record.dataset,
        reason: item.record.reason,
        method
      });
    } catch (err) {
      failures.push({ source: item.source, reason: String(err && err.message || err) });
    }
  }
  return { moved, failures };
}

function restore(restoreManifestPath) {
  const raw = JSON.parse(fs.readFileSync(restoreManifestPath, 'utf8'));
  const entries = Array.isArray(raw.moved) ? raw.moved : [];
  const restored = [];
  const failures = [];
  for (const entry of entries) {
    try {
      if (!fs.existsSync(entry.quarantine_path)) {
        failures.push({ quarantine_path: entry.quarantine_path, reason: 'quarantine_file_missing' });
        continue;
      }
      if (fs.existsSync(entry.original_path)) {
        failures.push({ original_path: entry.original_path, reason: 'original_path_occupied' });
        continue;
      }
      ensureDir(path.dirname(entry.original_path));
      const currentHash = sha256File(entry.quarantine_path);
      if (entry.sha256 && currentHash !== entry.sha256) {
        failures.push({ quarantine_path: entry.quarantine_path, reason: 'hash_mismatch' });
        continue;
      }
      // Review fix (P2): restoration must support the same cross-device layout
      // the move already supports. renameSync throws EXDEV across filesystems;
      // fall back to verified copy + unlink.
      try {
        fs.renameSync(entry.quarantine_path, entry.original_path);
      } catch (renameErr) {
        fs.copyFileSync(entry.quarantine_path, entry.original_path);
        const dstHash = sha256File(entry.original_path);
        if (dstHash !== currentHash) {
          failures.push({ quarantine_path: entry.quarantine_path, reason: 'restore_copy_hash_mismatch' });
          try { fs.unlinkSync(entry.original_path); } catch (_) {}
          continue;
        }
        fs.unlinkSync(entry.quarantine_path);
      }
      restored.push({ original_path: entry.original_path, sha256: currentHash });
    } catch (err) {
      failures.push({ quarantine_path: entry.quarantine_path, reason: String(err && err.message || err) });
    }
  }
  return { restored, failures };
}

function main(argv) {
  const args = argv || process.argv.slice(2);
  const getArg = name => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
  };

  const restorePath = getArg('--restore');
  if (restorePath) {
    const result = restore(restorePath);
    console.log(`Restored: ${result.restored.length} | Failures: ${result.failures.length}`);
    result.failures.forEach(f => console.error(`  FAILED ${f.quarantine_path || f.original_path}: ${f.reason}`));
    if (result.failures.length > 0) process.exitCode = 1;
    return result;
  }

  const manifestPath = getArg('--manifest');
  if (!manifestPath) {
    console.error('Usage: node tools/quarantine-aux-provenance.js --manifest <path> --quarantine-root <dir> [--execute] [--dry-run] [--restore-manifest <path>]');
    console.error('       node tools/quarantine-aux-provenance.js --restore <restore-manifest.json>');
    process.exitCode = 1;
    return null;
  }

  const { manifest, files } = readManifest(manifestPath);
  const root = manifest.root || process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');
  const quarantineRoot = getArg('--quarantine-root');
  const execute = args.includes('--execute') && !args.includes('--dry-run');

  const { plan, skipped } = buildPlan(files, root);

  // Gate H (task §26): never allow a current/latest artifact into the plan.
  const forbidden = plan.filter(item => /(^|[\\/])latest\.json$/.test(item.relative) || /(^|[\\/])p1\.json$/.test(item.relative) || /(^|[\\/])series\.json$/.test(item.relative));
  if (forbidden.length > 0) {
    console.error(`REFUSING: plan contains ${forbidden.length} current/latest/undated artifact(s); aborting.`);
    process.exitCode = 2;
    return null;
  }

  console.log('=== AUXILIARY PROVENANCE QUARANTINE ===');
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`);
  console.log(`Verified-invalid candidates: ${plan.length}`);
  console.log(`Skipped (not verified-invalid/outside root): ${skipped.length}`);
  plan.forEach(item => console.log(`  PLAN ${item.relative}`));
  skipped.forEach(item => console.log(`  SKIP ${item.path} (${item.reason})`));

  if (!execute) {
    console.log('DRY-RUN: no file was moved. Re-run with --execute and --quarantine-root to perform the quarantine.');
    return { plan, skipped, moved: [], failures: [] };
  }

  if (!quarantineRoot) {
    console.error('--quarantine-root is required with --execute.');
    process.exitCode = 1;
    return null;
  }
  const normalizedQuarantine = path.resolve(quarantineRoot);
  const normalizedRoot = path.resolve(root);
  if (normalizedQuarantine.startsWith(normalizedRoot + path.sep) || normalizedQuarantine === normalizedRoot) {
    console.error('REFUSING: quarantine root must be OUTSIDE the active data root.');
    process.exitCode = 2;
    return null;
  }

  const stamp = dateStamp();
  const { moved, failures } = executePlan(plan, normalizedQuarantine, stamp);
  console.log(`MOVED: ${moved.length} | FAILED: ${failures.length}`);
  failures.forEach(f => console.error(`  FAILED ${f.source}: ${f.reason}`));

  const restoreManifestPath = getArg('--restore-manifest') || path.join(normalizedQuarantine, stamp, 'restore-manifest.json');
  ensureDir(path.dirname(restoreManifestPath));
  fs.writeFileSync(restoreManifestPath, JSON.stringify({
    tool: 'quarantine-aux-provenance',
    version: 1,
    quarantine_root: normalizedQuarantine,
    data_root: normalizedRoot,
    stamp,
    generated_at: new Date().toISOString(),
    moved,
    failures
  }, null, 2));
  console.log(`Restore manifest: ${restoreManifestPath}`);
  if (failures.length > 0) process.exitCode = 1;
  return { plan, skipped, moved, failures };
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Quarantine tool failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = { main, buildPlan, executePlan, restore, VERIFIED };
