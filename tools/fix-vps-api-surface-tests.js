'use strict';

/**
 * Migrate the historical Vercel "api/*.js exactly 13 functions" assertions to the
 * shared VPS routing contract (test/lib/vps-api-surface.js). Route-regression
 * protection is preserved: the 13 historical endpoints must remain present and
 * every vercel.json /api/* alias must resolve. Idempotent.
 *
 * Run: node tools/fix-vps-api-surface-tests.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HELPER_REQUIRE = "const vpsSurface = require('./lib/vps-api-surface');";

const FILES = [
  'admin-approved-users', 'admin-command-login', 'admin-session-auth',
  'ai-eval-openagentic-quality', 'auth-modal-and-ai-analysis-ui',
  'auto-swing-telegram-digest', 'budi-admin-compatibility',
  'budi-login-routing', 'canonical-domain-redirect', 'canonical-plan-rollout',
  'chart-export-and-responsive', 'dashboard-top5-monitor-loading',
  'daytrade-experimental-admin-alert', 'free-user-approval',
  'intraday-eligibility-parity-lifecycle', 'intraday-sample-collector-date',
  'intraday-sample-collector', 'intraday-sample-eligibility-partition',
  'intraday-shadow-scoring-live', 'intraday-shadow-scoring',
  'intraday-shadow-trade-backtest', 'manual-subscription-review-flow',
  'pattern-map', 'portfolio-and-security', 'production-loader-hotfix',
  'rich-telegram-format', 'run-intraday-experimental-pipeline',
  'security-phase1', 'subscription-auth', 'subscription-phase4',
  'subscription-phase5a', 'subscription-phase5b', 'subscription-phase5c',
  'subscription-phase6a-access', 'subscription-phase6a-ui',
  'swing-konglo-fibonacci-confluence', 'telegram-candidate-digest-gate',
  'telegram-invite-button-cleanup', 'telegram-member-lifecycle',
  'telegram-monitor-dedup', 'telegram-monitor-dry-run',
  'telegram-monitor-hourly-batch', 'telegram-verification-v2',
  'top10-command-selection', 'track-record-backtest',
  'trade-plan-v2-daytrade-diagnostic', 'trade-plan-v2-integration',
  'trade-plan-v2-source-adapters', 'trade-plan-v2-sweep-diagnostic',
  'ui-redesign-a11y', 'website-production-audit'
];

// Balanced extraction of an `assert.equal(...)` call starting at index i.
function extractCall(text, start) {
  let depth = 0;
  let q = null;
  for (let j = start; j < text.length; j += 1) {
    const c = text[j];
    if (q) { if (c === q && text[j - 1] !== '\\') q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return { body: text.slice(start, j + 1), end: j + 1 }; }
  }
  return null;
}

function isApiCountBody(body) {
  if (/\b131072\b/.test(body)) return false;
  if (/\b13084\b|\b13000\b|\b13091\b/.test(body)) return false;
  return /\.length\s*,?\s*13\b/.test(body);
}

function step1MigrateAssertions(name) {
  const p = path.join(ROOT, 'test', name + '.test.js');
  if (!fs.existsSync(p)) return { name, status: 'MISSING', replaced: 0 };
  let src = fs.readFileSync(p, 'utf8');
  // If already converted, skip before touching.
  const already = src.includes("require('./lib/vps-api-surface')") && !/\.length,\s*13\b/.test(src);
  if (already) return { name, status: 'already', replaced: 0 };

  let text = src;
  let replaced = 0;
  let i = 0;
  while ((i = text.indexOf('assert.equal(', i)) !== -1) {
    const call = extractCall(text, i);
    if (!call) { i += 13; continue; }
    if (isApiCountBody(call.body)) {
      const indent = (text.slice(0, i).split('\n').pop().match(/^[ \t]*/) || [''])[0];
      text = text.slice(0, i) + 'vpsSurface.assertVpsApiSurface(assert)' + text.slice(call.end);
      replaced += 1;
    } else {
      i = call.end;
    }
  }

  return { name, status: 'migrated-assertions', replaced, text };
}

function step2EnsureRequire(rec) {
  if (rec.status !== 'migrated-assertions') return rec;
  let text = rec.text;
  if (text.includes("require('./lib/vps-api-surface')")) return Object.assign(rec, { status: 'done' });

  // Insert the helper require right after the 'use strict'; directive when
  // present (keeps the strict-mode prologue intact), else prepend.
  const lines = text.split(/\r?\n/);
  const strictIdx = lines.findIndex((l) => /^['"]use strict['"];?\s*$/.test(l.trim()));
  if (strictIdx >= 0) {
    lines.splice(strictIdx + 1, 0, HELPER_REQUIRE);
    text = lines.join('\n');
  } else {
    text = HELPER_REQUIRE + '\n' + text;
  }
  rec.text = text;
  rec.status = 'done';
  return rec;
}

const report = [];
for (const f of FILES) {
  let rec = step1MigrateAssertions(f);
  rec = step2EnsureRequire(rec);
  if (rec.status === 'done') {
    fs.writeFileSync(path.join(ROOT, 'test', f + '.test.js'), rec.text, 'utf8');
  }
  report.push(rec);
}

for (const r of report) {
  if (r.status !== 'already' && r.status !== 'MISSING') {
    console.log(r.status.padEnd(20) + ' ' + r.name + ' (' + (r.replaced || 0) + ')');
  } else if (r.status === 'MISSING') {
    console.log('MISSING             ' + r.name);
  }
}
console.log('---');
console.log('done=' + report.filter((r) => r.status === 'done').length +
  ' already=' + report.filter((r) => r.status === 'already').length +
  ' no-match=' + report.filter((r) => r.status === 'migrated-assertions').length +
  ' missing=' + report.filter((r) => r.status === 'MISSING').length);