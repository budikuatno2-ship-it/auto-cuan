'use strict';

/**
 * lib/strategy-registry.js
 * ============================================================================
 * V5 Phase 3 — Strategy Registry Version Gate (N20 / BUG-V5-P1-027)
 * ============================================================================
 *
 * CONTRACT (Strategy Registry)
 *   - Versioned registry persisted at `data/strategy-registry.json`.
 *     If absent: initialized additively with an empty `strategies` map and
 *     `status: 'EMPTY'`. Nothing is ever destructively rewritten; writes are
 *     read-modify-write against the latest on-disk state.
 *   - `registerStrategy({id, version, metrics, approvedBy, approvedAt, evidence})`
 *       → writes ONLY when `approvedBy` is present; otherwise rejects with
 *         APPROVAL_REQUIRED.
 *   - `getApprovedStrategy(id)` → returns the approved version record or
 *       `null`. NEVER a default. Never a silently-swapped production version.
 *   - `setProductionStrategy(id, version, {approvedBy, reason, approved})`
 *       → REQUIRES an explicit approval flag (`approved === true` AND a
 *         non-empty `approvedBy`); otherwise throws APPROVAL_REQUIRED.
 *       Every successful promotion is appended to `auditLog` (immutable,
 *       append-only within the file) with actor, timestamp, previous/new
 *       version and reason.
 *   - `NO_QUALIFIED_STRATEGY` is a first-class result when no registered
 *       strategy meets the minimum qualification thresholds (positive net
 *       expectancy and minimum sample size). There is NO fallback default:
 *       callers must treat "no qualified strategy" as a valid, honest answer.
 *
 * MINIMUM QUALIFICATION THRESHOLDS
 *   Reused from lib/screener-config.js where they exist:
 *     - MIN_RR_RATIO (1.5) is reused as the minimum profit-factor floor —
 *       a strategy whose profit factor < the production minimum R/R floor
 *       cannot be qualified (both express "reward must dominate risk").
 *     - MIN_SAMPLE_SIZE (100) — smallest sample for which the Wilson 95%
 *       lower bound is still meaningful at the granularity the screener
 *       publishes; imported from screener-config if exported, else pinned
 *       here and documented.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'strategy-registry.json');

// Minimum qualification thresholds. MIN_RR_RATIO is genuinely defined in
// lib/screener-config.js; MIN_SAMPLE_SIZE is not exported there, so it is
// pinned here (same value the V3-F03 backtest treats as a minimum cohort).
let MIN_RR_RATIO = 1.5;
let MIN_PROFIT_FACTOR = 1.5;
let MIN_SAMPLE_SIZE = 100;
let MIN_EXPECTANCY_R = 0; // strictly positive net expectancy required
try {
  const sc = require('./screener-config');
  if (sc && Number.isFinite(Number(sc.MIN_RR_RATIO))) MIN_RR_RATIO = Number(sc.MIN_RR_RATIO);
  if (sc && Number.isFinite(Number(sc.MIN_PROFIT_FACTOR))) MIN_PROFIT_FACTOR = Number(sc.MIN_PROFIT_FACTOR);
  if (sc && Number.isFinite(Number(sc.MIN_SAMPLE_SIZE))) MIN_SAMPLE_SIZE = Number(sc.MIN_SAMPLE_SIZE);
} catch (_) { /* thresholds keep pinned defaults */ }

class StrategyRegistryError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'StrategyRegistryError';
    this.code = code;
  }
}

const APPROVAL_REQUIRED = 'APPROVAL_REQUIRED';
const NO_QUALIFIED_STRATEGY = 'NO_QUALIFIED_STRATEGY';

function emptyRegistry() {
  return {
    status: 'EMPTY',
    schema: 1,
    updatedAt: null,
    strategies: {},
    auditLog: []
  };
}

function loadRegistry(registryPath) {
  const p = registryPath || REGISTRY_PATH;
  if (!fs.existsSync(p)) return emptyRegistry();
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!doc || typeof doc !== 'object') return emptyRegistry();
    if (!doc.strategies || typeof doc.strategies !== 'object') doc.strategies = {};
    if (!Array.isArray(doc.auditLog)) doc.auditLog = [];
    if (!doc.status) doc.status = Object.keys(doc.strategies).length === 0 ? 'EMPTY' : 'ACTIVE';
    return doc;
  } catch (_) {
    // Corrupt registry is NOT silently reset — surface the failure.
    throw new StrategyRegistryError('REGISTRY_CORRUPT', 'data/strategy-registry.json is not valid JSON');
  }
}

