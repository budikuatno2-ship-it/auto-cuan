#!/usr/bin/env node
"use strict";
const fs = require('fs');
const path = require('path');

const BASE = process.cwd();
const DC_DIR = path.join(BASE, 'handoff-redesign', 'design', 'project');
const OUT_DIR = path.join(BASE, 'bukti-verifikasi-final', 'fase02');
const OUT = path.join(OUT_DIR, 'kontrak-per-kanvas.json');
const MAP = {Main:'Dashboard',Screener:'Screener',SektorHot:'Sektor Hot',CatatanAdmin:'Catatan Admin',Analisis:'Analisis & Chart',Bandarmologi:'Bandarmologi',SinyalIntelijen:'Sinyal Intelijen',BrokerHunter:'Broker Hunter',Insider:'Insider',Ranking:'Ranking',Financial:'Financial',StrukturPasar:'Struktur Pasar',Watchlist:'Watchlist',Portfolio:'Portfolio',TrackRecord:'Track Record',KelolaKeuangan:'Kelola Keuangan',PatternRadar:'Pattern Radar',AdminConsole:'Admin Console',AccountCenter:'Pusat Akun',AuthLogin:'Login',AuthRegister:'Register',AuthRecovery:'Recovery',AuthGmail:'Auth Gmail',Landing:'Landing',Maintenance:'Maintenance',Mobile:'Mobile',MobileScreener:'Mobile Screener',Ketentuan:'Ketentuan'};

const { extractPageContract } = require('./extract-dc-lib.js');

// MAIN
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, {recursive:true});
const dcFiles = fs.readdirSync(DC_DIR).filter(f => f.endsWith('.dc.html'));
console.log('Found ' + dcFiles.length + ' .dc.html files');

const result = { total_kanvas: dcFiles.length, checkedAt: new Date().toISOString(), halaman: {} };

for (const f of dcFiles) {
  const html = fs.readFileSync(path.join(DC_DIR, f), 'utf8');
  const name = MAP[f.replace('.dc.html','')] || f.replace('.dc.html','');
  result.halaman[name] = extractPageContract(html, f);
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log('Written:', OUT);

let tt=0,tb=0,tc=0,tm=0,ta=0;
for (const k in result.halaman) {
  const p = result.halaman[k];
  tt+=p.tab.length; tb+=p.tombol.length; tc+=p.kolom_tabel.length;
  tm+=p.kartu_metrik; ta+=p.aria_labels.length;
}
console.log(Object.keys(result.halaman).length+' pages, '+tt+' tabs, '+tb+' btns, '+tc+' cols, '+tm+' metrics, '+ta+' aria');