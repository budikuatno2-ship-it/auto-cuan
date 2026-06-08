-- =============================================
-- SECTOR HOT GROUP MAPPING v2 — Revised complete mapping
-- Safe idempotent patch. Can be re-run safely.
-- Adds member_type column, deactivates old members, upserts new mapping.
-- Run this in Supabase SQL Editor manually.
-- =============================================

-- Step 1: Add member_type column if not exists
ALTER TABLE sector_hot_group_members ADD COLUMN IF NOT EXISTS member_type TEXT DEFAULT 'CORE';

-- Step 2: Deactivate ALL old members (will reactivate new ones below)
UPDATE sector_hot_group_members SET is_active = false WHERE is_active = true;

-- Step 3: Upsert groups
INSERT INTO sector_hot_groups (group_code, group_name, owner_label, sort_order, is_active) VALUES
('BUMN_MIND_ID_CORE', 'BUMN MIND ID Core', 'Pemerintah RI / MIND ID', 1, true),
('BUMN_BANK_CORE', 'BUMN Bank Core', 'Pemerintah RI', 2, true),
('BUMN_TELCO', 'BUMN Telco', 'Pemerintah RI', 3, true),
('BUMN_KARYA', 'BUMN Karya & Infrastruktur', 'Pemerintah RI', 4, true),
('BUMN_ENERGY', 'BUMN Energy', 'Pemerintah RI', 5, true),
('BUMN_OTHERS', 'BUMN Others', 'Pemerintah RI', 6, true),
('SALIM', 'Salim Group', 'Anthoni Salim', 7, true),
('SINARMAS', 'Sinarmas Group', 'Eka Tjipta Widjaja Family', 8, true),
('DJARUM', 'Djarum Group', 'Hartono Brothers', 9, true),
('ASTRA', 'Astra International Group', 'Jardine Matheson / Salim', 10, true),
('LIPPO', 'Lippo Group', 'Mochtar Riady Family', 11, true),
('BARITO', 'Barito Pacific Group', 'Prajogo Pangestu', 12, true),
('ADARO', 'Adaro Group', 'Garibaldi Thohir', 13, true),
('SARATOGA', 'Saratoga Group', 'Sandiaga / Edwin Soeryadjaya', 14, true),
('CT_CORP', 'CT Corp', 'Chairul Tanjung', 15, true),
('EMTEK', 'Emtek Group', 'Sariaatmadja Family', 16, true),
('MNC', 'MNC Group', 'Hary Tanoesoedibjo', 17, true),
('BAKRIE', 'Bakrie Group', 'Bakrie Family', 18, true),
('PANIN', 'Panin Group', 'Mu''min Ali Gunawan', 19, true),
('KALBE', 'Kalbe Group', 'Boenjamin Setiawan Family', 20, true),
('CHAROEN_POKPHAND', 'Charoen Pokphand Group', 'Dhanin Chearavanont', 21, true),
('CIPUTRA', 'Ciputra Group', 'Ciputra Family', 22, true),
('SUMMARECON', 'Summarecon Group', 'Soetjipto Nagaria', 23, true),
('MAYORA', 'Mayora Group', 'Jogi Hendra Atmadja', 24, true),
('GAJAH_TUNGGAL', 'Gajah Tunggal Group', 'Sjamsul Nursalim', 25, true),
('MAYAPADA', 'Mayapada Group', 'Dato Sri Tahir', 26, true),
('WILMAR', 'Wilmar Group', 'Martua Sitorus / Kuok', 27, true),
('TOBA', 'Toba Bara Group', 'Luhut Panjaitan Family', 28, true),
('TRIPUTRA', 'Triputra Group', 'Theodore Rachmat', 29, true),
('PODOMORO', 'Agung Podomoro Group', 'Trihatma Haliman', 30, true),
('JAPFA', 'Japfa Group', 'Japfa Family', 31, true),
('PJAYA', 'Pembangunan Jaya Group', 'Pembangunan Jaya / Ciputra', 32, true),
('PAKUWON', 'Pakuwon Group', 'Alexander Tedja', 33, true),
('MATAHARI', 'Matahari Group', 'Lippo / CVC', 34, true),
('AGUAN', 'Aguan Group (Agung Sedayu)', 'Sugianto Kusuma (Aguan)', 35, true),
('HARUM', 'Harum Energy Group', 'Kiki Barki', 36, true),
('ALAM_SUTERA', 'Alam Sutera Group', 'Harjanto Tirtohadiguno', 37, true),
('MERDEKA', 'Merdeka Group', 'Garibaldi Thohir / Sandiaga', 38, true),
('INDIKA', 'Indika Energy Group', 'Wishnu Wardhana', 39, true),
('ABM', 'ABM Investama Group', 'Tiara Marga Trakindo', 40, true)
ON CONFLICT (group_code) DO UPDATE SET
  group_name = EXCLUDED.group_name,
  owner_label = EXCLUDED.owner_label,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  updated_at = now();

