# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 2 (AI & LLM Grounding)
Dokumentasi temuan bug Fase 2. Read-only kode produksi, dibuktikan lewat failing unit test di test/.

---

### BUG-NAR-01: Unhandled TypeError pada `narrateMonitorUpdate` saat `evaluation` bernilai null / undefined
- **File & Baris:** `lib/ai-narration.js:151`
- **Kutipan Kode:**
  ```javascript
  async function narrateMonitorUpdate(pick, evaluation, priceData) {
    const status = (evaluation.status || '').toUpperCase();
    if (isStaleOrExpired(pick, evaluation)) return { note: null, source: 'fallback', error: 'stale_or_expired' };
  ```
- **Dampak ke User:**
  Jika worker atau caller memanggil `narrateMonitorUpdate(pick, null)` atau evaluation gagal di-resolve, proses crash seketika dengan `TypeError: Cannot read properties of null (reading 'status')` sebelum proteksi `isStaleOrExpired` sempat berjalan. Notifikasi Telegram gagal terkirim / proses worker berhenti tak terduga.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-bugs.test.js`
  Hasil: `BUG-NAR-01 reproduced: threw unhandled exception: Cannot read properties of null (reading 'status')`.
- **Usulan Arah Perbaikan:**
  Gunakan optional chaining atau default object: `const status = String((evaluation && evaluation.status) || '').toUpperCase();` dan posisikan evaluasi setelah guard awal.

---

### BUG-NAR-02: `narrateMonitorUpdate` Menghapus Perhitungan `profit_pct` Saat `priceData` Kosong Meskipun TP Sudah Tercapai
- **File & Baris:** `lib/ai-narration.js:164-170`
- **Kutipan Kode:**
  ```javascript
  const entry1 = parseFloat(pick.entry1) || 0;
  const lastPrice = priceData && priceData.last ? priceData.last : 0;
  const tp1 = parseFloat(pick.tp1) || 0;
  let profitPct = null, lossPct = null;
  if (entry1 > 0 && lastPrice > 0) {
    if (status === 'TP1_HIT' || status === 'TP2_HIT') {
      const tp = status === 'TP2_HIT' ? (parseFloat(pick.tp2) || tp1) : tp1;
      profitPct = (((tp - entry1) / entry1) * 100).toFixed(2);
    }
  ```
- **Dampak ke User:**
  Saat event TP1_HIT atau TP2_HIT dipicu dari evaluasi internal tanpa melewatkan objek `priceData` (atau last = 0), `profit_pct` tidak dihitung (`null`). Akibatnya prompt ke AI tidak memuat data persentase cuan yang sebenarnya sudah pasti dari level target vs entry. AI menghasilkan narasi tanpa angka persentase keuntungan.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-bugs.test.js`
  Hasil: `profitPct requires lastPrice > 0 even when TP1/TP2 hit is determined by entry & target`.
- **Usulan Arah Perbaikan:**
  Hitung `profitPct` murni berbasis `entry1` dan `tp` tanpa mensyaratkan `lastPrice > 0` saat status TP HIT.

---

### BUG-NAR-03: Crash TypeError pada `generateNote` Saat Argumen `data` bernilai null / undefined
- **File & Baris:** `lib/ai-narration.js:122`
- **Kutipan Kode:**
  ```javascript
  const cacheKey = narrationCache.buildCacheKey({
    type: type, ticker: data.ticker, category: data.category || data.status,
    data: { entry1: data.entry1, ... }
  });
  ```
- **Dampak ke User:**
  Jika `generateNote` dipanggil tanpa payload data saat AI narration aktif, sistem melempar unhandled `TypeError: Cannot read properties of null (reading 'ticker')` alih-alih mengembalikan fallback `{ note: null, source: 'fallback' }`.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-bugs.test.js`
  Hasil: `BUG-NAR-03 reproduced: crashed on null data with Cannot read properties of null (reading 'ticker')`.
- **Usulan Arah Perbaikan:**
  Tambahkan guard: `const payload = data && typeof data === 'object' ? data : null; if (!payload) return { note: null, source: 'fallback', error: 'invalid_data' };`.

---

### BUG-ARG-01: `moneyFromMessage` Gagal Mengekstrak Dana Pada Kalimat Alami Multi-kata ("modal saya sebesar X juta")
- **File & Baris:** `lib/ai-runtime-grounding.js:77`
- **Kutipan Kode:**
  ```javascript
  const contextualMoney = /(?:budget|modal|dana|uang|saldo|kapital|simulasi)\s*(?:saya|aku|ku|sebesar|sekitar|senilai|=|:)?\s*(\d(?:[\d.,]*\d)?)(?:\s*(ribu|juta|miliar|triliun))/gi;
  ```
- **Dampak ke User:**
  User yang mengetik kalimat natural seperti `"Modal saya sebesar 50 juta"` menghasilkan array kosong `[]` karena kelompok non-capturing `(?:saya|aku|ku|sebesar|sekitar|senilai|=|:)?` hanya dapat mencocokkan tepat satu kata tanpa loop. Daya beli tidak terdeteksi, AI menjawab tidak tahu modal user padahal sudah diketik jelas.
- **Bukti Test Nyata:**
  `node --test test/ai-runtime-grounding-bugs.test.js`
  Hasil: `values: []`, gagal assert `[50000000]`.
- **Usulan Arah Perbaikan:**
  Gunakan pemisah fleksibel multi-kata: `(?:\s+(?:saya|aku|ku|sebesar|sekitar|senilai|=|:))+\s*`.

---

### BUG-ARG-02: `prepareRuntimeGrounding` Menghilangkan `calculation_facts` Pada Analisis Saham Tunggal (`stock_analysis`)
- **File & Baris:** `lib/ai-runtime-grounding.js:192-198`
- **Kutipan Kode:**
  ```javascript
  output.ai_answer_policy = answerPolicy(source);
  if (source === 'portfolio_chat') {
    output.calculation_facts = portfolioCalculationFacts(output);
    output.affordability_facts = affordabilityFacts(output, message);
  }
  return output;
  ```
- **Dampak ke User:**
  `answerPolicy` menginstruksikan LLM: *"Angka hanya boleh berasal dari snapshot atau calculation_facts."* Namun untuk modul `stock_analysis`, `calculation_facts` dibiarkan `undefined`. AI tidak menerima fakta perhitungan rasio risk/reward yang deterministik dan rentan berhalusinasi atau menolak menjawab metrik risiko.
- **Bukti Test Nyata:**
  `node --test test/ai-runtime-grounding-bugs.test.js`
  Hasil: `calculation_facts` bernilai `undefined`.
- **Usulan Arah Perbaikan:**
  Import `stockFacts` dari `ai-eval-derived-facts.js` dan isi `output.calculation_facts = { stock: stockFacts(output) }` saat `source !== 'portfolio_chat'`.

---

### BUG-ARG-03: `portfolioCalculationFacts` Menghilangkan Metrik `budgetFacts` dari Kontrak Runtime Grounding
- **File & Baris:** `lib/ai-runtime-grounding.js:168-176`
- **Kutipan Kode:**
  ```javascript
  function portfolioCalculationFacts(context) {
    const source = context && typeof context === 'object' ? context : {};
    const plans = Array.isArray(source.plans) ? source.plans : [];
    const simulation = source.simulation && typeof source.simulation === 'object' ? source.simulation : null;
    return compact({
      policy: 'Semua angka turunan dihitung deterministik dari snapshot. Jangan pakai bila basis datanya tidak tersedia.',
      market_rules: { shares_per_lot: SHARES_PER_LOT },
      plans: plans.map((plan) => planFacts(plan, simulation))
    });
  }
  ```
- **Dampak ke User:**
  Berbeda dari evaluator evaluasi (`ai-eval-derived-facts.js:186-193`), modul runtime grounding ini lupa menyertakan `budgetFacts(source)`. Alokasi modal per posisi dan porsi dana cadangan hilang dari grounding runtime portfolio chat.
- **Bukti Test Nyata:**
  `node --test test/ai-runtime-grounding-bugs.test.js`
  Hasil: `calculation_facts.budget` bernilai `undefined`.
- **Usulan Arah Perbaikan:**
  Import `budgetFacts` dari `ai-eval-derived-facts.js` dan tambahkan properti `budget: budgetFacts(source)` pada objek yang di-compact.

---

### BUG-ARG2-01: `addPerShareFacts` Menggunakan Fallback `plans[index]` Mengakibatkan Kontaminasi Metrik Antar-Saham yang Berbeda
- **File & Baris:** `lib/ai-runtime-grounding-v2.js:37`
- **Kutipan Kode:**
  ```javascript
  facts.forEach((fact, index) => {
    const factTicker = tickerKey(fact && fact.ticker);
    const plan = (factTicker && plansByTicker.get(factTicker)) || plans[index] || {};
    const entry = levelOf(plan, ['entryPriceIdr', 'entry_price', 'entry', 'avgPriceIdr']);
  ```
- **Dampak ke User:**
  Jika sebuah ticker di `calculation_facts.plans` (misal GOTO) tidak ditemukan di `plansByTicker`, kode menggunakan fallback `plans[index]` (misal BBRI). Akibatnya angka risiko per lembar (`loss_to_stop_per_share_idr`) dan target keuntungan (`tp1_gain_per_share_idr`) milik BBRI dilekatkan ke fakta saham GOTO. AI akan menjelaskan batas risiko dan target harga yang salah fatal ke user.
- **Bukti Test Nyata:**
  `node --test test/ai-runtime-grounding-v2-bugs.test.js`
  Hasil: `GOTO must not inherit BBRI's loss_to_stop_per_share_idr, got 300`.
- **Usulan Arah Perbaikan:**
  Hapus fallback `|| plans[index]`. Jika `factTicker` tidak cocok dengan entri manapun di `plansByTicker`, gunakan objek kosong `{}`.

---

### BUG-ARG2-02: `levelOf` pada `addPerShareFacts` Mengabaikan Alias Standar Stop Loss `sl`
- **File & Baris:** `lib/ai-runtime-grounding-v2.js:39`
- **Kutipan Kode:**
  ```javascript
  const stop = levelOf(plan, ['stopLossIdr', 'stop_loss', 'stop']);
  ```
- **Dampak ke User:**
  Banyak payload trading plan menggunakan kunci `sl` (misal `{ ticker: 'BBRI', entry: 5000, sl: 4700 }`). Karena `sl` tidak ada di daftar pengecekan `levelOf`, variabel `stop` bernilai `null`. Kalkulasi `loss_to_stop_per_share_idr` tidak pernah terhitung (`undefined`), sehingga AI tidak menerima fakta nominal risiko per lembar.
- **Bukti Test Nyata:**
  `node --test test/ai-runtime-grounding-v2-bugs.test.js`
  Hasil: `addPerShareFacts should compute 300 from entry 5000 and sl 4700, got undefined`.
- **Usulan Arah Perbaikan:**
  Tambahkan `'sl'` dan `'stopLoss'` ke dalam array pencarian: `['stopLossIdr', 'stop_loss', 'stop', 'sl', 'stopLoss']`.

---

### BUG-EDF-01: `stockFacts` Mengabaikan Field Alias Standar Screener `entry1`, `entry2`, dan `sl`
- **File & Baris:** `lib/ai-eval-derived-facts.js:160-163`
- **Kutipan Kode:**
  ```javascript
  const entry = recursiveFind(source, new Set(['entry', 'entryprice', 'entry_price', 'entrylow', 'entry_low', 'entrypriceidr']));
  const entryHigh = recursiveFind(source, new Set(['entryhigh', 'entry_high']));
  const stop = recursiveFind(source, new Set(['stop', 'stoploss', 'stop_loss', 'stoplossidr']));
  ```
- **Dampak ke User:**
  Di seluruh ekosistem Auto-Cuan (screener daytrade, swing, monitor pick), sinyal menggunakan alias `entry1`, `entry2`, dan `sl`. Karena ketiga kunci ini tidak ada di lookup Set, pemanggilan `stockFacts(pick)` menghasilkan fakta harga kosong (`entry_price: undefined`, `stop_loss: undefined`), sehingga seluruh metrik `risk_per_share`, `reward_to_tp1`, dan `risk_reward_tp1` hangus/kosong.
- **Bukti Test Nyata:**
  `node --test test/ai-eval-derived-facts-bugs.test.js`
  Hasil: `entry_price` dan `stop_loss` undefined.
- **Usulan Arah Perbaikan:**
  Tambahkan `'entry1'`, `'entry2'` ke Set entry, dan tambahkan `'sl'` ke Set stop.

---

### BUG-EDF-02: Simulasi `planFacts` Menghasilkan Nilai Null untuk Semua Total Posisi Pada Rencana Saham Baru / Watchlist
- **File & Baris:** `lib/ai-eval-derived-facts.js:125-132`
- **Kutipan Kode:**
  ```javascript
  const totalLots = lots != null && addLots != null ? lots + addLots : null;
  const totalShares = shares != null && addShares != null ? shares + addShares : null;
  const totalCapital = capital != null && additionalCapital != null ? capital + additionalCapital : null;
  const averageEntry = totalCapital != null && totalShares != null && totalShares > 0
    ? totalCapital / totalShares
    : null;
  ```
- **Dampak ke User:**
  Jika user membuat simulasi pembelian pada saham watchlist yang belum dimiliki (`lots` = null atau 0), kondisi `lots != null` bernilai false. Akibatnya `totalLots`, `totalShares`, `totalCapital`, dan `averageEntry` semuanya bernilai `null` dan dihapus oleh `compactObject`. Simulasi pembelian baru tidak menghasilkan estimasi posisi apapun ke AI.
- **Bukti Test Nyata:**
  `node --test test/ai-eval-derived-facts-bugs.test.js`
  Hasil: `facts.simulation.total_lots` undefined.
- **Usulan Arah Perbaikan:**
  Hitung akumulasi dengan memperlakukan lot/modal eksisting yang belum ada sebagai 0: `const totalLots = addLots != null ? (lots || 0) + addLots : null;`.

---

### BUG-NAV-01: `stripClockReferences` Menghapus Harga Saham dan Persentase Berdesimal Dua (`X.YY` di mana `X <= 23` dan `YY <= 59`)
- **File & Baris:** `lib/ai-narration-validator.js:43-48`
- **Kutipan Kode:**
  ```javascript
  function stripClockReferences(text) {
    return String(text || '').replace(/\b(?:[01]?\d|2[0-3])[:.]\d{2}\b/g, function(token) {
      var parts = token.split(/[:.]/);
      var minute = Number(parts[1]);
      return minute >= 0 && minute <= 59 ? ' ' : token;
    });
  }
  ```
- **Dampak ke User:**
  Setiap angka harga saham atau level floating point seperti `18.30`, `14.50`, `0.05`, `22.15` yang dihasilkan model dianggap sebagai jam/menit (`18:30`) dan dihapus. Jika AI mengarang harga palsu di rentang ini, validator gagal mendeteksinya (`valid: true`) dan angka halusinasi lolos ke channel Telegram.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-validator-bugs.test.js`
  Hasil: `assert.strictEqual(result.valid, false)` gagal; validator meloloskan `18.30`.
- **Usulan Arah Perbaikan:**
  Hanya bersihkan token waktu bila didahului indikator jam/waktu (misal `jam`, `pukul`, `wib`) atau bila menggunakan titik dua `:` sebagai pemisah.

---

### BUG-NAV-02: Pengecualian Tanggal 0–31 Meloloskan Angka Harga dan Persentase Palsu Tanpa Konteks Kalender
- **File & Baris:** `lib/ai-narration-validator.js:175-177`
- **Kutipan Kode:**
  ```javascript
  var fabricatedNumbers = aiNumbers.filter(function(n) {
    if (sourceNumbers.has(n)) return false;
    var num = parseFloat(n);
    // Day-of-month references.
    if (num >= 0 && num <= 31) return false;
  ```
- **Dampak ke User:**
  Seluruh angka antara 0 hingga 31 dianggap "tanggal" tanpa verifikasi apakah angka tersebut integer atau didampingi nama bulan. Akibatnya, harga saham FCA (misal 15, 25 rupiah), target persentase profit/cut loss palsu (10%, 25%), atau lot karangan (misal 5 lot) bebas dari deteksi angka halusinasi.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-validator-bugs.test.js`
  Hasil: `assert.strictEqual(result.valid, false)` gagal; teks `Disiplin cut loss di level 25 rupiah` lolos validasi.
- **Usulan Arah Perbaikan:**
  Pastikan pengecualian tanggal hanya berlaku untuk bilangan bulat (`Number.isInteger(num)`) dan didampingi token nama bulan/kalender.

---

### BUG-NAV-03: `validateNote` Mengabaikan Objek Bersarang pada `sourceData`, Menolak Angka Sah Valid
- **File & Baris:** `lib/ai-narration-validator.js:161-172`
- **Kutipan Kode:**
  ```javascript
  for (var key of Object.keys(sourceData)) {
    var val = sourceData[key];
    if (val == null) continue;
    if (typeof val === 'number' && isFinite(val)) { ... }
    else if (typeof val === 'string') { ... }
  }
  ```
- **Dampak ke User:**
  Jika payload sinyal memiliki metadata bersarang seperti `sourceData.levels = { support: 4500 }`, angka `4500` diabaikan dari daftar sumber sah. AI yang sah menyebut support `4500` akan ditolak oleh validator dengan alasan `fabricated_numbers`, memicu fallback kosong ke user.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-validator-bugs.test.js`
  Hasil: `assert.strictEqual(result.valid, true)` gagal dengan error `fabricated_numbers`.
- **Usulan Arah Perbaikan:**
  Gunakan penelusuran rekursif untuk mengekstrak angka dari properti bersarang dalam `sourceData`.

---

### BUG-NAC-01: Crash TypeError pada `buildCacheKey` Saat Dipanggil Tanpa Argumen atau bernilai null
- **File & Baris:** `lib/ai-narration-cache.js:30-33`
- **Kutipan Kode:**
  ```javascript
  function buildCacheKey(params) {
    const parts = [
      String(params.type || 'unknown'),
  ```
- **Dampak ke User:**
  Pemanggilan `buildCacheKey()` atau `buildCacheKey(null)` langsung melempar unhandled `TypeError: Cannot read properties of null (reading 'type')`, merusak flow caching narasi AI.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-cache-prompts-bugs.test.js`
  Hasil: `BUG-NAC-01 reproduced: crashed with Cannot read properties of null (reading 'type')`.
- **Usulan Arah Perbaikan:**
  Default argument: `function buildCacheKey(params = {}) { const p = params || {}; ... }`.

---

### BUG-NAC-02: `buildCacheKey` Menghilangkan Seluruh Properti Objek Bersarang Akibat Array Replacer `JSON.stringify`
- **File & Baris:** `lib/ai-narration-cache.js:38-41`
- **Kutipan Kode:**
  ```javascript
  if (params.data && typeof params.data === 'object') {
    const sorted = JSON.stringify(params.data, Object.keys(params.data).sort());
    const hash = crypto.createHash('md5').update(sorted).digest('hex').slice(0, 12);
  ```
- **Dampak ke User:**
  Array replacer pada `JSON.stringify` di JavaScript berfungsi sebagai whitelist kunci. Saat rekursi masuk ke objek bersarang (misal `{ nested: { val: 100 } }`), kunci di dalam anak tidak ada di whitelist tingkat atas, sehingga seluruh properti anak dihapus. Dua payload dengan data bersarang berbeda menghasilkan cache key yang identik (tabrakan cache/stale response).
- **Bukti Test Nyata:**
  `node --test test/ai-narration-cache-prompts-bugs.test.js`
  Hasil: `assert.notStrictEqual(key1, key2)` gagal karena kedua key sama persis (`signal|BBRI||408e08d5e8f4`).
- **Usulan Arah Perbaikan:**
  Urutkan objek bersarang secara deterministik tanpa array replacer `JSON.stringify`.

---

### BUG-NAP-01: Crash TypeError pada `buildNotePrompt` Saat Argumen `data` bernilai null / undefined
- **File & Baris:** `lib/ai-narration-prompts.js:63-64`
- **Kutipan Kode:**
  ```javascript
  function buildNewSignalNotePrompt(data) {
    var category = (data.category || 'Swing').toUpperCase();
  ```
- **Dampak ke User:**
  Jika template prompt dipanggil dengan data tidak lengkap atau null, sistem crash seketika melempar unhandled `TypeError: Cannot read properties of null (reading 'category')`.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-cache-prompts-bugs.test.js`
  Hasil: `BUG-NAP-01 reproduced: crashed on null data with Cannot read properties of null (reading 'category')`.
- **Usulan Arah Perbaikan:**
  Defensif guard `var d = data || {};`.

---

### BUG-NAP-02: `buildNotePrompt` Case-Sensitive Mengabaikan Event Notifikasi Huruf Besar (`TP1_HIT`, `SL_HIT`, `ENTRY_HIT`)
- **File & Baris:** `lib/ai-narration-prompts.js:33-47`
- **Kutipan Kode:**
  ```javascript
  switch (type) {
    case 'tp1_hit':
      return buildTp1HitNotePrompt(data);
    case 'sl_hit':
  ```
- **Dampak ke User:**
  Event dari screener atau webhook sering kali berstatus uppercase (`TP1_HIT`, `SL_HIT`). Karena perbandingan `switch` bersifat case-sensitive, pemanggilan ini jatuh ke `default: buildGenericNotePrompt`, menghilangkan instruksi khusus pengamanan profit dan trailing stop.
- **Bukti Test Nyata:**
  `node --test test/ai-narration-cache-prompts-bugs.test.js`
  Hasil: prompt TP1_HIT menghasilkan teks generic `Notifikasi tipe "TP1_HIT"` alih-alih instruksi target profit.
- **Usulan Arah Perbaikan:**
  Normalisasi tipe ke huruf kecil: `switch (String(type || '').toLowerCase())`.

---

### BUG-AAC-01: `numberTokenRegex` Membuang Tanda Negatif pada Persentase dan Angka Finansial Risiko
- **File & Baris:** `lib/ai-answer-contract.js:84-86`
- **Kutipan Kode:**
  ```javascript
  function numberTokenRegex() {
    return /\b(?:rp|idr)\s*\d(?:[\d.,]*\d)?(?:\s*(?:ribu|juta|miliar|triliun))?(?:\s*rupiah)?(?:\s*[x×%])?|(?<![A-Za-z0-9_])\d(?:[\d.,]*\d)?(?:\s*(?:ribu|juta|miliar|triliun))?(?:\s*rupiah)?(?:\s*[x×%])?(?![A-Za-z0-9_])/gi;
  }
  ```
- **Dampak ke User:**
  Regex tidak menangkap tanda `-`. Angka risiko seperti `-5%` diekstrak sebagai angka positif `5`. Saat divalidasi terhadap `allowed_numbers` yang mencantumkan batas risiko `-5`, pembanding `nearlyEqual(5, -5)` gagal, menyebabkan jawaban AI yang sah ditolak dengan error `angka finansial tidak didukung sumber: 5`.
- **Bukti Test Nyata:**
  `node --test test/ai-answer-contract-cache-bugs.test.js`
  Hasil: `assert.deepStrictEqual([5], [-5])` gagal.
- **Usulan Arah Perbaikan:**
  Dukung tanda negatif opsional pada regex: `[+-]?`.

---

### BUG-AAC-02: `parseMatchedNumber` Membuang Pengali Skala pada Konteks Finansial Non-Moneter ("10 juta lembar")
- **File & Baris:** `lib/ai-answer-contract.js:106-107`
- **Kutipan Kode:**
  ```javascript
  const base = parseNumberToken(text);
  if (base == null) return null;
  if (scale && (explicitCurrency || MONETARY_SCALE_CONTEXT.test(context || ''))) return base * scale;
  return base;
  ```
- **Dampak ke User:**
  Untuk frasa seperti `"Volume transaksi 10 juta lembar"`, karena tidak ada kata mata uang rupiah dalam `MONETARY_SCALE_CONTEXT`, skala `juta` diabaikan dan fungsi mengembalikan angka `10`. Downstream validator menganggap angka `10` adalah angka finansial liar yang tidak terdaftar di snapshot, lalu membatalkan respons AI.
- **Bukti Test Nyata:**
  `node --test test/ai-answer-contract-cache-bugs.test.js`
  Hasil: `assert.deepStrictEqual([10], [10000000])` gagal.
- **Usulan Arah Perbaikan:**
  Bila kata skala (`ribu`, `juta`, `miliar`) secara eksplisit tertulis setelah angka, selalu kalikan dengan skala yang sesuai.

---

### BUG-AC-01: Crash RangeError pada `setCachedAnalysis` Saat `ttlSeconds` Bernilai `NaN`
- **File & Baris:** `lib/ai-analysis-cache.js:90-97`
- **Kutipan Kode:**
  ```javascript
  const ttlSeconds = typeof params.ttlSeconds === 'number'
    ? params.ttlSeconds
    : DEFAULT_TTL_SECONDS;

  const now = Date.now();
  const expiresAtMs = now + (ttlSeconds * 1000);
  const expiresAtIso = new Date(expiresAtMs).toISOString();
  ```
- **Dampak ke User:**
  Di JavaScript, `typeof NaN === 'number'` bernilai `true`. Jika caller melewatkan `ttlSeconds` hasil kalkulasi yang menjadi `NaN`, `new Date(NaN).toISOString()` seketika melempar unhandled `RangeError: Invalid time value` yang mematikan serverless runner / proses Node.js.
- **Bukti Test Nyata:**
  `node --test test/ai-answer-contract-cache-bugs.test.js`
  Hasil: `BUG-AC-01 reproduced: crashed with Invalid time value`.
- **Usulan Arah Perbaikan:**
  Gunakan pengecekan ketat `Number.isFinite(params.ttlSeconds)`.

---

### BUG-AC-02: `getCachedAnalysis` Tidak Menghapus Entri Kedaluwarsa dari `memoryCache` Saat Dibaca
- **File & Baris:** `lib/ai-analysis-cache.js:48-52`
- **Kutipan Kode:**
  ```javascript
  const mem = memoryCache.get(cacheKey);
  if (mem && mem.expiresAt > now) {
    return Object.assign({}, mem.payload, { source: 'db_cache', cache_hit: true });
  }
  ```
- **Dampak ke User:**
  Jika sebuah entri memori kedaluwarsa (`mem.expiresAt <= now`), fungsi hanya melewatinya ke DB tanpa melakukan `memoryCache.delete(cacheKey)`. Memori cache terus membengkak (memory leak) seiring waktu tanpa pernah dibersihkan saat cache miss.
- **Bukti Test Nyata:**
  `node --test test/ai-answer-contract-cache-bugs.test.js`
  Hasil: `getCachedAnalysis does not prune expired item from memoryCache on read`.
- **Usulan Arah Perbaikan:**
  Tambahkan pembersihan langsung: `if (mem && mem.expiresAt <= now) memoryCache.delete(cacheKey);`.

---

### BUG-UAC-01: Tidak Ada Validasi `userId` pada `saveUserApiKey` dan `getUserApiKey` Mengakibatkan Kebocoran Kredensial Lintas Sesi Anonim
- **File & Baris:** `lib/user-ai-credentials.js:103-144` & `lib/user-ai-credentials.js:146-191`
- **Kutipan Kode:**
  ```javascript
  async function saveUserApiKey(db, userId, rawKey, provider = 'gemini') {
    const validation = validateApiKey(rawKey);
    if (!validation.ok) {
      return { ok: false, status: 400, error: validation.error };
    }
    // ...
    fallbackMemoryStore.set(`${userId}:${provider}`, { encryptedKey: encrypted, keyHint: hint, updatedAt: now });
  ```
- **Dampak ke User:**
  Jika caller tidak mengirimkan `userId` (`undefined`, `null`, atau string kosong), API key tetap disimpan dengan kunci `undefined:gemini`. Sesi anonim lain yang memanggil `getUserApiKey` tanpa `userId` akan mendapatkan kredensial dan API key privat pengguna tersebut.
- **Bukti Test Nyata:**
  `node --test test/user-ai-credentials-bugs.test.js`
  Hasil: `saveUserApiKey should reject undefined userId` gagal (`AssertionError [ERR_ASSERTION]: 'saveUserApiKey should reject undefined userId': true == false`).
- **Usulan Arah Perbaikan:**
  Tambahkan validasi awal: `if (!userId || typeof userId !== 'string' || !userId.trim()) return { ok: false, status: 400, error: 'User ID wajib diisi.' };`.

---

### BUG-UAC-02: `isSubscribedTier` Mengabaikan Status Pelanggan Aktif Recurring (Non-Lifetime) Sehingga Menolak Akses App Key
- **File & Baris:** `lib/user-ai-credentials.js:206-216`
- **Kutipan Kode:**
  ```javascript
  function isSubscribedTier(access) {
    if (!access) return false;
    const user = access.user || {};
    const username = String(user.username || '').trim().toLowerCase();
    const isAdmin = user.isAdmin === true;
    const entitlement = access.entitlement || {};
    if (isAdmin || username === 'budi') return true;
    if (entitlement.lifetime_state === 'active' || entitlement.lifetime_state === 'lifetime' || entitlement.current_plan === 'lifetime') return true;
    if (access.premium === true || entitlement.premium === true) return true;
    return false;
  }
  ```
- **Dampak ke User:**
  Pengguna berlangganan bulanan/tahunan aktif yang memiliki record entitlement `current_plan: 'pro'` atau `status: 'active'` (namun bukan tipe lifetime dan flag `premium` tidak bernilai true eksplisit) dianggap sebagai tier `'free'`. Pengguna berbayar ditolak menggunakan application AI key dan dipaksa memasukkan personal BYOK key sendiri.
- **Bukti Test Nyata:**
  `node --test test/user-ai-credentials-bugs.test.js`
  Hasil: `Active recurring subscriber should be recognized as subscribed tier` gagal (`AssertionError [ERR_ASSERTION]: 'Active recurring subscriber should be recognized as subscribed tier': false == true`).
- **Usulan Arah Perbaikan:**
  Periksa status aktif recurring plan: `if (entitlement.status === 'active' && (entitlement.current_plan === 'pro' || entitlement.current_plan === 'vip')) return true;`.

---

### BUG-AL-01: `routeIntent` Menggunakan Regex Case-Insensitive `/^[A-Z]{1,5}$/i` Mengalihkan Sapaan Singkat Menjadi `ticker_only` ("HALO terdeteksi")
- **File & Baris:** `lib/analyze-legacy.js:387-404`
- **Kutipan Kode:**
  ```javascript
  // If, after stripping enrichment, the user's actual text is just a ticker
  // symbol (1-5 uppercase letters) or an index alias, treat as ticker_only
  // (which lets the deterministic template fire). Never a follow-up.
  var bareTickerOnly = /^[A-Z]{1,5}$/i.test(msg) || /^(IHSG|JKSE|JCI|COMPOSITE)$/i.test(msg);
  // ...
  if (bareTickerOnly) {
    return 'ticker_only';
  }
  ```
- **Dampak ke User:**
  Setiap kata sapaan atau instruksi umum beranggotakan 1-5 karakter (misalnya "halo", "hai", "pagi", "oke", "siap", "beli", "cut") lolos regex `/^[A-Z]{1,5}$/i` dan dianggap sebagai ticker saham. Akibatnya intent casual chat terpotong, dan bot menjawab aneh: `"HALO terdeteksi. Harga sekarang berapa? Contoh: 'WMUU 58'"`.
- **Bukti Test Nyata:**
  `node --test test/analyze-legacy-bugs.test.js`
  Hasil: `Greeting "halo" must not be routed to ticker_only` gagal (`AssertionError [ERR_ASSERTION]: 'Greeting "halo" must not be routed to ticker_only': 'ticker_only' !== 'ticker_only'`).
- **Usulan Arah Perbaikan:**
  Hapus flag `/i` agar ticker murni kapital atau periksa kata-kata umum / sapaan sebelum mencocokkan ticker.

---

### BUG-AL-02: `buildStockFixedTemplate` Tidak Memetakan Field `prevClose` dari `parseMarketDataFromMessage` ke `deriveCandlePotentialRange` Sehingga ARA/ARB Selalu "Belum tersedia"
- **File & Baris:** `lib/analyze-legacy.js:664-672`
- **Kutipan Kode:**
  ```javascript
  var execReality = _idxTick.deriveCandlePotentialRange({
    previousClose: d.previousClose,
    previous_close: d.previous_close,
    prev_close: d.prev_close,
    prior_close: d.prior_close,
    close_prev: d.close_prev,
    current_price: d.last || d.close || d.currentPrice,
    // ...
  });
  ```
- **Dampak ke User:**
  Fungsi `parseMarketDataFromMessage` mengekstrak data harga penutupan sebelumnya ke field `prevClose`. Saat `buildStockFixedTemplate` memanggil `deriveCandlePotentialRange`, field yang dioper adalah `previousClose` (dengan 'ious') dan snake_case lainnya, sedangkan `d.prevClose` diabaikan. Akibatnya `previousClose` selalu undefined, dan kartu kalkulasi ARA/ARB selalu gagal terhitung dengan output `"ARA/ARB: Belum tersedia"`.
- **Bukti Test Nyata:**
  `node --test test/analyze-legacy-bugs.test.js`
  Hasil: `ARA/ARB should be computed when prevClose is present in market data` gagal (`AssertionError [ERR_ASSERTION]: 'ARA/ARB should be computed when prevClose is present in market data': false == true`).
- **Usulan Arah Perbaikan:**
  Tambahkan pemetaan properti `d.prevClose`: `previousClose: d.previousClose || d.prevClose`.

---

### BUG-CR4-01: `stockContext` Menolak Simbol Indeks Bertanda Caret (`^JKSE`) Sehingga AI Chat Analisis IHSG Menolak Snapshot Valid
- **File & Baris:** `lib/context-ai-router-v4.js:397-400`
- **Kutipan Kode:**
  ```javascript
  function stockContext(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const ticker = clean(input.ticker, 10).toUpperCase().replace(/\.JK$/i, '');
    // ...
    return {
      ticker: /^(IHSG|[A-Z]{3,5})$/.test(ticker) ? ticker : '',
  ```
- **Dampak ke User:**
  Simbol resmi Yahoo Finance dan feed market data IHSG adalah `^JKSE`. Karena ekspresi reguler `/^(IHSG|[A-Z]{3,5})$/` menolak karakter caret `^`, `ticker` dikosongkan menjadi string kosong `''`. Di baris 511, `handleContextAI` mengecek `!context.ticker` dan langsung menolak permintaan follow-up dengan HTTP 400 `AI_STOCK_SNAPSHOT_MISSING: "Jalankan analisis ticker terlebih dahulu..."` padahal snapshot analisis IHSG valid.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-v4-bugs.test.js`
  Hasil: `BUG-CR4-01: stockContext must support index ticker ^JKSE` gagal (`AssertionError: stockContext must accept ^JKSE but got ""`).
- **Usulan Arah Perbaikan:**
  Dukung format simbol indeks: `return /^(\^[A-Z]{4}|IHSG|[A-Z]{3,5})$/.test(ticker) ? ticker : '';`.

---

### BUG-CR4-02: `portfolioContext` Menghilangkan Field Standar Portofolio `stop_loss`, `sl`, dan `capital` Menjadi Null
- **File & Baris:** `lib/context-ai-router-v4.js:349-365`
- **Kutipan Kode:**
  ```javascript
  const plans = (Array.isArray(input.plans) ? input.plans : []).slice(0, 25).map((p) => {
    // ...
    return {
      ticker,
      entry: number(p.entryPriceIdr != null ? p.entryPriceIdr : p.entry),
      stop_loss: number(p.stopLossIdr != null ? p.stopLossIdr : p.stop),
      // ...
      capital: number(p.capitalIdr),
      position_status: clean(p.positionStatus || p.position_status, 40),
      source: clean(p.source, 30)
    };
  }).filter(Boolean);
  ```
- **Dampak ke User:**
  Model data portofolio dari Supabase dan store klien menggunakan field `stop_loss`, `sl`, dan `capital`. Pemetaan di `portfolioContext` hanya memeriksa `stopLossIdr` / `stop` dan `capitalIdr`. Akibatnya `stop_loss` dan `capital` selalu ter-resolve menjadi `null`. LLM menerima data tanpa batas risiko dan alokasi modal, lalu menjawab tidak mengetahui stop loss atau modal posisi pengguna.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-v4-bugs.test.js`
  Hasil: `BUG-CR4-02: portfolioContext must preserve standard fields stop_loss, sl, and capital` gagal (`AssertionError: plan.stop_loss must be 4500, got null`).
- **Usulan Arah Perbaikan:**
  Dukung alias standar:
  `stop_loss: number(p.stopLossIdr != null ? p.stopLossIdr : (p.stop_loss != null ? p.stop_loss : (p.sl != null ? p.sl : p.stop)))`
  `capital: number(p.capitalIdr != null ? p.capitalIdr : p.capital)`.

---

### BUG-CR5-01: `allPrimaryFailuresAreTemporary` Tidak Menduplikasi Array Model yang Dicoba Mengakibatkan Kegagalan 1 Model Tunggal Dianggap Sebagai Pemadaman Provider Penuh
- **File & Baris:** `lib/context-ai-router-v5.js:138-147`
- **Kutipan Kode:**
  ```javascript
  function allPrimaryFailuresAreTemporary(payload, trace) {
    if (!payload || payload.code !== 'AI_MODELS_FAILED_SAFE_STOP') return false;
    const attempted = Array.isArray(payload.attempted_models) ? payload.attempted_models.filter(Boolean) : [];
    if (attempted.length < 2) return false;
    const rows = trace && Array.isArray(trace.rejections) ? trace.rejections : [];
    return attempted.every((model) => {
      const matches = rows.filter((row) => row && row.model === model && row.provider_host === 'weizerouter.web.id');
      return matches.length > 0 && matches.every((row) => row.temporary_unavailable === true);
    });
  }
  ```
- **Dampak ke User:**
  Jika satu model (misal `wz/gpt-5.6-luna`) gagal dan dilakukan retry kompatibilitas parameter, `payload.attempted_models` memuat dua entri model yang sama (`['wz/gpt-5.6-luna', 'wz/gpt-5.6-luna']`). Karena fungsi tidak melakukan deduplikasi unik, `attempted.length < 2` lolos dan fungsi menyimpulkan bahwa seluruh model primer telah gagal serentak, lalu memicu emergency spillover atau penghentian paksa padahal model cadangan lainnya belum pernah dicoba sama sekali.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-v5-bugs.test.js`
  Hasil: `BUG-CR5-01: allPrimaryFailuresAreTemporary must require at least 2 distinct models` gagal (`AssertionError: allPrimaryFailuresAreTemporary must return false when only 1 distinct model was attempted: true == false`).
- **Usulan Arah Perbaikan:**
  Deduplikasi array model: `const attempted = dedupe(Array.isArray(payload.attempted_models) ? payload.attempted_models.filter(Boolean) : []);`.

---

### BUG-CR5-02: `redactDiagnostic` Mengabaikan Redaksi Kunci API Google Gemini (`AIza...`) Pada Log Diagnostik
- **File & Baris:** `lib/context-ai-router-v5.js:98-107`
- **Kutipan Kode:**
  ```javascript
  function redactDiagnostic(value) {
    return String(value == null ? '' : value)
      .replace(/Bearer\s+[A-Za-z0-9._~+\/=\-]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:wz|sk(?:-[A-Za-z0-9]+)*)-[A-Za-z0-9._\-]{8,}\b/g, '[REDACTED_KEY]')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_TOKEN]')
  ```
- **Dampak ke User:**
  Regex redaksi hanya mengantisipasi prefix OpenAI/Weize (`sk-`, `wz-`). Pesan error provider yang mencantumkan kunci Google Gemini pengguna (`AIzaSy...`) lolos dari redaksi dan tercetak mentah ke log server `console.warn`, mengekspos kredensial API key privat pengguna ke log produksi.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-v5-bugs.test.js`
  Hasil: `BUG-CR5-02: redactDiagnostic must redact Google Gemini API keys (AIza...)` gagal.
- **Usulan Arah Perbaikan:**
  Tambahkan pembersihan kunci Gemini: `.replace(/\b(?:AIza|AQ)[A-Za-z0-9_\-\.]{15,}\b/g, '[REDACTED_KEY]')`.

---

### BUG-CR6-01: `FALLBACK_CODES` Menghilangkan `AI_UNEXPECTED_ERROR` Sehingga Error 500 dari Provider Tidak Memicu Fallback Lokal
- **File & Baris:** `lib/context-ai-router-v6.js:18-29` & `lib/context-ai-router-v6.js:148-156`
- **Kutipan Kode:**
  ```javascript
  const FALLBACK_CODES = new Set([
    'AI_MODELS_FAILED_SAFE_STOP',
    'AI_ALL_MODELS_TIMED_OUT',
    'AI_PROVIDER_TEMPORARILY_UNAVAILABLE',
    'AI_RECENT_FAILURE',
    'AI_TIMEOUT_NO_RETRY',
    'AI_REQUEST_ERROR'
  ]);
  // ...
  function shouldUseLocalFallback(req, statusCode, payload) {
    // ...
    const code = payload && payload.code;
    return !code || FALLBACK_CODES.has(code);
  }
  ```
- **Dampak ke User:**
  Bila upstream router (V4/V5) menangkap exception jaringan atau provider crash pada blok `catch`, router mengembalikan status HTTP 500 dengan `code: 'AI_UNEXPECTED_ERROR'`. Karena kode ini tidak didaftarkan dalam `FALLBACK_CODES`, `shouldUseLocalFallback` menghasilkan `false`. Fallback lokal snapshot yang dirancang untuk menyelamatkan respons pengguna saat provider AI crash justru dibatalkan dan pengguna menerima galat 500 mentah.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-v6-bugs.test.js`
  Hasil: `BUG-CR6-01: shouldUseLocalFallback must support AI_UNEXPECTED_ERROR from upstream router` gagal (`AssertionError: shouldUseLocalFallback must return true for AI_UNEXPECTED_ERROR on status 500: false == true`).
- **Usulan Arah Perbaikan:**
  Tambahkan `'AI_UNEXPECTED_ERROR'` ke dalam `FALLBACK_CODES`.

---

### BUG-CR6-02: `extractSnapshotFacts` Menangkap Angka '2' dari `Entry 2` Sebagai Nilai `entry` (Rp 2) Saat Entry 1 Tidak Ditemukan
- **File & Baris:** `lib/context-ai-router-v6.js:77-83`
- **Kutipan Kode:**
  ```javascript
  const priceToken = '([0-9][0-9.,]*(?:\\s*[–-]\\s*[0-9][0-9.,]*)?)';
  const make = (label) => new RegExp(label + '\\s*(?::|=)?\\s*' + priceToken, 'i');
  // ...
  entry: firstMatch(text, [
    make('entry\\s*\\/\\s*konfirmasi'), make('area\\s+entry'), make('entry\\s+zone'), make('entry\\s*1?'), make('konfirmasi')
  ]),
  ```
- **Dampak ke User:**
  Pola `make('entry\\s*1?')` menggunakan kuantifier opsional `1?`. Bila snapshot hanya memiliki baris `Entry 2: 4400` (atau format tanpa Entry 1 eksplisit), pola mencocokkan kata `Entry`, `1?` mencocokkan string kosong, dan angka `2` tertangkap oleh `priceToken` sebagai harga entry. Asisten lokal menjawab: *"BBRI: area entry/konfirmasi yang tercatat adalah 2."* Pengguna disarankan membeli saham di harga Rp 2.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-v6-bugs.test.js`
  Hasil: `BUG-CR6-02: extractSnapshotFacts must not capture "2" as entry level when Entry 2 is present` gagal (`AssertionError: facts.entry must not capture "2" from "Entry 2: 4400"`).
- **Usulan Arah Perbaikan:**
  Gunakan pemisah non-digit tegas sebelum kuantifier harga agar digit label entry 2 tidak tertangkap sebagai harga: `make('entry(?:\\s*1)?(?!\\s*2)')` atau `make('(?:area\\s+)?entry(?:\\s*1)?')`.

---

### BUG-CR7-01: `SAFETY_NET_GEMINI_MODEL` Bernilai Identik dengan `DEFAULT_GEMINI_MODEL` Menyebabkan Percobaan Fallback Ke-4 Tidak Pernah Dapat Berjalan
- **File & Baris:** `lib/context-ai-router-v7.js:527` & `lib/context-ai-router-v7.js:641`
- **Kutipan Kode:**
  ```javascript
  // Attempt 4 (Safety Net): Try stable modern flash if all previous failed
  const attempt4Timeout = !geminiResult ? nextGeminiTimeout(handlerStarted) : null;
  if (!geminiResult && attempt4Timeout != null && primaryModel !== SAFETY_NET_GEMINI_MODEL && fallbackModel !== SAFETY_NET_GEMINI_MODEL) {
  ```
- **Dampak ke User:**
  Di `lib/ai-gemini-provider.js:25`, `SAFETY_NET_GEMINI_MODEL` didefinisikan dengan fallback `DEFAULT_GEMINI_MODEL`. Tanpa konfigurasi env khusus, `primaryModel` dan `SAFETY_NET_GEMINI_MODEL` adalah string yang sama, sehingga kondisi `primaryModel !== SAFETY_NET_GEMINI_MODEL` selalu bernilai `false`. Akibatnya jaring pengaman fallback terakhir (Attempt 4) menjadi dead code dan tidak pernah dieksekusi saat model utama dan model cadangan mengalami kendala.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-bugs.test.js`
  Hasil: `SAFETY_NET_GEMINI_MODEL must not equal DEFAULT_GEMINI_MODEL by default to prevent dead Attempt 4 fallback` gagal (`AssertionError: SAFETY_NET_GEMINI_MODEL must be distinct from DEFAULT_GEMINI_MODEL`).
- **Usulan Arah Perbaikan:**
  Set model safety net default ke model stabil terpisah yang selalu berbeda dari `DEFAULT_GEMINI_MODEL` (misal `'gemini-2.0-flash'`).

---

### BUG-CR7-02: Kebocoran Data Sisa Kuota Pengguna Lain pada Respons Cache Analisis AI
- **File & Baris:** `lib/context-ai-router-v7.js:410-415` & `lib/context-ai-router-v7.js:672-684`
- **Kutipan Kode:**
  ```javascript
  // Saat menyimpan cache:
  payload.quota = { tier: req._aiQuota.tier, usedToday: updatedCount, ... };
  await setCachedAnalysis(Object.assign({}, cacheParams, { payloadResponse: payload, ttlSeconds: 4 * 3600 }));

  // Saat cache hit:
  return res.status(200).json(Object.assign({}, cached, {
    success: true,
    reply: cached.reply || cached.text,
    source: 'db_cache',
    cache_hit: true,
    token_saved: true
  }));
  ```
- **Dampak ke User:**
  Objek `payload.quota` milik pengguna A ikut disimpan ke database cache bersama hasil analisis. Saat pengguna B (atau pengguna A di sesi berbeda) menanyakan pertanyaan yang sama dan menghasilkan cache hit, sistem mengembalikan objek `quota` kadaluwarsa milik pengguna A (`usedToday` dan `remaining`). Kuota pengguna B tampak berkurang atau nol secara keliru dan metadata privat akun pengguna lain bocor.
- **Bukti Test Nyata:**
  `node --test test/context-ai-router-bugs.test.js`
  Hasil: `handleContextAIV7 cache hit must not leak previous user quota in response payload` gagal (`AssertionError: Cached quota should not overwrite live User B quota: 0 !== 0`).
- **Usulan Arah Perbaikan:**
  Hapus properti `cached.quota` saat merakit respons cache hit atau gantikan secara dinamis dengan kuota aktual `req._aiQuota`.

---

### BUG-ANL-01: `transientSimulation(undefined)` Mengembalikan Objek Aktif `{ label: 'SIMULASI' }` yang Memaksa Mode Simulasi Aktif pada Seluruh Percakapan Portofolio Normal
- **File & Baris:** `api/analyze.js:100-111`
- **Kutipan Kode:**
  ```javascript
  function transientSimulation(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const output = {
      label: String(input.label || 'SIMULASI').slice(0, 40),
      available_funds_idr: availableFunds != null && availableFunds > 0 ? availableFunds : null,
      add_lots: addLots != null && addLots > 0 ? addLots : null,
      setup_still_valid: ...
    };
    return Object.values(output).some((value) => value !== null && value !== '') ? output : null;
  }
  ```
- **Dampak ke User:**
  Karena properti `output.label` selalu bernilai default `'SIMULASI'` (bukan null dan bukan string kosong), evaluasi `Object.values(output).some(...)` selalu bernilai `true` meskipun pemanggil tidak mengirimkan parameter simulasi apapun. Objek `context.simulation` palsu selalu terpasang pada setiap sesi chat portofolio, memicu `planFacts` menghasilkan data kalkulasi simulasi kosong (`facts.simulation`) dan membingungkan model AI.
- **Bukti Test Nyata:**
  `node --test test/analyze-api-bugs.test.js`
  Hasil: `transientSimulation(undefined) must return null when no simulation parameters are provided` gagal (`AssertionError: transientSimulation(undefined) must return null: { label: 'SIMULASI', ... } == null`).
- **Usulan Arah Perbaikan:**
  Kembalikan `null` di awal jika argumen `raw` bernilai falsy, atau periksa kelayakan simulasi hanya dari keberadaan dana/lot: `if (!raw || (!output.available_funds_idr && !output.add_lots)) return null;`.

---

### BUG-SH-01: Logika Keputusan AI Confirmation Mengabaikan Status `REJECT` untuk Kandidat Non-`Swing Ready`
- **File & Baris:** `api/sector-hot.js:771-778`
- **Kutipan Kode:**
  ```javascript
  // Downgrade if AI rejects
  if (r.ai_status === 'REJECT' && r.status === 'Swing Ready') {
    r.final_status = 'Watchlist';
  } else if (r.ai_status === 'CAUTION' && r.status === 'Swing Ready') {
    r.final_status = r.status;
  } else {
    r.final_status = r.status;
  }
  ```
- **Dampak ke User:**
  Kandidat saham berstatus `Rebound Speculative` dan `Watchlist` juga dikirimkan ke model AI untuk divalidasi. Namun jika model AI mengembalikan evaluasi `REJECT` (karena adanya risiko distribusi berat atau pelemahan struktur), blok `else` mempertahankan status awal `r.final_status = r.status`. Penolakan AI diabaikan 100%, dan saham berbahaya tetap direkomendasikan kepada user sebagai `Rebound Speculative`.
- **Bukti Test Nyata:**
  `node --test test/analyze-api-bugs.test.js`
  Hasil: `AI Confirmation in sector-hot must downgrade Rebound Speculative and Watchlist upon AI REJECT` gagal (`AssertionError: AI REJECT on Rebound Speculative should downgrade final_status: 'Rebound Speculative' !== 'Rebound Speculative'`).
- **Usulan Arah Perbaikan:**
  Turunkan status kandidat non-`Swing Ready` saat AI REJECT: `if (r.ai_status === 'REJECT') { r.final_status = r.status === 'Swing Ready' ? 'Watchlist' : 'Invalid'; }`.

---

### BUG-SH-02: String Tanda Peringatan `ai_red_flags` Memuat Spasi Tak Tertrim Sehingga Gagal Dicocokkan oleh Operator Array PostgreSQL
- **File & Baris:** `api/sector-hot.js:1459-1469`
- **Kutipan Kode:**
  ```javascript
  var codes = parts.length >= 3 ? parts[2].trim().split(',').slice(0, 3) : [];
  // ...
  parsed.push({
    ticker: ticker,
    ai_status: aiStatus,
    ai_reason: aiReason,
    ai_red_flags: codes.filter(function(c) {
      var ct = c.trim();
      return ct === 'TREND_WEAK' || ct === 'RSI_LOW' || ct === 'RSI_HIGH' || ...;
    })
  });
  ```
- **Dampak ke User:**
  Pemotongan string `parts[2].split(',')` pada respons multi-kode (misal `"TREND_OK, RSI_LOW"`) menghasilkan elemen dengan spasi awal `" RSI_LOW"`. Filter array mengembalikan elemen asli yang belum di-trim ke `ai_red_flags`. Saat disimpan ke database sebagai array PostgreSQL (`'{" RSI_LOW"}'`), pencarian query menggunakan operator array `@> '{RSI_LOW}'` gagal mencocokkan data, sehingga peringatan bendera merah tidak dapat difilter di dashboard.
- **Bukti Test Nyata:**
  `node --test test/analyze-api-bugs.test.js`
  Hasil: `callAIConfirmation in sector-hot trims whitespace in ai_red_flags to avoid broken postgres array matching` gagal (`AssertionError: Red flags must be trimmed strings: [' RSI_LOW'] == ['RSI_LOW']`).
- **Usulan Arah Perbaikan:**
  Map kode dengan trim sebelum filtering: `var codes = parts[2].split(',').map(function(c) { return c.trim(); }).slice(0, 3);`.

---

### BUG-CAS-01: `runChartAnalysis` Tidak Menyertakan Objek `quota` Pada Respons Cache Hit
- **File & Baris:** `lib/chart-analysis-service.js:377-385`
- **Kutipan Kode:**
  ```javascript
  if (!options.forceFresh) {
    const cached = await getCachedAnalysis(db, userId, safeTicker, wibDate);
    if (cached) {
      return {
        ok: true,
        status: 200,
        cached: true,
        data: cached
      };
    }
  }
  ```
- **Dampak ke User:**
  Ketika analisis chart disajikan dari cache lokal/database, properti `quota` tidak disertakan di objek pengembalian. Pada `handleChartAnalysisEndpoint`, respons JSON ke klien menghasilkan `quota: undefined`. Widget kuota di UI pengguna menjadi hilang atau menampilkan `undefined` kuota tersisa.
- **Bukti Test Nyata:**
  `node --test test/chart-analysis-bugs.test.js`
  Hasil: `Cached response must include quota information` gagal (`AssertionError: Cached response must include quota information`).
- **Usulan Arah Perbaikan:**
  Ambil `getUserUsage` dan sertakan objek `quota` (`usedToday`, `maxDaily`, `remaining`) juga pada cabang pengembalian `cached`.

---

### BUG-CAS-02: `runChartAnalysis` dan `getAnalysisStatus` Mengabaikan Rejection `USER_BLOCKED` dan Membuka Akses Eksekusi AI ke Pengguna Terblokir
- **File & Baris:** `lib/chart-analysis-service.js:308-327` & `lib/chart-analysis-service.js:352-371`
- **Kutipan Kode:**
  ```javascript
  let access = options.access || null;
  if (!access) {
    try { access = await resolvePremiumAccess(req, db); } catch (_) {}
  }
  if ((!access || !access.ok) && auth && auth.session) {
    const isAdm = auth.session.adm === true || auth.session.un === 'budi';
    const isPrem = isAdm || auth.premium === true;
    access = {
      ok: true,
      user: { id: auth.session.uid, username: auth.session.un, isAdmin: auth.session.adm === true }, ...
    };
  }
  ```
- **Dampak ke User:**
  Bila `resolvePremiumAccess` menolak user terblokir (`access.ok === false, status === 403`), blok `if ((!access || !access.ok) && auth && auth.session)` justru menganggapnya sebagai sesi gratis biasa dan memaksa `access.ok = true`. Akun yang diblokir oleh admin tetap dapat memeriksa status kuota dan mengeksekusi chart vision AI selama memiliki BYOK key.
- **Bukti Test Nyata:**
  `node --test test/chart-analysis-bugs.test.js`
  Hasil: `getAnalysisStatus must reject blocked user with ok: false` gagal (`AssertionError: false == true`).
- **Usulan Arah Perbaikan:**
  Periksa kode penolakan: jika `access && access.code === 'USER_BLOCKED'` atau `access.status === 403`, kembalikan penolakan 403 tersebut tanpa menimpanya.

---

### BUG-CAE-01: `handleChartAnalysisEndpoint` Mengabaikan Status Error pada `deleteUserApiKey` dan Selalu Mengembalikan Status Sukses 200
- **File & Baris:** `lib/chart-analysis-endpoint.js:63-70`
- **Kutipan Kode:**
  ```javascript
  // POST: delete user Gemini API key
  if (action === 'delete-key') {
    await deleteUserApiKey(db, userId, 'gemini');
    return res.status(200).json({
      success: true,
      message: 'API key Gemini berhasil dihapus.'
    });
  }
  ```
- **Dampak ke User:**
  Saat penghapusan personal BYOK API key gagal di level database (`deleteUserApiKey` mengembalikan `{ ok: false, error: ... }`), endpoint tidak memeriksa status hasil dan tetap mengembalikan HTTP 200 dengan pesan `"API key Gemini berhasil dihapus"`. Pengguna mengira kunci pribadi mereka sudah dihapus dari server, padahal masih tersimpan dan aktif.
- **Bukti Test Nyata:**
  `node --test test/chart-analysis-endpoint-bugs.test.js`
  Hasil: `BUG-CAE-01: handleChartAnalysisEndpoint must not return success 200 when deleteUserApiKey fails` gagal (`AssertionError: Endpoint should return error status when deleteUserApiKey fails, got 200`).
- **Usulan Arah Perbaikan:**
  Tampung hasil penghapusan dan periksa statusnya:
  ```javascript
  const delRes = await deleteUserApiKey(db, userId, 'gemini');
  if (!delRes || !delRes.ok) {
    return res.status(delRes && delRes.status || 400).json({ success: false, error: (delRes && delRes.error) || 'Gagal menghapus API key.' });
  }
  ```

---

### BUG-CAE-02: `handleChartAnalysisEndpoint` Membiarkan Mutating Action (`action=set-key`, `action=delete-key`, `action=analyze`) Berjalan pada HTTP GET
- **File & Baris:** `lib/chart-analysis-endpoint.js:28-39`
- **Kutipan Kode:**
  ```javascript
  // GET: status & quota info
  if (req.method === 'GET' || action === 'status') {
    const ticker = String(req.query && req.query.ticker || '').trim().toUpperCase();
    const statusResult = await getAnalysisStatus(req, db, ticker);
    return res.status(statusResult.status || 200).json(statusResult);
  }

  // Mutating requests must be POST
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }
  ```
- **Dampak ke User:**
  Karena kondisi `req.method === 'GET' || action === 'status'` menangkap seluruh permintaan `GET` tanpa memverifikasi parameter `action`, pemanggilan `GET /api/chart-analysis?action=set-key` atau `GET /api/chart-analysis?action=delete-key` tidak pernah mencapai baris validasi `req.method !== 'POST'`. Permintaan tersebut justru mengeksekusi `getAnalysisStatus` dan mengembalikan status 200 secara keliru alih-alih 405 Method Not Allowed.
- **Bukti Test Nyata:**
  `node --test test/chart-analysis-endpoint-bugs.test.js`
  Hasil: `BUG-CAE-02: handleChartAnalysisEndpoint must reject mutating action=set-key on GET with 405 Method Not Allowed` gagal (`AssertionError: Mutating GET ?action=set-key must return 405 Method Not Allowed, got 200`).
- **Usulan Arah Perbaikan:**
  Pisahkan rute:
  ```javascript
  if (action === 'status' || (!action && req.method === 'GET')) {
    if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method Not Allowed' });
    ...
  }
  ```

---

### BUG-CAP-01: `getChartAnalysisSystemPrompt` Merusak Akhiran `.JK` Menjadi `tickerJK` Bukan Membuang Suffix Bursa
- **File & Baris:** `lib/chart-analysis-prompt.js:40-41`
- **Kutipan Kode:**
  ```javascript
  function getChartAnalysisSystemPrompt(ticker) {
    const safeTicker = String(ticker || 'SAHAM').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return RAW_SYSTEM_PROMPT_TEMPLATE.replace(/\{TICKER\}/g, safeTicker);
  }
  ```
- **Dampak ke User:**
  Pada ekosistem BEI/Yahoo Finance, simbol saham menggunakan akhiran `.JK` (misal `BBCA.JK`). Regex `replace(/[^A-Z0-9]/g, '')` hanya menghapus tanda titik sehingga nama ticker menjadi `BBCAJK`. AI Vision menerima prompt `"gambar chart candlestick saham BBCAJK"` yang mengacaukan identifikasi entitas emiten di BEI.
- **Bukti Test Nyata:**
  `node --test test/chart-analysis-prompt-bugs.test.js`
  Hasil: `Prompt must not contain corrupted ticker "BBCAJK"` gagal.
- **Usulan Arah Perbaikan:**
  Hapus suffix `.JK` terlebih dahulu: `.replace(/\.JK$/i, '').replace(/[^A-Z0-9]/g, '')`.

---

### BUG-CAP-02: `getChartAnalysisSystemPrompt` Menghasilkan Ticker Kosong Saat Menerima Ticker Berisi Spasi atau Karakter Simbol
- **File & Baris:** `lib/chart-analysis-prompt.js:40-41`
- **Kutipan Kode:**
  ```javascript
  const safeTicker = String(ticker || 'SAHAM').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  ```
- **Dampak ke User:**
  Jika string berisi spasi (`'   '`) atau simbol (`'---'`) dioper ke fungsi, ekspresi `ticker || 'SAHAM'` tetap mengevaluasi string input karena string bukan string kosong (truthy). Setelah `trim()` dan `replace(/[^A-Z0-9]/g, '')`, hasilnya adalah string kosong `''`. Akibatnya prompt yang dikirim ke AI berbunyi `"gambar chart candlestick saham  di Bursa Efek Indonesia"` (ticker kosong).
- **Bukti Test Nyata:**
  `node --test test/chart-analysis-prompt-bugs.test.js`
  Hasil: `Prompt should fall back to "saham SAHAM di Bursa" on whitespace` gagal.
- **Usulan Arah Perbaikan:**
  Lakukan fallback setelah pembersihan regex: `const safeTicker = String(ticker || '').replace(/\.JK$/i, '').replace(/[^A-Z0-9]/g, '').trim() || 'SAHAM';`.

---

### BUG-AIT-01: `getAiTelemetryStats` Menghilangkan Properti CamelCase Alias `cacheHitRate` pada Objek Pengembalian
- **File & Baris:** `lib/ai-telemetry.js:46-59`
- **Kutipan Kode:**
  ```javascript
  return {
    total_requests: _stats.totalRequests,
    cache_hits: _stats.cacheHits,
    gemini_calls: _stats.geminiCalls,
    local_fallbacks: _stats.localFallbacks,
    average_latency_ms: avgLatencyMs,
    cache_hit_rate: cacheHitRate,
    // CamelCase aliases
    totalRequests: _stats.totalRequests,
    cacheHits: _stats.cacheHits,
    geminiCalls: _stats.geminiCalls,
    localFallbacks: _stats.localFallbacks,
    avgLatencyMs: avgLatencyMs,
    last_updated: new Date().toISOString()
  };
  ```
- **Dampak ke User:**
  Fungsi menghitung `const cacheHitRate = ...` dan mendokumentasikan blok `// CamelCase aliases` untuk kompatibilitas frontend/consumer JavaScript, namun melewatkan `cacheHitRate` (dan `lastUpdated`). Konsumen kode yang membaca `stats.cacheHitRate` mendapatkan nilai `undefined`, menyebabkan tampilan rasio efisiensi cache AI di dashboard monitoring kosong atau bernilai `NaN%`.
- **Bukti Test Nyata:**
  `node --test test/ai-telemetry-bugs.test.js`
  Hasil: `BUG-AIT-01: getAiTelemetryStats must include cacheHitRate in camelCase aliases` gagal (`AssertionError: stats.cacheHitRate must be defined as a number, got undefined`).
- **Usulan Arah Perbaikan:**
  Tambahkan `cacheHitRate` dan `lastUpdated` ke dalam blok alias camelCase: `cacheHitRate: cacheHitRate, lastUpdated: new Date().toISOString()`.

---

### BUG-AIT-02: `recordCacheHit` Tanpa `recordRequest` Menghasilkan Hit Rate Tidak Terikat (>100%) atau 0% Karena Tidak Menjaga Konsistensi `totalRequests`
- **File & Baris:** `lib/ai-telemetry.js:18-20` & `lib/ai-telemetry.js:38-40`
- **Kutipan Kode:**
  ```javascript
  function recordCacheHit() {
    _stats.cacheHits++;
  }
  // ...
  const cacheHitRate = _stats.totalRequests > 0
    ? Math.round((_stats.cacheHits / _stats.totalRequests) * 10000) / 10000
    : 0;
  ```
- **Dampak ke User:**
  Jika pemanggil mencatat event cache hit via `recordCacheHit()` tanpa terlebih dahulu memanggil `recordRequest()` (misalnya saat short-circuit cache di handler mandiri), `_stats.totalRequests` tetap 0 sehingga `cacheHitRate` dievaluasi menjadi 0 (0% efisiensi meskipun ada 100 hit). Bila `recordRequest` hanya dipanggil sebagian, rasio cache hit rate dapat melebihi 1.0 (>100%), merusak metrik telemetri operasional.
- **Bukti Test Nyata:**
  `node --test test/ai-telemetry-bugs.test.js`
  Hasil: `BUG-AIT-02: recordCacheHit must maintain consistent totalRequests or bound cache_hit_rate <= 1.0` gagal (`AssertionError: total_requests (0) must be at least cache_hits (1)`).
- **Usulan Arah Perbaikan:**
  Pastikan `recordCacheHit` otomatis meningkatkan `_stats.totalRequests++` bila `_stats.totalRequests < _stats.cacheHits`, atau batasi rasio maksimum `Math.min(1, ...)`.

---

### BUG-PAIR-01: `classifyFailure` pada Portfolio AI Runtime Menyamarkan Galat Kuota Habis (`QUOTA_EXCEEDED`) Menjadi Peringatan Rate Limit Sementara
- **File & Baris:** `public/portfolio-ai-runtime-v2.js:491-497`
- **Kutipan Kode:**
  ```javascript
  if (status === 429 || code === 'AI_RATE_LIMITED') {
    var wait = Number(data && data.retry_after_seconds);
    return {
      fallback: false,
      status: 'Terlalu banyak pertanyaan dalam waktu singkat.' + (Number.isFinite(wait) && wait > 0 ? ' Coba lagi sekitar ' + wait + ' detik lagi.' : ' Tunggu sebentar lalu coba lagi.')
    };
  }
  ```
- **Dampak ke User:**
  Ketika kuota harian pengguna habis, server mengembalikan status HTTP 429 dengan kode `QUOTA_EXCEEDED` dan pesan *"Batas kuota harian Anda telah tercapai (10/10)"*. Namun klien mengecek `status === 429` terlebih dahulu dan menampilkan pesan keliru: *"Terlalu banyak pertanyaan dalam waktu singkat. Tunggu sebentar lalu coba lagi."* Pengguna mengira hanya ada antrean sementara dan terus mencoba berulang kali padahal kuota hariannya telah habis.
- **Bukti Test Nyata:**
  `node --test test/ai-chat-renderer-bugs.test.js`
  Hasil: `classifyFailure must display quota exceeded error message instead of rate limit message` gagal (`AssertionError: 'Terlalu banyak pertanyaan...' == 'Batas kuota harian Anda telah tercapai...'`).
- **Usulan Arah Perbaikan:**
  Periksa `if (code === 'QUOTA_EXCEEDED')` sebelum blok pengecekan `status === 429`.

---

### BUG-SAI-01: `describeFailure` pada Stock Analysis AI Menyamarkan Galat Kuota Habis (`QUOTA_EXCEEDED`) Menjadi Peringatan Rate Limit Sementara
- **File & Baris:** `public/stock-analysis-ai.js:144-147`
- **Kutipan Kode:**
  ```javascript
  if (status === 429 || code === 'AI_RATE_LIMITED') {
    var wait = Number(data && data.retry_after_seconds);
    return { retryable: false, text: 'Terlalu banyak pertanyaan dalam waktu singkat.' + (Number.isFinite(wait) && wait > 0 ? ' Coba lagi sekitar ' + wait + ' detik lagi.' : ' Tunggu sebentar lalu coba lagi.') };
  }
  ```
- **Dampak ke User:**
  Sama seperti BUG-PAIR-01, modul follow-up chat Analisis Saham menutupi pesan `QUOTA_EXCEEDED` dengan kalimat rate-limit generik. Pengguna tidak menyadari kuota harian mereka habis.
- **Bukti Test Nyata:**
  `node --test test/ai-chat-renderer-bugs.test.js`
  Hasil: `describeFailure must display quota exceeded error message instead of rate limit message` gagal.
- **Usulan Arah Perbaikan:**
  Periksa `if (code === 'QUOTA_EXCEEDED') return { retryable: false, text: (data && data.error) || 'Batas kuota harian AI Anda telah tercapai.' };` sebelum pemeriksaan status 429.

---

### BUG-ACR-01: `normalizeSpacing` pada AI Chat Renderer Merusak Angka Desimal Tanpa Angka Nol di Depan Titik (`.382` Menjadi `. 382`)
- **File & Baris:** `public/ai-chat-renderer.js:72`
- **Kutipan Kode:**
  ```javascript
  .replace(/(^|[^0-9])\.([0-9])/g, '$1. $2')
  ```
- **Dampak ke User:**
  Regex pembersih spasi menyisipkan spasi setelah titik desimal pada angka seperti `.382` (Fibonacci) atau `.5%` (persentase risiko), mengubahnya menjadi `. 382` atau `. 5%`. Teks teknikal finansial yang dirender di layar menjadi terpotong dan tidak lazim dibaca.
- **Bukti Test Nyata:**
  `node --test test/ai-chat-renderer-bugs.test.js`
  Hasil: `Decimal without leading zero (.382) must not have space inserted` gagal.
- **Usulan Arah Perbaikan:**
  Pastikan karakter sebelum titik bukan tanda desimal angka atau ganti regex pemisah kalimat agar hanya menyisipkan spasi bila diikuti huruf kapital.
