-- =============================================
-- SECTOR HOT GROUP MAPPING v2 — Revised complete mapping
-- Uses exact CORE / AFFILIATE / RADAR classification.
-- Safe idempotent patch. Can be re-run safely.
-- Run this in Supabase SQL Editor manually.
-- =============================================

-- Step 1: Add member_type column if not exists
ALTER TABLE sector_hot_group_members ADD COLUMN IF NOT EXISTS member_type TEXT DEFAULT 'CORE';

-- Step 2: Deactivate ALL old members (will reactivate new ones below)
UPDATE sector_hot_group_members SET is_active = false WHERE is_active = true;

-- Step 3: Deactivate old groups (will reactivate new ones below)
UPDATE sector_hot_groups SET is_active = false WHERE is_active = true;

-- Step 4: Upsert groups with exact codes
INSERT INTO sector_hot_groups (group_code, group_name, owner_label, sort_order, is_active) VALUES
('BUMN_MIND_ID_CORE', 'BUMN MIND ID Core', 'Pemerintah RI / MIND ID', 1, true),
('BUMN_BANK_CORE', 'BUMN Bank Core', 'Pemerintah RI', 2, true),
('BUMN_TELCO_CORE', 'BUMN Telco Core', 'Pemerintah RI', 3, true),
('BUMN_KARYA_INFRA_CORE', 'BUMN Karya / Infra Core', 'Pemerintah RI', 4, true),
('BUMN_ENERGI_SEMEN_FARMA_TRANSPORT', 'BUMN Energi / Semen / Farma / Transport', 'Pemerintah RI', 5, true),
('TELCO_NON_BUMN', 'Telco Non-BUMN', 'Swasta', 6, true),
('THOHIR_ADARO_ALAMTRI_CORE', 'Thohir / Adaro / Alamtri Core', 'Garibaldi Thohir', 10, true),
('THOHIR_AFFILIATE_MARKET_LINKED', 'Thohir Affiliate / Market-linked', 'Garibaldi Thohir (affiliate)', 11, true),
('THOHIR_MAHAKA_TRINUGRAHA', 'Thohir / Mahaka / Trinugraha', 'Garibaldi Thohir (Mahaka)', 12, true),
('SARATOGA_PROVIDENT_CORE', 'Saratoga / Provident Core', 'Edwin Soeryadjaya / Sandiaga', 13, true),
('SARATOGA_PROVIDENT_AFFILIATE', 'Saratoga / Provident Affiliate', 'Saratoga (affiliate)', 14, true),
('SALIM_CORE', 'Salim Core', 'Anthoni Salim', 20, true),
('SALIM_AFFILIATE_INVESTEE', 'Salim Affiliate / Investee', 'Salim (affiliate/investee)', 21, true),
('SINARMAS_CORE', 'Sinarmas Core', 'Eka Tjipta Widjaja Family', 25, true),
('SINARMAS_HISTORICAL_MERGER', 'Sinarmas Historical / Merger', 'Sinarmas (historical)', 26, true),
('DJARUM_HARTONO_CORE', 'Djarum / Hartono Core', 'Robert & Michael Hartono', 30, true),
('DJARUM_HARTONO_AFFILIATE', 'Djarum / Hartono Affiliate', 'Hartono (affiliate)', 31, true),
('DJARUM_HARTONO_RADAR', 'Djarum / Hartono Radar', 'Hartono (radar)', 32, true),
('BARITO_PRAJOGO_CORE', 'Barito / Prajogo Core', 'Prajogo Pangestu', 35, true),
('BARITO_PRAJOGO_RADAR', 'Barito / Prajogo Radar', 'Prajogo (radar)', 36, true),
('LIPPO_CORE', 'Lippo Core', 'Mochtar Riady Family', 40, true),
('EMTEK_CORE', 'Emtek Core', 'Sariaatmadja Family', 45, true),
('MD_ENTERTAINMENT_CORE', 'MD Entertainment Core', 'Manoj Punjabi', 46, true),
('MNC_HARY_TANOE_CORE', 'MNC / Hary Tanoe Core', 'Hary Tanoesoedibjo', 47, true),
('BAKRIE_CORE', 'Bakrie Core', 'Bakrie Family', 50, true),
('BAKRIE_AFFILIATE_RADAR', 'Bakrie Affiliate / Radar', 'Bakrie (affiliate)', 51, true),
('ASTRA_JARDINE_CORE', 'Astra / Jardine Core', 'Jardine Matheson', 55, true),
('ASTRA_EX', 'Astra Ex / Historical', 'Astra (ex)', 56, true),
('TRIPUTRA_TP_RACHMAT_CORE', 'Triputra / TP Rachmat Core', 'TP Rachmat', 60, true),
('TBS_TOBA_CORE', 'TBS / Toba Core', 'Toba Group', 61, true),
('MAYAPADA_CORE', 'Mayapada Core', 'Dato Sri Tahir', 65, true),
('PANIN_CORE', 'Panin Core', 'Mu''min Ali Gunawan', 66, true),
('PANIN_AFFILIATE', 'Panin Affiliate', 'Panin (affiliate)', 67, true),
('KALBE_CORE', 'Kalbe Core', 'Boenjamin Setiawan Family', 70, true),
('CHAROEN_POKPHAND_CORE', 'Charoen Pokphand Core', 'Dhanin Chearavanont', 71, true),
('CIPUTRA_CORE', 'Ciputra Core', 'Ciputra Family', 72, true),
('SUMMARECON_CORE', 'Summarecon Core', 'Soetjipto Nagaria', 73, true),
('MAYORA_CORE', 'Mayora Core', 'Jogi Hendra Atmadja', 74, true),
('GAJAH_TUNGGAL_CORE', 'Gajah Tunggal Core', 'Sjamsul Nursalim', 75, true),
('PODOMORO_CORE', 'Agung Podomoro Core', 'Trihatma Haliman', 76, true),
('WILMAR_CORE', 'Wilmar Core', 'Martua Sitorus', 77, true),
('SAMPOERNA_STRATEGIC_CORE', 'Sampoerna Strategic Core', 'Sampoerna', 78, true),
('CIMORY_CORE', 'Cimory Core', 'Cimory Group', 79, true),
('CATUR_SENTOSA_CORE', 'Catur Sentosa Core', 'Catur Sentosa', 80, true),
('MEDCO_CORE', 'Medco Core', 'Arifin Panigoro', 81, true),
('AMMAN_MINERAL_CORE', 'Amman Mineral Core', 'Amman Mineral', 82, true),
('AGUNG_SEDAYU_PIK_AFFILIATE', 'Agung Sedayu / PIK Affiliate', 'Agung Sedayu', 83, true),
('MAP_GROUP_CORE', 'MAP Group Core', 'MAP Group', 84, true),
('TANCORP_TANOKO_CORE', 'Tancorp / Tanoko Core', 'Hermanto Tanoko', 85, true)
ON CONFLICT (group_code) DO UPDATE SET
  group_name = EXCLUDED.group_name,
  owner_label = EXCLUDED.owner_label,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  updated_at = now();

