'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function write(relativePath, content) {
  fs.writeFileSync(path.join(__dirname, '..', relativePath), content);
}

function replaceRequired(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error('Missing production hotfix target: ' + label);
  return source.replace(before, after);
}

function patchIndex() {
  let source = read('public/index.html');
  const q = String.fromCharCode(39);

  const oldWatchdog = 'setTimeout(function() { if (document.getElementById(' + q + 'initialLoader' + q + ')) renderStartupFallback(); }, 4500);';
  const newWatchdog = 'setTimeout(function() { var loader=document.getElementById(' + q + 'initialLoader' + q + '); if (loader && !loader.classList.contains(' + q + 'hidden' + q + ')) renderStartupFallback(); }, 4500);';
  source = replaceRequired(source, oldWatchdog, newWatchdog, 'startup watchdog');

  source = replaceRequired(
    source,
    'Bandingkan manfaat, harga, dan masa aktif setiap paket. Pembayaran melalui transfer bank akan tersedia pada tahap berikutnya.',
    'Bandingkan manfaat, harga, dan masa aktif setiap paket secara transparan.',
    'subscription hero copy'
  );
  source = replaceRequired(
    source,
    'Pembayaran melalui transfer bank akan tersedia pada tahap berikutnya. Tidak ada pembelian atau akses yang diproses dari halaman ini.',
    'Pilihan pembayaran belum dibuka. Tidak ada pembelian atau akses yang diproses dari halaman ini.',
    'subscription action copy'
  );

  source = source.replace(/<button[^>]*onclick="openSubscriptionPage\(\)"[^>]*>\s*Paket Langganan\s*<\/button>/g, '');
  source = source.replace(/<button[^>]*onclick="navigateTo\('subscription'\)"[^>]*>[\s\S]*?<\/button>/g, '');

  source = replaceRequired(
    source,
    "if (isPremiumFeaturePage(page) && !hasConfirmedPremiumAccess()) {",
    'if (false) {',
    'legacy premium navigation gate'
  );
  source = replaceRequired(
    source,
    'if (!allowed && isPremiumFeaturePage(currentPage)) {',
    'if (false) {',
    'legacy premium current-page gate'
  );
  source = replaceRequired(
    source,
    "function openSubscriptionPage(){setTopLevelView('app');navigateTo('subscription');loadSubscriptionExperience(true);window.scrollTo({top:0,behavior:'smooth'});}",
    "function openSubscriptionPage(){if(isAutocuanLoggedIn())enterApp({replaceHistory:true});else showLandingPage({replaceHistory:true});}",
    'subscription route disable'
  );

  const scripts = [
    '/website-approved-access.js?v=20260726-final2',
    '/admin-user-delete-enhancement.js?v=20260726-final2',
    '/ai-chat-renderer.js?v=20260726-final2',
    '/stock-analysis-ai.js?v=20260726-final2'
  ];
  const injection = scripts.map((src) => '<script src="' + src + '"></script>').join('\n');
  if (!source.includes('/website-approved-access.js?v=20260726-final2')) {
    source = source.replace('</body>', injection + '\n</body>');
  }

  write('public/index.html', source);
}

function patchContextRouter() {
  let source = read('lib/context-ai-router-v4.js');
  source = replaceRequired(
    source,
    "  const preferred = sticky.get(stickyKey);\n  const live = pool.filter((model) => modelHealth(model).cooldownUntil <= now);\n  const cooling = pool.filter((model) => modelHealth(model).cooldownUntil > now);\n  const allowSticky = preferred && live.includes(preferred) && ((source === 'stock_analysis_followup' || task === 'heavy') || !EXPENSIVE_MODELS.has(preferred));\n  return dedupe((allowSticky ? [preferred] : []).concat(live, cooling));",
    "  const preferred = sticky.get(stickyKey);\n  const globalPreferred = sticky.get(userId + ':global');\n  const live = pool.filter((model) => modelHealth(model).cooldownUntil <= now);\n  const cooling = pool.filter((model) => modelHealth(model).cooldownUntil > now);\n  const allowGlobal = globalPreferred && live.includes(globalPreferred) && ((source === 'stock_analysis_followup' || task === 'heavy') || !EXPENSIVE_MODELS.has(globalPreferred));\n  const allowSticky = preferred && live.includes(preferred) && ((source === 'stock_analysis_followup' || task === 'heavy') || !EXPENSIVE_MODELS.has(preferred));\n  return dedupe((allowGlobal ? [globalPreferred] : []).concat(allowSticky ? [preferred] : [], live, cooling));",
    'shared healthy AI model preference'
  );
  source = replaceRequired(
    source,
    "      sticky.set(userId + ':' + source + ':' + task, model);",
    "      sticky.set(userId + ':' + source + ':' + task, model);\n      sticky.set(userId + ':global', model);",
    'shared AI success memory'
  );
  write('lib/context-ai-router-v4.js', source);
}

