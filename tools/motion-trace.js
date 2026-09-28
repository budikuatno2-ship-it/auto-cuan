#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 *  AUTO-CUAN — MOTION & USER-JOURNEY TRACE                (tools/motion-trace.js)
 * ============================================================================
 *  Jalankan : node tools/motion-trace.js
 *  Opsi     : --no-frames  lewati pass screenshot slow-mo (lebih cepat)
 *             --axe        jalankan axe-core juga  (npm i -D @axe-core/puppeteer)
 *             --canary     uji-diri: racuni token di DOM; skrip HARUS mendeteksinya
 *             --headful    tampilkan browser
 *  Env      : BASE_URL, CHROME_PATH, SPEC_FILE, OUT_DIR
 *  Output   : docs/motion-trace/<timestamp>/{trace.json, summary.txt, frames/*.png}
 *  Exit code: 0 = tidak ada FAIL | 1 = ada FAIL | 3 = canary gagal (skrip tidak
 *             membaca DOM hidup -> hasil audit TIDAK boleh dipercaya)
 *
 *  PRINSIP
 *    1. Target BUKAN diambil dari kode aplikasi. Sumbernya SPEC_FILE (kunci token
 *       motion) atau MASTER_SPEC di bawah (salinan dokumen master §2 & §6.1).
 *       Kalau keduanya beda, skrip mencetak WARN "spec-drift".
 *    2. Semua angka diukur dari DOM hidup: getComputedStyle + document.getAnimations().
 *    3. Tidak ada baris yang lulus tanpa syarat. Elemen tidak ditemukan = FAIL.
 *
 *  DUA PASS PER LANGKAH
 *    Pass A (kecepatan asli): sampler in-page berbasis requestAnimationFrame mencatat
 *      opacity/transform/rect di t = 0, 60, 120, 180, 260 ms (+ ekstra) dan
 *      inventaris animasi (durasi, easing, delay). INI YANG MENENTUKAN PASS/FAIL.
 *    Pass B (slow-mo 10x via CDP Animation.setPlaybackRate): screenshot per titik t.
 *      Hanya bukti visual. Timer JS tidak ikut diperlambat, jadi kalau frame Pass B
 *      tampak beda dari Pass A, percayai Pass A.
 *
 *  YANG TIDAK BISA DIBUKTIKAN SKRIP INI: jank GPU di perangkat nyata, persepsi
 *  pengguna, dan performa di bawah beban data live. Ukur itu terpisah.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

// ───────────────────────── konfigurasi ─────────────────────────
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SPEC_FILE = process.env.SPEC_FILE || path.resolve(__dirname, 'audit-spec-targets.json');
const OUT_ROOT = process.env.OUT_DIR || path.resolve(__dirname, '../docs/motion-trace');
const SAMPLE_TIMES = [0, 60, 120, 180, 260];
const SLOWMO_RATE = 0.1;
const TOL_MS = 50;
const SETTLE_MS = 600;
const ARGS = new Set(process.argv.slice(2));

const SB_SEL = '#appSidebar, #sidebar, .app-sidebar';
const ROUTES = [
  ['landing', '/preview/landing'], ['dashboard', '/preview/dashboard'],
  ['analisis-saham', '/preview/analisis-saham'], ['sektor-hot', '/preview/sektor-hot'],
  ['screener', '/preview/screener'], ['watchlist', '/preview/watchlist'],
  ['track-record', '/preview/track-record'], ['portofolio', '/preview/portofolio'],
  ['kelola-keuangan', '/preview/kelola-keuangan']
];
const VIEWPORTS = [[1440, 900], [1366, 768], [1280, 720]];

// Salinan dokumen master §2 & §6.1. JANGAN diubah tanpa mengubah dokumen master.
const MASTER_SPEC = {
  motion: {
    '--motion-instant': '100ms', '--motion-fast': '180ms', '--motion-base': '260ms', '--motion-slow': '420ms',
    '--ease-standard': 'cubic-bezier(0.4, 0, 0.2, 1)',
    '--ease-emphasized': 'cubic-bezier(0.16, 1, 0.3, 1)',
    '--ease-exit': 'cubic-bezier(0.4, 0, 1, 1)'
  },
  dark: {
    '--canvas': '#090D16', '--surface': '#10151F', '--surface-elevated': '#161C29',
    '--border-hairline': 'rgba(255,255,255,0.08)', '--text-primary': '#F4F6F8',
    '--text-secondary': '#9AA4B2', '--text-muted': '#626C7A', '--accent-primary': '#22C55E',
    '--accent-primary-hover': '#16A34A', '--data-positive': '#22C55E',
    '--data-negative': '#EF4444', '--data-neutral': '#F59E0B'
  },
  light: {
    '--canvas': '#F7F8FA', '--surface': '#FFFFFF', '--border-hairline': '#E5E7EB',
    '--text-primary': '#111827', '--text-secondary': '#4B5563', '--text-muted': '#9CA3AF',
    '--accent-primary': '#16A34A', '--data-positive': '#16A34A', '--data-negative': '#DC2626'
  },
  layout: { sidebarExpandedPx: 240, sidebarCollapsedPx: 72 }
};

// ───────────────────────── util murni (bisa dites) ─────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => String(s === undefined || s === null ? '' : s).replace(/\s+/g, '').toLowerCase();
const parseMs = v => {
  const s = String(v).trim();
  if (/ms$/i.test(s)) return parseFloat(s);
  if (/s$/i.test(s)) return parseFloat(s) * 1000;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
};
const overshoot = e => {
  const m = /cubic-bezier\(([^)]+)\)/i.exec(e || '');
  if (!m) return false;
  const p = m[1].split(',').map(Number);
  return p.length === 4 && (p[1] < 0 || p[1] > 1 || p[3] < 0 || p[3] > 1);
};
const identity = tf => {
  if (!tf || tf === 'none') return true;
  let m = /matrix3d\(([^)]+)\)/.exec(tf);
  if (m) { const p = m[1].split(',').map(Number); return Math.abs(p[0] - 1) < 0.001 && Math.abs(p[5] - 1) < 0.001 && Math.abs(p[12]) < 0.5 && Math.abs(p[13]) < 0.5; }
  m = /matrix\(([^)]+)\)/.exec(tf);
  if (!m) return false;
  const p = m[1].split(',').map(Number);
  return Math.abs(p[0] - 1) < 0.001 && Math.abs(p[3] - 1) < 0.001 && Math.abs(p[1]) < 0.001 && Math.abs(p[2]) < 0.001 && Math.abs(p[4]) < 0.5 && Math.abs(p[5]) < 0.5;
};
const fmtAnim = a => `${a.target} ${a.name} ${a.durationMs}ms ${a.easing}`;
const uniqSorted = arr => Array.from(new Set(arr)).sort((a, b) => a - b);
const isLight = t => !!t && (t.dataTheme === 'light' || /\blight\b/.test(t.className || ''));

function loadSpec() {
  const spec = JSON.parse(JSON.stringify(MASTER_SPEC));
  let source = 'BUILT-IN (salinan dokumen master §2 & §6.1)';
  if (fs.existsSync(SPEC_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8'));
      const found = {};
      (function walk(o) {
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
          if (Object.prototype.hasOwnProperty.call(spec.motion, k) && (typeof v === 'string' || typeof v === 'number')) found[k] = String(v);
          else walk(v);
        }
      })(j);
      const miss = Object.keys(spec.motion).filter(n => !(n in found));
      Object.assign(spec.motion, found);
      if (j.dark && typeof j.dark === 'object') Object.assign(spec.dark, j.dark);
      if (j.light && typeof j.light === 'object') Object.assign(spec.light, j.light);
      source = miss.length ? `${path.basename(SPEC_FILE)} (sebagian) + BUILT-IN untuk: ${miss.join(', ')}` : path.basename(SPEC_FILE);
    } catch (e) { console.warn('WARN: gagal membaca ' + SPEC_FILE + ': ' + e.message); }
  } else {
    console.warn('WARN: ' + SPEC_FILE + ' tidak ditemukan, memakai spek BUILT-IN');
  }
  return { spec, source };
}

function classify(finite, spec) {
  const durs = Object.entries(spec.motion).filter(([k]) => k.startsWith('--motion-')).map(([, v]) => parseMs(v));
  const eases = Object.entries(spec.motion).filter(([k]) => k.startsWith('--ease-')).map(([, v]) => strip(v));
  return {
    offDur: finite.filter(a => !durs.some(d => Math.abs(d - a.durationMs) < 0.5)),
    offEase: finite.filter(a => !eases.includes(strip(a.easing))),
    bounce: finite.filter(a => overshoot(a.easing))
  };
}
const hasPair = (finite, spec, dTok, eTok) =>
  finite.some(a => Math.abs(a.durationMs - parseMs(spec.motion[dTok])) < 0.5 && strip(a.easing) === strip(spec.motion[eTok]));

function staggerFromSeries(series, group) {
  const by = {};
  series.filter(p => p.key.startsWith(group + '[')).forEach(p => { (by[p.key] = by[p.key] || []).push(p); });
  const rows = Object.entries(by).map(([k, pts]) => {
    const first = pts[0];
    const up = pts.find(p => p.opacity >= 0.05);
    return { k, top: first.top, left: first.left, start: up ? up.t : undefined, hidden: first.opacity < 0.05, inView: pts.some(p => p.inView) };
  }).filter(r => r.hidden && r.start !== undefined && r.inView);
  if (rows.length < 2) return null;
  rows.sort((a, b) => a.top - b.top || a.left - b.left);
  const top0 = rows[0].top;
  const row = rows.filter(r => Math.abs(r.top - top0) <= 12).sort((a, b) => a.left - b.left);
  if (row.length < 2) return null;
  const diffs = [];
  for (let i = 1; i < row.length; i++) diffs.push(Math.round(row[i].start - row[i - 1].start));
  return { diffs, starts: row.map(r => Math.round(r.start)) };
}

// Evaluasi hasil Pass A satu langkah -> daftar {id,status,detail}. Tidak ada auto-pass.
function evaluateStep(step, A, spec) {
  const out = [];
  const add = (id, ok, detail, soft) => out.push({ id, status: ok ? 'PASS' : (soft ? 'WARN' : 'FAIL'), detail: detail || '' });
  if (!A || !A.fired || !A.fired.ok) { add('trigger', false, A && A.fired ? A.fired.reason : 'sampler tidak mengembalikan hasil'); return out; }
  add('trigger', true, A.fired.target);
  const ex = step.expect || {};
  const finite = (A.inventory || []).filter(a => !a.looping);
  const looping = (A.inventory || []).filter(a => a.looping);
  const cls = classify(finite, spec);

  if (ex.animated) add('ada motion', finite.length > 0, finite.length ? finite.length + ' animasi/transisi terdeteksi' : 'TIDAK ADA animasi: perpindahan instan', ex.animated === 'soft');
  add('durasi ∈ token', cls.offDur.length === 0, cls.offDur.length ? 'di luar token: ' + cls.offDur.map(fmtAnim).join(' | ') : finite.length + ' animasi, semua cocok');
  add('easing ∈ token', cls.offEase.length === 0, cls.offEase.length ? 'di luar token: ' + cls.offEase.map(fmtAnim).join(' | ') : 'semua cocok');
  add('tanpa overshoot/bounce', cls.bounce.length === 0, cls.bounce.map(fmtAnim).join(' | '));
  (ex.tokens || []).forEach(([d, e]) => add(`pakai pasangan ${d}+${e}`, hasPair(finite, spec, d, e),
    `spek ${spec.motion[d]} ${spec.motion[e]}; teramati: ${[...new Set(finite.map(a => a.durationMs + 'ms'))].join(',') || '-'}`));
  if (step.budgetMs !== undefined) add('settle ≤ anggaran', A.settleMs <= step.budgetMs + TOL_MS, `${A.settleMs}ms (anggaran ${step.budgetMs}ms +${TOL_MS})`);
  if (looping.length) add('animasi looping (info)', true, looping.map(a => a.target + ' ' + a.name).join(' | '), false);

  const by = {};
  (A.series || []).forEach(p => { (by[p.key] = by[p.key] || []).push(p); });
  const over1 = [], flick = [];
  Object.entries(by).forEach(([k, pts]) => {
    let reached = false;
    for (const p of pts) {
      if (p.opacity > 1.001) over1.push(k);
      if (ex.enter) { if (p.opacity >= 0.98) reached = true; else if (reached && p.opacity < 0.95) { flick.push(k + '@' + p.t + 'ms'); break; } }
    }
  });
  add('opacity tidak >1', over1.length === 0, over1.join(', '));
  if (ex.enter) add('tanpa kedip setelah tampil', flick.length === 0, flick.join(', '));

  if (ex.startsHidden && A.samples[0]) {
    const seen = A.samples[0].els.filter(e => e.key.startsWith(step.observe[0]) && e.inView && e.opacity > 0.1);
    add('mulai tersembunyi (sebelum reveal)', seen.length === 0, seen.length ? seen.map(e => e.key + ' opacity=' + e.opacity).join(', ') : '', true);
  }
  if (ex.endsVisible) {
    const bad = (A.final || []).filter(e => e.key.startsWith(step.observe[0]) && e.inView && (e.opacity < 0.99 || !identity(e.transform)));
    add('state akhir bersih (opacity 1, tanpa sisa transform)', bad.length === 0, bad.map(e => `${e.key} opacity=${e.opacity} transform=${e.transform}`).join(' | '));
  }
  if (ex.stagger) {
    const st = staggerFromSeries(A.series || [], ex.stagger.group);
    if (!st) add('stagger antar kartu', false, 'tidak cukup elemen terukur di satu baris', true);
    else {
      const avg = st.diffs.reduce((a, b) => a + b, 0) / st.diffs.length;
      const [lo, hi] = ex.stagger.expected;
      add('stagger antar kartu', avg >= 20, `selisih mulai ${st.diffs.join(', ')}ms (spek ${lo}–${hi}ms)` + (avg < 20 ? ' → muncul bersamaan' : ''));
      add('stagger dalam rentang spek', avg >= lo - 25 && avg <= hi + 25, `rata-rata ${Math.round(avg)}ms`, true);
    }
  }
  if (ex.noEmptyFlash) {
    const empty = A.samples.slice(1).filter(s => { const e = s.els.find(x => x.key.startsWith(ex.noEmptyFlash + '[')); return e && e.textLen === 0; });
    add('tanpa flash konten kosong', empty.length === 0, empty.map(s => 't=' + s.actual + 'ms').join(', '));
  }
  if (ex.stableWidth) {
    const ws = A.samples.map(s => { const e = s.els.find(x => x.key.startsWith(ex.stableWidth + '[')); return e ? e.rect.width : null; }).filter(w => w !== null);
    const d = ws.length ? Math.max(...ws) - Math.min(...ws) : 0;
    add('tanpa layout shift lebar', d <= 1.5, `Δlebar ${d}px`, true);
  }
  if (ex.sidebar) {
    const w = (A.final.find(e => e.key.startsWith(SB_SEL + '[')) || { rect: {} }).rect.width;
    add('lebar akhir sidebar', Math.abs(w - ex.sidebar.finalWidth) <= 1, `${w}px (target ${ex.sidebar.finalWidth}px)`);
    const mid = A.samples.some(s => { const e = s.els.find(x => x.key.startsWith(SB_SEL + '[')); return e && e.rect.width > 73 && e.rect.width < 239; });
    add('lebar bertransisi (ada nilai antara)', mid, mid ? '' : 'lebar loncat langsung: tidak ada transisi');
  }
  return out;
}

// ───────────────────────── pustaka in-page ─────────────────────────
// Fungsi ini diserialisasi ke browser (evaluateOnNewDocument): HARUS mandiri.
function installMotionLib() {
  if (window.__MT) return;
  const SB = '#appSidebar, #sidebar, .app-sidebar';
  const round = (n, d) => { const k = Math.pow(10, d === undefined ? 3 : d); return typeof n === 'number' && isFinite(n) ? Math.round(n * k) / k : n; };
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const describe = el => {
    if (!el || !el.tagName) return String(el);
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const c = typeof el.className === 'string' ? el.className.trim() : '';
    if (c) s += '.' + c.split(/\s+/).slice(0, 2).join('.');
    return s;
  };
  const vis = el => { const cs = getComputedStyle(el), r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };

  function collect(map, tMs) {
    let running = 0, maxCur = null, list = [];
    try { list = document.getAnimations(); } catch (e) { return { running, maxCur }; }
    for (const a of list) {
      const eff = a.effect;
      if (!eff || !eff.target) continue;
      let tm, ct;
      try { tm = eff.getTiming(); ct = eff.getComputedTiming(); } catch (e) { continue; }
      const looping = tm.iterations === Infinity || ct.iterations === Infinity;
      const type = (a.constructor && a.constructor.name) || 'Animation';
      const name = a.animationName || a.transitionProperty || a.id || 'waapi';
      const tgt = describe(eff.target) + (eff.pseudoElement || '');
      const key = [tgt, type, name, tm.duration, tm.delay, tm.easing].join('|');
      if (!map.has(key)) map.set(key, { target: tgt, type, name, durationMs: round(Number(tm.duration), 2), delayMs: round(Number(tm.delay), 2), easing: tm.easing, looping, firstSeenMs: round(tMs, 1) });
      if (!looping && a.playState === 'running') {
        running++;
        const cur = Number(a.currentTime);
        if (isFinite(cur) && (maxCur === null || cur > maxCur)) maxCur = cur;
      }
    }
    return { running, maxCur };
  }

  function snapshot(observe) {
    const out = [];
    for (const sel of observe) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(sel)).slice(0, 6); } catch (e) { continue; }
      list.forEach((el, i) => {
        const cs = getComputedStyle(el), r = el.getBoundingClientRect();
        out.push({
          key: sel + '[' + i + ']', opacity: round(parseFloat(cs.opacity)), transform: cs.transform,
          bg: cs.backgroundColor, color: cs.color,
          rect: { top: round(r.top, 1), left: round(r.left, 1), width: round(r.width, 1), height: round(r.height, 1) },
          inView: r.bottom > 0 && r.top < innerHeight, textLen: (el.innerText || '').length, childCount: el.children.length
        });
      });
    }
    return out;
  }

  function seriesFrame(series, t, into) {
    for (const sel of series) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(sel)).slice(0, 6); } catch (e) { continue; }
      list.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        into.push({ t: round(t, 1), key: sel + '[' + i + ']', opacity: round(parseFloat(getComputedStyle(el).opacity)), top: round(r.top, 1), left: round(r.left, 1), inView: r.bottom > 0 && r.top < innerHeight });
      });
    }
  }

  function findTrigger(spec) {
    if (!spec) return null;
    if (spec.fn === 'sidebarToggle') {
      const sb = document.querySelector(SB);
      if (!sb) return null;
      const byAttr = sb.querySelector('[data-action="toggle-sidebar"], #sidebarToggle, .sidebar-toggle, [aria-label*="ollapse" i], [aria-label*="idebar" i]');
      if (byAttr) return byAttr;
      return Array.from(sb.querySelectorAll('button')).find(b => { const r = b.getBoundingClientRect(); return r.top < 110 && r.width > 0 && r.width <= 48 && r.height <= 48; }) || null;
    }
    if (spec.fn === 'themeToggle') {
      const byAttr = document.querySelector('[data-action="toggle-theme"], #themeToggle, .theme-toggle, [aria-label*="tema" i], [aria-label*="theme" i]');
      if (byAttr) return byAttr;
      const sb = document.querySelector(SB);
      if (!sb) return null;
      return Array.from(sb.querySelectorAll('button')).find(b => { const r = b.getBoundingClientRect(); return r.top > innerHeight * 0.6 && r.width > 100; }) || null;
    }
    if (spec.selector) return document.querySelector(spec.selector);
    if (spec.text) {
      const scope = spec.scope ? document.querySelector(spec.scope) : document;
      if (!scope) return null;
      const cands = Array.from(scope.querySelectorAll('a, button, [role="tab"], [role="button"], [data-tab], [data-page], .sidebar-item, .nav-btn'));
      const want = norm(spec.text);
      return cands.find(e => norm(e.textContent) === want) || cands.find(e => norm(e.textContent).startsWith(want)) || cands.find(e => norm(e.textContent).includes(want)) || null;
    }
    return null;
  }

  function fire(spec) {
    if (!spec || spec.type === 'none') return { ok: true, target: 'none' };
    const el = findTrigger(spec);
    if (!el) return { ok: false, reason: 'elemen trigger tidak ditemukan: ' + JSON.stringify(spec) };
    if (spec.type === 'scroll') el.scrollIntoView({ block: 'center', behavior: 'instant' });
    else el.click();
    return { ok: true, target: describe(el) };
  }

  function sample(cfg) {
    return new Promise(done => {
      const inv = new Map(), series = [], samples = [];
      const t0 = performance.now();
      window.__MT_T0 = t0;
      const fired = fire(cfg.trigger);
      if (!fired.ok) { done({ fired, samples, series, inventory: [], settleMs: null, final: [] }); return; }
      let idx = 0, lastActive = 0;
      const step = () => {
        const t = performance.now() - t0;
        const a = collect(inv, t);
        if (a.running > 0) lastActive = t;
        seriesFrame(cfg.series, t, series);
        while (idx < cfg.sampleAt.length && t >= cfg.sampleAt[idx]) {
          samples.push({ target: cfg.sampleAt[idx], actual: round(t, 1), running: a.running, els: snapshot(cfg.observe) });
          idx++;
        }
        if (t >= cfg.maxMs) done({ fired, samples, series, inventory: Array.from(inv.values()), settleMs: round(lastActive, 1), final: snapshot(cfg.observe) });
        else requestAnimationFrame(step);
      };
      step();
    });
  }

  function begin(cfg) { window.__MT_T0 = performance.now(); return fire(cfg.trigger); }
  function snap(observe) {
    const a = collect(new Map(), 0);
    return { realMs: round(performance.now() - window.__MT_T0, 1), animMs: a.maxCur === null ? null : round(a.maxCur, 1), running: a.running, els: snapshot(observe) };
  }

  // inventaris animasi saat dokumen load (3 detik pertama)
  const loadInv = new Map(), L0 = performance.now();
  (function loop() {
    const t = performance.now() - L0;
    collect(loadInv, t);
    if (t < 3000) requestAnimationFrame(loop);
  })();

  // ---- token & shell ----
  function colorNorm(v) {
    const p = document.createElement('i');
    p.style.color = '';
    p.style.color = v;
    if (!p.style.color) return 'INVALID:' + v;
    document.body.appendChild(p);
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  }
  const isColor = v => /^\s*(#|rgb|hsl)/i.test(v);
  const isTime = v => /^\s*[\d.]+m?s\s*$/i.test(v);
  const toMs = v => { const s = String(v).trim(); return /ms$/i.test(s) ? parseFloat(s) : parseFloat(s) * 1000; };
  function tokens(items) {
    const cs = getComputedStyle(document.documentElement);
    return items.map(it => {
      const raw = cs.getPropertyValue(it.name).trim();
      if (!raw) return { name: it.name, expected: it.expected, actual: '(tidak ada)', ok: false };
      let ok;
      if (isColor(it.expected)) ok = colorNorm(raw) === colorNorm(it.expected);
      else if (isTime(it.expected) && isTime(raw)) ok = Math.abs(toMs(raw) - toMs(it.expected)) < 0.5;
      else ok = raw.replace(/\s+/g, '').toLowerCase() === it.expected.replace(/\s+/g, '').toLowerCase();
      return { name: it.name, expected: it.expected, actual: raw, ok };
    });
  }
  function shell() {
    const sb = document.querySelector(SB), ac = document.getElementById('appContent'), html = document.documentElement;
    const s = sb ? getComputedStyle(sb) : null, a = ac ? getComputedStyle(ac) : null;
    return {
      sidebar: s ? { width: round(sb.getBoundingClientRect().width, 1), transitionDuration: s.transitionDuration, transitionTimingFunction: s.transitionTimingFunction } : null,
      appContent: a ? { transitionDuration: a.transitionDuration, transitionProperty: a.transitionProperty } : null,
      theme: { dataTheme: html.getAttribute('data-theme'), className: html.className }
    };
  }

  // ---- layout ----
  function misaligned() {
    const out = [], root = document.querySelector('#appContent') || document.body;
    const parents = Array.from(root.querySelectorAll('*')).filter(e => e.children.length >= 2);
    for (const p of parents) {
      const kids = Array.from(p.children).filter(k => { const r = k.getBoundingClientRect(), cs = getComputedStyle(k); return r.width > 180 && r.height > 80 && cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed'; });
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        const side = b.left >= a.right - 2 || a.left >= b.right - 2;
        const d = Math.abs(a.top - b.top);
        if (side && d >= 2 && d <= 24 && Math.abs(a.width - b.width) <= 2 && kids[i].tagName === kids[j].tagName) out.push({ parent: describe(p), a: describe(kids[i]), b: describe(kids[j]), dTop: round(d, 1) });
      }
    }
    return out.slice(0, 10);
  }
  function layout() {
    const sb = document.querySelector(SB), r = sb ? sb.getBoundingClientRect() : null;
    const nm = document.getElementById('sidebarUserName');
    const box = nm ? (nm.closest('[class*="profile"],[class*="user"]') || nm.parentElement).getBoundingClientRect() : null;
    const th = findTrigger({ fn: 'themeToggle' }), tr = th ? th.getBoundingClientRect() : null;
    return {
      innerH: innerHeight, innerW: innerWidth, scrollW: document.documentElement.scrollWidth,
      sbTop: r && round(r.top, 1), sbBottom: r && round(r.bottom, 1),
      profTop: box && round(box.top, 1), profBottom: box && round(box.bottom, 1),
      toggleTop: tr && round(tr.top, 1), toggleBottom: tr && round(tr.bottom, 1),
      misaligned: misaligned()
    };
  }
  function routeInfo() {
    const re = /PREVIEW\s*[·•\-–|]?\s*DATA CONTOH|MOCK STATE/i;
    const skip = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, NOSCRIPT: 1 };
    const all = Array.from(document.querySelectorAll('body *')).filter(e => !skip[e.tagName]);
    const hits = all.filter(e => re.test(e.textContent || '') && !Array.from(e.children).some(c => re.test(c.textContent || '')));
    const banner = hits.find(e => vis(e) && e.getBoundingClientRect().bottom > 0 && e.getBoundingClientRect().top < innerHeight);
    const live = all.filter(e => !e.children.length && /^live$/i.test((e.textContent || '').trim()) && vis(e)).map(describe);
    const tabs = Array.from(document.querySelectorAll('.analisis-tab')).filter(vis);
    const rows = new Set(tabs.map(t => Math.round(t.getBoundingClientRect().top / 6)));
    return { bannerVisible: !!banner, bannerText: banner ? (banner.textContent || '').trim().slice(0, 80) : null, liveBadges: live, subtabCount: tabs.length, subtabRows: rows.size, scrollW: document.documentElement.scrollWidth, innerW: innerWidth, misaligned: misaligned() };
  }

  // ---- format tabel/kartu ----
  function parseC(s) {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(x => x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x));
    if (p.length < 3 || p.some(isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function format() {
    const numRe = /^[+\-−–]?\s*(rp\s*)?\d[\d.,]*\s*(%|jt|rb|m|b|t|k)?$/i;
    const cells = Array.from(document.querySelectorAll('table td, table th')).filter(c => c.offsetParent !== null);
    let total = 0;
    const bad = [];
    for (const c of cells) {
      const t = (c.textContent || '').trim();
      if (!t || t.length > 18 || !numRe.test(t)) continue;
      total++;
      const cs = getComputedStyle(c);
      if (!(/tabular-nums/.test(cs.fontVariantNumeric) || /tnum/.test(cs.fontFeatureSettings))) bad.push(t + ' @ ' + describe(c));
    }
    const tables = Array.from(document.querySelectorAll('table')).filter(t => t.offsetParent !== null).slice(0, 6).map(t => {
      const th = t.querySelector('thead th');
      const cs = th ? getComputedStyle(th) : null, bg = cs ? parseC(cs.backgroundColor) : null;
      const tds = Array.from(t.querySelectorAll('tbody tr td')).slice(0, 40).map(td => td.getBoundingClientRect().height).sort((a, b) => a - b);
      return { table: describe(t), sticky: cs ? cs.position === 'sticky' : null, opaqueHead: !!bg && bg.a >= 0.9, medianRowH: tds.length ? round(tds[Math.floor(tds.length / 2)], 1) : null };
    });
    const boxes = Array.from(document.querySelectorAll('[class*="card"], [class*="panel"]')).filter(vis).slice(0, 80);
    const wide = [], radii = {}, shadows = [];
    boxes.forEach(b => {
      const cs = getComputedStyle(b), w = parseFloat(cs.borderTopWidth), rd = Math.round(parseFloat(cs.borderTopLeftRadius) || 0);
      if (w > 1.01) wide.push(describe(b) + ' ' + w + 'px');
      radii[rd] = (radii[rd] || 0) + 1;
      if (cs.boxShadow && cs.boxShadow !== 'none') shadows.push(describe(b) + ' ' + cs.boxShadow.slice(0, 40));
    });
    const mk = cls => { const s = document.createElement('span'); s.className = cls; s.textContent = '1'; document.body.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; };
    const rc = getComputedStyle(document.documentElement);
    return {
      numeric: { total, badCount: bad.length, bad: bad.slice(0, 5) }, tables,
      borders: { checked: boxes.length, wide: wide.slice(0, 5), wideCount: wide.length },
      radii, shadows: { count: shadows.length, samples: shadows.slice(0, 3) },
      semantic: { pos: mk('flow-positive'), neg: mk('flow-negative'), posToken: colorNorm(rc.getPropertyValue('--data-positive').trim() || 'transparent'), negToken: colorNorm(rc.getPropertyValue('--data-negative').trim() || 'transparent') }
    };
  }

  // ---- kontras WCAG dari DOM yang dirender ----
  function contrast(limit) {
    const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
    const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const bgOf = el => {
      const layers = [];
      let n = el, uncertain = false;
      while (n && n.nodeType === 1) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') uncertain = true;
        const c = parseC(cs.backgroundColor);
        if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
        n = n.parentElement;
      }
      let base = { r: 255, g: 255, b: 255, a: 1 };
      const h = parseC(getComputedStyle(document.documentElement).backgroundColor), b = parseC(getComputedStyle(document.body).backgroundColor);
      if (h && h.a >= 1) base = h; else if (b && b.a >= 1) base = b;
      let acc = base;
      for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
      return { c: acc, uncertain };
    };
    const out = [];
    let checked = 0;
    for (const el of document.querySelectorAll('#appContent *, #appSidebar *')) {
      if (checked >= limit) break;
      if (!Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const fg = parseC(cs.color);
      if (!fg) continue;
      const bgr = bgOf(el);
      if (bgr.uncertain) continue;
      const fgc = fg.a < 1 ? over(fg, bgr.c) : fg;
      const rt = ratio(fgc, bgr.c);
      checked++;
      const px = parseFloat(cs.fontSize), w = parseInt(cs.fontWeight, 10) || 400;
      const need = (px >= 24 || (px >= 18.66 && w >= 700)) ? 3 : 4.5;
      if (rt < need) out.push({ ratio: round(rt, 2), need, text: el.textContent.trim().slice(0, 40), el: describe(el), fg: cs.color, bg: 'rgb(' + Math.round(bgr.c.r) + ',' + Math.round(bgr.c.g) + ',' + Math.round(bgr.c.b) + ')' });
    }
    out.sort((a, b) => a.ratio - b.ratio);
    return { checked, failCount: out.length, worst: out.slice(0, 12) };
  }

  window.__MT = { sample, begin, snap, fire, tokens, shell, layout, routeInfo, format, contrast, loadInventory: () => Array.from(loadInv.values()) };
}

// ───────────────────────── definisi user journey ─────────────────────────
const navSpec = label => ({ type: 'click', scope: SB_SEL, text: label });
const TOG = { type: 'click', fn: 'sidebarToggle' };
const THEME = { type: 'click', fn: 'themeToggle' };
const sub = sel => ({ type: 'click', selector: sel });

const ensureSidebar = want => async ctx => {
  const w = await ctx.sidebarWidth();
  const collapsed = w !== null && w < 120;
  if ((want === 'collapsed') !== collapsed) await ctx.click(TOG, 500);
};
const ensureTheme = want => async ctx => {
  const t = await ctx.page.evaluate(() => window.__MT.shell().theme);
  if (isLight(t) !== (want === 'light')) await ctx.click(THEME, 600);
};
const gotoNav = label => async ctx => { await ctx.click(navSpec(label), 800); };
const nav = (from, to) => ({
  pre: async ctx => { await ensureSidebar('expanded')(ctx); await gotoNav(from)(ctx); },
  trigger: navSpec(to)
});
const NAV_EXPECT = { animated: true, noEmptyFlash: '#appContent', stableWidth: '#appContent', tokens: [['--motion-fast', '--ease-standard']] };

const STEPS = [
  { id: '01-landing-reveal', title: 'Landing · scroll reveal + stagger kartu fitur', url: '/preview/landing', reset: 'goto',
    trigger: { type: 'scroll', selector: '#landingFeatures .feature-card' },
    observe: ['#landingFeatures .feature-card'], maxMs: 1100, extraSamples: [420, 600], budgetMs: 420 + 2 * 80,
    expect: { animated: true, enter: true, startsHidden: true, endsVisible: true, tokens: [['--motion-slow', '--ease-emphasized']], stagger: { group: '#landingFeatures .feature-card', expected: [60, 80] } } },
  { id: '02-landing-cta', kind: 'cta', title: 'Landing · CTA "Lihat Preview" menuju app shell' },
  { id: '03-dashboard-load', kind: 'load', title: 'Dashboard · inventaris motion saat load (render radar Top 5)', url: '/preview/dashboard' },
  { id: '04-sidebar-collapse', title: 'Shell · sidebar 240px → 72px', pre: ensureSidebar('expanded'), revert: ensureSidebar('expanded'),
    trigger: TOG, observe: [SB_SEL, '#appContent'], series: [SB_SEL], maxMs: 600, budgetMs: 180,
    expect: { animated: true, sidebar: { finalWidth: 72 }, tokens: [['--motion-fast', '--ease-standard']] } },
  { id: '05-sidebar-expand', title: 'Shell · sidebar 72px → 240px', pre: ensureSidebar('collapsed'), revert: ensureSidebar('expanded'),
    trigger: TOG, observe: [SB_SEL, '#appContent'], series: [SB_SEL], maxMs: 600, budgetMs: 180,
    expect: { animated: true, sidebar: { finalWidth: 240 }, tokens: [['--motion-fast', '--ease-standard']] } },
  { id: '06-nav-dashboard-analisis', title: 'Tab utama · Dashboard → Analisis Saham', ...nav('Dashboard', 'Analisis Saham'),
    observe: ['#appContent'], maxMs: 700, budgetMs: 180, expect: NAV_EXPECT },
  { id: '07-nav-analisis-screener', title: 'Tab utama · Analisis Saham → Screener', ...nav('Analisis Saham', 'Screener'),
    observe: ['#appContent'], maxMs: 700, budgetMs: 180, expect: NAV_EXPECT },
  { id: '08-nav-screener-portofolio', title: 'Tab utama · Screener → Portofolio', ...nav('Screener', 'Portofolio'),
    observe: ['#appContent'], maxMs: 700, budgetMs: 180, expect: NAV_EXPECT },
  { id: '09-subtab-analisis-bandarmologi', title: 'Sub-tab Analisis · Analisis & Chart → Bandarmologi',
    pre: async ctx => { await gotoNav('Analisis Saham')(ctx); await ctx.click(sub('.analisis-tab[data-tab="analisis-chart"]'), 600); },
    revert: async ctx => { await ctx.click(sub('.analisis-tab[data-tab="analisis-chart"]'), 600); },
    trigger: sub('.analisis-tab[data-tab="bandarmologi"]'), observe: ['#analisisPartialMount', '#analisisPartialMount > *'], series: ['#analisisPartialMount > *'],
    maxMs: 700, budgetMs: 180, expect: { animated: true, noEmptyFlash: '#analisisPartialMount', stableWidth: '#analisisPartialMount', tokens: [['--motion-fast', '--ease-standard']] } },
  { id: '10-subtab-analisis-pattern', title: 'Sub-tab Analisis · → Pattern Radar (halaman yang dulu kosong)',
    pre: async ctx => { await gotoNav('Analisis Saham')(ctx); await ctx.click(sub('.analisis-tab[data-tab="analisis-chart"]'), 600); },
    revert: async ctx => { await ctx.click(sub('.analisis-tab[data-tab="analisis-chart"]'), 600); },
    trigger: sub('.analisis-tab[data-tab="pattern"]'), observe: ['#analisisPartialMount', '#analisisPartialMount > *'], series: ['#analisisPartialMount > *'],
    maxMs: 700, budgetMs: 180, expect: { animated: true, noEmptyFlash: '#analisisPartialMount', stableWidth: '#analisisPartialMount', tokens: [['--motion-fast', '--ease-standard']] } },
  { id: '11-subtab-portofolio-planner', title: 'Sub-tab Portofolio · Hari Ini → Rencana Posisi',
    pre: async ctx => { await gotoNav('Portofolio')(ctx); await ctx.click(sub('#portofolioPartialMount [data-tab="today"]'), 600); },
    revert: async ctx => { await ctx.click(sub('#portofolioPartialMount [data-tab="today"]'), 600); },
    trigger: sub('#portofolioPartialMount [data-tab="planner"]'), observe: ['#portofolioPartialMount', '#portofolioPartialMount > *'], series: ['#portofolioPartialMount > *'],
    maxMs: 700, budgetMs: 180, expect: { animated: true, noEmptyFlash: '#portofolioPartialMount', stableWidth: '#portofolioPartialMount', tokens: [['--motion-fast', '--ease-standard']] } },
  { id: '12-theme-toggle', title: 'Shell · toggle tema Dark → Light',
    pre: async ctx => { await gotoNav('Dashboard')(ctx); await ensureTheme('dark')(ctx); },
    revert: async ctx => { await ensureTheme('dark')(ctx); },
    trigger: THEME, observe: ['body', SB_SEL, '#appContent'], series: ['body'], maxMs: 700, budgetMs: 180,
    expect: { animated: 'soft' } }
];

// ───────────────────────── runner ─────────────────────────
const REPORT = [];
const STATE = { step: 'init', errors: [] };
function rec(section, id, status, detail) {
  REPORT.push({ section, id, status, detail: detail || '' });
  console.log(`  [${status}] ${section} › ${id}${detail ? ' — ' + detail : ''}`);
}
const recBool = (section, id, ok, detail, soft) => rec(section, id, ok ? 'PASS' : (soft ? 'WARN' : 'FAIL'), detail);

async function slowmo(ctx, step, cfg) {
  const { page, client } = ctx;
  const frames = [];
  await client.send('Animation.enable');
  await client.send('Animation.setPlaybackRate', { playbackRate: SLOWMO_RATE });
  try {
    const fired = await page.evaluate(c => window.__MT.begin(c), cfg);
    if (!fired.ok) return { error: fired.reason, frames };
    for (const t of cfg.sampleAt) {
      const wantReal = t / SLOWMO_RATE;
      for (;;) {
        const el = await page.evaluate(() => performance.now() - window.__MT_T0);
        if (el >= wantReal) break;
        await sleep(Math.max(4, Math.min(wantReal - el - 8, 250)));
      }
      const s = await page.evaluate(o => window.__MT.snap(o), cfg.observe);
      const file = path.join(ctx.framesDir, `${step.id}__t${String(t).padStart(3, '0')}ms.png`);
      await page.screenshot({ path: file });
      frames.push(Object.assign({ t, file: path.relative(ctx.outDir, file) }, s));
    }
  } finally {
    await client.send('Animation.setPlaybackRate', { playbackRate: 1 });
  }
  return { frames };
}

async function revertStep(ctx, step) {
  if (step.reset === 'goto') await ctx.goto(step.url);
  else if (step.revert) await step.revert(ctx);
  await sleep(SETTLE_MS);
}

async function runStep(ctx, step) {
  STATE.step = step.id;
  console.log(`\n▶ ${step.id} — ${step.title}`);
  const out = { id: step.id, title: step.title, A: null, B: null };
  try {
    if (step.kind === 'cta') return await runCta(ctx, step, out);
    if (step.kind === 'load') return await runLoad(ctx, step, out);
    if (step.url) await ctx.goto(step.url);
    if (step.pre) await step.pre(ctx);
    const cfg = {
      observe: step.observe, series: step.series || step.observe,
      sampleAt: uniqSorted(SAMPLE_TIMES.concat(step.extraSamples || [])), maxMs: step.maxMs || 700, trigger: step.trigger
    };
    out.A = await ctx.page.evaluate(c => window.__MT.sample(c), cfg);
    evaluateStep(step, out.A, ctx.spec).forEach(c => rec(step.id, c.id, c.status, c.detail));
    await revertStep(ctx, step);
    if (ctx.frames) {
      if (step.pre) await step.pre(ctx);
      out.B = await slowmo(ctx, step, cfg);
      if (out.B.error) rec(step.id, 'frame slow-mo', 'WARN', out.B.error);
      else rec(step.id, 'frame slow-mo', 'PASS', out.B.frames.length + ' screenshot → frames/');
      await revertStep(ctx, step);
    }
  } catch (e) {
    rec(step.id, 'runner', 'FAIL', String((e && e.message) || e));
  }
  return out;
}

async function runCta(ctx, step, out) {
  await ctx.goto('/preview/landing');
  const t0 = Date.now();
  try { await ctx.fire({ type: 'click', text: 'Lihat Preview' }); } catch (e) { /* navigasi bisa menghancurkan konteks */ }
  try { await ctx.page.waitForSelector('#appContent', { timeout: 8000 }); } catch (e) { /* dicek di bawah */ }
  const arrived = await ctx.page.evaluate(() => !!document.getElementById('appContent')).catch(() => false);
  recBool(step.id, 'CTA membawa ke app shell', arrived, `${Date.now() - t0}ms → ${ctx.page.url()}`);
  out.arrived = arrived;
  return out;
}

