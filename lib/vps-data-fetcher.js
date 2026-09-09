/**
 * VPS On-Demand Data Fetcher
 *
 * Automatically fetches authentic broker summary data from the VPS on-demand
 * when files are missing locally. Prevents local disk bloat by only downloading
 * the specific ticker/date files requested.
 */

const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SSH_KEY_PATH = process.env.VPS_SSH_KEY || 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const SSH_TARGET = process.env.VPS_SSH_TARGET || 'ubuntu@168.110.221.197';
const VPS_BASE_PATH = process.env.VPS_BASE_PATH || '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';

function getLocalStorageDir() {
  return path.join(__dirname, '..', 'data', 'arjum-data', 'broker-summary');
}

function ensureLocalDirExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function hasSshKey() {
  try {
    return fs.existsSync(SSH_KEY_PATH);
  } catch (_) {
    return false;
  }
}

/**
 * Fetch a specific broker summary file from VPS synchronously
 * @param {string} ticker Ticker symbol (e.g. 'GPRA', 'BBCA')
 * @param {string} date Date key (e.g. '2026-09-08' or 'latest')
 * @returns {object|null} Parsed JSON data or null if unavailable
 */
function fetchBrokerSummaryFromVpsSync(ticker, date = '2026-09-08') {
  if (!ticker) return null;
  const safeTicker = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const safeDate = String(date || '2026-09-08').trim().replace(/[^0-9\-a-zA-Z]/g, '');

  if (!hasSshKey()) {
    return null;
  }

  // Paths to try on VPS in priority order: requested date, then latest.json
  const candidateDates = [safeDate];
  if (safeDate !== 'latest') {
    candidateDates.push('latest');
  }
  if (!candidateDates.includes('2026-09-08')) {
    candidateDates.push('2026-09-08');
  }

  const localTickerDir = path.join(getLocalStorageDir(), safeTicker);
  ensureLocalDirExists(localTickerDir);

  for (const targetDate of candidateDates) {
    const remoteFilePath = `${VPS_BASE_PATH}/${safeTicker}/${targetDate}.json`;
    try {
      const stdout = execFileSync('ssh', [
        '-i', SSH_KEY_PATH,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=5',
        SSH_TARGET,
        `cat "${remoteFilePath}" 2>/dev/null`
      ], {
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 15 * 1024 * 1024
      });

      if (stdout && stdout.trim().startsWith('{')) {
        const parsed = JSON.parse(stdout);
        if (parsed && (parsed.brokers || parsed.stock_code)) {
          // Write to local cache for instant zero-latency future requests
          const saveDate = parsed.date || (targetDate !== 'latest' ? targetDate : '2026-09-08');
          const localFilePath = path.join(localTickerDir, `${saveDate}.json`);
          fs.writeFileSync(localFilePath, JSON.stringify(parsed, null, 2), 'utf8');

          const latestFilePath = path.join(localTickerDir, 'latest.json');
          fs.writeFileSync(latestFilePath, JSON.stringify(parsed, null, 2), 'utf8');

          console.log(`[VPS-FETCHER] Successfully fetched on-demand ${safeTicker} (${saveDate}) from VPS (${(stdout.length / 1024).toFixed(1)} KB)`);
          return parsed;
        }
      }
    } catch (err) {
      // Continue to next candidate date if remote file not found
    }
  }

  return null;
}

/**
 * Fetch a specific broker summary file from VPS asynchronously
 * @param {string} ticker Ticker symbol
 * @param {string} date Date key
 * @returns {Promise<object|null>}
 */
function fetchBrokerSummaryFromVps(ticker, date = '2026-09-08') {
  return new Promise((resolve) => {
    try {
      const data = fetchBrokerSummaryFromVpsSync(ticker, date);
      resolve(data);
    } catch (err) {
      resolve(null);
    }
  });
}

/**
 * Fetch a specific broker hunter index file from VPS synchronously
 * @param {string} broker Broker code (e.g. 'AK', 'CC')
 * @param {string} range Range key ('1d', '7d', '30d')
 * @returns {object|null}
 */
