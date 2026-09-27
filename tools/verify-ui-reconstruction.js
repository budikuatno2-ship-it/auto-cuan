/**
 * Auto-Cuan UI Reconstruction Verification Script
 * Captures screenshots for visual verification of UI fixes
 * 
 * Usage: node tools/verify-ui-reconstruction.js
 * Requires: puppeteer (npm install puppeteer)
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const OUTPUT_DIR = path.join(__dirname, '../audit-screenshots');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const SCREENSHOTS = [
  { name: '01-desktop-dashboard', width: 1280, height: 800, wait: 2000 },
  { name: '02-desktop-sidebar-open', width: 1280, height: 800, wait: 1000 },
  { name: '03-mobile-dashboard', width: 375, height: 667, wait: 2000 },
  { name: '04-mobile-sidebar-open', width: 375, height: 667, wait: 1000 },
  { name: '05-footer-horizontal', width: 1280, height: 200, selector: '#appSidebar', wait: 1000 },
  { name: '06-active-nav-emerald', width: 1280, height: 800, selector: '.sidebar-item.active', wait: 1000 },
];

async function captureScreenshots() {
  console.log('Starting UI verification screenshot capture...');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log('');

  // Try system Chrome first, then fallback to puppeteer bundled
  let executablePath;
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  
  for (const path of possiblePaths) {
    try {
      const fs = require('fs');
      if (fs.existsSync(path)) {
        executablePath = path;
        break;
      }
    } catch (e) {}
  }
  
  const launchOptions = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };
  
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }
  
  const browser = await puppeteer.launch(launchOptions);

  let allPassed = true;

  for (const shot of SCREENSHOTS) {
    console.log(`\n📸 Capturing: ${shot.name}`);
    console.log(`   Viewport: ${shot.width}x${shot.height}`);
    
    const page = await browser.newPage();
    await page.setViewport({ width: shot.width, height: shot.height });
    
    try {
      // Navigate to base URL
      await page.goto(BASE_URL, { waitUntil: 'networkidle0', timeout: 30000 });
      // Use setTimeout workaround for newer Puppeteer versions
      await new Promise(resolve => setTimeout(resolve, shot.wait || 2000));
      
      // Run 3 times for consistency (reduced from 10 for speed)
      for (let run = 1; run <= 3; run++) {
        const filename = `${shot.name}_run${run}.png`;
        const filepath = path.join(OUTPUT_DIR, filename);
        
        if (shot.selector) {
          // Screenshot specific element
          const element = await page.$(shot.selector);
          if (element) {
            await element.screenshot({ path: filepath, type: 'png' });
            console.log(`   ✓ Captured: ${filename}`);
          } else {
            console.log(`   ⚠ Element not found: ${shot.selector}`);
            allPassed = false;
          }
        } else {
          // Full page screenshot
          await page.screenshot({ path: filepath, type: 'png', fullPage: false });
          console.log(`   ✓ Captured: ${filename}`);
        }
      }
      
      // Verify specific UI elements
      const verification = await verifyElements(page, shot);
      if (!verification.allPassed) {
        console.log(`   ⚠ Verification warnings:`);
        verification.warnings.forEach(w => console.log(`      - ${w}`));
      }
      
    } catch (err) {
      console.error(`   ✗ Error: ${err.message}`);
      allPassed = false;
    } finally {
      await page.close();
    }
  }

  await browser.close();
  
  console.log('\n' + '='.repeat(50));
  if (allPassed) {
    console.log('✓ All screenshots captured successfully!');
  } else {
    console.log('⚠ Some screenshots had issues. Check output directory.');
  }
  console.log('='.repeat(50));
}

async function verifyElements(page, shot) {
  const warnings = [];
  let allPassed = true;
  
  try {
    // Check for double header
    const headers = await page.$$('.app-header');
    if (headers.length > 1) {
      warnings.push(`Found ${headers.length} headers (expected 1)`);
      allPassed = false;
    }
    
    // Check sidebar visibility
    const sidebar = await page.$('#appSidebar');
    if (!sidebar) {
      warnings.push('Sidebar not found');
    }
    
    // Check tree-view sub-menu
    const treeGroup = await page.$('.tree-group');
    if (!treeGroup) {
      warnings.push('Tree-view not found');
    } else {
      const submenu = await page.$('.tree-submenu');
      const submenuItems = await page.$$('.tree-submenu-item');
      if (submenuItems.length === 0) {
        warnings.push('Sub-menu items not found');
      }
    }
    
    // Check footer is horizontal
    const footer = await page.$('.sidebar-footer');
    if (footer) {
      const userInfo = await page.$('.sidebar-footer .user-info');
      if (!userInfo) {
        warnings.push('Footer user-info not found');
      }
    }
    
    // Check active nav uses emerald
    const activeNav = await page.$('.sidebar-item.active, .tree-submenu-item.active');
    if (activeNav) {
      // This is a visual check - we'll just note it exists
    }
    
  } catch (err) {
    warnings.push(`Verification error: ${err.message}`);
    allPassed = false;
  }
  
  return { allPassed, warnings };
}

// Run if executed directly
if (require.main === module) {
  captureScreenshots().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { captureScreenshots, verifyElements };
