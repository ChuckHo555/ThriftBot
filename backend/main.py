"""
============================================================================
main.py — FastAPI Application Entry Point
============================================================================
This is the thin routing layer. Each route:
1. Validates the incoming request (Pydantic handles this automatically)
2. Calls the appropriate service function
3. Returns the response in the right shape

RUNNING:
    uvicorn main:app --reload --port 8000

    --reload: Auto-restart on code changes (dev only, remove in production)
    --port 8000: Default port. Frontend should target http://localhost:8000

API DOCS:
    Once running, visit http://localhost:8000/docs for interactive Swagger UI.
    This is auto-generated from the Pydantic models — zero extra work.
    Great for portfolio demos: interviewers can try the API live.
============================================================================
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import time

from config import get_settings
from models import (
    EstimateRequest,
    EstimateResponse,
    AIAppraisalResponse,
    HistoryResponse,
    StatsResponse,
)
from services import (
    call_anthropic_vision,
    upload_image_to_storage,
    store_appraisal,
    get_appraisal_history,
    get_appraisal_by_id,
    get_aggregate_stats,
    preprocess_image,
    generate_listing_draft,
)


settings = get_settings()


# ==========================================================================
# APP LIFESPAN
# ==========================================================================
# The lifespan context manager runs setup code on startup and cleanup code
# on shutdown. We use it here to verify config on boot — if the API key
# or Supabase URL is missing, the app fails immediately instead of waiting
# for the first request to discover the problem.
# ==========================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic."""
    # Startup: verify config is valid
    print(f"[BOOT] ThriftBot API starting...")
    print(f"[BOOT] Model: {settings.ANTHROPIC_MODEL}")
    print(f"[BOOT] Supabase URL: {settings.SUPABASE_URL[:30]}...")
    print(f"[BOOT] CORS origins: {settings.CORS_ORIGINS}")
    yield
    # Shutdown: clean up if needed (nothing to do for now)
    print("[SHUTDOWN] ThriftBot API stopping.")


# ==========================================================================
# APP INITIALIZATION
# ==========================================================================

app = FastAPI(
    title="ThriftBot API",
    description="AI-powered resale price estimation for clothing and sneakers",
    version="1.0.0",
    lifespan=lifespan,
)


# ==========================================================================
# MIDDLEWARE
# ==========================================================================
# CORS: Required because the frontend (localhost:5173) and backend
# (localhost:8000) are on different ports = different origins.
# Without this, the browser blocks all API requests.
#
# In production, replace the origins list with your actual domain.
# NEVER use allow_origins=["*"] in production — it disables CORS entirely.
# ==========================================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],  # Allow all HTTP methods (GET, POST, etc.)
    allow_headers=["*"],  # Allow all headers (Content-Type, Authorization, etc.)
)


# ==========================================================================
# SIMPLE IN-MEMORY RATE LIMITER
# ==========================================================================
# Tracks request counts per IP address per hour. This prevents:
# 1. Accidental infinite loops in the frontend burning API credits
# 2. Malicious users spamming the estimation endpoint
#
# LIMITATIONS:
# - Resets on server restart (that's fine for a portfolio project)
# - Doesn't work with multiple server instances (use Redis for that)
# - No sliding window — just resets every hour
#
# FOR PRODUCTION: Use a Redis-backed rate limiter like slowapi or
# a reverse proxy (nginx, Cloudflare) with rate limiting built in.
# ==========================================================================

rate_limit_store: dict[str, list[float]] = {}


def check_rate_limit(ip: str) -> bool:
    """
    Returns True if the request is allowed, False if rate limited.
    Cleans up old entries on each check.
    """
    if settings.RATE_LIMIT_PER_HOUR == 0:
        return True  # Rate limiting disabled

    now = time.time()
    one_hour_ago = now - 3600

    # Get or create the timestamps list for this IP
    timestamps = rate_limit_store.get(ip, [])

    # Remove timestamps older than 1 hour
    timestamps = [t for t in timestamps if t > one_hour_ago]

    # Check if under limit
    if len(timestamps) >= settings.RATE_LIMIT_PER_HOUR:
        rate_limit_store[ip] = timestamps
        return False

    # Allow and record this request
    timestamps.append(now)
    rate_limit_store[ip] = timestamps
    return True


# ==========================================================================
# ROUTES
# ==========================================================================


