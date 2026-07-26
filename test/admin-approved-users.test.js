'use strict';

// ===========================================================================
// Mocked tests for the "Sudah Di-approve" (Approved Users) admin view.
//
// LOCAL / MOCKED ONLY:
//  - The approved-view helpers + device-details logic are extracted verbatim
//    from public/index.html and evaluated in a headless Node vm sandbox with a
//    minimal fake `document`. No browser, no network, no Supabase, no Telegram,
//    no secrets are touched.
//
// Covers: approved filter shows only approved users, pending excluded, correct
// count, budi appears safely, device count rendering, device modal open/close,
// masked device IDs, malformed/empty devices, escaping of user-controlled text,
// Telegram status, action targeting, Delete User absent, and API file count 12.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public', 'index.html');

// ---------------------------------------------------------------------------
// Extract the admin approved-view helpers + modal DOM functions from index.html
// and run them in a sandbox with a fake DOM + a settable cachedUsers global.
// ---------------------------------------------------------------------------
function makeFakeEl() {
  const classes = new Set();
  return {
    innerHTML: '',
    textContent: '',
    classList: {
      add: function (c) { classes.add(c); },
      remove: function (c) { classes.delete(c); },
      contains: function (c) { return classes.has(c); }
    }
  };
}

function loadAdminApprovedUi(initialUsers) {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const start = html.indexOf('function userIsPending(u)');
  const end = html.indexOf('// ===== DEVICE-MODAL-DOM-END =====');
  assert.ok(start >= 0 && end > start, 'admin approved-view helpers must exist in index.html');
  const src = html.slice(start, end);

  const els = {
    deviceDetailsModal: makeFakeEl(),
    deviceDetailsBody: makeFakeEl(),
    deviceDetailsTitle: makeFakeEl()
  };
  els.deviceDetailsModal.classList.add('hidden');

  const sandbox = {
    cachedUsers: initialUsers || [],
    document: { getElementById: function (id) { return els[id] || null; } },
    console: console
  };
  vm.createContext(sandbox);
  const exportsExpr = '\nthis.__api = {' +
    ' userIsPending: userIsPending, userIsVerified: userIsVerified, userIsApproved: userIsApproved,' +
    ' adminUserMatchesFilter: adminUserMatchesFilter, telegramStatusLabel: telegramStatusLabel,' +
    ' escapeAdminHtml: escapeAdminHtml, adminOnclickArg: adminOnclickArg, maskDeviceId: maskDeviceId,' +
    ' deviceDetailsModel: deviceDetailsModel, renderDeviceDetailsHtml: renderDeviceDetailsHtml,' +
    ' renderApprovedUsersTable: renderApprovedUsersTable,' +
    ' openDeviceModal: openDeviceModal, closeDeviceModal: closeDeviceModal };';
  vm.runInContext(src + exportsExpr, sandbox);
  return { api: sandbox.__api, els: els, sandbox: sandbox };
}

const nowIso = new Date().toISOString();

// A representative population: pending (verified + unverified), blocked, and
// several approved (including budi and a joined-channel user).
function samplePopulation() {
  return [
    { username: 'readyA', is_approved: false, is_blocked: false, telegram_verified_at: nowIso, devices: ['d1'] },
    { username: 'unverifiedA', is_approved: false, is_blocked: false, telegram_verified_at: null, devices: [] },
    { username: 'blockedA', is_approved: false, is_blocked: true, telegram_verified_at: nowIso, devices: ['d2'] },
    { username: 'budi', is_approved: true, is_blocked: false, telegram_verified_at: nowIso, channel_joined_at: nowIso, devices: ['bud_device_1234567890abcd'] },
    { username: 'approvedJoined', is_approved: true, is_blocked: false, telegram_verified_at: nowIso, channel_joined_at: nowIso, devices: ['srv_12ab34567890cd89cd', 'srv_second_device_999'], device_id: 'srv_12ab34567890cd89cd', created_at: nowIso, last_login_at: nowIso },
    { username: 'approvedNotJoined', is_approved: true, is_blocked: false, telegram_verified_at: nowIso, channel_joined_at: null, devices: [] }
  ];
}