function saveRegistry(registry, registryPath) {
  const p = registryPath || REGISTRY_PATH;
  registry.updatedAt = new Date().toISOString();
  registry.status = Object.keys(registry.strategies).length === 0 ? 'EMPTY' : 'ACTIVE';
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

function nowIso() { return new Date().toISOString(); }

/**
 * Register a strategy version. Writes only when approvedBy is present.
 * @returns {{ok:true, id, version}} on success
 * @throws StrategyRegistryError APPROVAL_REQUIRED when approvedBy missing
 */
function registerStrategy(spec, opts) {
  const o = opts || {};
  const p = o.registryPath || REGISTRY_PATH;
  if (!spec || typeof spec !== 'object') {
    throw new StrategyRegistryError('INVALID_SPEC', 'registerStrategy requires a spec object');
  }
  const id = String(spec.id || '').trim();
  const version = String(spec.version || '').trim();
  if (!id || !version) {
    throw new StrategyRegistryError('INVALID_SPEC', 'registerStrategy requires id and version');
  }
  if (!spec.approvedBy || !String(spec.approvedBy).trim()) {
    throw new StrategyRegistryError(APPROVAL_REQUIRED,
      'registerStrategy(' + id + '@' + version + ') rejected: approvedBy is required');
  }
  const registry = loadRegistry(p);
  const entry = {
    id,
    version,
    metrics: spec.metrics || null,
    approvedBy: String(spec.approvedBy).trim(),
    approvedAt: spec.approvedAt || nowIso(),
    evidence: spec.evidence || null,
    registeredAt: nowIso()
  };
  registry.strategies[id] = registry.strategies[id] || { versions: {} };
  registry.strategies[id].versions[version] = entry;
  if (!registry.strategies[id].production) registry.strategies[id].production = null;
  registry.auditLog.push({
    at: entry.registeredAt,
    event: 'REGISTER_STRATEGY',
    id, version,
    approvedBy: entry.approvedBy
  });
  saveRegistry(registry, p);
  return { ok: true, id, version };
}

/**
 * Returns the approved production version record for `id`, or null.
 * NEVER a default; never a silent fallback.
 */
function getApprovedStrategy(id, opts) {
  const o = opts || {};
  const registry = loadRegistry(o.registryPath || REGISTRY_PATH);
  const s = registry.strategies[String(id || '').trim()];
  if (!s || !s.production) return null;
  const rec = s.versions[s.production.version];
  if (!rec) return null; // registry inconsistency → honest null, no fallback
  return Object.assign({}, rec, { productionSince: s.production.since || null, productionReason: s.production.reason || null });
}

/**
 * Promote `version` of `id` to production. REQUIRES explicit approval.
 * @throws StrategyRegistryError APPROVAL_REQUIRED unless opts.approved===true && opts.approvedBy
 * @throws StrategyRegistryError VERSION_NOT_REGISTERED when version unknown
 */
function setProductionStrategy(id, version, opts) {
  const o = opts || {};
  const p = o.registryPath || REGISTRY_PATH;
  const sid = String(id || '').trim();
  const sver = String(version || '').trim();
  const approved = o.approved === true && o.approvedBy && String(o.approvedBy).trim().length > 0;
  if (!approved) {
    throw new StrategyRegistryError(APPROVAL_REQUIRED,
      'setProductionStrategy(' + sid + '@' + sver + ') rejected: explicit approval required ' +
      '(opts.approved === true AND opts.approvedBy)');
  }
  const registry = loadRegistry(p);
  const s = registry.strategies[sid];
  if (!s || !s.versions || !s.versions[sver]) {
    throw new StrategyRegistryError('VERSION_NOT_REGISTERED',
      'setProductionStrategy(' + sid + '@' + sver + ') rejected: version not registered');
  }
  // Approval is necessary but not sufficient. Unqualified strategies must
  // never become the production version, even when signed off by an operator.
  const qualification = isQualified(s.versions[sver].metrics);
  if (!qualification.qualified) {
    throw new StrategyRegistryError('QUALIFICATION_REQUIRED',
      'setProductionStrategy(' + sid + '@' + sver + ') rejected: ' + qualification.reasons.join('; '));
  }
  const previous = s.production ? s.production.version : null;
  s.production = { version: sver, since: nowIso(), reason: o.reason || null, approvedBy: String(o.approvedBy).trim() };
  registry.auditLog.push({
    at: s.production.since,
    event: 'SET_PRODUCTION_STRATEGY',
    id: sid,
    previousVersion: previous,
    newVersion: sver,
    reason: o.reason || null,
    approvedBy: s.production.approvedBy
  });
  saveRegistry(registry, p);
  return { ok: true, id: sid, version: sver, previousVersion: previous };
}

/**
 * Qualification gate: positive net expectancy + minimum sample size +
 * profit factor >= MIN_RR_RATIO (threshold reused from screener-config).
 * @returns {{qualified:boolean, reasons:string[]}}
 */
function isQualified(metrics, options) {
  const reasons = [];
  const m = metrics || {};
  const o = options || {};
  const configured = Number(o.minProfitFactor);
  const minProfitFactor = o.minProfitFactor != null && Number.isFinite(configured) && configured > 0
    ? configured : MIN_PROFIT_FACTOR;
  const sampleSize = Number(m.sampleSize != null ? m.sampleSize : m.signals);
  const expectancyR = Number(m.expectancyR);
  const profitFactor = Number(m.profitFactor);
  if (!Number.isFinite(sampleSize) || sampleSize < MIN_SAMPLE_SIZE) {
    reasons.push('sampleSize ' + sampleSize + ' < MIN_SAMPLE_SIZE ' + MIN_SAMPLE_SIZE);
  }
  if (!Number.isFinite(expectancyR) || expectancyR <= MIN_EXPECTANCY_R) {
    reasons.push('expectancyR ' + expectancyR + ' <= ' + MIN_EXPECTANCY_R + ' (net expectancy must be positive)');
  }
  if (!Number.isFinite(profitFactor) || profitFactor < minProfitFactor) {
    reasons.push('profitFactor ' + profitFactor + ' < MIN_PROFIT_FACTOR ' + minProfitFactor);
  }
  return { qualified: reasons.length === 0, reasons };
}

/**
 * Highest-version registered strategy for `id` that passes qualification.
 * @returns the version record, or the sentinel string NO_QUALIFIED_STRATEGY.
 */
function getQualifiedStrategy(id, opts) {
  const o = opts || {};
  const registry = loadRegistry(o.registryPath || REGISTRY_PATH);
  const s = registry.strategies[String(id || '').trim()];
  if (!s || !s.versions) return NO_QUALIFIED_STRATEGY;
  const versions = Object.keys(s.versions).sort((a, b) => {
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a < b ? -1 : (a > b ? 1 : 0);
  });
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const rec = s.versions[versions[i]];
    if (isQualified(rec.metrics).qualified) return rec;
  }
  return NO_QUALIFIED_STRATEGY;
}

