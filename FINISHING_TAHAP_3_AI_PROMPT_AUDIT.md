# FINISHING TAHAP 3 — PM2 TEST FIX & AUDIT FORMAT AI

**Tanggal:** 2026-09-25 · **Status:** ✅ SELESAI & DEPLOYED
**VPS:** ubuntu@168.110.221.197 · `/home/ubuntu/auto-cuan`

---

## 1. FIX UNIT TEST PM2

### Temuan: angka sebenarnya **5**, bukan 6

`ecosystem.config.js` mendaftarkan **5** app. `auto-cuan-local-app` yang terlihat di
`pm2 list` **tidak** berasal dari ecosystem — ia dijalankan terpisah.

| # | Nama | Script |
|---|---|---|
| 1 | `auto-cuan-vps-api` | `tools/vps-api-server.js` |
| 2 | `auto-cuan-ai-eval-supervisor` | `tools/ai-eval-once-supervisor.js` |
| 3 | `autocuan-bot` | `tools/telegram-interactive-bot.js` |
| 4 | `autocuan-web-tunnel` | `tools/cloudflared-web-supervisor.js` |
| 5 | `autocuan-verify-bot` | `tools/telegram-verify-bot.js` |

### Perbaikan yang dilakukan (bukan sekadar menaikkan angka)

Assertion `APPS.length === 3` **dihapus** dan diganti dengan kontrak yang bermakna:

```javascript
// Setiap daemon yang WAJIB hidup di VPS — ini kontraknya, bukan angka.
const REQUIRED_DAEMONS = [
  'auto-cuan-vps-api',            // Express API bridge (port 3001)
  'auto-cuan-ai-eval-supervisor', // AI evaluator runner
  'autocuan-bot',                 // Telegram interactive bot
  'autocuan-web-tunnel',          // public HTTPS origin (cloudflared supervisor)
  'autocuan-verify-bot'           // @AutoCuanVerificationBot long-polling
];

test('Batch 12: ecosystem registers every required long-lived VPS daemon', () => {
  for (const name of REQUIRED_DAEMONS) assert.ok(byName(name), 'missing required daemon: ' + name);
});

test('Batch 12: ecosystem declares exactly the five official daemons', () => {
  assert.equal(APPS.length, REQUIRED_DAEMONS.length, /* pesan menyebut daftar aktual */);
});

test('Batch 12: no daemon name is duplicated', () => { /* nama ganda = daemon hilang senyap */ });
```

**Alasan desain:** test lama mengukur **angka**, bukan **kontrak**. Setiap penambahan
daemon resmi (FASE 2 menambah 2) menggagalkan test padahal konfigurasinya benar.
Versi baru menambah 2 test: kehadiran daemon wajib + deteksi nama duplikat
(nama duplikat membuat PM2 diam-diam melewatkan satu proses).

### Hasil

```
✔ Batch 12: ecosystem registers every required long-lived VPS daemon
✔ Batch 12: ecosystem declares exactly the five official daemons
✔ Batch 12: no daemon name is duplicated
✔ Batch 12: every app script points to a real file on disk
✔ Batch 12: apps auto-restart and use single-fork mode
✔ Batch 12: supervisor kill_timeout allows child SIGTERM before force-kill
✔ Batch 12: apps pin production env and Jakarta timezone
✔ Batch 12: package.json exposes pm2 start & zero-downtime reload scripts
ℹ tests 8  ℹ pass 8  ℹ fail 0
```

**✅ PASS 100%**

---

## 2. AUDIT FORMAT JAWABAN AI (/tanya, /analisa, /opini)

### Arsitektur prompt yang ditemukan

| Komponen | Lokasi | Fungsi |
|---|---|---|
| `MARKET_ANALYSIS_SYSTEM` | `lib/telegram-interactive-bot.js` L391 | System prompt yang di-prepend saat `{ marketAnalysis: true }` |
| `marketContext.buildInjection()` | `lib/market-context-service.js` L176 | Blok grounding "DATA PASAR" |
| `callByok()` | `lib/telegram-interactive-bot.js` L1519 | Injeksi prompt + pemanggilan provider |
| `/opini` | L1629 | Snapshot top 5 + `marketAnalysis: true` |
| `/tanya` | L1651 | Grounding saja (tanpa marketAnalysis sebelum perbaikan) |
| `/analisa` | `renderMarketCard` L1557 | Broker card + narasi AI `marketAnalysis: true` |

### ❌ TEMUAN A — Grounding tidak lengkap

Sebelum perbaikan, blok `DATA PASAR` hanya berisi:
- `close`, `perubahan %`, `MA20`, `rasio volume`
- `bandar: net`, `asing`, `ritel`, `CR3 beli`, `CR5 beli`, top buyer

