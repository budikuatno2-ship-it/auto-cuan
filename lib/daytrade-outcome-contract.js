'use strict';

const crypto = require('node:crypto');
const { canonicalJson, normalizeEvaluationRecord } = require('./screener-evaluation-contract');

const SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 64 * 1024;
const ENTRY_STATES = new Set(['UNFILLED', 'FILLED', 'UNRESOLVED']);
const OUTCOMES = new Set(['TP1_FIRST', 'SL_FIRST', 'EXPIRED', 'UNRESOLVED']);
const TOUCH_CONVENTIONS = new Set(['POINT_IN_TIME', 'PESSIMISTIC_SL_FIRST', 'NOT_APPLICABLE']);
const KEYS = ['schema_version','strategy','evidence_type','initial_link','evaluator','horizon','levels','entry','touches','excursions','performance','policy','completion','rejection_codes','record_hash'];
const LINK_KEYS = ['run_id','ticker','market_date','scheduled_slot','observed_at','code_sha','config_hash','record_digest'];
const POLICY_KEYS = ['policy_version','currency','tick','fees','taxes','spread','slippage'];
const COMPONENT_KEYS = ['version','rate','fixed','provenance'];
const FORBIDDEN_VALUE = /(?:\bBearer\s+|https?:\/\/|\beyJ[A-Za-z0-9_-]{8,}\.|bot\d{6,}:|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;

function plain(v) { return !!v && Object.getPrototypeOf(v) === Object.prototype; }
function exact(v, keys, name) { if (!plain(v) || Object.keys(v).sort().join() !== keys.slice().sort().join()) throw new TypeError(name + ' must contain exact keys'); }
function str(v, name, max = 128, nullable = false) { if (nullable && v === null) return; if (typeof v !== 'string' || !v || v.length > max || FORBIDDEN_VALUE.test(v)) throw new TypeError(name + ' must be a bounded secret-safe string'); }
function num(v, name, nullable = false) { if (nullable && v === null) return; if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(name + ' must be finite'); }
function ts(v, name, nullable = false) { if (nullable && v === null) return; str(v,name,40); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) || !Number.isFinite(Date.parse(v))) throw new TypeError(name + ' must be UTC'); }
function hash(v,name) { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) throw new TypeError(name + ' must be SHA-256'); }
function component(v,name) { exact(v,COMPONENT_KEYS,name); str(v.version,name+'.version',64); num(v.rate,name+'.rate'); num(v.fixed,name+'.fixed'); str(v.provenance,name+'.provenance',256); if(v.rate<0||v.fixed<0) throw new TypeError(name+' cannot be negative'); }

function initialRecordDigest(record) { return crypto.createHash('sha256').update(Buffer.from(canonicalJson(normalizeEvaluationRecord(record)))).digest('hex'); }
function outcomeIdentity(link, evaluatorVersion, policyVersion) { return crypto.createHash('sha256').update(Buffer.from(canonicalJson({ initial_record_digest: link.record_digest, evaluator_version: evaluatorVersion, policy_version: policyVersion }))).digest('hex'); }

function normalizePolicy(policy) {
  exact(policy,POLICY_KEYS,'policy'); str(policy.policy_version,'policy.policy_version',64); str(policy.currency,'policy.currency',16);
  exact(policy.tick,['version','size','entry_snap','stop_snap','target_snap','provenance'],'policy.tick'); str(policy.tick.version,'policy.tick.version',64); num(policy.tick.size,'policy.tick.size'); if(policy.tick.size<=0) throw new TypeError('tick size must be positive');
  for (const key of ['entry_snap','stop_snap','target_snap']) if (!['CEIL','FLOOR','NEAREST'].includes(policy.tick[key])) throw new TypeError('invalid tick snap');
  str(policy.tick.provenance,'policy.tick.provenance',256); component(policy.fees,'policy.fees'); component(policy.taxes,'policy.taxes'); component(policy.spread,'policy.spread'); component(policy.slippage,'policy.slippage'); return policy;
}

