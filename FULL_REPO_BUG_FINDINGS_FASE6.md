# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 6 (Telegram & Notifikasi)
Dokumentasi temuan bug Fase 6. Read-only kode produksi, dibuktikan lewat failing unit test di test/.
Fokus khusus: Markdown/HTML entity escaping bursa, alert dedup saat volatilitas harga, queue handling saat rate limit 429.

---

### BUG-F6-001: Korupsi Kondisi Teknikal Akibat Regex Tag Stripping Naif dan Ketiadaan Escaping Entity
- **File**: `lib/telegram-notifier.js:490`, `lib/telegram-templates.js:77`
- **Severity**: CRITICAL
- **Kode Bermasalah**:
  ```javascript
  // lib/telegram-notifier.js
  function formatTelegramSafeText(text) {
    if (!text) return '';
    var clean = text.replace(/<[^>]*>/g, '');
    ...
  }

  // lib/telegram-templates.js
  function safe(value, fallback) {
    ...
    var s = String(value).replace(/[\r\n\t]+/g, ' ').replace(/<[^>]*>/g, '').replace(/\s{2,}/g, ' ').trim();
    ...
  }
  ```
- **Dampak**: Catatan teknikal trading yang mengandung tanda perbandingan `<` dan `>` (contoh: `Price < 1500 dan MA > 1200`) terpotong menjadi `Price  1200`. Data instruksi trading hilang atau terdistorsi bagi pengguna. Selain itu, template tidak meng-escape karakter `&`, `<`, `>` untuk HTML atau `.`, `-`, `+`, `_`, `(`, `)` untuk MarkdownV2, memicu HTTP 400 Bad Request jika parse_mode diaktifkan.
- **Bukti Uji**: `test/telegram-fase6-batch1-bugs.test.js` (Test 1 gagal: `Price  1200` !== `Price < 1500 dan MA > 1200`).
- **Usulan Perbaikan**: Ganti regex stripping naif dengan HTML parser/escaper kontekstual, dan sediakan fungsi escape karakter khusus resmi Telegram.

---

### BUG-F6-002: Notifikasi Exit/Take-Profit (`TP1_HIT`, `TP2_HIT`, `EARLY_EXIT_DISTRIBUTION`) Ditekan Cooldown Sinyal Beli
- **File**: `lib/telegram-notifier.js:52-62`
- **Severity**: CRITICAL
- **Kode Bermasalah**:
  ```javascript
  function isDrasticAlertStatusChange(prevStatus, nextStatus) {
    const prev = normalizeAlertStatus(prevStatus);
    const next = normalizeAlertStatus(nextStatus);
    if (!next || next === prev) return false;
    const wasNeutral = prev.includes('WATCHLIST') || prev.includes('RADAR') || prev.includes('PULLBACK') || prev.includes('SPECULATIVE');
    if (wasNeutral && isConfirmedBuyStatus(next)) return true;
    const isNowAvoid = next.includes('AVOID') || next.includes('SL_HIT') || next.includes('INVALID');
    const wasNormal = !prev.includes('AVOID') && !prev.includes('SL_HIT');
    return isNowAvoid && wasNormal;
  }
  ```
- **Dampak**: Jika sinyal awal saham adalah setup beli terkonfirmasi (`A_PLUS_SETUP`, `CONFIRMED`), lalu 3-10 menit kemudian harga melesat menyentuh target profit (`TP1_HIT`, `TP2_HIT`) atau terdeteksi distribusi masif (`EARLY_EXIT_DISTRIBUTION`), `isDrasticAlertStatusChange` mengembalikan `false`. Akibatnya, sinyal keluar krusial diblokir oleh cooldown 20 menit, menyebabkan pengguna tidak menerima instruksi profit taking atau penyelamatan modal.
- **Bukti Uji**: `test/telegram-fase6-batch1-bugs.test.js` (Test 2 gagal: `tp1Check.suppressed` bernilai `true`).
- **Usulan Perbaikan**: Masukkan status aksi kunci (`TP1_HIT`, `TP2_HIT`, `BEP_CLOSED`, `EARLY_EXIT_DISTRIBUTION`, `TRAILING_STOP`) ke dalam daftar bypass cooldown.