-- Step 5: Upsert members — BUMN
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('BUMN_MIND_ID_CORE', 'ANTM', 'Aneka Tambang', 'CORE', true, 1),
('BUMN_MIND_ID_CORE', 'PTBA', 'Bukit Asam', 'CORE', true, 2),
('BUMN_MIND_ID_CORE', 'TINS', 'Timah', 'CORE', true, 3),
('BUMN_MIND_ID_CORE', 'INCO', 'Vale Indonesia', 'CORE', true, 4),
('BUMN_BANK_CORE', 'BBRI', 'Bank BRI', 'CORE', true, 1),
('BUMN_BANK_CORE', 'BMRI', 'Bank Mandiri', 'CORE', true, 2),
('BUMN_BANK_CORE', 'BBNI', 'Bank BNI', 'CORE', true, 3),
('BUMN_BANK_CORE', 'BBTN', 'Bank BTN', 'CORE', true, 4),
('BUMN_BANK_CORE', 'BRIS', 'Bank BSI', 'CORE', true, 5),
('BUMN_BANK_CORE', 'AGRO', 'Bank Raya', 'CORE', true, 6),
('BUMN_TELCO_CORE', 'TLKM', 'Telkom Indonesia', 'CORE', true, 1),
('BUMN_TELCO_CORE', 'MTEL', 'Dayamitra Telekomunikasi', 'CORE', true, 2),
('BUMN_KARYA_INFRA_CORE', 'ADHI', 'Adhi Karya', 'CORE', true, 1),
('BUMN_KARYA_INFRA_CORE', 'WIKA', 'Wijaya Karya', 'CORE', true, 2),
('BUMN_KARYA_INFRA_CORE', 'WSKT', 'Waskita Karya', 'CORE', true, 3),
('BUMN_KARYA_INFRA_CORE', 'WSBP', 'Waskita Beton', 'CORE', true, 4),
('BUMN_KARYA_INFRA_CORE', 'PTPP', 'PP Persero', 'CORE', true, 5),
('BUMN_KARYA_INFRA_CORE', 'PPRO', 'PP Properti', 'CORE', true, 6),
('BUMN_KARYA_INFRA_CORE', 'PPRE', 'PP Presisi', 'CORE', true, 7),
('BUMN_KARYA_INFRA_CORE', 'WTON', 'Wijaya Karya Beton', 'CORE', true, 8),
('BUMN_KARYA_INFRA_CORE', 'WEGE', 'Wijaya Karya Bangunan Gedung', 'CORE', true, 9),
('BUMN_KARYA_INFRA_CORE', 'JSMR', 'Jasa Marga', 'CORE', true, 10),
('BUMN_ENERGI_SEMEN_FARMA_TRANSPORT', 'PGAS', 'Perusahaan Gas Negara', 'CORE', true, 1),
('BUMN_ENERGI_SEMEN_FARMA_TRANSPORT', 'PGEO', 'Pertamina Geothermal', 'CORE', true, 2),
('BUMN_ENERGI_SEMEN_FARMA_TRANSPORT', 'ELSA', 'Elnusa', 'CORE', true, 3),
('BUMN_ENERGI_SEMEN_FARMA_TRANSPORT', 'TUGU', 'Tugu Insurance', 'CORE', true, 4),
('BUMN_ENERGI_SEMEN_FARMA_TRANSPORT', 'SMGR', 'Semen Indonesia', 'CORE', true, 5),
('BUMN_ENERGI_SEMEN_FARMA_TRANSPORT', 'SMBR', 'Semen Baturaja', 'CORE', true, 6),
('BUMN_ENERGI_SEMEN_FARMA_TRANSPORT', 'KAEF', 'Kimia Farma', 'CORE', true, 7),
('BUMN_ENERGI_SEMEN_FARMA_TRANSPORT', 'INAF', 'Indofarma', 'CORE', true, 8),
('BUMN_ENERGI_SEMEN_FARMA_TRANSPORT', 'GIAA', 'Garuda Indonesia', 'CORE', true, 9),
('BUMN_ENERGI_SEMEN_FARMA_TRANSPORT', 'IPCM', 'IPC Pelindo', 'CORE', true, 10),
('TELCO_NON_BUMN', 'ISAT', 'Indosat Ooredoo Hutchison', 'CORE', true, 1),
('TELCO_NON_BUMN', 'EXCL', 'XL Axiata', 'CORE', true, 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET member_type = EXCLUDED.member_type, is_active = true, sort_order = EXCLUDED.sort_order, updated_at = now();

-- Thohir / Adaro / Saratoga
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('THOHIR_ADARO_ALAMTRI_CORE', 'ADRO', 'Alamtri Resources', 'CORE', true, 1),
('THOHIR_ADARO_ALAMTRI_CORE', 'AADI', 'Adaro Andalan', 'CORE', true, 2),
('THOHIR_ADARO_ALAMTRI_CORE', 'ADMR', 'Adaro Minerals', 'CORE', true, 3),
('THOHIR_AFFILIATE_MARKET_LINKED', 'MDKA', 'Merdeka Copper Gold', 'AFFILIATE', true, 1),
('THOHIR_AFFILIATE_MARKET_LINKED', 'EMAS', 'Merdeka Battery', 'AFFILIATE', true, 2),
('THOHIR_AFFILIATE_MARKET_LINKED', 'PALM', 'Provident Agro', 'AFFILIATE', true, 3),
('THOHIR_AFFILIATE_MARKET_LINKED', 'TRIM', 'Trimegah Sekuritas', 'AFFILIATE', true, 4),
('THOHIR_AFFILIATE_MARKET_LINKED', 'ESSA', 'Surya Esa Perkasa', 'AFFILIATE', true, 5),
('THOHIR_AFFILIATE_MARKET_LINKED', 'BFIN', 'BFI Finance', 'AFFILIATE', true, 6),
('THOHIR_AFFILIATE_MARKET_LINKED', 'WOMF', 'Wahana Ottomitra', 'AFFILIATE', true, 7),
('THOHIR_MAHAKA_TRINUGRAHA', 'ABBA', 'Mahaka Media', 'AFFILIATE', true, 1),
('THOHIR_MAHAKA_TRINUGRAHA', 'CARS', 'Bintraco Dharma', 'AFFILIATE', true, 2),
('SARATOGA_PROVIDENT_CORE', 'SRTG', 'Saratoga Investama', 'CORE', true, 1),
('SARATOGA_PROVIDENT_CORE', 'MDKA', 'Merdeka Copper Gold', 'CORE', true, 2),
('SARATOGA_PROVIDENT_CORE', 'TBIG', 'Tower Bersama', 'CORE', true, 3),
('SARATOGA_PROVIDENT_CORE', 'MPMX', 'Mitra Pinasthika', 'CORE', true, 4),
('SARATOGA_PROVIDENT_CORE', 'ADRO', 'Alamtri Resources', 'CORE', true, 5),
('SARATOGA_PROVIDENT_CORE', 'AADI', 'Adaro Andalan', 'CORE', true, 6),
('SARATOGA_PROVIDENT_CORE', 'AGII', 'Samator Indo Gas', 'CORE', true, 7),
('SARATOGA_PROVIDENT_CORE', 'NRCA', 'Nusa Raya Cipta', 'CORE', true, 8),
('SARATOGA_PROVIDENT_AFFILIATE', 'EMAS', 'Merdeka Battery', 'AFFILIATE', true, 1),
('SARATOGA_PROVIDENT_AFFILIATE', 'PALM', 'Provident Agro', 'AFFILIATE', true, 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET member_type = EXCLUDED.member_type, is_active = true, sort_order = EXCLUDED.sort_order, updated_at = now();

-- Salim
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('SALIM_CORE', 'INDF', 'Indofood Sukses Makmur', 'CORE', true, 1),
('SALIM_CORE', 'ICBP', 'Indofood CBP', 'CORE', true, 2),
('SALIM_CORE', 'SIMP', 'Salim Ivomas Pratama', 'CORE', true, 3),
('SALIM_CORE', 'LSIP', 'London Sumatra', 'CORE', true, 4),
('SALIM_CORE', 'IMAS', 'Indomobil Sukses', 'CORE', true, 5),
('SALIM_CORE', 'IMJS', 'Indomobil Multi Jasa', 'CORE', true, 6),
('SALIM_CORE', 'DNET', 'Indoritel Makmur', 'CORE', true, 7),
('SALIM_CORE', 'BINA', 'Bank Ina Perdana', 'CORE', true, 8),
('SALIM_AFFILIATE_INVESTEE', 'DCII', 'DCI Indonesia', 'AFFILIATE', true, 1),
('SALIM_AFFILIATE_INVESTEE', 'ROTI', 'Nippon Indosari', 'AFFILIATE', true, 2),
('SALIM_AFFILIATE_INVESTEE', 'FAST', 'Fast Food Indonesia', 'AFFILIATE', true, 3),
('SALIM_AFFILIATE_INVESTEE', 'AMMN', 'Amman Mineral', 'AFFILIATE', true, 4),
('SALIM_AFFILIATE_INVESTEE', 'MEDC', 'Medco Energi', 'AFFILIATE', true, 5),
('SALIM_AFFILIATE_INVESTEE', 'BUMI', 'Bumi Resources', 'AFFILIATE', true, 6),
('SALIM_AFFILIATE_INVESTEE', 'BRMS', 'Bumi Resources Minerals', 'AFFILIATE', true, 7),
('SALIM_AFFILIATE_INVESTEE', 'PANI', 'Pantai Indah Kapuk Dua', 'AFFILIATE', true, 8)
ON CONFLICT (group_code, ticker) DO UPDATE SET member_type = EXCLUDED.member_type, is_active = true, sort_order = EXCLUDED.sort_order, updated_at = now();

-- Sinarmas
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('SINARMAS_CORE', 'SMMA', 'Sinarmas Multiartha', 'CORE', true, 1),
('SINARMAS_CORE', 'BSIM', 'Bank Sinarmas', 'CORE', true, 2),
('SINARMAS_CORE', 'LIFE', 'Sinarmas MSIG Life', 'CORE', true, 3),
('SINARMAS_CORE', 'DSSA', 'Dian Swastatika', 'CORE', true, 4),
('SINARMAS_CORE', 'GEMS', 'Golden Energy Mines', 'CORE', true, 5),
('SINARMAS_CORE', 'BSDE', 'Bumi Serpong Damai', 'CORE', true, 6),
('SINARMAS_CORE', 'DUTI', 'Duta Pertiwi', 'CORE', true, 7),
('SINARMAS_CORE', 'DMAS', 'Puradelta Lestari', 'CORE', true, 8),
('SINARMAS_CORE', 'SMDM', 'Suryamas Dutamakmur', 'CORE', true, 9),
('SINARMAS_CORE', 'SMAR', 'Smart Tbk', 'CORE', true, 10),
('SINARMAS_CORE', 'INKP', 'Indah Kiat Pulp', 'CORE', true, 11),
('SINARMAS_CORE', 'TKIM', 'Pabrik Kertas Tjiwi', 'CORE', true, 12),
('SINARMAS_HISTORICAL_MERGER', 'FREN', 'Smartfren Telecom', 'RADAR', true, 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET member_type = EXCLUDED.member_type, is_active = true, sort_order = EXCLUDED.sort_order, updated_at = now();

-- Djarum / Hartono
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('DJARUM_HARTONO_CORE', 'BBCA', 'Bank Central Asia', 'CORE', true, 1),
('DJARUM_HARTONO_CORE', 'TOWR', 'Sarana Menara Nusantara', 'CORE', true, 2),
('DJARUM_HARTONO_CORE', 'BELI', 'Blibli', 'CORE', true, 3),
('DJARUM_HARTONO_CORE', 'RANC', 'Supra Boga Lestari', 'CORE', true, 4),
('DJARUM_HARTONO_AFFILIATE', 'SUPR', 'Solusi Tunas Pratama', 'AFFILIATE', true, 1),
('DJARUM_HARTONO_RADAR', 'SSIA', 'Surya Semesta', 'RADAR', true, 1),
('DJARUM_HARTONO_RADAR', 'DATA', 'Remala Abadi', 'RADAR', true, 2),
('DJARUM_HARTONO_RADAR', 'HEAL', 'Medikaloka Hermina', 'RADAR', true, 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET member_type = EXCLUDED.member_type, is_active = true, sort_order = EXCLUDED.sort_order, updated_at = now();

-- Barito / Prajogo
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('BARITO_PRAJOGO_CORE', 'BRPT', 'Barito Pacific', 'CORE', true, 1),
('BARITO_PRAJOGO_CORE', 'BREN', 'Barito Renewables', 'CORE', true, 2),
('BARITO_PRAJOGO_CORE', 'TPIA', 'Chandra Asri Pacific', 'CORE', true, 3),
('BARITO_PRAJOGO_CORE', 'CUAN', 'Petrindo Jaya Kreasi', 'CORE', true, 4),
('BARITO_PRAJOGO_CORE', 'PTRO', 'Petrosea', 'CORE', true, 5),
('BARITO_PRAJOGO_CORE', 'CDIA', 'Chandra Daya Investasi', 'CORE', true, 6),
('BARITO_PRAJOGO_RADAR', 'SSIA', 'Surya Semesta', 'RADAR', true, 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET member_type = EXCLUDED.member_type, is_active = true, sort_order = EXCLUDED.sort_order, updated_at = now();

-- Lippo
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('LIPPO_CORE', 'LPKR', 'Lippo Karawaci', 'CORE', true, 1),
('LIPPO_CORE', 'LPCK', 'Lippo Cikarang', 'CORE', true, 2),
('LIPPO_CORE', 'SILO', 'Siloam Hospitals', 'CORE', true, 3),
('LIPPO_CORE', 'LPPF', 'Matahari Department Store', 'CORE', true, 4),
('LIPPO_CORE', 'MLPL', 'Multipolar', 'CORE', true, 5),
('LIPPO_CORE', 'MLPT', 'Multipolar Technology', 'CORE', true, 6),
('LIPPO_CORE', 'MPPA', 'Matahari Putra Prima', 'CORE', true, 7),
('LIPPO_CORE', 'LPGI', 'Lippo General Insurance', 'CORE', true, 8),
('LIPPO_CORE', 'LPIN', 'Multi Prima Sejahtera', 'CORE', true, 9),
('LIPPO_CORE', 'LPPS', 'Lippo Securities', 'CORE', true, 10),
('LIPPO_CORE', 'LPLI', 'Star Pacific', 'CORE', true, 11),
('LIPPO_CORE', 'NOBU', 'Bank Nationalnobu', 'CORE', true, 12),
('LIPPO_CORE', 'GMTD', 'Gowa Makassar Tourism', 'CORE', true, 13)
ON CONFLICT (group_code, ticker) DO UPDATE SET member_type = EXCLUDED.member_type, is_active = true, sort_order = EXCLUDED.sort_order, updated_at = now();

-- Emtek / MD / MNC
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('EMTEK_CORE', 'EMTK', 'Elang Mahkota Teknologi', 'CORE', true, 1),
('EMTEK_CORE', 'SCMA', 'Surya Citra Media', 'CORE', true, 2),
('EMTEK_CORE', 'BUKA', 'Bukalapak', 'CORE', true, 3),
('EMTEK_CORE', 'AMOR', 'Ashmore Asset Management', 'CORE', true, 4),
('EMTEK_CORE', 'BBHI', 'Bank Harda Internasional', 'CORE', true, 5),
('EMTEK_CORE', 'SAME', 'Sarana Meditama', 'CORE', true, 6),
('EMTEK_CORE', 'RSGK', 'Sejahtera Anugerah Medika', 'CORE', true, 7),
('MD_ENTERTAINMENT_CORE', 'FILM', 'MD Pictures', 'CORE', true, 1),
('MD_ENTERTAINMENT_CORE', 'NETV', 'Net Visi Media', 'CORE', true, 2),
('MNC_HARY_TANOE_CORE', 'BHIT', 'MNC Asia Holding', 'CORE', true, 1),
('MNC_HARY_TANOE_CORE', 'BMTR', 'Global Mediacom', 'CORE', true, 2),
('MNC_HARY_TANOE_CORE', 'MNCN', 'MNC Digital Entertainment', 'CORE', true, 3),
('MNC_HARY_TANOE_CORE', 'MSIN', 'MNC Studios', 'CORE', true, 4),
('MNC_HARY_TANOE_CORE', 'IPTV', 'MNC Vision Networks', 'CORE', true, 5),
('MNC_HARY_TANOE_CORE', 'MSKY', 'MNC Sky Vision', 'CORE', true, 6),
('MNC_HARY_TANOE_CORE', 'KPIG', 'MNC Land', 'CORE', true, 7),
('MNC_HARY_TANOE_CORE', 'BCAP', 'MNC Kapital', 'CORE', true, 8),
('MNC_HARY_TANOE_CORE', 'BABP', 'Bank MNC Internasional', 'CORE', true, 9),
('MNC_HARY_TANOE_CORE', 'IATA', 'MNC Energy', 'CORE', true, 10)
ON CONFLICT (group_code, ticker) DO UPDATE SET member_type = EXCLUDED.member_type, is_active = true, sort_order = EXCLUDED.sort_order, updated_at = now();

-- Bakrie
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('BAKRIE_CORE', 'BNBR', 'Bakrie & Brothers', 'CORE', true, 1),
('BAKRIE_CORE', 'BUMI', 'Bumi Resources', 'CORE', true, 2),
('BAKRIE_CORE', 'BRMS', 'Bumi Resources Minerals', 'CORE', true, 3),
('BAKRIE_CORE', 'ENRG', 'Energi Mega Persada', 'CORE', true, 4),
('BAKRIE_CORE', 'DEWA', 'Darma Henwa', 'CORE', true, 5),
('BAKRIE_CORE', 'ELTY', 'Bakrieland Development', 'CORE', true, 6),
('BAKRIE_CORE', 'UNSP', 'Bakrie Sumatra Plantations', 'CORE', true, 7),
('BAKRIE_CORE', 'VIVA', 'Viva Media Baru', 'CORE', true, 8),
('BAKRIE_CORE', 'MDIA', 'Intermedia Capital', 'CORE', true, 9),
('BAKRIE_CORE', 'BTEL', 'Bakrie Telecom', 'CORE', true, 10),
('BAKRIE_CORE', 'VKTR', 'Bakrie & Brothers (new)', 'CORE', true, 11),
('BAKRIE_AFFILIATE_RADAR', 'ALII', 'Ancara Logistics', 'RADAR', true, 1),
('BAKRIE_AFFILIATE_RADAR', 'JGLE', 'Jungle Land', 'RADAR', true, 2)
ON CONFLICT (group_code, ticker) DO UPDATE SET member_type = EXCLUDED.member_type, is_active = true, sort_order = EXCLUDED.sort_order, updated_at = now();

-- Astra / Triputra / Toba
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('ASTRA_JARDINE_CORE', 'ASII', 'Astra International', 'CORE', true, 1),
('ASTRA_JARDINE_CORE', 'UNTR', 'United Tractors', 'CORE', true, 2),
('ASTRA_JARDINE_CORE', 'AALI', 'Astra Agro Lestari', 'CORE', true, 3),
('ASTRA_JARDINE_CORE', 'AUTO', 'Astra Otoparts', 'CORE', true, 4),
('ASTRA_JARDINE_CORE', 'ASGR', 'Astra Graphia', 'CORE', true, 5),
('ASTRA_JARDINE_CORE', 'ACST', 'Acset Indonusa', 'CORE', true, 6),
('ASTRA_EX', 'BNLI', 'Bank Permata', 'RADAR', true, 1),
('TRIPUTRA_TP_RACHMAT_CORE', 'TAPG', 'Triputra Agro Persada', 'CORE', true, 1),
('TRIPUTRA_TP_RACHMAT_CORE', 'DSNG', 'Dharma Satya Nusantara', 'CORE', true, 2),
('TRIPUTRA_TP_RACHMAT_CORE', 'ASSA', 'Adi Sarana Armada', 'CORE', true, 3),
('TRIPUTRA_TP_RACHMAT_CORE', 'DRMA', 'Dharma Polimetal', 'CORE', true, 4),
('TRIPUTRA_TP_RACHMAT_CORE', 'ASLC', 'Autopedia Sukses Lestari', 'CORE', true, 5),
('TRIPUTRA_TP_RACHMAT_CORE', 'KMTR', 'Kirana Megatara', 'CORE', true, 6),
('TBS_TOBA_CORE', 'TOBA', 'TBS Energi Utama', 'CORE', true, 1)
ON CONFLICT (group_code, ticker) DO UPDATE SET member_type = EXCLUDED.member_type, is_active = true, sort_order = EXCLUDED.sort_order, updated_at = now();

-- Other groups
INSERT INTO sector_hot_group_members (group_code, ticker, stock_name, member_type, is_active, sort_order) VALUES
('MAYAPADA_CORE', 'MAYA', 'Bank Mayapada', 'CORE', true, 1),
('MAYAPADA_CORE', 'SRAJ', 'Sejahteraraya Anugerahjaya', 'CORE', true, 2),
('MAYAPADA_CORE', 'SONA', 'Sona Topas Tourism', 'CORE', true, 3),
('MAYAPADA_CORE', 'MPRO', 'Maha Properti', 'CORE', true, 4),
('PANIN_CORE', 'PNBN', 'Bank Pan Indonesia', 'CORE', true, 1),
('PANIN_CORE', 'PNLF', 'Panin Financial', 'CORE', true, 2),
('PANIN_CORE', 'PNIN', 'Panin Insurance', 'CORE', true, 3),
('PANIN_CORE', 'PNBS', 'Bank Panin Dubai Syariah', 'CORE', true, 4),
('PANIN_AFFILIATE', 'AMAG', 'Asuransi Multi Artha Guna', 'AFFILIATE', true, 1),
('KALBE_CORE', 'KLBF', 'Kalbe Farma', 'CORE', true, 1),
('KALBE_CORE', 'EPMT', 'Enseval Putera Megatrading', 'CORE', true, 2),
('CHAROEN_POKPHAND_CORE', 'CPIN', 'Charoen Pokphand Indonesia', 'CORE', true, 1),
('CIPUTRA_CORE', 'CTRA', 'Ciputra Development', 'CORE', true, 1),
('SUMMARECON_CORE', 'SMRA', 'Summarecon Agung', 'CORE', true, 1),
('MAYORA_CORE', 'MYOR', 'Mayora Indah', 'CORE', true, 1),
('GAJAH_TUNGGAL_CORE', 'GJTL', 'Gajah Tunggal', 'CORE', true, 1),
('PODOMORO_CORE', 'APLN', 'Agung Podomoro Land', 'CORE', true, 1),
('WILMAR_CORE', 'CEKA', 'Wilmar Cahaya Indonesia', 'CORE', true, 1),
('SAMPOERNA_STRATEGIC_CORE', 'SGRO', 'Sampoerna Agro', 'CORE', true, 1),
('CIMORY_CORE', 'CMRY', 'Cisarua Mountain Dairy', 'CORE', true, 1),
('CATUR_SENTOSA_CORE', 'CSAP', 'Catur Sentosa Adiprana', 'CORE', true, 1),
('MEDCO_CORE', 'MEDC', 'Medco Energi Internasional', 'CORE', true, 1),
('AMMAN_MINERAL_CORE', 'AMMN', 'Amman Mineral Internasional', 'CORE', true, 1),
('AGUNG_SEDAYU_PIK_AFFILIATE', 'PANI', 'Pantai Indah Kapuk Dua', 'AFFILIATE', true, 1),
('MAP_GROUP_CORE', 'MAPI', 'Mitra Adiperkasa', 'CORE', true, 1),
('MAP_GROUP_CORE', 'MAPA', 'MAP Aktif Adiperkasa', 'CORE', true, 2),
('MAP_GROUP_CORE', 'MAPB', 'MAP Boga Adiperkasa', 'CORE', true, 3),
('TANCORP_TANOKO_CORE', 'CLEO', 'Sariguna Primatirta', 'CORE', true, 1),
('TANCORP_TANOKO_CORE', 'AVIA', 'Avia Avian', 'CORE', true, 2),
('TANCORP_TANOKO_CORE', 'DEPO', 'Depo Bangunan', 'CORE', true, 3)
ON CONFLICT (group_code, ticker) DO UPDATE SET member_type = EXCLUDED.member_type, is_active = true, sort_order = EXCLUDED.sort_order, updated_at = now();

-- =============================================
-- Verification queries (run after patch):
--
-- 1. Check BARITO_PRAJOGO_CORE includes CUAN:
-- SELECT * FROM sector_hot_group_members WHERE group_code = 'BARITO_PRAJOGO_CORE' AND is_active = true;
--
-- 2. Check SINARMAS_CORE includes DMAS:
-- SELECT * FROM sector_hot_group_members WHERE group_code = 'SINARMAS_CORE' AND is_active = true;
--
-- 3. Check SALIM_CORE includes DNET, IMJS, BINA:
-- SELECT * FROM sector_hot_group_members WHERE group_code = 'SALIM_CORE' AND is_active = true;
--
-- 4. Check duplicates:
-- SELECT ticker, COUNT(*) AS cnt, STRING_AGG(group_code, ', ') AS groups
-- FROM sector_hot_group_members WHERE is_active = true
-- GROUP BY ticker HAVING COUNT(*) > 1 ORDER BY cnt DESC;
--
-- 5. Group summary:
-- SELECT g.group_code, g.group_name, COUNT(m.ticker) as members
-- FROM sector_hot_groups g
-- LEFT JOIN sector_hot_group_members m ON g.group_code = m.group_code AND m.is_active = true
-- WHERE g.is_active = true GROUP BY g.group_code, g.group_name ORDER BY g.sort_order;
-- =============================================
