# Argus — Proactive Memory Assistant v2.7.0

AI-powered WhatsApp assistant that learns from your conversations, detects events, and reminds you at the right moment — while you browse. Refer argus/ARCH.md for detailed architecture.

## Quick Start

### Docker (Recommended — works on Linux / Windows / macOS)

```bash
git clone https://github.com/nityam2007/argus-whatsapp-assistant.git
cd argus-whatsapp-assistant/argus
cp .env.example .env          # Fill in GEMINI_API_KEY + Elasticsearch credentials
docker compose up -d           # Starts 4 containers (builds everything from source)
docker compose logs -f argus   # View Argus logs
```

> **Everything is included** — Evolution API source, QuickSave, and Argus are all in this repo. No extra downloads needed.

### Local Development

```bash
cd argus
npm install
cp .env.example .env           # Fill in GEMINI_API_KEY + Elasticsearch credentials
npm run dev                    # Hot-reload dev server on :3000
```

## Docker Architecture

```
┌─────────────────────────────────────────────────────┐
│                  docker compose                      │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ postgres │←─│ evolution-api │←─│    argus      │  │
│  │ :5432    │  │ :8080         │  │ :3000         │  │
│  └──────────┘  └──────────────┘  └───────┬───────┘  │
│  ┌──────────┐        ↑                   │          │
│  │  redis   │────────┘                   │ WS+HTTP  │
│  │ :6379    │                            │          │
│  └──────────┘                            ▼          │
│                               Chrome Extension      │
└─────────────────────────────────────────────────────┘
```

| Container | Image | Purpose |
|-----------|-------|---------|
| `argus-server` | Built from `./Dockerfile` | Express server, Gemini AI, Elasticsearch, WebSocket |
| `argus-evolution` | Built from `../evolution-api/Dockerfile` | WhatsApp bridge (Evolution API v2.3) |
| `argus-postgres` | `postgres:16-alpine` | Evolution API database |
| `argus-redis` | `redis:7-alpine` | Evolution API cache |

### Docker Commands

```bash
docker compose up -d               # Start all 4 containers
docker compose up -d --build       # Rebuild + start
docker compose logs -f argus       # Argus logs
docker compose logs -f evolution-api # Evolution logs
docker compose down                # Stop
docker compose down -v             # Stop + delete all data
docker compose ps                  # Status
```

## Project Structure

```
argus-whatsapp-assistant/           # ← Clone this repo
├── argus/                          # Main application
│   ├── src/
│   │   ├── server.ts               # Express + WebSocket server, all API routes
│   │   ├── elastic.ts              # Elasticsearch — all DB operations, hybrid search
│   │   ├── gemini.ts               # Gemini AI — extraction, popup blueprints, chat
│   │   ├── mcp-client.ts           # Elastic Agent Builder MCP — JSON-RPC 2.0 client, agentic chat
│   │   ├── ingestion.ts            # WhatsApp message processing pipeline
│   │   ├── ai-tier.ts              # AI fallback tier manager (Tier 1/2/3)
│   │   ├── fallback-heuristics.ts  # Tier 2 — regex/pattern replacements for Gemini
│   │   ├── response-cache.ts       # Tier 3 — LRU response cache
│   │   ├── embeddings.ts           # Gemini embedding generation (768-dim)
│   │   ├── backup.ts               # Export/import/prune backup logic
│   │   ├── quicksave.ts            # QuickSave CEP v9.1 — context compression
│   │   ├── matcher.ts              # URL pattern matching for context triggers
│   │   ├── scheduler.ts            # Time-based reminders + snooze + daily backup
│   │   ├── evolution-db.ts         # Direct PostgreSQL read for message history
│   │   ├── errors.ts               # Typed error classes
│   │   └── types.ts                # Zod schemas + config parser
│   ├── extension/                  # Chrome Extension (Manifest V3)
│   │   ├── manifest.json           # <all_urls> content scripts
│   │   ├── background.js           # WebSocket, API calls, context checks
│   │   ├── content.js              # Popup overlays (8 types), DOM form watcher
│   │   ├── sidepanel.html/js       # AI Chat sidebar
│   │   ├── popup.html/js           # Extension popup with stats + backup export
│   │   └── icons/                  # Extension icons
│   ├── tests/                      # Vitest tests
│   ├── data/backups/               # Daily backup files (argus-backup-YYYY-MM-DD.json)
│   ├── Dockerfile                  # Multi-stage Node 22 Alpine
│   ├── docker-compose.yml          # Full stack (4 containers)
│   └── .env.example                # Environment template
├── evolution-api/                  # WhatsApp Bridge (included, builds from source)
│   ├── src/                        # Evolution API v2.3.7 source
│   ├── Dockerfile                  # Node 24 Alpine build
│   ├── prisma/                     # Database schema
│   └── docker-compose.yaml         # (Not used — we use argus/docker-compose.yml)
└── quicksave/                      # QuickSave CEP v9.1 (reference spec)
    ├── SKILL.md                    # Full protocol specification
    └── references/                 # PDL, S2A, NCL, expert docs
```

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Build TypeScript → `dist/` |
| `npm start` | Run production server |
| `npm test` | Run tests (~2s, Vitest) |
| `npm run lint` | Lint code (ESLint, cached) |
| `npm run format` | Format code (Prettier) |
| `npm run typecheck` | Type-check without emitting |

