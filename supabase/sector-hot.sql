-- =============================================
-- SEKTOR HOT / GRUP KONGLOMERAT HOT — SCHEMA + SEED
-- Run this in Supabase SQL Editor manually.
-- Do NOT run automatically.
-- =============================================

-- Table 1: Group definitions (curated mapping)
CREATE TABLE IF NOT EXISTS public.sector_hot_groups (
  group_code text PRIMARY KEY,
  group_name text NOT NULL,
  owner_label text,
  description text,
  is_active boolean DEFAULT true,
  sort_order int DEFAULT 999,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Table 2: Group members (ticker mapping)
CREATE TABLE IF NOT EXISTS public.sector_hot_group_members (
  id bigserial PRIMARY KEY,
  group_code text NOT NULL REFERENCES public.sector_hot_groups(group_code) ON DELETE CASCADE,
  ticker text NOT NULL,
  stock_name text NOT NULL,
  member_type text NOT NULL DEFAULT 'Member' CHECK (member_type IN ('ANCHOR', 'Member')),
  is_active boolean DEFAULT true,
  sort_order int DEFAULT 999,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(group_code, ticker)
);

-- Table 3: Latest group summary cache (one row per group)
CREATE TABLE IF NOT EXISTS public.sector_hot_latest (
  group_code text PRIMARY KEY REFERENCES public.sector_hot_groups(group_code) ON DELETE CASCADE,
  group_name text,
  owner_label text,
  avg_change_pct numeric,
  stock_count int,
  valid_count int,
  top_ticker text,
  top_change_pct numeric,
  avg_volume_ratio numeric,
  calculated_at timestamptz DEFAULT now(),
  status text,
  message text
);

-- Table 4: Latest member-level data cache
CREATE TABLE IF NOT EXISTS public.sector_hot_members_latest (
  id bigserial PRIMARY KEY,
  group_code text NOT NULL,
  ticker text NOT NULL,
  stock_name text,
  last_price numeric,
  change_pct numeric,
  volume_today bigint,
  avg_volume_30d numeric,
  volume_ratio_30d numeric,
  member_type text NOT NULL DEFAULT 'Member' CHECK (member_type IN ('ANCHOR', 'Member')),
  calculated_at timestamptz DEFAULT now(),
  UNIQUE(group_code, ticker),
  FOREIGN KEY (group_code, ticker) REFERENCES public.sector_hot_group_members(group_code, ticker) ON DELETE CASCADE
);

-- Table 5: Global refresh metadata
CREATE TABLE IF NOT EXISTS public.sector_hot_meta (
  id text PRIMARY KEY DEFAULT 'latest',
  calculated_at timestamptz,
  scanned_count int DEFAULT 0,
  failed_count int DEFAULT 0,
  status text,
  message text,
  updated_at timestamptz DEFAULT now()
);

-- RLS: Enable on all tables, reads via service role only
ALTER TABLE public.sector_hot_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sector_hot_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sector_hot_latest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sector_hot_members_latest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sector_hot_meta ENABLE ROW LEVEL SECURITY;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_shgm_group ON public.sector_hot_group_members(group_code);
CREATE INDEX IF NOT EXISTS idx_shml_group ON public.sector_hot_members_latest(group_code);

-- =============================================
-- SEED: GRUP KONGLOMERAT MAPPING
-- =============================================

INSERT INTO public.sector_hot_groups (group_code, group_name, owner_label, sort_order) VALUES
('BUMN_TAMBANG', 'BUMN Tambang (MIND ID Holding)', 'MIND ID / Pemerintah RI', 1),
('BUMN_BANK', 'BUMN Bank', 'Pemerintah RI', 2),
('BUMN_TELCO', 'BUMN Telco & Infrastruktur Digital', 'Pemerintah RI', 3),
('BUMN_KARYA', 'BUMN Karya', 'Pemerintah RI', 4),
('SALIM', 'Salim Group (Anthoni Salim)', 'Anthoni Salim', 10),
('SINARMAS', 'Sinarmas Group (Eka Tjipta Widjaja)', 'Eka Tjipta Widjaja', 11),
('DJARUM', 'Djarum Group (Hartono Brothers)', 'Robert Budi Hartono & Michael Bambang Hartono', 12),
('LIPPO', 'Lippo Group (Mochtar Riady)', 'Mochtar Riady', 13),
('BARITO', 'Barito Group (Prajogo Pangestu)', 'Prajogo Pangestu', 14),
('ADARO', 'Adaro Group (Garibaldi Thohir & Edwin Soeryadjaya)', 'Garibaldi Thohir & Edwin Soeryadjaya', 15),
('SARATOGA', 'Saratoga Group (Edwin Soeryadjaya & Sandiaga Uno)', 'Edwin Soeryadjaya & Sandiaga Uno', 16),
('CT_CORP', 'CT Corp (Chairul Tanjung)', 'Chairul Tanjung', 17),
('EMTEK', 'Emtek Group (Eddy Kusnadi Sariaatmadja)', 'Eddy Kusnadi Sariaatmadja', 18),
('MNC', 'MNC Group (Hary Tanoesoedibjo)', 'Hary Tanoesoedibjo', 19),
('MAYAPADA', 'Mayapada Group (Dato Sri Tahir)', 'Dato Sri Tahir', 20),
('WILMAR', 'Wilmar Group (Martua Sitorus)', 'Martua Sitorus', 21),
('TOBA', 'Toba Group (Luhut Binsar Pandjaitan)', 'Luhut Binsar Pandjaitan', 22),
('TRIPUTRA', 'Triputra Group (TP Rachmat)', 'TP Rachmat', 23),
('PODOMORO', 'Agung Podomoro Group (Trihatma Haliman)', 'Trihatma Haliman', 24),
('PANIN', 'Panin Group (Mu''min Ali Gunawan)', 'Mu''min Ali Gunawan', 25),
('KALBE', 'Kalbe Group (Boenjamin Setiawan)', 'Boenjamin Setiawan', 26),
('CHAROEN_POKPHAND', 'Charoen Pokphand Group (Dhanin Chearavanont)', 'Dhanin Chearavanont', 27),
('CIPUTRA', 'Ciputra Group', 'Ciputra Family', 28),
('SUMMARECON', 'Summarecon Group (Soetjipto Nagaria)', 'Soetjipto Nagaria', 29),
('MAYORA', 'Mayora Group (Jogi Hendra Atmadja)', 'Jogi Hendra Atmadja', 30),
('BAKRIE', 'Bakrie Group (Aburizal Bakrie)', 'Aburizal Bakrie', 31),
('GAJAH_TUNGGAL', 'Gajah Tunggal Group (Sjamsul Nursalim)', 'Sjamsul Nursalim', 32)
ON CONFLICT (group_code) DO UPDATE SET
  group_name = EXCLUDED.group_name,
  owner_label = EXCLUDED.owner_label,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- MEMBERS SEED
INSERT INTO public.sector_hot_group_members (group_code, ticker, stock_name, member_type, sort_order) VALUES
-- BUMN_TAMBANG
('BUMN_TAMBANG', 'ANTM', 'Aneka Tambang Tbk.', 'ANCHOR', 1),
('BUMN_TAMBANG', 'PTBA', 'Bukit Asam (Persero) Tbk.', 'Member', 2),
('BUMN_TAMBANG', 'TINS', 'Timah Tbk.', 'Member', 3),
('BUMN_TAMBANG', 'INCO', 'Vale Indonesia Tbk.', 'Member', 4),
('BUMN_TAMBANG', 'MDKA', 'Merdeka Copper Gold Tbk.', 'Member', 5),
-- BUMN_BANK
('BUMN_BANK', 'BBRI', 'Bank Rakyat Indonesia Tbk.', 'ANCHOR', 1),
('BUMN_BANK', 'BMRI', 'Bank Mandiri (Persero) Tbk.', 'Member', 2),
('BUMN_BANK', 'BBNI', 'Bank Negara Indonesia Tbk.', 'Member', 3),
('BUMN_BANK', 'BBTN', 'Bank Tabungan Negara Tbk.', 'Member', 4),
-- BUMN_TELCO
('BUMN_TELCO', 'TLKM', 'Telkom Indonesia Tbk.', 'ANCHOR', 1),
('BUMN_TELCO', 'EXCL', 'XLSmart Telecom Sejahtera Tbk.', 'Member', 2),
('BUMN_TELCO', 'ISAT', 'Indosat Ooredoo Hutchison Tbk.', 'Member', 3),
-- BUMN_KARYA
('BUMN_KARYA', 'WIKA', 'Wijaya Karya (Persero) Tbk.', 'ANCHOR', 1),
('BUMN_KARYA', 'WSKT', 'Waskita Karya (Persero) Tbk.', 'Member', 2),
('BUMN_KARYA', 'PTPP', 'PP (Persero) Tbk.', 'Member', 3),
('BUMN_KARYA', 'ADHI', 'Adhi Karya (Persero) Tbk.', 'Member', 4),
-- SALIM
('SALIM', 'INDF', 'Indofood Sukses Makmur Tbk.', 'ANCHOR', 1),
('SALIM', 'ICBP', 'Indofood CBP Sukses Makmur Tbk.', 'Member', 2),
('SALIM', 'ACES', 'Aspirasi Hidup Indonesia Tbk.', 'Member', 3),
-- SINARMAS
('SINARMAS', 'BSDE', 'Bumi Serpong Damai Tbk.', 'ANCHOR', 1),
('SINARMAS', 'DSSA', 'Dian Swastatika Sentosa Tbk.', 'Member', 2),
-- DJARUM
('DJARUM', 'BBCA', 'Bank Central Asia Tbk.', 'ANCHOR', 1),
('DJARUM', 'HMSP', 'HM Sampoerna Tbk.', 'Member', 2),
-- LIPPO
('LIPPO', 'LPKR', 'Lippo Karawaci Tbk.', 'ANCHOR', 1),
('LIPPO', 'MPPA', 'Matahari Putra Prima Tbk.', 'Member', 2),
('LIPPO', 'MLPL', 'Multipolar Tbk.', 'Member', 3),
-- BARITO
('BARITO', 'BRPT', 'Barito Pacific Tbk.', 'ANCHOR', 1),
('BARITO', 'BREN', 'Barito Renewables Energy Tbk.', 'Member', 2),
('BARITO', 'TPIA', 'Chandra Asri Pacific Tbk.', 'Member', 3),
-- ADARO
('ADARO', 'ADRO', 'Alamtri Resources Indonesia Tbk.', 'ANCHOR', 1),
('ADARO', 'ADMR', 'Alamtri Minerals Indonesia Tbk.', 'Member', 2),
-- SARATOGA
('SARATOGA', 'SRTG', 'Saratoga Investama Sedaya Tbk.', 'ANCHOR', 1),
('SARATOGA', 'MDKA', 'Merdeka Copper Gold Tbk.', 'Member', 2),
('SARATOGA', 'TBIG', 'Tower Bersama Infrastructure Tbk.', 'Member', 3),
-- CT_CORP
('CT_CORP', 'MEGA', 'Bank Mega Tbk.', 'ANCHOR', 1),
('CT_CORP', 'CARS', 'Industri dan Perdagangan Bintraco Dharma Tbk.', 'Member', 2),
-- EMTEK
('EMTEK', 'EMTK', 'Elang Mahkota Teknologi Tbk.', 'ANCHOR', 1),
('EMTEK', 'SCMA', 'Surya Citra Media Tbk.', 'Member', 2),
-- MNC
('MNC', 'MNCN', 'MNC Digital Entertainment Tbk.', 'ANCHOR', 1),
('MNC', 'BHIT', 'MNC Asia Holding Tbk.', 'Member', 2),
('MNC', 'BABP', 'Bank MNC Internasional Tbk.', 'Member', 3),
-- MAYAPADA
('MAYAPADA', 'MAYA', 'Bank Mayapada Internasional Tbk.', 'ANCHOR', 1),
-- WILMAR
('WILMAR', 'SIMP', 'Salim Ivomas Pratama Tbk.', 'ANCHOR', 1),
-- TOBA
('TOBA', 'TOBA', 'Toba Bara Sejahtra Tbk.', 'ANCHOR', 1),
('TOBA', 'NCKL', 'Trimegah Bangun Persada Tbk.', 'Member', 2),
-- TRIPUTRA
('TRIPUTRA', 'DSNG', 'Dharma Satya Nusantara Tbk.', 'ANCHOR', 1),
('TRIPUTRA', 'ADMR', 'Alamtri Minerals Indonesia Tbk.', 'Member', 2),
-- PODOMORO
('PODOMORO', 'APLN', 'Agung Podomoro Land Tbk.', 'ANCHOR', 1),
('PODOMORO', 'GMTD', 'Gowa Makassar Tourism Development Tbk.', 'Member', 2),
-- PANIN
('PANIN', 'PNBN', 'Bank Pan Indonesia Tbk.', 'ANCHOR', 1),
('PANIN', 'PNLF', 'Panin Financial Tbk.', 'Member', 2),
-- KALBE
('KALBE', 'KLBF', 'Kalbe Farma Tbk.', 'ANCHOR', 1),
-- CHAROEN_POKPHAND
('CHAROEN_POKPHAND', 'CPIN', 'Charoen Pokphand Indonesia Tbk.', 'ANCHOR', 1),
('CHAROEN_POKPHAND', 'CPRO', 'Central Proteina Prima Tbk.', 'Member', 2),
-- CIPUTRA
('CIPUTRA', 'CTRA', 'Ciputra Development Tbk.', 'ANCHOR', 1),
-- SUMMARECON
('SUMMARECON', 'SMRA', 'Summarecon Agung Tbk.', 'ANCHOR', 1),
-- MAYORA
('MAYORA', 'MYOR', 'Mayora Indah Tbk.', 'ANCHOR', 1),
-- BAKRIE
('BAKRIE', 'BUMI', 'Bumi Resources Tbk.', 'ANCHOR', 1),
('BAKRIE', 'ENRG', 'Energi Mega Persada Tbk.', 'Member', 2),
('BAKRIE', 'BNBR', 'Bakrie & Brothers Tbk.', 'Member', 3),
-- GAJAH_TUNGGAL
('GAJAH_TUNGGAL', 'GJTL', 'Gajah Tunggal Tbk.', 'ANCHOR', 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  stock_name = EXCLUDED.stock_name,
  member_type = EXCLUDED.member_type,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- Initialize meta row
INSERT INTO public.sector_hot_meta (id, status, message)
VALUES ('latest', 'pending', 'Awaiting first calculation.')
ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status,
  message = EXCLUDED.message,
  updated_at = now();