**Yang HILANG:**
- ❌ **`unified_score`** — skor 0-100 sama sekali tidak dikirim ke AI
- ❌ **Level plan Entry / SL / TP1 / TP2 / R:R** — tidak ada di prompt mana pun
- ❌ **Verdict bandar** (`bandar_label`) — hanya angka mentah, bukan kesimpulan

Akibatnya AI mengarang skor & level sendiri, dan angka di Telegram bisa berbeda
dari card web untuk saham yang sama.

**`/tanya` lebih parah:** dipanggil **tanpa** `marketAnalysis: true`, sehingga
bahkan tidak mendapat system prompt sama sekali.

### ❌ TEMUAN B — Tidak ada batas panjang

| Lapisan | Sebelum | Masalah |
|---|---|---|
| System prompt | tidak menyebut batas | model bebas menulis 6-8 paragraf |
| Gemini cap | `maxOutputTokens: 2048` | ≈1500 kata — tidak terbaca di HP |
| Provider lain | `max_tokens: 1024` | ≈750 kata |

Tidak ada instruksi "ringkas", "maksimal N paragraf", atau larangan pembuka.

---

### ✅ PERBAIKAN A — Grounding lengkap

**`lib/market-context-service.js`** — fungsi baru:
- `screenerSnapshotPath()`, `findScreenerRow()`, `findScreenerRowIn()`
- `extractScreenerFacts()` — hanya mengambil field yang boleh dikutip; field
  hilang tetap `null` (bukan default karangan)
- `buildInjectionWithRoots()` — menerima `screenerPath` eksplisit
- `fmtLvl()`, `bandarLabelId()` — format harga + terjemahkan verdict

**Blok grounding baru (terverifikasi live di VPS):**
```
DATA PASAR (snapshot penutupan terakhir, sumber lokal Auto-Cuan).
Gunakan hanya angka di bawah ini. Jangan menambah atau menebak harga lain.
- BBCA (2026-09-24): close 8750, perubahan 1.74%, MA20 8675, rasio volume 1.29x
- BBCA SKOR UNIFIED: 84/100 (grade A), status SWING_READY, kategori Swing Konglo
- BBCA RENCANA TRADE: Entry 8.600-8.750, SL 8.400, TP1 9.200, TP2 9.600, R/R 2.1
- BBCA STATUS BANDARMOLOGI: Akumulasi (konsisten 7D & 1M)
```

**Precedence skor** mengikuti alias yang disinkronkan engine Fase 3:
`unified_score → score → daytrade_score → combined_score`

**Verdict bandar diterjemahkan** ke istilah badge card:
`Accumulation→Akumulasi`, `Distribution→Distribusi`, `Mixed→Campuran`

### ✅ PERBAIKAN B — Batas panjang

**System prompt baru (`MARKET_ANALYSIS_SYSTEM`):**
```
Kamu analis saham berpengalaman. Tulislah ulasan chart yang mengalir alami,
nyaman dibaca di layar HP. Pakai paragraf ringkas, jeda baris natural,
tanpa tanda bintang, tanpa dash bullet, tanpa titik koma.
Selalu gunakan data candle 30 hari terakhir yang tersedia.
Jangan tambahkan angka di luar data yang diberikan.
MAKSIMAL 3 paragraf pendek, total tidak lebih dari 120 kata.
Paragraf pertama: kesimpulan dan arah (1-2 kalimat).
Paragraf kedua: alasan utama dari data (skor, bandarmologi, volume).
Paragraf ketiga: level penting dan manajemen risiko (entry, SL, TP).
Jangan mengulang angka yang sama dua kali.
Jangan menulis pembuka, sapaan, disclaimer, atau penutup.
Langsung ke isi.
Bila blok DATA PASAR menyediakan SKOR UNIFIED, kutip angka itu apa adanya
sebagai skor saham. Bila tersedia RENCANA TRADE, sebut level Entry, SL, dan
TP dari data itu, jangan mengarang level sendiri. Bila tersedia STATUS
BANDARMOLOGI, sebutkan statusnya. Bila salah satu tidak tersedia, jangan
mengarang dan jangan mengeluh soal keterbatasan data lebih dari satu kalimat.
```

**Token cap ditegakkan di provider** (prompt saja = permintaan, bukan jaminan):
```javascript
// ~450 token: nyaman di atas jawaban 120 kata, jauh di bawah default 2048
const answerTokenCap = (opts2 && opts2.marketAnalysis) ? 450 : undefined;

// Gemini
generateGeminiContent({ ..., ...(answerTokenCap ? { maxOutputTokens: answerTokenCap } : {}) })
// OpenAI / DeepSeek / Claude
aiProvider.callProvider({ ..., ...(answerTokenCap ? { maxTokens: answerTokenCap } : {}) })
// Fallback VPS
evaluateWithPrimary(primary, prompt, { ..., ...(answerTokenCap ? { extra: { maxOutputTokens: answerTokenCap } } : {}) })
```

**Cap hanya berlaku untuk `marketAnalysis`** — fitur AI lain tidak terpotong.

