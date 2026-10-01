'use strict';
const {createClient}=require('@supabase/supabase-js');
const {requireAuthenticatedSession,isSameOrigin}=require('./admin-session');
function dbClient(){
 if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)return null;
 return createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
}
function createHandler(factory=dbClient){return async function(req,res){
 res.setHeader('Cache-Control','private, no-store');
 if(req.method!=='POST')return res.status(405).json({success:false,error:'Method not allowed'});
 if(!isSameOrigin(req))return res.status(403).json({success:false,error:'Permintaan ditolak.'});
 const auth=requireAuthenticatedSession(req);
 if(!auth.ok)return res.status(401).json({success:false,error:'Silakan login kembali.'});
 try{
  const db=factory();if(!db)return res.status(503).json({success:false,error:'Data akun belum tersedia. Coba lagi.'});
  const result=await db.from('app_users').select('id, username, email, is_blocked').eq('id',auth.session.uid).maybeSingle();
  const user=result.data;
  if(result.error||!user||String(user.username).toLowerCase()!==String(auth.session.un).toLowerCase())return res.status(401).json({success:false,error:'Sesi tidak valid.'});
  if(user.is_blocked)return res.status(403).json({success:false,error:'Akun diblokir.'});
  const required=!String(user.email||'').trim() && !['budi','review'].includes(String(user.username).toLowerCase());
  if(req.body.action==='account-email-status'||!required)return res.status(200).json({success:true,required,email:user.email||null});
  const email=typeof req.body.email==='string'?req.body.email.trim().toLowerCase():'';
  if(email.length>254||! /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?@gmail\.com$/.test(email))return res.status(400).json({success:false,error:'Masukkan alamat Gmail yang valid (@gmail.com).'});
  // A conditional update cannot replace an email saved concurrently by another device.
  let update=db.from('app_users').update({email}).eq('id',auth.session.uid);
  update=user.email==null?update.is('email',null):update.eq('email',user.email);
  const updated=await update.select('email').maybeSingle();
  if(updated.error)return res.status(updated.error.code==='23505'?409:503).json({success:false,error:updated.error.code==='23505'?'Gmail tidak dapat digunakan. Gunakan Gmail lain.':'Gmail belum tersimpan. Coba lagi.'});
  if(!updated.data)return res.status(409).json({success:false,error:'Data akun berubah. Muat ulang halaman.'});
  return res.status(200).json({success:true,required:false,email});
 }catch(_){return res.status(503).json({success:false,error:'Data akun belum tersedia. Coba lagi.'});}
};}
module.exports=createHandler();module.exports.createHandler=createHandler;
