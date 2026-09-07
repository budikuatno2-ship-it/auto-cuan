-- Migration: Tambah Kolom Email Opsional ke app_users
ALTER TABLE public.app_users 
ADD COLUMN IF NOT EXISTS email text;

-- Index unik parsial case-insensitive (hanya berlaku jika email diisi dan tidak kosong)
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_email_unique_lower 
ON public.app_users (LOWER(TRIM(email))) 
WHERE email IS NOT NULL AND TRIM(email) <> '';
