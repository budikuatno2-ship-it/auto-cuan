/**
 * Auto-Cuan UI Audit Screenshot Capture Script
 * Captures screenshots of all UI elements for comprehensive audit documentation
 * 
 * Usage: node tools/audit-screenshot-capture.js
 * Requires: Puppeteer (already in devDependencies)
 * Target: http://127.0.0.1:3000 (local dev server running)
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Configuration
const BASE_URL = 'http://127.0.0.1:3000';
const SCREENSHOT_DIR = path.join(__dirname, '..', 'docs', 'audit-screenshots');
const DELAY_MS = 2000; // Wait time between actions
const VIEWPORT = { width: 1920, height: 1080 };

// Screenshot targets based on audit catalog
const SCREENSHOT_CATALOG = {
    landing: [
        { name: 'landing-page-hero', description: 'Landing page hero section with CTA' },
        { name: 'landing-page-features', description: 'Landing page features grid' },
        { name: 'landing-page-safety', description: 'Landing page safety disclaimers' },
        { name: 'landing-page-footer', description: 'Landing page footer' }
    ],
    auth: [
        { name: 'auth-choice-modal', description: 'Auth choice modal with login/register options' },
        { name: 'login-modal', description: 'Login modal form' },
        { name: 'register-modal', description: 'Register modal form' }
    ],
    appShell: [
        { name: 'sidebar-expanded-240px', description: 'Sidebar in expanded state (240px)' },
        { name: 'sidebar-collapsed-72px', description: 'Sidebar in collapsed state (72px)' },
        { name: 'sidebar-footer-profile', description: 'Sidebar footer with user profile' },
        { name: 'dark-mode-sidebar', description: 'App shell in dark mode' },
        { name: 'header-area', description: 'Header area with navigation' }
    ],
    analisisSaham: [
        { name: 'analisis-chart-tab', description: 'Analisis & Chart sub-tab' },
        { name: 'bandarmologi-tab', description: 'Bandarmologi sub-tab' },
        { name: 'signals-intel-tab', description: 'Sinyal Intelijen sub-tab' },
        { name: 'broker-hunter-tab', description: 'Broker Hunter sub-tab' },
        { name: 'insider-network-tab', description: 'Jejaring Insider sub-tab' },
        { name: 'ranking-daily-tab', description: 'Ranking Harian sub-tab' },
        { name: 'pattern-radar-tab', description: 'Pattern Radar sub-tab' }
    ],
    portfolio: [
        { name: 'portfolio-today-tab', description: 'Hari Ini sub-tab' },
        { name: 'position-plans-tab', description: 'Rencana Posisi sub-tab' },
        { name: 'portfolio-watchlist-tab', description: 'Pantauan sub-tab' },
        { name: 'risk-management-tab', description: 'Risiko & Avg Down sub-tab' },
        { name: 'position-scenarios-tab', description: 'Skenario Posisi sub-tab' },
        { name: 'portfolio-journal-tab', description: 'Jurnal sub-tab' },
        { name: 'portfolio-ai-tab', description: 'Asisten AI sub-tab' }
    ],
    otherTabs: [
        { name: 'sektor-hot-page', description: 'Sektor Hot page' },
        { name: 'screener-page', description: 'Screener page' },
        { name: 'watchlist-page', description: 'Watchlist page' },
        { name: 'track-record-page', description: 'Track Record page' },
        { name: 'macro-deepscan-page', description: 'Macro DeepScan page' },
        { name: 'kelola-keuangan-page', description: 'Kelola Keuangan page' }
    ]
};

/**
 * Create directory structure for screenshots
 */
function createScreenshotDirectories() {
    console.log('📁 Creating screenshot directory structure...');
    
    const folders = ['landing', 'auth', 'app-shell', 'analisis-saham', 'portfolio', 'other-tabs'];
    
    folders.forEach(folder => {
        const folderPath = path.join(SCREENSHOT_DIR, folder);
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
            console.log(`  ✅ Created: ${folder}`);
        } else {
            console.log(`  ⚠️  Already exists: ${folder}`);
        }
    });
    
    console.log('📁 Directory structure ready.\n');
}

/**
 * Take screenshot with error handling
 */
async function takeScreenshot(page, screenshotPath, description) {
    try {
        await page.screenshot({ 
            path: screenshotPath, 
            fullPage: true,
            timeout: 10000 
        });
        console.log(`  ✅ ${description}`);
        return true;
    } catch (error) {
        console.error(`  ❌ ${description}: ${error.message}`);
        return false;
    }
}

/**
 * Wait for page to fully load
 */
async function waitForPageLoad(page) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Simple 2 second wait
}

/**
 * Main screenshot capture function
 */