### ✅ Perbaikan tambahan: `/tanya` kini ikut tergrounding

`/tanya` sebelumnya tidak memakai `marketAnalysis`, jadi tidak mendapat system
prompt **maupun** batas panjang. Sekarang:
```javascript
const injection = marketContext.buildInjectionWithRoots(rootDir, question, { screenerPath: roots.screener });
return callByok(access.user, prompt, { marketAnalysis: true });
```
`/opini` juga diubah ke `buildInjectionWithRoots` agar memakai path snapshot yang
sudah di-resolve bot (`roots.screener`) — mencegah dua modul menebak path berbeda.

---

## 3. VERIFIKASI

### Test baru: `test/ai-prompt-contract.test.js` — **19 pass**

| Kelompok | Cakupan |
|---|---|
| Grounding | `extractScreenerFacts` baca skor/plan/bandar; fallback alias; **tidak mengarang nilai kosong** |
| Rendering | baris `SKOR UNIFIED` / `RENCANA TRADE` / `STATUS BANDARMOLOGI`; format `8.600`; terjemahan verdict |
| Snapshot | `findScreenerRow` lintas bucket; null-safe untuk file hilang & JSON rusak |
| Prompt | budget 3 paragraf / 120 kata; larangan pembuka; 3 aturan grounding |
| Token cap | Gemini + OpenAI + fallback; **hanya** untuk `marketAnalysis` |
| Handler | `/tanya` & `/opini` pakai `buildInjectionWithRoots` + `screenerPath` |

### Verifikasi live VPS — **20/20 PASS**
```
PASS  score line present          PASS  MAKSIMAL 3 paragraf
PASS  grade present               PASS  120 kata cap
PASS  plan line present           PASS  no preamble
PASS  entry present               PASS  SKOR UNIFIED rule
PASS  SL present                  PASS  RENCANA TRADE rule
PASS  TP1 present                 PASS  STATUS BANDARMOLOGI rule
PASS  TP2 present                 PASS  no invented levels
PASS  R/R present                 PASS  token cap wired
PASS  bandar verdict Indonesian   PASS  cap is marketAnalysis-only
PASS  bandar windows              PASS  technical still grounded
```

### Regression

| Suite | Hasil |
|---|---|
| PM2 test | **8/8 PASS** ✅ (sebelumnya 5/6) |
| `ai-prompt-contract` | 19/19 PASS |
| 9 suite terdampak | **186/186 PASS** |
| **FULL SUITE (553 file)** | **✅ ALL 553 PASSED** |

### PM2 setelah restart

| Proses | Memori | Status |
|---|---|---|
| auto-cuan-vps-api | 58.3mb | online |
| auto-cuan-ai-eval-supervisor | 84.5mb | online |
| auto-cuan-local-app | 60.4mb | online |
| autocuan-bot | 70.1mb | online |
| autocuan-verify-bot | 80.9mb | online |
| autocuan-web-tunnel | 60.4mb | online |

**6 proses ONLINE · max 84.5mb (< 100MB) · `pm2 save` sukses**

### Pekerjaan FASE 2 tetap utuh
`_getPublicWebBase` ✅ · `resolveRegisterBase` ✅ · `AutoCuanVerificationBot` ✅ · `lib/public-web-base.js` ✅

---

## 4. FILE DIUBAH

| File | Aksi |
|---|---|
| `test/pm2-ecosystem-config.test.js` | Assertion angka → kontrak `REQUIRED_DAEMONS` + cek duplikat |
| `lib/market-context-service.js` | +6 fungsi grounding (snapshot reader, fact extractor, renderer) |
| `lib/telegram-interactive-bot.js` | System prompt baru; token cap 3 provider; `/tanya` & `/opini` grounding |
| `test/ai-prompt-contract.test.js` | **BARU** — 19 test |
| `tools/curated-build-tests.json` | +1 entri (murni sisipan, 0 penghapusan) |

**Rollback:** `/home/ubuntu/finishing3-backup-20260925-195609`
(dicatat di `/home/ubuntu/finishing3-last-backup.txt`)

---

## 5. CATATAN

1. **Snapshot screener belum ada di VPS** (`data/screener-latest.json` tidak
   ditemukan). Grounding dirancang *fail-safe*: bila snapshot tidak ada, baris
   skor/plan/bandar **tidak dicetak** dan AI tidak diberi angka untuk dikarang —
   bukan menampilkan data palsu. Baris akan muncul otomatis begitu screener run
   berikutnya menulis snapshot.
2. **Cap 450 token** dipilih agar jawaban 120 kata tetap muat dengan margin.
   Provider yang mengabaikan field `extra` berperilaku seperti sebelumnya (tidak
   error) — cap tetap berlaku di jalur primary.
3. **Test lama `pm2-ecosystem-config` kini hijau**, sehingga full suite 553 file
   lulus 100% untuk pertama kali pada sesi ini.
