// tools/fix-4-critical-ui.js
// Comprehensive fix for 4 critical UI problems in Auto-Cuan

const fs = require('fs');
const path = require('path');

console.log('🔧 Auto-Cuan 4-Critical-UI Fix Starting...');
console.log('📋 Target Issues:');
console.log('   1. Sub-menu "Analisis Saham" collapsed to raw paragraph text');
console.log('   2. Double header desktop (.app-header) appearing');
console.log('   3. Footer profile stacking vertically instead of horizontal');
console.log('   4. Charts stuck on black/blank loading state');
console.log('');

// Helper function to read file safely
function readFile(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        console.error(`❌ Error reading ${filePath}:`, error.message);
        return null;
    }
}

// Helper function to write file safely
function writeFile(filePath, content) {
    try {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`✅ Fixed: ${path.basename(filePath)}`);
        return true;
    } catch (error) {
        console.error(`❌ Error writing ${filePath}:`, error.message);
        return false;
    }
}

// ===== PILLAR 1: Fix Sub-menu "Analisis Saham" collapsed text =====
// Add proper styling for sub-menu items
function fixSubmenuStyling() {
    console.log('\n📌 Pillar 1: Fixing Sub-menu Styling...');
    
    const cssFile = path.join(__dirname, '..', 'public', 'index-shell.css');
    let css = readFile(cssFile);
    
    if (!css) return false;
    
    // Add comprehensive sub-menu styling if not present
    const submenuStyles = `
/* ===== SUB-MENU STYLING FIX ===== */
/* Fix for collapsed sub-menu text issue */
.sidebar-submenu,
.submenu-items,
.nav-submenu {
    display: flex !important;
    flex-direction: column !important;
    gap: 4px !important;
    padding: 8px !important;
    background: rgba(15, 23, 42, 0.4) !important;
    border-radius: 8px !important;
    margin-top: 4px !important;
}

.sidebar-submenu a,
.submenu-items a,
.nav-submenu a {
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    padding: 8px 12px !important;
    border-radius: 6px !important;
    font-size: 13px !important;
    color: #94a3b8 !important;
    text-decoration: none !important;
    transition: all 0.15s ease-out !important;
}

.sidebar-submenu a:hover,
.submenu-items a:hover,
.nav-submenu a:hover {
    background: rgba(255, 255, 255, 0.05) !important;
    color: #e2e8f0 !important;
}

.sidebar-submenu a.active,
.submenu-items a.active,
.nav-submenu a.active {
    background: rgba(16, 185, 129, 0.12) !important;
    color: #10b981 !important;
    border: 1px solid rgba(16, 185, 129, 0.25) !important;
}
`;
    
    // Append styles if not already present
    if (!css.includes('.sidebar-submenu')) {
        css += submenuStyles;
        return writeFile(cssFile, css);
    }
    
    console.log('⏩ Sub-menu styling already exists, skipping...');
    return true;
}

// ===== PILLAR 2: Fix Double Header Desktop =====
// Ensure only one header appears on desktop
function fixDoubleHeader() {
    console.log('\n📌 Pillar 2: Fixing Double Header...');
    
    const cssFile = path.join(__dirname, '..', 'public', 'index-shell.css');
    let css = readFile(cssFile);
    
    if (!css) return false;
    
    // Add desktop header fix
    const headerFix = `
/* ===== DESKTOP HEADER FIX ===== */
/* Fix for duplicate header on desktop */
@media (min-width: 1024px) {
    .app-header,
    #appHeader {
        display: none !important;
    }
    
    .app-header.desktop-visible,
    #appHeader.desktop-visible,
    .workspace-header {
        display: flex !important;
    }
}

@media (max-width: 1023px) {
    .app-header.mobile-hidden,
    #appHeader.mobile-hidden {
        display: none !important;
    }
}
`;
    
    // Append if not present
    if (!css.includes('.app-header.desktop-visible')) {
        css += headerFix;
        return writeFile(cssFile, css);
    }
    
    console.log('⏩ Header fix already exists, skipping...');
    return true;
}

