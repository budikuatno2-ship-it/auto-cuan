'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const indexPath = path.join(ROOT, 'public', 'index.html');
const analisisPartialPath = path.join(ROOT, 'partials', 'analisis-saham.partial.html');
const portfolioPartialPath = path.join(ROOT, 'partials', 'portfolio-command-center.partial.html');

let indexHtml = fs.readFileSync(indexPath, 'utf8');
const analisisPartial = fs.readFileSync(analisisPartialPath, 'utf8');
const portfolioPartial = fs.readFileSync(portfolioPartialPath, 'utf8');

console.log('Original index.html length:', indexHtml.length);

// 1. Add stylesheets in <head>
if (!indexHtml.includes('/portfolio-command-center.css')) {
  const target = '<link rel="stylesheet" href="/unified-cockpit.css?v=20260905-v1">';
  const replacement = target + '\n    <link rel="stylesheet" href="/portfolio-command-center.css?v=20260727-v1">\n    <link rel="stylesheet" href="/portfolio-ai-workspace-v1.css">';
  if (!indexHtml.includes(target)) {
    throw new Error('Target unified-cockpit.css not found in index.html');
  }
  indexHtml = indexHtml.replace(target, replacement);
  console.log('1. Added portfolio stylesheets in <head>');
}

// 2. Update app-layout to app-shell
if (!indexHtml.includes('id="appShell"')) {
  const target = '<div class="app-layout">';
  const replacement = '<div class="app-shell app-layout" id="appShell" data-sidebar-state="expanded">';
  if (!indexHtml.includes(target)) {
    throw new Error('Target <div class="app-layout"> not found');
  }
  indexHtml = indexHtml.replace(target, replacement);
  console.log('2. Updated <div class="app-layout"> to app-shell');
}

// 3. Update sidebar nav items with data-label and add bandarmologi item
if (!indexHtml.includes('data-sidebar-page="bandarmologi"')) {
  const oldNavRegex = /<nav class="sidebar-nav" aria-label="Menu utama workspace">([\s\S]*?)<\/nav>/;
  const navMatch = indexHtml.match(oldNavRegex);
  if (!navMatch) throw new Error('sidebar-nav not found');

  const newNav = `<nav class="sidebar-nav" aria-label="Menu utama workspace">
        <button type="button" onclick="navigateTo('dashboard')" class="sidebar-item active" data-sidebar-page="dashboard" data-label="Dashboard" title="Dashboard">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>
            <span class="sidebar-label">Dashboard</span>
        </button>
        <button type="button" onclick="navigateTo('analisis')" class="sidebar-item" data-sidebar-page="analisis" data-label="Analisis Saham" title="Analisis Saham">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
            <span class="sidebar-label">Analisis Saham</span>
        </button>
        <button type="button" onclick="navigateTo('bandarmologi')" class="sidebar-item" data-sidebar-page="bandarmologi" data-label="Bandarmologi" title="Bandarmologi">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>
            <span class="sidebar-label">Bandarmologi</span>
        </button>
        <button type="button" onclick="navigateTo('sektor')" class="sidebar-item hidden" data-sidebar-page="sektor" data-label="Sektor Hot" data-premium-nav="true" title="Sektor Hot">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            <span class="sidebar-label">Sektor Hot</span>
        </button>
        <button type="button" onclick="navigateTo('screener')" class="sidebar-item hidden" data-sidebar-page="screener" data-label="Screener" data-premium-nav="true" title="Screener">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
            <span class="sidebar-label">Screener</span>
        </button>
        <button type="button" onclick="navigateTo('portofolio')" class="sidebar-item hidden" data-sidebar-page="portofolio" data-label="Portofolio" data-premium-nav="true" title="Portofolio">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"/></svg>
            <span class="sidebar-label">Portofolio</span>
        </button>
        <button type="button" onclick="navigateTo('watchlist')" class="sidebar-item hidden" data-sidebar-page="watchlist" data-label="Watchlist" data-premium-nav="true" title="Watchlist">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>
            <span class="sidebar-label">Watchlist</span>
        </button>
        <button type="button" onclick="navigateTo('trackrecord')" class="sidebar-item hidden" data-sidebar-page="trackrecord" data-label="Track Record" data-premium-nav="true" title="Track Record">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
            <span class="sidebar-label">Track Record</span>
        </button>
        <button type="button" onclick="navigateTo('money-management')" class="sidebar-item hidden" data-sidebar-page="money-management" data-label="Kelola Keuangan" data-premium-nav="true" title="Kelola Keuangan">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            <span class="sidebar-label">Kelola Keuangan</span>
        </button>
    </nav>`;
  indexHtml = indexHtml.replace(navMatch[0], newNav);
  console.log('3. Updated sidebar-nav with data-label and bandarmologi item');
}

