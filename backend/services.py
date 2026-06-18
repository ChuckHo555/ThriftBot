"""
============================================================================
services.py — Business Logic Layer
============================================================================
This is where the actual work happens. The routes in main.py are thin
wrappers that call these service functions.

WHY A SEPARATE SERVICES LAYER?
1. Testability — you can unit test estimate_item() without spinning up
   a FastAPI server or making real API calls (mock the clients).
2. Reusability — if you add a CLI or batch processing later, the same
   service functions work without duplicating logic.
3. Separation of concerns — routes handle HTTP (parsing requests,
   returning responses). Services handle business logic (calling APIs,
   transforming data, storing results).
============================================================================
"""

import anthropic
import base64
import io
import json
import uuid
from datetime import datetime
from typing import Optional

from PIL import Image
from pillow_heif import register_heif_opener  # teaches Pillow to read HEIC/HEIF
register_heif_opener()                        # must call before any Image.open()
from supabase import create_client, Client as SupabaseClient

from config import get_settings
from models import AIAppraisalResponse, EstimateRequest


# ==========================================================================
# CLIENT INITIALIZATION
# ==========================================================================
# We create clients at module level so they're reused across requests.
# Creating a new HTTP client per request wastes connection setup time.
#
# In a larger app, you'd use FastAPI's dependency injection to manage
# client lifecycle. For this scale, module-level singletons are fine.
# ==========================================================================

settings = get_settings()

# Anthropic client — handles auth, retries, and rate limiting internally.
anthropic_client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

# Supabase client — wraps the Supabase REST API and Storage API.
supabase: SupabaseClient = create_client(
    settings.SUPABASE_URL,
    settings.SUPABASE_KEY,
)


# ==========================================================================
# SYSTEM PROMPT
# ==========================================================================
# Same prompt from the original starter, now living server-side where it
# belongs. The frontend never sees this — it's an implementation detail.
#
# TUNING GUIDE FOR YOUR FRIEND:
# - Add few-shot examples if a specific category is underperforming
# - Adjust the JSON schema if you add new fields (e.g., "rarity_score")
# - Add brand-specific instructions if certain brands are misidentified
# - The "CRITICAL RULES" section prevents common failure modes
# ==========================================================================

SYSTEM_PROMPT = """You are ThriftBot, an expert AI appraiser for secondhand clothing and sneakers. You have deep knowledge of resale markets including eBay, Poshmark, Mercari, Depop, StockX, GOAT, and Grailed.

Given an image of an item and its metadata, you must:
1. Identify the item (brand, model/style, colorway if applicable, approximate era/year)
2. Assess visible condition from the photo
3. Estimate a realistic resale price RANGE based on current market conditions

CRITICAL RULES:
- Always give a RANGE (low-high), never a single price
- Base prices on RESALE market value, not retail MSRP
- Factor in: brand desirability, condition, rarity, current trends, seasonality
- If you can't identify the exact item, say so and give a range for similar items
- Be honest about confidence — don't fake certainty
- Explain your price with 3-5 pricing_factors — concrete observations (condition details, rarity, demand, trends) and their dollar impact. Be specific, not generic ("Box has corner damage" not "minor wear").
- If the image does not show clothing, sneakers, or a wearable fashion item, set is_applicable to false and fill in rejection_reason. Leave all other fields null.
- For any brand known for counterfeits (Nike, Supreme, Off-White, Yeezy, Stone Island, etc.), assess visible authenticity markers (stitching consistency, tag font/placement, logo proportions, hardware quality). Be specific about what you see. Never claim certainty — you are doing a visual check only, not a physical inspection.

Respond ONLY with valid JSON (no markdown, no backticks, no preamble) matching this exact schema:
{
  "is_applicable": true,
  "rejection_reason": "null if applicable, otherwise a short human-friendly explanation e.g. 'This looks like a landscape photo, not a clothing item.'",
  "identified_item": {
    "brand": "string",
    "model": "string or null if unknown",
    "colorway": "string or null",
    "estimated_era": "string, e.g. '2019-2021'",
    "category": "string"
  },
  "condition_assessment": "string — 1-2 sentence assessment based on what's visible in the photo",
  "platform_prices": {
    "ebay":   { "low": number, "high": number },
    "grailed": { "low": number, "high": number },
    "depop":  { "low": number, "high": number }
  },
  "best_platform": "ebay | grailed | depop — which platform would get the highest net price for this specific item",
  "pricing_factors": [
    {
      "factor": "string — specific observation about the item",
      "impact": "string — '+$X', '-$X', or 'neutral'"
    }
  ],
  "confidence": "low | medium | high",
  "confidence_reasoning": "string — brief explanation of why confidence is at this level",
  "comparables": [
    "string — similar item that recently sold and approximate price, 2-3 items"
  ],
  "tips": "string — one actionable tip to maximize resale value",
  "authenticity_check": {
    "verdict": "no_red_flags | minor_concerns | potential_issues | not_applicable",
    "observations": ["string — specific visual detail checked, e.g. 'Swoosh stitching appears consistent with authentic examples'"],
    "disclaimer": "Visual check only — not a guarantee of authenticity."
  }
}"""