// ===========================================================================
// Filter behavior + counts
// ===========================================================================
test('approved filter shows ONLY approved users (pending never appear)', function () {
  const { api } = loadAdminApprovedUi();
  const users = samplePopulation();
  const approved = users.filter(function (u) { return api.adminUserMatchesFilter(u, 'approved'); }).map(function (u) { return u.username; });
  assert.deepEqual(approved.sort(), ['approvedJoined', 'approvedNotJoined', 'budi']);
  // No pending accounts leaked in.
  assert.ok(approved.indexOf('readyA') === -1);
  assert.ok(approved.indexOf('unverifiedA') === -1);
});

test('pending filters never include approved users', function () {
  const { api } = loadAdminApprovedUi();
  const users = samplePopulation();
  ['ready', 'unverified', 'pending'].forEach(function (f) {
    users.filter(function (u) { return api.adminUserMatchesFilter(u, f); }).forEach(function (u) {
      assert.equal(u.is_approved, false, 'filter ' + f + ' must not include approved user ' + u.username);
    });
  });
});

test('approved count is correct and data-derived', function () {
  const { api } = loadAdminApprovedUi();
  const users = samplePopulation();
  const count = users.filter(function (u) { return api.adminUserMatchesFilter(u, 'approved'); }).length;
  assert.equal(count, 3);
});

test('budi appears safely in the approved view', function () {
  const { api } = loadAdminApprovedUi();
  const budi = samplePopulation().filter(function (u) { return u.username === 'budi'; })[0];
  assert.equal(api.adminUserMatchesFilter(budi, 'approved'), true);
  const rowHtml = api.renderApprovedUsersTable([budi]);
  assert.ok(rowHtml.indexOf('budi') !== -1, 'budi is listed');
  // budi row still exposes only safe actions.
  assert.ok(rowHtml.indexOf('Delete') === -1);
});

test('ADMIN_USER_FILTERS declares Sudah Di-approve as its own tab (not mixed with pending)', function () {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  assert.ok(/key:\s*'approved'\s*,\s*label:\s*'Sudah Di-approve'/.test(html), 'approved filter tab must exist');
  // Ordered before blocked and after Semua Pending.
  const idxPending = html.indexOf("label: 'Semua Pending'");
  const idxApproved = html.indexOf("label: 'Sudah Di-approve'");
  const idxBlocked = html.indexOf("label: 'Blocked'");
  assert.ok(idxPending < idxApproved && idxApproved < idxBlocked, 'approved tab ordered between pending and blocked');
});

// ===========================================================================
// Approved table rendering: columns, device count, telegram, actions
// ===========================================================================
test('device count is rendered correctly (n/max)', function () {
  const { api } = loadAdminApprovedUi();
  const user = { username: 'approvedJoined', is_approved: true, devices: ['a', 'b'], created_at: nowIso, last_login_at: nowIso };
  const html = api.renderApprovedUsersTable([user]);
  assert.ok(html.indexOf('2/3') !== -1, 'shows 2/3 devices');
  assert.ok(html.indexOf('Lihat Devices') !== -1, 'has Lihat Devices button');
});

test('approved table renders required columns and last login', function () {
  const { api } = loadAdminApprovedUi();
  const html = api.renderApprovedUsersTable([]);
  ['Username', 'Devices', 'Telegram', 'Created', 'Last Login', 'Status', 'Actions'].forEach(function (h) {
    assert.ok(html.indexOf('>' + h + '<') !== -1, 'column ' + h + ' present');
  });
});

test('Telegram status renders correctly for approved users', function () {
  const { api } = loadAdminApprovedUi();
  const joined = api.telegramStatusLabel({ channel_joined_at: nowIso, telegram_verified_at: nowIso });
  const verifiedNotJoined = api.telegramStatusLabel({ channel_joined_at: null, telegram_verified_at: nowIso });
  const unverified = api.telegramStatusLabel({ channel_joined_at: null, telegram_verified_at: null });
  assert.ok(joined.indexOf('Sudah Join Channel') !== -1);
  assert.ok(verifiedNotJoined.indexOf('Terverifikasi') !== -1);
  assert.ok(unverified.indexOf('Belum Verifikasi') !== -1);
  // An approved user with channel_joined_at null is shown as not joined.
  assert.ok(verifiedNotJoined.indexOf('Sudah Join Channel') === -1);
});