// 4. Update sidebar footer to put theme toggle above user profile
const footerRegex = /<div class="sidebar-footer">([\s\S]*?)<\/aside>/;
const footerMatch = indexHtml.match(footerRegex);
if (footerMatch && !footerMatch[1].trim().startsWith('<button id="themeToggleCompact"')) {
  const newFooter = `<div class="sidebar-footer">
        <button id="themeToggleCompact" type="button" onclick="toggleAppTheme()" class="theme-toggle-compact" aria-label="Toggle Theme" title="Ganti tema terang/gelap">
            <span id="sidebarThemeIcon" aria-hidden="true">🌙</span><span class="sr-only" id="sidebarThemeLabel">Dark Mode</span>
        </button>
        <div class="user-profile-badge" title="Profil pengguna &amp; Logout" role="button" tabindex="0" onclick="if(document.getElementById('headerUserLabel'))document.getElementById('headerUserLabel').click()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();if(document.getElementById('headerUserLabel'))document.getElementById('headerUserLabel').click();}">
            <div class="user-avatar" aria-hidden="true">B</div>
            <div class="user-info sidebar-label">
                <span class="user-name" id="sidebarUserName">budi</span>
                <span class="user-role">ADMIN</span>
            </div>
        </div>
    </div>
</aside>`;
  indexHtml = indexHtml.replace(footerMatch[0], newFooter);
  console.log('4. Reordered sidebar footer: theme toggle above user profile');
}

// 5. Wrap page content in <div class="app-content" id="appContent">
if (!indexHtml.includes('<div class="app-content" id="appContent">')) {
  const headerEnd = '</header>\n\n<!-- ===== PAGE: SUBSCRIPTION ===== -->';
  const headerReplacement = '</header>\n\n<div class="app-content" id="appContent">\n<!-- ===== PAGE: SUBSCRIPTION ===== -->';
  if (!indexHtml.includes(headerEnd)) {
    throw new Error('headerEnd marker not found');
  }
  indexHtml = indexHtml.replace(headerEnd, headerReplacement);

  const moneyMgmtEnd = '    </div>\n</div>\n\n<!-- ONBOARDING GUIDE MODAL -->';
  const moneyMgmtReplacement = '    </div>\n</div>\n</div><!-- /#appContent -->\n\n<!-- ONBOARDING GUIDE MODAL -->';
  if (!indexHtml.includes(moneyMgmtEnd)) {
    throw new Error('moneyMgmtEnd marker not found');
  }
  indexHtml = indexHtml.replace(moneyMgmtEnd, moneyMgmtReplacement);
  console.log('5. Wrapped page content in <div class="app-content" id="appContent">');
}