---

### BUG-F6-003: Pengabaian Respon HTTP 429 (Rate Limit) pada `sendTelegramPhoto`, `sendTelegramPhotoUrl`, dan `sendTelegramDocument`
- **File**: `lib/telegram-notifier.js:343-350, 415-422, 479-486`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  // sendTelegramPhoto / sendTelegramDocument
  if (!response.ok) {
    var errBody = '';
    try { errBody = await response.text(); } catch (readErr) { /* ignore */ }
    var errMsg = 'HTTP ' + response.status;
    if (errBody && errBody.length < 200) errMsg += ': ' + errBody;
    return { ok: false, sent: false, skipped: false, reason: 'api_error', status: response.status, error_message: errMsg };
  }
  ```
- **Dampak**: Jika pengiriman media chart/dokumen terkena batas rate-limit 429 Telegram, fungsi tidak memanggil `applyRateLimitBackoff` dan tidak membaca `retry_after`. Seluruh throttle gate tidak diparkir, menyebabkan antrean permintaan berikutnya terus menembak server Telegram dan memperparah pemblokiran bot.
- **Bukti Uji**: `test/telegram-fase6-batch1-bugs.test.js` (Test 3 gagal: `res.reason` bernilai `'api_error'` bukan `'rate_limited'`, `backoffActive` bernilai `false`).
- **Usulan Perbaikan**: Samakan penanganan status HTTP 429 pada seluruh fungsi pengiriman media agar memicu `applyRateLimitBackoff(retryAfter)` dan mengembalikan `reason: 'rate_limited'`.

---

### BUG-F6-004: Inversi Logika Antrean Menyebabkan Chunk Multipart Melewati Throttle Saat Backoff 429 Sedang Aktif
- **File**: `lib/telegram-notifier.js:281`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  // BATCH 10: serialize + space outbound sends (skip only while honoring a 429 backoff).
  if (i === 0 || throttleState.retryAfterUntil <= Date.now()) {
    await acquireSendSlot(options);
  }
  ```
- **Dampak**: Ketika `retryAfterUntil > Date.now()` (artinya bot sedang dalam masa hukuman rate limit 429), chunk ke-2 (`i > 0`) menghasilkan nilai kondisi `false || false` -> `false`. Akibatnya, `acquireSendSlot` dilewati secara langsung dan chunk ke-2 dikirim instan ke Telegram saat backoff sedang berlangsung, menjamin kegagalan pengiriman berulang.
- **Bukti Uji**: `test/telegram-fase6-batch1-bugs.test.js` (Test 4 gagal: `sleepCalled` bernilai `false`).
- **Usulan Perbaikan**: Perbaiki logika kondisi: saat backoff aktif, chunk lanjutan HARUS tetap mengantre dan menunggu slot backoff selesai.

---

