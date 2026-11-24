'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const store = require('./admin-schedule-store');
const engine = require('./admin-schedule-engine');
const quotaStore = require('./quota-config-store');
const calendar = require('./idx-trading-calendar');
const { atomicWrite, readJson, verifyOutput, sha, createAdapters } = require('./v6-scheduler-adapters.cjs');

const INACTIVE = new Set(['telegram', 'quota-backfill', 'coordinated-pipeline', 'hourly-confirmation', 'daytrade-fastwatcher', 'fastwatcher', 'daytrade-producer', 'oracle-monitoring']);
// Shared Admin/store/worker mandatory DAG; no divergent worker-only preset.
const PARENTS = Object.fromEntries(store.JOB_CATALOG.map(def => [def.key, (def.dependsOn || []).slice()]));
const PAID = new Set(['ihsg', 'broksum-all', 'broksum-foreign', 'insider', 'fundamental']);
function retryDelayMs(attempt, quota, random = Math.random) {
  return Math.floor(Math.min(3600000, Number(quota.backoffBaseMs) * 2 ** Math.min(20, attempt - 1)) * (0.75 + Math.max(0, Math.min(1, random())) * 0.5));
}
function blankState() { return { schemaVersion: 1, realm: null, jobs: {}, paidGuard: null, usage: {}, loaded: null }; }
function readState(file) {
  const state = readJson(file, blankState());
  if (state.schemaVersion !== 1 || !state.jobs || (state.realm != null && typeof state.realm !== 'string')) throw new Error('STATE_CORRUPT');
  if (!state.usage || typeof state.usage !== 'object') state.usage = {};
  if (state.paidGuard === undefined) state.paidGuard = null;
  if (state.loaded === undefined) state.loaded = null;
  return state;
}
function serviceFor(key) {
  if (key === 'broksum-foreign') return 'foreign';
  if (key.startsWith('broksum') || ['domestic-compile', 'accumulation', 'bandarmologi', 'top20', 'top5'].includes(key)) return 'broksum';
  if (key === 'insider') return 'insider';
  if (key === 'fundamental') return 'financial';
  return 'candles';
}
function paidDecision(job, quota, truth, usage, now, cost) {
  // This arithmetic never authorizes a provider call in this implementation.
  if (!truth || truth.realm !== 'PRODUCTION' || truth.known !== true || typeof truth.remaining !== 'number' || !Number.isFinite(truth.remaining) || truth.remaining < 0 ||
      typeof truth.limit !== 'number' || !Number.isFinite(truth.limit) || truth.limit < truth.remaining || typeof truth.used !== 'number' || !Number.isFinite(truth.used) || truth.used < 0 || Math.abs(truth.limit - truth.used - truth.remaining) > 0.001) return { ok: false, reason: 'QUOTA_UNKNOWN' };
  const age = now.getTime() - Date.parse(truth.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > Number(quota.staleThresholdMinutes) * 60000 || !['VERIFIED', 'PROVIDER_VERIFIED'].includes(truth.verificationStatus) || truth.date !== engine.jakartaDateKey(now)) return { ok: false, reason: 'QUOTA_STALE_OR_UNVERIFIED' };
  if (quota.planExpiresAt && Date.parse(quota.planExpiresAt) <= now.getTime()) return { ok: false, reason: 'PLAN_EXPIRED' };
  if (!cost || !Number.isSafeInteger(cost.httpRequests) || cost.httpRequests < 0 || typeof cost.billedUnits !== 'number' || !Number.isFinite(cost.billedUnits) || cost.billedUnits < 0 || !cost.verified) return { ok: false, reason: 'ENDPOINT_COST_UNKNOWN' };
  const minutes = engine.jakartaHoursMinutes(now);
  const weekend = [0, 6].includes(engine.jakartaWeekday(now));
  const configuredFloor = weekend ? quota.reserveFloorWeekend : quota.reserveFloorWeekday;
  if (configuredFloor == null || !Number.isFinite(configuredFloor) || quota.configuredOperatingCap == null || !Number.isFinite(quota.configuredOperatingCap) || typeof truth.currentDayObligations !== 'number' || !Number.isFinite(truth.currentDayObligations) || truth.currentDayObligations < 0) return { ok: false, reason: 'BUDGET_OBLIGATIONS_UNKNOWN' };
  const floor = configuredFloor;
  const available = Math.min(truth.remaining, Math.max(0, quota.configuredOperatingCap - truth.used)) - floor - truth.currentDayObligations - (usage.reservedUnits || 0);
  if (available < cost.billedUnits) return { ok: false, reason: 'QUOTA_RESERVE_OR_OBLIGATIONS', available, floor, httpRequests: cost.httpRequests, billedUnits: cost.billedUnits };
  if (minutes >= store.timeToMinutes(quota.hardStopWIB)) return { ok: false, reason: 'HARD_STOP' };
  return { ok: true, available, floor, httpRequests: cost.httpRequests, billedUnits: cost.billedUnits };
}
function policyDue(job, date, disclosures = []) {
  const policy = job.policy;
  if (!policy) return { ok: false, reason: 'ADMIN_DISCLOSURE_POLICY_UNCONFIGURED' };
  if (job.key === 'insider') {
    const due = [];
    for (const tier of policy.tiers || []) for (const ticker of tier.tickers) {
      const item = disclosures.find((r) => r.ticker === ticker && r.kind === 'insider');
      if (!item || !item.publishedAt || item.publishedAt > date || !item.nextDueDate || item.nextDueDate > date) continue;
      if (item.lastCheckedDate && (Date.parse(date) - Date.parse(item.lastCheckedDate)) / 86400000 < tier.intervalDays) continue;
      due.push({ ticker, tier: tier.name });
    }
    return { ok: due.length > 0, reason: due.length ? 'DUE' : 'PENDING_DISCLOSURE', due };
  }
  const md = date.slice(5);
  const due = [];
  for (const window of policy.windows || []) {
    const inWindow = window.start <= window.end ? md >= window.start && md <= window.end : md >= window.start || md <= window.end;
    if (!inWindow) continue;
    for (const item of disclosures) if (item.kind === 'financial' && item.period === window.period && item.publishedAt && item.publishedAt <= date && item.nextDueDate && item.nextDueDate <= date && (!item.lastCheckedDate || (Date.parse(date) - Date.parse(item.lastCheckedDate)) / 86400000 >= policy.retryDays)) due.push({ ticker: item.ticker, period: item.period, fiscalYear: item.fiscalYear });
  }
  return { ok: due.length > 0, reason: due.length ? 'DUE' : 'PENDING_PUBLICATION_WINDOW', due };
}

