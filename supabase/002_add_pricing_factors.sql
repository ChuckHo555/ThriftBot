-- ============================================================================
-- ThriftBot — Migration 002: Add pricing_factors column
-- ============================================================================
-- Run this in the Supabase SQL Editor AFTER 001_initial_schema.sql.
--
-- WHAT THIS DOES
-- Adds a dedicated `pricing_factors` JSONB column to the appraisals table
-- to store the AI's reasoning behind each price estimate.
--
-- WHY A NEW COLUMN INSTEAD OF READING FROM ai_response?
-- The full AI response is already stored in `ai_response JSONB`, so the data
-- is technically already there. But we add a dedicated column to:
--   1. Make it queryable on its own (faster than JSONB path queries at scale)
--   2. Follow the same denormalization pattern as identified_brand, price_low,
--      price_high, confidence, etc.
--   3. Make the schema self-documenting — anyone looking at the table sees
--      "this column matters" without having to dig into JSONB.
--
-- SHAPE OF THE DATA
-- An array of objects, e.g.:
--   [
--     {"factor": "Deadstock with original box", "impact": "+$25"},
--     {"factor": "2003 OG colorway", "impact": "+$15"},
--     {"factor": "Slight box corner damage", "impact": "-$5"}
--   ]
--
-- NULLABILITY
-- Nullable on purpose. Old rows (from before this migration) won't have
-- pricing_factors. New rows will. Making it NOT NULL would require a
-- backfill, which isn't worth it for a portfolio project.
-- ============================================================================


-- ==========================================================================
-- ADD COLUMN
-- ==========================================================================
-- `ADD COLUMN IF NOT EXISTS` makes this migration safe to re-run.
-- (Postgres 9.6+, which Supabase always is.)
-- ==========================================================================

ALTER TABLE appraisals
    ADD COLUMN IF NOT EXISTS pricing_factors JSONB;


-- ==========================================================================
-- COLUMN COMMENT (self-documenting schema)
-- ==========================================================================
-- COMMENT ON COLUMN attaches a description to the column itself. It shows
-- up in Supabase's table view and in pg_dump output. Future-you (or your
-- friend) will thank you.
-- ==========================================================================

COMMENT ON COLUMN appraisals.pricing_factors IS
    'Array of {factor, impact} objects explaining the AI''s price estimate. '
    'Mirrors ai_response.pricing_factors. Nullable for rows created before '
    'this column existed.';


-- ==========================================================================
-- NO INDEX FOR NOW
-- ==========================================================================
-- We're not indexing this column yet because:
--   1. The MVP doesn't have any query patterns that filter on it
--   2. JSONB indexes (GIN) are heavier than B-tree indexes
--   3. Premature optimization
--
-- When you later want to query "find appraisals where any factor mentions
-- 'deadstock'", you'd add a GIN index like:
--
--   CREATE INDEX idx_appraisals_pricing_factors
--       ON appraisals USING GIN (pricing_factors);
--
-- And query it with the @> containment operator.
-- ==========================================================================
