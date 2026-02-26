# Search Fallback System — Implementation Plan

`matchContext()` in `matcher.ts` is called every time the Chrome extension detects a URL change. It runs a 3-step pipeline: extract keywords → Elasticsearch search → Gemini validation. If ES or Gemini fails, the function throws and the context check returns a 500 error to the extension — no results, no fallback.

This plan adds **result caching, keyword-overlap scoring as a Gemini fallback, and cached-result return when ES is down**.

---

## Current Flow (No Fallback)

```
URL → extractContextFromUrl() → searchEventsByKeywords() → validateRelevance() → result
                                        ↓ (ES down)               ↓ (Gemini down)
                                     ❌ throws                  ❌ throws
```

## Proposed Flow (With Fallback)

```
URL → check match cache (10m TTL)
       ↓ (cache hit)                  ↓ (cache miss)
    return cached result     extractContextFromUrl()
                                      ↓
                              searchEventsByKeywords()
                               ↓ (ES down)        ↓ (success)
                          return cached result   validateRelevance()
                          (if available)          ↓ (Gemini down)     ↓ (success)
                                          keywordOverlapScore()    cache + return
                                                ↓
                                          cache + return
```

---

## Proposed Changes

### Match Result Cache

#### [MODIFY] [matcher.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/matcher.ts)

**New in-module cache** (separate from `response-cache.ts` since it needs URL-keyed lookup and shorter TTL):

```typescript
interface CachedMatch {
  result: ContextCheckResponse;
  cachedAt: number;
}

const matchCache = new Map<string, CachedMatch>();
const MATCH_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const MATCH_CACHE_MAX = 200;             // max cached URLs
```

**`matchContext()` changes:**

1. **Cache check first** — normalize URL (strip fragment/tracking params), check cache:
   ```typescript
   const cacheKey = normalizeUrl(url);
   const cached = matchCache.get(cacheKey);
   if (cached && Date.now() - cached.cachedAt < MATCH_CACHE_TTL) {
     console.log(`   Cache hit (${Date.now() - start}ms)`);
     return cached.result;
   }
   ```

2. **ES failure fallback** — wrap ES search calls in try-catch:
   ```typescript
   let candidates: Event[] = [];
   try {
     // existing ES search logic...
   } catch (err) {
     console.warn(`⚠️ ES search failed, checking cache: ${err}`);
     if (cached) return cached.result; // return stale cache
     return { matched: false, events: [], confidence: 0 };
   }
   ```

3. **Gemini failure fallback** — replace Gemini validation with keyword overlap scoring:
   ```typescript
   let validation;
   try {
     validation = await validateRelevance(url, title || '', candidates);
   } catch {
     console.warn('⚠️ Gemini validation failed, using keyword overlap');
     validation = keywordOverlapValidation(keywords, candidates);
   }
   ```

4. **Cache successful results** — store before returning:
   ```typescript
   matchCache.set(cacheKey, { result, cachedAt: Date.now() });
   // LRU eviction if over max
   if (matchCache.size > MATCH_CACHE_MAX) {
     const oldest = matchCache.keys().next().value;
     if (oldest) matchCache.delete(oldest);
   }
   ```

---

### Keyword Overlap Scoring (Gemini-free Validation)

#### [MODIFY] [matcher.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/matcher.ts)

**New `keywordOverlapValidation()` function:**

```typescript
function keywordOverlapValidation(
  urlKeywords: string[],
  candidates: Event[]
): { relevant: number[]; confidence: number } {
  const urlSet = new Set(urlKeywords.map(k => k.toLowerCase()));
  const scored: { idx: number; score: number }[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const event = candidates[i];
    const eventWords = new Set(
      `${event.title} ${event.keywords} ${event.location || ''} ${event.description || ''}`
        .toLowerCase().split(/[\s,]+/)
        .filter(w => w.length > 2)
    );

    // Count overlapping keywords
    let overlap = 0;
    for (const kw of urlSet) {
      for (const ew of eventWords) {
        if (ew.includes(kw) || kw.includes(ew)) { overlap++; break; }
      }
    }

    const score = urlSet.size > 0 ? overlap / urlSet.size : 0;
    if (score >= 0.3) { // At least 30% keyword overlap
      scored.push({ idx: i, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.slice(0, 5).map(s => s.idx);
  const confidence = scored.length > 0 ? scored[0].score * 0.8 : 0; // Cap at 0.8 (never full confidence without Gemini)

  return { relevant, confidence };
}
```

---

### URL Normalization

#### [MODIFY] [matcher.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/matcher.ts)

**New `normalizeUrl()` function** — ensures the same page with different tracking params hits the cache:

```typescript
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Strip common tracking params
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','ref','fbclid','gclid'].forEach(p => u.searchParams.delete(p));
    u.hash = ''; // strip fragment
    return u.toString();
  } catch { return url; }
}
```

---

### Cache Stats Export

#### [MODIFY] [matcher.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/matcher.ts)

Export stats for the health endpoint:
```typescript
export function getMatchCacheStats(): { size: number; maxSize: number; ttlSec: number } {
  return { size: matchCache.size, maxSize: MATCH_CACHE_MAX, ttlSec: MATCH_CACHE_TTL / 1000 };
}
```

#### [MODIFY] [server.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/server.ts)

Add to `/api/health`:
```diff
+import { getMatchCacheStats } from './matcher.js';
 res.json({
   status: 'ok',
+  matchCache: getMatchCacheStats(),
 });
```

---

## Files Changed Summary

| File | Action | Purpose |
|:---|:---|:---|
| `matcher.ts` | MODIFY | Match result cache (10m TTL), keyword overlap fallback, URL normalization, cache stats |
| `server.ts` | MODIFY | Expose match cache stats in health endpoint |

---

## Verification Plan

### Automated
```bash
cd d:\Elastic\whatsapp-chat-rmd-argus\argus && npx tsc --noEmit
```

### Manual

1. **Cache hit** — Visit `netflix.com` twice within 10 minutes → verify second call logs "Cache hit" and responds in <1ms (vs ~500ms+ on first)

2. **Cache with tracking params** — Visit `netflix.com?utm_source=test` then `netflix.com?ref=xyz` → verify both hit the same cache entry

3. **ES failure fallback** — Break `ELASTIC_API_KEY`, visit a URL that was previously matched → verify stale cached result is returned

4. **Gemini failure fallback** — Break `GEMINI_API_KEY`, visit a new URL → verify keyword overlap scoring returns results (lower confidence, capped at 0.8)

5. **Both fail, no cache** — Break both keys, visit a never-seen URL → verify `{ matched: false }` returned cleanly, no crash

6. **Health endpoint** — `GET /api/health` → verify `matchCache.size` reflects actual cache size
