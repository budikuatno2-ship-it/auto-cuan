'use strict';

/**
 * Landing Showcase Service
 *
 * Mengambil snapshot data nyata dari DB (akun review / data yang sudah ada) untuk
 * ditampilkan di landing page sebagai preview otentik — bukan data hardcoded.
 *
 * Data source:
 *   - Sektor paling aktif hari ini dari sector_hot_latest
 *   - Sinyal Day Trade terbaru dari telegram_daily_picks (max 3 ticker)
 *
 * Snapshot disimpan di tabel `kv_store` (key: 'landing_showcase_snapshot').
 * Tidak ada auto-refresh; hanya dipicu via CRON_SECRET (landing-snapshot-refresh).
 */

const KV_KEY = 'landing_showcase_snapshot';
const SNAPSHOT_STALE_MS = 48 * 60 * 60 * 1000; // 48 jam — very tolerant, data review tidak berubah cepat

/**
 * Baca snapshot dari kv_store.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<{ok: boolean, snapshot: object|null, stale: boolean, error?: string}>}
 */
async function getSnapshot(supabase) {
  try {
    const { data, error } = await supabase
      .from('kv_store')
      .select('value, updated_at')
      .eq('key', KV_KEY)
      .maybeSingle();

    if (error) {
      return { ok: false, snapshot: null, stale: true, error: 'DB read error' };
    }
    if (!data || !data.value) {
      return { ok: true, snapshot: null, stale: true };
    }

    let parsed;
    try {
      parsed = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
    } catch (_) {
      return { ok: false, snapshot: null, stale: true, error: 'Parse error' };
    }

    const ageMs = data.updated_at ? Date.now() - new Date(data.updated_at).getTime() : Infinity;
    return {
      ok: true,
      snapshot: parsed,
      stale: ageMs > SNAPSHOT_STALE_MS,
      updated_at: data.updated_at
    };
  } catch (e) {
    return { ok: false, snapshot: null, stale: true, error: 'Unexpected error' };
  }
}

/**
 * Bangun snapshot baru dari data DB yang sudah ada, lalu simpan ke kv_store.
 * Dipanggil manual via CRON_SECRET saja.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<{ok: boolean, snapshot: object|null, error?: string}>}
 */
async function refreshSnapshot(supabase) {
  try {
    // 1. Ambil sektor paling aktif (top 4 by score, atau change_pct terbesar)
    const { data: sectorRows } = await supabase
      .from('sector_hot_latest')
      .select('group_code, group_name, score, avg_change_pct, calculated_at')
      .order('score', { ascending: false })
      .limit(4);

    // 2. Ambil sinyal DT terbaru dari telegram_daily_picks (up to 3)
    // Ambil baris dengan created_at dalam 3 hari terakhir, ticker unik, bukan yang di-remove
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { data: dtPicks } = await supabase
      .from('telegram_daily_picks')
      .select('ticker, raw_payload, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(10);

    // De-duplicate by ticker, ambil yang paling baru
    const seenTickers = new Set();
    const topDt = [];
    for (const pick of (dtPicks || [])) {
      if (seenTickers.has(pick.ticker)) continue;
      seenTickers.add(pick.ticker);

      let payload = {};
      try {
        payload = typeof pick.raw_payload === 'string'
          ? JSON.parse(pick.raw_payload)
          : (pick.raw_payload || {});
      } catch (_) {}

      // Hanya tampilkan field yang aman untuk publik (tidak ada PII, tidak ada user data)
      topDt.push({
        ticker: pick.ticker,
        signal_type: payload.signal_type || payload.type || 'DT',
        entry: payload.entry || payload.entry_price || null,
        tp: payload.tp || payload.tp1 || payload.target || null,
        sl: payload.sl || payload.stop_loss || null,
        rr: payload.rr || payload.risk_reward || null,
        created_at: pick.created_at
      });

      if (topDt.length >= 3) break;
    }

    // 3. Bangun payload snapshot
    const sectors = (sectorRows || []).map(function(s) {
      return {
        code: s.group_code,
        name: s.group_name || s.group_code,
        score: typeof s.score === 'number' ? Math.round(s.score * 10) / 10 : null,
        avg_change_pct: typeof s.avg_change_pct === 'number'
          ? Math.round(s.avg_change_pct * 100) / 100
          : null
      };
    });

    const snapshot = {
      sectors: sectors,
      dt_signals: topDt,
      generated_at: new Date().toISOString(),
      source: 'review_data'
    };

    // 4. Simpan ke kv_store (upsert by key)
    const upsertResult = await supabase
      .from('kv_store')
      .upsert(
        { key: KV_KEY, value: JSON.stringify(snapshot), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );

    if (upsertResult.error) {
      // Kembalikan snapshot in-memory meskipun gagal simpan
      return { ok: false, snapshot: snapshot, error: 'DB write error: ' + upsertResult.error.message };
    }

    return { ok: true, snapshot: snapshot };
  } catch (e) {
    return { ok: false, snapshot: null, error: 'refreshSnapshot failed: ' + (e && e.message) };
  }
}

module.exports = { getSnapshot, refreshSnapshot, KV_KEY };