async function runLoad(ctx, step, out) {
  await ctx.goto(step.url);
  await sleep(2500);
  const inv = await ctx.page.evaluate(() => window.__MT.loadInventory());
  const finite = inv.filter(a => !a.looping);
  const cls = classify(finite, ctx.spec);
  out.inventory = inv;
  recBool(step.id, 'durasi ∈ token', cls.offDur.length === 0, cls.offDur.length ? cls.offDur.map(fmtAnim).join(' | ') : finite.length + ' animasi load, semua cocok');
  recBool(step.id, 'easing ∈ token', cls.offEase.length === 0, cls.offEase.map(fmtAnim).join(' | '));
  recBool(step.id, 'tanpa overshoot/bounce', cls.bounce.length === 0, cls.bounce.map(fmtAnim).join(' | '));
  const lay = await ctx.page.evaluate(() => window.__MT.layout());
  recBool(step.id, 'kartu sejajar setelah animasi selesai', lay.misaligned.length === 0, lay.misaligned.map(m => `${m.a} vs ${m.b} Δtop=${m.dTop}px`).join(' | '));
  return out;
}

async function sectionTokens(ctx) {
  const S = 'tokens/shell';
  STATE.step = S;
  console.log('\n▶ ' + S);
  await ctx.goto('/preview/dashboard');
  await ensureTheme('dark')(ctx);
  const sh = await ctx.page.evaluate(() => window.__MT.shell());
  rec(S, 'mekanisme tema', 'PASS', `data-theme=${sh.theme.dataTheme} class="${sh.theme.className}"`);
  const mot = await ctx.page.evaluate(i => window.__MT.tokens(i), Object.entries(ctx.spec.motion).map(([name, expected]) => ({ name, expected })));
  mot.forEach(t => recBool(S, 'motion ' + t.name, t.ok, `${t.actual} (spek ${t.expected})`));
  const dark = await ctx.page.evaluate(i => window.__MT.tokens(i), Object.entries(ctx.spec.dark).map(([name, expected]) => ({ name, expected })));
  dark.forEach(t => recBool(S, 'dark ' + t.name, t.ok, `${t.actual} (spek ${t.expected})`));
  const fast = parseMs(ctx.spec.motion['--motion-fast']);
  if (sh.sidebar) {
    recBool(S, 'sidebar lebar expanded', Math.abs(sh.sidebar.width - ctx.spec.layout.sidebarExpandedPx) <= 1, sh.sidebar.width + 'px');
    recBool(S, 'sidebar transition-duration = --motion-fast', Math.abs(parseMs(sh.sidebar.transitionDuration.split(',')[0]) - fast) < 0.5, sh.sidebar.transitionDuration);
    recBool(S, 'sidebar easing = --ease-standard', strip(sh.sidebar.transitionTimingFunction).includes(strip(ctx.spec.motion['--ease-standard'])), sh.sidebar.transitionTimingFunction);
  } else rec(S, 'sidebar', 'FAIL', 'elemen sidebar tidak ditemukan');
  if (sh.appContent) recBool(S, '#appContent transition = --motion-fast', Math.abs(parseMs(sh.appContent.transitionDuration.split(',')[0]) - fast) < 0.5, sh.appContent.transitionDuration + ' / ' + sh.appContent.transitionProperty);
  else rec(S, '#appContent', 'FAIL', 'tidak ditemukan');
  // tema terang lewat tombol milik aplikasi
  await ctx.click(THEME, 700);
  const shL = await ctx.page.evaluate(() => window.__MT.shell());
  recBool(S, 'toggle tema mengubah state', isLight(shL.theme), `data-theme=${shL.theme.dataTheme} class="${shL.theme.className}"`);
  const light = await ctx.page.evaluate(i => window.__MT.tokens(i), Object.entries(ctx.spec.light).map(([name, expected]) => ({ name, expected })));
  light.forEach(t => recBool(S, 'light ' + t.name, t.ok, `${t.actual} (spek ${t.expected})`));
  await ctx.click(THEME, 700);
}

