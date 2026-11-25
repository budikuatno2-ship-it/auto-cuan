'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'data', 'three-horizon-config.json');
const DEFAULT_AUDIT_PATH = path.join(ROOT, 'data', 'three-horizon-audit.jsonl');

const HORIZON_KEYS = Object.freeze(['potensi_besok', 'short_swing', 'swing']);

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  updatedAt: null,
  updatedBy: 'system',
  reason: 'Default V6.5 Three-Horizon configuration',
  minRr: 1.5,
  topN: 20,
  topSlice: 5,
  horizons: {
    potensi_besok: {
      key: 'potensi_besok',
      label: 'Potensi Besok',
      holdingLabel: '1–5 Hari',
      minHoldingDays: 1,
      maxHoldingDays: 5,
      lookbackDays: 5,
      weights: { bandar: 35, foreign: 30, technical: 20, volume: 15 }
    },
    short_swing: {
      key: 'short_swing',
      label: 'Short Swing',
      holdingLabel: '3–10 Hari',
      minHoldingDays: 3,
      maxHoldingDays: 10,
      lookbackDays: 10,
      weights: { bandar: 30, foreign: 25, technical: 30, volume: 15 }
    },
    swing: {
      key: 'swing',
      label: 'Swing',
      holdingLabel: '7–30 Hari',
      minHoldingDays: 7,
      maxHoldingDays: 30,
      lookbackDays: 14,
      weights: { bandar: 25, foreign: 25, technical: 35, volume: 15 }
    }
  }
});

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function configPath(opts = {}) {
  return opts.filePath || process.env.AUTO_CUAN_THREE_HORIZON_CONFIG || DEFAULT_CONFIG_PATH;
}

function auditPath(opts = {}) {
  return opts.auditPath || DEFAULT_AUDIT_PATH;
}

function atomicWriteJson(fp, value) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, fp);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function normalizeDoc(raw) {
  const base = clone(DEFAULT_CONFIG);
  if (!raw || typeof raw !== 'object') return base;
  if (Number.isInteger(raw.version) && raw.version >= 1) base.version = raw.version;
  if (raw.updatedAt) base.updatedAt = String(raw.updatedAt);
  if (raw.updatedBy) base.updatedBy = String(raw.updatedBy);
  if (raw.reason) base.reason = String(raw.reason);
  if (Number.isFinite(Number(raw.minRr)) && Number(raw.minRr) >= 1.2) base.minRr = Number(raw.minRr);
  for (const key of HORIZON_KEYS) {
    const src = raw.horizons && raw.horizons[key];
    if (!src || typeof src !== 'object') continue;
    const dst = base.horizons[key];
    if (Number.isInteger(Number(src.lookbackDays)) && Number(src.lookbackDays) >= 1 && Number(src.lookbackDays) <= 250) {
      dst.lookbackDays = Number(src.lookbackDays);
    }
    if (src.weights && typeof src.weights === 'object') {
      const nextWeights = {};
      for (const p of ['bandar', 'foreign', 'technical', 'volume']) {
        const w = Number(src.weights[p]);
        if (Number.isFinite(w) && w >= 0 && w <= 100) nextWeights[p] = Math.round(w);
      }
      if (Object.keys(nextWeights).length === 4) {
        const sum = nextWeights.bandar + nextWeights.foreign + nextWeights.technical + nextWeights.volume;
        if (sum === 100) dst.weights = nextWeights;
      }
    }
  }
  return base;
}

function get(opts = {}) {
  const fp = configPath(opts);
  try {
    if (!fs.existsSync(fp)) {
      return { ok: true, doc: clone(DEFAULT_CONFIG), source: 'default' };
    }
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return { ok: true, doc: normalizeDoc(raw), source: fp };
  } catch (err) {
    return { ok: false, reason: 'READ_FAILED', error: err.message };
  }
}

