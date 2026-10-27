const fs = require('fs');
const d = JSON.parse(fs.readFileSync('/home/ubuntu/auto-cuan/data/arjum-data/financial-statements/BBCA.json','utf8'));
const periods = Object.keys(d).sort();
console.log('total periods:', periods.length);
console.log('first 10:', periods.slice(0,10));
console.log('last 10:', periods.slice(-10));
const latest = periods[periods.length-1];
console.log('latest period:', latest, 'keys:', Object.keys(d[latest]||{}).slice(0,15));