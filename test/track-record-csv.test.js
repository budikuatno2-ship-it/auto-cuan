'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  TRACK_RECORD_CSV_HEADERS,
  escapeCsvCell,
  formatTrackRecordCsvRow,
  generateTrackRecordCsv,
  getTrackRecordCsvFilename
} = require('../public/track-record-runtime');

const ROOT = path.resolve(__dirname, '..');
function source(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

test('Track Record CSV headers match exact required schema', () => {
  const expected = [
    'Tanggal',
    'Ticker',
    'Kategori',
    'Status',
    'Entry',
    'TP1',
    'TP2',
    'Stop Loss',
    'Max Gain %',
    'Status Hit',
    'Durasi (Hari)'
  ];

  assert.deepEqual(TRACK_RECORD_CSV_HEADERS, expected);
});

test('escapeCsvCell correctly handles special characters, commas, and quotes', () => {
  assert.equal(escapeCsvCell(null), '');
  assert.equal(escapeCsvCell(undefined), '');
  assert.equal(escapeCsvCell('BBRI'), 'BBRI');
  assert.equal(escapeCsvCell('Day Trade, Scalping'), '"Day Trade, Scalping"');
  assert.equal(escapeCsvCell('Quote "Test"'), '"Quote ""Test"""');
  assert.equal(escapeCsvCell('Multi\nLine'), '"Multi\nLine"');
  assert.equal(escapeCsvCell(1234), '1234');
});

test('getTrackRecordCsvFilename produces autocuan-track-record-YYYY-MM-DD.csv', () => {
  const sampleDate = new Date(2026, 7, 28);
  const filename = getTrackRecordCsvFilename(sampleDate);
  assert.equal(filename, 'autocuan-track-record-2026-08-28.csv');
  assert.match(getTrackRecordCsvFilename(), /^autocuan-track-record-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('formatTrackRecordCsvRow correctly formats complete signal data', () => {
  const signal = {
    date: '2026-08-28',
    ticker: 'BBRI',
    source_label: 'Swing Konglo',
    status_label: 'TP1 Hit',
    entry1: 4500,
    entry2: 4550,
    tp1: 4750,
    tp2: 5000,
    sl: 4350,
    gain_pct: 5.6,
    outcome: 'TP1_HIT',
    duration_text: '2 hari'
  };

  const row = formatTrackRecordCsvRow(signal);
  assert.deepEqual(row, [
    '2026-08-28',
    'BBRI',
    'Swing Konglo',
    'TP1 Hit',
    '4500-4550',
    '4750',
    '5000',
    '4350',
    '+5.6%',
    'TP1_HIT',
    '2 hari'
  ]);
});

test('formatTrackRecordCsvRow handles single entry and negative loss properly', () => {
  const signal = {
    date: '2026-08-27',
    ticker: 'ASII',
    category: 'Day Trade',
    source_short: 'Day Trade',
    status_label: 'SL Hit',
    entry1: 5200,
    entry2: 5200,
    tp1: 5400,
    tp2: 5600,
    sl: 5000,
    gain_pct: -3.8,
    outcome: 'SL_HIT',
    duration_text: '45 m'
  };

  const row = formatTrackRecordCsvRow(signal);
  assert.deepEqual(row, [
    '2026-08-27',
    'ASII',
    'Day Trade',
    'SL Hit',
    '5200',
    '5400',
    '5600',
    '5000',
    '-3.8%',
    'SL_HIT',
    '45 m'
  ]);
});

test('formatTrackRecordCsvRow gracefully falls back on missing/null fields', () => {
  const signal = {
    ticker: 'BREN'
  };

  const row = formatTrackRecordCsvRow(signal);
  assert.deepEqual(row, [
    '—',
    'BREN',
    '—',
    '—',
    '—',
    '—',
    '—',
    '—',
    '—',
    '—',
    '—'
  ]);
});

test('generateTrackRecordCsv generates full CSV string with valid header and rows', () => {
  const signals = [
    {
      date: '2026-08-28',
      ticker: 'BBRI',
      source_label: 'Swing Konglo',
      status_label: 'TP1 Hit',
      entry1: 4500,
      entry2: 4550,
      tp1: 4750,
      tp2: 5000,
      sl: 4350,
      gain_pct: 5.6,
      outcome: 'TP1_HIT',
      duration_text: '2 hari'
    },
    {
      date: '2026-08-28',
      ticker: 'TLKM',
      source_label: 'Day Trade',
      status_label: 'Running',
      entry1: 3100,
      entry2: null,
      tp1: 3250,
      tp2: 3350,
      sl: 3000,
      gain_pct: null,
      outcome: 'RUNNING',
      duration_text: '—'
    }
  ];

  const csv = generateTrackRecordCsv(signals);
  const lines = csv.split('\r\n');

  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'Tanggal,Ticker,Kategori,Status,Entry,TP1,TP2,Stop Loss,Max Gain %,Status Hit,Durasi (Hari)');
  assert.equal(lines[1], '2026-08-28,BBRI,Swing Konglo,TP1 Hit,4500-4550,4750,5000,4350,+5.6%,TP1_HIT,2 hari');
  assert.equal(lines[2], '2026-08-28,TLKM,Day Trade,Running,3100,3250,3350,3000,—,RUNNING,—');
});

test('UI templates contain Track Record CSV button and Watchlist quick filters & modal', () => {
  const indexHtml = source('public/index.html');
  const trRuntime = source('public/track-record-runtime.js');
  const wlRuntime = source('public/watchlist-runtime.js');

  // Track Record CSV button in index.html and runtime
  assert.match(indexHtml, /id="trackRecordExportBtn"/);
  assert.match(indexHtml, /onclick="exportTrackRecordCsv\(\)"/);
  assert.match(indexHtml, /Unduh CSV/);
  assert.match(trRuntime, /function exportTrackRecordCsv\(\)/);

  // Watchlist Quick Filters in index.html and runtime
  assert.match(indexHtml, /id="watchlistFilterTabs"/);
  assert.match(indexHtml, /data-wl-filter="all"/);
  assert.match(indexHtml, /data-wl-filter="alert"/);
  assert.match(indexHtml, /data-wl-filter="gain"/);
  assert.match(indexHtml, /data-wl-filter="loss"/);
  assert.match(wlRuntime, /function filterWatchlist\(/);

  // Watchlist Quick Notes Editor in index.html and runtime
  assert.match(indexHtml, /id="wlNotesModal"/);
  assert.match(indexHtml, /id="wlNotesText"/);
  assert.match(indexHtml, /id="wlNotesSaveBtn"/);
  assert.match(wlRuntime, /function openEditNotesModal\(/);
  assert.match(wlRuntime, /function saveWatchlistNotes\(/);
});
