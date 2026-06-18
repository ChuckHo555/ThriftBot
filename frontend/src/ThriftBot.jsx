/**
 * ============================================================================
 * THRIFT-BOT — EXPANDED FRONTEND
 * ============================================================================
 *
 * WHAT CHANGED FROM THE STARTER:
 *
 * 1. API CALLS GO TO THE BACKEND, NOT ANTHROPIC DIRECTLY
 *    The frontend now calls POST /api/estimate on our FastAPI backend.
 *    The API key lives server-side — never touches the browser.
 *
 * 2. HISTORY TAB
 *    New tab view shows past appraisals fetched from Supabase via the
 *    backend's GET /api/history endpoint. Users can browse their previous
 *    estimates, filter by category, and click into detail views.
 *
 * 3. STATS DASHBOARD (MINI)
 *    A small stats bar at the top showing total appraisals, average price
 *    range, and top brand. Fetched from GET /api/stats.
 *
 * WHAT STAYS THE SAME:
 * - Single-file structure (for the starter — split in production)
 * - Same upload flow and metadata form
 * - Same results display layout
 * - Warm, earthy design palette
 *
 * YOUR FRIEND'S NEXT STEPS:
 * - Split into components: UploadZone.jsx, MetadataForm.jsx, ResultsCard.jsx
 * - Add React Router for /estimate and /history routes
 * - Add loading skeletons (react-loading-skeleton package)
 * - Add toast notifications for success/error states
 * ============================================================================
 */

import { useState, useCallback, useRef, useEffect } from "react";

/* ============================================================================
 * CONFIG
 * ============================================================================
 * API_BASE points to the FastAPI backend. In development, this is
 * localhost:8000. In production, it's your deployed backend URL.
 *
 * IMPORTANT: If using Vite, you can also set up a proxy in vite.config.js
 * to avoid CORS during development:
 *
 *   server: {
 *     proxy: { '/api': 'http://localhost:8000' }
 *   }
 *
 * Then set API_BASE to '' (empty string) and all /api/* calls route through
 * the Vite dev server to your backend.
 * ========================================================================= */

const API_BASE = "http://localhost:8000";

const CONFIG = {
  categories: ["Sneakers", "Streetwear", "Denim", "Activewear", "Formal", "Other"],
  conditions: ["Deadstock/New", "Like New", "Good", "Fair", "Poor"],
  sizeHint: "e.g. US 10, M, 32x30, One Size",
};

/* ============================================================================
 * FILE UTILITIES (same as starter)
 * ========================================================================= */

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];
// Browsers often report HEIC files as empty string since they don't natively
// understand the format. We fall back to extension check to catch those cases.
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heics"];

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function validateFile(file) {
  if (!file) return "No file selected";
  const ext = "." + file.name.split(".").pop().toLowerCase();
  const typeOk = ALLOWED_TYPES.includes(file.type) || file.type === "";
  const extOk = ALLOWED_EXTENSIONS.includes(ext);
  if (!typeOk || !extOk) return `Unsupported file: ${file.name}`;
  if (file.size > MAX_FILE_SIZE) return `Too large (max 5MB)`;
  return null;
}

/* ============================================================================
 * API CLIENT
 * ============================================================================
 * Centralized API calls. Each function maps to one backend endpoint.
 * This makes it easy to swap the base URL, add auth headers, or add
 * request/response interceptors later.
 * ========================================================================= */