# ==========================================================================
# IMAGE PREPROCESSING
# ==========================================================================
# Resize + recompress images before they hit Claude or Supabase Storage.
# Big phone photos (4-8MB) become ~250KB without quality loss the AI notices.
# Benefits: lower API cost, faster uploads, less storage, consistent format.
# ==========================================================================


def preprocess_image(
    image_base64: str,
    media_type: str,
    max_dimension: int = 1568,
    jpeg_quality: int = 85,
) -> tuple[str, str]:
    """
    Resize + re-encode an image to optimize for Claude vision and storage.

    WHY 1568px?
    Anthropic's vision endpoint downsizes images larger than ~1568px on the
    longest side anyway. Sending bigger images wastes bandwidth — the AI
    "sees" the same thing either way.

    WHY JPEG QUALITY 85?
    Industry-standard sweet spot. Quality 95+ is visually indistinguishable
    from 85 for most photos but 2-3x larger. Quality 75 starts showing
    visible artifacts. 85 = best size/quality tradeoff.

    WHY ALWAYS RE-ENCODE TO JPEG?
    - Strips bloated EXIF metadata (some phone photos carry 50KB+ of EXIF)
    - PNGs of photos are 5-10x larger than the equivalent JPEG
    - Consistent output format simplifies downstream code

    NOTE ON SYNC vs ASYNC:
    Pillow is CPU-bound and has no async API. In a high-traffic production
    app you'd wrap this in `asyncio.to_thread(...)` so it doesn't block the
    event loop. For dev-scale traffic, running sync from async is fine.

    Returns: (new_base64, "image/jpeg") on success, or (original_b64, original_type)
    on failure — never crashes the pipeline.
    """
    try:
        # Decode base64 to raw image bytes
        original_bytes = base64.b64decode(image_base64)

        # Load into Pillow. BytesIO wraps bytes in a file-like object since
        # Image.open() expects something it can .read() from.
        img = Image.open(io.BytesIO(original_bytes))

        # Convert anything non-RGB to RGB. JPEG doesn't support transparency,
        # so a transparent PNG would crash on save() without this. We composite
        # transparent areas onto a white background instead of leaving them black.
        if img.mode != "RGB":
            if img.mode in ("RGBA", "LA"):
                background = Image.new("RGB", img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[-1])  # alpha channel as mask
                img = background
            else:
                img = img.convert("RGB")

        # Resize so the longest side is at most max_dimension, preserving
        # aspect ratio. thumbnail() never upscales, so small images stay small.
        # LANCZOS is the highest-quality resampling filter Pillow ships with.
        img.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)

        # Re-encode to JPEG bytes in memory (BytesIO acts as a writable file).
        # optimize=True spends extra CPU finding the smallest encoding — cheap
        # because we run this once per request, not in a hot loop.
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=jpeg_quality, optimize=True)
        new_bytes = buffer.getvalue()

        # Encode back to base64 for downstream code that expects strings.
        new_base64 = base64.b64encode(new_bytes).decode("ascii")

        # Log compression ratio for observability — useful during dev to
        # confirm preprocessing is actually working on the photos you upload.
        ratio = len(new_bytes) / len(original_bytes) * 100
        print(
            f"[PREPROCESS] {len(original_bytes):,}B -> {len(new_bytes):,}B "
            f"({ratio:.0f}% of original, {img.size[0]}x{img.size[1]})"
        )

        return new_base64, "image/jpeg"

    except Exception as e:
        # Don't crash the request if preprocessing fails — fall back to the
        # original bytes and let the rest of the pipeline continue.
        print(f"[WARN] Image preprocessing failed, using original: {e}")
        return image_base64, media_type