## Chrome Extension Setup

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `extension/` folder
4. (For local `file://` testing) → Enable **Allow access to file URLs**

## API Endpoints

### Core

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check (includes `aiTier`, `aiTierMode`, `mcpConfigured`) |
| `/api/stats` | GET | Event and message statistics |
| `/api/ai-status` | GET | AI tier status, cooldown, cache stats |
| `/api/mcp-status` | GET | Elastic Agent Builder MCP status, tool list, cache info |

### Events

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/events` | GET | List events (filter by `?status=`) |
| `/api/events/:id` | GET | Get single event |
| `/api/events/:id` | PATCH | Update event fields |
| `/api/events/:id` | DELETE | Delete event |
| `/api/events/:id/set-reminder` | POST | Schedule event reminder |
| `/api/events/:id/snooze` | POST | Snooze for X minutes |
| `/api/events/:id/ignore` | POST | Ignore event |
| `/api/events/:id/complete` | POST | Mark done |
| `/api/events/:id/done` | POST | Mark done (alias) |
| `/api/events/:id/dismiss` | POST | Dismiss notification |
| `/api/events/:id/acknowledge` | POST | Acknowledge reminder |
| `/api/events/:id/confirm-update` | POST | Confirm pending update |
| `/api/events/:id/context-url` | POST | Set context URL for event |
| `/api/events/day/:timestamp` | GET | Get all events for a day |
| `/api/events/status/:status` | GET | Get events by status |

### WhatsApp / Messages

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/messages` | GET | List stored messages |
| `/api/whatsapp/messages` | GET | Messages from Evolution API |
| `/api/whatsapp/search` | GET | Search messages (`?q=`) |
| `/api/whatsapp/contacts` | GET | Contact list |
| `/api/whatsapp/chats` | GET | Chat list |
| `/api/whatsapp/instances` | GET | Evolution API instance status |
| `/api/whatsapp/stats` | GET | WhatsApp message statistics |

### Context & AI

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/context-check` | POST | Check URL for matching events (hybrid kNN + BM25) |
| `/api/form-check` | POST | Check form field mismatch against memory |
| `/api/extract-context` | POST | Extract context from URL |
| `/api/chat` | POST | AI Chat — agentic via MCP tools (when configured) or embedded events |

### Backup

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/backup/export` | GET | Download full backup as JSON |
| `/api/backup/list` | GET | List available backup files |
| `/api/backup/import` | POST | Import backup from JSON body |
| `/api/backup/restore/:filename` | POST | Restore from a saved backup file |

### Webhook & WebSocket

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/webhook/whatsapp` | POST | Evolution API webhook receiver |
| `/ws` | WebSocket | Real-time notifications to extension |

## How It Works

```
WhatsApp Message → Evolution API → Webhook → Argus Server
                                                  │
                                         Gemini AI (Tier 1)
                                         or Heuristics (Tier 2)
                                         or Safe Default (Tier 3)
                                        extracts events/tasks/reminders
                                                  │
                                     Elasticsearch Serverless stores,
                                      indexes + generates embeddings
                                                  │
                                   ┌──────────────┼──────────────┐
                                   │              │              │
                              WebSocket      URL Match      DOM Watch
                              (new event)   (context)      (form field)
                                   │              │              │
                                   └──────────────┼──────────────┘
                                                  │
                                          Chrome Extension
                                         shows popup overlay
