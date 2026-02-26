# Database Backup System — Implementation Plan

Argus stores all data in Elasticsearch Serverless (6 indices). A cloud outage, accidental index deletion, or bad migration could wipe everything. This plan adds 3 backup capabilities to prevent data loss.

## Features

| Feature | Trigger | Output | Location |
|:---|:---|:---|:---|
| **Automatic daily backup** | Scheduler (every 24h) | `.json` file per day | `argus/data/backups/` |
| **Manual JSON export** | User clicks 💾 button in Chrome extension popup | Single `.json` download | Browser download |
| **Import from backup** | User uploads file via API | Restores all indices | Elasticsearch |

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  backup.ts (NEW)                 │
│                                                  │
│  exportAllData()        ← scrolls all 6 indices  │
│  importFromBackup()     ← bulk indexes from file  │
│  runDailyBackup()       ← export + save to disk   │
│  pruneOldBackups()      ← keep last N backups     │
│  getBackupList()        ← list available backups  │
└──────────────────────────────────────────────────┘
         ↕                          ↕
    elastic.ts                 data/backups/
    (getClient)           argus-backup-2026-02-26.json
```

---

## Proposed Changes

### New Module: Backup Engine

#### [NEW] [backup.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/backup.ts)

**`exportAllData(): Promise<BackupPayload>`**
- Uses the Elasticsearch **Scroll API** to paginate through all documents in each of the 6 indices (`argus-events`, `argus-messages`, `argus-triggers`, `argus-contacts`, `argus-context-dismissals`, `argus-push-subscriptions`)
- Returns a typed `BackupPayload` object:
```typescript
interface BackupPayload {
  version: string;           // "1.0"
  exportedAt: string;        // ISO timestamp
  source: string;            // "argus-elastic"
  indices: {
    events: Record<string, any>[];
    messages: Record<string, any>[];
    triggers: Record<string, any>[];
    contacts: Record<string, any>[];
    contextDismissals: Record<string, any>[];
    pushSubscriptions: Record<string, any>[];
  };
  counts: {
    events: number;
    messages: number;
    triggers: number;
    contacts: number;
    contextDismissals: number;
    pushSubscriptions: number;
  };
}
```

**`importFromBackup(payload: BackupPayload, options): Promise<ImportResult>`**
- Validates the backup file structure (version check, required fields)
- Options:
  - `mode: 'merge' | 'replace'` — merge adds missing docs, replace wipes and restores
  - `indices: string[]` — optionally restore only specific indices (e.g., just events)
- For `replace` mode: deletes all docs in target indices first, then bulk-indexes
- For `merge` mode: uses `index` with existing `_id` values (upsert behavior)
- Uses Elasticsearch **Bulk API** for efficient batch indexing (500 docs per batch)
- Returns `ImportResult` with counts of created, updated, failed docs
- Reinitializes ID counters after import (calls existing `initIdCounters()`)

**`runDailyBackup(): Promise<string>`**
- Calls `exportAllData()` and writes JSON to `data/backups/argus-backup-YYYY-MM-DD.json`
- Creates `data/backups/` directory if it doesn't exist
- Logs backup size and document counts
- Returns the file path

**`pruneOldBackups(keepLast: number): Promise<number>`**
- Reads `data/backups/` directory, sorts by date
- Deletes oldest files beyond `keepLast` (default: 7)
- Returns count of deleted files

**`getBackupList(): Promise<BackupInfo[]>`**
- Lists all `.json` files in `data/backups/`
- Returns array of `{ filename, date, sizeBytes, counts }` (reads header without loading full file)

---

### Modifications to Existing Files

#### [MODIFY] [elastic.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/elastic.ts)

- Export the `INDICES` constant (currently not exported) so `backup.ts` can reference index names
- Export `getClient()` (currently private) so `backup.ts` can use the ES client directly for scroll/bulk operations
- Export `initIdCounters()` (currently private) so import can reinitialize counters after restore

#### [MODIFY] [server.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/server.ts)

Add 4 new API endpoints:

| Method | Route | Description |
|:---|:---|:---|
| `GET` | `/api/backup/export` | Full JSON export as downloadable file |
| `POST` | `/api/backup/import` | Upload a backup JSON to restore |
| `GET` | `/api/backup/list` | List available local backups with metadata |
| `POST` | `/api/backup/restore/:filename` | Restore from a specific local backup file |

**Export endpoint:**
```
GET /api/backup/export
Response: Content-Disposition: attachment; filename="argus-backup-2026-02-26.json"
```

**Import endpoint:**
```
POST /api/backup/import
Body: { backup: <BackupPayload>, mode: "merge" | "replace" }
Response: { success: true, imported: { events: 42, messages: 150, ... } }
```

**body size limit**: Increase Express JSON limit to `50mb` for the import route only (backup files can be large).

#### [MODIFY] [scheduler.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/scheduler.ts)

- Add a daily backup interval in `startScheduler()` — runs `runDailyBackup()` followed by `pruneOldBackups(7)` every 24 hours
- First backup runs 60 seconds after server start (not immediately, to avoid slowing boot)

#### [MODIFY] [types.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/types.ts)

- Add `backupRetentionDays` to `ConfigSchema` (default: 7)
- Add `BACKUP_RETENTION_DAYS` env var mapping in `parseConfig()`

#### [MODIFY] [.env](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/.env)

```env
# Backup config
BACKUP_RETENTION_DAYS=7
```

---

### Chrome Extension Changes

#### [MODIFY] [popup.html](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/extension/popup.html)

Add an "Export Backup" button to the footer area, next to the existing "Open Dashboard" link:
```diff
 <div class="footer">
