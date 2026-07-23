'use strict';

const crypto = require('crypto');
const VOUCHER_CODE_RE = /^[A-Z0-9]{8,32}$/;
const VOUCHER_ADMIN_TELEGRAM_USER_ID = 6396446903;
function normalizeVoucherCode(value) { const code=typeof value==='string' ? value.trim().toUpperCase() : ''; return VOUCHER_CODE_RE.test(code) ? code : null; }
function voucherCodeHash(value) { const code=normalizeVoucherCode(value), pepper=process.env.VOUCHER_CODE_PEPPER; if (!code || typeof pepper !== 'string' || pepper.length<16) throw new Error('voucher unavailable'); return crypto.createHmac('sha256',pepper).update(code,'utf8').digest('hex'); }
function isVoucherAdminTelegramUser(id) { return Number(id) === VOUCHER_ADMIN_TELEGRAM_USER_ID; }
module.exports={ VOUCHER_CODE_RE, VOUCHER_ADMIN_TELEGRAM_USER_ID, normalizeVoucherCode, voucherCodeHash, isVoucherAdminTelegramUser };