/* -------------------------------------------------------------------------- */
/* v3-f03 params file approval verification (N20 loader-side guard)            */
/* -------------------------------------------------------------------------- */

/**
 * Canonical payload of config/v3-f03-winning-params.json = the strategy
 * content WITHOUT the approval envelope. The checksum is computed over this
 * canonical serialization so any parameter edit invalidates the approval.
 */
function canonicalParamsPayload(raw) {
  return JSON.stringify({
    konglo: raw.konglo,
    nonkonglo: raw.nonkonglo,
    daytrade: raw.daytrade,
    horizons: raw.horizons,
    metrics: raw.metrics
  });
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Verify config/v3-f03-winning-params.json carries valid approval metadata:
 * approved===true, approvedBy, approved_at, immutable version, and a
 * sha256 checksum that matches the canonical params payload.
 * @returns {{ok:true, version, approvedBy}} or {{ok:false, reason}}
 */
function verifyParamsApproval(paramsPath) {
  const p = paramsPath || path.join(__dirname, '..', 'config', 'v3-f03-winning-params.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    return { ok: false, reason: 'unreadable: ' + err.message };
  }
  const approval = raw.approval || {};
  if (approval.approved !== true) return { ok: false, reason: 'approval.approved is not true' };
  if (!approval.approvedBy || !String(approval.approvedBy).trim()) return { ok: false, reason: 'approval.approvedBy missing' };
  if (!approval.approved_at) return { ok: false, reason: 'approval.approved_at missing' };
  if (!approval.version) return { ok: false, reason: 'approval.version missing' };
  if (!approval.checksum) return { ok: false, reason: 'approval.checksum missing' };
  const actual = sha256Hex(canonicalParamsPayload(raw));
  if (actual !== approval.checksum) {
    return { ok: false, reason: 'checksum mismatch (params edited after approval): expected ' + approval.checksum + ', actual ' + actual };
  }
  return { ok: true, version: approval.version, approvedBy: approval.approvedBy, checksum: actual };
}

module.exports = {
  STRATEGY_REGISTRY_PATH: REGISTRY_PATH,
  APPROVAL_REQUIRED,
  QUALIFICATION_REQUIRED: 'QUALIFICATION_REQUIRED',
  NO_QUALIFIED_STRATEGY,
  MIN_RR_RATIO,
  MIN_PROFIT_FACTOR,
  MIN_SAMPLE_SIZE,
  StrategyRegistryError,
  emptyRegistry,
  loadRegistry,
  saveRegistry,
  registerStrategy,
  getApprovedStrategy,
  setProductionStrategy,
  isQualified,
  getQualifiedStrategy,
  verifyParamsApproval,
  canonicalParamsPayload,
  sha256Hex
};