+  <button class="btn btn-export" id="export-backup">Export Backup</button>
   <a href="http://localhost:3000" target="_blank">Open Dashboard ↗</a>
 </div>
```

Add CSS for the export button:
```css
.btn-export {
  background: rgba(129, 140, 248, 0.15);
  border: 1px solid rgba(129, 140, 248, 0.3);
  color: #818cf8;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 11px;
  cursor: pointer;
  margin-bottom: 8px;
  width: 100%;
  transition: background 0.15s;
}
.btn-export:hover { background: rgba(129, 140, 248, 0.25); }
.btn-export:disabled { opacity: 0.5; cursor: not-allowed; }
```

#### [MODIFY] [popup.js](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/extension/popup.js)

Add export button click handler:
```javascript
document.getElementById('export-backup').addEventListener('click', async function() {
  this.disabled = true;
  this.textContent = '💾 Exporting...';
  try {
    const res = await fetch(API + '/backup/export');
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `argus-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.textContent = '✅ Downloaded!';
    setTimeout(() => { this.textContent = '💾 Export Backup'; this.disabled = false; }, 2000);
  } catch (e) {
    this.textContent = '❌ Failed';
    setTimeout(() => { this.textContent = '💾 Export Backup'; this.disabled = false; }, 2000);
  }
});
```

---

## Files Changed Summary

| File | Action | Purpose |
|:---|:---|:---|
| `backup.ts` | **NEW** | Core backup engine: export, import, daily backup, prune |
| `elastic.ts` | MODIFY | Export `INDICES`, `getClient()`, `initIdCounters()` |
| `server.ts` | MODIFY | Add 4 backup API endpoints |
| `scheduler.ts` | MODIFY | Add daily backup cron to scheduler |
| `types.ts` | MODIFY | Add `backupRetentionDays` config |
| `.env` | MODIFY | Add `BACKUP_RETENTION_DAYS` |
| `popup.html` | MODIFY | Add 💾 Export Backup button to footer |
| `popup.js` | MODIFY | Add download handler that calls export API |

---

## Verification Plan

### Automated
```bash
cd d:\Elastic\whatsapp-chat-rmd-argus\argus && npx tsc --noEmit
```

### Manual

1. **Export via API** — `GET /api/backup/export` → verify downloaded JSON contains all 6 indices with correct counts matching `GET /api/stats`

2. **Export via extension** — Open Argus popup → click 💾 Export Backup → verify `.json` file downloads to browser, button shows ✅ feedback

3. **Daily backup** — Start server, wait 60s → verify `data/backups/argus-backup-YYYY-MM-DD.json` created with valid JSON

4. **Import (merge)** — Add a test event, export, delete the event, import with `mode: "merge"` → verify event is restored

5. **Import (replace)** — Export, add garbage events, import with `mode: "replace"` → verify only original events remain

6. **Prune** — Create 10 fake backup files, call prune with `keepLast: 3` → verify oldest 7 are deleted

7. **List** — `GET /api/backup/list` → verify returns filenames, dates, and sizes