# ==========================================================================
# IMAGE UPLOAD SERVICE
# ==========================================================================

async def upload_image_to_storage(
    image_base64: str,
    media_type: str,
    original_filename: Optional[str] = None,
) -> Optional[str]:
    """
    Uploads a base64-encoded image to Supabase Storage and returns the
    public URL.

    WHY STORE IMAGES?
    1. The base64 string is large (~1-3MB). Storing it in the DB would bloat
       every row and slow down list queries.
    2. A URL is small (~100 bytes) and can be served via CDN.
    3. The user can see their original photo in the history view.
    4. You could add image comparison features later (e.g., "similar items").

    NAMING STRATEGY:
    We use UUID filenames to avoid collisions and keep URLs unpredictable.
    The original filename is stored in the DB for display purposes.
    """
    try:
        # Decode base64 to raw bytes
        image_bytes = base64.b64decode(image_base64)

        # Generate a unique filename using UUID
        # We preserve the extension from the media type for compatibility
        ext_map = {
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
            "image/gif": "gif",
        }
        ext = ext_map.get(media_type, "jpg")
        filename = f"{uuid.uuid4()}.{ext}"

        # Upload to Supabase Storage
        # The bucket must exist and be set to public in the dashboard.
        supabase.storage.from_(settings.SUPABASE_BUCKET).upload(
            path=filename,
            file=image_bytes,
            file_options={"content-type": media_type},
        )

        # Construct the public URL
        # Format: {SUPABASE_URL}/storage/v1/object/public/{bucket}/{filename}
        public_url = (
            f"{settings.SUPABASE_URL}/storage/v1/object/public/"
            f"{settings.SUPABASE_BUCKET}/{filename}"
        )

        return public_url

    except Exception as e:
        # Log the error but don't fail the request — the estimation can
        # still succeed even if image storage fails. The image_url will
        # just be null in the DB.
        print(f"[WARN] Image upload failed: {e}")
        return None


# ==========================================================================
# AI ESTIMATION SERVICE
# ==========================================================================

