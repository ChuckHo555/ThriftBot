# ThriftBot — Resume & Project Review

---

## Resume Bullet Points

- **Built ThriftBot**, a full-stack AI resale price estimator using React (Vite), FastAPI, and Claude's vision API — analyzes clothing and sneaker photos to return platform-specific price ranges across eBay, Grailed, and Depop with condition-aware confidence scoring
- **Engineered a multi-modal AI pipeline** that preprocesses uploaded images (including HEIC/iPhone format) via Pillow, encodes them as base64, and sends them to Claude Sonnet for structured JSON appraisals with retry logic for malformed responses
- **Designed an on-demand listing draft generator** that produces platform-tailored titles and descriptions for eBay, Grailed, and Depop using prompt-engineered AI calls — triggered per user selection with one-click clipboard copy
- **Integrated Supabase** for image storage and appraisal history persistence, with graceful degradation fallback so users always receive their appraisal even on database failure

---

## Project Review

### What is ThriftBot?

ThriftBot is an AI-powered resale price estimator built for people who buy and sell secondhand clothing and sneakers. You upload a photo of an item, fill in a few details — category, condition, brand if you know it — and the app uses Claude's vision API to identify what the item is, assess its condition, and return price ranges specific to eBay, Grailed, and Depop. It also flags potential authenticity concerns, checks whether a price you've been offered is a good deal, and generates ready-to-post listing drafts for whichever platform you want to sell on.

### How does it work?

The frontend is a React app built with Vite. When you submit a photo, it converts the image to base64, sends it to the FastAPI backend, and transitions to a loading screen with rotating status messages. The backend preprocesses the image — resizing it and re-encoding it to keep payloads small and consistent — then sends it alongside the item metadata to Claude Sonnet via the Anthropic API. Claude returns a structured JSON response with platform prices, pricing factors, confidence level, and an authenticity check. That response gets stored in Supabase (both the image in object storage and the appraisal data in the database), then returned to the frontend for display. The results screen shows the item photo, price ranges by platform, a good deal calculator, and on-demand listing draft generation per platform. Users can view their full appraisal history in a separate tab.

### Challenges I ran into

The hardest problem early on was JSON reliability from the AI. Claude's responses occasionally came back with trailing commas or minor formatting issues, which crashed the JSON parser and surfaced as errors to the user. I solved this with a retry mechanism that feeds the partial response back with a prefilled `{` to nudge the model into completing a valid JSON object.

HEIC support was also trickier than expected. iPhones save photos as HEIC by default, and browsers don't populate `file.type` consistently for that format — sometimes it comes back as an empty string. I handled this with an extension-based fallback on the frontend, and used `pillow-heif` on the backend to convert HEIC files transparently before processing.

The UI went through two major overhauls. The original single-page form worked but felt static. I rebuilt it as a three-screen flow — form, loading animation, results — so the app feels more intentional and the loading state actually communicates that work is happening, which matters when an API call takes 5–10 seconds.

Structurally, I also learned the value of defensive Pydantic models the hard way. When I added the `platform_prices` field to the AI response, the `store_appraisal` function was still referencing the old `price_estimate.low` field — which didn't exist anymore. That kind of silent field rename breaks things in ways that are hard to trace. Now every model field is Optional with explicit fallbacks.

### What am I most proud of?

Honestly, the listing draft feature. It's the kind of thing that actually saves someone time in a real workflow — not just "here's your price estimate," but "here's a ready-to-paste eBay title and description you can post right now." The prompt engineering to make each platform feel different — Grailed descriptions lean into brand storytelling, Depop ones are casual and punchy, eBay ones are keyword-dense and structured — is something I'm genuinely happy with.

I'm also proud of how the app degrades gracefully. If the database write fails, the user still gets their appraisal. If the image preprocessing fails, the original image still goes through. If Claude returns slightly malformed JSON, the retry catches it. The app almost never surfaces an error to the user even when things go wrong behind the scenes — and that's a design choice I'm glad I made early.

### What would I build next?

eBay Marketplace API integration is the biggest pending feature — it would let ThriftBot pull real-time sold listing data to ground the AI's estimates in actual recent transactions rather than training knowledge alone. I also want to add a batch upload mode for people flipping multiple items at once, and a price trend tracker that resurfaces old appraisals when market prices shift significantly.

---

*ThriftBot — React · FastAPI · Claude Vision API · Supabase · Python 3.12*