async function sectionLayout(ctx) {
  const S = 'layout';
  STATE.step = S;
  console.log('\n▶ ' + S + ' (sidebar & kartu di 3 viewport)');
  for (const [w, h] of VIEWPORTS) {
    await ctx.page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await ctx.goto('/preview/dashboard');
    const L = await ctx.page.evaluate(() => window.__MT.layout());
    const tag = `${w}×${h}`;
    recBool(S, `${tag} sidebar bottom ≤ viewport`, L.sbBottom !== null && L.sbBottom <= L.innerH + 0.5, `bottom=${L.sbBottom} innerH=${L.innerH} top=${L.sbTop}`);
    recBool(S, `${tag} baris profil tidak terpotong`, L.profBottom !== null && L.profBottom <= L.innerH + 0.5, `bottom=${L.profBottom} innerH=${L.innerH}`);
    recBool(S, `${tag} toggle tema tidak terpotong`, L.toggleBottom !== null && L.toggleBottom <= L.innerH + 0.5, `bottom=${L.toggleBottom}`);
    recBool(S, `${tag} toggle di ATAS profil (§1.2)`, L.toggleBottom !== null && L.profTop !== null && L.toggleBottom <= L.profTop + 1, `toggleBottom=${L.toggleBottom} profTop=${L.profTop}`);
    recBool(S, `${tag} tanpa scroll horizontal`, L.scrollW <= L.innerW, `scrollW=${L.scrollW} innerW=${L.innerW}`);
    recBool(S, `${tag} kartu satu baris sejajar`, L.misaligned.length === 0, L.misaligned.map(m => `${m.a} vs ${m.b} Δtop=${m.dTop}px`).join(' | '));
  }
  await ctx.page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
}

