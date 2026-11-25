'use strict';

// No network, child processes, provider SDKs, Telegram or production DB writes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}
function validateCandles(raw, job, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || raw.source !== 'yahoo' || !Array.isArray(raw.rows) || !raw.rows.length) throw new Error('OHLCV_INVALID_SOURCE_OR_DATE');
  const seen = new Set();
  for (const row of raw.rows) {
    const validTicker = job === 'ihsg' ? ['^JKSE', 'JKSE'].includes(row && row.ticker) : /^[A-Z0-9]{2,10}$/.test(row && row.ticker || '');
    if (!validTicker || row.date !== date || seen.has(row.ticker)) throw new Error('OHLCV_INVALID_IDENTITY');
    seen.add(row.ticker);
    for (const field of ['open', 'high', 'low', 'close']) if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] <= 0) throw new Error('OHLCV_INVALID_PRICE');
    if (typeof row.volume !== 'number' || !Number.isFinite(row.volume) || row.volume < 0) throw new Error('OHLCV_INVALID_VOLUME');
    if (row.high < Math.max(row.open, row.close, row.low) || row.low > Math.min(row.open, row.close, row.high)) throw new Error('OHLCV_INVALID_GEOMETRY');
  }
}
function verifyOutput(record) {
  if (!record || !record.path || !/^[a-f0-9]{64}$/.test(record.sha256 || '')) return false;
  try {
    const bytes = fs.readFileSync(record.path);
    const value = JSON.parse(bytes);
    if (['yahoo-ohlcv', 'ihsg'].includes(record.job)) validateCandles(value, record.job, record.date);
    return sha(bytes) === record.sha256 && value.trade_date === record.date && value.job === record.job &&
      value.snapshot === record.snapshot && value.realm === record.realm;
  } catch (_) { return false; }
}
function publish(file, content, metadata) {
  const value = Object.assign({}, content, { job: metadata.job, trade_date: metadata.date, snapshot: metadata.snapshot, realm: metadata.realm || 'OFFLINE' });
  // Immutable content-addressed output; crash between output write and ledger
  // commit can be recovered without repeating the transformation or publishing.
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  const target = file.replace(/\.json$/, '') + '.' + sha(bytes) + '.json';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { const fd = fs.openSync(target, 'wx'); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  catch (err) { if (err.code !== 'EEXIST') throw err; if (sha(fs.readFileSync(target)) !== sha(bytes)) throw new Error('IMMUTABLE_OUTPUT_CONFLICT'); }
  const receipt = { path: target, sha256: sha(bytes), date: metadata.date, job: metadata.job, snapshot: metadata.snapshot, realm: value.realm };
  if (!verifyOutput(receipt)) throw new Error('OUTPUT_READBACK_FAILED');
  atomicWrite(file + '.receipt.json', receipt);
  return receipt;
}
function inside(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function createAdapters(options = {}) {
  if (!options.outputDir || !options.cachedDir) throw new Error('Explicit outputDir and cachedDir required; no runtime activation defaults');
  const outputDir = path.resolve(options.outputDir);
  const cachedDir = path.resolve(options.cachedDir);
  const realm = options.realm || 'PRODUCTION';
  if (!['PRODUCTION', 'OFFLINE'].includes(realm)) throw new Error('Invalid evidence realm');
  if (realm === 'OFFLINE' && inside(path.resolve(__dirname, '..', 'data'), outputDir)) throw new Error('OFFLINE_OUTPUT_CANNOT_USE_PRODUCTION_DATA');

  function loadSource(job, date, now) {
    const receiptFile = path.join(cachedDir, date, job + '.json');
    const receipt = readJson(receiptFile, null);
    if (!receipt) return null;
    if (receipt.realm !== realm || receipt.trade_date !== date || receipt.job !== job || receipt.status !== 'VERIFIED' ||
        !receipt.rawFile || !/^[a-f0-9]{64}$/.test(receipt.rawSha256 || '') || !receipt.publishedAt || !receipt.retrievedAt ||
        Date.parse(receipt.publishedAt) > now.getTime() || Date.parse(receipt.retrievedAt) > now.getTime() ||
        !Number.isFinite(Date.parse(receipt.publishedAt)) || !Number.isFinite(Date.parse(receipt.retrievedAt))) throw new Error('UNPROVEN_SOURCE_RECEIPT');
    const rawFile = path.resolve(path.dirname(receiptFile), receipt.rawFile);
    if (!inside(cachedDir, rawFile) || !inside(fs.realpathSync(cachedDir), fs.realpathSync(rawFile))) throw new Error('SOURCE_PATH_OUTSIDE_CACHE');
    const bytes = fs.readFileSync(rawFile);
    if (sha(bytes) !== receipt.rawSha256) throw new Error('SOURCE_HASH_MISMATCH');
    const raw = JSON.parse(bytes);
    if (raw.trade_date !== date || raw.realm !== realm || raw.market !== 'REGULAR' || !Array.isArray(raw.rows) || !raw.rows.length) throw new Error('SOURCE_SCHEMA_DATE_OR_MARKET');
    if (['yahoo-ohlcv', 'ihsg'].includes(job)) validateCandles(raw, job, date);
    if (job.startsWith('broksum-')) {
      if (raw.units !== 'IDR_SHARES' || raw.complete !== true || raw.flow !== (job === 'broksum-all' ? 'ALL' : 'F')) throw new Error('SOURCE_FLOW_UNITS_OR_COMPLETENESS');
      const seen = new Set();
      for (const row of raw.rows) {
        if (!/^[A-Z0-9]{2,10}$/.test(row.ticker || '') || !/^[A-Z0-9]{2,4}$/.test(row.broker_code || '') || seen.has(row.ticker + '/' + row.broker_code)) throw new Error('SOURCE_DUPLICATE_OR_IDENTITY');
        seen.add(row.ticker + '/' + row.broker_code);
        for (const field of ['bval', 'sval', 'bvol', 'svol']) if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0 || (field.endsWith('vol') && !Number.isSafeInteger(row[field]))) throw new Error('SOURCE_UNKNOWN_OR_INVALID_NUMBER');
      }
    }
    return { raw, provenance: { receiptSha256: sha(fs.readFileSync(receiptFile)), rawSha256: receipt.rawSha256, publishedAt: receipt.publishedAt, retrievedAt: receipt.retrievedAt, realm } };
  }
  function parent(context, key) {
    const receipt = context.parents && context.parents[key];
    if (!receipt || receipt.realm !== realm || receipt.date !== context.date || receipt.snapshot !== context.snapshot || receipt.job !== key || !verifyOutput(receipt)) throw new Error('DEPENDENCY_UNVERIFIED:' + key);
    return JSON.parse(fs.readFileSync(receipt.path));
  }
  function validateRanking(snapshot, date) {
    const store = require('./saham-potensial-snapshot-store');
    if (!snapshot || snapshot.session_date !== date || !snapshot.content_hash || store.recomputeContentHash(snapshot) !== snapshot.content_hash ||
        !snapshot.snapshot_id || !Array.isArray(snapshot.top20) || snapshot.top20.length > 20 ||
        new Set(snapshot.top20.map(row => row.ticker)).size !== snapshot.top20.length ||
        snapshot.top20.some((row, i) => row.rank !== i + 1 || row.snapshot_id !== snapshot.snapshot_id || snapshot.ranking[i] !== row.ticker || typeof row.rr !== 'number' || !Number.isFinite(row.rr) || row.rr < 1.5)) {
      throw new Error('TOP20_CANONICAL_HASH_RANK_OR_RR_INVALID');
    }
  }
  function done(job, context, payload) {
    const output = publish(path.join(outputDir, context.date, job + '.json'), { schemaVersion: 1, configVersion: context.configVersion, parents: context.parents || {}, ...payload }, { date: context.date, job, snapshot: context.snapshot, realm });
    return { status: 'DONE', output, retryable: false, httpRequests: 0, billedUnits: 0 };
  }
  async function run(job, context) {
    const now = context.now || new Date();
    try {
      if (['telegram', 'coordinated-pipeline', 'hourly-confirmation', 'daytrade-fastwatcher', 'fastwatcher', 'daytrade-producer', 'oracle-monitoring'].includes(job)) return { status: 'BLOCKED_INACTIVE', retryable: false, httpRequests: 0, billedUnits: 0 };
      if (['yahoo-ohlcv', 'broksum-all', 'broksum-foreign', 'ihsg'].includes(job)) {
        const source = loadSource(job, context.date, now);
        if (!source) return { status: 'PENDING_PROVIDER', retryable: true, detail: 'No verified published cached source. External requests disabled.', httpRequests: 0, billedUnits: 0 };
        return done(job, context, { ...source.raw, provenance: source.provenance });
      }
      if (job === 'domestic-compile') {
        const all = parent(context, 'broksum-all');
        const foreign = parent(context, 'broksum-foreign');
        if (all.flow !== 'ALL' || foreign.flow !== 'F' || all.units !== 'IDR_SHARES' || foreign.units !== all.units || all.complete !== true || foreign.complete !== true) throw new Error('PARENT_FLOW_UNITS_OR_COMPLETENESS');
        const allByKey = new Map(all.rows.map((r) => [r.ticker + '/' + r.broker_code, r]));
        const fByKey = new Map(foreign.rows.map((r) => [r.ticker + '/' + r.broker_code, r]));
        const allTickers = new Set(all.rows.map((r) => r.ticker));
        const fTickers = new Set(foreign.rows.map((r) => r.ticker));
        if (allTickers.size !== fTickers.size || [...allTickers].some((t) => !fTickers.has(t))) throw new Error('FOREIGN_TICKER_COVERAGE_MISSING');
        for (const [key, row] of fByKey) {
          const a = allByKey.get(key);
          if (!a || ['bval', 'sval', 'bvol', 'svol'].some((f) => row[f] > a[f])) throw new Error('FOREIGN_EXCEEDS_ALL');
        }
        const transform = require('./broker-accumulation-local').computeDomesticBroksum;
        const rows = [];
        for (const ticker of [...allTickers].sort()) {
          const result = transform({ all_data: true, brokers: all.rows.filter((r) => r.ticker === ticker) }, { brokers: foreign.rows.filter((r) => r.ticker === ticker) }, context.date, ticker);
          if (result.status !== 'RELEASED') throw new Error('DOMESTIC_TRANSFORM_REJECTED');
          rows.push(...result.brokers.map((r) => ({ ticker, ...r })));
        }
        return done(job, context, { rows, units: 'IDR_SHARES', market: 'REGULAR', flow: 'D', source: 'verified-ALL-minus-F' });
      }
      if (job === 'accumulation') {
        // Real rolling accumulation over verified same-date parents (ALL, F, D).
        // Deterministic: sorted ticker/date iteration, domain engine only, no
        // sorting heuristics that depend on object key order beyond explicit sort.
        const contract = require('./broker-unit-contract');
        const localEngine = require('./broker-accumulation-local');
        const all = parent(context, 'broksum-all');
        const foreign = parent(context, 'broksum-foreign');
        const domestic = parent(context, 'domestic-compile');
        if (all.units !== contract.UNIT_CONTRACT.units_label || foreign.units !== all.units || domestic.units !== all.units) {
          throw new Error('PARENT_UNITS_CONTRACT_MISMATCH');
        }
        const allByTicker = new Map();
        for (const row of all.rows) {
          const list = allByTicker.get(row.ticker) || [];
          list.push(row);
          allByTicker.set(row.ticker, list);
        }
        const fRowsByTickerDate = new Map();
        for (const row of foreign.rows) {
          fRowsByTickerDate.set(row.ticker + '|' + row.broker_code, row); // duplicate guard
        }
        const fByTicker = new Map();
        for (const row of foreign.rows) {
          const list = fByTicker.get(row.ticker) || [];
          if (!list.some((r) => r.broker_code === row.broker_code)) list.push(row);
          fByTicker.set(row.ticker, list);
        }
        const foreignUnconfirmed = [];
        const accumulationRows = [];
        for (const ticker of [...allByTicker.keys()].sort()) {
          const allRows = allByTicker.get(ticker);
          const fRows = fByTicker.get(ticker) || [];
          const decision = contract.foreignFlowDecision({ rows: fRows });
          if (!decision.proven) {
            // Fail-closed: this issuer-date has no proven Foreign flow, so no
            // Domestic-derivable accumulation windows are published for it.
            foreignUnconfirmed.push({ ticker, status: decision.status });
            continue;
          }
          const series = [{
            date: context.date,
            broksum: { stock_code: ticker, all_data: true, brokers: allRows },
            broksumForeign: { stock_code: ticker, brokers: fRows }
          }];
          const full = localEngine.computeFullRollingAccumulation(ticker, series, series.map((s) => ({ date: s.date, broksum: s.broksumForeign })));
          const latest = full && full.latest;
          if (!latest) throw new Error('ACCUMULATION_ENGINE_NO_SNAPSHOT:' + ticker);
          const win = (n) => {
            const w = latest.windows[n + 'H'] || {};
            return {
              all: w.all ? { net_val: w.all.net_val, bs_ratio_3: w.all.bs_ratio_3, arah: w.all.arah } : null,
              foreign: w.foreign ? { net_val: w.foreign.net_val } : null,
              domestic: w.domestic ? { net_val: w.domestic.net_val } : null
            };
          };
          accumulationRows.push({
            ticker,
            sessions: full.total_sessions,
            end_date: full.end_date,
            foreign_status: latest.foreign_status,
            bandar_vwap: latest.bandar_vwap,
            tekanan_broker: latest.tekanan_broker,
            top3_buyers: latest.top3_buyers,
            consistency: {
              all: latest.consistency && latest.consistency.all ? {
                net_buy_days_10h: latest.consistency.all.net_buy_days_10h,
                of_days: latest.consistency.all.of_days
              } : null
            },
            windows: { '1H': win(1), '5H': win(5), '20H': win(20) }
          });
        }
        // Canonical OHLCV context enrichment when a verified same-date cached
        // source exists; its absence is recorded, never fabricated.
        let ohlcvStatus = 'OHLCV_NOT_VERIFIED';
        let priceContextByTicker = null;
        try {
          const ohlcvSource = loadSource('yahoo-ohlcv', context.date, now);
          if (ohlcvSource) {
            ohlcvStatus = 'OHLCV_VERIFIED';
            priceContextByTicker = new Map();
            for (const row of ohlcvSource.raw.rows) priceContextByTicker.set(row.ticker, row);
          }
        } catch (_) { ohlcvStatus = 'OHLCV_SOURCE_INVALID'; }
        const rows = accumulationRows.map((r) => {
          const px = priceContextByTicker ? priceContextByTicker.get(r.ticker) : null;
          return { ...r, price_context: px ? { close: px.close, volume: px.volume, asof: px.date } : null };
        });
        return done(job, context, {
          rows,
          units: contract.UNIT_CONTRACT.units_label,
          unit_basis: {
            value_unit: contract.UNIT_CONTRACT.value_unit,
            volume_unit: contract.UNIT_CONTRACT.volume_unit,
            lot_fields_policy: contract.UNIT_CONTRACT.lot_fields_policy,
            contract_sha256: contract.contractSha256()
          },
          foreign_unconfirmed: foreignUnconfirmed,
          foreign_unconfirmed_count: foreignUnconfirmed.length,
          ohlcv_status: ohlcvStatus,
          computed_ticker_count: rows.length,
          source: 'verified-parents-ALL-F-D-plus-canonical-OHLCV'
        });
      }
      if (job === 'bandarmologi') {
        // Real deterministic bandarmologi summary from the verified accumulation
        // parent plus canonical OHLCV history. No ranking, no score invention.
        const contract = require('./broker-unit-contract');
        const accumulation = parent(context, 'accumulation');
        if (accumulation.units !== contract.UNIT_CONTRACT.units_label) throw new Error('PARENT_UNITS_CONTRACT_MISMATCH');
        let ohlcvStatus = 'OHLCV_NOT_VERIFIED';
        let priceByTicker = null;
        try {
          const ohlcvSource = loadSource('yahoo-ohlcv', context.date, now);
          if (ohlcvSource) {
            ohlcvStatus = 'OHLCV_VERIFIED';
            priceByTicker = new Map();
            for (const row of ohlcvSource.raw.rows) priceByTicker.set(row.ticker, row);
          }
        } catch (_) { ohlcvStatus = 'OHLCV_SOURCE_INVALID'; }
        const rows = [];
        for (const acc of accumulation.rows.slice().sort((a, b) => a.ticker.localeCompare(b.ticker))) {
          const oneH = acc.windows && acc.windows['1H'] && acc.windows['1H'].all;
          const bsRatio = oneH && Number.isFinite(oneH.bs_ratio_3) ? oneH.bs_ratio_3 : null;
          const verdict = (() => {
            if (bsRatio === null) return 'Tidak Diketahui';
            if (bsRatio >= 1.35) return 'Akumulasi Kuat';
            if (bsRatio >= 1.10) return 'Akumulasi';
            if (bsRatio >= 0.90) return 'Netral';
            if (bsRatio >= 0.70) return 'Distribusi';
            return 'Distribusi Kuat';
          })();
          const px = priceByTicker ? priceByTicker.get(acc.ticker) : null;
          const priceVsBandarVwapPct = px && px.close > 0 && acc.bandar_vwap > 0
            ? Number((((px.close - acc.bandar_vwap) / acc.bandar_vwap) * 100).toFixed(4))
            : null;
          rows.push({
            ticker: acc.ticker,
            verdict,
            bs_ratio_3_1h: bsRatio,
            net_val_1h_all: oneH ? oneH.net_val : null,
            net_val_5h_all: acc.windows && acc.windows['5H'] && acc.windows['5H'].all ? acc.windows['5H'].all.net_val : null,
            net_val_20h_all: acc.windows && acc.windows['20H'] && acc.windows['20H'].all ? acc.windows['20H'].all.net_val : null,
            consistency_all: acc.consistency && acc.consistency.all ? acc.consistency.all : null,
            bandar_vwap: acc.bandar_vwap,
            tekanan_broker: acc.tekanan_broker,
            top3_buyers: acc.top3_buyers,
            price_context: px ? { close: px.close, volume: px.volume, asof: px.date } : null,
            price_vs_bandar_vwap_pct: priceVsBandarVwapPct
          });
        }
        return done(job, context, {
          rows,
          units: contract.UNIT_CONTRACT.units_label,
          unit_basis: {
            value_unit: contract.UNIT_CONTRACT.value_unit,
            volume_unit: contract.UNIT_CONTRACT.volume_unit,
            lot_fields_policy: contract.UNIT_CONTRACT.lot_fields_policy,
            contract_sha256: contract.contractSha256()
          },
          ohlcv_status: ohlcvStatus,
          computed_ticker_count: rows.length,
          accumulation_output_sha256: accumulation.parents && context.parents.accumulation ? context.parents.accumulation.sha256 : null,
          source: 'verified-accumulation-parent-plus-canonical-OHLCV'
        });
      }
      if (job === 'market-context') {
        const source = loadSource('yahoo-ohlcv', context.date, now);
        if (!source) return { status: 'PENDING_PROVIDER', retryable: true, httpRequests: 0, billedUnits: 0 };
        let advancing = 0, declining = 0, unchanged = 0;
        for (const row of source.raw.rows) {
          if (!row.ticker || typeof row.close !== 'number' || typeof row.previousClose !== 'number' || row.close <= 0 || row.previousClose <= 0 || !Number.isFinite(row.close + row.previousClose)) throw new Error('OHLCV_INVALID');
          if (row.close > row.previousClose) advancing++; else if (row.close < row.previousClose) declining++; else unchanged++;
        }
        return done(job, context, { advancing, declining, unchanged, total: source.raw.rows.length, provenance: source.provenance });
      }
      if (job === 'top5') {
        const top20 = parent(context, 'top20');
        const snapshot = top20.canonicalSnapshot;
        validateRanking(snapshot, context.date);
        return done(job, context, { publicationStatus: 'FINAL', rows: snapshot.top20.slice(0, 5), rankingSnapshot: snapshot.snapshot_id, rankingContentHash: snapshot.content_hash, top20OutputHash: context.parents.top20.sha256 });
      }
      if (job === 'top20') {
        // Reuse the real engine's canonical published snapshot. Never invent a
        // stock ranking by sorting broker rows or trigger an independent scan.
        const source = loadSource('top20', context.date, now);
        if (!source) return { status: 'BLOCKED_RANKING_ENGINE_INPUT_UNAVAILABLE', retryable: true, httpRequests: 0, billedUnits: 0 };
        const snapshot = source.raw.canonicalSnapshot;
        validateRanking(snapshot, context.date);
        return done(job, context, { publicationStatus: 'FINAL', canonicalSnapshot: snapshot, provenance: source.provenance });
      }
      return { status: 'BLOCKED_UNPROVEN_ADAPTER', retryable: false, detail: 'Rolling accumulation, bandarmologi, lifecycle, sector and disclosure provider integrations need verified production inputs.', httpRequests: 0, billedUnits: 0 };
    } catch (err) {
      const detail = String(err.message || err).slice(0, 200);
      if (/^OHLCV_INVALID_/.test(detail)) return { status: 'INVALID_OUTPUT', retryable: false, detail, httpRequests: 0, billedUnits: 0 };
      return { status: 'BLOCKED_SOURCE_INVALID', retryable: true, detail, httpRequests: 0, billedUnits: 0 };
    }
  }
  return { run, outputDir, cachedDir, realm, loadSource };
}

module.exports = { createAdapters, atomicWrite, readJson, verifyOutput, publish, sha, inside };