```

### AI Fallback Tier System

Argus automatically downgrades when Gemini is unavailable:

| Tier | Condition | Behavior |
|------|-----------|----------|
| **1** | Normal operation | Gemini AI (full accuracy) |
| **2** | 1+ failures, cooldown active | Regex/pattern heuristics |
| **3** | 10+ consecutive failures | Safe defaults (`{events: []}`) |

Cooldown schedule: 1 failure → 30s, 3 consecutive → 5min, 10 consecutive → 15min. Recovery to Tier 1 is immediate on any success.

## Elasticsearch

Argus uses **Elasticsearch Serverless** (cloud ID + API key auth) as its sole database. All six indices are created automatically on startup if they don't exist.

### Indices

| Index | Purpose |
|-------|---------|
| `argus-events` | Events/tasks/reminders extracted from WhatsApp |
| `argus-messages` | Raw WhatsApp messages (source of truth) |
| `argus-triggers` | Time and URL-based notification triggers |
| `argus-contacts` | Contact list with message counts |
| `argus-context-dismissals` | Per-URL dismissal suppression (30-minute window) |
| `argus-push-subscriptions` | Browser push subscription tokens |

### Events Index Mapping

The `argus-events` index stores a `dense_vector` field (768 dimensions, cosine similarity) alongside standard text/keyword fields. This enables hybrid search. Key fields:

```
title        — text (+ keyword sub-field, boosted ×3 in search)
keywords     — text (+ keyword sub-field, boosted ×2 in search)
description  — text
location     — text + keyword
event_type   — keyword
status       — keyword
embedding    — dense_vector (768 dims, cosine similarity, indexed for kNN)
event_time   — long (Unix timestamp)
reminder_time — long (Unix timestamp)
context_url  — keyword (URL pattern for context triggers)
```

### Hybrid Search (kNN + BM25)

`/api/context-check` and `/api/chat` use `hybridSearchEvents()` which combines:

- **kNN** — vector search over the `embedding` field (`num_candidates: 50`)
- **BM25** — `multi_match` across `title^3`, `keywords^2`, `description`, `location`

When both are present Elasticsearch merges scores via **Reciprocal Rank Fusion (RRF)**. If an event has no embedding (e.g. generated during a Gemini outage), it participates in BM25-only and gets an embedding on the next backfill run.

### ID Counters

Elasticsearch Serverless has no auto-increment. Argus uses in-memory integer counters seeded at startup by running a `max` aggregation on the `id` field of `argus-events` and `argus-triggers`. After a backup restore, counters are reinitialized to prevent collisions.

### Write Safety

All writes use `safeAsync` from `errors.ts`. A failed write is caught, logged, and its payload appended to `data/dead-letter.jsonl` for manual recovery. The dead-letter file auto-rotates to `.old` at 10 MB.

## Search Fallback

When Gemini embeddings are unavailable, search degrades gracefully instead of failing.

### Fallback Chain

```
1. hybridSearchEvents(queryText, queryVector)
   ├── queryVector != null → kNN + BM25 merged via RRF   (full semantic match)
   └── queryVector == null → BM25 only                   (keyword match, still useful)

2. searchEventsByKeywords(keywords[])
   ├── Try exact location match per keyword first
   └── Multi-match: title^3 · keywords^2 · description · location  (fuzziness: AUTO)
```

### Embedding Backfill

Events created during a Gemini outage have `embedding: null`. A background job running every 5 minutes calls `getEventsWithoutEmbeddings()` and calls `generateEmbedding()` for each, storing the result with `updateEventEmbedding()`. BM25 search continues to work for these events in the meantime.

## Elastic Agent Builder MCP

When `ELASTIC_MCP_URL` is set, `/api/chat` switches from pre-loading events into a single prompt to an **agentic tool-call loop** — Gemini decides what to search and how, calling Elastic Agent Builder tools to query Elasticsearch directly.

### Agentic Chat Loop

```
POST /api/chat { "query": "do I have any meetings this week?" }

  1. fetchMcpTools()       — discover available tools (5-min cache)
  2. Gemini + tools        — model decides which tool to call and with what arguments
  3. callMcpTool()         — JSON-RPC 2.0 tools/call → Elasticsearch query executed
  4. Gemini reads result   — may call another tool (up to 5 iterations)
  5. Final JSON response   — { "response": "...", "relevantEventIds": [...] }