function createDispatcher(options = {}) {
  if (!options.statePath || !options.adapterOptions) throw new Error('Explicit isolated statePath and adapterOptions required; dispatcher is not activated by importing');
  const statePath = path.resolve(options.statePath);
  const lockDbPath = statePath + '.lock.sqlite';
  const registry = options.adapters || createAdapters(options.adapterOptions);
  const realm = registry.realm;
  const now = options.now || (() => new Date());
  const random = options.random || Math.random;
  const readSchedule = options.readSchedule || store.get;
  const readQuota = options.readQuota || quotaStore.get;
  const readTruth = options.readProviderQuota || (() => ({ known: false, remaining: null }));
  const cycle = async () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const db = new DatabaseSync(lockDbPath);
    let locked = false;
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); locked = true;
    } catch (err) {
      db.close(); if (/locked|busy/i.test(err.message)) return { status: 'LOCKED', ran: [], blocked: [] }; throw err;
    }
    try {
      const instant = now();
      if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new Error('CLOCK_INVALID');
      const schedule = readSchedule(); const quotaRead = readQuota();
      if (!schedule || !schedule.ok || !schedule.doc || !Number.isSafeInteger(schedule.doc.version)) return { status: 'SCHEDULE_UNKNOWN', ran: [], blocked: [] };
      if (!quotaRead || !quotaRead.ok || !quotaRead.doc || !Number.isSafeInteger(quotaRead.doc.version)) return { status: 'QUOTA_CONFIG_UNKNOWN', ran: [], blocked: [] };
      const quota = quotaRead.doc;
      if (!Number.isInteger(quota.concurrency) || quota.concurrency < 1 || !Number.isInteger(quota.retryCount) || quota.retryCount < 0 || !Number.isFinite(quota.backoffBaseMs) || quota.backoffBaseMs < 100) throw new Error('QUOTA_CONTROLS_INVALID');
      const state = readState(statePath);
      if (state.realm && state.realm !== realm) return { status: 'STATE_REALM_MISMATCH', ran: [], blocked: [] };
      state.realm = realm;
      const date = engine.jakartaDateKey(instant);
      const snapshot = sha('v6-pipeline:' + date + ':' + realm);
      const holidaySet = new Set([...calendar.getSeedHolidaySet(), ...(options.holidays || [])]);
      if (quota.holidayManualMode === 'libur' && quota.holidayManualDateWIB === date) holidaySet.add(date);
      state.loaded = { scheduleVersion: schedule.doc.version, quotaVersion: quota.version, loadedAt: instant.toISOString(), realm, pid: process.pid, configuredConcurrency: quota.concurrency, effectiveConcurrency: 1 };
      const save = () => atomicWrite(statePath, state);
      save();
      const ran = [], blocked = [];
      const usage = state.usage[date] || (state.usage[date] = { httpRequests: 0, billedUnits: 0, reservedUnits: 0 });
      const jobs = store.JOB_CATALOG.map((def) => ({ ...schedule.doc.jobs[def.key], key: def.key, legacy_inactive: def.legacy_inactive === true, marketDaysOnly: def.marketDaysOnly, dependsOn: [...new Set([...(def.dependsOn || []), ...(schedule.doc.jobs[def.key]?.dependsOn || [])])] })).sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
      for (const job of jobs) {
        if (!job.enabled || job.legacy_inactive || INACTIVE.has(job.key)) continue;
        const slot = engine.computeTodaySlot(job, instant, holidaySet);
        if (!slot || slot > instant) continue;
        const key = date + '/' + job.key + '/' + snapshot;
        let prior = state.jobs[key];
        if (prior && prior.status === 'DONE') {
          if (!verifyOutput(prior.output) || prior.output.job !== job.key || prior.output.date !== date || prior.output.snapshot !== snapshot || prior.output.realm !== realm) blocked.push({ job: job.key, reason: 'COMPLETED_OUTPUT_CORRUPT' });
          continue;
        }
        // Readback is reconciliation, not admission of another execution. Keep
        // it inside the process lock, before retry/window/backoff checks.
        if (prior && prior.status === 'RUNNING') {
          let pending = null;
          try { pending = readJson(path.join(registry.outputDir, date, job.key + '.json.receipt.json'), null); } catch (_) { /* Conflicting receipt stays unknown. */ }
          const priorIdentity = ['job', 'date', 'snapshot'].every((field) => prior[field] === undefined || prior[field] === ({ job: job.key, date, snapshot })[field]);
          const valid = priorIdentity && pending && pending.date === date && pending.job === job.key && pending.realm === realm && pending.snapshot === snapshot && verifyOutput(pending);
          const content = valid ? readJson(pending.path, null) : null;
          const parentsValid = valid && job.dependsOn.every((dep) => {
            const record = state.jobs[date + '/' + dep + '/' + snapshot];
            const parent = content.parents && content.parents[dep];
            return record && record.status === 'DONE' && parent && record.output && parent.sha256 === record.output.sha256 && parent.date === date && parent.job === dep && parent.snapshot === snapshot && parent.realm === realm && verifyOutput(parent) && verifyOutput(record.output);
          });
          if (valid && parentsValid) {
            state.jobs[key] = { ...prior, status: 'DONE', output: pending, recoveredAt: instant.toISOString() }; save(); ran.push({ job: job.key, recovered: true, output: pending }); continue;
          }
          if (instant.getTime() - slot.getTime() > job.retryWindowMinutes * 60000 || prior.attempts >= quota.retryCount + 1) {
            blocked.push({ job: job.key, reason: 'RECOVERY_OUTPUT_MISSING_OR_CONFLICTING', state: 'UNKNOWN' }); continue;
          }
        }
        const elapsed = instant.getTime() - slot.getTime();
        if (elapsed > job.retryWindowMinutes * 60000) {
          if (!prior) { state.jobs[key] = { job: job.key, date, snapshot, status: 'MISSED', scheduleVersion: schedule.doc.version, observedAt: instant.toISOString() }; save(); }
          blocked.push({ job: job.key, reason: 'MISSED_RETRY_WINDOW' }); continue;
        }
        const pause = quota.pausedServices || {};
        if (quota.killSwitch === true || pause.all === true || pause[serviceFor(job.key)] === true || (job.key === 'broksum-foreign' && pause.broksum === true)) { blocked.push({ job: job.key, reason: quota.killSwitch ? 'KILL_SWITCH' : 'PAUSED' }); continue; }
        if (options.legacyGuard !== false || realm !== 'OFFLINE') {
          const active = engine.controlPlane.readLegacyActive(options.legacyActivePath);
          const cls = engine.controlPlane.SIDE_EFFECT_CLASS[job.key];
          if (cls && engine.controlPlane.activeExecutorsForClass(cls, active.activeNames).length) { blocked.push({ job: job.key, reason: 'BLOCKED_LEGACY_ACTIVE' }); continue; }
        }
        const parents = {};
        let dependency;
        for (const dep of job.dependsOn) {
          const record = state.jobs[date + '/' + dep + '/' + snapshot];
          if (!record || record.status !== 'DONE' || !record.output || record.output.realm !== realm || record.output.date !== date || record.output.snapshot !== snapshot || record.output.job !== dep || !verifyOutput(record.output)) { dependency = dep; break; }
          parents[dep] = record.output;
        }
        if (dependency) { blocked.push({ job: job.key, reason: 'DEPENDENCY_UNVERIFIED', dependency }); continue; }
        if (['fundamental', 'insider'].includes(job.key)) {
          const due = policyDue(job, date, options.readDisclosures ? options.readDisclosures() : []);
          if (!due.ok) { blocked.push({ job: job.key, reason: due.reason }); continue; }
        }
        if (state.paidGuard && PAID.has(job.key)) { blocked.push({ job: job.key, reason: 'PERSISTENT_PAID_GUARD', guard: state.paidGuard }); continue; }
        if (prior && prior.nextAttemptAt && Date.parse(prior.nextAttemptAt) > instant.getTime()) { blocked.push({ job: job.key, reason: 'BACKOFF', nextAttemptAt: prior.nextAttemptAt }); continue; }
        if (prior && prior.attempts >= quota.retryCount + 1) { blocked.push({ job: job.key, reason: 'RETRY_EXHAUSTED' }); continue; }
        if (prior && prior.retryable === false && prior.status !== 'MISSED' && prior.status !== 'RUNNING') { blocked.push({ job: job.key, reason: prior.status }); continue; }
        if (ran.length >= quota.concurrency) { blocked.push({ job: job.key, reason: 'CYCLE_CAPACITY' }); continue; }
        if (realm === 'PRODUCTION' && PAID.has(job.key)) {
          blocked.push({ job: job.key, reason: 'PAID_ADAPTER_NOT_AUTHORIZED' });
          continue;
        }
        const entry = { job: job.key, date, snapshot, status: 'RUNNING', attempts: (prior && prior.attempts || 0) + 1, configVersion: schedule.doc.version, quotaVersion: quota.version, startedAt: instant.toISOString(), parents, httpRequests: 0, billedUnits: 0 };
        state.jobs[key] = entry; save();
        let result;
        try { result = await registry.run(job.key, { date, snapshot, configVersion: schedule.doc.version, quotaVersion: quota.version, now: instant, parents, realm, policy: job.policy }); }
        catch (_) { result = { status: 'FAILED_ADAPTER', retryable: true, httpRequests: 0, billedUnits: 0 }; }
        entry.status = result && result.status || 'FAILED_ADAPTER'; entry.retryable = result && result.retryable === true;
        // This dispatcher cannot issue paid calls; adapters claiming consumption
        // are quarantined. HTTP request counts and billed units remain separate.
        if (result.httpRequests !== 0 || result.billedUnits !== 0) { entry.status = 'BLOCKED_UNAUTHORIZED_CONSUMPTION'; entry.retryable = false; state.paidGuard = { reason: 'UNAUTHORIZED_CONSUMPTION', at: instant.toISOString() }; }
        if ([429, 401, 403].includes(result.httpStatus)) { state.paidGuard = { reason: result.httpStatus === 429 ? 'HTTP_429' : 'AUTH_FAILURE', at: instant.toISOString(), status: result.httpStatus }; entry.status = 'PERSISTENT_PAID_GUARD'; entry.retryable = false; }
        if (entry.status === 'DONE') {
          if (!result.output || result.output.realm !== realm || result.output.date !== date || result.output.job !== job.key || result.output.snapshot !== snapshot || !verifyOutput(result.output)) { entry.status = 'FAILED_READBACK'; entry.retryable = true; }
          else entry.output = result.output;
        }
        // Blocked sources are reported honestly. Quota arithmetic is diagnostic;
        // verified cache reuse above costs zero and needs no provider permission.
        if (entry.status === 'PENDING_PROVIDER' && PAID.has(job.key)) entry.paidDecision = paidDecision(job, quota, readTruth(), usage, instant, options.endpointCosts && options.endpointCosts[job.key]);
        entry.finishedAt = now().toISOString();
        if (entry.retryable) entry.nextAttemptAt = new Date(instant.getTime() + retryDelayMs(entry.attempts, quota, random)).toISOString();
        save();
        if (entry.status === 'DONE') ran.push({ job: job.key, output: entry.output, configVersion: entry.configVersion });
        else blocked.push({ job: job.key, reason: entry.status, detail: result.detail || null, paidDecision: entry.paidDecision || null, nextAttemptAt: entry.nextAttemptAt || null });
      }
      return { status: 'OK', date, snapshot, realm, scheduleVersion: schedule.doc.version, quotaVersion: quota.version, effectiveConcurrency: 1, configuredConcurrency: quota.concurrency, usage, ran, blocked };
    } finally { if (locked) db.exec('ROLLBACK'); db.close(); }
  };
  return { cycle, statePath, status: () => readState(statePath) };
}
module.exports = { createDispatcher, readState, paidDecision, policyDue, retryDelayMs, INACTIVE, PARENTS };