### BUG-F6-005: Kegagalan Rate Limit 429 pada Pesan Chunked Dikunci Permanen Sebagai `DELIVERY_UNCERTAIN`
- **File**: `lib/telegram-delivery.js:68-87`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  if (chunksSent > 0) {
    return {
      state: 'delivery_uncertain',
      delivered: false,
      attempted: true,
      skipped: false,
      uncertain: true,
      retryable: false,
      permanent: false,
      partial: true,
      reason: reason || 'partial_delivery',
      status: status,
      chunks_sent: chunksSent,
      chunks_total: chunksTotal
    };
  }
  ```
- **Dampak**: Jika pesan sinyal berukuran besar terbagi menjadi 2 chunk, di mana chunk 1 berhasil namun chunk 2 terbentur HTTP 429, status diklasifikasikan sebagai `delivery_uncertain` dengan `retryable: false`. Di database, baris masuk ke `DELIVERY_UNCERTAIN`. Berdasarkan `rowBlocksRetry()`, status ini memblokir selamanya upaya pengiriman ulang, mengunci sinyal dan menggagalkan monitoring.
- **Bukti Uji**: `test/telegram-fase6-batch1-bugs.test.js` (Test 5 gagal: `classified.retryable` bernilai `false`).
- **Usulan Perbaikan**: Berikan pengecualian jika `status === 429` atau `reason === 'rate_limited'`, tandai sebagai `retryable: true` dengan state `retryable_failure`.

---

### BUG-F6-006: Rejection Prematur dan Notifikasi Salah pada `handleChatJoinRequest` untuk Akun yang Sudah Tergabung (`already_joined`)
- **File**: `lib/telegram-verification.js:587-595`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  const eligible = ctx.outcome === 'eligible' && inviteValid && !ctx.channelJoinedAt;

  if (!eligible) {
    try { await bot.declineChatJoinRequest(channelId, requesterId); } catch (e) { /* sanitized */ }
    if (ctx.telegramPrivateChatId != null) {
      try { await bot.sendMessage(ctx.telegramPrivateChatId, MSG.joinRequestDeclined); } catch (e) {}
    }
    return declineOutcomeCode(ctx, providedInviteLink, linkMatches);
  }
  ```
- **Dampak**: Jika webhook `chat_join_request` terkirim ganda atau pengguna mengetuk kembali link invite setelah permintaan pertama disetujui, `ctx.channelJoinedAt` sudah bernilai timestamp. Hal ini membuat `eligible` bernilai `false`. Akibatnya, sistem menolak permintaan via `declineChatJoinRequest` dan mengirim pesan penolakan `MSG.joinRequestDeclined` ("Permintaan bergabung tidak dapat disetujui"), serta mematikan blok penanganan idempotensi `confirm.outcome === 'already_joined'` di baris 629.
- **Bukti Uji**: `test/telegram-fase6-batch2-bugs.test.js` (Test 1 gagal: `declineCalled` bernilai `true`, pesan penolakan terkirim ke akun yang sah).
- **Usulan Perbaikan**: Tangani kondisi `ctx.channelJoinedAt` sebelum memeriksa `!eligible`. Bersihkan tombol inline keyboard tanpa memanggil decline atau mengirim pesan kegagalan.

---

### BUG-F6-007: Opsi Kritis `creates_join_request: true` Hilang dan Salah Nama Parameter Kadaluwarsa pada `createChatInviteLink`
- **File**: `lib/telegram-verification.js:527, 793-796`
- **Severity**: CRITICAL
- **Kode Bermasalah**:
  ```javascript
  // ensureJoinRequestInvite (line 527)
  link = await bot.createChatInviteLink(channelId, { expireSeconds: INVITE_TTL_SECONDS, name: INVITE_LINK_NAME });

  // deliverApprovalInvite (line 793)
  inviteLink = await bot.createChatInviteLink(channelId, {
    expireSeconds: INVITE_TTL_SECONDS,
    name: INVITE_LINK_NAME
  });
  ```
- **Dampak**: Arsitektur persetujuan Telegram mensyaratkan dynamic join request link. Karena opsi `{ creates_join_request: true }` tidak disertakan, Telegram secara default membuat link join langsung (direct membership). Pengguna dapat langsung masuk channel tanpa memicu webhook `chat_join_request`. Selain itu, Telegram API menggunakan parameter `expire_date` (Unix epoch seconds), bukan `expireSeconds`, sehingga masa berlaku link diabaikan Telegram dan menjadi aktif tanpa batas.
- **Bukti Uji**: `test/telegram-fase6-batch2-bugs.test.js` (Test 2 gagal: `creates_join_request` bernilai `undefined`).
- **Usulan Perbaikan**: Tambahkan `creates_join_request: true` dan konversi `expireSeconds` menjadi `expire_date: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS`.

---

