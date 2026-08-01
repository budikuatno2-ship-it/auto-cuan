#!/usr/bin/env node
'use strict';

// Inactive manual VPS harness. Nothing happens without --execute and a caller root.
const crypto = require('node:crypto');
const { normalizeEvaluationRecord } = require('../lib/screener-evaluation-contract');
const { createLocalEvaluationLogger } = require('../lib/screener-evaluation-logger');
const { MAX_ENVELOPE_RECORDS, MAX_ENVELOPE_BYTES } = require('../lib/daytrade-evaluation-adapter');

function validateEnvelope(value) {
  if (!value || value.schema_version !== 1 || value.strategy !== 'DAY_TRADE' || !Array.isArray(value.records)) throw new TypeError('malformed evaluation envelope');
  if (value.records.length > MAX_ENVELOPE_RECORDS || Buffer.byteLength(JSON.stringify(value)) > MAX_ENVELOPE_BYTES + 4096) throw new RangeError('evaluation envelope exceeds cap');
  const records = value.records.map(normalizeEvaluationRecord);
  if (records.some(record => record.run_id !== value.run_id || record.batch_index !== value.batch_index)) throw new TypeError('envelope identity mismatch');
  return records;
}

function consumeEnvelope(envelope, options) {
  const records = validateEnvelope(envelope); // validate all before creating a file
  if (!options || !options.enabled) return null;
  const logger = createLocalEvaluationLogger({ root: options.root, env: { EVALUATION_LOGGING_ENABLED: 'true' }, runId: envelope.run_id, marketDate: options.marketDate, diskAudit: options.diskAudit });
  try { records.forEach(record => logger.append(record)); return logger.finalize(); }
  catch (error) { try { logger.abort('CONSUMER_FAILED'); } catch (_) {} throw error; }
}

function parseArgs(argv) {
  const out = { execute: false, batch: 0 };
  for (let i=2;i<argv.length;i++) { const a=argv[i]; if (a === '--execute') out.execute=true; else if (['--url','--secret','--root','--market-date','--scheduled-slot'].includes(a)) out[a.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=argv[++i]; else if (a === '--batch') out.batch=Number(argv[++i]); else throw new Error('unknown option: '+a); }
  return out;
}
async function main(args=parseArgs(process.argv), fetchImpl=fetch) {
  if (!args.execute) throw new Error('inactive: pass --execute explicitly');
  if (!args.url || !args.secret || !args.root || !/^\d{4}-\d{2}-\d{2}$/.test(args.marketDate || '')) throw new Error('--url, --secret, --root and --market-date are required');
  const url=new URL('/api/sector-hot',args.url); Object.entries({action:'daytrade-screener-run',batch:args.batch,evaluation_capture:1,defer_to_fast_watcher:1,scheduled_slot:args.scheduledSlot||'manual-one-shot',scheduler_source:'vps-one-shot'}).forEach(([k,v])=>url.searchParams.set(k,String(v)));
  const response=await fetchImpl(url,{headers:{Authorization:'Bearer '+args.secret,Accept:'application/json'}}); const payload=await response.json();
  if (!response.ok || !payload.evaluation) throw new Error('evaluation envelope absent: '+String(payload.evaluation_diagnostic && payload.evaluation_diagnostic.reason || payload.status || response.status));
  const manifest=consumeEnvelope(payload.evaluation,{enabled:true,root:args.root,marketDate:args.marketDate});
  process.stdout.write(JSON.stringify({record_count:manifest.record_count,compressed_bytes:manifest.byte_size,manifest_checksum:manifest.sha256,omitted_field_provenance:payload.evaluation.omitted_field_provenance})+'\n');
  return manifest;
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={validateEnvelope,consumeEnvelope,parseArgs,main};
