// ============ Backup Engine ============
// Handles export/import of all Argus data from Elasticsearch.
// Three modes:
//   exportAllData()    — full JSON snapshot of all 6 indices
//   importFromBackup() — restore from a snapshot (merge or replace)
//   runDailyBackup()   — export + save to data/backups/argus-backup-YYYY-MM-DD.json
//   pruneOldBackups()  — delete oldest backup files beyond keepLast threshold
//   getBackupList()    — list local backup files with metadata

import * as fs from 'fs';
import * as path from 'path';
import { getClient, INDICES, initIdCounters } from './elastic.js';

// ============ Types ============

export interface BackupPayload {
  version: string;        // "1.0"
  exportedAt: string;     // ISO timestamp
  source: string;         // "argus-elastic"
  counts: {
    events: number;
    messages: number;
    triggers: number;
    contacts: number;
    contextDismissals: number;
    pushSubscriptions: number;
  };
  indices: {
    events: Record<string, any>[];
    messages: Record<string, any>[];
    triggers: Record<string, any>[];
    contacts: Record<string, any>[];
    contextDismissals: Record<string, any>[];
    pushSubscriptions: Record<string, any>[];
  };
}

export interface ImportOptions {
  mode: 'merge' | 'replace';
  indices?: string[];      // restrict to specific index keys (e.g. ['events'])
}

export interface ImportResult {
  created: number;
  updated: number;
  failed: number;
  counts: Record<string, number>;
}

export interface BackupInfo {
  filename: string;
  date: string;
  sizeBytes: number;
  counts: Record<string, number>;
}

// ============ Constants ============

const BACKUP_VERSION = '1.0';
const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');
const PAGE_SIZE = 1000;
const BULK_BATCH = 500;

// ============ Scroll helper (search_after pagination) ============

/**
 * Fetches all documents from an index using from+size pagination.
 * Excludes the 'embedding' field (dense_vector — large, regenerable).
 * Returns empty array if index does not exist.
 * Note: ES limits from+size to max_result_window (default 10000).
 *       For a personal app this is sufficient.
 */
async function fetchAllDocs(indexName: string): Promise<Record<string, any>[]> {
  const es = getClient();
  const docs: Record<string, any>[] = [];

  try {
    let from = 0;

    while (true) {
      const response = await es.search({
        index: indexName,
        size: PAGE_SIZE,
        from,
        query: { match_all: {} },
        _source_excludes: ['embedding'],
      });

      const hits = response.hits.hits;
      if (hits.length === 0) break;

      for (const hit of hits) {
        docs.push({ _id: hit._id, ...(hit._source as Record<string, any>) });
      }

      // Last page
      if (hits.length < PAGE_SIZE) break;

      from += PAGE_SIZE;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('index_not_found') && !msg.includes('no such index')) {
      throw err;
    }
    // Index doesn't exist yet — return empty
  }

  return docs;
}

// ============ Export ============

export async function exportAllData(): Promise<BackupPayload> {
  console.log('[Backup] Starting export...');

  const [events, messages, triggers, contacts, contextDismissals, pushSubscriptions] =
    await Promise.all([
      fetchAllDocs(INDICES.events),
      fetchAllDocs(INDICES.messages),
      fetchAllDocs(INDICES.triggers),
      fetchAllDocs(INDICES.contacts),
      fetchAllDocs(INDICES.contextDismissals),
      fetchAllDocs(INDICES.pushSubscriptions),
    ]);

  const counts = {
    events: events.length,
    messages: messages.length,
    triggers: triggers.length,
    contacts: contacts.length,
    contextDismissals: contextDismissals.length,
    pushSubscriptions: pushSubscriptions.length,
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`[Backup] Export complete: ${total} docs — ${JSON.stringify(counts)}`);

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    source: 'argus-elastic',
    counts,  // counts BEFORE indices so it appears early in the JSON for fast header read
    indices: { events, messages, triggers, contacts, contextDismissals, pushSubscriptions },
  };
}

// ============ Import ============

