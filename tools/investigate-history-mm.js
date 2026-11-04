const { execSync } = require('child_process');

console.log('--- Git log for money-management / kelola-keuangan ---');
try {
  const log = execSync('git log --grep="money-management" --grep="kelola-keuangan" --grep="FINAL-BUG-004" --oneline -n 20', { encoding: 'utf8' });
  console.log(log);
} catch (e) {
  console.error(e.message);
}

try {
  const log2 = execSync('git log -S "nav-money-management" --oneline -n 10', { encoding: 'utf8' });
  console.log('Commits touching nav-money-management:\n', log2);
} catch (e) {
  console.error(e.message);
}