const api = {
  /**
   * POST /api/estimate — Send image + metadata, get appraisal back.
   * This replaces the direct Anthropic API call from the starter.
   * The backend handles: API key auth, image storage, DB persistence.
   */
  async estimate(imageBase64, mediaType, filename, metadata) {
    const res = await fetch(`${API_BASE}/api/estimate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_base64: imageBase64,
        image_media_type: mediaType,
        original_filename: filename,
        ...metadata,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Unknown error" }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
  },

  /**
   * GET /api/history — Fetch paginated appraisal history.
   * Supports filtering by category and brand via query params.
   */
  async getHistory(page = 1, perPage = 12, filters = {}) {
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
    });
    if (filters.category) params.set("category", filters.category);
    if (filters.brand) params.set("brand", filters.brand);

    const res = await fetch(`${API_BASE}/api/history?${params}`);
    if (!res.ok) throw new Error("Failed to load history");
    return res.json();
  },

  /**
   * GET /api/history/:id — Fetch full detail for one appraisal.
   */
  async getAppraisal(id) {
    const res = await fetch(`${API_BASE}/api/history/${id}`);
    if (!res.ok) throw new Error("Appraisal not found");
    return res.json();
  },

  /**
   * GET /api/stats — Fetch aggregate statistics.
   */
  async getStats() {
    const res = await fetch(`${API_BASE}/api/stats`);
    if (!res.ok) throw new Error("Failed to load stats");
    return res.json();
  },
};

/* ============================================================================
 * MAIN APP COMPONENT
 * ============================================================================
 * Two-tab layout: "Estimate" (upload + results) and "History" (past items).
 * The tab pattern keeps the app feeling like one cohesive tool rather than
 * separate pages. In production, you'd use React Router for URL-based nav.
 * ========================================================================= */

const LOADING_MESSAGES = [
  "Analyzing your item...",
  "Checking the resale market...",
  "Comparing prices across platforms...",
  "Working hard on your results...",
  "Almost there...",
];

export default function ThriftBot() {
  // screen: "form" | "loading" | "results" | "history"
  const [screen, setScreen] = useState("form");
  const [result, setResult] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [error, setError] = useState(null);

  const handleSubmitStart = () => { setError(null); setScreen("loading"); };
  const handleSubmitDone  = (data, preview) => { setResult(data); setImagePreview(preview); setScreen("results"); };
  const handleSubmitError = (msg)  => { setError(msg); setScreen("form"); };
  const handleReset       = () => { setResult(null); setImagePreview(null); setError(null); setScreen("form"); };

  return (
    <div style={styles.page}>
      {/* Inject keyframe animation for loading pulse */}
      <style>{`
        @keyframes pulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.15);opacity:0.7} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
      `}</style>

      {/* --- Top Nav --- */}
      <nav style={styles.nav}>
        <div style={styles.navBrand} onClick={handleReset}>
          <div style={styles.navLogo}>T</div>
          <span style={styles.navTitle}>ThriftBot</span>
        </div>
        <button
          onClick={() => setScreen(screen === "history" ? "form" : "history")}
          style={{ ...styles.navBtn, ...(screen === "history" ? styles.navBtnActive : {}) }}
        >
          📋 History
        </button>
      </nav>

      {/* --- Screens --- */}
      <main style={styles.main}>
        {screen === "form" && (
          <FormScreen
            error={error}
            onSubmitStart={handleSubmitStart}
            onSubmitDone={handleSubmitDone}
            onSubmitError={handleSubmitError}
          />
        )}
        {screen === "loading" && <LoadingScreen />}
        {screen === "results" && result && (
          <ResultsScreen result={result} imagePreview={imagePreview} onReset={handleReset} />
        )}
        {screen === "history" && <HistoryTab />}
      </main>

      <p style={styles.footer}>
        Estimates are AI-generated and may not reflect exact market value.
        Always cross-reference with recent sold listings.
      </p>
    </div>
  );
}

/* ============================================================================
 * LOADING SCREEN
 * ========================================================================= */

function LoadingScreen() {
  const [msgIndex, setMsgIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setMsgIndex((i) => (i + 1) % LOADING_MESSAGES.length);
    }, 2000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={styles.loadingScreen}>
      <div style={styles.pulseIcon}>
        <div style={styles.pulseIconInner}>T</div>
      </div>
      <h2 style={styles.loadingTitle}>Appraising your item</h2>
      <p style={styles.loadingMsg}>{LOADING_MESSAGES[msgIndex]}</p>
    </div>
  );
}

/* ============================================================================
 * FORM SCREEN
 * ========================================================================= */

function FormScreen({ error, onSubmitStart, onSubmitDone, onSubmitError }) {
  const [image, setImage] = useState(null);
  const [metadata, setMetadata] = useState({
    category: CONFIG.categories[0],
    condition: CONFIG.conditions[1],
    brand: "",
    size: "",
    notes: "",
  });
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);

  const handleImageUpload = useCallback(async (file) => {
    const validationError = validateFile(file);
    if (validationError) { onSubmitError(validationError); return; }
    try {
      const base64 = await fileToBase64(file);
      const ext = file.name.split(".").pop().toLowerCase();
      const mediaType = file.type || (["heic", "heics"].includes(ext) ? "image/heic" : "image/jpeg");
      setImage({ file, preview: URL.createObjectURL(file), base64, mediaType });
    } catch { onSubmitError("Failed to process image."); }
  }, [onSubmitError]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleImageUpload(file);
  }, [handleImageUpload]);

  const handleSubmit = useCallback(async () => {
    if (!image) { onSubmitError("Upload a photo first"); return; }
    onSubmitStart();
    try {
      const data = await api.estimate(image.base64, image.mediaType, image.file.name, metadata);
      onSubmitDone(data, image.preview);
    } catch (err) {
      onSubmitError(err.message || "Estimation failed. Try again.");
    }
  }, [image, metadata, onSubmitStart, onSubmitDone, onSubmitError]);

  return (
    <div style={styles.formScreen}>
      <div style={styles.formHero}>
        <h2 style={styles.formHeroTitle}>What's it worth?</h2>
        <p style={styles.formHeroSub}>Drop a photo and get instant resale prices across eBay, Grailed, and Depop.</p>
      </div>

      <div style={styles.formLayout}>
        {/* Left: image upload */}
        <div style={styles.formLeft}>
          {!image ? (
            <div
              style={{ ...styles.dropZone, ...(dragActive ? styles.dropZoneActive : {}) }}
              onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <div style={styles.dropIcon}>📸</div>
              <p style={styles.dropText}>Drop image here or <span style={styles.dropLink}>browse</span></p>
              <p style={styles.dropMeta}>JPEG, PNG, WebP, HEIC · Max 5MB</p>
              <input ref={fileInputRef} type="file" accept="image/*,.heic,.heics" style={{ display: "none" }}
                onChange={(e) => { if (e.target.files?.[0]) handleImageUpload(e.target.files[0]); }} />
            </div>
          ) : (
            <div style={styles.previewContainer}>
              <img src={image.preview} alt="Preview" style={styles.previewImage} />
              <button onClick={() => setImage(null)} style={styles.removeBtn}>✕ Remove</button>
            </div>
          )}
        </div>

        {/* Right: form fields */}
        <div style={styles.formRight}>
          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label style={styles.label}>Category *</label>
              <select style={styles.select} value={metadata.category}
                onChange={(e) => setMetadata((m) => ({ ...m, category: e.target.value }))}>
                {CONFIG.categories.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Condition *</label>
              <select style={styles.select} value={metadata.condition}
                onChange={(e) => setMetadata((m) => ({ ...m, condition: e.target.value }))}>
                {CONFIG.conditions.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label style={styles.label}>Brand (optional)</label>
              <input style={styles.input} placeholder="e.g. Nike, Levi's"
                value={metadata.brand} onChange={(e) => setMetadata((m) => ({ ...m, brand: e.target.value }))} />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Size (optional)</label>
              <input style={styles.input} placeholder={CONFIG.sizeHint}
                value={metadata.size} onChange={(e) => setMetadata((m) => ({ ...m, size: e.target.value }))} />
            </div>
          </div>
          <div style={styles.formGroup}>
            <label style={styles.label}>Notes (optional)</label>
            <textarea style={styles.textarea} rows={3} placeholder="Year, special edition, defects, etc."
              value={metadata.notes} onChange={(e) => setMetadata((m) => ({ ...m, notes: e.target.value }))} />
          </div>

          {error && <div style={styles.error}>{error}</div>}

          <button
            onClick={handleSubmit}
            disabled={!image}
            style={{ ...styles.submitBtn, ...(!image ? styles.submitBtnDisabled : {}) }}
          >
            Estimate Value →
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * RESULTS SCREEN
 * ========================================================================= */

function ResultsScreen({ result, imagePreview, onReset }) {
  const appraisal = result?.appraisal || null;

  const cColor = {
    high:   { bg: "#d1fae5", text: "#065f46", border: "#6ee7b7" },
    medium: { bg: "#fce7f3", text: "#9f1239", border: "#fcd34d" },
    low:    { bg: "#fee2e2", text: "#991b1b", border: "#fca5a5" },
  };

  const impactColor = (impact) => {
    if (!impact) return { bg: "#f5f1ec", text: "#78716c" };
    const first = impact.trim().charAt(0);
    if (first === "+") return { bg: "#d1fae5", text: "#065f46" };
    if (first === "-") return { bg: "#fee2e2", text: "#991b1b" };
    return { bg: "#f5f1ec", text: "#78716c" };
  };

  if (!appraisal) return null;

  return (
    <div style={styles.resultsScreen}>
      <div style={styles.card}>
        {imagePreview && (
          <img src={imagePreview} alt="Appraised item" style={styles.resultImage} />
        )}

        <h2 style={styles.cardTitle}>Appraisal Results</h2>

        {result?.id && result.id !== "temp-no-db" && (
          <div style={styles.savedBadge}>✓ Saved to your history</div>
        )}

        {appraisal.is_applicable === false ? (
          <div style={styles.rejectionBox}>
            <p style={styles.rejectionTitle}>⚠️ Can't appraise this image</p>
            <p style={styles.rejectionText}>
              {appraisal.rejection_reason || "Please upload a photo of a clothing item or sneakers."}
            </p>
          </div>
        ) : <>
          <div style={styles.itemIdBox}>
            <p style={styles.itemBrand}>{appraisal.identified_item?.brand || "Unknown Brand"}</p>
            <p style={styles.itemModel}>
              {[appraisal.identified_item?.model, appraisal.identified_item?.colorway].filter(Boolean).join(" — ") || "Model not identified"}
            </p>
            {appraisal.identified_item?.estimated_era && (
              <p style={styles.itemEra}>Era: {appraisal.identified_item.estimated_era}</p>
            )}
          </div>

          {/* Authenticity Check */}
          {(() => {
            const ac = appraisal.authenticity_check;
            if (!ac || ac.verdict === "not_applicable") return null;
            const cfg = {
              no_red_flags:     { bg: "#f0fdf4", border: "#bbf7d0", color: "#166534", icon: "🟢", label: "No red flags" },
              minor_concerns:   { bg: "#fff1f2", border: "#fbcfe8", color: "#9f1239", icon: "🟡", label: "Minor concerns" },
              potential_issues: { bg: "#fff1f2", border: "#fecdd3", color: "#9f1239", icon: "🔴", label: "Potential issues" },
            }[ac.verdict] || { bg: "#f5f5f4", border: "#e7e5e4", color: "#57534e", icon: "⚪", label: "Unknown" };
            return (
              <div style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
                <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 13, color: cfg.color }}>{cfg.icon} Authenticity — {cfg.label}</p>
                {ac.observations?.map((obs, i) => <p key={i} style={{ margin: "2px 0", fontSize: 12, color: cfg.color }}>· {obs}</p>)}
                {ac.disclaimer && <p style={{ margin: "8px 0 0", fontSize: 11, color: "#a8a29e", fontStyle: "italic" }}>{ac.disclaimer}</p>}
              </div>
            );
          })()}

          {/* Platform Prices */}
          <div style={styles.priceBox}>
            <p style={styles.priceLabel}>Estimated Resale Value</p>
            {appraisal.platform_prices ? (
              <div style={styles.platformPriceList}>
                {[{ key: "ebay", label: "eBay" }, { key: "grailed", label: "Grailed" }, { key: "depop", label: "Depop" }].map(({ key, label }) => {
                  const p = appraisal.platform_prices[key];
                  const isBest = appraisal.best_platform?.toLowerCase() === key;
                  return p ? (
                    <div key={key} style={{ ...styles.platformRow, ...(isBest ? styles.platformRowBest : {}) }}>
                      <span style={styles.platformName}>{label}{isBest && <span style={styles.bestBadge}> ★ Best</span>}</span>
                      <span style={styles.platformRange}>${p.low?.toLocaleString()} — ${p.high?.toLocaleString()}</span>
                    </div>
                  ) : null;
                })}
              </div>
            ) : <p style={styles.priceRange}>Price unavailable</p>}
          </div>

          {/* Pricing Factors */}
          {appraisal.pricing_factors?.length > 0 && (
            <div style={styles.section}>
              <h3 style={styles.sectionTitle}>Why This Price?</h3>
              <div style={styles.factorsList}>
                {appraisal.pricing_factors.map((f, i) => {
                  const color = impactColor(f.impact);
                  return (
                    <div key={i} style={styles.factorRow}>
                      <span style={styles.factorText}>{f.factor}</span>
                      {f.impact && <span style={{ ...styles.factorImpact, background: color.bg, color: color.text }}>{f.impact}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Confidence */}
          {appraisal.confidence && (
            <div style={{ ...styles.confidenceBadge, backgroundColor: cColor[appraisal.confidence]?.bg, color: cColor[appraisal.confidence]?.text, borderColor: cColor[appraisal.confidence]?.border }}>
              <strong>Confidence: {appraisal.confidence.toUpperCase()}</strong>
              {appraisal.confidence_reasoning && <span> — {appraisal.confidence_reasoning}</span>}
            </div>
          )}

          {appraisal.condition_assessment && (
            <div style={styles.section}>
              <h3 style={styles.sectionTitle}>Condition</h3>
              <p style={styles.sectionText}>{appraisal.condition_assessment}</p>
            </div>
          )}

          {appraisal.comparables?.length > 0 && (
            <div style={styles.section}>
              <h3 style={styles.sectionTitle}>Comparable Sales</h3>
              {appraisal.comparables.map((c, i) => <p key={i} style={styles.comparable}>→ {c}</p>)}
            </div>
          )}

          {appraisal.tips && (
            <div style={styles.tipBox}>
              <p style={styles.tipLabel}>💡 Pro Tip</p>
              <p style={styles.tipText}>{appraisal.tips}</p>
            </div>
          )}

          <GoodDealChecker appraisal={appraisal} />
          <ListingDraftSection appraisal={appraisal} />
        </>}
      </div>

      {/* Appraise another button */}
      <div style={styles.resetRow}>
        <button onClick={onReset} style={styles.anotherBtn}>
          ＋ Appraise Another Item
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
 * HISTORY TAB
 * ============================================================================
 * Displays past appraisals in a card grid. Fetches from the backend on mount
 * and when filters change.
 *
 * DESIGN DECISIONS:
 * - Card grid (not table) — more visual, shows thumbnail + price at a glance
 * - Category filter dropdown — most useful filter for browsing
 * - Pagination — simple page numbers, not infinite scroll (simpler to build,
 *   and the data set is small enough that pages work fine)
 * ========================================================================= */

function HistoryTab() {
  const [history, setHistory] = useState(null);
  const [page, setPage] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);

  // Fetch history when tab mounts or filters change
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    api.getHistory(page, 12, { category: categoryFilter || undefined })
      .then((data) => { if (!cancelled) setHistory(data); })
      .catch(() => { if (!cancelled) setHistory({ items: [], total: 0, page: 1, per_page: 12 }); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [page, categoryFilter]);

  // Fetch stats once on mount
  useEffect(() => {
    api.getStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  const totalPages = history ? Math.ceil(history.total / history.per_page) : 0;

  return (
    <>
      {/* --- Mini Stats Bar --- */}
      {stats && stats.total_appraisals > 0 && (
        <div style={styles.statsBar}>
          <div style={styles.statItem}>
            <span style={styles.statValue}>{stats.total_appraisals}</span>
            <span style={styles.statLabel}>Appraised</span>
          </div>
          <div style={styles.statItem}>
            <span style={styles.statValue}>
              ${stats.average_price_low?.toFixed(0)}–${stats.average_price_high?.toFixed(0)}
            </span>
            <span style={styles.statLabel}>Avg Range</span>
          </div>
          {stats.top_brands?.[0] && (
            <div style={styles.statItem}>
              <span style={styles.statValue}>{stats.top_brands[0].brand}</span>
              <span style={styles.statLabel}>Top Brand</span>
            </div>
          )}
        </div>
      )}

      {/* --- Filter Bar --- */}
      <div style={styles.filterBar}>
        <select style={{ ...styles.select, flex: 1 }} value={categoryFilter}
          onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}>
          <option value="">All Categories</option>
          {CONFIG.categories.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>

      {/* --- History Grid --- */}
      {loading ? (
        <div style={styles.card}>
          <p style={styles.loadingText}>Loading history...</p>
        </div>
      ) : history?.items?.length === 0 ? (
        <div style={styles.card}>
          <p style={{ ...styles.loadingText, color: "#78716c" }}>
            No appraisals yet. Upload a photo to get started!
          </p>
        </div>
      ) : (
        <div style={styles.historyGrid}>
          {history.items.map((item) => (
            <div key={item.id} style={styles.historyCard}>
              {/* Thumbnail — shows the uploaded photo from Supabase Storage */}
              {item.image_url ? (
                <img src={item.image_url} alt={item.identified_brand || "Item"}
                  style={styles.historyThumb} />
              ) : (
                <div style={styles.historyThumbPlaceholder}>📷</div>
              )}
              <div style={styles.historyContent}>
                <p style={styles.historyBrand}>
                  {item.identified_brand || "Unknown"}{" "}
                  {item.identified_model && <span style={{ fontWeight: 400, color: "#78716c" }}>· {item.identified_model}</span>}
                </p>
                <p style={styles.historyPrice}>
                  ${item.price_low?.toLocaleString()} — ${item.price_high?.toLocaleString()}
                </p>
                <div style={styles.historyMeta}>
                  <span style={styles.historyCategory}>{item.category}</span>
                  <span style={styles.historyDate}>
                    {new Date(item.created_at).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* --- Pagination --- */}
      {totalPages > 1 && (
        <div style={styles.pagination}>
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            style={{ ...styles.pageBtn, opacity: page <= 1 ? 0.4 : 1 }}>← Prev</button>
          <span style={styles.pageInfo}>Page {page} of {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
            style={{ ...styles.pageBtn, opacity: page >= totalPages ? 0.4 : 1 }}>Next →</button>
        </div>
      )}
    </>
  );
}

/* ============================================================================
 * LISTING DRAFT SECTION
 * ========================================================================= */

function GoodDealChecker({ appraisal }) {
  const [offerPrice, setOfferPrice] = useState("");
  const verdict = (() => {
    const price = parseFloat(offerPrice);
    if (!price || price <= 0) return null;

    const best = appraisal.best_platform?.toLowerCase();
    const range = appraisal.platform_prices?.[best];
    if (!range) return null;

    const { low, high } = range;
    if (price < low * 0.75) return { label: "Steal 🔥", sub: `Well below the $${low}–$${high} range on ${best}`, bg: "#f0fdf4", border: "#bbf7d0", color: "#166534" };
    if (price < low)        return { label: "Good Deal ✅", sub: `Below the $${low}–$${high} range on ${best}`, bg: "#f0fdf4", border: "#bbf7d0", color: "#166534" };
    if (price <= high)      return { label: "Fair Price 👍", sub: `Within the $${low}–$${high} range on ${best}`, bg: "#fff1f2", border: "#fbcfe8", color: "#9f1239" };
    if (price <= high * 1.2)return { label: "Slightly High ⚠️", sub: `A bit above the $${low}–$${high} range on ${best}`, bg: "#fff7ed", border: "#fed7aa", color: "#9a3412" };
    return                         { label: "Overpriced ❌", sub: `Significantly above the $${low}–$${high} range on ${best}`, bg: "#fff1f2", border: "#fecdd3", color: "#9f1239" };
  })();

  return (
    <div style={styles.dealSection}>
      <h3 style={styles.sectionTitle}>Is It a Good Deal?</h3>
      <div style={styles.dealInputRow}>
        <span style={styles.dealDollar}>$</span>
        <input
          type="number"
          min="0"
          placeholder="Enter asking price"
          value={offerPrice}
          onChange={e => setOfferPrice(e.target.value)}
          style={styles.dealInput}
        />
      </div>
      {verdict && (
        <div style={{ background: verdict.bg, border: `1px solid ${verdict.border}`, borderRadius: 10, padding: "12px 14px", marginTop: 10 }}>
          <p style={{ margin: "0 0 3px", fontWeight: 800, fontSize: 15, color: verdict.color }}>{verdict.label}</p>
          <p style={{ margin: 0, fontSize: 12, color: verdict.color }}>{verdict.sub}</p>
        </div>
      )}
    </div>
  );
}

function ListingDraftSection({ appraisal }) {
  const [activePlatform, setActivePlatform] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const platforms = [
    { key: "ebay",    label: "eBay" },
    { key: "grailed", label: "Grailed" },
    { key: "depop",   label: "Depop" },
  ];

  async function generate(platform) {
    setActivePlatform(platform);
    setDraft(null);
    setError(null);
    setCopied(false);
    setLoading(true);
    try {
      const pp = appraisal.platform_prices?.[platform];
      const res = await fetch(`${API_BASE}/api/listing-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          identified_item: appraisal.identified_item || {},
          condition_assessment: appraisal.condition_assessment || "",
          price_range: pp ? { low: pp.low, high: pp.high } : {},
        }),
      });
      if (!res.ok) throw new Error("Generation failed");
      setDraft(await res.json());
    } catch (e) {
      setError("Couldn't generate listing. Try again.");
    } finally {
      setLoading(false);
    }
  }

  function copyAll() {
    if (!draft) return;
    navigator.clipboard.writeText(`${draft.title}\n\n${draft.description}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div style={styles.listingSection}>
      <h3 style={styles.sectionTitle}>Generate Listing</h3>
      <div style={styles.platformBtnRow}>
        {platforms.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => generate(key)}
            disabled={loading}
            style={{
              ...styles.platformBtn,
              ...(activePlatform === key ? styles.platformBtnActive : {}),
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && <p style={styles.listingLoading}>Writing your listing…</p>}
      {error && <p style={styles.listingError}>{error}</p>}

      {draft && !loading && (
        <div style={styles.draftBox}>
          <div style={styles.draftField}>
            <p style={styles.draftLabel}>Title</p>
            <p style={styles.draftTitle}>{draft.title}</p>
          </div>
          <div style={styles.draftField}>
            <p style={styles.draftLabel}>Description</p>
            <p style={styles.draftDescription}>{draft.description}</p>
          </div>
          <button onClick={copyAll} style={styles.copyBtn}>
            {copied ? "✓ Copied!" : "Copy to clipboard"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * STYLES
 * ========================================================================= */

const styles = {
  page: {
    fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
    color: "#1a1a1a",
    minHeight: "100vh",
    background: "linear-gradient(180deg, #fdf4f5 0%, #f9ecef 100%)",
  },

  /* --- Nav --- */
  nav: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "0 32px", height: 60,
    background: "linear-gradient(135deg, #e11d48, #db2777)",
    position: "sticky", top: 0, zIndex: 10,
    boxShadow: "0 2px 16px rgba(225,29,72,0.3)",
  },
  navBrand: {
    display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
  },
  navLogo: {
    width: 36, height: 36, borderRadius: 10,
    background: "rgba(255,255,255,0.25)",
    color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 18, fontWeight: 800,
  },
  navTitle: { fontSize: 18, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" },
  navBtn: {
    padding: "7px 16px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.4)",
    background: "transparent", fontSize: 13, fontWeight: 600, color: "#fff", cursor: "pointer",
  },
  navBtnActive: { background: "rgba(255,255,255,0.25)", color: "#fff", borderColor: "rgba(255,255,255,0.6)" },

  main: { maxWidth: 900, margin: "0 auto", padding: "40px 24px 80px" },

  /* --- Form Screen --- */
  formScreen: { animation: "fadeIn 0.3s ease" },
  formHero: { textAlign: "center", marginBottom: 36 },
  formHeroTitle: { margin: "0 0 8px", fontSize: 36, fontWeight: 800, color: "#292524", letterSpacing: "-0.03em" },
  formHeroSub: { margin: 0, fontSize: 16, color: "#78716c" },
  formLayout: { display: "flex", gap: 28, alignItems: "flex-start", flexWrap: "wrap" },
  formLeft: { flex: "0 0 320px", minWidth: 260 },
  formRight: { flex: 1, minWidth: 260 },

  /* --- Loading Screen --- */
  loadingScreen: {
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    minHeight: "60vh", gap: 16, animation: "fadeIn 0.3s ease",
  },
  pulseIcon: { animation: "pulse 1.6s ease-in-out infinite" },
  pulseIconInner: {
    width: 80, height: 80, borderRadius: 22,
    background: "linear-gradient(135deg, #e11d48, #db2777)",
    color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 36, fontWeight: 900,
    boxShadow: "0 8px 30px rgba(225,29,72,0.4)",
  },
  loadingTitle: { margin: 0, fontSize: 22, fontWeight: 700, color: "#292524" },
  loadingMsg: { margin: 0, fontSize: 15, color: "#78716c", minHeight: 24 },

  /* --- Results Screen --- */
  resultsScreen: { animation: "fadeIn 0.3s ease", maxWidth: 620, margin: "0 auto" },
  resetRow: { textAlign: "center", marginTop: 24 },
  anotherBtn: {
    padding: "14px 32px", borderRadius: 12, border: "none",
    background: "linear-gradient(135deg, #e11d48, #db2777)",
    color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer",
    boxShadow: "0 4px 14px rgba(225,29,72,0.3)",
  },

  /* Legacy / kept from old layout */
  header: { display: "flex", alignItems: "center", gap: 14, marginBottom: 20 },
  logoMark: {
    width: 44, height: 44, borderRadius: 12,
    background: "linear-gradient(135deg, #e11d48, #db2777)",
    color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 22, fontWeight: 800,
  },
  title: { margin: 0, fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em", color: "#292524" },
  subtitle: { margin: 0, fontSize: 13, color: "#78716c", fontWeight: 500 },

  /* --- Tabs (kept for history) --- */
  tabBar: {
    display: "flex", gap: 4, marginBottom: 18,
    background: "#e7e0d8", borderRadius: 12, padding: 4,
  },
  tab: {
    flex: 1, padding: "10px 16px", border: "none", borderRadius: 10,
    fontSize: 14, fontWeight: 600, cursor: "pointer",
    background: "transparent", color: "#78716c",
    transition: "all 0.15s",
  },
  tabActive: {
    background: "#ffffff", color: "#292524",
    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  },

  /* --- Cards --- */
  card: {
    background: "#ffffff", borderRadius: 20, padding: "28px 26px",
    marginBottom: 18, border: "1px solid rgba(0,0,0,0.07)",
    boxShadow: "0 2px 16px rgba(0,0,0,0.06), 0 1px 4px rgba(0,0,0,0.04)",
  },
  cardTitle: { margin: "0 0 6px", fontSize: 18, fontWeight: 800, color: "#1c1917", letterSpacing: "-0.02em" },
  cardHint: { margin: "0 0 16px", fontSize: 13, color: "#a8a29e" },

  /* --- Result image --- */
  resultImage: {
    width: "100%", maxHeight: 340, objectFit: "cover", display: "block",
    borderRadius: 14, marginBottom: 20,
    boxShadow: "0 4px 20px rgba(0,0,0,0.1)",
  },

  /* --- Upload --- */
  dropZone: {
    border: "2px dashed #d6cfc7", borderRadius: 16, padding: "48px 24px",
    textAlign: "center", cursor: "pointer", transition: "all 0.2s", background: "#fdfcfa",
    minHeight: 260, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
  },
  dropZoneActive: { borderColor: "#e11d48", background: "#fff1f2", transform: "scale(1.01)" },
  dropIcon: { fontSize: 40, marginBottom: 10 },
  dropText: { margin: "0 0 6px", fontSize: 15, color: "#57534e", fontWeight: 500 },
  dropLink: { color: "#e11d48", fontWeight: 700, textDecoration: "none" },
  dropMeta: { margin: 0, fontSize: 12, color: "#a8a29e" },
  previewContainer: {
    position: "relative", borderRadius: 16, overflow: "hidden",
    border: "1px solid #e7e0d8", minHeight: 260,
    boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
  },
  previewImage: { width: "100%", height: 300, objectFit: "cover", display: "block" },
  removeBtn: {
    position: "absolute", top: 10, right: 10,
    background: "rgba(0,0,0,0.7)", color: "#fff", border: "none",
    borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600,
    backdropFilter: "blur(4px)",
  },

  /* --- Form --- */
  formRow: { display: "flex", gap: 14, marginBottom: 14, flexWrap: "wrap" },
  formGroup: { flex: "1 1 200px", marginBottom: 4 },
  label: {
    display: "block", fontSize: 11, fontWeight: 700, color: "#a8a29e",
    marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em",
  },
  select: {
    width: "100%", padding: "11px 14px", borderRadius: 10,
    border: "1px solid #e2dbd3", fontSize: 14, background: "#faf8f5",
    color: "#1c1917", outline: "none", boxSizing: "border-box",
    boxShadow: "inset 0 1px 3px rgba(0,0,0,0.04)",
  },
  input: {
    width: "100%", padding: "11px 14px", borderRadius: 10,
    border: "1px solid #e2dbd3", fontSize: 14, background: "#faf8f5",
    color: "#1c1917", outline: "none", boxSizing: "border-box",
    boxShadow: "inset 0 1px 3px rgba(0,0,0,0.04)",
  },
  textarea: {
    width: "100%", padding: "11px 14px", borderRadius: 10,
    border: "1px solid #e2dbd3", fontSize: 14, background: "#faf8f5",
    color: "#1c1917", outline: "none", resize: "vertical",
    fontFamily: "inherit", boxSizing: "border-box",
    boxShadow: "inset 0 1px 3px rgba(0,0,0,0.04)",
  },

  /* --- Actions --- */
  error: {
    background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b",
    borderRadius: 12, padding: "12px 16px", fontSize: 13, marginBottom: 14,
  },
  actions: { display: "flex", gap: 10, marginBottom: 16 },
  submitBtn: {
    width: "100%", padding: "15px 20px", marginTop: 8,
    background: "linear-gradient(135deg, #e11d48, #db2777)",
    color: "#fff", border: "none", borderRadius: 12, fontSize: 15,
    fontWeight: 800, cursor: "pointer", letterSpacing: "0.01em",
    boxShadow: "0 4px 16px rgba(225,29,72,0.35)", transition: "opacity 0.15s, transform 0.15s",
  },
  submitBtnDisabled: { opacity: 0.45, cursor: "not-allowed", boxShadow: "none", transform: "none" },
  resetBtn: {
    padding: "14px 20px", background: "transparent", color: "#78716c",
    border: "1px solid #d6cfc7", borderRadius: 11, fontSize: 14, fontWeight: 600, cursor: "pointer",
  },

  /* --- Loading --- */
  skeleton: { padding: "8px 0" },
  skeletonLine: {
    height: 14, background: "linear-gradient(90deg, #ede9e3 25%, #f5f1ec 50%, #ede9e3 75%)",
    backgroundSize: "200% 100%", borderRadius: 6, marginBottom: 10,
  },
  loadingText: { textAlign: "center", fontSize: 13, color: "#a8a29e", marginTop: 12 },

  /* --- Results --- */
  savedBadge: {
    background: "#d1fae5", color: "#065f46", fontSize: 12, fontWeight: 700,
    padding: "6px 14px", borderRadius: 20, marginBottom: 16, display: "inline-block",
    letterSpacing: "0.02em",
  },
  rejectionBox: {
    background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 10,
    padding: "14px 16px", marginBottom: 14,
  },
  rejectionTitle: { margin: "0 0 6px", fontWeight: 700, color: "#9a3412", fontSize: 14 },
  rejectionText: { margin: 0, color: "#c2410c", fontSize: 13 },
  itemIdBox: { marginBottom: 18, paddingBottom: 16, borderBottom: "1px solid #f0ebe3" },
  itemBrand: { margin: 0, fontSize: 24, fontWeight: 900, color: "#1c1917", letterSpacing: "-0.03em" },
  itemModel: { margin: "4px 0 0", fontSize: 15, color: "#57534e", fontWeight: 500 },
  itemEra: { margin: "6px 0 0", fontSize: 12, color: "#a8a29e", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" },
  priceBox: {
    background: "linear-gradient(135deg, #fff1f2 0%, #fce7f3 100%)", borderRadius: 16,
    padding: "20px 22px", marginBottom: 16, border: "1px solid #fbcfe8",
    boxShadow: "0 2px 12px rgba(225,29,72,0.1)",
  },
  priceLabel: {
    margin: "0 0 4px", fontSize: 12, fontWeight: 600,
    textTransform: "uppercase", letterSpacing: "0.06em", color: "#9f1239",
  },
  priceRange: { margin: 0, fontSize: 32, fontWeight: 800, color: "#881337", letterSpacing: "-0.02em" },
  pricePlatform: { margin: "6px 0 0", fontSize: 13, color: "#be123c", fontWeight: 500 },
  platformPriceList: { display: "flex", flexDirection: "column", gap: 6, marginTop: 6 },
  platformRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "8px 12px", borderRadius: 8, background: "rgba(255,255,255,0.5)",
    border: "1px solid #fbcfe8",
  },
  platformRowBest: { background: "#fdf2f8", border: "1px solid #f43f5e" },
  platformName: { fontSize: 13, fontWeight: 600, color: "#9f1239" },
  platformRange: { fontSize: 15, fontWeight: 700, color: "#881337" },
  bestBadge: { color: "#be123c", fontWeight: 700, fontSize: 12 },
  confidenceBadge: {
    padding: "10px 14px", borderRadius: 10, fontSize: 13,
    marginBottom: 14, border: "1px solid", lineHeight: 1.5,
  },
  section: { marginBottom: 14 },
  sectionTitle: {
    margin: "0 0 6px", fontSize: 13, fontWeight: 700,
    textTransform: "uppercase", letterSpacing: "0.04em", color: "#78716c",
  },
  sectionText: { margin: 0, fontSize: 14, color: "#44403c", lineHeight: 1.6 },
  comparable: { margin: "0 0 4px", fontSize: 13, color: "#57534e", lineHeight: 1.5 },

  /* --- Pricing Factors --- */
  factorsList: { display: "flex", flexDirection: "column", gap: 6 },
  factorRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    gap: 10, padding: "8px 10px", background: "#fdfcfa",
    border: "1px solid #f0ebe3", borderRadius: 8,
  },
  factorText: { fontSize: 13, color: "#44403c", lineHeight: 1.4, flex: 1 },
  factorImpact: {
    fontSize: 12, fontWeight: 700, padding: "3px 8px",
    borderRadius: 6, whiteSpace: "nowrap",
    fontFamily: "'DM Mono', monospace",
  },
  tipBox: {
    background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "12px 14px",
  },
  tipLabel: { margin: "0 0 4px", fontSize: 13, fontWeight: 700, color: "#166534" },
  tipText: { margin: 0, fontSize: 13, color: "#15803d", lineHeight: 1.5 },

  /* --- Listing Draft --- */
  dealSection: { marginTop: 14, marginBottom: 14 },
  dealInputRow: { display: "flex", alignItems: "center", gap: 6, marginTop: 8 },
  dealDollar: { fontSize: 18, fontWeight: 700, color: "#57534e" },
  dealInput: {
    flex: 1, padding: "9px 12px", borderRadius: 8, border: "1px solid #e7e5e4",
    fontSize: 15, fontWeight: 600, color: "#292524", outline: "none",
    background: "#fff",
  },
  listingSection: { marginTop: 14 },
  platformBtnRow: { display: "flex", gap: 8, marginTop: 8, marginBottom: 10 },
  platformBtn: {
    flex: 1, padding: "8px 0", borderRadius: 8, border: "1px solid #e7e5e4",
    background: "#fff", fontSize: 13, fontWeight: 600, color: "#57534e", cursor: "pointer",
  },
  platformBtnActive: { background: "#292524", color: "#fff", borderColor: "#292524" },
  listingLoading: { fontSize: 13, color: "#78716c", margin: "4px 0" },
  listingError: { fontSize: 13, color: "#dc2626", margin: "4px 0" },
  draftBox: {
    background: "#fafaf9", border: "1px solid #e7e5e4", borderRadius: 10, padding: "14px 16px",
  },
  draftField: { marginBottom: 12 },
  draftLabel: { margin: "0 0 4px", fontSize: 11, fontWeight: 700, color: "#a8a29e", textTransform: "uppercase", letterSpacing: "0.05em" },
  draftTitle: { margin: 0, fontSize: 14, fontWeight: 700, color: "#292524" },
  draftDescription: { margin: 0, fontSize: 13, color: "#57534e", lineHeight: 1.6 },
  copyBtn: {
    marginTop: 4, padding: "7px 14px", borderRadius: 7, border: "1px solid #e7e5e4",
    background: "#fff", fontSize: 12, fontWeight: 600, color: "#57534e", cursor: "pointer",
  },

  /* --- Stats Bar --- */
  statsBar: {
    display: "flex", gap: 8, marginBottom: 16,
  },
  statItem: {
    flex: 1, background: "#fff", borderRadius: 12, padding: "14px 12px",
    textAlign: "center", border: "1px solid #e7e0d8",
    display: "flex", flexDirection: "column", gap: 2,
  },
  statValue: { fontSize: 16, fontWeight: 800, color: "#292524" },
  statLabel: { fontSize: 11, color: "#a8a29e", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em" },

  /* --- Filter Bar --- */
  filterBar: { display: "flex", gap: 8, marginBottom: 16 },

  /* --- History Grid --- */
  historyGrid: {
    display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16,
  },
  historyCard: {
    background: "#fff", borderRadius: 12, overflow: "hidden",
    border: "1px solid #e7e0d8", boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    cursor: "pointer", transition: "box-shadow 0.15s",
  },
  historyThumb: {
    width: "100%", height: 120, objectFit: "cover", display: "block",
    borderBottom: "1px solid #f0ebe3",
  },
  historyThumbPlaceholder: {
    width: "100%", height: 120, display: "flex", alignItems: "center",
    justifyContent: "center", background: "#faf7f2", fontSize: 28,
    borderBottom: "1px solid #f0ebe3",
  },
  historyContent: { padding: "10px 12px" },
  historyBrand: { margin: 0, fontSize: 13, fontWeight: 700, color: "#292524", lineHeight: 1.4 },
  historyPrice: { margin: "4px 0", fontSize: 15, fontWeight: 800, color: "#881337" },
  historyMeta: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  historyCategory: {
    fontSize: 10, fontWeight: 600, color: "#fff", textTransform: "uppercase",
    letterSpacing: "0.04em", background: "linear-gradient(135deg, #e11d48, #db2777)",
    padding: "2px 8px", borderRadius: 4,
  },
  historyDate: { fontSize: 11, color: "#a8a29e" },

  /* --- Pagination --- */
  pagination: {
    display: "flex", justifyContent: "center", alignItems: "center", gap: 16, marginBottom: 16,
  },
  pageBtn: {
    padding: "8px 16px", background: "#fff", border: "1px solid #d6cfc7",
    borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#44403c",
  },
  pageInfo: { fontSize: 13, color: "#78716c" },

  /* --- Footer --- */
  footer: {
    textAlign: "center", fontSize: 11, color: "#a8a29e", marginTop: 8,
    lineHeight: 1.5, padding: "0 12px",
  },
};
