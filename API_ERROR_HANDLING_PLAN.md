# API Error Handling — Implementation Plan

Every external call in Argus can fail: Gemini API, Elasticsearch, Evolution PostgreSQL, context checks, and Chrome extension messaging. Currently, error handling is inconsistent — some modules catch and return defaults, others let exceptions propagate and crash the request. No call has a timeout, so a hanging API can block the entire server.

This plan adds **consistent try-catch blocks, request timeouts, retry logic, and structured error logging** across all five layers.

> [!IMPORTANT]
> **Risk mitigations built into this plan:**
> - Elastic write failures log to a **dead-letter file** instead of silently dropping data
> - Gemini retry budget is capped at **1 retry with 15s timeout** (max 45s per call, not 90s)
> - `DEBUG_ERRORS=true` env var re-throws caught errors in development so bugs aren't masked

---

## Current State Audit

| Layer | try-catch? | Timeout? | Retry? | What happens on failure |
|:---|:---|:---|:---|:---|
| **Gemini API** (`gemini.ts`) | Partial — response errors caught, network errors not | ❌ None | ❌ | Throws → crashes webhook handler |
| **Elasticsearch** (`elastic.ts`) | Partial — search ops have some, writes have none | ❌ None | ❌ | Throws → crashes route handler |
| **Evolution PG** (`evolution-db.ts`) | ✅ All queries wrapped | ✅ 5s connection timeout | ❌ | Returns empty arrays/defaults (good!) |
| **Context checks** (`background.js`) | ✅ Outer catch | ❌ None | ❌ | Silently fails (acceptable) |
| **Chrome messaging** (`background.js`) | ✅ On `trySendToTab` | N/A | ✅ Fallback inject + retry | Returns false on failure (good) |

> [!WARNING]
> **`callGemini()` has no abort timeout.** If the Gemini API hangs (accepts connection but never responds), the entire webhook processing pipeline stalls indefinitely. This is the most critical gap.

---

## Proposed Changes

### New Utility Module

#### [NEW] [errors.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/errors.ts)

Centralized error handling utilities reused across all modules.

**`fetchWithTimeout(url, options, timeoutMs): Promise<Response>`**
- Wraps `fetch()` with `AbortController` + `setTimeout`
- Throws `TimeoutError` if request exceeds `timeoutMs`
- Cleans up abort controller on success

**`withRetry<T>(fn, options): Promise<T>`**
- Retries async function up to `maxRetries` times (default: **1**, not 2 — prevents retry stacking)
- Exponential backoff: 500ms → 1000ms
- Retry timeout reduced to **15s** (vs 30s first attempt) to cap total budget at 45s
- Only retries on network/timeout errors, NOT on 4xx client errors
- Configurable `shouldRetry(error): boolean` predicate

**`safeAsync<T>(fn, fallback, context): Promise<T>`**
- Generic try-catch wrapper that logs the error with `context` string and returns `fallback` value
- Used to wrap database operations that should never crash the caller
- **Debug mode**: if `DEBUG_ERRORS=true`, re-throws the error instead of returning fallback (so real bugs surface during development)

**`logDeadLetter(operation, data, error): void`**
- Appends failed write operations to `data/dead-letter.jsonl` (one JSON object per line)
- Each entry: `{ timestamp, operation, data, error: message, stack }`
- Enables recovery: a future `reprocessDeadLetters()` can replay failed writes
- File auto-rotates when > 10MB

**Custom error classes:**
```typescript
class TimeoutError extends Error { }
class GeminiApiError extends Error { status: number; retryable: boolean; }
class ElasticError extends Error { operation: string; index: string; }
```

---

### Layer 1: Gemini API (`gemini.ts`)

#### [MODIFY] [gemini.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/gemini.ts)

**`callGemini()` changes:**
- Add **30-second timeout** on first attempt via `fetchWithTimeout()` + `AbortController`
- Wrap in `withRetry()` — **1 retry only** with **15-second timeout** on retry (total budget: 45s max)
- On 429: respect `Retry-After` header if present, skip retry if `Retry-After > 10s`
- Classify errors: `4xx` → non-retryable `GeminiApiError`, `5xx/timeout` → retryable
- Log structured error: `⚠️ [GEMINI] timeout after 30s on analyzeMessage`

**Each exported function (`analyzeMessage`, `detectAction`, `validateRelevance`, `chatWithContext`, `generatePopupBlueprint`):**
- Already wrapped with `withFallback()` from the AI tier system — no additional changes needed, the tier system handles Gemini failures by falling back to Tier 2/3

---

### Layer 2: Elasticsearch (`elastic.ts`)

#### [MODIFY] [elastic.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/elastic.ts)

**Write operations — `safeAsync()` + dead-letter logging:**

Failed writes are **not silently dropped**. Instead, the original payload is logged to `data/dead-letter.jsonl` so it can be recovered.

