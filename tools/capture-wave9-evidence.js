'use strict';
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots', 'wave9-evidence');
const SCREENSHOT_ROOT_DIR = path.join(ROOT, 'screenshots');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function checkServer(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      resolve(res.statusCode < 500);
    }).on('error', () => {
      resolve(false);
    });
  });
}

async function run() {
  console.log(`[Wave9-Evidence] Checking server at ${BASE_URL}...`);
  const isUp = await checkServer(`${BASE_URL}/`);
  if (!isUp) {
    console.error(`[Wave9-Evidence] Dev server not responding at ${BASE_URL}. Ensure server is running.`);
    process.exit(1);
  }
  console.log('[Wave9-Evidence] Dev server is responding.');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Configure guest mode
    await page.goto(`${BASE_URL}/?module=landing`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (_) {}
      if (typeof window.showLandingPage === 'function') {
        window.showLandingPage({ skipHistory: true });
      }
      const previewBar = document.getElementById('autocuan-preview-bar');
      if (previewBar) previewBar.remove();
      const om = document.getElementById('onboardingModal');
      if (om) om.remove();
    });

    // 1. Programmatic Viewport & Overflow Audit
    console.log('\n--- PROGRAMMATIC VIEWPORT & OVERFLOW AUDIT ---');
    const viewports = [
      { name: 'Mobile 360', width: 360, height: 780 },
      { name: 'Mobile 390', width: 390, height: 844 },
      { name: 'Tablet 768', width: 768, height: 1024 },
      { name: 'Laptop 1280', width: 1280, height: 800 },
      { name: 'Desktop 1440', width: 1440, height: 900 },
      { name: 'Large 1920', width: 1920, height: 1080 }
    ];

    for (const vp of viewports) {
      await page.setViewport({ width: vp.width, height: vp.height });
      await new Promise(r => setTimeout(r, 200));
      const audit = await page.evaluate(() => {
        const docWidth = document.documentElement.clientWidth;
        const scrollWidth = document.documentElement.scrollWidth;
        const bodyScrollWidth = document.body.scrollWidth;
        const overflow = Math.max(scrollWidth, bodyScrollWidth) - docWidth;
        return {
          clientWidth: docWidth,
          scrollWidth: Math.max(scrollWidth, bodyScrollWidth),
          hasOverflow: overflow > 1,
          overflowPx: overflow
        };
      });

      console.log(`[${vp.name}] clientWidth: ${audit.clientWidth}px | scrollWidth: ${audit.scrollWidth}px | overflow: ${audit.overflowPx}px -> ${audit.hasOverflow ? 'FAIL' : 'PASS'}`);
      if (audit.hasOverflow) {
        throw new Error(`Horizontal overflow detected at ${vp.name}: ${audit.overflowPx}px`);
      }
    }

    // 2. Programmatic Tap Target Audit on Mobile 390
    console.log('\n--- TAP TARGET AUDIT (Mobile 390) ---');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    const tapTargetAudit = await page.evaluate(() => {
      const interactive = Array.from(document.querySelectorAll('#landingPage button, #landingPage a[href], #landingPage .landing-cta-btn, #landingPage .landing-preview-tab'));
      const smallTargets = [];
      for (const el of interactive) {
        if (!el.offsetParent) continue; // hidden
        const rect = el.getBoundingClientRect();
        // check if it's an inline link inside text paragraph (allowed to be text height)
        const isInlineTextLink = el.tagName === 'A' && el.closest('p, .landing-card-body, .landing-hero-note, .landing-footer-copy');
        if (isInlineTextLink) continue;
        if (rect.width < 40 || rect.height < 40) {
          smallTargets.push({
            tag: el.tagName,
            text: el.innerText.trim().slice(0, 30),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            id: el.id,
            className: el.className
          });
        }
      }
      return { total: interactive.length, smallTargets };
    });
    console.log(`Total interactive elements evaluated: ${tapTargetAudit.total}`);
    if (tapTargetAudit.smallTargets.length > 0) {
      console.warn(`[Warning] Found ${tapTargetAudit.smallTargets.length} small tap targets:`, tapTargetAudit.smallTargets);
    } else {
      console.log('All interactive buttons/tabs meet tap target standards >= 40-44px.');
    }

    // 3. CAPTURE REQUIRED 5 SCREENSHOTS
    console.log('\n--- CAPTURING WAVE 9 SCREENSHOT EVIDENCE ---');

    async function saveImage(name) {
      const dest1 = path.join(SCREENSHOT_DIR, name);
      const dest2 = path.join(SCREENSHOT_ROOT_DIR, name);
      await page.screenshot({ path: dest1 });
      fs.copyFileSync(dest1, dest2);
      console.log(`[Captured] ${name} -> saved to wave9-evidence & root screenshots`);
    }

    // (1) wave9-landing-desktop-hero-light-1440x900.png
    console.log('1. Capturing Desktop Hero Light (1440x900)...');
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluate(() => {
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('light');
      window.scrollTo(0, 0);
      const pb = document.getElementById('autocuan-preview-bar');
      if (pb) pb.remove();
    });
    await new Promise(r => setTimeout(r, 600));
    await saveImage('wave9-landing-desktop-hero-light-1440x900.png');

    // (2) wave9-landing-desktop-story-light-1440x900.png
    console.log('2. Capturing Desktop Story Light (1440x900)...');
    await page.evaluate(() => {
      const target = document.getElementById('landingMarket') || document.querySelector('.landing-workstation-preview');
      if (target) {
        target.scrollIntoView({ behavior: 'instant', block: 'start' });
      } else {
        window.scrollTo(0, 800);
      }
    });
    await new Promise(r => setTimeout(r, 600));
    await saveImage('wave9-landing-desktop-story-light-1440x900.png');

    // (3) wave9-landing-mobile-hero-light-390x844.png
    console.log('3. Capturing Mobile Hero Light (390x844)...');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await page.evaluate(() => {
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('light');
      window.scrollTo(0, 0);
      const pb = document.getElementById('autocuan-preview-bar');
      if (pb) pb.remove();
    });
    await new Promise(r => setTimeout(r, 600));
    await saveImage('wave9-landing-mobile-hero-light-390x844.png');

    // (4) wave9-landing-mobile-story-light-390x844.png
    console.log('4. Capturing Mobile Story Light (390x844)...');
    await page.evaluate(() => {
      const target = document.getElementById('landingMarket') || document.querySelector('.landing-workstation-preview');
      if (target) {
        target.scrollIntoView({ behavior: 'instant', block: 'start' });
      } else {
        window.scrollTo(0, 900);
      }
    });
    await new Promise(r => setTimeout(r, 600));
    await saveImage('wave9-landing-mobile-story-light-390x844.png');

    // (5) wave9-landing-desktop-dark-1440x900.png
    console.log('5. Capturing Desktop Dark (1440x900)...');
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluate(() => {
      if (typeof window.applyAppTheme === 'function') window.applyAppTheme('dark');
      window.scrollTo(0, 0);
      const pb = document.getElementById('autocuan-preview-bar');
      if (pb) pb.remove();
    });
    await new Promise(r => setTimeout(r, 600));
    await saveImage('wave9-landing-desktop-dark-1440x900.png');

    console.log('\nAll 5 required Wave 9 screenshots captured successfully!');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('[Wave9-Evidence] Error:', err);
  process.exit(1);
});
