-- =============================================
-- SECTOR HOT MEMBERS PATCH v3 — Full provided mapping
-- Based ONLY on the full provided source mapping.
-- Run this in Supabase SQL Editor manually.
-- Safe to re-run (uses ON CONFLICT DO UPDATE).
-- =============================================

-- =============================================
-- STEP 1: Add missing groups
-- =============================================
INSERT INTO public.sector_hot_groups (group_code, group_name, owner_label, sort_order) VALUES
('ASTRA', 'Astra Group (Jardine Matheson)', 'Jardine Matheson / Salim', 5),
('PJAYA', 'Pembangunan Jaya Group', 'Pembangunan Jaya', 33),
('JAPFA', 'Japfa Group', 'Japfa Family', 34)
ON CONFLICT (group_code) DO UPDATE SET
  group_name = EXCLUDED.group_name,
  owner_label = EXCLUDED.owner_label,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- =============================================
-- STEP 2: Remove ONLY incorrectly added members that are NOT in provided mapping
-- =============================================
-- KALBE: remove SIDO, TSPC (not provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'KALBE' AND ticker IN ('SIDO', 'TSPC');
-- CHAROEN_POKPHAND: remove CPRO (not provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'CHAROEN_POKPHAND' AND ticker = 'CPRO';
-- WILMAR: remove SIMP, LSIP (not provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'WILMAR' AND ticker IN ('SIMP', 'LSIP');
-- CIPUTRA: remove DUTI (not in CIPUTRA provided; DUTI belongs to SINARMAS)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'CIPUTRA' AND ticker = 'DUTI';
-- SUMMARECON: remove DILD (not provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'SUMMARECON' AND ticker = 'DILD';
-- CT_CORP: remove HEAL (not provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'CT_CORP' AND ticker = 'HEAL';
-- EMTEK: remove MSIN (not provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'EMTEK' AND ticker = 'MSIN';
-- MNC: remove BABP, IATA (not provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'MNC' AND ticker IN ('BABP', 'IATA');
-- GAJAH_TUNGGAL: remove MASA (not provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'GAJAH_TUNGGAL' AND ticker = 'MASA';
-- MAYAPADA: remove SRAJ (not provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'MAYAPADA' AND ticker = 'SRAJ';
-- PODOMORO: remove KIJA (not provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'PODOMORO' AND ticker = 'KIJA';
-- ADARO: remove AADI (not provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'ADARO' AND ticker = 'AADI';
-- TRIPUTRA: remove TAPG (not provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'TRIPUTRA' AND ticker = 'TAPG';
-- MAYORA: remove CEKA (not provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'MAYORA' AND ticker = 'CEKA';
-- SALIM: remove MPPA, DNET (not in SALIM provided; DNET belongs to DJARUM)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'SALIM' AND ticker IN ('MPPA', 'DNET');
-- LIPPO: remove MPPA (not provided for LIPPO)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'LIPPO' AND ticker = 'MPPA';
-- DJARUM: remove ARTO, HMSP (not in DJARUM provided)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'DJARUM' AND ticker IN ('ARTO', 'HMSP');
-- TOBA: remove PTRO (PTRO belongs to BARITO)
DELETE FROM public.sector_hot_group_members WHERE group_code = 'TOBA' AND ticker = 'PTRO';

-- =============================================
-- STEP 3: INSERT/UPDATE full provided mapping
-- =============================================

-- BUMN_TAMBANG (unchanged)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('BUMN_TAMBANG', 'ANTM', 'Aneka Tambang Tbk.', 'ANCHOR', 1),
('BUMN_TAMBANG', 'PTBA', 'Bukit Asam (Persero) Tbk.', 'Member', 2),
('BUMN_TAMBANG', 'TINS', 'Timah Tbk.', 'Member', 3),
('BUMN_TAMBANG', 'INCO', 'Vale Indonesia Tbk.', 'Member', 4),
('BUMN_TAMBANG', 'MDKA', 'Merdeka Copper Gold Tbk.', 'Member', 5)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- BUMN_BANK (unchanged)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('BUMN_BANK', 'BBRI', 'Bank Rakyat Indonesia Tbk.', 'ANCHOR', 1),
('BUMN_BANK', 'BMRI', 'Bank Mandiri (Persero) Tbk.', 'Member', 2),
('BUMN_BANK', 'BBNI', 'Bank Negara Indonesia Tbk.', 'Member', 3),
('BUMN_BANK', 'BBTN', 'Bank Tabungan Negara Tbk.', 'Member', 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- BUMN_TELCO (add MTEL)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('BUMN_TELCO', 'TLKM', 'Telkom Indonesia Tbk.', 'ANCHOR', 1),
('BUMN_TELCO', 'MTEL', 'Dayamitra Telekomunikasi Tbk.', 'Member', 2),
('BUMN_TELCO', 'EXCL', 'XLSmart Telecom Sejahtera Tbk.', 'Member', 3),
('BUMN_TELCO', 'ISAT', 'Indosat Ooredoo Hutchison Tbk.', 'Member', 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- BUMN_KARYA (add WTON)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('BUMN_KARYA', 'WIKA', 'Wijaya Karya (Persero) Tbk.', 'ANCHOR', 1),
('BUMN_KARYA', 'PTPP', 'PP (Persero) Tbk.', 'Member', 2),
('BUMN_KARYA', 'WSKT', 'Waskita Karya (Persero) Tbk.', 'Member', 3),
('BUMN_KARYA', 'ADHI', 'Adhi Karya (Persero) Tbk.', 'Member', 4),
('BUMN_KARYA', 'WTON', 'Wijaya Karya Beton Tbk.', 'Member', 5)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- ASTRA (new group)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('ASTRA', 'ASII', 'Astra International Tbk.', 'ANCHOR', 1),
('ASTRA', 'AALI', 'Astra Agro Lestari Tbk.', 'Member', 2),
('ASTRA', 'UNTR', 'United Tractors Tbk.', 'Member', 3),
('ASTRA', 'AUTO', 'Astra Otoparts Tbk.', 'Member', 4),
('ASTRA', 'ACST', 'Acset Indonusa Tbk.', 'Member', 5)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- SALIM (provided: INDF, ICBP, ACES)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('SALIM', 'INDF', 'Indofood Sukses Makmur Tbk.', 'ANCHOR', 1),
('SALIM', 'ICBP', 'Indofood CBP Sukses Makmur Tbk.', 'Member', 2),
('SALIM', 'ACES', 'Aspirasi Hidup Indonesia Tbk.', 'Member', 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- SINARMAS (provided: SMAR, INKP, TKIM, DSSA, SMMA, BSDE, DUTI)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('SINARMAS', 'SMAR', 'Smart Tbk.', 'ANCHOR', 1),
('SINARMAS', 'INKP', 'Indah Kiat Pulp & Paper Tbk.', 'Member', 2),
('SINARMAS', 'TKIM', 'Pabrik Kertas Tjiwi Kimia Tbk.', 'Member', 3),
('SINARMAS', 'DSSA', 'Dian Swastatika Sentosa Tbk.', 'Member', 4),
('SINARMAS', 'SMMA', 'Sinarmas Multiartha Tbk.', 'Member', 5),
('SINARMAS', 'BSDE', 'Bumi Serpong Damai Tbk.', 'Member', 6),
('SINARMAS', 'DUTI', 'Duta Pertiwi Tbk.', 'Member', 7)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- DJARUM (provided: BBCA, DNET, TOWR, EMTK)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('DJARUM', 'BBCA', 'Bank Central Asia Tbk.', 'ANCHOR', 1),
('DJARUM', 'DNET', 'Indoritel Makmur Internasional Tbk.', 'Member', 2),
('DJARUM', 'TOWR', 'Sarana Menara Nusantara Tbk.', 'Member', 3),
('DJARUM', 'EMTK', 'Elang Mahkota Teknologi Tbk.', 'Member', 4)
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

-- BARITO (provided: BRPT, BREN, TPIA, PTRO, CDIA, MEDC)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('BARITO', 'BRPT', 'Barito Pacific Tbk.', 'ANCHOR', 1),
('BARITO', 'BREN', 'Barito Renewables Energy Tbk.', 'Member', 2),
('BARITO', 'TPIA', 'Chandra Asri Pacific Tbk.', 'Member', 3),
('BARITO', 'PTRO', 'Petrosea Tbk.', 'Member', 4),
('BARITO', 'CDIA', 'Cisadane Sawit Raya Tbk.', 'Member', 5),
('BARITO', 'MEDC', 'Medco Energi Internasional Tbk.', 'Member', 6)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- ADARO (provided: ADRO, ADMR)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('ADARO', 'ADRO', 'Alamtri Resources Indonesia Tbk.', 'ANCHOR', 1),
('ADARO', 'ADMR', 'Alamtri Minerals Indonesia Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- SARATOGA (provided: SRTG, ADRO, TBIG, ADMR, MPMX)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('SARATOGA', 'SRTG', 'Saratoga Investama Sedaya Tbk.', 'ANCHOR', 1),
('SARATOGA', 'ADRO', 'Alamtri Resources Indonesia Tbk.', 'Member', 2),
('SARATOGA', 'TBIG', 'Tower Bersama Infrastructure Tbk.', 'Member', 3),
('SARATOGA', 'ADMR', 'Alamtri Minerals Indonesia Tbk.', 'Member', 4),
('SARATOGA', 'MPMX', 'Mitra Pinasthika Mustika Tbk.', 'Member', 5)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- CT_CORP (provided: MEGA, CARS)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('CT_CORP', 'MEGA', 'Bank Mega Tbk.', 'ANCHOR', 1),
('CT_CORP', 'CARS', 'Industri dan Perdagangan Bintraco Dharma Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- EMTEK (provided: EMTK, SCMA, DCII, BUKA)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('EMTEK', 'EMTK', 'Elang Mahkota Teknologi Tbk.', 'ANCHOR', 1),
('EMTEK', 'SCMA', 'Surya Citra Media Tbk.', 'Member', 2),
('EMTEK', 'DCII', 'DCI Indonesia Tbk.', 'Member', 3),
('EMTEK', 'BUKA', 'Bukalapak.com Tbk.', 'Member', 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

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

-- MAYAPADA (provided: MAYA only)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('MAYAPADA', 'MAYA', 'Bank Mayapada Internasional Tbk.', 'ANCHOR', 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- WILMAR (provided: SGRO)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('WILMAR', 'SGRO', 'Sampoerna Agro Tbk.', 'ANCHOR', 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- TOBA (provided: TOBA, NCKL)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('TOBA', 'TOBA', 'Toba Bara Sejahtra Tbk.', 'ANCHOR', 1),
('TOBA', 'NCKL', 'Trimegah Bangun Persada Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- TRIPUTRA (provided: DSNG, ADMR)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('TRIPUTRA', 'DSNG', 'Dharma Satya Nusantara Tbk.', 'ANCHOR', 1),
('TRIPUTRA', 'ADMR', 'Alamtri Minerals Indonesia Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- PODOMORO (provided: APLN, GMTD)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('PODOMORO', 'APLN', 'Agung Podomoro Land Tbk.', 'ANCHOR', 1),
('PODOMORO', 'GMTD', 'Gowa Makassar Tourism Development Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- PANIN (provided: PNBN, PNIN, PNLF, PNBS)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('PANIN', 'PNBN', 'Bank Pan Indonesia Tbk.', 'ANCHOR', 1),
('PANIN', 'PNIN', 'Panin Insurance Tbk.', 'Member', 2),
('PANIN', 'PNLF', 'Panin Financial Tbk.', 'Member', 3),
('PANIN', 'PNBS', 'Bank Panin Dubai Syariah Tbk.', 'Member', 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- KALBE (provided: KLBF, MIKA)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('KALBE', 'KLBF', 'Kalbe Farma Tbk.', 'ANCHOR', 1),
('KALBE', 'MIKA', 'Mitra Keluarga Karyasehat Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- CHAROEN_POKPHAND (provided: CPIN, MAIN)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('CHAROEN_POKPHAND', 'CPIN', 'Charoen Pokphand Indonesia Tbk.', 'ANCHOR', 1),
('CHAROEN_POKPHAND', 'MAIN', 'Malindo Feedmill Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- CIPUTRA (provided: CTRA only)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('CIPUTRA', 'CTRA', 'Ciputra Development Tbk.', 'ANCHOR', 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- SUMMARECON (provided: SMRA, SMDM)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('SUMMARECON', 'SMRA', 'Summarecon Agung Tbk.', 'ANCHOR', 1),
('SUMMARECON', 'SMDM', 'Suryamas Dutamakmur Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- MAYORA (provided: MYOR only)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('MAYORA', 'MYOR', 'Mayora Indah Tbk.', 'ANCHOR', 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- BAKRIE (provided: BNBR, BUMI, DEWA, BRMS, ELTY, VIVA, ENRG)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('BAKRIE', 'BNBR', 'Bakrie & Brothers Tbk.', 'ANCHOR', 1),
('BAKRIE', 'BUMI', 'Bumi Resources Tbk.', 'Member', 2),
('BAKRIE', 'DEWA', 'Darma Henwa Tbk.', 'Member', 3),
('BAKRIE', 'BRMS', 'Bumi Resources Minerals Tbk.', 'Member', 4),
('BAKRIE', 'ELTY', 'Bakrieland Development Tbk.', 'Member', 5),
('BAKRIE', 'VIVA', 'Visi Media Asia Tbk.', 'Member', 6),
('BAKRIE', 'ENRG', 'Energi Mega Persada Tbk.', 'Member', 7)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- GAJAH_TUNGGAL (provided: GJTL only)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('GAJAH_TUNGGAL', 'GJTL', 'Gajah Tunggal Tbk.', 'ANCHOR', 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- PJAYA (new group, provided: JRPT, PJAA)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('PJAYA', 'JRPT', 'Jaya Real Property Tbk.', 'ANCHOR', 1),
('PJAYA', 'PJAA', 'Pembangunan Jaya Ancol Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- JAPFA (new group, provided: JPFA, SIPD)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('JAPFA', 'JPFA', 'Japfa Comfeed Indonesia Tbk.', 'ANCHOR', 1),
('JAPFA', 'SIPD', 'Sreeya Sewu Indonesia Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- =============================================
-- STEP 4: Clean orphaned cache rows
-- =============================================
DELETE FROM public.sector_hot_members_latest WHERE (group_code, ticker) NOT IN (
  SELECT group_code, ticker FROM public.sector_hot_group_members WHERE is_active = true
);

-- Update meta to indicate mapping changed
UPDATE public.sector_hot_meta SET status = 'mapping_updated', message = 'Mapping updated. Run refresh to repopulate cache.', updated_at = now() WHERE id = 'latest';
