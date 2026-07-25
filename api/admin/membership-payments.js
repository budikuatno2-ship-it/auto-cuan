'use strict';

const crypto = require('crypto');
const { requireAdminSession, isSameOrigin } = require('../../lib/admin-session');
const service = require('../../lib/telegram-membership-service');
const bot = require('../../lib/telegram-verify-bot');

module.exports = async function handler(req, res) {
  const auth = requireAdminSession(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  if (req.method === 'GET' && req.query && req.query.proofId) {
    if (!/^[0-9a-f-]{36}$/i.test(req.query.proofId)) return res.status(400).json({ error: 'invalid_proof_id' });
    const proof = await service.proof(req.query.proofId);
    const bytes = await bot.downloadFile(proof.telegram_file_id);
    res.setHeader('Content-Type', proof.mime_type);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="payment-proof-${proof.id}"`);
    return res.status(200).send(bytes);
  }
  if (req.method === 'GET') return res.status(200).json({ pending: await service.pending() });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!isSameOrigin(req)) return res.status(403).json({ error: 'cross_origin_denied' });
  const body = req.body || {};
  if (!/^[0-9a-f-]{36}$/i.test(body.purchaseId || '') || !['approve', 'reject'].includes(body.action)) return res.status(400).json({ error: 'invalid_request' });
  if (body.action === 'reject' && (typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.length > 500)) return res.status(400).json({ error: 'reason_required' });
  const key = String(req.headers['idempotency-key'] || '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return res.status(400).json({ error: 'idempotency_key_required' });
  const result = await service.review(body.purchaseId, body.action === 'approve', body.reason, auth.session.uid, key);
  return res.status(200).json({ result, audit: await service.audit(body.purchaseId), requestId: crypto.randomUUID() });
};