- `insertEvent()` — wrap with `safeAsync()`, log to dead-letter, return `-1`
- `insertMessage()` — wrap with `safeAsync()`, log to dead-letter, return `false`
- `insertTrigger()` — wrap with `safeAsync()`, log to dead-letter, return `-1`
- `updateEvent()` — wrap with `safeAsync()`, log to dead-letter, return `false`
- `updateEventStatus()` — wrap with `safeAsync()`, log and continue
- `deleteEvent()` — wrap with `safeAsync()`, return `false`

**Search operations (partially protected):**
- `searchEventsByKeywords()`, `searchEventsByLocation()` — already have catches but inconsistent; standardize to log + return `[]`
- `hybridSearchEvents()` — add try-catch returning `[]`

**Example pattern:**
```typescript
export async function insertEvent(event): Promise<number> {
  return safeAsync(
    async () => { /* existing code */ },
    -1,
    'insertEvent',
    { deadLetter: true, payload: event }  // logs to dead-letter file on failure
  );
}
```

---

### Layer 3: Evolution PostgreSQL (`evolution-db.ts`)

#### [MODIFY] [evolution-db.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/evolution-db.ts)

Already well-protected. Minor improvements:
- Add **query timeout** (`statement_timeout = 10000`) to pool config options
- Add structured error logging with function name context

---

### Layer 4: Server Routes (`server.ts`)

#### [MODIFY] [server.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/server.ts)

**Webhook handler (`POST /api/webhook/whatsapp`):**
- Already has outer try-catch returning 500
- Add timeout for the entire webhook processing: if `processWebhook()` takes >45 seconds, respond with `202 Accepted` and continue processing in background
- Add specific error type logging: `[WEBHOOK] Gemini timeout`, `[WEBHOOK] Elastic write failed`, etc.

**AI Chat (`POST /api/chat`):**
- Already has try-catch — add a **30s timeout** on `chatWithContext()` call
- On timeout, return: `"I'm taking too long to think. Try asking again!"`

**Context check (`POST /api/context-check`):**
- Already has try-catch — add timeout on `matchContext()` call (15s)

**General pattern for all route handlers:**
- Ensure every route has a try-catch that returns the appropriate HTTP status (400/404/500)
- Never leak internal error details to the client (log full error server-side, return generic message to client)

---

### Layer 5: Chrome Extension

#### [MODIFY] [background.js](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/extension/background.js)

**Add `fetchWithTimeout` utility** (JS version, with AbortController feature check for MV3 safety):
```javascript
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  // AbortController is supported in Chrome 95+ but check defensively for MV3
  if (typeof AbortController === 'undefined') return fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally { clearTimeout(timer); }
}
```

**Apply to ALL `fetch()` calls in message handlers:**
- `SET_REMINDER`, `SNOOZE_EVENT`, `IGNORE_EVENT`, etc. — 10s timeout each
- `checkCurrentUrl()` context check — 8s timeout
- `fetchAndShowDiscoveredEvents()` — 10s timeout

**Add user-friendly error responses:**
- On timeout: return `{ error: 'Server not responding', timeout: true }`
- On network error: return `{ error: 'Cannot reach Argus server', offline: true }`

#### [MODIFY] [content.js](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/extension/content.js)

- Wrap popup rendering functions in try-catch to prevent DOM errors from breaking the page
- On render error: show a minimal fallback popup with event title and basic actions

---

## Files Changed Summary

| File | Action | Purpose |
|:---|:---|:---|
| `errors.ts` | **NEW** | `fetchWithTimeout`, `withRetry`, `safeAsync`, `logDeadLetter`, custom error classes |
| `gemini.ts` | MODIFY | 30s timeout + 1 retry (15s) on `callGemini()` |
| `elastic.ts` | MODIFY | Wrap all write operations with `safeAsync()` + dead-letter logging |
| `evolution-db.ts` | MODIFY | Add query `statement_timeout` |
| `server.ts` | MODIFY | Route-level timeouts, consistent error responses |
| `background.js` | MODIFY | Add `fetchWithTimeout` (with AbortController check) to all API calls |
| `content.js` | MODIFY | Try-catch around popup rendering |
| `.env` | MODIFY | Add `DEBUG_ERRORS=false` |

---

## Verification Plan

### Automated
```bash
cd d:\Elastic\whatsapp-chat-rmd-argus\argus && npx tsc --noEmit
```

### Manual

1. **Gemini timeout** — Set `GEMINI_API_URL` to a slow/non-responding endpoint → verify 30s timeout fires, error logged, Tier 2 fallback activates

2. **Gemini retry** — Monitor logs during a 429 rate limit → verify retry with backoff, then fallback

3. **Elastic write failure** — Temporarily break `ELASTIC_API_KEY` → send webhook message → verify `insertEvent` returns `-1`, error logged, **entry written to `data/dead-letter.jsonl`**, server doesn't crash

4. **Dead-letter recovery** — After restoring API key, verify dead-letter entries contain enough data to replay

5. **Extension timeout** — Stop the Argus server → click buttons in popup → verify "Server not responding" error within 10s, not hanging

6. **Webhook timeout** — Simulate slow Gemini (>45s total) → verify webhook returns 202 without blocking

7. **Debug mode** — Set `DEBUG_ERRORS=true` → break Elastic → verify errors are thrown (not swallowed) so bugs surface during development
