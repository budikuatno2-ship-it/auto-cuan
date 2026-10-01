/* Shared, dependency-free financial worksheet contract. No eval or DOM access. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AutoCuanMoneySheetModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var Formula = typeof module === 'object' && module.exports ? require('./money-sheet-formulas') : globalThis.AutoCuanMoneySheetFormulas;
  var MAX_ROWS = 300;
  var MAX_AMOUNT = 1000000000000;
  var TYPES = ['income', 'expense', 'saving', 'transfer'];
  var TYPE_LABELS = { income: 'Pemasukan', expense: 'Pengeluaran', saving: 'Tabungan', transfer: 'Transfer trading' };
  var FIELDS = ['type', 'category', 'label', 'amount', 'note'];
  var LEGACY = [
    ['income_salary', 'income', 'Utama', 'Gaji'],
    ['income_side', 'income', 'Tambahan', 'Penghasilan sampingan'],
    ['income_other', 'income', 'Lainnya', 'Pemasukan lainnya'],
    ['expense_necessities', 'expense', 'Kebutuhan', 'Kebutuhan hidup'],
    ['expense_wants', 'expense', 'Gaya hidup', 'Pengeluaran pilihan'],
    ['savings_emergency', 'saving', 'Cadangan', 'Tabungan / dana darurat'],
    ['trading_capital_allocation', 'transfer', 'Investasi', 'Transfer ke portofolio bulan ini']
  ];
  function validMonth(value) { return typeof value === 'string' && /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value); }
  function currentMonth(now) { return new Date((now == null ? Date.now() : now) + 7 * 3600000).toISOString().slice(0, 7); }
  function amount(value) {
    if (typeof value === 'number') {
      if (Number.isSafeInteger(value) && value >= 0 && value <= MAX_AMOUNT) return value;
      throw new Error('Nominal harus rupiah bulat, 0 sampai 1 triliun per baris.');
    }
    if (typeof value !== 'string') throw new Error('Nominal tidak valid.');
    var raw = value.trim().replace(/^Rp\s*/i, '').trim();
    if (!raw) return 0;
    // Indonesian thousands separators, optionally a zero decimal fraction.
    if (/^\d{1,3}(\.\d{3})+(,00)?$/.test(raw)) raw = raw.replace(/\./g, '').replace(/,00$/, '');
    else if (/^\d+(,00)?$/.test(raw)) raw = raw.replace(/,00$/, '');
    else throw new Error('Gunakan rupiah bulat, misalnya 1500000 atau Rp 1.500.000.');
    return amount(Number(raw));
  }
  function text(value, max, field) {
    if (typeof value !== 'string' || value.length > max) throw new Error(field + ' terlalu panjang atau tidak valid.');
    return value;
  }
  function normalize(input) {
    if (!input || (input.version !== 1 && input.version !== 2) || !Array.isArray(input.rows) || input.rows.length > MAX_ROWS) {
      throw new Error('Lembar kerja tidak valid (maksimal ' + MAX_ROWS + ' baris).');
    }
    var seen = new Set();
    var rows = input.rows.map(function (row) {
      if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) || seen.has(row.id)) throw new Error('Identitas baris tidak valid atau duplikat.');
      seen.add(row.id);
      if (TYPES.indexOf(row.type) < 0) throw new Error('Jenis arus kas tidak valid.');
      var out = { id: row.id, type: row.type, category: text(row.category, 80, 'Kategori'), label: text(row.label, 160, 'Nama pos'), amount: row.formula ? 0 : amount(row.amount), note: text(row.note, 500, 'Catatan') };
      if (row.formula) { out.formula = text(row.formula, 240, 'Rumus').trim(); if (!out.formula.startsWith('=')) throw new Error('Rumus harus diawali =.'); }
      return out;
    });
    if (rows.some(function (row) { return row.formula; })) {
      if (!Formula) throw new Error('Mesin rumus belum tersedia. Muat ulang sebelum mengedit.');
      Formula.calculate(rows, MAX_AMOUNT);
    }
    // Formula-bearing sheets advertise v2 so an older v1 client refuses them
    // instead of silently dropping formulas on its next save.
    return { version:input.version === 2 || rows.some(function(row) { return row.formula; }) ? 2 : 1, rows:rows };
  }
  function fromLegacy(data) {
    data = data || {};
    return normalize({ version: 1, rows: LEGACY.map(function (item) {
      var raw = data[item[0]] == null ? 0 : Number(data[item[0]]);
      // Never silently round or discard a legacy value that cannot be represented.
      return { id: 'legacy-' + item[0], type: item[1], category: item[2], label: item[3], amount: amount(raw), note: '' };
    }) });
  }
  function totals(sheet) {
    var out = { income: 0, expense: 0, saving: 0, transfer: 0, remaining: 0 };
    sheet.rows.forEach(function (row) { out[row.type] += row.amount; });
    out.remaining = out.income - out.expense - out.saving - out.transfer;
    return out;
  }
  function toLegacy(sheet) {
    var result = {};
    LEGACY.forEach(function (r) { result[r[0]] = 0; });
    sheet.rows.forEach(function (row) {
      var key = row.type === 'income' ? 'income_other' : row.type === 'expense' ? 'expense_necessities' : row.type === 'saving' ? 'savings_emergency' : 'trading_capital_allocation';
      var original = LEGACY.find(function (r) { return row.id === 'legacy-' + r[0] && row.type === r[1]; });
      if (original) key = original[0];
      result[key] += row.amount;
    });
    return result;
  }
  function parseType(value) {
    var raw = String(value).trim().toLowerCase();
    return TYPES.find(function (key) { return key === raw || TYPE_LABELS[key].toLowerCase() === raw; });
  }
  function newRow(id) { return { id: id, type: 'expense', category: '', label: '', amount: 0, note: '' }; }
  function parseTSV(value) {
    if (typeof value !== 'string' || value.length > 200000) throw new Error('Data tempel terlalu besar.');
    var rows = [], cells = [], cell = '', quoted = false, closed = false;
    for (var i=0; i<value.length; i++) {
      var c = value[i];
      if (quoted) {
        if (c === '"' && value[i+1] === '"') { cell += '"'; i++; }
        else if (c === '"') { quoted=false; closed=true; }
        else cell += c;
      } else if (c === '"' && !cell && !closed) quoted=true;
      else if (c === '\t' || c === '\n' || c === '\r') {
        cells.push(cell); cell=''; closed=false;
        if (c !== '\t') { rows.push(cells); cells=[]; if(c==='\r'&&value[i+1]==='\n')i++; }
      } else { if (closed) throw new Error('Teks setelah tanda kutip tidak valid.'); cell+=c; }
    }
    if (quoted) throw new Error('Tanda kutip pada data tempel belum ditutup.');
    if (cell || cells.length || !rows.length || closed) { cells.push(cell); rows.push(cells); }
    return rows;
  }
  function setRaw(row, field, value) {
    if (field === 'amount') {
      if (typeof value === 'string' && value.trim().startsWith('=')) { row.formula=value.trim(); row.amount=0; }
      else { delete row.formula; row.amount=amount(value); }
    } else row[field] = field === 'type' ? parseType(value) : value;
  }
  function paste(sheet, startRow, startColumn, value, makeId) {
    if (!Number.isInteger(startRow) || startRow < 0 || startRow > sheet.rows.length || !Number.isInteger(startColumn) || startColumn < 0 || startColumn >= FIELDS.length) throw new Error('Posisi tempel tidak valid.');
    var lines = parseTSV(value);
    if (startRow + lines.length > MAX_ROWS) throw new Error('Batas ' + MAX_ROWS + ' baris terlampaui.');
    var copy = JSON.parse(JSON.stringify(sheet));
    lines.forEach(function (cells, i) {
      if (startColumn + cells.length > FIELDS.length) throw new Error('Data melewati kolom Catatan. Tidak ada sel yang diubah.');
      var index = startRow + i;
      if (!copy.rows[index]) copy.rows[index] = newRow(makeId());
      cells.forEach(function (cell,c) { setRaw(copy.rows[index], FIELDS[startColumn+c], cell); });
    });
    return normalize(copy);
  }
  function insertRows(sheet, index, rows) {
    if (!Number.isInteger(index) || index<0 || index>sheet.rows.length) throw new Error('Posisi baris tidak valid.');
    var copy=JSON.parse(JSON.stringify(sheet));
    copy.rows.forEach(function(row) { if(row.formula) row.formula=Formula.shift(row.formula,index,rows.length); });
    copy.rows.splice.apply(copy.rows,[index,0].concat(rows)); return normalize(copy);
  }
  function removeRows(sheet, ids) {
    var removed=new Set(); sheet.rows.forEach(function(row,i) { if(ids.includes(row.id)) removed.add(i); });
    var copy=JSON.parse(JSON.stringify(sheet));
    copy.rows=copy.rows.filter(function(_,i) { return !removed.has(i); });
    copy.rows.forEach(function(row) { if(row.formula) row.formula=Formula.shift(row.formula,0,0,removed); });
    return normalize(copy);
  }
  function csvCell(value) {
    var s = String(value == null ? '' : value);
    // Export plain text, never a spreadsheet formula controlled by a label/note.
    if (/^[\s\uFEFF]*[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function csv(sheet) {
    var rows = [['Jenis', 'Kategori', 'Nama pos', 'Nominal (Rp)', 'Catatan']];
    sheet.rows.forEach(function (row) { rows.push([TYPE_LABELS[row.type], row.category, row.label, row.amount, row.note]); });
    return '\uFEFF' + rows.map(function (row) { return row.map(csvCell).join(','); }).join('\r\n');
  }
  return { MAX_ROWS: MAX_ROWS, MAX_AMOUNT: MAX_AMOUNT, TYPES: TYPES, TYPE_LABELS: TYPE_LABELS, FIELDS: FIELDS, validMonth: validMonth, currentMonth: currentMonth, amount: amount, normalize: normalize, fromLegacy: fromLegacy, totals: totals, toLegacy: toLegacy, newRow: newRow, paste: paste, parseTSV: parseTSV, setRaw: setRaw, insertRows: insertRows, removeRows: removeRows, csv: csv };
});