### BUG-F6-008: Kegagalan Pengiriman Pesan pada `sendTransient` Mengakibatkan Hilangnya Pesan Permanen & `deletePrevious` Menghapus Tracking Saat Hapus Gagal
- **File**: `lib/telegram-transient-message.js:37-47, 56-59`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  // deletePrevious
  async function deletePrevious(db, sender, chatId, scope) {
    const previous = await previousMessageId(db, chatId, scope);
    if (!previous) return false;
    try {
      if (sender && typeof sender.deleteMessage === 'function') {
        await sender.deleteMessage(Number(chatId), previous);
      }
    } catch (_) {}
    await forget(db, chatId, scope);
    return true;
  }

  // sendTransient
  await deletePrevious(db, sender, chatId, scope);
  let sent = null;
  try { sent = await sender.sendMessage(chatId, opts.text, opts.extra); }
  catch (_) { return null; }
  ```
- **Dampak**: Pada `deletePrevious`, jika `deleteMessage` melempar error (misal rate limit Telegram 429 atau network timeout), `forget()` tetap dipanggil. Tracking di database terhapus padahal pesan fisik di Telegram masih ada, mengakibatkan pesan menjadi orphaned dan tidak pernah bisa dihapus lagi. Pada `sendTransient`, pesan lama dihapus sebelum pesan baru terkirim; jika `sendMessage` gagal, pengguna kehilangan pesan tanpa ada penggantinya.
- **Bukti Uji**: `test/telegram-fase6-batch2-bugs.test.js` (Test 3 gagal: record di DB terhapus saat `deleteMessage` throw error).
- **Usulan Perbaikan**: Panggil `forget()` hanya jika `deleteMessage` berhasil. Pada `sendTransient`, pastikan pesan baru terkirim sebelum menghapus referensi pesan lama.

---

### BUG-F6-009: Premature Claim Locking pada `sendLegacyChannelAnnouncement` Mengunci Pengumuman Permanen Tanpa Pengiriman Berhasil
- **File**: `lib/telegram-lifecycle.js:263-272`
- **Severity**: MEDIUM
- **Kode Bermasalah**:
  ```javascript
  let claim = { claimed: false };
  try { claim = await claimLegacyChannelAnnouncement(supabase, key); } catch (e) { return { status: 'error', reason: 'claim_failed' }; }
  if (!claim.claimed) return { status: 'duplicate', reason: 'already_announced' };

  try {
    await bot.sendMessage(channelId, buildLegacyAnnouncementMessage(), { reply_markup: legacyAnnouncementButton() });
    return { status: 'sent' };
  } catch (e) {
    return { status: 'failed', reason: 'send_failed' };
  }
  ```
- **Dampak**: RPC `claim_legacy_channel_announcement` langsung mengunci status pengumuman sebelum pesan dikirim. Ketika `bot.sendMessage` gagal (gangguan bot/jaringan/izin channel), fungsi mengembalikan `{ status: 'failed' }` namun guard di database sudah terlanjur tercatat. Pemanggilan ulang berikutnya selalu ditolak sebagai `{ status: 'duplicate' }`, memblokir pengumuman selamanya.
- **Bukti Uji**: `test/telegram-fase6-batch2-bugs.test.js` (Test 4 gagal: pemanggilan ulang menghasilkan `'duplicate'`).
- **Usulan Perbaikan**: Terapkan mekanisme two-phase commit atau rollback status klaim jika `bot.sendMessage` melempar kegagalan.

---

### BUG-F6-010: Inkonsistensi Filter Sinyal Terarsip Merusak Summary dan Jumlah Sinyal pada Daily Recap
- **File**: `lib/telegram-daily-recap.js:146-157`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  async function generateDailyAfternoonRecap(supabase, targetDate, options = {}) {
    const { date, picks } = await fetchPicksForRecap(supabase, targetDate);
    const message = formatDailyAfternoonRecapMessage(picks, date, options);
    const trackData = trackRecordService.buildTrackRecordData(picks);

    return {
      date,
      total_signals: (picks || []).length,
      summary: trackData.summary,
      by_category: trackData.by_category,
      message
    };
  }
  ```