async function sectionRoutes(ctx) {
  const S = 'routes';
  console.log('\n▶ ' + S + ' (9 rute preview: banner, LIVE, overflow, tab wrap)');
  for (const [name, url] of ROUTES) {
    STATE.step = 'route:' + name;
    await ctx.goto(url);
    const R = await ctx.page.evaluate(() => window.__MT.routeInfo());
    recBool(S, `${name} banner PREVIEW terlihat`, R.bannerVisible, R.bannerText || 'banner tidak ditemukan / tidak terlihat');
    recBool(S, `${name} tanpa badge "LIVE" pada data contoh`, R.liveBadges.length === 0, R.liveBadges.join(', '));
    recBool(S, `${name} tanpa scroll horizontal`, R.scrollW <= R.innerW, `scrollW=${R.scrollW} innerW=${R.innerW}`);
    if (R.subtabCount) recBool(S, `${name} sub-tab satu baris`, R.subtabRows === 1, `${R.subtabCount} tab dalam ${R.subtabRows} baris`);
    recBool(S, `${name} kartu sejajar`, R.misaligned.length === 0, R.misaligned.map(m => `${m.a} vs ${m.b} Δtop=${m.dTop}px`).join(' | '), true);
  }
}

async function sectionFormat(ctx) {
  const S = 'format';
  console.log('\n▶ ' + S + ' (tabular-nums, sticky header, hairline, warna semantik)');
  for (const [name, url] of [['watchlist', '/preview/watchlist'], ['kelola-keuangan', '/preview/kelola-keuangan'], ['screener', '/preview/screener'], ['dashboard', '/preview/dashboard']]) {
    STATE.step = 'format:' + name;
    await ctx.goto(url);
    await ensureTheme('dark')(ctx);
    const F = await ctx.page.evaluate(() => window.__MT.format());
    recBool(S, `${name} angka tabel pakai tabular-nums`, F.numeric.badCount === 0, `${F.numeric.badCount}/${F.numeric.total} sel bermasalah ${F.numeric.bad.join(' | ')}`);
    F.tables.forEach(t => {
      recBool(S, `${name} ${t.table} thead sticky`, t.sticky === true, String(t.sticky));
      recBool(S, `${name} ${t.table} thead solid`, t.opaqueHead, '');
      if (t.medianRowH !== null) recBool(S, `${name} ${t.table} tinggi baris 34–36px`, t.medianRowH >= 33 && t.medianRowH <= 37, `median ${t.medianRowH}px`, true);
    });
    recBool(S, `${name} border kartu ≤ 1px`, F.borders.wideCount === 0, F.borders.wide.join(' | '));
    const odd = Object.keys(F.radii).filter(r => ![0, 8, 12, 999].includes(Number(r)) && Number(r) < 100);
    recBool(S, `${name} radius ∈ {8,12}px`, odd.length === 0, 'radius lain: ' + odd.map(r => r + 'px×' + F.radii[r]).join(', '), true);
    recBool(S, `${name} tanpa shadow di dark mode`, F.shadows.count === 0, `${F.shadows.count} elemen ${F.shadows.samples.join(' | ')}`, true);
    recBool(S, `${name} .flow-positive = --data-positive`, F.semantic.pos === F.semantic.posToken, `${F.semantic.pos} vs token ${F.semantic.posToken}`);
    recBool(S, `${name} .flow-negative = --data-negative`, F.semantic.neg === F.semantic.negToken, `${F.semantic.neg} vs token ${F.semantic.negToken}`);
  }
}

