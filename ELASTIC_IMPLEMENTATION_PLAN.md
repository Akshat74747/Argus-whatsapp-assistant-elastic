# Argus: Migration to Elastic Stack (Implementation Plan)

## Goal Description
Migrate the underlying data storage and search engine from SQLite to **Elasticsearch** (Serverless). This leverages the Elastic AI capabilities, specifically **Hybrid Search**, to make Argus a true "AI Assistant" as per hackathon requirements.

## User Review Required
> [!IMPORTANT]
> **Serverless vs Local**: This plan targets **Elastic Cloud Serverless** using the provided API coordinates. If you want a local fallback (Docker), we can add that, but the primary target is Cloud.

> [!WARNING]
> **Data Loss**: Existing SQLite data will **NOT** be migrated. You will start with a fresh memory.

## Architecture Changes
1.  **Database**: SQLite (`better-sqlite3`) -> Elasticsearch (`@elastic/elasticsearch`).
2.  **Search**: FTS5 SQL Queries -> Elastic Query DSL (Hybrid Search).
3.  **Agents**: Hardcoded Gemini calls -> Elastic Agent Builder (via MCP or direct API).

## Detailed Implementation Steps

### 1. Project Configuration
#### [MODIFY] [package.json](file:///d:/Elastic/whatsapp-chat-rmd-argus/package.json)
- Remove `better-sqlite3`.
- Add `@elastic/elasticsearch`.
- *Optional*: Add MCP SDK if integrating Agent Builder via MCP protocol directly.

#### [NEW] [argus/.env](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/.env)
- Add `ELASTIC_CLOUD_ID`, `ELASTIC_API_KEY`, `ELASTIC_MCP_URL`.

### 2. Database Layer (`elastic.ts`)
Create a new file `argus/src/elastic.ts` to replace `db.ts`.

#### [NEW] [argus/src/elastic.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/elastic.ts)
- **Init**: Connect using `Client({ cloud: { id }, auth: { apiKey } })`.
- **Indices**: Check if `argus-events`, `argus-messages` exist. If not, create them with **mappings**:
    - `events`: `title` (text + keyword), `description` (text), `embedding` (dense_vector), `status` (keyword), `event_time` (date).
- **CRUD Operations**:
    - `indexEvent(event)`: Index a new document.
    - `getEvent(id)`: Retrieve by `_id`.
    - `updateEvent(id, doc)`: Partial update.
    - `deleteEvent(id)`: Delete document.

### 3. Search & Matcher Logic (`matcher.ts`)
Rewrite `matcher.ts` to use Elastic's power.

#### [MODIFY] [argus/src/matcher.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/matcher.ts)
- **Function**: `searchEventsByContext(keywords, location)`
- **Query**: Use a `bool` query:
    - `should`:
        - `multi_match` on `title`, `description`, `keywords` (boosted).
        - `match` on `location` (if provided).
    - `filter`: `status` is `active` (discovered/scheduled).
- **Hybrid Search (Future)**: Prepare the query structure to accept `knn` (vectors) for semantic matching later.

### 4. Ingestion Flow (`ingestion.ts`)
Update the "Director" to use the new backend.

#### [MODIFY] [argus/src/ingestion.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/ingestion.ts)
- Replace `insertMessage` -> `elastic.indexMessage`.
- Replace `insertEvent` -> `elastic.indexEvent`.
- **Entity Resolution**: Replace `findDuplicateEvent` SQL with an Elastic `fuzzy` query on the `title` field to find duplicates.
5.  **Docker Cleanup**:
    *   [MODIFY] `docker-compose.yml`: Remove the `volumes` mapping for SQLite. Ensure the container uses the new `.env` variables.

## Verification
1.  **Compile**: `npm run build` (ensure types match).
2.  **Connect**: Start app, check logs for `✅ Elastic connected`.
3.  **Test**: Send "Buy milk" on WhatsApp. Check Elastic Dashboard to see the document.
4.  **Retrieval**: Type a URL in the browser (e.g., `bigbasket.com`). Check logs for Elastic query and match.