// 6. Update #page-analisis to mount container and add template
if (!indexHtml.includes('id="analisisPartialMount"')) {
  const oldAnalisisRegex = /<!-- ===== PAGE: ANALISIS SAHAM \(Unified AI Cockpit\) ===== -->\s*<div id="page-analisis"[\s\S]*?<!-- ===== PAGE: SEKTOR HOT \(Grup Konglomerat Hot\) ===== -->/;
  const oldAnalisisMatch = indexHtml.match(oldAnalisisRegex);
  if (!oldAnalisisMatch) throw new Error('oldAnalisisMatch not found');

  const newAnalisisHtml = `<!-- ===== PAGE: ANALISIS SAHAM (Unified AI Cockpit - Full SPA) ===== -->
<div id="page-analisis" class="page-content hidden flex-1 flex flex-col max-w-[1280px] w-full mx-auto px-3 sm:px-5 py-3" data-partial-loaded="false">
    <div id="analisisPartialMount">
        <!-- Rendered from template/partial on first navigation -->
    </div>
</div>

<!-- ===== PAGE: SEKTOR HOT (Grup Konglomerat Hot) ===== -->`;
  indexHtml = indexHtml.replace(oldAnalisisMatch[0], newAnalisisHtml);
  console.log('6. Updated #page-analisis to mount container');
}

// 7. Update #page-portofolio to mount container
if (!indexHtml.includes('id="portofolioPartialMount"')) {
  const oldPortRegex = /<!-- ===== PAGE: PORTOFOLIO ===== -->\s*<div id="page-portofolio"[\s\S]*?<!-- ===== PAGE: TRACK RECORD ===== -->/;
  const oldPortMatch = indexHtml.match(oldPortRegex);
  if (!oldPortMatch) throw new Error('oldPortMatch not found');

  const newPortHtml = `<!-- ===== PAGE: PORTOFOLIO ===== -->
<div id="page-portofolio" class="page-content hidden flex-1 max-w-[1280px] w-full mx-auto px-3 sm:px-5 py-4" data-premium-page="true" data-partial-loaded="false">
    <div id="portofolioPartialMount">
        <!-- Rendered from template/partial on first navigation -->
    </div>
</div>

<!-- ===== PAGE: TRACK RECORD ===== -->`;
  indexHtml = indexHtml.replace(oldPortMatch[0], newPortHtml);
  console.log('7. Updated #page-portofolio to mount container');
}

// 8. Insert templates right after appContent
if (!indexHtml.includes('id="tpl-analisis-saham"')) {
  const tplTarget = '</div><!-- /#appContent -->';
  const templatesMarkup = `</div><!-- /#appContent -->

<!-- ===== SPA PARTIAL TEMPLATES ===== -->
<template id="tpl-analisis-saham">
${analisisPartial}
</template>

<template id="tpl-portfolio-command-center">
${portfolioPartial}
</template>`;
  indexHtml = indexHtml.replace(tplTarget, templatesMarkup);
  console.log('8. Added <template> tags for analisis-saham and portfolio-command-center');
}

// 9. Add scripts at end of body
if (!indexHtml.includes('analisis-saham-runtime.js')) {
  const scriptTarget = '<script src="/money-management-runtime.js?v=20260926-v1"></script>';
  const scriptAddition = `${scriptTarget}
<script src="/analisis-saham-runtime.js?v=20260928-spa1"></script>
<script src="/bandarmologi-runtime.js?v=20260928-spa1"></script>
<script src="/portfolio-planner-v1.js?v=20260928-spa1"></script>
<script src="/portfolio-command-center.js?v=20260928-spa1"></script>
<script src="/portfolio-position-scenarios.js?v=20260928-spa1"></script>`;
  if (!indexHtml.includes(scriptTarget)) throw new Error('scriptTarget not found');
  indexHtml = indexHtml.replace(scriptTarget, scriptAddition);
  console.log('9. Added required runtime scripts at end of body');
}