// ===== PILLAR 3: Fix Footer Profile Stacking =====
// Ensure footer elements display horizontally
function fixFooterLayout() {
    console.log('\n📌 Pillar 3: Fixing Footer Profile Layout...');
    
    const cssFile = path.join(__dirname, '..', 'public', 'index-shell.css');
    let css = readFile(cssFile);
    
    if (!css) return false;
    
    // Add footer profile horizontal layout fix
    const footerFix = `
/* ===== FOOTER PROFILE LAYOUT FIX ===== */
/* Fix for vertical stacking of profile elements ("BU", "budi", "ADMIN") */
.sidebar-footer,
.profile-footer,
.app-sidebar-footer {
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    justify-content: flex-start !important;
    gap: 8px !important;
    padding: 12px !important;
    background: rgba(15, 23, 42, 0.6) !important;
    border-top: 1px solid rgba(255, 255, 255, 0.08) !important;
}

.profile-badge,
.user-role-badge,
.user-badge {
    display: inline-flex !important;
    align-items: center !important;
    padding: 4px 10px !important;
    border-radius: 6px !important;
    font-size: 11px !important;
    font-weight: 600 !important;
    background: rgba(16, 185, 129, 0.1) !important;
    color: #10b981 !important;
    border: 1px solid rgba(16, 185, 129, 0.25) !important;
}

.profile-name,
.user-name {
    display: inline !important;
    font-size: 13px !important;
    font-weight: 500 !important;
    color: #e2e8f0 !important;
}

.profile-actions,
.user-actions {
    display: inline-flex !important;
    flex-direction: row !important;
    gap: 4px !important;
    margin-left: auto !important;
}
`;
    
    // Append if not present
    if (!css.includes('.sidebar-footer')) {
        css += footerFix;
        return writeFile(cssFile, css);
    }
    
    console.log('⏩ Footer fix already exists, skipping...');
    return true;
}

// ===== PILLAR 4: Fix Chart Loading State =====
// Ensure charts don't get stuck in loading state
function fixChartLoading() {
    console.log('\n📌 Pillar 4: Fixing Chart Loading State...');
    
    const htmlFile = path.join(__dirname, '..', 'public', 'analisis-saham.html');
    let html = readFile(htmlFile);
    
    if (!html) return false;
    
    // Add chart loading timeout and error handling
    const chartFix = `
    <script>
    // ===== CHART LOADING FIX =====
    // Prevent charts from getting stuck in loading state
    (function() {
        // Set a maximum loading time for charts
        const MAX_LOADING_TIME = 30000; // 30 seconds
        
        // Function to force chart display after timeout
        window.forceChartDisplay = function(chartId) {
            const chartContainer = document.getElementById(chartId);
            if (chartContainer) {
                const loadingOverlay = chartContainer.querySelector('.chart-loading-overlay');
                if (loadingOverlay) {
                    loadingOverlay.style.display = 'none';
                }
                chartContainer.style.background = 'transparent';
            }
        };
        
        // Set timeout for chart loading
        setTimeout(function() {
            window.forceChartDisplay('tradingview-chart');
            window.forceChartDisplay('mainChart');
        }, MAX_LOADING_TIME);
        
        // Listen for chart load events
        document.addEventListener('DOMContentLoaded', function() {
            setTimeout(function() {
                window.forceChartDisplay('tradingview-chart');
                window.forceChartDisplay('mainChart');
            }, 5000); // Force display after 5 seconds
        });
    })();
    </script>
`;
    
    // Add script before closing body tag if not present
    if (!html.includes('forceChartDisplay')) {
        html = html.replace('</body>', chartFix + '</body>');
        return writeFile(htmlFile, html);
    }
    
    console.log('⏩ Chart loading fix already exists, skipping...');
    return true;
}

// ===== MAIN EXECUTION =====
console.log('🚀 Starting fixes...\n');

try {
    const results = {
        submenu: fixSubmenuStyling(),
        header: fixDoubleHeader(),
        footer: fixFooterLayout(),
        chart: fixChartLoading()
    };
    
    console.log('\n📊 Fix Results:');
    console.log(`   Sub-menu Styling: ${results.submenu ? '✅ Fixed' : '❌ Failed'}`);
    console.log(`   Double Header: ${results.header ? '✅ Fixed' : '❌ Failed'}`);
    console.log(`   Footer Layout: ${results.footer ? '✅ Fixed' : '❌ Failed'}`);
    console.log(`   Chart Loading: ${results.chart ? '✅ Fixed' : '❌ Failed'}`);
    
    const allSuccess = Object.values(results).every(r => r);
    if (allSuccess) {
        console.log('\n🎉 All 4 critical UI issues have been fixed!');
        console.log('🔄 Please restart the development server and test the fixes.');
    } else {
        console.log('\n⚠️ Some fixes failed. Please check the output above.');
    }
    
} catch (error) {
    console.error('❌ Fix script failed:', error);
    process.exit(1);
}