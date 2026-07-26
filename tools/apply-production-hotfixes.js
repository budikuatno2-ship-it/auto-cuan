'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

  // Website access is approval-based. Subscription belongs to the later Telegram phase.
  source = source.replace(/<button[^>]*onclick="openSubscriptionPage\(\)"[^>]*>\s*Paket Langganan\s*<\/button>/g, '');
  source = source.replace(/<button[^>]*onclick="navigateTo\('subscription'\)"[^>]*>[\s\S]*?<\/button>/g, '');
  source = source.replace(
    /<div id="page-subscription"[\s\S]*?<\/div>\s*\n\s*<!-- ===== PAGE: DASHBOARD HOME ===== -->/,
    '<!-- Subscription UI intentionally hidden until the later Telegram/payment phase. -->\n\n<!-- ===== PAGE: DASHBOARD HOME ===== -->'
  );
  source = source.replace(/<section id="subscriptionIdentityCard"[\s\S]*?<\/section>/g, '');

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
  source = replaceRequired(
    source,
    "if (path === '/subscription' || path === '/subscription/') { openSubscriptionPage(); return; }",
    "if (path === '/subscription' || path === '/subscription/') { openSubscriptionPage(); return; }",
    'subscription route compatibility'
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

patchIndex();
patchContextRouter();
console.log('Applied production website and AI hotfixes');
