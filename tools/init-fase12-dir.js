const fs = require('fs');
const path = require('path');

const dir = 'bukti-verifikasi-final/fase12';
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
  console.log('Created:', dir);
} else {
  console.log('Exists:', dir);
}
