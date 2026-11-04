'use strict';

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'public', 'analisis-saham-runtime.js');
let code = fs.readFileSync(filePath, 'utf8');

// 1. In table render: Add visual bar to Free Float and real KSEI date
const oldTableBlock = `        var st = !hasFf ? 'Data belum lengkap' : (isHsc ? 'Konsentrasi tinggi' : (ffVal < 15 ? 'Free Float rendah' : (!row.hsc_flag ? 'HSC belum diketahui' : 'Normal')));
        var d = '30 Sep 2026';

        tr.innerHTML = '<td class="tk mono">' + escapeHtml(row.ticker) + '</td>' +
          '<td class="mut">' + escapeHtml(row.company_name || row.name || ('PT ' + row.ticker + ' Tbk')) + '</td>' +
          '<td class="' + ffC + '" style="font-weight:600">' + ffS + '</td>' +
          '<td><span class="pill-st" style="font-weight:500"><span class="' + hD + '"></span>' + hS + '</span></td>' +
          '<td>' + st + '</td>' +
          '<td class="mut num">' + d + '</td>';`;

const newTableBlock = `        var st = !hasFf ? 'Data belum lengkap' : (isHsc ? 'Konsentrasi tinggi' : (ffVal < 15 ? 'Free Float rendah' : (!row.hsc_flag ? 'HSC belum diketahui' : 'Normal')));
        var barWidth = hasFf ? Math.min(100, Math.max(2, ffVal)) : 0;
        var barColor = (hasFf && ffVal < 15) ? 'var(--ac-warn, #f59e0b)' : 'var(--ac-brand, #10b981)';
        var ffVisual = hasFf
          ? '<div style="display:inline-flex;align-items:center;justify-content:flex-end;gap:8px;width:100%">' +
              '<div style="width:44px;height:5px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;flex-shrink:0" title="Free Float ' + ffS + '">' +
                '<div style="width:' + barWidth.toFixed(1) + '%;height:100%;background:' + barColor + ';border-radius:3px"></div>' +
              '</div>' +
              '<span style="font-weight:600;min-width:50px;text-align:right">' + ffS + '</span>' +
            '</div>'
          : '—';
        var rawDate = row.free_float_as_of || row.as_of_trade_date || row.as_of;
        var d = (hasFf && rawDate) ? formatIndonesianDateWithWib(rawDate) : '—';

        tr.innerHTML = '<td class="tk mono">' + escapeHtml(row.ticker) + '</td>' +
          '<td class="mut">' + escapeHtml(row.company_name || row.name || ('PT ' + row.ticker + ' Tbk')) + '</td>' +
          '<td class="' + ffC + '">' + ffVisual + '</td>' +
          '<td><span class="pill-st" style="font-weight:500"><span class="' + hD + '"></span>' + hS + '</span></td>' +
          '<td>' + st + '</td>' +
          '<td class="mut num">' + d + '</td>';`;

if (code.includes(oldTableBlock)) {
  code = code.replace(oldTableBlock, newTableBlock);
  console.log('✓ Successfully patched table render with visual bar and real KSEI date');
} else {
  console.log('⚠ oldTableBlock not found directly, checking normalized lines');
}

// 2. In detail pane: Dynamic KSEI date
const oldDetailSource = `      var sSource = byId('msDetailSource');
      if (sSource) sSource.textContent = 'KSEI · 30 Sep 2026';`;

const newDetailSource = `      var sSource = byId('msDetailSource');
      if (sSource) {
        var detailRawDate = row.free_float_as_of || row.as_of_trade_date || row.as_of;
        var detailFormattedDate = (hasFf && detailRawDate) ? formatIndonesianDateWithWib(detailRawDate) : null;
        sSource.textContent = detailFormattedDate ? ('KSEI · ' + detailFormattedDate) : 'KSEI · Belum ada data';
      }`;

if (code.includes(oldDetailSource)) {
  code = code.replace(oldDetailSource, newDetailSource);
  console.log('✓ Successfully patched msDetailSource with dynamic KSEI date');
} else {
  console.log('⚠ oldDetailSource not found directly');
}

fs.writeFileSync(filePath, code, 'utf8');
console.log('Done patching public/analisis-saham-runtime.js');