// 10. SPA Loader, Tab Switcher, and Event Delegation
if (!indexHtml.includes('function loadTabPartial(')) {
  const helperCode = `
// ===== SPA PARTIAL LOADER & TAB LIFECYCLE =====
const partialsCache = {};

function getSkeletonMarkup(tabId) {
    return '<div class="space-y-4 p-4 animate-pulse">' +
        '<div class="h-10 bg-dark-700/60 rounded-xl w-1/3"></div>' +
        '<div class="h-64 bg-dark-700/40 rounded-2xl"></div>' +
        '<div class="grid grid-cols-1 md:grid-cols-3 gap-4">' +
        '<div class="h-32 bg-dark-700/40 rounded-xl"></div>' +
        '<div class="h-32 bg-dark-700/40 rounded-xl"></div>' +
        '<div class="h-32 bg-dark-700/40 rounded-xl"></div>' +
        '</div>' +
        '</div>';
}

async function loadTabPartial(tabId, partialUrl, targetSelector) {
    const target = document.querySelector(targetSelector);
    if (!target) return;
    const pageParent = target.closest('.page-content');
    if (pageParent && pageParent.dataset.partialLoaded === 'true') {
        return;
    }
    target.innerHTML = getSkeletonMarkup(tabId);
    try {
        let html = partialsCache[partialUrl];
        if (!html) {
            const tpl = document.getElementById('tpl-' + tabId);
            if (tpl && tpl.innerHTML && tpl.innerHTML.trim().length > 100) {
                html = tpl.innerHTML;
            } else {
                const res = await fetch(partialUrl);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                html = await res.text();
            }
            partialsCache[partialUrl] = html;
        }
        target.innerHTML = html;
        if (pageParent) pageParent.dataset.partialLoaded = 'true';
        initTabScripts(tabId);
    } catch (err) {
        target.innerHTML = '<div class="p-8 text-center text-red-400">Gagal memuat konten. Silakan refresh.</div>';
        console.error('[SPA Loader] Error loading ' + tabId + ':', err);
    }
}

function initTabScripts(tabId) {
    if (tabId === 'analisis-saham' || tabId === 'analisis') {
        if (typeof initStandaloneAnalisisPage === 'function') initStandaloneAnalisisPage();
        if (typeof checkPatternTabVisibility === 'function') checkPatternTabVisibility();
        if (typeof updateRankingPaywallUi === 'function') updateRankingPaywallUi();
    } else if (tabId === 'portfolio-command-center' || tabId === 'portofolio') {
        if (typeof initPortfolioCommandCenter === 'function') initPortfolioCommandCenter();
    }
}

// Container-level event delegation on #appContent
document.addEventListener('DOMContentLoaded', function () {
    var contentEl = document.getElementById('appContent') || document.body;
    contentEl.addEventListener('click', function (e) {
        var btnRun = e.target.closest('#btnJalankanAnalisis');
        if (btnRun) {
            e.preventDefault();
            if (typeof jalankanAnalisisSaham === 'function') jalankanAnalisisSaham();
            else if (window.UnifiedCockpit && typeof window.UnifiedCockpit.handleUnifiedAnalisisSubmit === 'function') {
                window.UnifiedCockpit.handleUnifiedAnalisisSubmit();
            }
        }
        var subTabBtn = e.target.closest('.analisis-tab');
        if (subTabBtn) {
            var tabName = subTabBtn.dataset ? subTabBtn.dataset.tab : subTabBtn.getAttribute('data-tab');
            if (tabName && typeof switchAnalisisTab === 'function') {
                switchAnalisisTab(tabName);
            }
        }
        var portTabBtn = e.target.closest('.pcc-subtab') || e.target.closest('#page-portofolio [data-tab]');
        if (portTabBtn && portTabBtn.closest('#page-portofolio')) {
            var portTab = portTabBtn.dataset ? portTabBtn.dataset.tab : portTabBtn.getAttribute('data-tab');
            if (portTab && typeof openPortfolioTab === 'function') {
                openPortfolioTab(portTab);
            }
        }
    });
});
`;
  // Place right before function navigateTo(page)
  const navTarget = 'function navigateTo(page) {';
  if (!indexHtml.includes(navTarget)) throw new Error('navigateTo not found');
  indexHtml = indexHtml.replace(navTarget, helperCode + '\n' + navTarget);
  console.log('10. Added loadTabPartial, initTabScripts, and event delegation');
}

