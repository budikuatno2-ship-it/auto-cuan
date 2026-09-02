'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
function marketDate(now, timeZone = 'Asia/Jakarta') {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).reduce((out, part) => { out[part.type] = part.value; return out; }, {});
  return parts.year + '-' + parts.month + '-' + parts.day;
}
function auditRetention(options = {}) {
  const root = path.resolve(options.root);
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError('now is invalid');
  const today = marketDate(now, options.timeZone || 'Asia/Jakarta');
  const policy = Object.assign({}, DEFAULTS, options.policy);
  const allFiles = walk(root);
  const usageBytes = allFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  const freeBytes = options.freeBytes == null ? fs.statfsSync(root).bavail * fs.statfsSync(root).bsize : options.freeBytes;
  const manifestFiles = allFiles.filter(file => file.endsWith('.manifest.json'));
  const eligible = [];
  for (const manifestFile of manifestFiles) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (_) { continue; }
    if (!manifest || manifest.schema_version !== 1 || typeof manifest.relative_path !== 'string' || !manifest.relative_path || path.isAbsolute(manifest.relative_path) || manifest.relative_path.split(/[\\/]/).includes('..')) continue;
    const rawRoot = path.join(root, 'raw');
    const rawFile = path.resolve(root, manifest.relative_path);
    if (rawFile === rawRoot || !rawFile.startsWith(rawRoot + path.sep) || !rawFile.endsWith('.jsonl.gz') || rawFile.endsWith('.open.jsonl.gz')) continue;
    const normalizedRel = String(manifest.relative_path || '').replace(/\\/g, '/');
    const dateMatch = normalizedRel.match(/(?:^|\/)raw\/(\d{4}-\d{2}-\d{2})\//);
    if (!dateMatch || dateMatch[1] === today || rawFile.endsWith('.open.jsonl.gz') || !fs.existsSync(rawFile)) continue;
    const realRawRoot = fs.realpathSync(rawRoot); const realRawFile = fs.realpathSync(rawFile);
    if (!realRawFile.startsWith(realRawRoot + path.sep) || !fs.statSync(realRawFile).isFile()) continue;
    const expectedManifest = path.join(root, 'manifests', dateMatch[1], path.basename(rawFile) + '.manifest.json');
    if (path.resolve(manifestFile) !== path.resolve(expectedManifest) || !Number.isInteger(manifest.record_count) || manifest.record_count < 0 || !Number.isInteger(manifest.byte_size) || manifest.byte_size < 0 || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) continue;
    const content = fs.readFileSync(rawFile);
    if (content.length !== manifest.byte_size || crypto.createHash('sha256').update(content).digest('hex') !== manifest.sha256) continue;
    const ageDays = (Date.parse(today + 'T00:00:00Z') - Date.parse(dateMatch[1] + 'T00:00:00Z')) / 86400000;
    if (ageDays <= policy.rawRetentionDays) continue;
    const stat = fs.statSync(rawFile);
    eligible.push({ path: rawFile, relative_path: path.relative(root, rawFile), byte_size: stat.size, market_date: dateMatch[1], manifest: path.relative(root, manifestFile) });
  }
  eligible.sort((a, b) => a.market_date.localeCompare(b.market_date) || a.relative_path.localeCompare(b.relative_path));
  const eligibleDebug = allFiles.filter(file => {
    const rel = path.relative(root, file);
    if (!rel.startsWith('technical' + path.sep) || /(?:^|\.)open(?:\.|$)/.test(path.basename(file))) return false;
    const match = rel.replace(/\\/g, '/').match(/(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\/|$)/);
    if (match && match[1] === today) return false;
    return (now.getTime() - fs.statSync(file).mtimeMs) / 86400000 > policy.debugRetentionDays;
  }).map(file => ({ path: file, relative_path: path.relative(root, file), byte_size: fs.statSync(file).size }));
  return { dry_run: true, root, policy, usage_bytes: usageBytes, free_bytes: freeBytes, over_usage_cap: usageBytes > policy.maxRootBytes, below_free_reserve: freeBytes < policy.minFreeBytes, writes_should_stop: usageBytes > policy.maxRootBytes || freeBytes < policy.minFreeBytes, eligible_deletions: eligible, eligible_debug_deletions: eligibleDebug, protected: { current_day: today, manifests: true, aggregates: true, outcomes: true, configuration_provenance: true } };
}
module.exports = { GIB, DEFAULTS, marketDate, auditRetention };
