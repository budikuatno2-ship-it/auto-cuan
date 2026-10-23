'use strict';

// Default-deny gate for the UNAUTHENTICATED /data/* static route.
//
// Why this exists
// ---------------
// tools/local-dev-server.js served EVERY file under data/ with no session. That
// tree holds premium screener exports, raw broker summaries and large
// bandarmologi indexes (built with maxBytes=2MB, so multi-MB exports were even
// truncated). An audit found the whole 7.9 GB folder reachable by anyone.
//
// Exactly ONE class of file is legitimately fetched by the browser WITHOUT a
// session:
//
//   /data/bandarmologi-intel-indexes/latest_<range>.json
//
// which public/bandarmologi-runtime.js uses as a static fallback for the
// Bandarmologi "Sinyal Intelijen" scanner when the authenticated
// /api/sector-hot?action=bandarmologi-intel call returns no data. Every other
// page that needs premium data reads it through an authenticated API endpoint,
// never through /data/. This module therefore allows ONLY that exact prefix and
// refuses everything else, so /data/ becomes default-deny.
//
// The module is pure (no I/O): it answers "is this request path allowlisted?".
// Path containment and traversal defence live here so the check is unit-tested
// in isolation and reused by every server that fronts data/.

// The single allowlisted prefix, relative to DATA_DIR (POSIX separators).
const ALLOWED_INDEX_PREFIX = 'bandarmologi-intel-indexes/latest_';

// Path-containment guard. Any traversal intent is refused outright instead of
// being normalised, so a ".." that survived percent-decoding (including
// double-encoded "%252e%252e" once decoded) can never be silently resolved into
// an allowed prefix:
//   - a whole path segment equal to ".."   (e.g. bandarmologi-intel-indexes/../secret)
//   - a backslash separator                (Windows-style escape)
//   - a NUL byte                           (truncation tricks)
const TRAVERSAL = /(?:^|\/)\.\.(?:\/|$)|\\|\u0000/;

// The <range> token is only ever one of the known windows (1d,5d,7d,14d,30d,60d)
// but the allowlist keeps it as a tight single path segment: short, no
// separators, no dot-leading. This makes the allowlist a closed set even if a
// future frontend requests an unexpected range.
const RANGE_TOKEN = /^[A-Za-z0-9_-]{1,16}$/;

const MAX_PATH_LENGTH = 2048;

// Accepts the request path as either "/data/bandarmologi-.../latest_7d.json"
// (absolute) or "/bandarmologi-.../latest_7d.json" (relative to DATA_DIR, which
// is what serveData() is given). Both normalise to the DATA_DIR-relative form.
function toDataRelative(rawPath) {
  let value = String(rawPath == null ? '' : rawPath);
  if (!value || value.length > MAX_PATH_LENGTH) return null;
  value = value.replace(/^\/+/, '');
  if (value === 'data') return '';
  if (value.startsWith('data/')) value = value.slice('data/'.length);
  return value;
}

// True only for the exact allowlisted bandarmologi intel index shape.
function isAllowedDataPath(rawPath) {
  const relative = toDataRelative(rawPath);
  if (relative == null || relative === '') return false;
  // Reject any traversal/backslash/NUL BEFORE the prefix comparison.
  if (TRAVERSAL.test(relative)) return false;
  if (!relative.startsWith(ALLOWED_INDEX_PREFIX)) return false;

  const remainder = relative.slice(ALLOWED_INDEX_PREFIX.length);
  if (!remainder.toLowerCase().endsWith('.json')) return false;
  const token = remainder.slice(0, remainder.length - '.json'.length);
  return RANGE_TOKEN.test(token);
}

module.exports = {
  ALLOWED_INDEX_PREFIX,
  isAllowedDataPath,
  // Exported for tests/documentation only.
  toDataRelative
};