async def call_anthropic_vision(
    image_base64: str,
    media_type: str,
    metadata: dict,
) -> AIAppraisalResponse:
    """
    Sends the image + metadata to Claude and parses the structured response.

    ERROR HANDLING STRATEGY:
    - If the API call fails (network, rate limit, etc.), we raise and let
      the route handler return a 502.
    - If the response isn't valid JSON, we raise and return a 502.
    - If the JSON doesn't match our schema, Pydantic validation catches it.

    COST NOTE:
    Each call with a typical phone photo (~500KB–2MB) costs roughly:
    - Image input tokens: ~1,500 tokens (~$0.005 with Sonnet)
    - Text input (system + user prompt): ~500 tokens (~$0.002)
    - Output: ~300 tokens (~$0.005)
    - Total: ~$0.01 per estimation
    At the free tier rate limit, this is very affordable for development.
    """

    # Build the user message with all available metadata
    user_parts = [
        f"Please identify and appraise this item for resale.",
        f"Category: {metadata.get('category', 'Unknown')}",
        f"Condition: {metadata.get('condition', 'Unknown')}",
    ]
    if metadata.get("brand"):
        user_parts.append(f"Brand (user-provided): {metadata['brand']}")
    if metadata.get("size"):
        user_parts.append(f"Size: {metadata['size']}")
    if metadata.get("notes"):
        user_parts.append(f"Additional notes: {metadata['notes']}")

    user_message = "\n".join(user_parts)

    # Call the Anthropic API
    # The image goes first in the content array — this is a best practice
    # for vision tasks as it primes the model to analyze the image before
    # reading the text context.
    message = anthropic_client.messages.create(
        model=settings.ANTHROPIC_MODEL,
        max_tokens=settings.ANTHROPIC_MAX_TOKENS,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_base64,
                        },
                    },
                    {
                        "type": "text",
                        "text": user_message,
                    },
                ],
            },
        ],
    )

    # Extract text from response content blocks
    raw_text = "".join(
        block.text for block in message.content if block.type == "text"
    )

    # Parse JSON — strip markdown fences just in case
    cleaned = raw_text.replace("```json", "").replace("```", "").strip()

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        # Claude occasionally produces malformed JSON on complex prompts.
        # One retry is usually enough — the second call almost always succeeds.
        print("[WARN] JSON parse failed on first attempt, retrying...")
        retry = anthropic_client.messages.create(
            model=settings.ANTHROPIC_MODEL,
            max_tokens=settings.MAX_TOKENS,
            system=SYSTEM_PROMPT,
            messages=[
                {
                    "role": "user",
                    "content": message.content[0].text if message.content else user_message,
                },
                {
                    "role": "assistant",
                    "content": "I need to return valid JSON. Here it is:\n{",
                },
            ],
        )
        retry_text = "".join(b.text for b in retry.content if b.type == "text")
        cleaned = ("{" + retry_text).replace("```json", "").replace("```", "").strip()
        parsed = json.loads(cleaned)

    # Validate against our Pydantic model
    return AIAppraisalResponse(**parsed)


# ==========================================================================
# LISTING DRAFT SERVICE
# ==========================================================================
# Generates a platform-specific title + description on demand.
# Called separately from the main appraisal so users only pay the token
# cost when they actually want a listing draft.
# ==========================================================================

LISTING_PROMPTS = {
    "ebay": {
        "tone": "professional and keyword-rich, optimized for eBay search",
        "title_rules": "max 80 characters, format: Brand + Model + Size + Condition + key detail",
        "description_rules": "3-5 sentences covering condition details, notable features, measurements if known, and a placeholder for shipping/returns policy",
    },
    "grailed": {
        "tone": "knowledgeable streetwear/menswear tone",
        "title_rules": "max 60 characters, format: Brand + Model + Colorway + Size",
        "description_rules": "2-4 sentences, mention era or cultural context if relevant, condition, and why it's worth buying",
    },
    "depop": {
        "tone": "casual and trend-forward, gen-Z friendly",
        "title_rules": "max 50 characters, use popular Depop search terms and aesthetic descriptors",
        "description_rules": "2-3 sentences, highlight vibe/style, condition, and measurements if visible",
    },
}

