'use strict';

// Only public files enter this responder. API/auth responses never enter its cache.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const gzip = promisify(zlib.gzip), brotli = promisify(zlib.brotliCompress);
const TEXT = /\.(?:html?|css|m?js|json|svg|txt|xml)$/i;
const ASSET = /\.(?:css|m?js|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|eot)$/i;

function preferences(header) {
  const choices = new Map();
  for (const part of String(header || '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.find(p => /^\s*q\s*=/i.test(p));
    const value = q == null ? 1 : Number(q.split('=')[1].trim());
    choices.set(name, Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0);
  }
  return choices;
}
function identityAllowed(header) {
  const choices = preferences(header);
  return choices.has('identity') ? choices.get('identity') > 0 : choices.get('*') !== 0;
}
function encodingFor(header) {
  const choices = preferences(header);
  // No Accept-Encoding means identity; never send an unsupported representation.
  const quality = name => choices.has(name) ? choices.get(name) : choices.get('*') || 0;
  const br = quality('br'), gz = quality('gzip');
  if (choices.has('identity') && choices.get('identity') > Math.max(br, gz)) return null;
  if (br > 0 && br >= gz) return 'br';
  if (gz > 0) return 'gzip';
  return choices.get('identity') === 0 || (!choices.has('identity') && choices.get('*') === 0) ? 'unacceptable' : null;
}

function createStaticResponder({ rootDir, mimeTypes, maxBytes = 16 * 1024 * 1024, maxEntries = 128, maxFileBytes = 2 * 1024 * 1024 }) {
  const root = path.resolve(rootDir), cache = new Map(), pending = new Map();
  let bytes = 0, reads = 0, hits = 0, compressions = 0;
  function drop(key) {
    const entry = cache.get(key);
    if (entry) { bytes -= entry.bytes; cache.delete(key); }
  }
  function trim() {
    while (bytes > maxBytes || cache.size > maxEntries) drop(cache.keys().next().value);
  }
  async function locate(pathname, extensions) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch (_) { return null; }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(p => p.startsWith('.'))) return null;
    let canonical;
    try { canonical = await fs.promises.realpath(root); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const candidate = path.resolve(canonical, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
    if (!candidate.startsWith(canonical + path.sep)) return null;
    for (const file of extensions ? [candidate, candidate + '.html'] : [candidate]) {
      try {
        const real = await fs.promises.realpath(file);
        if (!real.startsWith(canonical + path.sep)) return null;
        const stat = await fs.promises.stat(real);
        if (stat.isFile()) return { file: real, stat };
      } catch (error) { if (!['ENOENT','ENOTDIR','EACCES'].includes(error.code)) throw error; }
    }
    return null;
  }
  async function contents(file, stat) {
    const signature = [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    const old = cache.get(file);
    if (old && old.signature === signature) {
      hits++; cache.delete(file); cache.set(file, old); return old;
    }
    if (old) drop(file);
    const key = file + ':' + signature;
    if (pending.has(key)) { hits++; return pending.get(key); }
    const load = (async () => {
      reads++;
      const raw = await fs.promises.readFile(file);
      const entry = { signature, raw, bytes: raw.length, encoded: new Map(), work: new Map(),
        etag: 'W/"' + crypto.createHash('sha256').update(raw).digest('hex').slice(0,32) + '"' };
      // A slow old load may finish after a new revision: subsequent stat checking
      // prevents stale reuse, and replacement always updates the byte accounting.
      drop(file); cache.set(file, entry); bytes += entry.bytes; trim(); return entry;
    })();
    pending.set(key, load);
    try { return await load; } finally { pending.delete(key); }
  }
  async function encoded(file, entry, type) {
    if (entry.encoded.has(type)) return entry.encoded.get(type);
    if (entry.work.has(type)) return entry.work.get(type);
    const job = (async () => {
      compressions++;
      const result = type === 'br'
        ? await brotli(entry.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
        : await gzip(entry.raw, { level: 4 });
      entry.encoded.set(type, result);
      if (cache.get(file) === entry) { entry.bytes += result.length; bytes += result.length; trim(); }
      return result;
    })();
    entry.work.set(type, job);
    try { return await job; } finally { entry.work.delete(type); }
  }
  async function serve(req, res, pathname, options = {}) {
    if (!['GET','HEAD'].includes(req.method)) {
      res.statusCode = 405; res.setHeader('Allow','GET, HEAD'); res.setHeader('Cache-Control','no-store'); res.end(); return true;
    }
    try {
      const found = await locate(pathname, options.extensionFallback !== false);
      if (!found) return false;
      const { file, stat } = found, status = options.status || 200;
      const reusable = status === 200 && !options.noStore && ASSET.test(file);
      const cacheControl = reusable ? 'public, max-age=0, must-revalidate' : 'private, no-store';
      res.statusCode = status;
      res.setHeader('Content-Type', mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Cache-Control', cacheControl);
      res.setHeader('Last-Modified', stat.mtime.toUTCString());
      const compressible = TEXT.test(file) && stat.size >= 1024;
      if (compressible) res.setHeader('Vary','Accept-Encoding');
      const requested = encodingFor(req.headers['accept-encoding']);
      const identityForbidden = !identityAllowed(req.headers['accept-encoding']);
      if (requested === 'unacceptable' || (identityForbidden && (!compressible || stat.size > maxFileBytes))) {
        res.statusCode = 406; res.setHeader('Cache-Control','no-store'); res.end(); return true;
      }
      // Large downloads stream with backpressure rather than occupying the LRU.
      if (stat.size > maxFileBytes) {
        res.setHeader('Content-Length', stat.size);
        if (req.method === 'HEAD') { res.end(); return true; }
        await pipeline(fs.createReadStream(file), res); return true;
      }
      const entry = await contents(file, stat);
      if (reusable) {
        res.setHeader('ETag', entry.etag);
        const tags = req.headers['if-none-match'];
        const notModified = tags != null
          ? String(tags).split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//,'') === entry.etag.replace(/^W\//,''))
          : req.headers['if-modified-since'] && Math.floor(stat.mtimeMs / 1000) * 1000 <= Date.parse(req.headers['if-modified-since']);
        if (notModified) { res.statusCode = 304; res.end(); return true; }
      }
      const type = compressible ? requested : null;
      const body = type ? await encoded(file, entry, type) : entry.raw;
      if (type) res.setHeader('Content-Encoding', type);
      res.setHeader('Content-Length', body.length);
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    } catch (error) {
      if (res.destroyed) return true;
      if (res.headersSent) { res.destroy(); return true; }
      for (const key of ['Content-Encoding','Content-Length','ETag','Last-Modified']) res.removeHeader(key);
      res.setHeader('Cache-Control','no-store');
      res.statusCode = ['ENOENT','ENOTDIR'].includes(error.code) ? 404 : 500;
      res.end(req.method === 'HEAD' ? undefined : 'File unavailable');
      return true;
    }
  }
  serve.stats = () => ({ bytes, entries: cache.size, reads, hits, compressions, pending: pending.size });
  return serve;
}
module.exports = { createStaticResponder, encodingFor };