async function captureScreenshots() {
    console.log('🚀 Starting Auto-Cuan UI Audit Screenshot Capture\n');
    console.log(`📍 Target URL: ${BASE_URL}`);
    console.log(`📂 Output Directory: ${SCREENSHOT_DIR}\n`);
    
    // Create directories
    createScreenshotDirectories();
    
    let browser;
    let successCount = 0;
    let totalCount = 0;
    
    try {
        // Launch browser
        console.log('🌐 Launching browser...');
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        
        const page = await browser.newPage();
        await page.setViewport(VIEWPORT);
        
        console.log('✅ Browser launched successfully\n');
        
        // ============================================
        // 1. LANDING PAGE SCREENSHOTS
        // ============================================
        console.log('📸 CAPTURING: Landing Page');
        console.log('─'.repeat(50));
        
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
        await waitForPageLoad(page);
        
        // Scroll through landing page and capture sections
        for (const screenshot of SCREENSHOT_CATALOG.landing) {
            const screenshotPath = path.join(SCREENSHOT_DIR, 'landing', `${screenshot.name}.png`);
            await takeScreenshot(page, screenshotPath, screenshot.description);
            await page.evaluate(() => window.scrollBy(0, 500));
            await new Promise(resolve => setTimeout(resolve, 500));
            totalCount++;
        }
        
        // ============================================
        // 2. AUTH MODAL SCREENSHOTS  
        // ============================================
        console.log('\n📸 CAPTURING: Authentication Modals');
        console.log('─'.repeat(50));
        
        // Capture auth choice modal
        await page.evaluate(() => {
            if (typeof showAuthChoiceModal === 'function') {
                showAuthChoiceModal();
            }
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const authChoicePath = path.join(SCREENSHOT_DIR, 'auth', 'auth-choice-modal.png');
        await takeScreenshot(page, authChoicePath, 'Auth choice modal');
        totalCount++;
        
        // Open login modal
        await page.evaluate(() => {
            if (typeof openLoginModal === 'function') {
                openLoginModal();
            }
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const loginPath = path.join(SCREENSHOT_DIR, 'auth', 'login-modal.png');
        await takeScreenshot(page, loginPath, 'Login modal');
        totalCount++;
        
        // Close and open register modal
        await page.evaluate(() => {
            if (typeof closeLoginModal === 'function') {
                closeLoginModal();
            }
            setTimeout(() => {
                if (typeof openRegisterModal === 'function') {
                    openRegisterModal();
                }
            }, 500);
        });
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const registerPath = path.join(SCREENSHOT_DIR, 'auth', 'register-modal.png');
        await takeScreenshot(page, registerPath, 'Register modal');
        totalCount++;
        
        // Close modals
        await page.evaluate(() => {
            if (typeof closeRegisterModal === 'function') {
                closeRegisterModal();
            }
        });
        
        // ============================================
        // 3. APP SHELL SCREENSHOTS (requires login simulation)
        // ============================================
        console.log('\n📸 CAPTURING: App Shell States');
        console.log('─'.repeat(50));
        
        // Simulate logged-in state for app shell screenshots
        await page.evaluate(() => {
            // Simulate user being logged in
            localStorage.setItem('autocuan_user', JSON.stringify({
                username: 'budi',
                role: 'ADMIN',
                sessionToken: 'audit-test-session'
            }));
            localStorage.setItem('autocuan_theme', 'dark');
        });
        
        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
        await waitForPageLoad(page);
        
        // Wait for sidebar to be visible
        await page.waitForSelector('#appSidebar', { timeout: 5000 }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Capture expanded sidebar
        const expandedPath = path.join(SCREENSHOT_DIR, 'app-shell', 'sidebar-expanded-240px.png');
        await takeScreenshot(page, expandedPath, 'Sidebar expanded (240px)');
        totalCount++;
        
        // Toggle sidebar collapse
        await page.evaluate(() => {
            if (typeof toggleSidebarCollapse === 'function') {
                toggleSidebarCollapse();
            }
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Capture collapsed sidebar
        const collapsedPath = path.join(SCREENSHOT_DIR, 'app-shell', 'sidebar-collapsed-72px.png');
        await takeScreenshot(page, collapsedPath, 'Sidebar collapsed (72px)');
        totalCount++;
        
        // Restore expanded and capture footer
        await page.evaluate(() => {
            if (typeof toggleSidebarCollapse === 'function') {
                toggleSidebarCollapse();
            }
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const footerPath = path.join(SCREENSHOT_DIR, 'app-shell', 'sidebar-footer-profile.png');
        await takeScreenshot(page, footerPath, 'Sidebar footer with user profile');
        totalCount++;
        
        // Capture dark mode header
        const headerPath = path.join(SCREENSHOT_DIR, 'app-shell', 'header-area.png');
        await takeScreenshot(page, headerPath, 'Header area');
        totalCount++;
        
        // ============================================
        // 4. ANALISIS SAHAM SCREENSHOTS (Standalone Page)
        // ============================================
        console.log('\n📸 CAPTURING: Analisis Saham (Standalone Page)');
        console.log('─'.repeat(50));
        
        await page.goto(`${BASE_URL}/analisis-saham`, { waitUntil: 'domcontentloaded' });
        await waitForPageLoad(page);
        
        // Wait for page content
        await page.waitForSelector('.analisis-tab-strip', { timeout: 5000 }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Capture each sub-tab
        const analisisTabs = [
            'tabAnalisisChart',
            'tabBandarmologi', 
            'tabSinyalIntelijen',
            'tabBrokerHunter',
            'tabJejaringInsider',
            'tabRankingHarian',
            'tabAnalisisPattern'
        ];
        
        for (let i = 0; i < SCREENSHOT_CATALOG.analisisSaham.length && i < analisisTabs.length; i++) {
            const tabButtonId = analisisTabs[i];
            const screenshot = SCREENSHOT_CATALOG.analisisSaham[i];
            
            // Click tab
            await page.evaluate((id) => {
                const button = document.getElementById(id);
                if (button) button.click();
            }, tabButtonId);
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const screenshotPath = path.join(SCREENSHOT_DIR, 'analisis-saham', `${screenshot.name}.png`);
            await takeScreenshot(page, screenshotPath, screenshot.description);
            totalCount++;
        }
        
        // ============================================
        // 5. PORTFOLIO COMMAND CENTER SCREENSHOTS (Standalone Page)
        // ============================================
        console.log('\n📸 CAPTURING: Portfolio Command Center (Standalone Page)');
        console.log('─'.repeat(50));
        
        await page.goto(`${BASE_URL}/portfolio-command-center`, { waitUntil: 'domcontentloaded' });
        await waitForPageLoad(page);
        
        // Wait for app to be visible
        await page.waitForSelector('#app', { timeout: 5000 }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Make app visible (it starts hidden for auth check)
        await page.evaluate(() => {
            document.getElementById('app')?.classList.remove('hidden');
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Capture each sub-tab
        const portfolioTabs = [
            'page-today',
            'page-planner',
            'page-watch',
            'page-risk',
            'page-scenarios',
            'page-journal',
            'page-ai'
        ];
        
        for (let i = 0; i < SCREENSHOT_CATALOG.portfolio.length && i < portfolioTabs.length; i++) {
            const pageId = portfolioTabs[i];
            const screenshot = SCREENSHOT_CATALOG.portfolio[i];
            
            // Click tab
            await page.evaluate((id) => {
                const button = document.querySelector(`[data-tab="${id.replace('page-', '')}"]`);
                if (button) button.click();
            }, pageId);
            
            await page.waitForTimeout(1000);
            
            const screenshotPath = path.join(SCREENSHOT_DIR, 'portfolio', `${screenshot.name}.png`);
            await takeScreenshot(page, screenshotPath, screenshot.description);
            totalCount++;
        }
        
        // ============================================
        // 6. OTHER TABS SCREENSHOTS (Inside App Shell)
        // ============================================
        console.log('\n📸 CAPTURING: Other Dashboard Tabs');
        console.log('─'.repeat(50));
        
        await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
        await waitForPageLoad(page);
        
        const otherTabFunctions = [
            { name: 'sektor', screenshot: SCREENSHOT_CATALOG.otherTabs[0] },
            { name: 'screener', screenshot: SCREENSHOT_CATALOG.otherTabs[1] },
            { name: 'watchlist', screenshot: SCREENSHOT_CATALOG.otherTabs[2] },
            { name: 'trackrecord', screenshot: SCREENSHOT_CATALOG.otherTabs[3] },
            { name: 'deepscan', screenshot: SCREENSHOT_CATALOG.otherTabs[4] },
            { name: 'money-management', screenshot: SCREENSHOT_CATALOG.otherTabs[5] }
        ];
        
        for (const tabInfo of otherTabFunctions) {
            // Navigate to tab
            await page.evaluate((pageName) => {
                if (typeof navigateTo === 'function') {
                    navigateTo(pageName);
                }
            }, tabInfo.name);
            
            await page.waitForTimeout(2000);
            
            const screenshotPath = path.join(SCREENSHOT_DIR, 'other-tabs', `${tabInfo.screenshot.name}.png`);
            await takeScreenshot(page, screenshotPath, tabInfo.screenshot.description);
            totalCount++;
        }
        
        console.log('\n' + '═'.repeat(50));
        console.log('🎉 SCREENSHOT CAPTURE COMPLETE!');
        console.log('═'.repeat(50));
        console.log(`📊 Total screenshots captured: ${totalCount}`);
        console.log(`📂 Output directory: ${SCREENSHOT_DIR}`);
        console.log('\n📋 Next steps:');
        console.log('1. Review screenshots in docs/audit-screenshots/');
        console.log('2. Update AUDIT-INVENTARIS-FITUR-DAN-UI.md with screenshot filenames');
        console.log('3. Proceed with implementation planning\n');
        
    } catch (error) {
        console.error('\n❌ ERROR during screenshot capture:', error);
        console.error(error.stack);
    } finally {
        if (browser) {
            await browser.close();
            console.log('🌐 Browser closed.');
        }
    }
}

// Execute the capture script
captureScreenshots().catch(console.error);
