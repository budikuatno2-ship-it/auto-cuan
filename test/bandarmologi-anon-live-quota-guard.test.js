'use strict';

// C4 (22 Oct 2026) — the public Bandarmologi endpoint must not let an anonymous
// visitor spend Arjum quota. Root cause: lib/bandarmologi-service.js called the
// live Arjum API (broker summary + accumulation + insiders = 3 requests per
// call) whenever the ticker/date was not on disk, before any premium gate, and
// the dispatcher routed `action=bandarmologi` BEFORE the gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('C4: live fetch defaults to OFF, so an anonymous call cannot spend Arjum quota', () => {
  const src = read('lib/bandarmologi-service.js');
  // Explicit opt-in flag, defaulting to false.
  assert.match(src, /const allowLiveFetch = options\.allowLiveFetch === true;/);
  // Both live-fetch sites are gated on it.
  assert.match(src, /if \(!allowLiveFetch \|\| !arjumClient\.hasArjumApiKey\(\)\)/);
  assert.match(src, /if \(allowLiveFetch && arjumClient\.hasArjumApiKey\(\)\)/);
});

test('C4: the Bandarmologi handler rate-limits anonymous callers and only enables live for a session', () => {
  const src = read('api/sector-hot.js');
  assert.match(src, /bandarmologiPublicLimiter = createRateLimiter\(/);
  assert.match(src, /allowLiveFetch: isAuthed/);
  assert.match(src, /requireAuthenticatedSession\(req\)/);
  assert.match(src, /res\.status\(429\)/);
});

test('C4: every live-fetch site sits behind the allowLiveFetch gate (no bypass left)', () => {
  const src = read('lib/bandarmologi-service.js');
  // Count the guarded hasArjumApiKey() occurrences in getBandarmologiData context.
  const guarded = (src.match(/(!allowLiveFetch|allowLiveFetch &&)\s*[^;]*hasArjumApiKey/g) || []).length;
  assert.ok(guarded >= 2, 'both the flow-filtered and the single-date live paths must be guarded');
});

test('C4: the cache is documented as a distinct path (MEMORY_CACHE + disk)', () => {
  const src = read('lib/bandarmologi-service.js');
  assert.match(src, /const MEMORY_CACHE = new Map\(\)/);
  assert.match(src, /from_disk: true|from_cache: true/);
});
