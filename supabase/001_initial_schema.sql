-- ============================================================================
-- ThriftBot — Supabase Database Schema
-- ============================================================================
-- Run this in the Supabase SQL Editor (supabase.com → your project → SQL Editor)
--
-- SCHEMA DESIGN DECISIONS:
--
-- 1. SINGLE TABLE FOR MVP
--    We could normalize into items, appraisals, images, etc. but for a portfolio
--    project, one table is easier to query, debug, and explain in interviews.
--    Denormalization is fine at this scale.
--
-- 2. JSONB FOR AI RESPONSE
--    We store the entire AI response as a JSONB column. This is intentional:
--    - The AI response schema might change as you tune the prompt
--    - JSONB is queryable in Postgres (you can index into nested fields)
--    - Avoids a painful migration every time you tweak the output format
--    - You can still extract specific fields in queries when needed
--
-- 3. SEPARATE COLUMNS FOR KEY FIELDS
--    Even though the full response is in JSONB, we extract brand, category,
--    price_low, price_high into their own columns. Why? Because these are
--    the fields you'll filter, sort, and aggregate on. Indexing a top-level
--    column is way faster than indexing into JSONB for hot queries.
--
-- 4. NO USER TABLE YET
--    We skip auth/users for MVP. When your friend adds Supabase Auth later,
--    they add a user_id column and a foreign key to auth.users. The schema
--    is designed to make that addition non-breaking.
--
-- 5. IMAGE URL, NOT IMAGE BLOB
--    We store the Supabase Storage URL, not the actual image bytes.
--    The image lives in a Storage bucket. This keeps the DB lean and
--    lets us serve images via CDN.
-- ============================================================================


-- ==========================================================================
-- TABLE: appraisals
-- ==========================================================================
-- Each row = one estimation request. This is the core table.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS appraisals (
    -- Primary key: UUID instead of serial integer.
    -- Why UUID? It's safe to expose in URLs (/history/abc-123) without
    -- leaking info about how many appraisals exist (sequential IDs do).
    -- Supabase has gen_random_uuid() built in.
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

    -- Timestamps: created_at is auto-set, updated_at is useful if you
    -- ever let users edit/re-appraise items.
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

    -- ======================================================================
    -- USER-PROVIDED METADATA
    -- These are the fields the user fills in on the form.
    -- ======================================================================

    -- Category from the dropdown (e.g., "Sneakers", "Streetwear")
    category TEXT NOT NULL,

    -- Condition from the dropdown (e.g., "Like New", "Good")
    condition TEXT NOT NULL,

    -- Optional fields — nullable because the user might skip them.
    -- TEXT is fine here; no need for VARCHAR(n) in Postgres.
    brand TEXT,
    size TEXT,
    notes TEXT,

    -- ======================================================================
    -- IMAGE
    -- URL pointing to the image in Supabase Storage.
    -- Example: https://xyz.supabase.co/storage/v1/object/public/item-images/abc.jpg
    -- ======================================================================
    image_url TEXT,

    -- Original filename and MIME type — useful for debugging and for
    -- displaying "photo.jpg" in the UI instead of a UUID filename.
    original_filename TEXT,
    image_media_type TEXT,

    -- ======================================================================
    -- AI RESPONSE (the good stuff)
    -- ======================================================================

    -- The complete JSON response from Claude, stored as JSONB.
    -- This is the source of truth. The columns below are denormalized
    -- extracts for fast querying.
    ai_response JSONB,

    -- Denormalized fields extracted from ai_response for indexing/filtering:

    -- What the AI identified the item as
    identified_brand TEXT,        -- ai_response.identified_item.brand
    identified_model TEXT,        -- ai_response.identified_item.model

    -- Price range (numbers for sorting/aggregation)
    price_low NUMERIC(10, 2),     -- ai_response.price_estimate.low
    price_high NUMERIC(10, 2),    -- ai_response.price_estimate.high

    -- Confidence level for filtering ("low", "medium", "high")
    confidence TEXT,

    -- Best platform recommendation
    best_platform TEXT,

    -- ======================================================================
    -- FUTURE: USER ASSOCIATION
    -- When you add Supabase Auth, uncomment this line and add the FK.
    -- user_id UUID REFERENCES auth.users(id),
    -- ======================================================================

    -- Status: lets you track if the estimation completed successfully
    -- Possible values: 'pending', 'completed', 'failed'
    status TEXT DEFAULT 'completed' NOT NULL
);


-- ==========================================================================
-- INDEXES
-- ==========================================================================
-- We create indexes on columns we'll frequently filter or sort by.
-- Don't over-index at this stage — add more as query patterns emerge.
-- ==========================================================================

-- Most common query: "show me my recent appraisals"
CREATE INDEX IF NOT EXISTS idx_appraisals_created_at
    ON appraisals (created_at DESC);

-- Filter by category (e.g., "show me all sneaker appraisals")
CREATE INDEX IF NOT EXISTS idx_appraisals_category
    ON appraisals (category);

-- Filter by identified brand (e.g., "show me all Nike items")
CREATE INDEX IF NOT EXISTS idx_appraisals_identified_brand
    ON appraisals (identified_brand);

-- Sort by price for "most valuable items" queries
CREATE INDEX IF NOT EXISTS idx_appraisals_price_high
    ON appraisals (price_high DESC);

-- Filter by confidence (e.g., "show me only high-confidence estimates")
CREATE INDEX IF NOT EXISTS idx_appraisals_confidence
    ON appraisals (confidence);


-- ==========================================================================
-- AUTO-UPDATE updated_at TRIGGER
-- ==========================================================================
-- Standard pattern: automatically set updated_at whenever a row changes.
-- ==========================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON appraisals
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- ==========================================================================
-- ROW-LEVEL SECURITY (RLS) — DISABLED FOR NOW
-- ==========================================================================
-- When you add Supabase Auth, enable RLS so users can only see their own
-- appraisals. The policy would look like:
--
-- ALTER TABLE appraisals ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY "Users can view their own appraisals"
--   ON appraisals FOR SELECT
--   USING (auth.uid() = user_id);
--
-- CREATE POLICY "Users can insert their own appraisals"
--   ON appraisals FOR INSERT
--   WITH CHECK (auth.uid() = user_id);
--
-- For now, we access everything through the backend with the service key,
-- so RLS isn't needed yet.
-- ==========================================================================


-- ==========================================================================
-- STORAGE BUCKET SETUP (do this in the Supabase dashboard, not SQL)
-- ==========================================================================
-- 1. Go to Storage in your Supabase dashboard
-- 2. Create a new bucket called "item-images"
-- 3. Set it to PUBLIC (so image URLs work without auth tokens)
-- 4. Optionally set a file size limit (5MB matches our frontend validation)
--
-- The bucket stores uploaded photos. Our backend uploads to this bucket
-- and saves the resulting public URL in the appraisals.image_url column.
-- ==========================================================================