test('existing actions still target the correct username', function () {
  const { api } = loadAdminApprovedUi();
  const html = api.renderApprovedUsersTable([{ username: 'approveduser', is_approved: true, is_blocked: false, devices: [] }]);
  assert.ok(html.indexOf("adminUserAction('block','approveduser')") !== -1, 'block targets user');
  assert.ok(html.indexOf("adminUserAction('reset_devices','approveduser')") !== -1, 'reset_devices targets user');
  assert.ok(html.indexOf("openResetPasswordModal('approveduser')") !== -1, 'reset password targets user');
  assert.ok(html.indexOf("openDeviceModal('approveduser')") !== -1, 'device modal targets user');
});

test('approved view exposes only safe actions (no Delete, no approve/reject)', function () {
  const { api } = loadAdminApprovedUi();
  const html = api.renderApprovedUsersTable([{ username: 'someuser', is_approved: true, is_blocked: false, devices: [] }]);
  assert.ok(html.indexOf('Delete') === -1, 'no Delete User');
  assert.ok(html.indexOf("adminUserAction('reject'") === -1, 'no reject control');
  assert.ok(html.indexOf("adminUserAction('approve'") === -1, 'no approve control');
  assert.ok(html.indexOf('Block') !== -1);
  assert.ok(html.indexOf('Reset Devices') !== -1);
  assert.ok(html.indexOf('Reset PW') !== -1);
});

test('blocked-but-approved user shows Unblock (not Block) and Blocked status', function () {
  const { api } = loadAdminApprovedUi();
  const html = api.renderApprovedUsersTable([{ username: 'blockedapproved', is_approved: true, is_blocked: true, devices: [] }]);
  assert.ok(html.indexOf("adminUserAction('unblock','blockedapproved')") !== -1);
  assert.ok(html.indexOf("adminUserAction('block','blockedapproved')") === -1);
  assert.ok(html.indexOf('Blocked') !== -1);
});

// ===========================================================================
// Device ID masking + safety
// ===========================================================================
test('device IDs are masked (raw ID never rendered)', function () {
  const { api } = loadAdminApprovedUi();
  const raw = 'srv_12ab34567890cd89cd';
  const masked = api.maskDeviceId(raw);
  assert.ok(masked.indexOf('\u2022') !== -1, 'contains bullet mask');
  assert.notEqual(masked, raw, 'not the raw id');
  assert.ok(raw.indexOf(masked.split('\u2022')[0]) === 0, 'keeps a short head prefix');
  const user = { username: 'u', is_approved: true, devices: [raw], device_id: raw };
  const modalHtml = api.renderDeviceDetailsHtml(user);
  assert.ok(modalHtml.indexOf(raw) === -1, 'full raw device id is never present in modal HTML');
  assert.ok(modalHtml.indexOf('\u2022') !== -1, 'modal shows masked ids');
});

test('current/legacy device is marked when determinable', function () {
  const { api } = loadAdminApprovedUi();
  const user = { username: 'u', is_approved: true, devices: ['dev_current_1234567890', 'dev_other_9876543210'], device_id: 'dev_current_1234567890' };
  const model = api.deviceDetailsModel(user);
  assert.equal(model.total, 2);
  assert.equal(model.max, 3);
  assert.equal(model.items[0].isCurrent, true);
  assert.equal(model.items[1].isCurrent, false);
  const html = api.renderDeviceDetailsHtml(user);
  assert.ok(html.indexOf('Perangkat saat ini') !== -1, 'current device badge shown');
});

test('empty and malformed device arrays are handled safely', function () {
  const { api } = loadAdminApprovedUi();
  // Empty
  const emptyModel = api.deviceDetailsModel({ username: 'e', devices: [] });
  assert.equal(emptyModel.total, 0);
  const emptyHtml = api.renderDeviceDetailsHtml({ username: 'e', devices: [] });
  assert.ok(emptyHtml.indexOf('Tidak ada perangkat') !== -1);
  // Non-array devices
  const badModel = api.deviceDetailsModel({ username: 'b', devices: 'not-an-array' });
  assert.equal(badModel.total, 0);
  // Array with malformed entries (null, number, object, empty string)
  const malformed = { username: 'm', devices: [null, 42, {}, '', 'good_device_1234567890'] };
  const mModel = api.deviceDetailsModel(malformed);
  assert.equal(mModel.total, 5);
  assert.equal(mModel.items[0].maskedId, '(kosong)');
  assert.equal(mModel.items[1].maskedId, '(tidak valid)');
  assert.equal(mModel.items[2].maskedId, '(tidak valid)');
  assert.equal(mModel.items[3].maskedId, '(kosong)');
  // Should not throw and should render.
  const mHtml = api.renderDeviceDetailsHtml(malformed);
  assert.ok(mHtml.indexOf('Format tidak valid') !== -1);
});

