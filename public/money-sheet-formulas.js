/* Small, deterministic rupiah formula grammar. No JavaScript evaluation.
   Amount references use physical D-row addresses, independent of sorting/filtering. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AutoCuanMoneySheetFormulas = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var FUNCTIONS = new Set(['SUM','AVERAGE','MIN','MAX','COUNT','ROUND']);
  function error(message) { throw new Error(message); }
  function tokens(source) {
    if (typeof source !== 'string' || source.length > 240 || source[0] !== '=') error('Rumus harus diawali = dan maksimal 240 karakter.');
    var result = [], text = source.slice(1).toUpperCase().trim();
    while (text) {
      var match = /^(?:D[1-9]\d*|[A-Z]+|(?:\d+(?:\.\d+)?|\.\d+)|[+*/(),;:\-])/.exec(text);
      if (!match) error('Rumus tidak valid. Gunakan angka, D1, + - * /, atau fungsi yang didukung.');
      result.push(match[0]); text = text.slice(match[0].length).trimStart();
      if (result.length > 128) error('Rumus terlalu panjang.');
    }
    return result;
  }
  function evaluate(source, read) {
    var list = tokens(source), pos = 0, depth = 0;
    function finite(value) { if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) error('Hasil rumus melewati batas angka aman.'); return value; }
    function scalar(value) { if (Array.isArray(value)) error('Rentang sel hanya boleh dipakai di dalam fungsi.'); return value; }
    function atom() {
      if (++depth > 32) error('Rumus terlalu bertingkat.');
      var token = list[pos++], value;
      if (token === '+' || token === '-') value = scalar(atom()) * (token === '-' ? -1 : 1);
      else if (token === '(') { value = expression(); if (list[pos++] !== ')') error('Kurung rumus belum lengkap.'); }
      else if (/^D[1-9]\d*$/.test(token || '')) {
        var first = Number(token.slice(1));
        if (list[pos] === ':') {
          pos++; var end = list[pos++];
          if (!/^D[1-9]\d*$/.test(end || '')) error('Rentang harus seperti D1:D4.');
          var last = Number(end.slice(1));
          if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > 300 || last > 300) error('Rentang rumus di luar batas 300 baris.');
          value = [];
          for (var i = Math.min(first,last); i <= Math.max(first,last); i++) value.push(read(i - 1));
        } else value = read(first - 1);
      } else if (FUNCTIONS.has(token)) {
        if (list[pos++] !== '(') error('Fungsi harus diikuti kurung.');
        var args = [];
        if (list[pos] !== ')') {
          while (true) {
            var arg = expression(); args.push.apply(args, Array.isArray(arg) ? arg : [arg]);
            if (list[pos] !== ',' && list[pos] !== ';') break; pos++;
          }
        }
        if (list[pos++] !== ')') error('Argumen fungsi belum lengkap.');
        if (token === 'COUNT') value = args.length;
        else if (token === 'SUM') value = args.reduce(function (a,b) { return finite(a+b); },0);
        else {
          if (!args.length) error(token + ' membutuhkan nilai.');
          if (token === 'ROUND') { if (args.length > 2 || args.length === 2 && args[1] !== 0) error('ROUND menerima nilai dan jumlah desimal 0 untuk rupiah.'); value = Math.round(args[0]); }
          else if (token === 'AVERAGE') value = args.reduce(function(a,b) { return finite(a+b); },0) / args.length;
          else value = token === 'MIN' ? Math.min.apply(Math,args) : Math.max.apply(Math,args);
        }
      } else if (token && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token)) value = finite(Number(token));
      else error('Nilai rumus belum lengkap atau fungsi tidak didukung.');
      depth--; return value;
    }
    function product() {
      var value = atom();
      while (list[pos] === '*' || list[pos] === '/') {
        var op = list[pos++], right = scalar(atom());
        if (op === '/' && right === 0) error('Pembagian dengan nol tidak diperbolehkan.');
        value = finite(op === '*' ? scalar(value)*right : scalar(value)/right);
      }
      return value;
    }
    function expression() {
      var value = product();
      while (list[pos] === '+' || list[pos] === '-') {
        var op = list[pos++], right = scalar(product());
        value = finite(op === '+' ? scalar(value)+right : scalar(value)-right);
      }
      return value;
    }
    var result = scalar(expression());
    if (pos !== list.length) error('Ada bagian rumus yang tidak dapat dibaca.');
    return finite(result);
  }
  function calculate(rows, maxAmount) {
    var states = new Map(), cache = new Map();
    function read(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= rows.length) error('Referensi D' + (index+1) + ' tidak ada.');
      if (states.get(index) === 1) error('Referensi melingkar pada D' + (index+1) + '.');
      if (cache.has(index)) return cache.get(index);
      states.set(index,1);
      var row = rows[index], value = row.formula ? evaluate(row.formula,read) : row.amount;
      if (!Number.isSafeInteger(value) || value < 0 || value > maxAmount) error('D' + (index+1) + ': hasil harus rupiah bulat 0 sampai 1 triliun. Gunakan ROUND(...) bila perlu.');
      cache.set(index,value); states.set(index,2); return value;
    }
    // Evaluate all rows before changing any cached amount.
    rows.forEach(function (_,i) { read(i); });
    rows.forEach(function (row,i) { row.amount = cache.get(i); });
    return rows;
  }
  function shift(source, index, count, removed) {
    return source.replace(/\bD([1-9]\d*)\b/gi, function (_,n) {
      var row = Number(n)-1;
      if (removed && removed.has(row)) error('D' + n + ' masih dipakai rumus. Ubah rumus tersebut sebelum menghapus baris.');
      if (removed) row -= Array.from(removed).filter(function (i) { return i < row; }).length;
      else if (row >= index) row += count;
      return 'D' + (row+1);
    });
  }
  return { evaluate:evaluate, calculate:calculate, shift:shift };
});
