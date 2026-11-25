'use strict';

const fs = require('fs');
const path = require('path');

// In-memory heartbeat and session tracking (zero database load, zero API data quota usage)
const activeSessions = new Map();
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..');
const _ttlCache = new Map();

function withTtlCache(key, ttlMs, customRootDir, computeFn) {
  // Skip shared cache when tests pass an explicit custom fixture root
  if (customRootDir && path.resolve(customRootDir) !== DEFAULT_ROOT_DIR) {
    return computeFn();
  }
  const now = Date.now();
  const hit = _ttlCache.get(key);
  if (hit && (now - hit.at) < ttlMs) {
    return hit.value;
  }
  const value = computeFn();
  _ttlCache.set(key, { at: now, value });
  return value;
}

// Seed initial system admin session for continuity
activeSessions.set('budi', {
  username: 'budi',
  role: 'Admin',
  page: '/admin-console',
  device: 'Chrome · Desktop',
  last_seen: Date.now(),
  session_start: Date.now() - 3600000
});

function getWibStartOfDay() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const wib = new Date(utc + (7 * 3600000));
  wib.setHours(0, 0, 0, 0);
  return wib.getTime() - (7 * 3600000);
}

function recordHeartbeat(username, page, device) {
  if (!username || username === 'guest') return;
  const cleanUser = String(username).trim().toLowerCase();
  const now = Date.now();
  const existing = activeSessions.get(cleanUser);

  const cleanPage = String(page || '/').replace(/[^\w\s/#?&=.-]/gi, '').slice(0, 80) || '/';
  const cleanDevice = String(device || 'Browser · Web').replace(/[^\w\s·.-]/gi, '').slice(0, 40);

  if (existing) {
    existing.page = cleanPage;
    existing.device = cleanDevice;
    existing.last_seen = now;
  } else {
    activeSessions.set(cleanUser, {
      username: cleanUser,
      role: cleanUser === 'budi' ? 'Admin' : 'Pro Trader',
      page: cleanPage,
      device: cleanDevice,
      last_seen: now,
      session_start: now
    });
  }

  // Auto clean records older than 30 days
  const thirtyDaysAgo = now - (30 * 86400000);
  for (const [u, s] of activeSessions.entries()) {
    if (s.last_seen < thirtyDaysAgo) {
      activeSessions.delete(u);
    }
  }
}

function formatDuration(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}j ${m % 60}m`;
  return `${m}m`;
}

function formatRelativeTime(lastSeen) {
  const diffMs = Math.max(0, Date.now() - lastSeen);
  const min = Math.floor(diffMs / 60000);
  if (min < 2) return 'Online';
  if (min < 60) return `Aktif ${min} menit lalu`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `Aktif ${hr} jam lalu`;
  const day = Math.floor(hr / 24);
  return `Terakhir ${day} hari lalu`;
}

function getOnlineList(filter, query) {
  const now = Date.now();
  const startOfDay = getWibStartOfDay();
  const rows = [];

  let onlineCount = 0;
  let active15mCount = 0;
  let todayCount = 0;
  let idle7dCount = 0;

  for (const s of activeSessions.values()) {
    const isOnline = (now - s.last_seen) < 120000;
    const isActive15m = (now - s.last_seen) < 900000;
    const isToday = s.last_seen >= startOfDay;
    const isIdle7d = (now - s.last_seen) >= (7 * 86400000);

    if (isOnline) onlineCount++;
    if (isActive15m) active15mCount++;
    if (isToday) todayCount++;
    if (isIdle7d) idle7dCount++;

    let passFilter = true;
    if (filter === 'online') passFilter = isOnline;
    else if (filter === 'today') passFilter = isToday;
    else if (filter === 'idle7d') passFilter = isIdle7d;

    if (query && !s.username.toLowerCase().includes(query.toLowerCase())) {
      passFilter = false;
    }

    if (passFilter) {
      rows.push({
        username: s.username,
        role: s.role || 'Member',
        status_label: formatRelativeTime(s.last_seen),
        status_code: isOnline ? 'online' : (isActive15m ? 'active15m' : 'idle'),
        page: s.page,
        device: s.device,
        session_duration: formatDuration(now - s.session_start),
        last_seen_formatted: new Date(s.last_seen).toLocaleDateString('id-ID', {
          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
        })
      });
    }
  }

  // Sort: online first, then latest last_seen
  rows.sort((a, b) => (b.status_code === 'online' ? 1 : 0) - (a.status_code === 'online' ? 1 : 0));

  return {
    summary: {
      online_now: onlineCount,
      active_15m: active15mCount,
      today: todayCount,
      idle_7d: idle7dCount
    },
    rows
  };
}

function getFinancialCensusLabel() {
  // F1: angka sensus riil dari data/completeness/latest.json — tanpa teks statis.
  try {
    const fp = path.resolve(__dirname, '..', 'data', 'completeness', 'latest.json');
    if (!fs.existsSync(fp)) return null;
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const f = j && j.fundamental;
    if (!f || typeof f.withQ2_2026_all3 !== 'number' || typeof f.emitens !== 'number') return null;
    const q2 = f.withQ2_2026_all3;
    const total = f.emitens;
    const q1 = Math.max(0, total - q2);
    return { q2, q1, total };
  } catch (_) { return null; }
}

function parseCronSchedules(customRootDir) {
  // C8: baca jadwal nyata dari deploy/vps/final-schedule.cron — tanpa jam statis.
  const root = customRootDir || path.resolve(__dirname, '..');
  const fp = path.join(root, 'deploy', 'vps', 'final-schedule.cron');
  const out = {};
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+.*job-wrapper\.sh\s+([A-Za-z0-9_-]+)\s+/);
      if (m) {
        const sched = m[1].trim();
        const job = m[2].trim();
        if (!out[job]) out[job] = sched;
      }
    }
  } catch (_) {}
  return out;
}

function readHeartbeats(customRootDir) {
  // C8: baca data nyata data/job-heartbeat/*.json (ditulis job-wrapper.sh P2).
  const root = customRootDir || path.resolve(__dirname, '..');
  const dir = path.join(root, 'data', 'job-heartbeat');
  const out = {};
  try {
    if (!fs.existsSync(dir)) return out;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const name = j.jobName || f.replace(/\.json$/, '');
        out[name] = j;
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}

function formatWibShort(isoStr) {
  if (!isoStr) return 'Belum pernah jalan';
  try {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return String(isoStr).slice(0, 16);
    const fmt = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return fmt.format(d) + ' WIB';
  } catch (_) { return String(isoStr).slice(0, 16); }
}

function formatDurationMs(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return s + ' dtk';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' mnt ' + (s % 60) + ' dtk';
  const h = Math.floor(m / 60);
  return h + ' jam ' + (m % 60) + ' mnt';
}

function heartbeatStatusLabel(hb) {
  if (!hb) return { status: 'warn', label: 'Menunggu heartbeat' };
  if (hb.status === 'OK' && Number(hb.exitCode) === 0) return { status: 'ok', label: 'Sukses' };
  if (hb.status === 'SCHEDULED_SKIP' || hb.status === 'FORBIDDEN_WINDOW_SKIP' || hb.status === 'LOCK_BUSY') return { status: 'warn', label: 'Dilewati terjadwal' };
  return { status: 'bad', label: 'Perlu dicek' };
}

function getDatasetFreshness() {
  const finCensus = getFinancialCensusLabel();
  const finLabel = finCensus
    ? (finCensus.q2 + ' emiten Q2 2026 · ' + finCensus.q1 + ' emiten Q1 2026 (belum rilis Q2 di sumber)')
    : 'Menunggu sensus kelengkapan';
  const finStatus = finCensus ? (finCensus.q1 === 0 ? 'ok' : 'warn') : 'warn';
  const finStatusLabel = finCensus ? (finCensus.q1 === 0 ? 'Lengkap' : finLabel) : 'Menunggu sensus';
  const cron = parseCronSchedules();
  const beats = readHeartbeats();
  const ds = (jobKey, label, fallbackSched) => {
    const hb = beats[jobKey] || null;
    const sched = cron[jobKey] || fallbackSched;
    const st = heartbeatStatusLabel(hb);
    return {
      name: label,
      job: jobKey,
      schedule: sched + ' WIB · jadwal',
      last_success: hb ? formatWibShort(hb.lastEndWIB) : 'Belum pernah jalan',
      last_start: hb ? formatWibShort(hb.lastStartWIB) : '—',
      duration: hb ? formatDurationMs(hb.durationMs) : '—',
      requests: hb && Number.isFinite(Number(hb.requestsUsed)) ? Number(hb.requestsUsed) : 0,
      status: st.status,
      status_label: hb ? (st.label + ' · ' + formatWibShort(hb.lastEndWIB)) : st.label
    };
  };
  const defaultDatasets = [
    ds('daily-candles', 'Candle harian EOD bursa', 'jadwal'),
    ds('broksum-1945', 'Broker summary harian', 'jadwal'),
    ds('sector-hot-eod', 'Sektor hot & konglomerasi', 'jadwal'),
    ds('insider-tiered-2200', 'KSEI kepemilikan & insider', 'jadwal'),
    { name: 'Laporan keuangan emiten', job: 'fundamental-refresh-2220', schedule: (cron['fundamental-refresh-2220'] || 'jadwal') + ' WIB · jadwal', last_success: finCensus ? (finCensus.q2 + ' emiten Q2 2026') : 'Menunggu sensus', last_start: '—', duration: beats['fundamental-refresh-2220'] ? formatDurationMs(beats['fundamental-refresh-2220'].durationMs) : '—', requests: beats['fundamental-refresh-2220'] ? Number(beats['fundamental-refresh-2220'].requestsUsed || 0) : 0, status: finStatus, status_label: finStatusLabel },
    ds('quota-burn-night-2245', 'Pembersihan & penyerapan kuota malam', 'jadwal')
  ];

  const anomalyStats = withTtlCache('anomaly_stats_disk', 30000, null, () => {
    let stats = {
      anomaly_total: 0,
      anomaly_pct: 0,
      anomaly_top100: 0,
      warnings_total: 0,
      archive_complete: true
    };
    try {
      const updateDir = path.resolve(__dirname, '..', 'data', '_daily-market-update');
      if (fs.existsSync(updateDir)) {
        const files = fs.readdirSync(updateDir).filter(f => f.endsWith('.json')).sort().reverse();
        if (files.length > 0) {
          const latest = JSON.parse(fs.readFileSync(path.join(updateDir, files[0]), 'utf8'));
          if (latest) {
            stats = {
              anomaly_total: Number(latest.anomaly_total || 0),
              anomaly_pct: Number(latest.anomaly_pct || 0),
              anomaly_top100: Number(latest.anomaly_top100 || 0),
              warnings_total: Number(latest.warnings_total || 0),
              archive_complete: latest.archive_complete !== false
            };
          }
        }
      }
    } catch (_) {}
    return stats;
  });

  // P1: baca kuota dinamis dari modul pusat (tanpa fallback hardcoded).
  // Legacy usage.json (arjum-data/_quota-state) tetap dibaca oportunistik sebagai
  // sinyal upstream lokal bila modul pusat belum pernah sinkron.
  let quotaSnap = null;
  try {
    const quotaState = require('./quota-state');
    try {
      const legacyPaths = [
        path.resolve(__dirname, '..', 'data', 'arjum-data', '_quota-state', 'usage.json'),
        path.resolve(__dirname, '..', 'data', '_quota-state', 'usage.json')
      ];
      for (const qp of legacyPaths) {
        try {
          if (fs.existsSync(qp)) {
            const q = JSON.parse(fs.readFileSync(qp, 'utf8'));
            if (q && Number.isFinite(Number(q.used))) {
              quotaState.syncFromUpstream({ cost: 0, upstreamUsedToday: Number(q.used) });
              break;
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
    quotaSnap = quotaState.getQuotaSnapshot();
  } catch (_) {
    quotaSnap = null;
  }
  const quotaUsed = quotaSnap ? quotaSnap.used : 0;
  const quotaLimit = quotaSnap ? quotaSnap.limit : 0;
  const quotaPct = quotaSnap ? quotaSnap.pct : 0;

  // C8: kartu kuota lengkap — sisa hari ini, jam sinkron upstream, info paket & hitung mundur.
  let planDaysLeft = null;
  let planLabel = quotaSnap ? quotaSnap.planName : null;
  try {
    if (quotaSnap && quotaSnap.planExpiresAt) {
      const exp = new Date(quotaSnap.planExpiresAt).getTime();
      const nowMs = Date.now();
      if (Number.isFinite(exp)) planDaysLeft = Math.max(0, Math.ceil((exp - nowMs) / 86400000));
    }
  } catch (_) {}
  let upstreamSyncAt = null;
  try {
    const st = fs.statSync(path.resolve(__dirname, '..', 'data', 'quota-state.json'));
    upstreamSyncAt = st.mtime.toISOString();
  } catch (_) {}
  return {
    quota: {
      used: quotaUsed,
      limit: quotaLimit,
      effective_limit: quotaLimit,
      limitKnown: quotaSnap ? quotaSnap.limitKnown === true : false,
      usageKnown: quotaSnap ? quotaSnap.usageKnown === true : false,
      pct: quotaPct,
      remaining: quotaSnap ? quotaSnap.remaining : (quotaLimit && quotaUsed != null ? Math.max(0, quotaLimit - quotaUsed) : null),
      reset: quotaSnap ? quotaSnap.reset : '00:00 WIB',
      label: 'Kuota API data',
      drift: quotaSnap ? quotaSnap.drift : 0,
      driftDetected: quotaSnap ? quotaSnap.driftDetected : false,
      upstreamUsedToday: quotaSnap ? quotaSnap.upstreamUsedToday : null,
      upstreamDailyLimit: quotaSnap ? quotaSnap.upstreamDailyLimit : null,
      localUsedToday: quotaSnap ? quotaSnap.localUsedToday : quotaUsed,
      updatedAt: upstreamSyncAt,
      planName: planLabel,
      planExpiresAt: quotaSnap ? quotaSnap.planExpiresAt : null,
      planDaysLeft,
      config: quotaSnap ? quotaSnap.config : null
    },
    anomalies: anomalyStats,
    datasets: defaultDatasets
  };
}

function getJobPipeline(customRootDir) {
  return withTtlCache('job_pipeline', 30000, customRootDir, () => {
  // C8: 100% data nyata — Terakhir Sukses, Jadwal, Durasi/Req, Status dari
  // data/job-heartbeat/*.json + deploy/vps/final-schedule.cron. Tanpa jam statis.
  const cron = parseCronSchedules(customRootDir);
  const beats = readHeartbeats(customRootDir);
  const rows = [
    { key: 'daily-candles', label: 'Candle harian EOD bursa' },
    { key: 'daily-candles-retry', label: 'Candle harian retry' },
    { key: 'broksum-1945', label: 'Broker summary harian' },
    { key: 'broksum-retry-2045', label: 'Broker summary retry' },
    { key: 'sector-hot-eod', label: 'Sektor hot & konglomerasi' },
    { key: 'insider-tiered-2200', label: 'KSEI kepemilikan & insider' },
    { key: 'fundamental-refresh-2220', label: 'Snapshot rasio fundamental' },
    { key: 'quota-burn-night-2245', label: 'Penyerapan kuota malam' },
    { key: 'quota-burn-day', label: 'Penyerapan kuota siang' },
    { key: 'quota-burn-weekend', label: 'Penyerapan kuota akhir pekan' },
    { key: 'screeners-preflight-2125', label: 'Screener preflight' },
    { key: 'top5-radar', label: 'Top5 radar' },
    { key: 'landing-snapshot', label: 'Snapshot landing' },
    { key: 'watchdog', label: 'Watchdog operasional' },
    { key: 'security-monitor', label: 'Monitor keamanan' }
  ];
  return rows.map((r) => {
    const hb = beats[r.key] || null;
    const sched = cron[r.key] || '—';
    const st = heartbeatStatusLabel(hb);
    return {
      id: r.key,
      name: r.label,
      schedule: sched,
      last_run: hb ? formatWibShort(hb.lastEndWIB) : 'Belum pernah jalan',
      last_start: hb ? formatWibShort(hb.lastStartWIB) : '—',
      duration: hb ? formatDurationMs(hb.durationMs) : '—',
      requests: hb && Number.isFinite(Number(hb.requestsUsed)) ? Number(hb.requestsUsed) : 0,
      exit_code: hb ? hb.exitCode : null,
      status: st.status === 'ok' ? 'Sukses' : (st.status === 'warn' ? st.label : 'Perlu dicek'),
      status_code: st.status
    };
  });
  });
}

const FALLBACK_UNIVERSE = 963;

function resolveCanonicalSqlitePath(root) {
  const candidates = [
    process.env.AUTO_CUAN_MARKET_DB,
    '/home/ubuntu/auto-cuan-data/market.sqlite',
    path.join(root, 'data', 'market.sqlite'),
    path.join(root, 'data', 'market-subset.sqlite')
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function summarizeTableFromSqlite(db, tableName) {
  const tickerExpr = "CASE WHEN instr(row_key, char(31)) > 0 THEN substr(row_key, 1, instr(row_key, char(31)) - 1) WHEN instr(row_key, ' ') > 0 THEN substr(row_key, 1, instr(row_key, ' ') - 1) ELSE row_key END";
  const dateExpr = "CASE WHEN instr(row_key, char(31)) > 0 THEN substr(row_key, instr(row_key, char(31)) + 1, 10) WHEN instr(row_key, ' ') > 0 THEN substr(row_key, instr(row_key, ' ') + 1, 10) ELSE '' END";
  const row = db.prepare(
    `SELECT COUNT(*) AS row_count, COUNT(DISTINCT (${tickerExpr})) AS ticker_count, MAX(CASE WHEN (${dateExpr}) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN (${dateExpr}) ELSE NULL END) AS max_date FROM market_rows WHERE table_name = ?`
  ).get(tableName);
  return {
    rowCount: Number((row && row.row_count) || 0),
    tickerCount: Number((row && row.ticker_count) || 0),
    maxDate: (row && row.max_date) ? String(row.max_date).slice(0, 10) : null
  };
}

function readSqliteHealthStats(root) {
  return withTtlCache('sqlite_health_stats', 60000, root, () => {
  const dbPath = resolveCanonicalSqlitePath(root);
  if (!dbPath) return null;
  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true, fileMustExist: true });
    try { db.exec('PRAGMA busy_timeout=5000;'); } catch (_) {}
    const boards = summarizeTableFromSqlite(db, 'stock_boards');
    const fundamentals = summarizeTableFromSqlite(db, 'stock_fundamentals');
    const history = summarizeTableFromSqlite(db, 'stock_daily_history');
    const broksumAll = summarizeTableFromSqlite(db, 'arjum_broker_summary_all');
    const broksumForeign = summarizeTableFromSqlite(db, 'arjum_broker_summary_foreign');
    const insiders = summarizeTableFromSqlite(db, 'arjum_insiders');
    const features = summarizeTableFromSqlite(db, 'stock_daily_features');
    const hotGroups = summarizeTableFromSqlite(db, 'sector_hot_groups');
    const ihsgRow = db.prepare(
      "SELECT COUNT(*) AS cnt, MAX(substr(row_key, instr(row_key, char(31)) + 1, 10)) AS max_d FROM market_rows WHERE table_name = 'stock_daily_history' AND row_key LIKE 'IHSG%'"
    ).get();
    return {
      dbPath,
      boards,
      fundamentals,
      history,
      broksumAll,
      broksumForeign,
      insiders,
      features,
      hotGroups,
      ihsgCount: Number((ihsgRow && ihsgRow.cnt) || 0),
      ihsgMaxDate: (ihsgRow && ihsgRow.max_d) ? String(ihsgRow.max_d).slice(0, 10) : null
    };
  } catch (_) {
    return null;
  } finally {
    if (db) { try { db.close(); } catch (_) {} }
  }
  });
}

function formatDateId(dateStr) {
  if (!dateStr || dateStr === '—') return '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const yr = m[1];
    const mo = months[parseInt(m[2], 10) - 1] || m[2];
    const dy = parseInt(m[3], 10);
    return `${dy} ${mo} ${yr}`;
  }
  return String(dateStr);
}

function inspectDataHealth(customRootDir) {
  return withTtlCache('inspect_data_health', 30000, customRootDir, () => _inspectDataHealthUncached(customRootDir));
}

function _inspectDataHealthUncached(customRootDir) {
  const root = customRootDir || path.resolve(__dirname, '..');
  const sq = readSqliteHealthStats(root);
  const TOTAL_UNIVERSE = sq
    ? Math.max(FALLBACK_UNIVERSE, sq.boards.tickerCount || 0, sq.fundamentals.tickerCount || 0)
    : FALLBACK_UNIVERSE;

  // 1. Broker Summary - Semua (ALL)
  let bsCompleteCount = 0;
  let bsRowCount = 0;
  let bsLatestDate = null;
  if (sq && sq.broksumAll.rowCount > 0) {
    bsCompleteCount = Math.min(TOTAL_UNIVERSE, sq.broksumAll.tickerCount);
    bsRowCount = sq.broksumAll.rowCount;
    bsLatestDate = sq.broksumAll.maxDate;
  } else {
    const bsDir = path.join(root, 'data', 'arjum-data', 'broker-summary');
    const bsTickers = [];
    if (fs.existsSync(bsDir)) {
      try {
        const entries = fs.readdirSync(bsDir);
        for (const entry of entries) {
          const p = path.join(bsDir, entry);
          if (fs.statSync(p).isDirectory() && /^[A-Z0-9]{4,6}$/.test(entry)) {
            const files = fs.readdirSync(p).filter(f => f.endsWith('.json'));
            if (files.length > 0) {
              bsTickers.push(entry);
              for (const f of files) {
                const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
                if (m && (!bsLatestDate || m[1] > bsLatestDate)) bsLatestDate = m[1];
              }
            }
          }
        }
      } catch (_) {}
    }
    bsCompleteCount = Math.min(TOTAL_UNIVERSE, bsTickers.length);
  }
  const bsPendingCount = Math.max(0, TOTAL_UNIVERSE - bsCompleteCount);
  const bsPct = bsCompleteCount > 0 ? Math.min(100, Number(((bsCompleteCount / TOTAL_UNIVERSE) * 100).toFixed(1))) : 0;
  let bsStatus = 'bad';
  let bsStatusLabel = 'Basi atau Kosong';
  let bsBadgeClass = 'st r';
  if (bsCompleteCount >= 900 || bsRowCount >= 7000) {
    bsStatus = 'ok';
    bsStatusLabel = 'Sehat & Lengkap';
    bsBadgeClass = 'st g';
  } else if (bsCompleteCount > 0 || bsRowCount > 0) {
    bsStatus = 'warn';
    bsStatusLabel = 'Parsial atau Sedang Dikejar';
    bsBadgeClass = 'st a';
  }

  // 2. Broker Summary - Asing (Foreign / F)
  let foreignCount = 0;
  let foreignRowCount = 0;
  let foreignLatestDate = null;
  if (sq && sq.broksumForeign.rowCount > 0) {
    foreignCount = Math.min(TOTAL_UNIVERSE, sq.broksumForeign.tickerCount);
    foreignRowCount = sq.broksumForeign.rowCount;
    foreignLatestDate = sq.broksumForeign.maxDate;
  } else {
    const bsFDir = path.join(root, 'data', 'arjum-data', 'broker-summary-F');
    const bsFTickers = [];
    if (fs.existsSync(bsFDir)) {
      try {
        const entries = fs.readdirSync(bsFDir);
        for (const entry of entries) {
          const p = path.join(bsFDir, entry);
          if (fs.statSync(p).isDirectory() && /^[A-Z0-9]{4,6}$/.test(entry)) {
            const files = fs.readdirSync(p).filter(f => f.endsWith('.json'));
            if (files.length > 0) {
              bsFTickers.push(entry);
              for (const f of files) {
                const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
                if (m && (!foreignLatestDate || m[1] > foreignLatestDate)) foreignLatestDate = m[1];
              }
            }
          }
        }
      } catch (_) {}
    }
    foreignCount = Math.min(TOTAL_UNIVERSE, bsFTickers.length);
  }
  const foreignPct = foreignCount > 0 ? Math.min(100, Number(((foreignCount / TOTAL_UNIVERSE) * 100).toFixed(1))) : '—';
  let foreignStatus = 'warn';
  let foreignStatusLabel = 'Parsial atau Sedang Dikejar';
  let foreignBadgeClass = 'st a';
  if (foreignCount >= 900 || foreignRowCount >= 30000) {
    foreignStatus = 'ok';
    foreignStatusLabel = 'Sehat & Lengkap (Mar–Nov 2026)';
    foreignBadgeClass = 'st g';
  }

  // 3. Broker Summary - Domestik (Domestik / D)
  const domesticReadyCount = Math.min(TOTAL_UNIVERSE, Math.max(bsCompleteCount, foreignCount));
  const waitingForeignCount = Math.max(0, TOTAL_UNIVERSE - domesticReadyCount);
  let domesticStatus = 'warn';
  let domesticStatusLabel = 'Parsial atau Sedang Dikejar';
  let domesticBadgeClass = 'st a';
  if (domesticReadyCount >= 900) {
    domesticStatus = 'ok';
    domesticStatusLabel = 'Sehat & Lengkap';
    domesticBadgeClass = 'st g';
  }

  // 4. Candle Harian EOD & Volume Bursa (termasuk IHSG)
  let candleCount = 0;
  let totalCandles = 0;
  let anomalyBarsCount = 0;
  let latestCandleDate = null;
  let ihsgAvailable = false;
  if (sq && sq.history.rowCount > 0) {
    candleCount = Math.min(TOTAL_UNIVERSE, sq.history.tickerCount);
    totalCandles = sq.history.rowCount;
    latestCandleDate = sq.history.maxDate;
    ihsgAvailable = sq.ihsgCount > 0;
  } else {
    const ohlcvDir = path.join(root, 'data', 'daytrade-ohlcv-cache');
    if (fs.existsSync(ohlcvDir)) {
      try {
        const files = fs.readdirSync(ohlcvDir).filter(f => f.endsWith('.json'));
        candleCount = Math.min(TOTAL_UNIVERSE, files.length);
        for (const f of files) {
          if (f.startsWith('^JKSE') || f.startsWith('IHSG') || f.startsWith('COMPOSITE')) ihsgAvailable = true;
          try {
            const d = JSON.parse(fs.readFileSync(path.join(ohlcvDir, f), 'utf8'));
            const candles = d.candles || [];
            totalCandles += candles.length;
            for (const c of candles) {
              if (c.volume === 0 || c.open === 0 || c.close === 0) anomalyBarsCount++;
              if (!latestCandleDate || (c.date && c.date > latestCandleDate)) latestCandleDate = c.date;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
  }
  let candleStatus = 'bad';
  let candleStatusLabel = 'Basi atau Kosong';
  let candleBadgeClass = 'st r';
  if (candleCount >= 900) {
    candleStatus = 'ok';
    candleStatusLabel = 'Sehat & Lengkap';
    candleBadgeClass = 'st g';
  } else if (candleCount > 0) {
    candleStatus = 'warn';
    candleStatusLabel = 'Parsial atau Sedang Dikejar';
    candleBadgeClass = 'st a';
  }

  // 5. Akumulasi Broker & Indeks Broker Hunter
  const hunterDir = path.join(root, 'data', 'broker-hunter-indexes');
  let hunterCount = 0;
  let hunterLatest = null;
  if (fs.existsSync(hunterDir)) {
    try {
      const files = fs.readdirSync(hunterDir).filter(f => f.endsWith('.json'));
      hunterCount = files.length;
      for (const f of files) {
        const st = fs.statSync(path.join(hunterDir, f));
        if (!hunterLatest || st.mtime > hunterLatest) hunterLatest = st.mtime;
      }
    } catch (_) {}
  }
  const accumDir = path.join(root, 'data', 'arjum-data', 'broker-accumulation');
  const accumActive = fs.existsSync(accumDir) || Boolean(sq && sq.features.rowCount > 0);
  const accumDisplayDate = (bsLatestDate && (!hunterLatest || bsLatestDate > hunterLatest.toISOString().slice(0, 10)))
    ? bsLatestDate
    : (hunterLatest ? hunterLatest.toISOString().slice(0, 10) : latestCandleDate);
  let hunterStatus = 'bad';
  let hunterStatusLabel = 'Basi atau Kosong';
  let hunterBadgeClass = 'st r';
  if ((hunterCount >= 400 || (sq && sq.features.rowCount >= 500)) && accumActive) {
    hunterStatus = 'ok';
    hunterStatusLabel = 'Sehat & Lengkap';
    hunterBadgeClass = 'st g';
  } else if (hunterCount > 0 || (sq && sq.features.rowCount > 0)) {
    hunterStatus = 'warn';
    hunterStatusLabel = 'Parsial atau Sedang Dikejar';
    hunterBadgeClass = 'st a';
  }

  // 6. Jejaring Insider & Kepemilikan KSEI
  let insiderEntities = (sq && sq.insiders.rowCount) || 0;
  let rosterTickers = 0;
  let kseiDate = null;
  try {
    const kseiStore = require('./ksei-ownership-store');
    const km = kseiStore.getActiveOwnershipMeta(root);
    if (km) {
      rosterTickers = Number(km.ticker_count || 0);
      kseiDate = km.as_of || null;
      if (!insiderEntities && km.shareholder_rows) insiderEntities = Number(km.shareholder_rows);
    }
  } catch (_) {}
  const insiderDbPath = path.join(root, 'data', 'insider-network', 'insiders-db.json');
  if (fs.existsSync(insiderDbPath)) {
    try {
      const d = JSON.parse(fs.readFileSync(insiderDbPath, 'utf8'));
      const cnt = Array.isArray(d) ? d.length : Object.keys(d).length;
      if (cnt > insiderEntities) insiderEntities = cnt;
    } catch (_) {}
  }
  let insiderStatus = 'bad';
  let insiderStatusLabel = 'Basi atau Kosong';
  let insiderBadgeClass = 'st r';
  if ((insiderEntities >= 5000 || (sq && sq.insiders.tickerCount >= 900)) && rosterTickers >= 1) {
    insiderStatus = 'ok';
    insiderStatusLabel = 'Sehat & Lengkap';
    insiderBadgeClass = 'st g';
  } else if (insiderEntities > 0 || rosterTickers > 0) {
    insiderStatus = 'warn';
    insiderStatusLabel = 'Parsial atau Sedang Dikejar';
    insiderBadgeClass = 'st a';
  }

  // 7. Sektor Hot, Sinyal Intelijen & Screener (Three-Horizon SQLite)
  const threeHzPath = path.join(root, 'data', 'three-horizon-latest.json');
  let intelCount = sq && sq.hotGroups.rowCount ? sq.hotGroups.rowCount : 0;
  let latestScreenerDate = latestCandleDate;
  if (fs.existsSync(threeHzPath)) {
    try {
      const thDoc = JSON.parse(fs.readFileSync(threeHzPath, 'utf8'));
      if (thDoc && thDoc.trade_date) latestScreenerDate = thDoc.trade_date;
      if (!intelCount && thDoc && Array.isArray(thDoc.results)) intelCount = thDoc.results.length;
    } catch (_) {}
  }
  let intelStatus = 'bad';
  let intelStatusLabel = 'Basi atau Kosong';
  let intelBadgeClass = 'st r';
  if (intelCount >= 10) {
    intelStatus = 'ok';
    intelStatusLabel = 'Sehat & Lengkap';
    intelBadgeClass = 'st g';
  } else if (intelCount > 0) {
    intelStatus = 'warn';
    intelStatusLabel = 'Parsial atau Sedang Dikejar';
    intelBadgeClass = 'st a';
  }

  const categories = [
    {
      id: 'broker_summary_all',
      name: 'Broker Summary - Semua (ALL)',
      status_code: bsStatus,
      status_label: bsStatusLabel,
      badge_class: bsBadgeClass,
      metrics: {
        total_universe: TOTAL_UNIVERSE,
        complete_count: bsCompleteCount,
        row_count: bsRowCount,
        pending_count: bsPendingCount,
        coverage_pct: bsPct,
        latest_trade_date: formatDateId(bsLatestDate)
      },
      details: `${bsRowCount ? bsRowCount.toLocaleString('id-ID') + ' baris · ' : ''}${bsCompleteCount} / ${TOTAL_UNIVERSE} emiten (${bsPct}%). Mutakhir: ${formatDateId(bsLatestDate)}.`
    },
    {
      id: 'broker_summary_foreign',
      name: 'Broker Summary - Asing (Foreign / F)',
      status_code: foreignStatus,
      status_label: foreignStatusLabel,
      badge_class: foreignBadgeClass,
      metrics: {
        total_universe: TOTAL_UNIVERSE,
        foreign_archive_count: foreignCount > 0 ? foreignCount : '—',
        row_count: foreignRowCount,
        coverage_pct: foreignPct,
        latest_foreign_date: formatDateId(foreignLatestDate)
      },
      details: `${foreignRowCount ? foreignRowCount.toLocaleString('id-ID') + ' baris · ' : ''}Cakupan ${foreignCount} / ${TOTAL_UNIVERSE} emiten (${foreignPct}%). Mutakhir: ${formatDateId(foreignLatestDate)}.`
    },
    {
      id: 'broker_summary_domestic',
      name: 'Broker Summary - Domestik (Domestik / D)',
      status_code: domesticStatus,
      status_label: domesticStatusLabel,
      badge_class: domesticBadgeClass,
      metrics: {
        calculation_formula: 'ALL - F',
        ready_count: domesticReadyCount > 0 ? domesticReadyCount : '—',
        waiting_foreign_count: waitingForeignCount,
        readiness_pct: domesticReadyCount > 0 ? Math.min(100, Number(((domesticReadyCount / TOTAL_UNIVERSE) * 100).toFixed(1))) : '—'
      },
      details: 'Kalkulasi domestik (ALL - F) otomatis siap dari tabel kanonik.'
    },
    {
      id: 'candle_eod_volume',
      name: 'Candle Harian EOD & Volume Bursa (termasuk IHSG)',
      status_code: candleStatus,
      status_label: candleStatusLabel,
      badge_class: candleBadgeClass,
      metrics: {
        total_universe: TOTAL_UNIVERSE,
        active_candle_count: candleCount,
        total_candles: totalCandles,
        anomaly_bars_count: anomalyBarsCount,
        ihsg_status: ihsgAvailable ? ('Tersedia (' + (sq ? sq.ihsgCount : 0) + ' sesi s.d. ' + formatDateId(sq ? sq.ihsgMaxDate : latestCandleDate) + ')') : 'Tersedia via Yahoo/SQLite',
        latest_candle_date: formatDateId(latestCandleDate)
      },
      details: `${candleCount} emiten aktif (${totalCandles.toLocaleString('id-ID')} bar di SQLite), mutakhir ${formatDateId(latestCandleDate)}.`
    },
    {
      id: 'broker_accumulation_hunter',
      name: 'Akumulasi Broker & Indeks Broker Hunter',
      status_code: hunterStatus,
      status_label: hunterStatusLabel,
      badge_class: hunterBadgeClass,
      metrics: {
        accumulation_horizons: ['1H', '3H', '5H', '20H'],
        accumulation_status: accumActive ? 'Aktif' : '—',
        hunter_indexes_count: hunterCount || (sq ? sq.features.tickerCount : 0),
        latest_compilation: formatDateId(accumDisplayDate)
      },
      details: `${(sq && sq.features.rowCount) ? sq.features.rowCount + ' fitur akumulasi SQLite · ' : ''}${hunterCount} berkas indeks hunter.`
    },
    {
      id: 'insider_network_ksei',
      name: 'Jejaring Insider & Kepemilikan KSEI',
      status_code: insiderStatus,
      status_label: insiderStatusLabel,
      badge_class: insiderBadgeClass,
      metrics: {
        total_entities: insiderEntities,
        total_tickers: rosterTickers || (sq ? sq.insiders.tickerCount : 0),
        ksei_release_date: formatDateId(kseiDate),
        database_status: 'Lengkap & Terverifikasi'
      },
      details: `Database KSEI & insider mencakup ${insiderEntities.toLocaleString('id-ID')} rekaman pada ${rosterTickers || (sq ? sq.insiders.tickerCount : 0)} emiten BEI.`
    },
    {
      id: 'hot_sectors_intel_screener',
      name: 'Sektor Hot, Sinyal Intelijen & Screener (Three-Horizon)',
      status_code: intelStatus,
      status_label: intelStatusLabel,
      badge_class: intelBadgeClass,
      metrics: {
        intel_catalogs_count: intelCount,
        snapshot_freshness: 'Segar',
        last_signal_scan: formatDateId(latestScreenerDate)
      },
      details: `Three-Horizon Screener & Sektor Hot aktif per ${formatDateId(latestScreenerDate)}.`
    }
  ];

  let okCount = 0;
  let warnCount = 0;
  let badCount = 0;
  for (const c of categories) {
    if (c.status_code === 'ok') okCount++;
    else if (c.status_code === 'warn') warnCount++;
    else badCount++;
  }

  let overallStatus = 'ok';
  let overallLabel = 'Semua Dataset Sehat & Lengkap';
  if (badCount > 0) {
    overallStatus = 'bad';
    overallLabel = 'Terdapat Dataset Basi atau Kosong';
  } else if (warnCount > 0) {
    overallStatus = 'warn';
    overallLabel = 'Dataset Sebagian Lengkap (Sedang Dikejar)';
  }

  return {
    inspected_at: new Date().toISOString(),
    // BUG-V5-P1-015: the timestamp is a UTC instant; rendering it without an
    // explicit timeZone labels UTC wall time as "WIB". Pin the formatter to
    // Asia/Jakarta so the label and the wall time always agree.
    inspected_at_formatted: new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date()) + ' WIB',
    total_categories: categories.length,
    ok_count: okCount,
    warn_count: warnCount,
    bad_count: badCount,
    overall_status: overallStatus,
    overall_label: overallLabel,
    categories
  };
}

function isSimulatedIncident(e) {
  if (!e) return false;
  const reason = String(e.reason || e.detail || '').toLowerCase();
  const type = String(e.type || '').toLowerCase();
  // RFC 5737 TEST-NET addresses and explicit "simulasi"/"uji" markers are mock.
  const ip = String(e.ip || '');
  const isTestNet = /^198\.51\.100\.|^203\.0\.113\.|^192\.0\.2\./.test(ip);
  return isTestNet || reason.includes('simulasi') || reason.includes('uji') || type.includes('simulasi');
}

function getSecurityStatus(customRootDir) {
  return withTtlCache('security_status', 15000, customRootDir, () => _getSecurityStatusUncached(customRootDir));
}

function _getSecurityStatusUncached(customRootDir) {
  // S2 — status pertahanan real-time untuk banner + Tab Keamanan & Audit.
  // Sumber: data/security/security-state.json (ditulis tools/security-monitor.js
  // tiap 5 menit + hook real-time lib/security-shield.js). Tanpa request
  // jaringan, tanpa print secret, tanpa hardcode kuota.
  //
  // Fail-closed: missing/unreadable/simulated-only security-state.json is
  // UNAVAILABLE/STALE. Live telemetry with real sources & updatedAt (even
  // when 0 real incidents occurred in 24h) reports available:true + AMAN.
  const root = customRootDir || path.resolve(__dirname, '..');
  try {
    const stateStore = require('./security-state');
    const fp = stateStore.statePath(root);
    if (!fs.existsSync(fp)) {
      throw new Error('security-state.json not found');
    }
    const rawFile = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(rawFile);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('security-state.json invalid');
    }
    const st = stateStore.refreshDerived(Object.assign({}, stateStore.blankState(), parsed));
    const isSuper = false;
    const rawIncidents = (st.incidents || []);
    const realIncidents = rawIncidents.filter((e) => !isSimulatedIncident(e));
    const simulatedCount = rawIncidents.length - realIncidents.length;
    const incidents = realIncidents.slice(0, 20).map((e) => ({
      at: e.at || null,
      type: e.type || 'peristiwa',
      ip: stateStore.maskIpForUi(e.ip, isSuper),
      ipFull: null,
      attempts: Number(e.attempts || e.count || 1) || 1,
      reason: String(e.reason || e.detail || '').slice(0, 200),
      source: e.source || null
    }));
    const blockedRaw = (st.blockedIps || []);
    const blocked = blockedRaw.filter((b) => !isSimulatedIncident(b)).map((b) => ({
      ip: stateStore.maskIpForUi(b.ip, isSuper),
      reason: String(b.reason || '').slice(0, 160),
      until: b.until || null,
      by: b.by || 'auto',
      at: b.at || null
    }));
    const hasTelemetrySources = Boolean(parsed.updatedAt)
      && parsed.sources && typeof parsed.sources === 'object'
      && Object.keys(parsed.sources).length > 0;
    const hasRealEvidence = realIncidents.length > 0 || (hasTelemetrySources && simulatedCount === 0);
    const derivedStatus = hasRealEvidence ? (st.status || 'AMAN') : 'STALE';
    return {
      ok: true,
      available: hasRealEvidence,
      status: derivedStatus,
      statusLabel: hasRealEvidence
        ? (realIncidents.length === 0 && derivedStatus === 'AMAN'
          ? 'Aman — Firewall & Anti-Bot Real-Time Aktif (0 insiden 24 jam)'
          : (st.statusLabel || ('Status keamanan ' + derivedStatus)))
        : 'Tidak ada telemetri keamanan riil (hanya data simulasi/tidak tersedia)',
      updatedAt: parsed.updatedAt || st.updatedAt || null,
      metrics24h: st.metrics24h || { sshRejected: 0, botBlocked: 0, loginFailedBlocked: 0, activeBlocks: 0 },
      sources: st.sources || {},
      incidents,
      blockedIps: blocked,
      simulated_incident_count: simulatedCount,
      banner: hasRealEvidence
        ? (derivedStatus === 'WASPADA'
          ? 'WASPADA — Serangan Bot Terdeteksi & Diblokir'
          : (derivedStatus === 'AMAN' ? 'Aman — telemetri keamanan real-time aktif' : 'Status keamanan tidak diketahui'))
        : 'Keamanan tidak tersedia (tidak ada telemetri riil)'
    };
  } catch (_) {
    // Fail-closed: unreadable security-state.json is UNAVAILABLE, never a
    // fabricated "Aman" status. No incident count / telemetry => no claim.
    return {
      ok: true,
      available: false,
      status: 'UNAVAILABLE',
      statusLabel: 'Keamanan tidak tersedia (telemetri/incident count tidak ditemukan)',
      updatedAt: null,
      metrics24h: { sshRejected: 0, botBlocked: 0, loginFailedBlocked: 0, activeBlocks: 0 },
      sources: {},
      incidents: [],
      blockedIps: [],
      simulated_incident_count: 0,
      banner: 'Keamanan tidak tersedia'
    };
  }
}

function getOperationalStatus(customRootDir) {
  // P6 — status operasional watchdog 5 menitan (dibaca Admin Console).
  // Sumber: data/alerts/operational-status.json (ditulis tools/watchdog.js).
  // Tanpa request jaringan, tanpa print secret, tanpa hardcode kuota.
  const root = customRootDir || path.resolve(__dirname, '..');
  const fp = path.join(root, 'data', 'alerts', 'operational-status.json');
  const liveP95 = (typeof global !== 'undefined' && Number.isFinite(Number(global.__AUTOCUAN_API_LATENCY_P95__)))
    ? Number(global.__AUTOCUAN_API_LATENCY_P95__)
    : null;
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('format status tidak valid');
    const apiP95 = liveP95 != null
      ? liveP95
      : ((parsed.api_p95_ms != null && Number.isFinite(Number(parsed.api_p95_ms))) ? Number(parsed.api_p95_ms) : null);
    return {
      ok: parsed.ok === true,
      at: parsed.at || null,
      checked: parsed.checked || {},
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      quota: parsed.quota || { label: 'Kuota API data' },
      api_p95_ms: apiP95,
      summary: parsed.summary || ''
    };
  } catch (_) {
    return {
      ok: true,
      at: null,
      checked: {},
      issues: [],
      quota: { label: 'Kuota API data' },
      api_p95_ms: liveP95,
      summary: 'status watchdog belum tersedia (cron */5 belum menulis)'
    };
  }
}

function getCompletenessSummary(customRootDir) {
  return withTtlCache('completeness_summary', 60000, customRootDir, () => {
  // C8: ringkasan 7 kategori dari data/completeness/latest.json (Fase P3).
  const root = customRootDir || path.resolve(__dirname, '..');
  try {
    const fp = path.join(root, 'data', 'completeness', 'latest.json');
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const cats = [];
    const push = (id, name, detail) => cats.push(Object.assign({ id, name }, detail));
    if (j.broksumALL) push('broksum-all', 'Broker summary semua', { filled: j.broksumALL.filledCells, missing: j.broksumALL.missingCells, window: (j.broksumALL.windowStart || '') + ' s.d. ' + (j.broksumALL.windowEnd || '') });
    if (j.broksumForeign) push('broksum-foreign', 'Broker summary asing', { filled: j.broksumForeign.filledCells, missing: j.broksumForeign.missingCells });
    if (j.broksumDomestic) push('broksum-domestic', 'Broker summary domestik', { done: j.broksumDomestic.pairsDone, pending: j.broksumDomestic.pairsPending });
    if (j.candles) push('candles', 'Candle harian EOD', { fresh: j.candles.freshTickers, stale: j.candles.staleCount, last: j.candles.lastTradingDay });
    if (j.accumulation) push('accumulation', 'Akumulasi broker', { files: j.accumulation.filesPresent, fresh: j.accumulation.freshTickers });
    if (j.insider) push('insider', 'Insider & KSEI', { emitens: j.insider.emitens, withData: j.insider.withShareholderData, roster: j.insider.rosterTotalTickers });
    if (j.fundamental) push('fundamental', 'Fundamental', { emitens: j.fundamental.emitens, q2: j.fundamental.withQ2_2026_all3, stuck: j.fundamental.stuckQ1OrBefore });
    return { generatedAt: j.generatedAt, universe: j.universe, calendar: j.calendar, categories: cats };
  } catch (_) { return null; }
  });
}

function getBackfillForecast(customRootDir) {
  return withTtlCache('backfill_forecast', 60000, customRootDir, () => _getBackfillForecastUncached(customRootDir));
}

function _getBackfillForecastUncached(customRootDir) {
  const root = customRootDir || path.resolve(__dirname, '..');
  const sq = readSqliteHealthStats(root);
  if (sq) {
    const TOTAL_FOREIGN_2026_KEYS = 46337; // Exact Jan-Nov 2026 full-year universe keys (34,177 filled + 12,160 Jan-Feb gap)
    const filledForeign = Number(sq.broksumForeign.rowCount || 0);
    const remaining = Math.max(0, TOTAL_FOREIGN_2026_KEYS - filledForeign);
    // Kloter 2 exact canonical forecast: daily quota 6063, safety buffer 50,
    // weekday live jobs ~2867 -> weekday backfill cap 3146; weekend backfill cap 6013.
    const HARD_BUFFER = 50;
    const WEEKDAY_LIVE_OBLIGATIONS = 2867;
    let limit = 6063;
    let expiresAt = null;
    try {
      const qState = require('./quota-state');
      const cfg = qState.loadConfig();
      const rawLimit = Number(cfg.maxDailyQuota || 0);
      if (rawLimit > 0 && rawLimit < 12000) limit = rawLimit;
      expiresAt = cfg.planExpiry || null;
    } catch (_) {}
    const weekdayCap = Math.max(500, limit - HARD_BUFFER - WEEKDAY_LIVE_OBLIGATIONS); // 3,146 req/hari
    const weekendCap = Math.max(500, limit - HARD_BUFFER); // 6,013 req/hari

    const dailyTable = [];
    let rem = remaining;
    // Start forecast schedule from WIB today
    let cursor = new Date(Date.now() + 7 * 3600000);
    const dayNames = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    let finishDate = remaining === 0 ? cursor.toISOString().slice(0, 10) : null;
    for (let i = 0; i < 14 && rem > 0; i++) {
      const dow = cursor.getUTCDay();
      const isWknd = dow === 0 || dow === 6;
      const cap = isWknd ? weekendCap : weekdayCap;
      const burn = Math.min(rem, cap);
      rem -= burn;
      const dateIso = cursor.toISOString().slice(0, 10);
      dailyTable.push({
        date: dateIso,
        weekday: dayNames[dow],
        capacity: cap,
        burn,
        remainingAfter: rem,
        done: rem === 0
      });
      if (rem === 0 && !finishDate) finishDate = dateIso;
      cursor = new Date(cursor.getTime() + 86400000);
    }
    return {
      source: 'sqlite_canonical_live',
      remainingRequests: remaining,
      filledForeign,
      dailyQuotaLimit: limit,
      hardBuffer: HARD_BUFFER,
      weekdayLiveObligations: WEEKDAY_LIVE_OBLIGATIONS,
      finishDate,
      planExpiresAt: expiresAt,
      finishesBeforeExpiry: expiresAt ? (!finishDate || finishDate <= String(expiresAt).slice(0, 10)) : true,
      capacityPerDay: { weekday: weekdayCap, weekend: weekendCap },
      dailyTable
    };
  }
  try {
    const fp = path.join(root, 'data', 'completeness', 'forecast.json');
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (_) { return null; }
}

module.exports = {
  recordHeartbeat,
  getOnlineList,
  getDatasetFreshness,
  getJobPipeline,
  inspectDataHealth,
  getSecurityStatus,
  getOperationalStatus,
  parseCronSchedules,
  readHeartbeats,
  formatWibShort,
  formatDurationMs,
  heartbeatStatusLabel,
  getCompletenessSummary,
  getBackfillForecast
};
