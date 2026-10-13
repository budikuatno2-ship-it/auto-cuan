const MONTHS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function formatWib(input, options = {}) {
  if (!input) return '-';
  const str = String(input).trim();
  if (!str || str === '-' || str === '—') return '-';

  // If it's pure YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-').map(Number);
    return `${d} ${MONTHS_ID[m - 1]} ${y}`;
  }

  const d = new Date(str);
  if (isNaN(d.getTime())) return str;

  // Convert to UTC+7 (WIB)
  const wibTime = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const year = wibTime.getUTCFullYear();
  const month = wibTime.getUTCMonth();
  const day = wibTime.getUTCDate();
  const hours = wibTime.getUTCHours();
  const minutes = wibTime.getUTCMinutes();

  const datePart = `${day} ${MONTHS_ID[month]} ${year}`;

  // If input string did not include time (e.g. 00:00:00.000Z or pure date), return date only unless includeTime is requested
  const hasTime = str.includes('T') && !str.endsWith('T00:00:00.000Z') && !str.endsWith('T00:00:00Z');
  if (options.includeTime || (hasTime && options.includeTime !== false)) {
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    return `${datePart}, ${hh}.${mm} WIB`;
  }
  return datePart;
}

function formatCompactUnit(num, unitSuffix = '') {
  if (num == null || isNaN(num)) return '-';
  const n = Math.abs(Number(num));
  const sign = Number(num) < 0 ? '-' : '';
  const suffix = unitSuffix ? ` ${unitSuffix}` : '';

  if (n >= 1e12) {
    return sign + (n / 1e12).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' T' + suffix;
  }
  if (n >= 1e9) {
    return sign + (n / 1e9).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Mrd' + suffix;
  }
  if (n >= 1e6) {
    return sign + (n / 1e6).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Jt' + suffix;
  }
  return sign + Number(num).toLocaleString('id-ID') + suffix;
}

module.exports = { formatWib, formatCompactUnit, MONTHS_ID };
