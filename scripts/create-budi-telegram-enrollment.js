'use strict';

const { createClient } = require('@supabase/supabase-js');
const recovery = require('../lib/auth-recovery');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib tersedia.');
  }
  if (!recovery.getRecoverySecret()) {
    throw new Error('TELEGRAM_VERIFY_CODE_SECRET wajib tersedia.');
  }

  const db = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  const result = await recovery.createAdminEnrollment(db, 'budi');

  console.log('============================================================');
  console.log('BUDI TELEGRAM ENROLLMENT — ONE TIME');
  console.log('============================================================');
  console.log('Kirim kode berikut ke AutoCuanVerificationBot:');
  console.log('');
  console.log(result.code);
  console.log('');
  console.log('Berlaku sampai: ' + result.expiresAt);
  console.log('Kode hanya dapat digunakan satu kali.');
  console.log('Password tidak diubah oleh perintah ini.');
  console.log('Device ID tidak diubah oleh perintah ini.');
}

main().catch(function (error) {
  console.error('ENROLLMENT_STATUS=FAILED');
  console.error('ERROR=' + String(error && error.message || error));
  process.exitCode = 1;
});