async function runAxe(page) {
  let AxePuppeteer;
  try { ({ AxePuppeteer } = require('@axe-core/puppeteer')); } catch (e) { return { skipped: 'npm i -D @axe-core/puppeteer' }; }
  const r = await new AxePuppeteer(page).withTags(['wcag2a', 'wcag2aa']).analyze();
  return { violations: r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })) };
}

async function sectionContrast(ctx) {
  const S = 'kontras';
  console.log('\n▶ ' + S + ' (WCAG dari elemen yang dirender, Dark & Light)');
  const out = {};
  for (const [name, url] of [['dashboard', '/preview/dashboard'], ['analisis-saham', '/preview/analisis-saham'], ['screener', '/preview/screener']]) {
    STATE.step = 'kontras:' + name;
    await ctx.goto(url);
    await ensureTheme('dark')(ctx);
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await ctx.click(THEME, 700);
      const C = await ctx.page.evaluate(() => window.__MT.contrast(1200));
      out[name + ':' + theme] = C;
      recBool(S, `${name} ${theme}`, C.failCount === 0, `${C.failCount}/${C.checked} teks di bawah ambang. terburuk: ` + C.worst.slice(0, 3).map(w => `"${w.text}" ${w.ratio}:1`).join(' | '));
      if (ARGS.has('--axe')) {
        const ax = await runAxe(ctx.page);
        if (ax.skipped) rec(S, `${name} ${theme} axe`, 'WARN', 'dilewati: ' + ax.skipped);
        else recBool(S, `${name} ${theme} axe-core`, ax.violations.length === 0, ax.violations.map(v => `${v.id}(${v.impact}) ×${v.nodes}`).join(', '));
      }
    }
    await ctx.click(THEME, 700);
  }
  return out;
}