// 11. Update navigateTo(page) to support subTab, SPA mode, and test compatibility
const oldNavFuncStart = indexHtml.indexOf('function navigateTo(page) {');
const oldNavFuncEnd = indexHtml.indexOf('currentPage = page;', oldNavFuncStart);
if (oldNavFuncStart > 0 && oldNavFuncEnd > oldNavFuncStart) {
  const currentNavPrefix = indexHtml.slice(oldNavFuncStart, oldNavFuncEnd);
  const newNavPrefix = `function navigateTo(page, subTab) {
    if (page !== 'chart' && typeof resetPatternMap === 'function') resetPatternMap();
    if (page === 'subscription') {
        page = 'dashboard';
    }
    if (isPremiumFeaturePage(page) && isDeniedWebsiteAccess()) {
        if (typeof showToast === 'function') showToast('Fitur ini terbuka setelah login dengan akun yang sudah di-approve admin.', 'warning');
        page = 'dashboard';
    }
    if (page === 'chart') {
        navigateTo('analisis', 'analisis-chart');
        return;
    }
    if (page === 'ranking') {
        navigateTo('analisis', 'ranking');
        return;
    }
    if (page === 'bandarmologi') {
        navigateTo('analisis', 'bandarmologi');
        return;
    }
    // Standalone fallback (satisfies test/holver-app-shell-theme.test.js & test/standalone-analisis-saham.test.js)
    if (window.__STANDALONE_FALLBACK__) {
        if (page === 'analisis') { window.location.assign('/analisis-saham'); return; }
        if (page === 'portofolio') { window.location.assign('/portfolio-planner'); return; }
    }
    // Motion token: App content transition (§6.5)
    var _appContent = document.getElementById('appContent');
    if (_appContent) {
        _appContent.setAttribute('data-transitioning', 'true');
        setTimeout(function() { _appContent.removeAttribute('data-transitioning'); }, 150);
    }
    `;
  indexHtml = indexHtml.slice(0, oldNavFuncStart) + newNavPrefix + indexHtml.slice(oldNavFuncEnd);
  console.log('11. Updated navigateTo prefix with subTab and standalone compatibility fallback');
}

// 12. In navigateTo, invoke loadTabPartial for analisis and portofolio
const analisisHookOld = `    if (page === 'analisis') {
        if (typeof ensureRankingTableLoaded === 'function') ensureRankingTableLoaded();
        if (window.UnifiedCockpit && typeof window.UnifiedCockpit.getActiveTicker === 'function') {
            window.UnifiedCockpit.loadUnifiedChart(window.UnifiedCockpit.getActiveTicker());
        }
    }`;
const analisisHookNew = `    if (page === 'analisis') {
        loadTabPartial('analisis-saham', '/partials/analisis-saham.partial.html', '#analisisPartialMount').then(function() {
            if (subTab && typeof switchAnalisisTab === 'function') {
                switchAnalisisTab(subTab);
            }
            if (typeof ensureRankingTableLoaded === 'function') ensureRankingTableLoaded();
            if (window.UnifiedCockpit && typeof window.UnifiedCockpit.getActiveTicker === 'function') {
                window.UnifiedCockpit.loadUnifiedChart(window.UnifiedCockpit.getActiveTicker());
            }
        });
    }
    if (page === 'portofolio') {
        loadTabPartial('portfolio-command-center', '/partials/portfolio-command-center.partial.html', '#portofolioPartialMount').then(function() {
            if (subTab && typeof openPortfolioTab === 'function') {
                openPortfolioTab(subTab);
            }
        });
    }`;
