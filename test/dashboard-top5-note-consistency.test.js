'use strict';

// ===========================================================================
// The Top 5 panel's heading must never contradict the body beneath it.
//
// The bug
// -------
// renderDashboardTop5MonitorData() assigned the heading BEFORE it computed
// `isAwaiting`, the flag that decides whether the panel renders rows or an
// awaiting-lock empty state. The heading's fallback branch was:
//
//   data.update_note || 'Top 5 Radar tersedia.'      ("Top 5 Radar is available")
//
// so any payload that was not a locked final — which includes the ordinary
// pre-lock state during the trading day — produced a dashboard reading:
//
//   Top 5 Radar
//   Top 5 Radar tersedia.                            <- heading
//   [!] Belum ada Top 5 final yang terkunci.         <- body, directly below
//
// The product claimed data it was simultaneously reporting as absent. Confirmed
// visually in Chromium before the fix, and gone after it.
//
// The heading is now derived from the same isAwaiting flag as the body, via this
// pure helper, so the two cannot drift apart again.
//
// LOCAL / STATIC ONLY. The helper is extracted from public/index.html and run.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFunction(signature) {
  const start = html.indexOf(signature);
  assert.ok(start > 0, signature + ' must exist in public/index.html');
  let depth = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error('could not delimit ' + signature);
}

// eslint-disable-next-line no-new-func
const noteText = new Function(
  extractFunction('function dashboardTop5NoteText(') + '; return dashboardTop5NoteText;'
)();

const AVAILABLE = /tersedia/i;
const GATE = 'lolos gate: 3/5';

// ---------------------------------------------------------------------------
// Awaiting states must never claim availability
// ---------------------------------------------------------------------------

const AWAITING_PAYLOADS = [
  ['no rows at all', {}],
  ['explicitly awaiting locked rows', { top5_source: 'awaiting_locked_rows' }],
  ['unlocked source', { top5_locked: false, top5_source: 'preview' }],
  ['a stale update_note left on the payload', { update_note: 'Top 5 Radar tersedia.' }],
  ['locked flag without locked rows', { top5_locked: true, top5_source: 'preview' }]
];

for (const [label, payload] of AWAITING_PAYLOADS) {
  test('awaiting (' + label + ') does not claim the radar is available', () => {
    const text = noteText(payload, true, GATE);
    assert.doesNotMatch(
      text,
      AVAILABLE,
      'the heading must not say "tersedia" while the body renders the awaiting state'
    );
    assert.match(text, /Menunggu Top 5 final dikunci/, 'it should say the lock is pending');
  });
}

test('a stale update_note cannot leak into an awaiting heading', () => {
  // The old code reached `data.update_note || ...` even while awaiting, so a
  // server-sent note could assert availability over an empty panel.
  const text = noteText({ update_note: 'Data lengkap sudah siap.' }, true, GATE);
  assert.doesNotMatch(text, /Data lengkap sudah siap/);
});

test('the admin provisional case keeps its own wording while awaiting', () => {
  const text = noteText({ web_provisional: true }, true, GATE);
  assert.match(text, /Preview\/Provisional khusus admin/);
  assert.doesNotMatch(text, /Menunggu Top 5 final dikunci/);
});

// ---------------------------------------------------------------------------
// Non-awaiting states keep their existing wording
// ---------------------------------------------------------------------------

test('a locked final still reports the gate count and refresh cadence', () => {
  const text = noteText({ top5_locked: true, top5_source: 'locked_rows' }, false, GATE);
  assert.match(text, /Final\/Locked/);
  assert.match(text, /lolos gate: 3\/5/);
  assert.match(text, /Monitor update tiap 30 menit/);
});

test('a server-supplied update_note is still honoured when not awaiting', () => {
  const text = noteText({ update_note: 'Top 5 diperbarui 10:15 WIB.' }, false, GATE);
  assert.equal(text, 'Top 5 diperbarui 10:15 WIB.');
});

test('the plain available wording remains for a non-awaiting payload', () => {
  assert.match(noteText({}, false, GATE), AVAILABLE);
});

test('a malformed payload does not throw', () => {
  for (const bad of [null, undefined, 'x', 42]) {
    assert.equal(typeof noteText(bad, true, GATE), 'string');
    assert.equal(typeof noteText(bad, false, GATE), 'string');
  }
});

// ---------------------------------------------------------------------------
// Source guards
// ---------------------------------------------------------------------------

test('the heading is assigned only after isAwaiting is known', () => {
  const fn = extractFunction('function renderDashboardTop5MonitorData(');
  const awaitingAt = fn.indexOf('var isAwaiting');
  const noteAt = fn.indexOf('note.textContent');
  assert.ok(awaitingAt > 0, 'isAwaiting must be computed');
  assert.ok(noteAt > 0, 'the note must be assigned');
  assert.ok(
    awaitingAt < noteAt,
    'assigning the heading before isAwaiting exists is what let it contradict the body'
  );
});

test('only the pure helper may claim the radar is available', () => {
  // The fetch path used to assign its own heading before calling the renderer,
  // flashing a contradictory line for a frame. The other two writers are fine
  // and must stay: the error path clears the heading to '', and the guest gate
  // sets "Login diperlukan…" alongside a login CTA body — heading and body agree
  // in both. What must never reappear is a second site asserting availability.
  const claims = (html.match(/'Top 5 Radar tersedia\.'/g) || []).length;
  assert.equal(claims, 1, 'the availability wording belongs to dashboardTop5NoteText alone');

  const helper = extractFunction('function dashboardTop5NoteText(');
  assert.match(helper, /'Top 5 Radar tersedia\.'/, 'and that one occurrence must be inside it');
});

test('the panel default in the markup does not over-claim before data arrives', () => {
  // The server-rendered default sits on screen until the first fetch resolves.
  const el = html.match(/<p id="dashboardTop5LockNote"[^>]*>([^<]*)</);
  assert.ok(el, 'the heading element must exist');
  assert.doesNotMatch(
    el[1],
    AVAILABLE,
    'the pre-fetch default must not claim data the panel does not have yet'
  );
});

test('the renderer routes the heading through the pure helper', () => {
  const fn = extractFunction('function renderDashboardTop5MonitorData(');
  assert.match(fn, /dashboardTop5NoteText\(data, isAwaiting, gateLabel\)/);
});
