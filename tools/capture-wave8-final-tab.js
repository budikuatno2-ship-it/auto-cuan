'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT_DIR = path.resolve(__dirname, '..');
const VERIFIED_ORIGIN = 'http://127.0.0.1:3000';
const OUT_DIRS = [
  path.join(ROOT_DIR, 'screenshots'),
  path.join(ROOT_DIR)
];

async function run() {
  console.log('=== WAVE 8 FINAL MOBILE TAB FIX VERIFICATION & CAPTURE ===');
  console.log('Verified Origin:', VERIFIED_ORIGIN);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.warn('  Browser Console Error:', msg.text());
    });

    // Viewport 390x844
    console.log('\n[1/3] Loading Account Center at 390x844...');
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(VERIFIED_ORIGIN + '/', { waitUntil: 'networkidle2' });

    await page.evaluate(async () => {
      if (typeof applyAppTheme === 'function') applyAppTheme('light');
      if (typeof openAccountProfile === 'function') {
        await openAccountProfile();
      }
    });

    await page.waitForSelector('#acAccountCenter:not([hidden])', { timeout: 8000 });
    await new Promise(r => setTimeout(r, 600));

    // Verify all 3 tabs are completely visible and within viewport
    console.log('\n[2/3] Verifying all three tabs discoverability, geometry and touch targets...');
    const tabMetrics = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('#acAccountCenter .ac-center-tab'));
      const closeBtn = document.querySelector('#acAccountCenter .ac-center-close');
      const closeComp = window.getComputedStyle(closeBtn);
      const closeRect = closeBtn.getBoundingClientRect();
      const shell = document.querySelector('#acAccountCenter .ac-center-shell');
      const shellRect = shell.getBoundingClientRect();

      return {
        tabs: tabs.map(t => {
          const rect = t.getBoundingClientRect();
          return {
            text: t.innerText.trim(),
            rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
            insideShell: rect.left >= shellRect.left - 2 && rect.right <= shellRect.right + 2,
            insideViewport: rect.left >= 0 && rect.right <= window.innerWidth,
            height: rect.height
          };
        }),
        closeTapTarget: {
          w: closeRect.width,
          h: closeRect.height,
          minW: closeComp.minWidth,
          minH: closeComp.minHeight
        },
        hasHorizontalOverflow: shell.scrollWidth > window.innerWidth
      };
    });

    console.log('  Tabs inspection:', JSON.stringify(tabMetrics.tabs, null, 2));
    assert.strictEqual(tabMetrics.tabs.length, 3, 'Must have exactly 3 tabs');

    tabMetrics.tabs.forEach((t, i) => {
      assert.ok(t.insideViewport, `Tab ${i} ("${t.text}") must be completely inside viewport (right: ${t.rect.right} <= ${390})`);
      assert.ok(t.insideShell, `Tab ${i} ("${t.text}") must be completely inside shell bounds`);
      assert.ok(t.height >= 43.5, `Tab ${i} ("${t.text}") must meet 44px tap target height (got ${t.height})`);
      console.log(`  ✓ Tab ${i + 1} ("${t.text}"): 100% visible, inside viewport, height = ${t.height}px`);
    });

    assert.ok(!tabMetrics.hasHorizontalOverflow, 'Must have no horizontal scroll overflow in Account Center');
    assert.ok(tabMetrics.closeTapTarget.minW === '44px' && tabMetrics.closeTapTarget.minH === '44px', 'Close button must have 44px min tap target');
    console.log('  ✓ Close button 44px tap target verified');

    // Check at 360px
    console.log('\n[3/3] Testing at 360px viewport width...');
    await page.setViewport({ width: 360, height: 740 });
    await new Promise(r => setTimeout(r, 400));
    const check360 = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('#acAccountCenter .ac-center-tab'));
      const shell = document.querySelector('#acAccountCenter .ac-center-shell');
      return {
        allInsideViewport: tabs.every(t => {
          const r = t.getBoundingClientRect();
          return r.left >= 0 && r.right <= window.innerWidth;
        }),
        noOverflow: shell.scrollWidth <= window.innerWidth + 2
      };
    });
    assert.ok(check360.allInsideViewport, 'All 3 tabs must remain inside 360px viewport');
    assert.ok(check360.noOverflow, 'No horizontal overflow at 360px');
    console.log('  ✓ 360px check PASS: all 3 tabs visible, zero overflow');

    // Switch back to 390x844 for the final required screenshot
    await page.setViewport({ width: 390, height: 844 });
    await new Promise(r => setTimeout(r, 400));

    const finalFilename = 'wave8-final-account-center-mobile-390x844.png';
    for (const dir of OUT_DIRS) {
      const dest = path.join(dir, finalFilename);
      await page.screenshot({ path: dest });
      console.log('  Saved required screenshot:', dest);
    }

    await page.close();
  } finally {
    await browser.close();
  }

  console.log('\n=== WAVE 8 FINAL MOBILE TAB FIX VERIFIED SUCCESSFULLY ===');
}

run().catch(err => {
  console.error('\nVERIFICATION FAILED:', err);
  process.exit(1);
});