function patchPortfolioRuntime() {
  let source = read('public/portfolio-ai-runtime-v2.js');
  source = replaceRequired(
    source,
    "  function loadChat() {\n    var rows = readJson(chatKey, []);\n    state.messages = Array.isArray(rows) ? rows.slice(-20).filter(function (row) {\n      return row && (row.role === 'user' || row.role === 'assistant') && String(row.content || '').trim();\n    }) : [];\n  }",
    "  function loadChat() {\n    var rows = readJson(chatKey, []);\n    var cleaned = Array.isArray(rows) ? rows.slice(-20).filter(function (row) {\n      return row && (row.role === 'user' || row.role === 'assistant') && String(row.content || '').trim();\n    }) : [];\n    state.messages = cleaned.filter(function (row, index) {\n      if (index === 0) return true;\n      var previous = cleaned[index - 1];\n      return previous.role !== row.role || String(previous.content).trim() !== String(row.content).trim();\n    });\n    saveChat();\n  }",
    'portfolio chat duplicate cleanup'
  );
  source = replaceRequired(
    source,
    "        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({\n          source: 'portfolio_chat',",
    "        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),\n        body: JSON.stringify({\n          source: 'portfolio_chat',",
    'portfolio AI auth headers'
  );
  source = replaceRequired(
    source,
    "      if (status) status.textContent = 'AI cloud lagi ngadat, jadi sistem pakai mode data lokal biar kamu tetap dapat jawaban.';",
    "      if (status) status.textContent = 'Jalur AI utama sedang sibuk. Jawaban sementara dibuat dari data portofolio yang tersedia.';",
    'portfolio fallback status'
  );
  write('public/portfolio-ai-runtime-v2.js', source);
}

function patchRenderer() {
  let source = read('public/ai-chat-renderer.js');
  source = replaceRequired(
    source,
    "    candidates.forEach(function (el) {\n      if (el.querySelector && el.querySelector('.ai-loading-dot, .spinner-sm')) return;\n      var raw = el.getAttribute('data-ai-raw') || el.textContent || '';",
    "    candidates.forEach(function (el) {\n      if (el.querySelector && el.querySelector('.ai-loading-dot, .spinner-sm')) return;\n      if (el.classList.contains('ai-rich-text') && !el.hasAttribute('data-ai-raw')) return;\n      var raw = el.getAttribute('data-ai-raw') || el.textContent || '';",
    'preserve pre-rendered portfolio markdown'
  );
  write('public/ai-chat-renderer.js', source);
}

function patchPortfolioPage() {
  let source = read('public/portfolio-planner.html');
  source = replaceRequired(
    source,
    '.ai-shell{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px}',
    '.ai-shell{display:grid;grid-template-columns:1fr;gap:16px}.ai-shell aside{order:2}',
    'portfolio AI vertical layout'
  );
  write('public/portfolio-planner.html', source);
}

function validateBuild() {
  const jsFiles = [
    'public/website-approved-access.js',
    'public/admin-user-delete-enhancement.js',
    'public/ai-chat-renderer.js',
    'public/portfolio-ai-runtime-v2.js',
    'public/stock-analysis-ai.js',
    'lib/context-ai-router-v4.js',
    'api/admin-users.js'
  ];
  jsFiles.forEach(function (file) {
    new vm.Script(read(file), { filename: file });
  });

  const apiFiles = fs.readdirSync(path.join(__dirname, '..', 'api'))
    .filter(function (name) { return name.endsWith('.js'); });
  if (apiFiles.length !== 12) {
    throw new Error('Vercel API function count changed: expected 12, got ' + apiFiles.length);
  }

  const index = read('public/index.html');
  if (/onclick="openSubscriptionPage\(\)"/.test(index) || /onclick="navigateTo\('subscription'\)"/.test(index)) {
    throw new Error('Subscription entry point is still visible.');
  }
  if (index.includes('if (isPremiumFeaturePage(page) && !hasConfirmedPremiumAccess()) {') ||
      index.includes('if (!allowed && isPremiumFeaturePage(currentPage)) {')) {
    throw new Error('Legacy website premium gate is still active.');
  }
  if (!index.includes('/website-approved-access.js?v=20260726-final2') ||
      !index.includes('/admin-user-delete-enhancement.js?v=20260726-final2')) {
    throw new Error('Approved access/admin enhancement was not injected.');
  }

  const renderer = read('public/ai-chat-renderer.js');
  if (/characterData\s*:\s*true/.test(renderer)) {
    throw new Error('AI renderer characterData feedback loop returned.');
  }

  const portfolio = read('public/portfolio-planner.html');
  if (!portfolio.includes('.ai-shell{display:grid;grid-template-columns:1fr;gap:16px}')) {
    throw new Error('Portfolio AI layout is not vertical.');
  }

  const vercel = JSON.parse(read('vercel.json'));
  const dashboardRewrite = (vercel.rewrites || []).find(function (row) { return row.source === '/dashboard'; });
  if (!dashboardRewrite || dashboardRewrite.destination !== '/index.html') {
    throw new Error('/dashboard must rewrite directly to /index.html.');
  }
}

patchIndex();
patchContextRouter();
patchPortfolioRuntime();
patchRenderer();
patchPortfolioPage();
validateBuild();
console.log('Applied and validated production website/AI hotfixes');
