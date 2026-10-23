#!/usr/bin/env node
'use strict';

// C2 (22 Oct 2026) — read the CSP Report-Only violations recorded at the origin.
//
// The policy starts in Report-Only mode; this tool is how the operator inspects
// what WOULD be blocked before enforcement. It reads data/csp-violations.jsonl
// (bounded, non-secret) and prints a summary. No side effects.

const path = require('path');
const securityHeaders = require(path.resolve(__dirname, '..', 'lib', 'security-headers'));

function main(argv) {
  const args = argv || [];
  const json = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;
  const rows = securityHeaders.readCspViolations(process.env, limit);
  const summary = securityHeaders.summarizeCspViolations(process.env);
  if (json) {
    process.stdout.write(JSON.stringify({ summary, rows }, null, 2) + '\n');
    return summary;
  }
  process.stdout.write(`[CSP-REPORT] file=${securityHeaders.violationsPath()}\n`);
  process.stdout.write(`[CSP-REPORT] count=${summary.count} first=${summary.first || '-'} last=${summary.last || '-'}\n`);
  for (const [directive, n] of Object.entries(summary.byDirective)) {
    process.stdout.write(`  directive ${directive} -> ${n}\n`);
  }
  for (const [uri, n] of Object.entries(summary.byUri)) {
    process.stdout.write(`  blocked_uri ${uri} -> ${n}\n`);
  }
  return summary;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exitCode = 1; }
}

module.exports = { main };
