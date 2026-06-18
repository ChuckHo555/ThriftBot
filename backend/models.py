"""
============================================================================
models.py — Pydantic Request/Response Schemas
============================================================================
These models define the exact shape of data flowing in and out of the API.

WHY PYDANTIC MODELS?
1. Automatic request validation — if a required field is missing, FastAPI
   returns a 422 with a clear error message before your code even runs.
2. Response serialization — ensures the API always returns consistent JSON.
3. Auto-generated API docs — FastAPI uses these models to build the Swagger
   UI at /docs, making your API self-documenting.
4. Type safety — IDE autocomplete and mypy checking throughout the codebase.

DESIGN PATTERN:
- *Request models have fields the client sends.
- *Response models have fields the server returns.
- We keep them separate even when they overlap because the shapes often
  diverge over time (e.g., response has `id` and `created_at` that the
  request doesn't).
============================================================================
"""

from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from uuid import UUID


# ==========================================================================
# REQUEST MODELS — What the client sends us
# ==========================================================================


class EstimateRequest(BaseModel):
    """
    The payload for POST /api/estimate.

    The image is sent as a base64-encoded string. In a more optimized setup,
    you might use multipart/form-data to stream the file, but base64-in-JSON
    is simpler to implement on both client and server, and fine for images
    under 5MB.

    ALTERNATIVE APPROACH: You could accept multipart/form-data with a File
    upload + form fields. FastAPI supports this natively with UploadFile.
    We use base64 JSON here because:
    1. The frontend already has the base64 from the previous starter
    2. It's easier to test with curl/Postman (just paste JSON)
    3. At <5MB per image, the base64 overhead (~33%) is negligible
    """

    # Image data (required)
    image_base64: str = Field(
        ...,
        description="Base64-encoded image data (without data URI prefix)"
    )
    image_media_type: str = Field(
        ...,
        description="MIME type of the image (e.g., 'image/jpeg')"
    )
    original_filename: Optional[str] = Field(
        None,
        description="Original filename for display purposes"
    )

    # Item metadata (category and condition required, rest optional)
    category: str = Field(
        ...,
        description="Item category: Sneakers, Streetwear, Denim, etc."
    )
    condition: str = Field(
        ...,
        description="Item condition: Deadstock/New, Like New, Good, Fair, Poor"
    )
    brand: Optional[str] = Field(
        None,
        description="Brand name if known by the user"
    )
    size: Optional[str] = Field(
        None,
        description="Size (e.g., 'US 10', 'M', '32x30')"
    )
    notes: Optional[str] = Field(
        None,
        description="Any additional context the user wants to provide"
    )


# ==========================================================================
# AI RESPONSE MODELS — Structured output from Claude
# ==========================================================================
# These mirror the JSON schema we ask Claude to return in the system prompt.
# Having Pydantic models for the AI response means we can validate it and
# catch malformed responses before they reach the database or frontend.
# ==========================================================================


class IdentifiedItem(BaseModel):
    brand: Optional[str] = None
    model: Optional[str] = None
    colorway: Optional[str] = None
    estimated_era: Optional[str] = None
    category: Optional[str] = None


class PriceEstimate(BaseModel):
    low: float
    high: float
    currency: str = "USD"
    best_platform: Optional[str] = None


class PlatformPriceRange(BaseModel):
    """A low/high price range for a single resale platform."""
    low: float
    high: float


class PlatformPrices(BaseModel):
    """
    Separate price estimates per platform.

    WHY THREE PLATFORMS?
    eBay, Grailed, and Depop each have a distinct buyer pool. A Supreme hoodie
    sells for more on Grailed (hype buyers) than eBay (broader, more price-
    sensitive). Giving platform-specific ranges helps sellers pick the right
    venue, which is the actual decision they're making.
    """
    ebay: Optional[PlatformPriceRange] = None
    grailed: Optional[PlatformPriceRange] = None
    depop: Optional[PlatformPriceRange] = None


