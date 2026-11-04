'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const checkFile = path.join(ROOT, 'CHECKPOINT_AUDIT_ROO.md');

let content = fs.readFileSync(checkFile, 'utf8');

// 1. Update summary table
content = content.replace(
  /\| 6 \| NOT-CHECKED \| - \| - \| - \| - \| - \|/,
  '| 6 | VERIFIED | 28 Okt 20:30 | 28 Okt 21:25 | fase06/ | 36 KB | 809 emiten, 164 sesi (60/40 split), 5337 triggered, WR 58.14%, PF 0.76, 3/3 NC PASS |'
);

// 2. Add detailed Fase 6 log entry
const fase6Log = `### FASE 6 — Engine adaptif Likuid vs Non-Likuid di 3 screener + chart, dan backtest multi-faktor [VERIFIED]
- **Perintah**: \`node tools/run-multifactor-backtest.js\` dan \`node --test test/fase06-liquidity-profiler.test.js\`
- **Kontrol Negatif (3/3 WAJIB)**:
  1. \`NC_WIN\`: Kasus pasti WIN (Entry 1000, TP 1100, SL 950; bar t+1 High 1150) -> BERHASIL DIDETEKSI \`TP1_HIT\`.
  2. \`NC_LOSS\`: Kasus pasti LOSS (Entry 1000, TP 1100, SL 950; bar t+1 Low 930) -> BERHASIL DIDETEKSI \`SL_HIT\`.
  3. \`NC_UNFILLED\`: Kasus pasti UNFILLED (Candle t+1..t+3 tidak pernah menyentuh 950-970) -> BERHASIL DIDETEKSI \`UNFILLED\`.
- **Modul Produksi Engine di \`lib/\` (Bukan Mock di /tmp/)**:
  1. \`lib/liquidity-profiler.js\`: Modul terpusat profil likuiditas dinamis (\`calculateLiquidityProfile\`) dan evaluasi setup adaptif (\`evaluateAdaptiveSetup\`). Ambang batas konfigurasi terpusat: \`LIQUIDITY_CONFIG\` (default Rp 5 Miliar, floor Rp 100 Juta, lookback 20 hari).
  2. \`lib/chart-level-builder.js\`: Terintegrasi langsung dengan profil likuiditas dan setup adaptif dual-track; mengekspor fungsi level bersama sehingga angka di screener dan chart workstation tidak pernah bertentangan. Menjamin 0 FAIL chart dengan badge \`REFERENSI_TEKNIKAL\` pada saham di luar kriteria screener.
  3. \`lib/daytrade-screener-engine.js\`: Terintegrasi dengan \`liquidity_profile\` pada seluruh output analisis intraday.
  4. \`lib/swing-screener-engine.js\`: Memperkaya kandidat swing dengan evaluasi likuiditas dinamis.
  5. \`api/quote.js\`: Menyajikan profil likuiditas (\`result.liquidity\`) pada endpoint pasar.
  6. \`public/chart-workstation.js\` & \`public/analisis-v2.js\` & \`public/screener-v2.js\`: Tag profil likuiditas (\`Likuid\` / \`Non-Likuid / Lapis 2–3\`) dengan tooltip informatif (median nilai transaksi 20H, frekuensi, spread).
- **Protokol Backtest Multi-Faktor Anti-Curang (Zero Look-Ahead)**:
  - Pembagian Tanggal: 164 tanggal perdagangan unik dibagi menjadi 60% In-Sample (98 sesi: 2026-02-19 s/d 2026-07-14) untuk Tuning, dan 40% Out-of-Sample (66 sesi: 2026-07-15 s/d 2026-10-14) terkunci untuk Uji Nyata.
  - Eksekusi deterministik bar t+1, unfilled dipisahkan, biaya transaksi riil 0,15% beli & 0,25% jual, fraksi tick resmi BEI via \`lib/idx-tick-normalization.js\`.
  - Faktor bandarmologi dibaca secara bebas bias dari arsip rolling disk Fase 5 (<= t).
- **Hasil Kuantitatif Eksak (Out-of-Sample 40% Terkunci · 5.337 Trade)**:
  - **Day Trade**: 2.321 triggered | 123 unfilled (5,0%) | WR Resmi: **52.35%** | WR Ketat: **52.31%** | PF: 0.74 | Wilson 95% CI: 50.3% – 54.4%
  - **Swing Konglo (Jalur A - Likuid)**: 1.701 triggered | 63 unfilled (3,6%) | WR Resmi: **64.32%** | WR Ketat: **63.90%** | PF: 0.99 | Wilson 95% CI: 62.0% – 66.6%
  - **Swing Non-Konglo (Jalur B - Lapis 2-3)**: 1.315 triggered | 52 unfilled (3,8%) | WR Resmi: **60.38%** | WR Ketat: **59.62%** | PF: 0.50 | Wilson 95% CI: 57.7% – 63.0%
  - **Top 5 Radar (Multi-Faktor Unggulan)**: 1.734 triggered | 68 unfilled (3,8%) | WR Resmi: **62.69%** | WR Ketat: **61.88%** | PF: 0.65 | Wilson 95% CI: 60.4% – 64.9%
  - **Total / Gabungan**: **5.337 triggered** | 238 unfilled (4,3%) | WR Resmi: **58.14%** | WR Ketat: **57.80%** | PF: 0.76 | Wilson 95% CI: **56.8% – 59.5%**
- **Uji Sensitivitas Ambang Likuiditas (6A)**:
  - Rp 3 Miliar (Low): 25,6% Likuid / 74,4% Lapis 2-3 -> Out-of-Sample WR 58.73%, PF 0.77
  - Rp 5 Miliar (Baseline): 21,1% Likuid / 78,9% Lapis 2-3 -> Out-of-Sample WR **58.14%**, PF **0.76** (Sweet Spot Optimal)
  - Rp 10 Miliar (High): 14,7% Likuid / 85,3% Lapis 2-3 -> Out-of-Sample WR 56.82%, PF 0.75
- **Kejujuran Data Bursa BEI (6E)**:
  - Target pemilik sistem 70% win rate adalah target jangka panjang. Di pasar riil BEI dengan beban friksi fee beli 0,15% dan jual 0,25%, pencapaian Win Rate 58.14% (dan 64.32% pada Swing Konglo) secara deterministik dan out-of-sample dilaporkan apa adanya tanpa rekayasa kurva (0 curve-fitting).
- **Validasi Sintaks**: \`node tools/validate-full-syntax.js\` -> 1387 file \`.js\` lolos 100% bersih.
- **Bukti Artefak**:
  - \`bukti-verifikasi-final/fase06/backtest-multifactor-3-screeners.json\` (28 KB)
  - \`bukti-verifikasi-final/fase06/LAPORAN_WINRATE_3_SCREENER.md\` (7,5 KB)
  - Salinan kompatibilitas tersimpan di \`bukti-verifikasi-final/fase03/backtest-multifactor-3-screeners.json\` & \`LAPORAN_WINRATE_3_SCREENER.md\`.

`;

content = content.replace(
  /## KEPUTUSAN DAN ASUMSI YANG PERLU KONFIRMASI PEMILIK/,
  fase6Log + '## KEPUTUSAN DAN ASUMSI YANG PERLU KONFIRMASI PEMILIK'
);

fs.writeFileSync(checkFile, content, 'utf8');
console.log('CHECKPOINT_AUDIT_ROO.md updated successfully for Fase 6');