-- Step 4: Upsert members (activate new mapping)
-- BUMN_MIND_ID_CORE
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('BUMN_MIND_ID_CORE', 'ANTM', 'Aneka Tambang', 'CORE', true, 1),
('BUMN_MIND_ID_CORE', 'PTBA', 'Bukit Asam', 'CORE', true, 2),
('BUMN_MIND_ID_CORE', 'TINS', 'Timah', 'CORE', true, 3),
('BUMN_MIND_ID_CORE', 'INCO', 'Vale Indonesia', 'CORE', true, 4),
('BUMN_MIND_ID_CORE', 'MDKA', 'Merdeka Copper Gold', 'CORE', true, 5)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- BUMN_BANK_CORE
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('BUMN_BANK_CORE', 'BBRI', 'Bank BRI', 'CORE', true, 1),
('BUMN_BANK_CORE', 'BMRI', 'Bank Mandiri', 'CORE', true, 2),
('BUMN_BANK_CORE', 'BBNI', 'Bank BNI', 'CORE', true, 3),
('BUMN_BANK_CORE', 'BBTN', 'Bank BTN', 'CORE', true, 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- BUMN_TELCO
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('BUMN_TELCO', 'TLKM', 'Telkom Indonesia', 'CORE', true, 1),
('BUMN_TELCO', 'MTEL', 'Dayamitra Telekomunikasi', 'CORE', true, 2),
('BUMN_TELCO', 'EXCL', 'XL Axiata', 'CORE', true, 3),
('BUMN_TELCO', 'ISAT', 'Indosat Ooredoo', 'CORE', true, 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- BUMN_KARYA
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('BUMN_KARYA', 'WIKA', 'Wijaya Karya', 'CORE', true, 1),
('BUMN_KARYA', 'PTPP', 'PP Persero', 'CORE', true, 2),
('BUMN_KARYA', 'WSKT', 'Waskita Karya', 'CORE', true, 3),
('BUMN_KARYA', 'ADHI', 'Adhi Karya', 'CORE', true, 4),
('BUMN_KARYA', 'WTON', 'Wijaya Karya Beton', 'CORE', true, 5),
('BUMN_KARYA', 'JSMR', 'Jasa Marga', 'CORE', true, 6),
('BUMN_KARYA', 'WEGE', 'Wijaya Karya Bangunan Gedung', 'CORE', true, 7)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- BUMN_ENERGY
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('BUMN_ENERGY', 'PGAS', 'Perusahaan Gas Negara', 'CORE', true, 1),
('BUMN_ENERGY', 'AKRA', 'AKR Corporindo', 'CORE', true, 2),
('BUMN_ENERGY', 'ELSA', 'Elnusa', 'CORE', true, 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- BUMN_OTHERS
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('BUMN_OTHERS', 'SMGR', 'Semen Indonesia', 'CORE', true, 1),
('BUMN_OTHERS', 'KAEF', 'Kimia Farma', 'CORE', true, 2),
('BUMN_OTHERS', 'INAF', 'Indofarma', 'CORE', true, 3),
('BUMN_OTHERS', 'KRAS', 'Krakatau Steel', 'CORE', true, 4),
('BUMN_OTHERS', 'SMBR', 'Semen Baturaja', 'CORE', true, 5),
('BUMN_OTHERS', 'GIAA', 'Garuda Indonesia', 'CORE', true, 6),
('BUMN_OTHERS', 'PPRO', 'PP Properti', 'CORE', true, 7)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- SALIM
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('SALIM', 'INDF', 'Indofood Sukses Makmur', 'CORE', true, 1),
('SALIM', 'ICBP', 'Indofood CBP', 'CORE', true, 2),
('SALIM', 'SIMP', 'Salim Ivomas Pratama', 'CORE', true, 3),
('SALIM', 'LSIP', 'London Sumatra', 'CORE', true, 4),
('SALIM', 'IMAS', 'Indomobil', 'CORE', true, 5),
('SALIM', 'PANI', 'Pantai Indah Kapuk Dua', 'CORE', true, 6),
('SALIM', 'CMRY', 'Cisarua Mountain Dairy', 'CORE', true, 7),
('SALIM', 'CSAP', 'Catur Sentosa Adiprana', 'CORE', true, 8)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- SINARMAS
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('SINARMAS', 'SMAR', 'Smart Tbk', 'CORE', true, 1),
('SINARMAS', 'INKP', 'Indah Kiat Pulp & Paper', 'CORE', true, 2),
('SINARMAS', 'TKIM', 'Pabrik Kertas Tjiwi Kimia', 'CORE', true, 3),
('SINARMAS', 'DSSA', 'Dian Swastatika Sentosa', 'CORE', true, 4),
('SINARMAS', 'SMMA', 'Sinarmas Multiartha', 'CORE', true, 5),
('SINARMAS', 'BSDE', 'Bumi Serpong Damai', 'CORE', true, 6),
('SINARMAS', 'DUTI', 'Duta Pertiwi', 'CORE', true, 7)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- DJARUM
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('DJARUM', 'BBCA', 'Bank Central Asia', 'CORE', true, 1),
('DJARUM', 'DNET', 'Indoritel Makmur Internasional', 'CORE', true, 2),
('DJARUM', 'TOWR', 'Sarana Menara Nusantara', 'CORE', true, 3),
('DJARUM', 'EMTK', 'Elang Mahkota Teknologi', 'CORE', true, 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- ASTRA
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('ASTRA', 'ASII', 'Astra International', 'CORE', true, 1),
('ASTRA', 'AALI', 'Astra Agro Lestari', 'CORE', true, 2),
('ASTRA', 'UNTR', 'United Tractors', 'CORE', true, 3),
('ASTRA', 'AUTO', 'Astra Otoparts', 'CORE', true, 4),
('ASTRA', 'ACST', 'Acset Indonusa', 'CORE', true, 5)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- LIPPO
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('LIPPO', 'LPKR', 'Lippo Karawaci', 'CORE', true, 1),
('LIPPO', 'LPCK', 'Lippo Cikarang', 'CORE', true, 2),
('LIPPO', 'SILO', 'Siloam International Hospitals', 'CORE', true, 3),
('LIPPO', 'LPPF', 'Matahari Department Store', 'CORE', true, 4),
('LIPPO', 'LPGI', 'Lippo General Insurance', 'CORE', true, 5),
('LIPPO', 'MLPL', 'Multipolar', 'CORE', true, 6),
('LIPPO', 'MLPT', 'Multipolar Technology', 'CORE', true, 7),
('LIPPO', 'LPIN', 'Multi Prima Sejahtera', 'CORE', true, 8)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- BARITO
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('BARITO', 'BRPT', 'Barito Pacific', 'CORE', true, 1),
('BARITO', 'BREN', 'Barito Renewables Energy', 'CORE', true, 2),
('BARITO', 'TPIA', 'Chandra Asri Pacific', 'CORE', true, 3),
('BARITO', 'PTRO', 'Petrosea', 'CORE', true, 4),
('BARITO', 'CDIA', 'Cisadane Sawit Raya', 'CORE', true, 5),
('BARITO', 'MEDC', 'Medco Energi Internasional', 'CORE', true, 6)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- ADARO
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('ADARO', 'ADRO', 'Adaro Energy', 'CORE', true, 1),
('ADARO', 'ADMR', 'Adaro Minerals', 'CORE', true, 2),
('ADARO', 'AADI', 'Adaro Andalan Indonesia', 'CORE', true, 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- SARATOGA
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('SARATOGA', 'SRTG', 'Saratoga Investama Sedaya', 'CORE', true, 1),
('SARATOGA', 'ADRO', 'Adaro Energy', 'CORE', true, 2),
('SARATOGA', 'TBIG', 'Tower Bersama Infrastructure', 'CORE', true, 3),
('SARATOGA', 'ADMR', 'Adaro Minerals', 'CORE', true, 4),
('SARATOGA', 'MPMX', 'Mitra Pinasthika Mustika', 'CORE', true, 5)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- CT_CORP
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('CT_CORP', 'MEGA', 'Bank Mega', 'CORE', true, 1),
('CT_CORP', 'CARS', 'Mobilindo Nusa Persada', 'CORE', true, 2),
('CT_CORP', 'ARTO', 'Bank Jago', 'CORE', true, 3),
('CT_CORP', 'HEAL', 'Medikaloka Hermina', 'CORE', true, 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- EMTEK
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('EMTEK', 'EMTK', 'Elang Mahkota Teknologi', 'CORE', true, 1),
('EMTEK', 'SCMA', 'Surya Citra Media', 'CORE', true, 2),
('EMTEK', 'DCII', 'DCI Indonesia', 'CORE', true, 3),
('EMTEK', 'BUKA', 'Bukalapak', 'CORE', true, 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- MNC
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('MNC', 'BHIT', 'MNC Asia Holding', 'CORE', true, 1),
('MNC', 'BMTR', 'Global Mediacom', 'CORE', true, 2),
('MNC', 'FILM', 'MD Entertainment', 'CORE', true, 3),
('MNC', 'MNCN', 'MNC Digital Entertainment', 'CORE', true, 4),
('MNC', 'IPTV', 'MNC Vision Networks', 'CORE', true, 5),
('MNC', 'NETV', 'Net Visi Media', 'CORE', true, 6),
('MNC', 'KPIG', 'MNC Land', 'CORE', true, 7),
('MNC', 'BCAP', 'MNC Kapital Indonesia', 'CORE', true, 8),
('MNC', 'ABBA', 'Mahaka Media', 'CORE', true, 9),
('MNC', 'BABP', 'Bank MNC Internasional', 'CORE', true, 10),
('MNC', 'IATA', 'MNC Energy', 'CORE', true, 11)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- BAKRIE
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('BAKRIE', 'BNBR', 'Bakrie & Brothers', 'CORE', true, 1),
('BAKRIE', 'BUMI', 'Bumi Resources', 'CORE', true, 2),
('BAKRIE', 'DEWA', 'Darma Henwa', 'CORE', true, 3),
('BAKRIE', 'BRMS', 'Bumi Resources Minerals', 'CORE', true, 4),
('BAKRIE', 'ELTY', 'Bakrieland Development', 'CORE', true, 5),
('BAKRIE', 'VIVA', 'Visi Media Asia', 'CORE', true, 6),
('BAKRIE', 'ENRG', 'Energi Mega Persada', 'CORE', true, 7)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- PANIN
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('PANIN', 'PNBN', 'Bank Pan Indonesia', 'CORE', true, 1),
('PANIN', 'PNIN', 'Panin Insurance', 'CORE', true, 2),
('PANIN', 'PNLF', 'Panin Financial', 'CORE', true, 3),
('PANIN', 'PNBS', 'Bank Panin Dubai Syariah', 'CORE', true, 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- KALBE
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('KALBE', 'KLBF', 'Kalbe Farma', 'CORE', true, 1),
('KALBE', 'MIKA', 'Mitra Keluarga Karyasehat', 'CORE', true, 2),
('KALBE', 'SIDO', 'Industri Jamu Sido Muncul', 'CORE', true, 3),
('KALBE', 'TSPC', 'Tempo Scan Pacific', 'CORE', true, 4)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- CHAROEN_POKPHAND
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('CHAROEN_POKPHAND', 'CPIN', 'Charoen Pokphand Indonesia', 'CORE', true, 1),
('CHAROEN_POKPHAND', 'MAIN', 'Malindo Feedmill', 'CORE', true, 2),
('CHAROEN_POKPHAND', 'CPRO', 'Central Proteina Prima', 'CORE', true, 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- CIPUTRA
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('CIPUTRA', 'CTRA', 'Ciputra Development', 'CORE', true, 1),
('CIPUTRA', 'CTRS', 'Ciputra Surya', 'CORE', true, 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- SUMMARECON
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('SUMMARECON', 'SMRA', 'Summarecon Agung', 'CORE', true, 1),
('SUMMARECON', 'SMDM', 'Suryamas Dutamakmur', 'CORE', true, 2),
('SUMMARECON', 'DILD', 'Intiland Development', 'CORE', true, 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- MAYORA
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('MAYORA', 'MYOR', 'Mayora Indah', 'CORE', true, 1),
('MAYORA', 'CEKA', 'Wilmar Cahaya Indonesia', 'CORE', true, 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- GAJAH_TUNGGAL
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('GAJAH_TUNGGAL', 'GJTL', 'Gajah Tunggal', 'CORE', true, 1),
('GAJAH_TUNGGAL', 'MASA', 'Multistrada Arah Sarana', 'CORE', true, 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- MAYAPADA
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('MAYAPADA', 'MAYA', 'Bank Mayapada Internasional', 'CORE', true, 1),
('MAYAPADA', 'SDPC', 'Millennium Pharmacon', 'CORE', true, 2),
('MAYAPADA', 'SRAJ', 'Sejahteraraya Anugrahjaya', 'CORE', true, 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- WILMAR
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('WILMAR', 'SGRO', 'Sampoerna Agro', 'CORE', true, 1),
('WILMAR', 'SIMP', 'Salim Ivomas Pratama', 'CORE', true, 2),
('WILMAR', 'LSIP', 'London Sumatra', 'CORE', true, 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- TOBA
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('TOBA', 'TOBA', 'Toba Bara Sejahtra', 'CORE', true, 1),
('TOBA', 'NCKL', 'Trimegah Bangun Persada', 'CORE', true, 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- TRIPUTRA
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('TRIPUTRA', 'DSNG', 'Dharma Satya Nusantara', 'CORE', true, 1),
('TRIPUTRA', 'ADMR', 'Adaro Minerals', 'CORE', true, 2),
('TRIPUTRA', 'TAPG', 'Triputra Agro Persada', 'CORE', true, 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- PODOMORO
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('PODOMORO', 'APLN', 'Agung Podomoro Land', 'CORE', true, 1),
('PODOMORO', 'GMTD', 'Gowa Makassar Tourism Dev', 'CORE', true, 2),
('PODOMORO', 'KIJA', 'Kawasan Industri Jababeka', 'CORE', true, 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- JAPFA
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('JAPFA', 'JPFA', 'Japfa Comfeed Indonesia', 'CORE', true, 1),
('JAPFA', 'SIPD', 'Sreeya Sewu Indonesia', 'CORE', true, 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- PJAYA
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('PJAYA', 'JRPT', 'Jaya Real Property', 'CORE', true, 1),
('PJAYA', 'PJAA', 'Pembangunan Jaya Ancol', 'CORE', true, 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- PAKUWON
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('PAKUWON', 'PWON', 'Pakuwon Jati', 'CORE', true, 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- MATAHARI
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('MATAHARI', 'LPPF', 'Matahari Department Store', 'CORE', true, 1),
('MATAHARI', 'MPPA', 'Matahari Putra Prima', 'CORE', true, 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- AGUAN
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('AGUAN', 'PANI', 'Pantai Indah Kapuk Dua', 'CORE', true, 1),
('AGUAN', 'SSIA', 'Surya Semesta Internusa', 'CORE', true, 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- HARUM
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('HARUM', 'HRUM', 'Harum Energy', 'CORE', true, 1),
('HARUM', 'NCKL', 'Trimegah Bangun Persada', 'CORE', true, 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- ALAM_SUTERA
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('ALAM_SUTERA', 'ASRI', 'Alam Sutera Realty', 'CORE', true, 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- MERDEKA
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('MERDEKA', 'MDKA', 'Merdeka Copper Gold', 'CORE', true, 1),
('MERDEKA', 'MBMA', 'Merdeka Battery Materials', 'CORE', true, 2),
('MERDEKA', 'ADMR', 'Adaro Minerals', 'CORE', true, 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- INDIKA
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('INDIKA', 'INDY', 'Indika Energy', 'CORE', true, 1),
('INDIKA', 'PTRO', 'Petrosea', 'CORE', true, 2),
('INDIKA', 'MBSS', 'Mitrabahtera Segara Sejati', 'CORE', true, 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- ABM
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('ABM', 'ABMM', 'ABM Investama', 'CORE', true, 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  is_active = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- =============================================
-- Done. Verify with:
-- SELECT g.group_code, g.group_name, COUNT(m.ticker) as member_count
-- FROM sector_hot_groups g
-- LEFT JOIN sector_hot_group_members m ON g.group_code = m.group_code AND m.is_active = true
-- WHERE g.is_active = true
-- GROUP BY g.group_code, g.group_name
-- ORDER BY g.sort_order;
-- =============================================