- **Dampak**: `formatDailyAfternoonRecapMessage` mengecualikan sinyal terarsip (`history_archived_at` / `archived_at`), sedangkan `generateDailyAfternoonRecap` menyusun `total_signals` dan `summary` langsung dari data mentah `picks`. Hal ini menimbulkan inkonsistensi: teks notifikasi melaporkan jumlah sinyal bersih (misal 1), namun metadata API melaporkan sinyal terarsip/uji coba (misal 2), merusak rekapitulasi data performa bursa.
- **Bukti Uji**: `test/telegram-fase6-batch2-bugs.test.js` (Test 5 gagal: `recap.total_signals` bernilai 2 bukan 1).
- **Usulan Perbaikan**: Filter `picks` sebelum diproses ke `trackRecordService.buildTrackRecordData` dan penghitungan `total_signals`.

---

### BUG-F6-011: `isDrasticStatusChange` pada Webhook Alert Engine Mengabaikan dan Menekan Sinyal TP1, TP2, dan Distribusi Bandar
- **File**: `lib/webhook-alert-engine.js:85-107`
- **Severity**: CRITICAL
- **Kode Bermasalah**:
  ```javascript
  function isDrasticStatusChange(cachedEntry, candidate) {
    if (!cachedEntry) return false;
    const prevStatus = normalizeStatus(cachedEntry.status);
    const nextStatus = normalizeStatus(candidate.status || candidate.final_status);

    const wasNeutral = prevStatus.includes('WATCHLIST') || prevStatus.includes('RADAR') || prevStatus.includes('PULLBACK') || prevStatus.includes('SPECULATIVE');
    const isNowBuy = isConfirmedBuyStatus(nextStatus);
    if (wasNeutral && isNowBuy) {
      return true;
    }

    const isNowAvoid = nextStatus.includes('AVOID') || nextStatus.includes('SL_HIT') || nextStatus.includes('INVALID');
    const wasNormal = !prevStatus.includes('AVOID') && !prevStatus.includes('SL_HIT');
    if (isNowAvoid && wasNormal) {
      return true;
    }

    return false;
  }
  ```
- **Dampak**: Jika ticker sebelumnya memicu sinyal beli (`A_PLUS_SETUP`), lalu beberapa menit kemudian mencapai take profit (`TP1_HIT`, `TP2_HIT`) atau terdeteksi distribusi bandar (`EARLY_EXIT_DISTRIBUTION`), `isDrasticStatusChange` mengembalikan `false`. `checkCooldown` menganggap sinyal sebagai duplikat dan menekan pengiriman alert. Pengguna terlambat atau tidak pernah menerima notifikasi take-profit dan penyelamatan modal.
- **Bukti Uji**: `test/telegram-fase6-batch3-bugs.test.js` (Test 1 gagal: `tp1Check.shouldDrop` bernilai `true`, `distCheck.shouldDrop` bernilai `true`).
- **Usulan Perbaikan**: Sertakan `TP1_HIT`, `TP2_HIT`, `EARLY_EXIT_DISTRIBUTION`, `BEP_CLOSED`, dan `TRAILING_STOP` ke dalam status yang diizinkan mem-bypass cooldown.

---