@app.post("/api/estimate", response_model=EstimateResponse)
async def estimate_item(request: EstimateRequest, req: Request):
    """
    Main estimation endpoint. The full flow:

    1. Validate the request (Pydantic does this before we even get here)
    2. Check rate limit
    3. Validate image type and size
    4. Upload image to Supabase Storage (async, non-blocking)
    5. Send image + metadata to Claude for appraisal
    6. Store the result in the database
    7. Return the structured response

    TIMING: Steps 4 and 5 could run in parallel (asyncio.gather) since
    they're independent. We run them sequentially here for clarity.
    In production, parallelize for ~2-3 second savings.
    """

    # --- Rate limiting ---
    client_ip = req.client.host if req.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded. Max {settings.RATE_LIMIT_PER_HOUR} "
                   f"estimates per hour.",
        )

    # --- Validate image type ---
    if request.image_media_type not in settings.ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported image type: {request.image_media_type}. "
                   f"Allowed: {settings.ALLOWED_IMAGE_TYPES}",
        )

    # --- Step 0: Preprocess image (resize + re-encode) ---
    # Run this first so both storage and Claude receive the same optimized image.
    # preprocess_image is defensive — it falls back to the original on any error.
    request.image_base64, request.image_media_type = preprocess_image(
        image_base64=request.image_base64,
        media_type=request.image_media_type,
    )

    # --- Step 1: Upload image to storage ---
    # This runs first so we have the URL before storing the appraisal.
    # If it fails, we continue without an image URL (graceful degradation).
    image_url = await upload_image_to_storage(
        image_base64=request.image_base64,
        media_type=request.image_media_type,
        original_filename=request.original_filename,
    )

    # --- Step 2: Call Claude for the appraisal ---
    try:
        appraisal = await call_anthropic_vision(
            image_base64=request.image_base64,
            media_type=request.image_media_type,
            metadata={
                "category": request.category,
                "condition": request.condition,
                "brand": request.brand,
                "size": request.size,
                "notes": request.notes,
            },
        )
    except Exception as e:
        # Log the full error server-side, return a clean message to the client.
        # Never expose internal errors (API keys, stack traces) to the frontend.
        print(f"[ERROR] Anthropic API call failed: {e}")
        raise HTTPException(
            status_code=502,
            detail="AI estimation failed. Please try again.",
        )

    # --- Step 3: Store in database ---
    try:
        stored = await store_appraisal(
            request=request,
            appraisal=appraisal,
            image_url=image_url,
        )
    except Exception as e:
        # If DB storage fails, we still return the appraisal to the user.
        # They paid for the API call — don't lose the result.
        print(f"[ERROR] Database storage failed: {e}")
        stored = {"id": "temp-no-db", "created_at": time.time()}

    # --- Return structured response ---
    return EstimateResponse(
        id=stored["id"],
        created_at=stored["created_at"],
        image_url=image_url,
        category=request.category,
        condition=request.condition,
        brand=request.brand,
        size=request.size,
        appraisal=appraisal,
    )


@app.post("/api/listing-draft")
async def listing_draft(request: Request):
    """
    Generate a platform-specific listing title + description on demand.
    Accepts the appraisal data the frontend already has — no DB lookup needed.
    """
    body = await request.json()
    platform = body.get("platform", "").lower()
    if platform not in ("ebay", "grailed", "depop"):
        raise HTTPException(status_code=400, detail="platform must be ebay, grailed, or depop")

    try:
        draft = await generate_listing_draft(
            platform=platform,
            identified_item=body.get("identified_item") or {},
            condition_assessment=body.get("condition_assessment") or "",
            price_range=body.get("price_range") or {},
        )
        return draft
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate listing: {str(e)}")


@app.get("/api/history", response_model=HistoryResponse)
async def list_history(
    page: int = 1,
    per_page: int = 20,
    category: str = None,
    brand: str = None,
):
    """
    Returns paginated appraisal history with optional filters.

    QUERY PARAMETERS:
    - page: Page number (1-indexed)
    - per_page: Items per page (max 50, to prevent huge payloads)
    - category: Filter by item category (exact match)
    - brand: Filter by identified brand (case-insensitive partial match)

    EXAMPLE CALLS:
    GET /api/history?page=1&per_page=10
    GET /api/history?category=Sneakers&brand=nike
    """
    if per_page > 50:
        per_page = 50  # Cap to prevent abuse

    result = await get_appraisal_history(
        page=page,
        per_page=per_page,
        category=category,
        brand=brand,
    )
    return HistoryResponse(**result)


@app.get("/api/history/{appraisal_id}")
async def get_history_detail(appraisal_id: str):
    """
    Returns the full detail for a single appraisal, including the complete
    AI response. Used when the user clicks into a specific item in their
    history.
    """
    result = await get_appraisal_by_id(appraisal_id)
    if not result:
        raise HTTPException(status_code=404, detail="Appraisal not found")
    return result


@app.get("/api/stats", response_model=StatsResponse)
async def get_stats():
    """
    Returns aggregate statistics across all appraisals.
    Useful for a dashboard view: total items appraised, average prices,
    top brands, category breakdown.
    """
    return await get_aggregate_stats()


# ==========================================================================
# HEALTH CHECK
# ==========================================================================
# A simple endpoint that returns 200. Used by:
# - Docker health checks
# - Load balancers
# - Uptime monitoring (e.g., UptimeRobot, free tier)
# - Your own sanity during development ("is the server running?")
# ==========================================================================

@app.get("/health")
async def health_check():
    return {"status": "healthy", "model": settings.ANTHROPIC_MODEL}
