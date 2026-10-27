-- Migration: 20261024_admin_notes.sql
-- Description: Create append-only admin_notes and admin_note_edits tables for Catatan Admin feature

CREATE TABLE IF NOT EXISTS admin_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker VARCHAR(10) NOT NULL,
    style VARCHAR(20) NOT NULL CHECK (style IN ('daytrade', 'swing')),
    reason TEXT NOT NULL,
    zone_lo NUMERIC NOT NULL,
    zone_hi NUMERIC NOT NULL,
    target NUMERIC NOT NULL,
    risk_limit NUMERIC NOT NULL,
    valid_days INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'Menunggu harga turun ke area',
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    entered_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    close_price NUMERIC,
    close_reason TEXT,
    result_pct NUMERIC,
    author_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only audit log for edits
CREATE TABLE IF NOT EXISTS admin_note_edits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    note_id UUID NOT NULL REFERENCES admin_notes(id) ON DELETE CASCADE,
    edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    editor_id TEXT NOT NULL,
    diff JSONB NOT NULL DEFAULT '{}'::jsonb,
    edit_reason TEXT NOT NULL
);

-- Indexes for querying
CREATE INDEX IF NOT EXISTS idx_admin_notes_status ON admin_notes(status);
CREATE INDEX IF NOT EXISTS idx_admin_notes_ticker ON admin_notes(ticker);
CREATE INDEX IF NOT EXISTS idx_admin_notes_style ON admin_notes(style);
CREATE INDEX IF NOT EXISTS idx_admin_notes_published_at ON admin_notes(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_note_edits_note_id ON admin_note_edits(note_id);