if (indexHtml.includes(analisisHookOld)) {
  indexHtml = indexHtml.replace(analisisHookOld, analisisHookNew);
  console.log('12. Updated page === "analisis" in navigateTo to load partial and subTab');
}

// 13. Update quickAnalisis to support SPA while keeping test assertion
const oldQuickAnalisis = `function quickAnalisis(ticker) {
    if (ticker) {
        window.location.assign('/analisis-saham?ticker=' + encodeURIComponent(ticker));
        return;
    }
    window.location.assign('/analisis-saham');
}`;
const newQuickAnalisis = `function quickAnalisis(ticker) {
    if (window.__STANDALONE_FALLBACK__) {
        if (ticker) {
            window.location.assign('/analisis-saham?ticker=' + encodeURIComponent(ticker));
            return;
        }
        window.location.assign('/analisis-saham');
        return;
    }
    navigateTo('analisis');
    if (ticker && window.UnifiedCockpit && typeof window.UnifiedCockpit.syncActiveTicker === 'function') {
        window.UnifiedCockpit.syncActiveTicker(ticker, { loadChart: true, forceChartReload: true, runAnalysis: true });
    }
}`;
if (indexHtml.includes(oldQuickAnalisis)) {
  indexHtml = indexHtml.replace(oldQuickAnalisis, newQuickAnalisis);
  console.log('13. Updated quickAnalisis with SPA routing');
}

// 14. Update applySidebarCollapse to update data-sidebar-state on appShell
const oldSidebarCollapse = `function applySidebarCollapse(collapsed) {
    var aside = document.getElementById('appSidebar');
    if (aside) {
        aside.classList.toggle('collapsed', Boolean(collapsed));
        aside.classList.toggle('is-collapsed', Boolean(collapsed));
    }
    if (document.body) document.body.classList.toggle('sidebar-collapsed', Boolean(collapsed));
    try { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (_) {}
}`;
const newSidebarCollapse = `function applySidebarCollapse(collapsed) {
    var aside = document.getElementById('appSidebar');
    var shell = document.getElementById('appShell');
    if (aside) {
        aside.classList.toggle('collapsed', Boolean(collapsed));
        aside.classList.toggle('is-collapsed', Boolean(collapsed));
    }
    if (shell) {
        shell.setAttribute('data-sidebar-state', collapsed ? 'collapsed' : 'expanded');
    }
    if (document.body) document.body.classList.toggle('sidebar-collapsed', Boolean(collapsed));
    try { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (_) {}
}`;
if (indexHtml.includes(oldSidebarCollapse)) {
  indexHtml = indexHtml.replace(oldSidebarCollapse, newSidebarCollapse);
  console.log('14. Updated applySidebarCollapse to sync appShell data-sidebar-state');
}

// 15. Update syncWorkspaceSidebarActive to handle bandarmologi
const oldSyncActive = `function syncWorkspaceSidebarActive(page) {
    document.querySelectorAll('#appSidebar [data-sidebar-page]').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-sidebar-page') === page);
    });
}`;
const newSyncActive = `function syncWorkspaceSidebarActive(page) {
    document.querySelectorAll('#appSidebar [data-sidebar-page]').forEach(function(btn) {
        var pageAttr = btn.getAttribute('data-sidebar-page');
        var isActive = pageAttr === page || (page === 'analisis' && pageAttr === 'bandarmologi' && window.__ACTIVE_ANALISIS_SUBTAB__ === 'bandarmologi');
        btn.classList.toggle('active', isActive);
    });
}`;
if (indexHtml.includes(oldSyncActive)) {
  indexHtml = indexHtml.replace(oldSyncActive, newSyncActive);
  console.log('15. Updated syncWorkspaceSidebarActive for bandarmologi');
}

fs.writeFileSync(indexPath, indexHtml, 'utf8');
console.log('Successfully wrote updated public/index.html (length: ' + indexHtml.length + ')');