function fetchBrokerHunterFromVpsSync(broker, range = '1d') {
  if (!broker) return null;
  const safeBroker = String(broker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const safeRange = String(range || '1d').trim().toLowerCase();

  if (!hasSshKey()) return null;

  const candidateFiles = [
    `${safeBroker}_${safeRange}.json`,
    `${safeBroker}-${safeRange}.json`
  ];

  const localIndexDir = path.join(__dirname, '..', 'data', 'broker-hunter-indexes');
  ensureLocalDirExists(localIndexDir);

  for (const filename of candidateFiles) {
    const remotePath = `/home/ubuntu/auto-cuan/data/broker-hunter-indexes/${filename}`;
    try {
      const stdout = execFileSync('ssh', [
        '-i', SSH_KEY_PATH,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=5',
        SSH_TARGET,
        `cat "${remotePath}" 2>/dev/null`
      ], {
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: 5 * 1024 * 1024
      });

      if (stdout && stdout.trim().startsWith('{')) {
        const parsed = JSON.parse(stdout);
        if (parsed && (parsed.top_accumulated || parsed.broker)) {
          const localPath = path.join(localIndexDir, `${safeBroker}_${safeRange}.json`);
          fs.writeFileSync(localPath, JSON.stringify(parsed, null, 2), 'utf8');
          console.log(`[VPS-FETCHER] Successfully fetched Broker Hunter ${safeBroker} (${safeRange}) from VPS`);
          return parsed;
        }
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Fetch authentic OHLCV cache file for a ticker from VPS synchronously
 * @param {string} ticker Ticker symbol (e.g. 'BBCA', 'GPRA')
 * @returns {object|null}
 */
function fetchOhlcvFromVpsSync(ticker) {
  if (!ticker) return null;
  const safeTicker = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  const localOhlcvDir = path.join(__dirname, '..', 'data', 'daytrade-ohlcv-cache');
  const localFilePath = path.join(localOhlcvDir, `${safeTicker}.json`);
  if (fs.existsSync(localFilePath)) {
    try {
      return JSON.parse(fs.readFileSync(localFilePath, 'utf8'));
    } catch (_) {}
  }

  if (!hasSshKey()) return null;

  ensureLocalDirExists(localOhlcvDir);
  const remotePath = `/home/ubuntu/auto-cuan/data/daytrade-ohlcv-cache/${safeTicker}.json`;

  try {
    const stdout = execFileSync('ssh', [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      SSH_TARGET,
      `cat "${remotePath}" 2>/dev/null`
    ], {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 10 * 1024 * 1024
    });

    if (stdout && stdout.trim().startsWith('{')) {
      const parsed = JSON.parse(stdout);
      if (parsed && (Array.isArray(parsed.candles) || parsed.ticker)) {
        fs.writeFileSync(localFilePath, JSON.stringify(parsed, null, 2), 'utf8');
        console.log(`[VPS-FETCHER] Successfully fetched OHLCV ${safeTicker} from VPS`);
        return parsed;
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Fetch authentic OHLCV cache file for a ticker from VPS asynchronously
 * @param {string} ticker
 * @returns {Promise<object|null>}
 */
function fetchOhlcvFromVps(ticker) {
  return new Promise((resolve) => {
    try {
      resolve(fetchOhlcvFromVpsSync(ticker));
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * Fetch authentic insider transactions file for a ticker from VPS synchronously
 * @param {string} ticker Ticker symbol
 * @returns {object|null}
 */
function fetchInsidersFromVpsSync(ticker) {
  if (!ticker) return null;
  const safeTicker = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  const localInsDir = path.join(__dirname, '..', 'data', 'arjum-data', 'insiders', safeTicker);
  const localFilePath = path.join(localInsDir, 'p1.json');
  if (fs.existsSync(localFilePath)) {
    try {
      return JSON.parse(fs.readFileSync(localFilePath, 'utf8'));
    } catch (_) {}
  }

  if (!hasSshKey()) return null;

  ensureLocalDirExists(localInsDir);
  const remotePath = `/home/ubuntu/auto-cuan/data/arjum-data/insiders/${safeTicker}/p1.json`;

  try {
    const stdout = execFileSync('ssh', [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      SSH_TARGET,
      `cat "${remotePath}" 2>/dev/null`
    ], {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 5 * 1024 * 1024
    });

    if (stdout && stdout.trim().startsWith('{')) {
      const parsed = JSON.parse(stdout);
      if (parsed && (Array.isArray(parsed.items) || parsed.stock_code)) {
        fs.writeFileSync(localFilePath, JSON.stringify(parsed, null, 2), 'utf8');
        return parsed;
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Fetch authentic insider transactions file for a ticker from VPS asynchronously
 * @param {string} ticker
 * @returns {Promise<object|null>}
 */
function fetchInsidersFromVps(ticker) {
  return new Promise((resolve) => {
    try {
      resolve(fetchInsidersFromVpsSync(ticker));
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * Ensure broker summary exists locally; if not, fetch on-demand from VPS
 * @param {string} ticker
 * @param {string} date
 * @returns {Promise<boolean>} True if file exists or was fetched
 */
async function ensureBrokerSummary(ticker, date = '2026-09-08') {
  if (!ticker) return false;
  const safeTicker = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const safeDate = String(date || '2026-09-08').trim();

  const localTickerDir = path.join(getLocalStorageDir(), safeTicker);
  const targetFile = path.join(localTickerDir, `${safeDate}.json`);
  const latestFile = path.join(localTickerDir, 'latest.json');

  if (fs.existsSync(targetFile) || fs.existsSync(latestFile)) {
    return true;
  }

  const fetched = await fetchBrokerSummaryFromVps(safeTicker, safeDate);
  return !!fetched;
}

module.exports = {
  fetchBrokerSummaryFromVpsSync,
  fetchBrokerSummaryFromVps,
  fetchBrokerHunterFromVpsSync,
  fetchOhlcvFromVpsSync,
  fetchOhlcvFromVps,
  fetchInsidersFromVpsSync,
  fetchInsidersFromVps,
  ensureBrokerSummary,
  hasSshKey,
  SSH_KEY_PATH,
  SSH_TARGET,
  VPS_BASE_PATH
};
