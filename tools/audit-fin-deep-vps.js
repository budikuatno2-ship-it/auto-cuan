const fs=require('fs'),path=require('path');
const DIR='/home/ubuntu/auto-cuan/data/arjum-data/financial-statements';
const dirs=fs.readdirSync(DIR).filter(d=>fs.statSync(path.join(DIR,d)).isDirectory());
const OUT='/tmp/fase05-financial-periods.json';

const report={meta:{totalEmitten:dirs.length,checkedAt:new Date().toISOString()},summary:{hasQ2:0,has6M:0,hasQ1only:0,hasAnnual:0,noData:0},samples:{}};

for(const ticker of dirs){
  const qPath=path.join(DIR,ticker,'INCOME_STATEMENT-quarterly.json');
  if(!fs.existsSync(qPath)){report.summary.noData++;continue;}
  try{
    const d=JSON.parse(fs.readFileSync(qPath,'utf8'));
    const items=d.items||d.data||[];
    if(!Array.isArray(items)||items.length===0){report.summary.noData++;continue;}
    
    // Check periods
    const periods=items.map(it=>it.period||it.fiscal_period||it.report_period||'').filter(Boolean);
    const hasQ2=periods.some(p=>String(p).includes('Q2')||String(p).includes('6M')||String(p).includes('Semester I'));
    const has6M=periods.some(p=>String(p).includes('6M')||String(p).includes('Semester I'));
    const hasQ1=periods.some(p=>String(p).includes('Q1'));
    
    if(hasQ2||has6M) report.summary.hasQ2++;
    else if(hasQ1) report.summary.hasQ1only++;
    
    const hasAn=fs.existsSync(path.join(DIR,ticker,'INCOME_STATEMENT-annually.json'));
    if(hasAn) report.summary.hasAnnual++;
    
    if(Object.keys(report.samples).length<10){
      report.samples[ticker]={periods:periods.slice(-8),hasQ2,has6M,hasQ1,count:items.length};
    }
  }catch(e){report.summary.noData++;}
}

fs.writeFileSync(OUT,JSON.stringify(report,null,2));
console.log('Total:',dirs.length,'hasQ2:',report.summary.hasQ2,'has6M:',report.summary.has6M,'Q1only:',report.summary.hasQ1only,'hasAnnual:',report.summary.hasAnnual,'noData:',report.summary.noData);