function normalizeOutcomeRecord(record) {
  exact(record,KEYS,'outcome record'); if(record.schema_version!==1||record.strategy!=='DAY_TRADE'||record.evidence_type!=='OUTCOME_COMPANION') throw new TypeError('unsupported outcome record');
  exact(record.initial_link,LINK_KEYS,'initial_link'); str(record.initial_link.run_id,'initial_link.run_id'); str(record.initial_link.ticker,'initial_link.ticker',20); if(!/^\d{4}-\d{2}-\d{2}$/.test(record.initial_link.market_date)) throw new TypeError('invalid market date'); str(record.initial_link.scheduled_slot,'initial_link.scheduled_slot',64,true); ts(record.initial_link.observed_at,'initial_link.observed_at'); if(!/^[a-f0-9]{40}$/.test(record.initial_link.code_sha)) throw new TypeError('invalid code SHA'); hash(record.initial_link.config_hash,'initial config hash'); hash(record.initial_link.record_digest,'initial digest');
  exact(record.evaluator,['version','identity'],'evaluator'); str(record.evaluator.version,'evaluator.version',64); hash(record.evaluator.identity,'evaluator.identity'); if(record.evaluator.identity!==outcomeIdentity(record.initial_link,record.evaluator.version,record.policy.policy_version)) throw new TypeError('evaluator identity mismatch');
  exact(record.horizon,['start_at','end_at','evidence_as_of'],'horizon'); ts(record.horizon.start_at,'horizon.start_at');ts(record.horizon.end_at,'horizon.end_at');ts(record.horizon.evidence_as_of,'horizon.evidence_as_of'); if(Date.parse(record.horizon.start_at)!==Date.parse(record.initial_link.observed_at)||Date.parse(record.horizon.end_at)<Date.parse(record.horizon.start_at)||Date.parse(record.horizon.evidence_as_of)<Date.parse(record.horizon.start_at)) throw new TypeError('invalid horizon ordering');
  exact(record.levels,['entry_raw','entry_snapped','stop_raw','stop_snapped','tp1_raw','tp1_snapped'],'levels'); for(const k of Object.keys(record.levels)) num(record.levels[k],'levels.'+k); if(!(record.levels.stop_snapped<record.levels.entry_snapped&&record.levels.entry_snapped<record.levels.tp1_snapped)) throw new TypeError('snapped levels must be ordered');
  exact(record.entry,['state','fill_at','fill_price','provenance','source_as_of'],'entry'); if(!ENTRY_STATES.has(record.entry.state)) throw new TypeError('invalid entry state'); ts(record.entry.fill_at,'entry.fill_at',true);num(record.entry.fill_price,'entry.fill_price',true);str(record.entry.provenance,'entry.provenance',256);ts(record.entry.source_as_of,'entry.source_as_of'); const filled=record.entry.state==='FILLED'; if(filled!==(record.entry.fill_at!==null&&record.entry.fill_price!==null)) throw new TypeError('fill fields contradict entry state');
  exact(record.touches,['outcome','tp1_at','tp1_price','sl_at','sl_price','ordering_convention','provenance'],'touches');if(!OUTCOMES.has(record.touches.outcome)||!TOUCH_CONVENTIONS.has(record.touches.ordering_convention)) throw new TypeError('invalid touch outcome'); for(const k of ['tp1_at','sl_at'])ts(record.touches[k],'touches.'+k,true);for(const k of ['tp1_price','sl_price'])num(record.touches[k],'touches.'+k,true);str(record.touches.provenance,'touches.provenance',256); if(!filled&&['TP1_FIRST','SL_FIRST'].includes(record.touches.outcome)) throw new TypeError('unfilled entry cannot be a loss or win');
  exact(record.excursions,['mfe','mfe_at','mae','mae_at','provenance'],'excursions');for(const k of ['mfe','mae'])num(record.excursions[k],'excursions.'+k,true);for(const k of ['mfe_at','mae_at'])ts(record.excursions[k],'excursions.'+k,true);str(record.excursions.provenance,'excursions.provenance',256);if(!filled&&[record.excursions.mfe,record.excursions.mae,record.excursions.mfe_at,record.excursions.mae_at].some(v=>v!==null))throw new TypeError('unfilled entry has excursions');
  exact(record.performance,['gross_return','gross_r','costs','net_return','net_r'],'performance');num(record.performance.gross_return,'gross_return',true);num(record.performance.gross_r,'gross_r',true);num(record.performance.net_return,'net_return',true);num(record.performance.net_r,'net_r',true);exact(record.performance.costs,['fees','taxes','spread','slippage','total'],'costs');for(const k of Object.keys(record.performance.costs))num(record.performance.costs[k],'costs.'+k,true);if(!filled&&[record.performance.gross_return,record.performance.gross_r,record.performance.net_return,record.performance.net_r,...Object.values(record.performance.costs)].some(v=>v!==null))throw new TypeError('unfilled entry has return');
  normalizePolicy(record.policy);exact(record.completion,['completed_at','final_evidence_as_of'],'completion');ts(record.completion.completed_at,'completed_at');ts(record.completion.final_evidence_as_of,'final_evidence_as_of');if(record.completion.final_evidence_as_of!==record.horizon.evidence_as_of)throw new TypeError('evidence boundary mismatch');
  if(!Array.isArray(record.rejection_codes)||record.rejection_codes.length>16||new Set(record.rejection_codes).size!==record.rejection_codes.length||record.rejection_codes.some(x=>typeof x!=='string'||! /^(?:[A-Z][A-Z0-9_]{0,63})$/.test(x)))throw new TypeError('invalid rejection codes');
  hash(record.record_hash,'record_hash'); const without={...record};delete without.record_hash;const expected=crypto.createHash('sha256').update(Buffer.from(canonicalJson(without))).digest('hex');if(record.record_hash!==expected)throw new TypeError('record hash mismatch');if(Buffer.byteLength(canonicalJson(record))>MAX_RECORD_BYTES)throw new RangeError('outcome record exceeds byte limit');return JSON.parse(canonicalJson(record));
}
function finalizeRecord(record) { const base={...record};delete base.record_hash;base.record_hash=crypto.createHash('sha256').update(Buffer.from(canonicalJson(base))).digest('hex');return normalizeOutcomeRecord(base); }
module.exports={SCHEMA_VERSION,MAX_RECORD_BYTES,ENTRY_STATES,OUTCOMES,normalizePolicy,initialRecordDigest,outcomeIdentity,normalizeOutcomeRecord,finalizeRecord};