export async function importFromBackup(
  payload: BackupPayload,
  options: ImportOptions
): Promise<ImportResult> {
  // Validate
  if (payload.version !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: "${payload.version}" (expected "${BACKUP_VERSION}")`);
  }
  if (!payload.indices || typeof payload.indices !== 'object') {
    throw new Error('Invalid backup: missing or malformed "indices" field');
  }

  const es = getClient();
  const result: ImportResult = { created: 0, updated: 0, failed: 0, counts: {} };

  const indexEntries: Array<{ key: keyof typeof INDICES; docs: Record<string, any>[] }> = [
    { key: 'events',            docs: payload.indices.events            || [] },
    { key: 'messages',          docs: payload.indices.messages          || [] },
    { key: 'triggers',          docs: payload.indices.triggers          || [] },
    { key: 'contacts',          docs: payload.indices.contacts          || [] },
    { key: 'contextDismissals', docs: payload.indices.contextDismissals || [] },
    { key: 'pushSubscriptions', docs: payload.indices.pushSubscriptions || [] },
  ];

  for (const { key, docs } of indexEntries) {
    const indexName = INDICES[key];

    // Skip if caller restricted to specific indices
    if (options.indices && !options.indices.includes(key) && !options.indices.includes(indexName)) {
      continue;
    }

    if (docs.length === 0) {
      result.counts[key] = 0;
      continue;
    }

    // Replace mode: wipe the index first
    if (options.mode === 'replace') {
      try {
        await es.deleteByQuery({
          index: indexName,
          query: { match_all: {} },
          refresh: true,
        });
        console.log(`[Backup] Cleared index: ${indexName}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('index_not_found')) throw err;
      }
    }

    // Bulk-index in batches
    for (let i = 0; i < docs.length; i += BULK_BATCH) {
      const batch = docs.slice(i, i + BULK_BATCH);
      const operations = batch.flatMap(doc => {
        const { _id, ...source } = doc;
        return [
          { index: { _index: indexName, ...(_id ? { _id: String(_id) } : {}) } },
          source,
        ];
      });

      const bulkRes = await es.bulk({ operations, refresh: false });

      for (const item of bulkRes.items) {
        const op = item.index;
        if (op?.result === 'created') result.created++;
        else if (op?.result === 'updated') result.updated++;
        else if (op?.error) {
          result.failed++;
          console.warn(`[Backup] Bulk index error on ${indexName}:`, op.error);
        }
      }
    }

    result.counts[key] = docs.length;
    console.log(`[Backup] Imported ${docs.length} docs → ${indexName}`);
  }

  // Reinitialize ID counters so new events/triggers don't collide
  await initIdCounters();
  console.log('[Backup] ID counters reinitialized');

  return result;
}

// ============ Daily Backup ============

export async function runDailyBackup(): Promise<string> {
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `argus-backup-${dateStr}.json`;
  const filePath = path.join(BACKUP_DIR, filename);

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const payload = await exportAllData();
  const json = JSON.stringify(payload);
  fs.writeFileSync(filePath, json, 'utf-8');

  const sizeKb = Math.round(json.length / 1024);
  console.log(`[Backup] Daily backup saved: ${filename} (${sizeKb} KB)`);

  return filePath;
}

// ============ Prune Old Backups ============

export async function pruneOldBackups(keepLast = 7): Promise<number> {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return 0;

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^argus-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()    // ISO date prefix → alphabetical = chronological
      .reverse(); // newest first

    const toDelete = files.slice(keepLast);
    for (const f of toDelete) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      console.log(`[Backup] Pruned: ${f}`);
    }

    return toDelete.length;
  } catch (err) {
    console.warn('[Backup] pruneOldBackups error:', (err as Error).message);
    return 0;
  }
}

// ============ List Backups ============

export async function getBackupList(): Promise<BackupInfo[]> {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^argus-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse(); // newest first

    return files.map(filename => {
      const filePath = path.join(BACKUP_DIR, filename);
      const stat = fs.statSync(filePath);

      // Read first 400 bytes to extract counts without loading the full file.
      // counts appears before indices in the JSON (by design), so it fits in the header.
      const buf = Buffer.alloc(400);
      const fd = fs.openSync(filePath, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, 400, 0);
      fs.closeSync(fd);
      const header = buf.slice(0, bytesRead).toString('utf-8');

      let counts: Record<string, number> = {};
      const countsMatch = header.match(/"counts"\s*:\s*(\{[^}]+\})/);
      if (countsMatch) {
        try { counts = JSON.parse(countsMatch[1]); } catch { /* ignore */ }
      }

      const dateMatch = filename.match(/argus-backup-(\d{4}-\d{2}-\d{2})\.json/);

      return {
        filename,
        date: dateMatch ? dateMatch[1] : '',
        sizeBytes: stat.size,
        counts,
      };
    });
  } catch (err) {
    console.warn('[Backup] getBackupList error:', (err as Error).message);
    return [];
  }
}