test('user-controlled device text is escaped (no HTML injection)', function () {
  const { api } = loadAdminApprovedUi();
  const evil = '<img src=x onerror=alert(1)>abcdefghijklmnop';
  const user = { username: 'victim', is_approved: true, devices: [evil], device_id: evil };
  const html = api.renderDeviceDetailsHtml(user);
  assert.ok(html.indexOf('<img') === -1, 'raw <img> must not appear');
  assert.ok(html.indexOf('&lt;img') !== -1, 'device text is HTML-escaped');
});

test('user-controlled username is escaped in the approved table', function () {
  const { api } = loadAdminApprovedUi();
  const html = api.renderApprovedUsersTable([{ username: '<script>x</script>', is_approved: true, is_blocked: false, devices: [] }]);
  assert.ok(html.indexOf('<script>x</script>') === -1, 'raw script tag must not appear');
  assert.ok(html.indexOf('&lt;script&gt;') !== -1, 'username HTML-escaped');
});

// ===========================================================================
// Device modal open / close (DOM)
// ===========================================================================
test('device modal opens (unhidden + populated) and closes (hidden)', function () {
  const users = [{ username: 'modaluser', is_approved: true, devices: ['dev_abcdef1234567890', 'dev_zzz_998877'], device_id: 'dev_abcdef1234567890' }];
  const { api, els } = loadAdminApprovedUi(users);

  assert.equal(els.deviceDetailsModal.classList.contains('hidden'), true, 'starts hidden');
  api.openDeviceModal('modaluser');
  assert.equal(els.deviceDetailsModal.classList.contains('hidden'), false, 'opened');
  assert.ok(els.deviceDetailsBody.innerHTML.indexOf('\u2022') !== -1, 'body shows masked devices');
  assert.ok(els.deviceDetailsTitle.textContent.indexOf('modaluser') !== -1, 'title set via textContent');
  // Raw device id never leaks into modal body.
  assert.ok(els.deviceDetailsBody.innerHTML.indexOf('dev_abcdef1234567890') === -1);

  api.closeDeviceModal();
  assert.equal(els.deviceDetailsModal.classList.contains('hidden'), true, 'closed');
});

test('device modal for an unknown user renders a safe not-found message', function () {
  const { api, els } = loadAdminApprovedUi([]);
  api.openDeviceModal('ghost');
  assert.equal(els.deviceDetailsModal.classList.contains('hidden'), false);
  assert.ok(els.deviceDetailsBody.innerHTML.indexOf('tidak ditemukan') !== -1);
});

// ===========================================================================
// Regression guards
// ===========================================================================
test('API JavaScript file count remains exactly 12', function () {
  const files = fs.readdirSync(path.join(ROOT, 'api')).filter(function (f) { return f.endsWith('.js'); });
  assert.equal(files.length, 12, 'API JS file count must remain 12; got ' + files.length);
});

test('Delete User is guarded (admin API) and absent from the approved table', function () {
  const adminApi = fs.readFileSync(path.join(ROOT, 'api', 'admin-users.js'), 'utf8');
  assert.ok(/action === 'delete_user'/.test(adminApi), 'delete_user action exists');
  assert.ok(/requireAdminSession\(req\)/.test(adminApi), 'delete requires a signed admin session');
  assert.ok(/targetUsername === 'budi' \|\| targetUsername === 'review'/.test(adminApi), 'budi/review protected');
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(function (f) { return f.endsWith('.js'); });
  assert.ok(!apiFiles.some(function (f) { return /delete/i.test(f); }), 'no separate delete-user API file');
  // The approved view itself must not offer a delete control; deletion lives in
  // the dedicated admin enhancement with exact-username confirmation.
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const start = html.indexOf('function renderApprovedUsersTable');
  const end = html.indexOf('// ===== APPROVED-USERS-HELPERS-END =====');
  const approvedSrc = html.slice(start, end);
  assert.equal(/delete/i.test(approvedSrc), false, 'approved table renders no delete control');
});
