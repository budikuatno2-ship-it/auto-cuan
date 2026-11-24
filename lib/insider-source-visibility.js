'use strict';

// Strict timestamp handling: never infer publication from event, filing or ingestion dates.
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}
function timestamp(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m || !validDay(m[1]) || +m[2] > 23 || +m[3] > 59 || +m[4] > 59) return null;
  if (m[5] !== 'Z' && (+m[5].slice(1,3) > 14 || +m[5].slice(4) > 59 || (+m[5].slice(1,3) === 14 && +m[5].slice(4) !== 0))) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
function cutoffTime(value) {
  if (validDay(value)) return Date.parse(value + 'T23:59:59.999+07:00');
  return timestamp(value);
}
function publicationEvidence(record) {
  const values = [record.source_published_at, record.published_at].filter(v => v != null && v !== '');
  if (!values.length) return {status:'UNKNOWN', reason:'PUBLICATION_TIMESTAMP_MISSING', source_published_at:null};
  const times = values.map(timestamp);
  if (times.some(t => t === null)) return {status:'UNKNOWN', reason:'PUBLICATION_TIMESTAMP_INVALID', source_published_at:values[0]};
  if (new Set(times).size !== 1) return {status:'UNKNOWN', reason:'PUBLICATION_TIMESTAMP_CONFLICT', source_published_at:values[0]};
  return {status:'KNOWN_TIMESTAMP', reason:'EXPLICIT_SOURCE_PUBLICATION', source_published_at:values[0], ms:times[0]};
}
function selectVisibleInsiders(records, options = {}) {
  const strict = options.asOf != null;
  const cutoff = strict ? cutoffTime(options.asOf) : Date.now();
  const visible = [], unknown = [], excluded = [];
  for (const record of records || []) {
    const pub = publicationEvidence(record);
    const status = strict && cutoff === null ? 'UNKNOWN' : pub.status === 'UNKNOWN' ? 'UNKNOWN'
      : pub.ms > cutoff ? 'AFTER_CUTOFF' : 'VISIBLE';
    const row = {...record, source_published_at:pub.source_published_at, publication_status:status,
      publication_reason:strict && cutoff === null ? 'INVALID_ASOF_CUTOFF' : pub.reason};
    if (status === 'UNKNOWN') unknown.push(row);
    if (status === 'AFTER_CUTOFF') excluded.push(row);
    if (status === 'VISIBLE' || (!strict && status === 'UNKNOWN')) visible.push(row);
  }
  return {records:visible, unknown, excluded, as_of:options.asOf || null,
    status:unknown.length || (strict && cutoff === null) ? 'UNKNOWN' : visible.length ? 'VISIBLE_EVENTS'
      : options.dueStatus === 'NOT_DUE' ? 'NOT_DUE' : excluded.length ? 'NO_VISIBLE_EVENTS' : 'UNKNOWN'};
}
module.exports = {validDay, timestamp, cutoffTime, publicationEvidence, selectVisibleInsiders};
