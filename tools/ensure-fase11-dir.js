const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../bukti-verifikasi-final/fase11');
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}
console.log('Ensured directory:', dir);
