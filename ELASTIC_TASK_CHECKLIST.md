# Task List: Elastic Stack Migration

## Preparation Phase
- [x] Requirements gathering & API validation
- [x] Document detailed implementation plan (`implementation_plan.md`)
- [x] Create `requirements.md` to list all dependencies and env vars
- [ ] Validating MCP server connection (optional but recommended)

## Implementation Phase (To be executed by Claude)
- [x] Database Layer: Create `elastic.ts` client wrapper
- [x] Schema Migration: define index mappings (events, messages)
- [x] Search Logic: Rewrite `matcher.ts` to use Elastic DSL
- [x] Ingestion Logic: Update `ingestion.ts` to write to Elastic
- [x] Server Integration: Swap `db.ts` calls for `elastic.ts` in `server.ts`
- [x] Scheduler: Update `scheduler.ts` to use `elastic.ts`
- [x] Types: Add Elastic config to `types.ts` ConfigSchema
- [x] Build: TypeScript compiles cleanly (`npx tsc`)
- [ ] Docker Config: Add `elasticsearch` and `kibana` (optional) to `docker-compose.yml`

## Verification Phase
- [ ] Verify index creation on startup
- [ ] Verify message ingestion (indexing)
- [ ] Verify context matching (search queries)
