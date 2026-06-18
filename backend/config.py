"""
============================================================================
config.py — Environment Variable Loading
============================================================================
Centralizes all configuration. Every secret and tunable value lives here.

WHY PYDANTIC SETTINGS?
- Validates env vars at startup (fail fast if ANTHROPIC_API_KEY is missing)
- Type coercion (CORS_ORIGINS string → list, MAX_IMAGE_SIZE string → int)
- IDE autocomplete on config.ANTHROPIC_API_KEY instead of os.getenv("...")
- .env file support built in — no need for python-dotenv separately

SECURITY NOTE:
Never commit .env files. The .env.example shows what's needed without
exposing real values.
============================================================================
"""

from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """
    All config values are loaded from environment variables (or .env file).
    Each field has a type annotation — Pydantic coerces the string env var
    to the right type automatically.
    """

    # ======================================================================
    # ANTHROPIC API
    # ======================================================================
    # Get your key from: console.anthropic.com → API Keys
    # Free trial credits are enough to build and test this project.
    ANTHROPIC_API_KEY: str

    # Model choice — Sonnet is the sweet spot for vision + pricing tasks.
    # Haiku would be cheaper but less accurate on brand identification.
    # Opus would be more accurate but ~5x more expensive with minimal gain.
    ANTHROPIC_MODEL: str = "claude-sonnet-4-20250514"

    # Max tokens for the AI response. 1000 is plenty for our JSON schema.
    ANTHROPIC_MAX_TOKENS: int = 1000

    # ======================================================================
    # SUPABASE
    # ======================================================================
    # Get these from: supabase.com → your project → Settings → API
    #
    # SUPABASE_URL: The project URL (e.g., https://xyz.supabase.co)
    # SUPABASE_KEY: Use the `service_role` key for backend access.
    #   The `anon` key works too but has RLS restrictions.
    #   NEVER expose the service_role key to the frontend.
    SUPABASE_URL: str
    SUPABASE_KEY: str

    # Storage bucket name — must match what you created in the dashboard.
    SUPABASE_BUCKET: str = "item-images"

    # ======================================================================
    # APP SETTINGS
    # ======================================================================

    # Max image upload size in bytes (5MB). Matches frontend validation.
    MAX_IMAGE_SIZE: int = 5 * 1024 * 1024

    # Allowed image MIME types. Must match what Claude's vision API accepts.
    ALLOWED_IMAGE_TYPES: list[str] = [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/heic",   # iPhone default format
        "image/heif",   # HEIF container (same thing, different MIME)
    ]

    # CORS origins — which frontend URLs can call this API.
    # In development: http://localhost:5173 (Vite default)
    # In production: your actual domain
    CORS_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
    ]

    # Rate limiting: max estimations per IP per hour.
    # Prevents abuse and runaway API costs.
    # Set to 0 to disable (not recommended in production).
    RATE_LIMIT_PER_HOUR: int = 30

    class Config:
        # Load from .env file in the same directory
        env_file = ".env"
        env_file_encoding = "utf-8"
        # Don't fail if .env doesn't exist (env vars might be set directly)
        env_ignore_empty = True


@lru_cache()
def get_settings() -> Settings:
    """
    Cached settings loader. The @lru_cache ensures we only parse env vars
    once, not on every request. This is the standard FastAPI pattern.

    Usage in routes:
        from config import get_settings
        settings = get_settings()
        print(settings.ANTHROPIC_API_KEY)
    """
    return Settings()
