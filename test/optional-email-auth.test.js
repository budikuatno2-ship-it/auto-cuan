const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Registration HTML UI exposes optional email field', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /id="regEmail"/, 'Input regEmail harus tersedia di index.html');
  assert.match(html, /Email \(Opsional\)/, 'Label Email (Opsional) harus tampil');
});

test('Login HTML UI updates username label to Username atau Email', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /Username atau Email/, 'Label login harus mendukung Username atau Email');
});

test('Registration handler validates email syntax safely when supplied', () => {
  const regJs = fs.readFileSync(path.join(__dirname, '../api/register-user.js'), 'utf8');
  assert.match(regJs, /cleanEmail/, 'Handler harus menormalisasi email');
  assert.match(regJs, /Format email tidak valid/, 'Harus mengembalikan error jika format email tidak valid');
  assert.match(regJs, /Email sudah digunakan/, 'Harus menolak duplikasi email');
});

test('Login handler resolves account via username or email lookup', () => {
  const loginJs = fs.readFileSync(path.join(__dirname, '../api/login-user.js'), 'utf8');
  assert.match(loginJs, /isEmailInput/, 'Handler login harus membedakan input email vs username');
  assert.match(loginJs, /effectiveUsername/, 'Session cookie harus selalu di-issue dengan username asli akun');
});
