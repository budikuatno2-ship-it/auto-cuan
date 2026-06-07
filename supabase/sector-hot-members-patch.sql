-- =============================================
-- SECTOR HOT MEMBERS PATCH v2 — Corrected mapping
-- Based ONLY on provided source mapping.
-- Run this in Supabase SQL Editor manually.
-- Safe to re-run (uses ON CONFLICT DO UPDATE).
-- =============================================

-- =============================================
-- STEP 1: REMOVE incorrectly added members from previous rejected patch
-- =============================================
DELETE FROM public.sector_hot_group_members WHERE group_code = 'KALBE' AND ticker = 'SIDO';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'KALBE' AND ticker = 'TSPC';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'CHAROEN_POKPHAND' AND ticker = 'JPFA';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'WILMAR' AND ticker = 'SIMP';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'WILMAR' AND ticker = 'LSIP';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'WILMAR' AND ticker = 'SMAR';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'SUMMARECON' AND ticker = 'DILD';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'CIPUTRA' AND ticker = 'DUTI';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'DJARUM' AND ticker = 'ARTO';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'BARITO' AND ticker = 'ESSA';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'CT_CORP' AND ticker = 'HEAL';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'EMTEK' AND ticker = 'MSIN';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'MNC' AND ticker = 'IATA';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'PANIN' AND ticker = 'PNIN';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'GAJAH_TUNGGAL' AND ticker = 'MASA';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'MAYAPADA' AND ticker = 'SRAJ';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'PODOMORO' AND ticker = 'KIJA';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'ADARO' AND ticker = 'AADI';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'TRIPUTRA' AND ticker = 'TAPG';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'BAKRIE' AND ticker = 'ELTY';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'SALIM' AND ticker = 'MPPA';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'SALIM' AND ticker = 'DNET';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'SINARMAS' AND ticker = 'SMDM';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'SINARMAS' AND ticker = 'SMMA';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'LIPPO' AND ticker = 'LPPF';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'LIPPO' AND ticker = 'SILO';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'SARATOGA' AND ticker = 'ADRO';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'TOBA' AND ticker = 'PTRO';
DELETE FROM public.sector_hot_group_members WHERE group_code = 'MAYORA' AND ticker = 'CEKA';

-- Also remove from sector_hot_members_latest cache (will be repopulated on next refresh)
DELETE FROM public.sector_hot_members_latest WHERE (group_code, ticker) NOT IN (
  SELECT group_code, ticker FROM public.sector_hot_group_members
);

-- =============================================
-- STEP 2: INSERT/UPDATE correct mapping from provided source
-- =============================================

-- KALBE (provided: KLBF + MIKA)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('KALBE', 'KLBF', 'Kalbe Farma Tbk.', 'ANCHOR', 1),
('KALBE', 'MIKA', 'Mitra Keluarga Karyasehat Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- CHAROEN_POKPHAND (provided: CPIN + MAIN)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('CHAROEN_POKPHAND', 'CPIN', 'Charoen Pokphand Indonesia Tbk.', 'ANCHOR', 1),
('CHAROEN_POKPHAND', 'MAIN', 'Malindo Feedmill Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();
-- Remove CPRO (not in provided mapping)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'CHAROEN_POKPHAND' AND ticker = 'CPRO';

-- WILMAR (provided: SGRO as ANCHOR)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('WILMAR', 'SGRO', 'Sampoerna Agro Tbk.', 'ANCHOR', 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- SUMMARECON (provided: SMRA + SMDM)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('SUMMARECON', 'SMRA', 'Summarecon Agung Tbk.', 'ANCHOR', 1),
('SUMMARECON', 'SMDM', 'Suryamas Dutamakmur Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- CIPUTRA (provided: CTRA only)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('CIPUTRA', 'CTRA', 'Ciputra Development Tbk.', 'ANCHOR', 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- LIPPO (provided: LPKR, LPCK, SILO, LPPF, LPGI, MLPL, MLPT, LPIN)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('LIPPO', 'LPKR', 'Lippo Karawaci Tbk.', 'ANCHOR', 1),
('LIPPO', 'LPCK', 'Lippo Cikarang Tbk.', 'Member', 2),
('LIPPO', 'SILO', 'Siloam International Hospitals Tbk.', 'Member', 3),
('LIPPO', 'LPPF', 'Matahari Department Store Tbk.', 'Member', 4),
('LIPPO', 'LPGI', 'Lippo General Insurance Tbk.', 'Member', 5),
('LIPPO', 'MLPL', 'Multipolar Tbk.', 'Member', 6),
('LIPPO', 'MLPT', 'Multipolar Technology Tbk.', 'Member', 7),
('LIPPO', 'LPIN', 'Multi Prima Sejahtera Tbk.', 'Member', 8)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();
-- Remove MPPA from LIPPO (not in provided mapping)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'LIPPO' AND ticker = 'MPPA';

-- MNC (provided: BHIT, BMTR, FILM, MNCN, IPTV, NETV, KPIG, BCAP, ABBA)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('MNC', 'BHIT', 'MNC Asia Holding Tbk.', 'ANCHOR', 1),
('MNC', 'BMTR', 'Global Mediacom Tbk.', 'Member', 2),
('MNC', 'FILM', 'MD Entertainment Tbk.', 'Member', 3),
('MNC', 'MNCN', 'MNC Digital Entertainment Tbk.', 'Member', 4),
('MNC', 'IPTV', 'MNC Vision Networks Tbk.', 'Member', 5),
('MNC', 'NETV', 'Net Visi Media Tbk.', 'Member', 6),
('MNC', 'KPIG', 'MNC Land Tbk.', 'Member', 7),
('MNC', 'BCAP', 'MNC Kapital Indonesia Tbk.', 'Member', 8),
('MNC', 'ABBA', 'Mahaka Media Tbk.', 'Member', 9)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();
-- Remove BABP from MNC (not in provided mapping)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'MNC' AND ticker = 'BABP';

-- MAYORA (provided: MYOR only — single member group)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('MAYORA', 'MYOR', 'Mayora Indah Tbk.', 'ANCHOR', 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- GAJAH_TUNGGAL (provided: GJTL only)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('GAJAH_TUNGGAL', 'GJTL', 'Gajah Tunggal Tbk.', 'ANCHOR', 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- MAYAPADA (provided: MAYA only)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('MAYAPADA', 'MAYA', 'Bank Mayapada Internasional Tbk.', 'ANCHOR', 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();