async def generate_listing_draft(
    platform: str,
    identified_item: dict,
    condition_assessment: str,
    price_range: dict,
) -> dict:
    """
    Generate a title + description for one platform using the appraisal data
    already returned by the main call. Returns {"title": str, "description": str}.
    """
    rules = LISTING_PROMPTS.get(platform)
    if not rules:
        raise ValueError(f"Unknown platform: {platform}")

    item_summary = (
        f"Brand: {identified_item.get('brand', 'Unknown')}\n"
        f"Model: {identified_item.get('model', 'Unknown')}\n"
        f"Colorway: {identified_item.get('colorway', 'N/A')}\n"
        f"Era: {identified_item.get('estimated_era', 'N/A')}\n"
        f"Category: {identified_item.get('category', 'Unknown')}\n"
        f"Condition: {condition_assessment}\n"
        f"Price range: ${price_range.get('low')}–${price_range.get('high')} USD"
    )

    prompt = (
        f"Write a {platform} resale listing for the following item.\n\n"
        f"Item details:\n{item_summary}\n\n"
        f"Tone: {rules['tone']}\n"
        f"Title rules: {rules['title_rules']}\n"
        f"Description rules: {rules['description_rules']}\n\n"
        f"Respond ONLY with valid JSON, no markdown:\n"
        f'{{"title": "string", "description": "string"}}'
    )

    message = anthropic_client.messages.create(
        model=settings.ANTHROPIC_MODEL,
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = "".join(b.text for b in message.content if b.type == "text")
    cleaned = raw.replace("```json", "").replace("```", "").strip()
    return json.loads(cleaned)


# ==========================================================================
# DATABASE SERVICE
# ==========================================================================

async def store_appraisal(
    request: EstimateRequest,
    appraisal: AIAppraisalResponse,
    image_url: Optional[str],
) -> dict:
    """
    Stores the appraisal result in the Supabase database.

    Returns the inserted row (including the auto-generated id and timestamps).

    WHY WE DENORMALIZE:
    We store both the full AI response (as JSONB) AND extracted fields
    (identified_brand, price_low, etc.) in separate columns. This is
    intentional:
    - The JSONB column is the source of truth (complete AI output)
    - The extracted columns enable fast SQL queries (WHERE, ORDER BY, GROUP BY)
    - Example: "SELECT * WHERE identified_brand = 'Nike' ORDER BY price_high DESC"
      is way faster on an indexed column than on a JSONB path query
    """

    row = {
        # User-provided metadata
        "category": request.category,
        "condition": request.condition,
        "brand": request.brand,
        "size": request.size,
        "notes": request.notes,

        # Image
        "image_url": image_url,
        "original_filename": request.original_filename,
        "image_media_type": request.image_media_type,

        # Full AI response as JSONB
        "ai_response": appraisal.model_dump(),

        # Denormalized fields for fast queries
        "identified_brand": (
            appraisal.identified_item.brand
            if appraisal.identified_item else None
        ),
        "identified_model": (
            appraisal.identified_item.model
            if appraisal.identified_item else None
        ),
        "price_low": (
            appraisal.platform_prices.ebay.low
            if appraisal.platform_prices and appraisal.platform_prices.ebay else None
        ),
        "price_high": (
            appraisal.platform_prices.ebay.high
            if appraisal.platform_prices and appraisal.platform_prices.ebay else None
        ),
        "confidence": appraisal.confidence,
        "best_platform": appraisal.best_platform,

        # Denormalized copy of the AI's reasoning, for queryability.
        # The full list also lives inside ai_response (above), but having
        # its own column matches the pattern of identified_brand/price_low/etc.
        # See migration 002_add_pricing_factors.sql for why this is separate.
        "pricing_factors": (
            [f.model_dump() for f in appraisal.pricing_factors]
            if appraisal.pricing_factors else None
        ),

        "status": "completed",
    }

    # Insert into Supabase via the REST API
    # .execute() returns the inserted row(s) with all auto-generated fields
    result = supabase.table("appraisals").insert(row).execute()

    # result.data is a list of inserted rows; we always insert one
    return result.data[0]


async def get_appraisal_history(
    page: int = 1,
    per_page: int = 20,
    category: Optional[str] = None,
    brand: Optional[str] = None,
) -> dict:
    """
    Fetches paginated appraisal history with optional filters.

    PAGINATION APPROACH:
    We use offset-based pagination (LIMIT/OFFSET) which is simple and works
    well for small-to-medium datasets. For very large datasets (100k+ rows),
    you'd switch to cursor-based pagination for better performance.
    """

    # Start building the query
    query = supabase.table("appraisals").select(
        "id, created_at, image_url, category, condition, "
        "identified_brand, identified_model, price_low, price_high, confidence",
        count="exact",  # This makes Supabase return the total row count
    )

    # Apply optional filters
    if category:
        query = query.eq("category", category)
    if brand:
        query = query.ilike("identified_brand", f"%{brand}%")  # Case-insensitive

    # Apply pagination and ordering
    offset = (page - 1) * per_page
    query = query.order("created_at", desc=True).range(offset, offset + per_page - 1)

    result = query.execute()

    return {
        "items": result.data,
        "total": result.count or 0,
        "page": page,
        "per_page": per_page,
    }


async def get_appraisal_by_id(appraisal_id: str) -> Optional[dict]:
    """
    Fetches a single appraisal by ID, including the full AI response.
    Used for the detail view when a user clicks into a specific item.
    """
    result = (
        supabase.table("appraisals")
        .select("*")
        .eq("id", appraisal_id)
        .execute()
    )
    return result.data[0] if result.data else None


async def get_aggregate_stats() -> dict:
    """
    Computes aggregate statistics across all appraisals.

    NOTE ON APPROACH:
    Supabase's REST API doesn't support GROUP BY natively, so we use
    the RPC (Remote Procedure Call) pattern — calling a Postgres function.

    For the MVP, we fetch all rows and aggregate in Python. This is fine
    for <10k rows. For scale, you'd create a Postgres function:

        CREATE FUNCTION get_stats() RETURNS JSON AS $$
          SELECT json_build_object(
            'total', COUNT(*),
            'avg_low', AVG(price_low),
            ...
          ) FROM appraisals;
        $$ LANGUAGE sql;

    And call it via: supabase.rpc('get_stats').execute()
    """

    # Fetch summary data (just the fields we need for aggregation)
    result = (
        supabase.table("appraisals")
        .select("identified_brand, category, confidence, price_low, price_high")
        .eq("status", "completed")
        .execute()
    )

    rows = result.data or []
    total = len(rows)

    if total == 0:
        return {
            "total_appraisals": 0,
            "average_price_low": None,
            "average_price_high": None,
            "top_brands": [],
            "category_breakdown": [],
            "confidence_breakdown": [],
        }

    # Calculate averages
    prices_low = [r["price_low"] for r in rows if r.get("price_low")]
    prices_high = [r["price_high"] for r in rows if r.get("price_high")]

    # Count occurrences for breakdowns
    brand_counts: dict[str, int] = {}
    category_counts: dict[str, int] = {}
    confidence_counts: dict[str, int] = {}

    for row in rows:
        brand = row.get("identified_brand") or "Unknown"
        brand_counts[brand] = brand_counts.get(brand, 0) + 1

        cat = row.get("category") or "Unknown"
        category_counts[cat] = category_counts.get(cat, 0) + 1

        conf = row.get("confidence") or "unknown"
        confidence_counts[conf] = confidence_counts.get(conf, 0) + 1

    return {
        "total_appraisals": total,
        "average_price_low": round(sum(prices_low) / len(prices_low), 2) if prices_low else None,
        "average_price_high": round(sum(prices_high) / len(prices_high), 2) if prices_high else None,
        "top_brands": sorted(
            [{"brand": k, "count": v} for k, v in brand_counts.items()],
            key=lambda x: x["count"],
            reverse=True,
        )[:10],  # Top 10 brands
        "category_breakdown": [
            {"category": k, "count": v} for k, v in category_counts.items()
        ],
        "confidence_breakdown": [
            {"confidence": k, "count": v} for k, v in confidence_counts.items()
        ],
    }
