const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('new registration UI requires Gmail while keeping username as profile identity', () => {
  const html = read('public/index.html');
  assert.match(html, /id="regEmail"[^>]*required/);
  assert.match(html, />Gmail<\/label>/);
  assert.match(html, /nama@gmail\.com/);
  assert.match(html, /id="regUsername"/);
  assert.doesNotMatch(html, /Email \(Opsional\)/);
});

test('login UI accepts email or username, with helper text confirming both work', () => {
  const html = read('public/index.html');
  // Wave 8B: label changed from "Gmail" to "Email atau username" (more accurate)
  assert.match(html, /for="loginUsername"[^>]*>Email atau username<\/label>/);
  // Helper text now confirms both Gmail and username work
  assert.match(html, /Masukkan Gmail atau username/);
  // Placeholder is generic (not Gmail-specific) since username is also valid
  assert.doesNotMatch(html, /for="loginUsername"[^>]*>Gmail<\/label>/);
});

test('registration handler requires normalized gmail.com identity and rejects duplicates', () => {
  const source = read('api/register-user.js');
  assert.match(source, /GMAIL_REQUIRED/);
  assert.match(source, /rawEmail\.endsWith\('@gmail\.com'\)/);
  assert.match(source, /\.eq\("email", cleanEmail\)/);
  assert.match(source, /Email sudah digunakan/);
});

test('login handler keeps case-insensitive email lookup plus legacy username fallback', () => {
  const source = read('api/login-user.js');
  assert.match(source, /isEmailInput/);
  assert.match(source, /userLookup\.eq\("email", usernameLower\)/);
  assert.match(source, /userLookup\.eq\("username", usernameLower\)/);
  assert.match(source, /effectiveUsername/);
});

test('staged migration preserves legacy NULL email and adds case-insensitive uniqueness', () => {
  const sql = read('supabase/gmail-auth-staged-migration.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS email text/);
  assert.match(sql, /LOWER\(TRIM\(email\)\)/);
  assert.match(sql, /WHERE email IS NOT NULL AND TRIM\(email\) <> ''/);
  assert.doesNotMatch(sql, /email\s+SET\s+NOT\s+NULL|email\s+text\s+NOT\s+NULL/i);
});

test('Telegram verification binds challenge to true user id, not free-form username', () => {
  const source = read('lib/telegram-verification.js');
  assert.match(source, /consume_challenge_and_bind_telegram/);
  assert.match(source, /userId: row \? row\.user_id : null/);
  assert.match(source, /p_user_id: userId/);
});

test('Gmail-backed accounts require Gmail while legacy rows retain username compatibility', () => {
  const source = read('api/login-user.js');
  assert.match(source, /gmailBacked = storedEmail\.endsWith\('@gmail\.com'\)/);
  assert.match(source, /legacyUsernameAllowed = !gmailBacked \|\| effectiveUsername === 'budi' \|\| effectiveUsername === 'review'/);
  assert.match(source, /gmail_identity_required/);
});

test('Gmail registration rejects pattern-wildcard and invalid local parts', () => {
  const source = read('api/register-user.js');
  assert.match(source, /\^\[a-z0-9\]\+\(\?:\\\.\[a-z0-9\]\+\)\*\$/);
  assert.match(source, /\.eq\("email", cleanEmail\)/);
  assert.doesNotMatch(source, /\.ilike\("email", cleanEmail\)/);
});