### BUG-F6-012: Pengabaian Hard Market Gate pada `sendAlert` Saat `options.now` Tidak Disertakan Pemanggil
- **File**: `lib/webhook-alert-engine.js:533-543`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  const marketNow = options.now != null ? options.now : null;
  if (marketNow != null && isMarketSessionClosed(marketNow)) {
    return {
      success: false,
      skipped: true,
      reason: 'market_session_closed',
      ticker,
      channels: {}
    };
  }
  ```
- **Dampak**: Pada lingkungan produksi, pemanggil webhook rutin memanggil `sendAlert(candidate, options)` tanpa menyuntikkan `options.now`. Karena `marketNow` bernilai `null`, kondisi `marketNow != null` bernilai `false`, dan evaluasi sesi bursa dilewati total. Akibatnya, sinyal dapat terkirim di luar jam bursa (malam hari, akhir pekan, atau sesi istirahat siang).
- **Bukti Uji**: `test/telegram-fase6-batch3-bugs.test.js` (Test 2 gagal: saat market CLOSED, `sendAlert` tetap mencoba dispatch dan tidak mengembalikan `reason: 'market_session_closed'`).
- **Usulan Perbaikan**: Gunakan `const marketNow = options.now != null ? options.now : new Date()` agar evaluasi sesi bursa selalu aktif secara default.

---

### BUG-F6-013: Ketiadaan Pemotongan Chunk Pesan pada `dispatchTelegram` Memicu Error HTTP 400 Bad Request untuk Pesan Panjang
- **File**: `lib/webhook-alert-engine.js:429-438`
- **Severity**: HIGH
- **Kode Bermasalah**:
  ```javascript
  const url = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;
  const body = {
    chat_id: String(chatId).trim(),
    text,
    disable_web_page_preview: true
  };

  const response = await fetch(url, { ... });
  ```
- **Dampak**: Telegram membatasi panjang teks `sendMessage` maksimal 4096 karakter. Berbeda dengan `lib/telegram-notifier.js` yang memecah pesan via `splitTelegramMessage`, `webhook-alert-engine.js` mengirimkan `text` apa adanya. Bila kartu sinyal berisi detail teknikal yang panjang (>4096 karakter), permintaan langsung ditolak mentah-mentah oleh server Telegram dengan HTTP 400 Bad Request tanpa upaya pemecahan chunk.
- **Bukti Uji**: `test/telegram-fase6-batch3-bugs.test.js` (Test 3 gagal: teks berukuran 4500 karakter dikirim utuh dalam satu payload).
- **Usulan Perbaikan**: Integrasikan `splitTelegramMessage` pada `dispatchTelegram` atau delegasikan pengiriman Telegram melalui modul `telegram-notifier.js`.

---

### BUG-F6-014: `createChatInviteLink` Mengabaikan Parameter `expire_date` Unix Timestamp dan Mengunci Opsi `creates_join_request`
- **File**: `lib/telegram-verify-bot.js:154-167`
- **Severity**: MEDIUM
- **Kode Bermasalah**:
  ```javascript
  async function createChatInviteLink(chatId, options) {
    const ttl = (options && options.expireSeconds) || INVITE_TTL_SECONDS;
    let name = (options && typeof options.name === 'string' && options.name) ? options.name : INVITE_LINK_NAME;
    if (name.length > INVITE_NAME_MAX) name = name.slice(0, INVITE_NAME_MAX);
    const payload = {
      chat_id: chatId,
      expire_date: Math.floor(Date.now() / 1000) + ttl,
      creates_join_request: true,
      name: name
    };
    const result = await callTelegram('createChatInviteLink', payload);
    return result && result.invite_link ? result.invite_link : null;
  }
  ```
- **Dampak**: Jika pemanggil menyediakan parameter resmi Telegram Bot API `expire_date` (Unix timestamp), parameter tersebut diabaikan total karena kode secara kaku selalu menghitung ulang `expire_date = Math.floor(Date.now() / 1000) + ttl`. Selain itu, `creates_join_request: true` dipaksakan tanpa memedulikan nilai `options.creates_join_request`, sehingga fungsi tidak dapat digunakan untuk menghasilkan link undangan langsung saat diperlukan.
- **Bukti Uji**: `test/telegram-fase6-batch3-bugs.test.js` (Test 4 gagal: `expire_date` eksplisit diabaikan dan ditimpa, `creates_join_request: false` dipaksa menjadi `true`).
- **Usulan Perbaikan**: Utamakan `options.expire_date` jika tersedia, dan izinkan `creates_join_request` bernilai boolean sesuai opsi pemanggil.
