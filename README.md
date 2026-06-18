# ThriftBot — AI-Powered Resale Price Estimator

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React)                        │
│  Upload photo → Fill metadata → Submit → View results/history  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTP (JSON + base64 image)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      BACKEND (FastAPI)                          │
│                                                                 │
│  POST /api/estimate    ← Image + metadata in, price range out   │
│  GET  /api/history     ← Paginated appraisal history            │
│  GET  /api/history/:id ← Single appraisal detail                │
│  GET  /api/stats       ← Aggregate stats (avg prices, counts)   │
│                                                                 │
│  Responsibilities:                                              │
│  1. Validate & resize incoming images                           │
│  2. Call Anthropic API (API key stays server-side)               │
│  3. Parse structured JSON response                              │
│  4. Store appraisal + image URL in Supabase                     │
│  5. Return result to frontend                                   │
└──────────┬────────────────────────────┬─────────────────────────┘
           │                            │
           ▼                            ▼
┌────────────────────┐    ┌──────────────────────────┐
│   Anthropic API    │    │     Supabase (Free)      │
│                    │    │                          │
│  Claude Sonnet     │    │  Postgres DB (tables)    │
│  Vision + Text     │    │  Storage (image bucket)  │
│  → JSON response   │    │  Auth (optional, later)  │
│                    │    │  REST API (auto-generated)│
└────────────────────┘    └──────────────────────────┘
```

## Why This Architecture?

### Why a backend at all?
The original starter called the Anthropic API from the browser. That works for a
demo but exposes your API key in client-side code. The backend is the minimal
addition that makes this production-safe. It also gives you a place to add
business logic (rate limiting, image validation, caching) without touching the
frontend.

### Why FastAPI?
- Python — same language as most AI/ML work, good for your resume
- Async by default — handles concurrent image uploads well
- Auto-generated API docs at /docs (Swagger) — great for portfolio demos
- Type hints + Pydantic models = self-documenting request/response schemas

### Why Supabase?
- Free tier: 500MB database, 1GB storage, 50k monthly active users
- Instant REST API: Every table gets CRUD endpoints automatically
- Storage buckets: Upload images directly, get public URLs back
- Auth (optional): Add user accounts later with zero backend changes
- Dashboard: Browse your data visually during development
- Python client: `supabase-py` is well-maintained and straightforward

### What Supabase gives you for FREE:
1. **Postgres database** — real SQL, not a toy. Supports JSON columns, full-text
   search, and all the query power you'd expect.
2. **Storage** — S3-compatible object storage. Upload the user's photo, get a
   public URL, store the URL in your DB. No need for AWS/Cloudinary.
3. **Auto-generated API** — every table becomes a REST endpoint. You CAN use
   this directly from the frontend (with row-level security), but we go through
   the backend for control.
4. **Auth** — email/password, OAuth, magic links. Add it when you want user
   accounts. Not needed for MVP.

## Setup Instructions

### 1. Supabase
1. Create a free account at supabase.com
2. Create a new project (pick any region, note your password)
3. Go to SQL Editor and run the migration in `supabase/001_initial_schema.sql`
4. Go to Storage and create a bucket called `item-images` (set to public)
5. Go to Settings → API and copy your `URL` and `anon` key

### 2. Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -r requirements.txt

# Create .env file
cp .env.example .env
# Fill in your keys: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_KEY

# Run
uvicorn main:app --reload --port 8000
```

### 3. Frontend
```bash
cd frontend
npm install
npm run dev
```

## File Structure
```
thriftbot-expanded/
├── README.md                  ← You are here
├── supabase/
│   └── 001_initial_schema.sql ← Database migration (run once)
├── backend/
│   ├── main.py                ← FastAPI app (all routes)
│   ├── models.py              ← Pydantic request/response schemas
│   ├── services.py            ← Business logic (Anthropic + Supabase calls)
│   ├── config.py              ← Environment variable loading
│   ├── requirements.txt       ← Python dependencies
│   └── .env.example           ← Template for secrets
└── frontend/
    └── ThriftBot.jsx          ← Updated React component (calls backend)
```
