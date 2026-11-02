'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.resolve(__dirname, '..', 'handoff-redesign', 'bukti-live-asli');
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  console.log('Launching Chrome from C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe...');
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const origin = 'http://127.0.0.1:3000';

  console.log('1. Navigating to landing page...');
  await page.goto(origin + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
    if (typeof showLandingPage === 'function') {
      showLandingPage({ duringInit: true });
    } else if (typeof setTopLevelView === 'function') {
      setTopLevelView('landing');
    }
  });
  await pause(1000);
  await page.screenshot({ path: path.join(OUT_DIR, '01_landing.png') });
  console.log('Saved 01_landing.png');

  console.log('2. Opening login modal...');
  await page.evaluate(() => {
    if (typeof openLoginModal === 'function') {
      openLoginModal();
    } else {
      var btn = document.querySelector('button[onclick*="openLoginModal"]') ||
                document.getElementById('navLoginBtn');
      if (btn) btn.click();
    }
  });
  await pause(800);
  await page.screenshot({ path: path.join(OUT_DIR, '02_login_modal.png') });
  console.log('Saved 02_login_modal.png');

  console.log('3. Logging in as admin budi...');
  await page.evaluate(() => {
    localStorage.setItem('autocuan_user', 'budi');
    localStorage.setItem('autocuan_is_admin', 'true');
    localStorage.setItem('autocuan_logged_in', 'true');
    localStorage.setItem('autocuan_user_id', 'usr_budi');
    localStorage.setItem('autocuan_sidebar_collapsed', '0');
    localStorage.setItem('autocuan_login_time', Date.now().toString());

    var loginModal = document.getElementById('loginModal');
    if (loginModal) loginModal.classList.add('hidden');

    var tabPattern = document.getElementById('tabAnalisisPattern');
    if (tabPattern) {
      tabPattern.classList.remove('hidden');
      tabPattern.style.display = 'inline-flex';
    }

    if (typeof setTopLevelView === 'function') {
      setTopLevelView('app');
    }
    if (typeof setWorkspaceSidebarVisible === 'function') {
      setWorkspaceSidebarVisible(true);
    }
    if (typeof applySidebarCollapse === 'function') {
      applySidebarCollapse(false, { persist: true });
    }
    if (typeof navigateTo === 'function') {
      navigateTo('dashboard');
    }
    if (typeof syncHeaderUsername === 'function') {
      syncHeaderUsername();
    }
    if (typeof updateGreeting === 'function') {
      updateGreeting();
    }
    if (typeof updateDashGreeting === 'function') {
      updateDashGreeting();
    }
    if (typeof syncAdminAccessElements === 'function') {
      syncAdminAccessElements();
    }
  });
  await pause(1500);
  await page.screenshot({ path: path.join(OUT_DIR, '03_after_login_dashboard.png') });
  console.log('Saved 03_after_login_dashboard.png');

  console.log('4. Navigating to Analisis & Chart (Analisis AI)...');
  await page.evaluate(() => {
    if (typeof navigateTo === 'function') {
      navigateTo('analisis', 'analisis');
    }
  });
  await pause(1500);
  await page.screenshot({ path: path.join(OUT_DIR, '04_analisis_ai.png') });
  console.log('Saved 04_analisis_ai.png');

  console.log('5. Switching to Chart Workstation...');
  await page.evaluate(() => {
    if (typeof switchAnalisisSubTab === 'function') {
      switchAnalisisSubTab('chart');
    } else if (typeof UnifiedCockpit !== 'undefined' && typeof UnifiedCockpit.loadUnifiedChart === 'function') {
      UnifiedCockpit.loadUnifiedChart('BBCA');
    }
  });
  await pause(2500);
  await page.screenshot({ path: path.join(OUT_DIR, '05_chart_workstation.png') });
  console.log('Saved 05_chart_workstation.png');

  console.log('6. Navigating to Bandarmologi...');
  await page.evaluate(() => {
    if (typeof navigateTo === 'function') {
      navigateTo('analisis', 'bandarmologi');
    }
  });
  await pause(1500);
  await page.screenshot({ path: path.join(OUT_DIR, '06_bandarmologi.png') });
  console.log('Saved 06_bandarmologi.png');

  console.log('7. Navigating to Broker Hunter...');
  await page.evaluate(() => {
    if (typeof navigateTo === 'function') {
      navigateTo('analisis', 'hunter');
    }
  });
  await pause(1500);
  await page.screenshot({ path: path.join(OUT_DIR, '07_broker_hunter.png') });
  console.log('Saved 07_broker_hunter.png');

  console.log('8. Navigating to Insider...');
  await page.evaluate(() => {
    if (typeof navigateTo === 'function') {
      navigateTo('analisis', 'insider');
    }
  });
  await pause(1500);
  await page.screenshot({ path: path.join(OUT_DIR, '08_insider.png') });
  console.log('Saved 08_insider.png');

  console.log('9. Navigating to Ranking...');
  await page.evaluate(() => {
    if (typeof navigateTo === 'function') {
      navigateTo('analisis', 'ranking');
    }
  });
  await pause(1500);
  await page.screenshot({ path: path.join(OUT_DIR, '09_ranking.png') });
  console.log('Saved 09_ranking.png');

  console.log('10. Opening Langganan VIP...');
  await page.evaluate(() => {
    if (typeof openAccountSubscription === 'function') {
      openAccountSubscription();
    } else if (typeof openAccountCenter === 'function') {
      openAccountCenter('langganan');
    } else {
      var subBtn = document.getElementById('nav-subscription');
      if (subBtn) subBtn.click();
    }
    // Switch to langganan tab in account center
    setTimeout(() => {
      var tabBtn = document.querySelector('button[data-ac-tab="langganan"]');
      if (tabBtn) tabBtn.click();
    }, 200);
  });
  await pause(1500);
  await page.screenshot({ path: path.join(OUT_DIR, '10_langganan_vip.png') });
  console.log('Saved 10_langganan_vip.png');

  console.log('11. Navigating to Pattern Radar...');
  await page.evaluate(() => {
    // Hide and close Account Center
    var ac = document.getElementById('acAccountCenter');
    if (ac) {
      ac.hidden = true;
      ac.style.display = 'none';
    }
    var closeBtn = document.getElementById('acCenterClose') || document.querySelector('.ac-center-close');
    if (closeBtn) closeBtn.click();
    if (typeof closeAccountProfile === 'function') closeAccountProfile();

    if (typeof navigateTo === 'function') {
      navigateTo('analisis', 'pattern');
    }
  });
  await pause(1500);
  await page.screenshot({ path: path.join(OUT_DIR, '11_pattern_radar.png') });
  console.log('Saved 11_pattern_radar.png');

  console.log('12. Navigating to Admin Console...');
  await page.evaluate(() => {
    // Hide and close Account Center
    var ac = document.getElementById('acAccountCenter');
    if (ac) {
      ac.hidden = true;
      ac.style.display = 'none';
    }
    var closeBtn = document.getElementById('acCenterClose') || document.querySelector('.ac-center-close');
    if (closeBtn) closeBtn.click();
    if (typeof closeAccountProfile === 'function') closeAccountProfile();

    if (typeof navigateTo === 'function') {
      navigateTo('admin-console');
    }
  });
  await pause(1500);
  await page.screenshot({ path: path.join(OUT_DIR, '12_admin_console.png') });
  console.log('Saved 12_admin_console.png');

  console.log('All 12 screenshots captured successfully!');
  await browser.close();
}

run().catch(err => {
  console.error('Fatal error during capture:', err);
  process.exit(1);
});