class PricingFactor(BaseModel):
    """
    One reason behind the price estimate.

    factor: human-readable observation (e.g., "2003 OG colorway is sought after")
    impact: dollar impact as a string ("+$15", "-$10", or "neutral")

    WHY ARE BOTH OPTIONAL?
    Same defensive pattern as the rest of this file — we'd rather accept a
    partial response than crash the whole appraisal. If Claude returns 4
    well-formed factors and 1 partial one, we still get the good ones.

    WHY `impact` IS A STRING, NOT A NUMBER:
    Some factors are qualitative ("neutral", "+ slight"). Forcing a number
    would push Claude into false precision.
    """
    factor: Optional[str] = None
    impact: Optional[str] = None


class AuthenticityCheck(BaseModel):
    """
    Visual-only authenticity assessment.
    verdict values:
      no_red_flags    — nothing suspicious spotted
      minor_concerns  — one or two details worth verifying in person
      potential_issues — multiple visual inconsistencies
      not_applicable  — brand not known for counterfeits / item type not checkable
    """
    verdict: Optional[str] = None
    observations: Optional[list[str]] = None
    disclaimer: Optional[str] = None


class AIAppraisalResponse(BaseModel):
    """
    The structured JSON that Claude returns.

    All fields are Optional except the price estimate because the AI might
    not be able to identify every attribute. We'd rather get a partial
    response than a parse failure.
    """
    is_applicable: Optional[bool] = True
    rejection_reason: Optional[str] = None
    identified_item: Optional[IdentifiedItem] = None
    condition_assessment: Optional[str] = None
    platform_prices: Optional[PlatformPrices] = None
    best_platform: Optional[str] = None
    pricing_factors: Optional[list[PricingFactor]] = None
    confidence: Optional[str] = None  # "low", "medium", "high"
    confidence_reasoning: Optional[str] = None
    comparables: Optional[list[str]] = None
    tips: Optional[str] = None
    authenticity_check: Optional[AuthenticityCheck] = None


# ==========================================================================
# API RESPONSE MODELS — What we send back to the client
# ==========================================================================


class EstimateResponse(BaseModel):
    """
    The full response for POST /api/estimate.

    Includes the AI appraisal PLUS metadata about the stored record
    (id, timestamps, image URL). The frontend uses the `id` to link
    to the detail view in history.

    NOTE: `id` is typed as a plain string (not UUID) on purpose.
    When the DB save fails, main.py falls back to id="temp-no-db" so
    the user still gets the appraisal. A strict UUID type would reject
    that fallback and turn a non-fatal warning into a hard 500 error.
    Same reasoning for `created_at` being a string fallback-friendly type.
    """
    id: str
    created_at: datetime | float
    image_url: Optional[str] = None
    category: str
    condition: str
    brand: Optional[str] = None
    size: Optional[str] = None
    appraisal: AIAppraisalResponse


class HistoryItem(BaseModel):
    """
    A single item in the history list. Intentionally lighter than
    EstimateResponse — we don't include the full AI response in the
    list view to keep payloads small. The client fetches the full
    detail when the user clicks into a specific appraisal.
    """
    id: UUID
    created_at: datetime
    image_url: Optional[str] = None
    category: str
    condition: str
    identified_brand: Optional[str] = None
    identified_model: Optional[str] = None
    price_low: Optional[float] = None
    price_high: Optional[float] = None
    confidence: Optional[str] = None


class HistoryResponse(BaseModel):
    """Paginated list of appraisals."""
    items: list[HistoryItem]
    total: int
    page: int
    per_page: int


class StatsResponse(BaseModel):
    """
    Aggregate statistics across all appraisals.
    Fun for a dashboard view and shows off SQL aggregation skills.
    """
    total_appraisals: int
    average_price_low: Optional[float] = None
    average_price_high: Optional[float] = None
    top_brands: list[dict]         # [{"brand": "Nike", "count": 15}, ...]
    category_breakdown: list[dict]  # [{"category": "Sneakers", "count": 23}, ...]
    confidence_breakdown: list[dict]  # [{"confidence": "high", "count": 40}, ...]
