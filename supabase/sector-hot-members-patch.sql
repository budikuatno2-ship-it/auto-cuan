-- =============================================
-- SECTOR HOT MEMBERS PATCH — Expand group mappings
-- Run this in Supabase SQL Editor manually.
-- Safe to re-run (uses ON CONFLICT DO UPDATE).
-- =============================================

-- KALBE (add subsidiaries)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('KALBE', 'KLBF', 'Kalbe Farma Tbk.', 'ANCHOR', 1),
('KALBE', 'SIDO', 'Industri Jamu dan Farmasi Sido Muncul Tbk.', 'Member', 2),
('KALBE', 'TSPC', 'Tempo Scan Pacific Tbk.', 'Member', 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- WILMAR (add palm oil / agri related)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('WILMAR', 'SIMP', 'Salim Ivomas Pratama Tbk.', 'ANCHOR', 1),
('WILMAR', 'LSIP', 'PP London Sumatra Indonesia Tbk.', 'Member', 2),
('WILMAR', 'SMAR', 'Smart Tbk.', 'Member', 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- MAYORA (add food/consumer)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('MAYORA', 'MYOR', 'Mayora Indah Tbk.', 'ANCHOR', 1),
('MAYORA', 'CEKA', 'Wilmar Cahaya Indonesia Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- SUMMARECON (add related property)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('SUMMARECON', 'SMRA', 'Summarecon Agung Tbk.', 'ANCHOR', 1),
('SUMMARECON', 'DILD', 'Intiland Development Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- CIPUTRA (add property)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('CIPUTRA', 'CTRA', 'Ciputra Development Tbk.', 'ANCHOR', 1),
('CIPUTRA', 'DUTI', 'Duta Pertiwi Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- SALIM (expand with more holdings)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('SALIM', 'INDF', 'Indofood Sukses Makmur Tbk.', 'ANCHOR', 1),
('SALIM', 'ICBP', 'Indofood CBP Sukses Makmur Tbk.', 'Member', 2),
('SALIM', 'ACES', 'Aspirasi Hidup Indonesia Tbk.', 'Member', 3),
('SALIM', 'MPPA', 'Matahari Putra Prima Tbk.', 'Member', 4),
('SALIM', 'DNET', 'Indoritel Makmur Internasional Tbk.', 'Member', 5)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- SINARMAS (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('SINARMAS', 'BSDE', 'Bumi Serpong Damai Tbk.', 'ANCHOR', 1),
('SINARMAS', 'DSSA', 'Dian Swastatika Sentosa Tbk.', 'Member', 2),
('SINARMAS', 'SMDM', 'Suryamas Dutamakmur Tbk.', 'Member', 3),
('SINARMAS', 'SMMA', 'Sinarmas Multiartha Tbk.', 'Member', 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- DJARUM (expand with BCA ecosystem)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('DJARUM', 'BBCA', 'Bank Central Asia Tbk.', 'ANCHOR', 1),
('DJARUM', 'HMSP', 'HM Sampoerna Tbk.', 'Member', 2),
('DJARUM', 'ARTO', 'Bank Jago Tbk.', 'Member', 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- LIPPO (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('LIPPO', 'LPKR', 'Lippo Karawaci Tbk.', 'ANCHOR', 1),
('LIPPO', 'MPPA', 'Matahari Putra Prima Tbk.', 'Member', 2),
('LIPPO', 'MLPL', 'Multipolar Tbk.', 'Member', 3),
('LIPPO', 'LPPF', 'Matahari Department Store Tbk.', 'Member', 4),
('LIPPO', 'SILO', 'Siloam International Hospitals Tbk.', 'Member', 5)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- BARITO (expand with energy/chemical)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('BARITO', 'BRPT', 'Barito Pacific Tbk.', 'ANCHOR', 1),
('BARITO', 'BREN', 'Barito Renewables Energy Tbk.', 'Member', 2),
('BARITO', 'TPIA', 'Chandra Asri Pacific Tbk.', 'Member', 3),
('BARITO', 'ESSA', 'Surya Esa Perkasa Tbk.', 'Member', 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- SARATOGA (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('SARATOGA', 'SRTG', 'Saratoga Investama Sedaya Tbk.', 'ANCHOR', 1),
('SARATOGA', 'MDKA', 'Merdeka Copper Gold Tbk.', 'Member', 2),
('SARATOGA', 'TBIG', 'Tower Bersama Infrastructure Tbk.', 'Member', 3),
('SARATOGA', 'ADRO', 'Alamtri Resources Indonesia Tbk.', 'Member', 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- CT_CORP (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('CT_CORP', 'MEGA', 'Bank Mega Tbk.', 'ANCHOR', 1),
('CT_CORP', 'CARS', 'Industri dan Perdagangan Bintraco Dharma Tbk.', 'Member', 2),
('CT_CORP', 'HEAL', 'Medikaloka Hermina Tbk.', 'Member', 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- EMTEK (expand with digital)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('EMTEK', 'EMTK', 'Elang Mahkota Teknologi Tbk.', 'ANCHOR', 1),
('EMTEK', 'SCMA', 'Surya Citra Media Tbk.', 'Member', 2),
('EMTEK', 'MSIN', 'MNC Studios International Tbk.', 'Member', 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- MNC (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('MNC', 'MNCN', 'MNC Digital Entertainment Tbk.', 'ANCHOR', 1),
('MNC', 'BHIT', 'MNC Asia Holding Tbk.', 'Member', 2),
('MNC', 'BABP', 'Bank MNC Internasional Tbk.', 'Member', 3),
('MNC', 'IATA', 'MNC Energy Investments Tbk.', 'Member', 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- PANIN (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('PANIN', 'PNBN', 'Bank Pan Indonesia Tbk.', 'ANCHOR', 1),
('PANIN', 'PNLF', 'Panin Financial Tbk.', 'Member', 2),
('PANIN', 'PNIN', 'Panin Insurance Tbk.', 'Member', 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- CHAROEN_POKPHAND (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('CHAROEN_POKPHAND', 'CPIN', 'Charoen Pokphand Indonesia Tbk.', 'ANCHOR', 1),
('CHAROEN_POKPHAND', 'CPRO', 'Central Proteina Prima Tbk.', 'Member', 2),
('CHAROEN_POKPHAND', 'JPFA', 'Japfa Comfeed Indonesia Tbk.', 'Member', 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- TOBA (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('TOBA', 'TOBA', 'Toba Bara Sejahtra Tbk.', 'ANCHOR', 1),
('TOBA', 'NCKL', 'Trimegah Bangun Persada Tbk.', 'Member', 2),
('TOBA', 'PTRO', 'Petrosea Tbk.', 'Member', 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- BAKRIE (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('BAKRIE', 'BUMI', 'Bumi Resources Tbk.', 'ANCHOR', 1),
('BAKRIE', 'ENRG', 'Energi Mega Persada Tbk.', 'Member', 2),
('BAKRIE', 'BNBR', 'Bakrie & Brothers Tbk.', 'Member', 3),
('BAKRIE', 'ELTY', 'Bakrieland Development Tbk.', 'Member', 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- GAJAH_TUNGGAL (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('GAJAH_TUNGGAL', 'GJTL', 'Gajah Tunggal Tbk.', 'ANCHOR', 1),
('GAJAH_TUNGGAL', 'MASA', 'Multistrada Arah Sarana Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- MAYAPADA (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('MAYAPADA', 'MAYA', 'Bank Mayapada Internasional Tbk.', 'ANCHOR', 1),
('MAYAPADA', 'SRAJ', 'Sejahteraraya Anugrahjaya Tbk.', 'Member', 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- PODOMORO (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('PODOMORO', 'APLN', 'Agung Podomoro Land Tbk.', 'ANCHOR', 1),
('PODOMORO', 'GMTD', 'Gowa Makassar Tourism Development Tbk.', 'Member', 2),
('PODOMORO', 'KIJA', 'Kawasan Industri Jababeka Tbk.', 'Member', 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- ADARO (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('ADARO', 'ADRO', 'Alamtri Resources Indonesia Tbk.', 'ANCHOR', 1),
('ADARO', 'ADMR', 'Alamtri Minerals Indonesia Tbk.', 'Member', 2),
('ADARO', 'AADI', 'Adaro Andalan Indonesia Tbk.', 'Member', 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- TRIPUTRA (expand)
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
('TRIPUTRA', 'DSNG', 'Dharma Satya Nusantara Tbk.', 'ANCHOR', 1),
('TRIPUTRA', 'ADMR', 'Alamtri Minerals Indonesia Tbk.', 'Member', 2),
('TRIPUTRA', 'TAPG', 'Triputra Agro Persada Tbk.', 'Member', 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name, member_type = EXCLUDED.member_type, sort_order = EXCLUDED.sort_order, updated_at = now();

-- Remove MPPA from SALIM (it's more accurately Lippo/Matahari)
-- Only remove if it was wrongly placed; keep if intentional cross-holding
-- DELETE FROM public.sector_hot_group_members WHERE group_code = 'SALIM' AND ticker = 'MPPA';
-- NOTE: MPPA can be in both SALIM and LIPPO as a cross-holding. Keeping both.
