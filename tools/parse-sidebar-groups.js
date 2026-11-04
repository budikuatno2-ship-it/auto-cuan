const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');

const startIdx = html.indexOf('<aside id="appSidebar"');
const endIdx = html.indexOf('</aside>', startIdx);
const sidebarHtml = html.slice(startIdx, endIdx + 8);

const sections = sidebarHtml.match(/<section[\s\S]*?<\/section>/gi) || [];
console.log('Total sections in sidebar:', sections.length);

const groups = [];

sections.forEach((sec, idx) => {
  const labelMatch = sec.match(/aria-label="([^"]+)"/);
  const groupLabel = labelMatch ? labelMatch[1] : `Group ${idx+1}`;
  
  const buttonMatches = sec.match(/<button[\s\S]*?<\/button>/gi) || [];
  const items = buttonMatches.map(btn => {
    const idMatch = btn.match(/id="([^"]+)"/);
    const dataPage = btn.match(/data-sidebar-page="([^"]+)"/);
    const dataAnalysisTab = btn.match(/data-analysis-tab="([^"]+)"/);
    const dataTab = btn.match(/data-tab="([^"]+)"/);
    const labelMatch = btn.match(/<span class="sidebar-label">([^<]+)<\/span>/);
    const dataLabel = btn.match(/data-label="([^"]+)"/);
    const classes = btn.match(/class="([^"]+)"/);
    const onclick = btn.match(/onclick="([^"]+)"/);
    
    return {
      id: idMatch ? idMatch[1] : null,
      dataPage: dataPage ? dataPage[1] : null,
      dataAnalysisTab: dataAnalysisTab ? dataAnalysisTab[1] : null,
      dataTab: dataTab ? dataTab[1] : null,
      label: labelMatch ? labelMatch[1].trim() : (dataLabel ? dataLabel[1] : ''),
      classes: classes ? classes[1] : '',
      onclick: onclick ? onclick[1] : ''
    };
  });
  
  groups.push({
    group: groupLabel,
    count: items.length,
    items
  });
});

console.log(JSON.stringify(groups, null, 2));
