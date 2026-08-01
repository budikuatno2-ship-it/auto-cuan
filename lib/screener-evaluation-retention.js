'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GIB = 1024 ** 3;
const DEFAULTS = { rawRetentionDays: 60, debugRetentionDays: 14, maxRootBytes: 20 * GIB, minFreeBytes: 20 * GIB };
function walk(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(file)); else if (entry.isFile()) files.push(file);
  }
  return files;
}
function auditRetention(options = {}) {
  const root = path.resolve(options.root);
  const now = options.now ? new Date(options.now) : new Date();
  const today = now.toISOString().slice(0, 10);
  const policy = Object.assign({}, DEFAULTS, options.policy);
  const allFiles = walk(root);
  const usageBytes = allFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  const freeBytes = options.freeBytes == null ? fs.statfsSync(root).bavail * fs.statfsSync(root).bsize : options.freeBytes;
  const manifestFiles = allFiles.filter(file => file.endsWith('.manifest.json'));
  const eligible = [];
  for (const manifestFile of manifestFiles) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (_) { continue; }
    const rawFile = path.resolve(root, manifest.relative_path || '');
    const dateMatch = String(manifest.relative_path || '').match(/(?:^|\/)raw\/(\d{4}-\d{2}-\d{2})\//);
    if (!dateMatch || dateMatch[1] === today || rawFile.endsWith('.open.jsonl.gz') || !fs.existsSync(rawFile)) continue;
    const ageDays = (Date.parse(today + 'T00:00:00Z') - Date.parse(dateMatch[1] + 'T00:00:00Z')) / 86400000;
    if (ageDays <= policy.rawRetentionDays) continue;
    const stat = fs.statSync(rawFile);
    eligible.push({ path: rawFile, relative_path: path.relative(root, rawFile), byte_size: stat.size, market_date: dateMatch[1], manifest: path.relative(root, manifestFile) });
  }
  eligible.sort((a, b) => a.market_date.localeCompare(b.market_date) || a.relative_path.localeCompare(b.relative_path));
  const eligibleDebug = allFiles.filter(file => {
    const rel = path.relative(root, file);
    if (!rel.startsWith('technical' + path.sep) || /(?:^|\.)open(?:\.|$)/.test(path.basename(file))) return false;
    const match = rel.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\/|$)/);
    if (match && match[1] === today) return false;
    return (now.getTime() - fs.statSync(file).mtimeMs) / 86400000 > policy.debugRetentionDays;
  }).map(file => ({ path: file, relative_path: path.relative(root, file), byte_size: fs.statSync(file).size }));
  return { dry_run: true, root, policy, usage_bytes: usageBytes, free_bytes: freeBytes, over_usage_cap: usageBytes > policy.maxRootBytes, below_free_reserve: freeBytes < policy.minFreeBytes, writes_should_stop: usageBytes > policy.maxRootBytes || freeBytes < policy.minFreeBytes, eligible_deletions: eligible, eligible_debug_deletions: eligibleDebug, protected: { current_day: today, manifests: true, aggregates: true, outcomes: true, configuration_provenance: true } };
}
module.exports = { GIB, DEFAULTS, auditRetention };