async function sectionReducedMotion(ctx) {
  const S = 'reduced-motion';
  STATE.step = S;
  console.log('\n▶ ' + S + ' (prefers-reduced-motion: reduce)');
  await ctx.page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  try {
    await ctx.goto('/preview/dashboard');
    await gotoNav('Dashboard')(ctx);
    const A = await ctx.page.evaluate(c => window.__MT.sample(c), { observe: ['#appContent'], series: ['#appContent'], sampleAt: [0, 60, 120], maxMs: 500, trigger: navSpec('Analisis Saham') });
    const long = (A.inventory || []).filter(a => !a.looping && a.durationMs > 1);
    recBool(S, 'animasi non-esensial dimatikan', A.fired && A.fired.ok && long.length === 0, long.map(fmtAnim).join(' | ') || 'tidak ada animasi >1ms', true);
  } finally {
    await ctx.page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  }
}

async function runCanary(ctx) {
  console.log('\n▶ CANARY: meracuni token di DOM hidup, skrip HARUS mendeteksinya');
  await ctx.goto('/preview/dashboard');
  await ctx.page.evaluate(() => {
    const s = document.documentElement.style;
    s.setProperty('--motion-fast', '150ms');
    s.setProperty('--ease-standard', 'cubic-bezier(0.2, 0, 0, 1)');
    s.setProperty('--accent-primary', '#10B981');
  });
  const items = Object.entries(ctx.spec.motion).concat(Object.entries(ctx.spec.dark)).map(([name, expected]) => ({ name, expected }));
  const res = await ctx.page.evaluate(i => window.__MT.tokens(i), items);
  const failed = res.filter(r => !r.ok).map(r => r.name);
  const need = ['--motion-fast', '--ease-standard', '--accent-primary'];
  need.forEach(n => console.log(`  canary ${n}: ${failed.includes(n) ? 'TERTANGKAP ✓' : 'LOLOS ✗ (audit buta!)'}`));
  return need.every(n => failed.includes(n));
}