```

### Setup

1. Create an **Elastic Agent Builder** project in Kibana.
2. Grant `ELASTIC_API_KEY` the `feature_agentBuilder.read` Kibana privilege.
3. Set `ELASTIC_MCP_URL` in `.env`:
   ```bash
   ELASTIC_MCP_URL=https://<project>.kb.<region>.gcp.elastic.cloud/api/agent_builder/mcp
   ```

### Fallback

| Mode | `ELASTIC_MCP_URL` | Behavior |
|------|-------------------|----------|
| Agentic | Set | Gemini calls MCP tools in a loop; events queried on-demand |
| Legacy | Not set | Up to 100 events embedded in prompt; single Gemini call |

MCP failures (`fetchMcpTools` or max iterations exceeded) escalate through the normal `withFallback()` tier system to Tier 2 heuristics, then Tier 3 cache. Individual `callMcpTool` failures inject an error JSON as the tool result and let Gemini adapt within the same loop.

## API Error Handling

All error handling is centralized in `src/errors.ts`.

### Custom Error Classes

| Class | Fields | Retryable |
|-------|--------|-----------|
| `TimeoutError` | `message` | Yes — always |
| `GeminiApiError` | `status`, `retryable` | Yes if 5xx or 429; No if 4xx |
| `ElasticError` | `operation`, `index` | No (handled by `safeAsync`) |

### `fetchWithTimeout`

Wraps `fetch()` with an `AbortController` deadline (default 30 s). Throws `TimeoutError` on expiry and cleans up the timer on success.

### `withRetry`

Retries an async operation with exponential backoff:

| Attempt | Timeout | Delay before retry |
|---------|---------|--------------------|
| 1st | 30 s | — |
| 2nd (retry) | 15 s | 500 ms |

Max 1 retry by default (total budget ≤ 45 s). Only retries on `TimeoutError`, `GeminiApiError` (retryable), or network errors (`ECONNREFUSED`, `ENOTFOUND`, `fetch failed`, `socket hang up`, `ETIMEDOUT`). Never retries 4xx client errors.

### `safeAsync`

Catch-and-fallback wrapper used on all Elasticsearch writes. Returns a safe fallback value on failure so the server never crashes on a write error. Set `DEBUG_ERRORS=true` to re-throw instead (surfaces bugs during development).

### Dead-Letter Log

Failed writes are appended to `data/dead-letter.jsonl` (one JSON object per line). Each entry contains the operation name, original payload, error message, and stack trace. The file auto-rotates to `dead-letter.jsonl.old` when it exceeds 10 MB.

## Scheduler Retry

The scheduler (`src/scheduler.ts`) guarantees at-least-once delivery of notifications to the Chrome extension.

### Retry Queue

When `notifyCallback` (WebSocket broadcast) throws or the extension is disconnected, the notification is placed in an in-memory retry queue with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1st retry | 1 minute |
| 2nd retry | 5 minutes |
| 3rd retry | 15 minutes |

The queue is drained every 30 seconds (piggybacked on the reminder check interval). On success the associated `markFn` (e.g. `markTriggerFired`, `markEventReminded`) is called to prevent re-firing.

### Permanent Failure

After 3 failed attempts the notification is dropped from the queue and its details appended to `data/failed-reminders.jsonl` for manual review. Failed reminder counts are exposed via `GET /api/ai-status`.

### Scheduler Intervals

| Task | Interval |
|------|----------|
| Time triggers | Every 60 s (configurable) |
| Due reminders + retry queue | Every 30 s |
| Snoozed events | Every 30 s |
| Daily backup | 60 s after start, then every 24 h |

## Database Backup

Argus automatically exports all Elasticsearch data to local JSON files daily.

### Automatic Backup

The scheduler runs `runDailyBackup()` 60 seconds after startup, then every 24 hours. Old backups beyond `BACKUP_RETENTION_DAYS` (default 7) are pruned automatically after each run.

### Backup Format

```json
{
  "version": "1.0",
  "exportedAt": "2026-02-26T00:00:00.000Z",
  "source": "argus-elastic",
  "counts": { "events": 120, "messages": 3400, ... },
  "indices": { "events": [...], "messages": [...], ... }
}
```

The `embedding` field is excluded from all exports — it is large and can be regenerated via the backfill job. The `counts` object is placed before `indices` in the JSON so `GET /api/backup/list` can extract record counts by reading only the first 400 bytes of each file (no full parse needed).

### Import Modes

| Mode | Behavior |
|------|----------|
| `merge` | Upserts documents — existing records are updated, new ones created |
| `replace` | Clears each index first (`deleteByQuery`), then bulk-indexes |

After import, ID counters are reinitialized via a `max` aggregation to prevent collisions with new events.

### Manual Backup via Extension

The extension popup has an **Export Backup** button that triggers `GET /api/backup/export` and downloads the JSON file directly to the browser.

## Working Scenarios

### 1. Travel Recommendations (Goa Cashews)
```
"Rahul recommended cashews at Zantye's in Goa"
User visits goatourism.com
Popup: "Rahul's Recommendation — Remember the cashews at Zantye's?"
```

### 2. Insurance Accuracy (Form Mismatch)
```
User owns Honda Civic 2018 (from WhatsApp chats)
User visits ACKO and types "Honda Civic 2022"
Popup: "Hold on — you own a Honda Civic 2018! You might be overpaying!"
"Fix It" button auto-fills the correct value
```

### 3. Gift Intent (E-commerce)
```
"Need to buy makeup for sis birthday"
User visits Nykaa
Popup: "Sale going on! You mentioned wanting makeup for your sister"
```

### 4. Subscription Cancel (Netflix)
```
"Want to cancel my Netflix this week"
User visits netflix.com
Popup: "You planned to cancel your Netflix subscription"
```

### 5. Calendar Conflict Detection
```
"Meeting tomorrow at 5pm"
"Call with John tomorrow at 5pm"
Popup: "You might be double-booked" + View My Day timeline
```

## Popup Types (8)

| Type | Trigger |
|------|---------|
| `event_discovery` | New event detected from WhatsApp |
| `event_reminder` | Time-based (24h, 1h, 15min before) |
| `context_reminder` | URL matches event context |
| `conflict_warning` | Overlapping events detected |
| `insight_card` | Suggestions from conversations |
| `snooze_reminder` | Snoozed event fires again |
| `update_confirm` | Confirm event modification |
| `form_mismatch` | Form input doesn't match memory |

## Configuration

Copy `.env.example` to `.env` and set:

```bash
# ─── Required ──────────────────────────────────────
GEMINI_API_KEY=your_gemini_api_key_here

