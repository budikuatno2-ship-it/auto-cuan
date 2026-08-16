'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function trackedFiles() {
  return cp.execFileSync('git', ['ls-files', '-z'], { cwd: ROOT })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

function fail(message) {
  console.error('SECURITY_AUDIT_FAIL: ' + message);
  process.exitCode = 1;
}

const files = trackedFiles();
const forbiddenPathPatterns = [
  /(^|\/)\.env(?:$|\.)/,
  /(^|\/)(?:id_rsa|id_ed25519|id_ecdsa)(?:$|\.)/i,
  /\.(?:pem|p12|pfx|jks|keystore)$/i,
  /(^|\/)service-account(?:\.json)?$/i
];

for (const file of files) {
  if (file === '.env.example' || file.endsWith('/.env.example')) continue;
  if (forbiddenPathPatterns.some((pattern) => pattern.test(file))) {
    fail('forbidden credential-like file is tracked: ' + file);
  }
}

const secretPatterns = [
  ['private-key-marker', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['github-classic-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['github-fine-grained-token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ['openai-style-secret', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['telegram-bot-token', /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g],
  ['supabase-personal-access-token', /\bsbp_[A-Za-z0-9_-]{20,}\b/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g]
];

const textExtensions = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.yml', '.yaml', '.md',
  '.html', '.css', '.sql', '.sh', '.py', '.txt', '.toml', '.ini', '.conf'
]);
const textBasenames = new Set(['Dockerfile', 'Procfile', 'vercel.json', 'package.json', 'package-lock.json']);

for (const file of files) {
  const abs = path.join(ROOT, file);
  let stat;
  try { stat = fs.statSync(abs); } catch (_) { continue; }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
  const ext = path.extname(file).toLowerCase();
  if (!textExtensions.has(ext) && !textBasenames.has(path.basename(file))) continue;
  const text = fs.readFileSync(abs, 'utf8');
  for (const [name, pattern] of secretPatterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) fail(name + ' pattern detected in ' + file + ':' + lineNumber(text, match.index));
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log('Repository security audit passed: no tracked credential files or high-confidence secret patterns found.');
