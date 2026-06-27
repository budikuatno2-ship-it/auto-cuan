'use strict';

const base = (process.env.AUTO_CUAN_BASE_URL || '').replace(/\/$/, '');
const secret = process.env.CRON_SECRET || '';
const start = process.env.AUTO_RUN_START || '09:10';
const end = process.env.AUTO_RUN_END || '15:40';
const interval = Number(process.env.AUTO_RUN_INTERVAL_MINUTES || 30);
const timeoutMs = 20000;
let timer;

function wib() { return new Date(Date.now() + 7 * 60 * 60 * 1000); }
function hmToMin(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }
function nowMin() { const d = wib(); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function ts() { return wib().toISOString().replace('T', ' ').slice(0, 19) + ' WIB'; }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

if (!base) throw new Error('AUTO_CUAN_BASE_URL is required');
if (!secret) throw new Error('CRON_SECRET is required');
if (!Number.isFinite(interval) || interval <= 0) throw new Error('AUTO_RUN_INTERVAL_MINUTES must be positive');

const startMin = hmToMin(start);
const endMin = hmToMin(end);
const url = `${base}/api/sector-hot?action=daytrade-screener-run`;

async function runOnce() {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  log(`Run start: ${url}`);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
      signal: controller.signal
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    const tg = data.telegram || {};
    log(`HTTP ${res.status} | success=${data.success === true} | published_count=${data.published_count ?? '-'} | selected_count=${tg.selected_count ?? '-'} | verified_count=${tg.verified_count ?? '-'} | high_conviction_count=${tg.high_conviction_count ?? '-'} | telegram=${tg.sent ? 'sent' : (tg.skipped ? 'skipped' : 'n/a')} reason=${tg.reason || '-'}`);
  } catch (e) {
    log(`Run failed: ${e.name === 'AbortError' ? 'request_timeout' : e.message}`);
  } finally {
    clearTimeout(t);
  }
}

function schedule() {
  if (nowMin() > endMin) return log(`Stop: market window closed after ${end} WIB.`);
  log(`Next run in ${interval} minutes.`);
  timer = setTimeout(async () => {
    if (nowMin() > endMin) return log(`Stop: market window closed after ${end} WIB.`);
    await runOnce();
    schedule();
  }, interval * 60 * 1000);
}

process.on('SIGINT', () => {
  if (timer) clearTimeout(timer);
  log('Manual shutdown requested. Runner stopped.');
  process.exit(0);
});

(async () => {
  log(`Day Trade auto runner started. Window ${start}-${end} WIB. Interval ${interval} minutes.`);
  if (nowMin() > endMin) return log(`No run executed. Market window already closed after ${end} WIB.`);
  if (nowMin() < startMin) return log(`Before market window. Start again after ${start} WIB.`);
  await runOnce();
  schedule();
})();