function validatePatch(patch) {
  const errors = [];
  if (!patch || typeof patch !== 'object') {
    return ['Patch konfigurasi wajib berupa objek.'];
  }
  if (patch.minRr != null) {
    const mr = Number(patch.minRr);
    if (!Number.isFinite(mr) || mr < 1.2 || mr > 5) {
      errors.push('minRr harus berada di rentang 1.2 - 5.0.');
    }
  }
  if (patch.horizons && typeof patch.horizons === 'object') {
    for (const [key, cfg] of Object.entries(patch.horizons)) {
      if (!HORIZON_KEYS.includes(key)) {
        errors.push(`Horizon tidak dikenal: ${key}`);
        continue;
      }
      if (!cfg || typeof cfg !== 'object') {
        errors.push(`Konfigurasi ${key} tidak valid.`);
        continue;
      }
      if (cfg.lookbackDays != null) {
        const lb = Number(cfg.lookbackDays);
        if (!Number.isInteger(lb) || lb < 1 || lb > 250) {
          errors.push(`lookbackDays ${key} harus integer 1..250.`);
        }
      }
      if (cfg.weights != null) {
        if (typeof cfg.weights !== 'object') {
          errors.push(`weights ${key} tidak valid.`);
        } else {
          let sum = 0;
          for (const pillar of ['bandar', 'foreign', 'technical', 'volume']) {
            const w = Number(cfg.weights[pillar]);
            if (!Number.isFinite(w) || w < 0 || w > 100) {
              errors.push(`Bobot ${pillar} pada ${key} harus 0..100.`);
            } else {
              sum += Math.round(w);
            }
          }
          if (Math.round(sum) !== 100) {
            errors.push(`Total bobot pilar pada ${key} harus tepat 100 (saat ini ${sum}).`);
          }
        }
      }
    }
  }
  return errors;
}

function put(patch, meta = {}, opts = {}) {
  const errors = validatePatch(patch);
  if (errors.length) {
    return { ok: false, reason: 'VALIDATION_FAILED', errors };
  }
  const current = get(opts);
  if (!current.ok) return current;
  const doc = current.doc;
  if (meta.expectedVersion != null && Number(meta.expectedVersion) !== doc.version) {
    return { ok: false, reason: 'CONFLICT', currentVersion: doc.version, doc };
  }

  const next = clone(doc);
  if (patch.minRr != null) next.minRr = Number(Number(patch.minRr).toFixed(2));
  if (patch.horizons && typeof patch.horizons === 'object') {
    for (const key of HORIZON_KEYS) {
      const p = patch.horizons[key];
      if (!p) continue;
      if (p.lookbackDays != null) next.horizons[key].lookbackDays = Number(p.lookbackDays);
      if (p.weights) {
        next.horizons[key].weights = {
          bandar: Math.round(Number(p.weights.bandar)),
          foreign: Math.round(Number(p.weights.foreign)),
          technical: Math.round(Number(p.weights.technical)),
          volume: Math.round(Number(p.weights.volume))
        };
      }
    }
  }
  next.version = doc.version + 1;
  next.updatedAt = (meta.now instanceof Date ? meta.now : new Date()).toISOString();
  next.updatedBy = String(meta.actor || 'admin');
  next.reason = String(meta.reason || 'Update Three-Horizon config').trim();

  const fp = configPath(opts);
  atomicWriteJson(fp, next);
  try {
    const ap = auditPath(opts);
    fs.mkdirSync(path.dirname(ap), { recursive: true });
    fs.appendFileSync(ap, JSON.stringify({
      at: next.updatedAt,
      actor: next.updatedBy,
      reason: next.reason,
      fromVersion: doc.version,
      toVersion: next.version,
      horizons: next.horizons,
      minRr: next.minRr
    }) + '\n', 'utf8');
  } catch (_) {}

  const readback = get(opts);
  return {
    ok: true,
    version: next.version,
    readbackOk: Boolean(readback.ok && readback.doc && readback.doc.version === next.version),
    config: readback.ok ? readback.doc : next
  };
}

module.exports = {
  HORIZON_KEYS,
  DEFAULT_CONFIG,
  get,
  put,
  validatePatch,
  normalizeDoc
};
