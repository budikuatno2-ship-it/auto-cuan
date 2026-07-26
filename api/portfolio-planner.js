'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { requireAuthenticatedSession } = require('../lib/admin-session');

const TEMPLATE_PATH = path.join(__dirname, '..', 'lib', 'portfolio-decision-center.html');
const ADMIN_GATE = "async function gate(){try{var r=await fetch('/api/admin-users',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'analytics'})}),d=await r.json();if(!r.ok||!d.success)throw Error();hi('loading');sh('app');load();init()}catch(e){hi('loading');sh('denied')}}";
const APPROVED_GATE = "async function gate(){hi('loading');sh('app');load();init()}";

function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

module.exports = async function handler(req, res) {
  noStore(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method not allowed');
  }

  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) return res.status(auth.status).send('Login diperlukan.');

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(503).send('Akses belum tersedia.');

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: user, error } = await supabase
    .from('app_users')
    .select('id, is_approved, is_blocked')
    .eq('id', auth.session.uid)
    .maybeSingle();

  if (error) {
    console.error('portfolio access lookup failed');
    return res.status(503).send('Akses belum tersedia.');
  }

  if (!user || user.is_approved !== true || user.is_blocked === true) {
    return res.status(403).send('Akun belum di-approve admin atau sedang diblokir.');
  }

  let html;
  try {
    html = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  } catch (e) {
    console.error('portfolio template unavailable');
    return res.status(503).send('Halaman belum tersedia.');
  }

  if (!html.includes(ADMIN_GATE)) {
    console.error('portfolio template gate mismatch');
    return res.status(503).send('Halaman belum tersedia.');
  }

  html = html
    .replace(ADMIN_GATE, APPROVED_GATE)
    .replace('Admin Preview. Akun Free tidak memperoleh akses dan approval akun tidak dianggap sebagai entitlement Premium.', 'Akses hanya untuk akun yang sudah di-approve admin dan tidak diblokir.')
    .replace('ADMIN PREVIEW · decision-center-v1', 'APPROVED ACCESS · decision-center-v1');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
};