function writeOutputs(outDir, meta, steps, extra) {
  const counts = REPORT.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  const lines = ['AUTO-CUAN MOTION & JOURNEY TRACE', `waktu   : ${meta.startedAt}`, `server  : ${meta.baseUrl}`, `spek    : ${meta.specSource}`, ''];
  let cur = null;
  REPORT.forEach(r => { if (r.section !== cur) { cur = r.section; lines.push('', '## ' + cur); } lines.push(`[${r.status}] ${r.id}${r.detail ? ' — ' + r.detail : ''}`); });
  lines.push('', '## console/network selama journey');
  lines.push(STATE.errors.length ? STATE.errors.map(e => `[${e.step}] ${e.type}: ${e.text}`).join('\n') : 'bersih');
  lines.push('', `RINGKASAN: PASS=${counts.PASS || 0} WARN=${counts.WARN || 0} FAIL=${counts.FAIL || 0}`);
  fs.writeFileSync(path.join(outDir, 'summary.txt'), lines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'trace.json'), JSON.stringify({ meta, report: REPORT, steps, extra, errors: STATE.errors }, null, 2), 'utf8');
  return counts;
}

async function main() {
  const puppeteer = require('puppeteer-core');
  const { spec, source } = loadSpec();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(OUT_ROOT, stamp);
  const framesDir = path.join(outDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH, headless: !ARGS.has('--headful'),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(installMotionLib);
    const client = await (page.createCDPSession ? page.createCDPSession() : page.target().createCDPSession());
    page.on('pageerror', e => STATE.errors.push({ step: STATE.step, type: 'pageerror', text: e.message }));
    page.on('console', m => { if (m.type() === 'error') STATE.errors.push({ step: STATE.step, type: 'console', text: m.text() }); });
    page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) STATE.errors.push({ step: STATE.step, type: 'http ' + r.status(), text: r.url() }); });

    const ctx = {
      page, client, spec, outDir, framesDir, frames: !ARGS.has('--no-frames'),
      goto: async route => { await page.goto(BASE_URL + route, { waitUntil: 'networkidle2', timeout: 20000 }); await sleep(SETTLE_MS); },
      fire: s => page.evaluate(x => window.__MT.fire(x), s),
      click: async (s, wait) => {
        const r = await page.evaluate(x => window.__MT.fire(x), s);
        if (!r.ok) throw new Error(r.reason);
        await sleep(wait === undefined ? SETTLE_MS : wait);
        return r;
      },
      sidebarWidth: () => page.evaluate(sel => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().width) : null; }, SB_SEL)
    };

    if (ARGS.has('--canary')) {
      const ok = await runCanary(ctx);
      console.log(ok ? '\nCANARY OK: skrip membaca DOM hidup.' : '\nCANARY GAGAL: skrip TIDAK membaca DOM hidup. Jangan percaya hasil audit.');
      process.exitCode = ok ? 0 : 3;
      return;
    }

    const meta = { baseUrl: BASE_URL, startedAt: new Date().toISOString(), specSource: source, samplePointsMs: SAMPLE_TIMES, slowmoRate: SLOWMO_RATE };
    console.log('Spek: ' + source);
    const masterFlat = MASTER_SPEC.motion;
    Object.keys(masterFlat).forEach(k => { if (strip(spec.motion[k]) !== strip(masterFlat[k]) && parseMs(spec.motion[k]) !== parseMs(masterFlat[k])) rec('spec-drift', k, 'WARN', `${path.basename(SPEC_FILE)}=${spec.motion[k]} ≠ dokumen master=${masterFlat[k]}. Putuskan satu dan perbarui dokumennya.`); });

    await sectionTokens(ctx);
    await sectionLayout(ctx);
    await sectionRoutes(ctx);
    await sectionFormat(ctx);
    const contrast = await sectionContrast(ctx);

    const steps = [];
    for (const s of STEPS) steps.push(await runStep(ctx, s));
    await sectionReducedMotion(ctx);

    STATE.step = 'final';
    const errs = STATE.errors;
    recBool('console', 'nol error console/pageerror/HTTP ≥400', errs.length === 0, errs.slice(0, 5).map(e => `[${e.step}] ${e.type}: ${e.text}`).join(' | '));

    const counts = writeOutputs(outDir, meta, steps, { contrast });
    console.log(`\n=== RINGKASAN: PASS=${counts.PASS || 0} WARN=${counts.WARN || 0} FAIL=${counts.FAIL || 0} ===`);
    console.log('Output: ' + outDir);
    process.exitCode = counts.FAIL ? 1 : 0;
  } finally {
    await browser.close();
  }
}

module.exports = { evaluateStep, staggerFromSeries, classify, loadSpec, identity, overshoot, parseMs, MASTER_SPEC };
if (require.main === module) main().catch(e => { console.error('[motion-trace] fatal:', e); process.exit(2); });