# ─── Elasticsearch Serverless (Required) ───────────
ELASTIC_CLOUD_ID=your_cloud_id_here
ELASTIC_API_KEY=your_api_key_here

# ─── Gemini ────────────
GEMINI_MODEL=gemini-3-flash-preview
GEMINI_EMBEDDING_MODEL=gemini-embedding-001

# ─── Evolution API / WhatsApp ──────────────────────
EVOLUTION_API_KEY=rmd_evolution_api_key_12345
EVOLUTION_INSTANCE_NAME=argaus

# ─── AI Fallback Tier ───────────────────
AI_TIER_MODE=auto              # auto | tier1_only | tier2_only | tier3_only
AI_COOLDOWN_BASE_SEC=30        # base cooldown after first failure
AI_CACHE_TTL_SEC=3600          # Tier 3 cache TTL (seconds)
AI_CACHE_MAX_SIZE=500          # Tier 3 LRU cache entries

# ─── Elastic Agent Builder MCP ──────────
# ELASTIC_MCP_URL=https://<project>.kb.<region>.gcp.elastic.cloud/api/agent_builder/mcp

# ─── Backup ─────────────────────────────
BACKUP_RETENTION_DAYS=7        # days to keep daily backups
```

## Performance

| Metric | Value |
|--------|-------|
| Message ingestion | <500ms |
| Context check (hybrid) | <800ms |
| Elasticsearch query | <50ms |
| Memory usage | <200MB |
| Test suite | ~2s |

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```

## License

MIT — see [LICENSE](../LICENSE) for details.
