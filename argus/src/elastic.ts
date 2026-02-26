import { Client } from '@elastic/elasticsearch';
import type { Message, Event, Trigger, Contact, TriggerType } from './types.js';
import { generateEmbedding, buildEventEmbeddingText } from './embeddings.js';
import { safeAsync } from './errors.js';

// ============ Client Setup ============
let client: Client | null = null;
let eventIdCounter = 0;
let triggerIdCounter = 0;

export const INDICES = {
  events: 'argus-events',
  messages: 'argus-messages',
  triggers: 'argus-triggers',
  contacts: 'argus-contacts',
  contextDismissals: 'argus-context-dismissals',
  pushSubscriptions: 'argus-push-subscriptions',
} as const;

export function getClient(): Client {
  if (!client) {
    throw new Error('Elasticsearch not initialized. Call initElastic() first.');
  }
  return client;
}

// ============ Initialization ============
export async function initElastic(config: {
  cloudId: string;
  apiKey: string;
}): Promise<void> {
  client = new Client({
    cloud: { id: config.cloudId },
    auth: { apiKey: config.apiKey },
  });

  // Test connection
  const info = await client.info();
  console.log('✅ Elastic connected:', info.cluster_name || 'serverless');

  // Create indices if they don't exist
  await ensureIndices();

  // Initialize ID counters from existing data
  await initIdCounters();
}

async function ensureIndices(): Promise<void> {
  const es = getClient();

  // Events index
  const eventsExists = await es.indices.exists({ index: INDICES.events });
  if (!eventsExists) {
    await es.indices.create({
      index: INDICES.events,
      mappings: {
        properties: {
          id: { type: 'integer' },
          message_id: { type: 'keyword' },
          event_type: { type: 'keyword' },
          title: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          description: { type: 'text' },
          event_time: { type: 'long' },
          location: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          participants: { type: 'text' },
          keywords: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          embedding: { type: 'dense_vector', dims: 768, index: true, similarity: 'cosine' },
          confidence: { type: 'float' },
          status: { type: 'keyword' },
          reminder_time: { type: 'long' },
          context_url: { type: 'keyword' },
          dismiss_count: { type: 'integer' },
          sender_name: { type: 'keyword' },
          created_at: { type: 'long' },
        },
      },
    });
    console.log('📦 Created index:', INDICES.events);
  } else {
    // Add embedding field to existing index (no-op if already present)
    try {
      await es.indices.putMapping({
        index: INDICES.events,
        properties: {
          embedding: { type: 'dense_vector', dims: 768, index: true, similarity: 'cosine' },
        } as any,
      });
      console.log('📦 Ensured embedding field on existing index:', INDICES.events);
    } catch (err) {
      // May fail if mapping already exists with same definition — safe to ignore
      console.warn('⚠️ Could not add embedding field (may already exist):', (err as Error).message?.slice(0, 100));
    }
  }

  // Messages index
  const messagesExists = await es.indices.exists({ index: INDICES.messages });
  if (!messagesExists) {
    await es.indices.create({
      index: INDICES.messages,
      mappings: {
        properties: {
          id: { type: 'keyword' },
          chat_id: { type: 'keyword' },
          sender: { type: 'keyword' },
          content: { type: 'text' },
          timestamp: { type: 'long' },
          created_at: { type: 'long' },
        },
      },
    });
    console.log('📦 Created index:', INDICES.messages);
  }

  // Triggers index
  const triggersExists = await es.indices.exists({ index: INDICES.triggers });
  if (!triggersExists) {
    await es.indices.create({
      index: INDICES.triggers,
      mappings: {
        properties: {
          id: { type: 'integer' },
          event_id: { type: 'integer' },
          trigger_type: { type: 'keyword' },
          trigger_value: { type: 'keyword' },
          is_fired: { type: 'boolean' },
          fire_count: { type: 'integer' },
          created_at: { type: 'long' },
        },
      },
    });
    console.log('📦 Created index:', INDICES.triggers);
  }

  // Contacts index
  const contactsExists = await es.indices.exists({ index: INDICES.contacts });
  if (!contactsExists) {
    await es.indices.create({
      index: INDICES.contacts,
      mappings: {
        properties: {
          id: { type: 'keyword' },
          name: { type: 'keyword' },
          first_seen: { type: 'long' },
          last_seen: { type: 'long' },
          message_count: { type: 'integer' },
        },
      },
    });
    console.log('📦 Created index:', INDICES.contacts);
  }

  // Context dismissals index
  const dismissalsExists = await es.indices.exists({ index: INDICES.contextDismissals });
  if (!dismissalsExists) {
    await es.indices.create({
      index: INDICES.contextDismissals,
      mappings: {
        properties: {
          id: { type: 'integer' },
          event_id: { type: 'integer' },
          url_pattern: { type: 'keyword' },
          dismissed_until: { type: 'long' },
          created_at: { type: 'long' },
        },
      },
    });
    console.log('📦 Created index:', INDICES.contextDismissals);
  }
}

export async function initIdCounters(): Promise<void> {
  const es = getClient();

  // Get max event ID
  try {
    const evRes = await es.search({
      index: INDICES.events,
      size: 0,
      aggs: { max_id: { max: { field: 'id' } } },
    });
    const maxEventId = (evRes.aggregations?.max_id as any)?.value;
    eventIdCounter = maxEventId ? Math.floor(maxEventId) : 0;
  } catch {
    eventIdCounter = 0;
  }

  // Get max trigger ID
  try {
    const trRes = await es.search({
      index: INDICES.triggers,
      size: 0,
      aggs: { max_id: { max: { field: 'id' } } },
    });
    const maxTriggerId = (trRes.aggregations?.max_id as any)?.value;
    triggerIdCounter = maxTriggerId ? Math.floor(maxTriggerId) : 0;
  } catch {
    triggerIdCounter = 0;
  }

  console.log(`🔢 ID counters: events=${eventIdCounter}, triggers=${triggerIdCounter}`);
}

function nextEventId(): number {
  return ++eventIdCounter;
}

function nextTriggerId(): number {
  return ++triggerIdCounter;
}

// Helper: map ES _source to Event object
function mapEvent(source: Record<string, any>): Event {
  return {
    id: source.id,
    message_id: source.message_id || null,
    event_type: source.event_type,
    title: source.title,
    description: source.description || null,
    event_time: source.event_time || null,
    location: source.location || null,
    participants: source.participants || null,
    keywords: source.keywords || '',
    confidence: source.confidence || 0,
    status: source.status || 'discovered',
    reminder_time: source.reminder_time || null,
    context_url: source.context_url || null,
    dismiss_count: source.dismiss_count || 0,
    sender_name: source.sender_name || null,
    created_at: source.created_at,
  };
}

// ============ Message Operations ============
export async function insertMessage(msg: Message): Promise<void> {
  await safeAsync(
    async () => {
      const es = getClient();
      await es.index({
        index: INDICES.messages,
        id: msg.id,
        document: {
          id: msg.id,
          chat_id: msg.chat_id,
          sender: msg.sender,
          content: msg.content,
          timestamp: msg.timestamp,
          created_at: Math.floor(Date.now() / 1000),
        },
        refresh: true,
      });
    },
    undefined,
    'insertMessage',
    { deadLetter: true, payload: msg }
  );
}

export async function getRecentMessages(chatId: string, limit = 5): Promise<Message[]> {
  const es = getClient();
  const res = await es.search({
    index: INDICES.messages,
    size: limit,
    query: { term: { chat_id: chatId } },
    sort: [{ timestamp: 'desc' }],
  });
  return res.hits.hits.map(h => h._source as Message);
}

export async function getMessageById(id: string): Promise<Message | undefined> {
  const es = getClient();
  try {
    const res = await es.get({ index: INDICES.messages, id });
    return res._source as Message;
  } catch {
    return undefined;
  }
}

// ============ Event Operations ============

export async function findDuplicateEvent(title: string, hoursWindow: number = 48): Promise<Event | null> {
  const es = getClient();
  const cutoff = Math.floor(Date.now() / 1000) - hoursWindow * 60 * 60;
  const normalizedTitle = title.trim().toLowerCase();

  // Search for similar titles in active events within the time window
  const res = await es.search({
    index: INDICES.events,
    size: 100,
    query: {
      bool: {
        must: [{ range: { created_at: { gte: cutoff } } }],
        must_not: [
          { terms: { status: ['completed', 'expired', 'ignored'] } },
        ],
      },
    },
    sort: [{ created_at: 'desc' }],
  });

  for (const hit of res.hits.hits) {
    const source = hit._source as Record<string, any>;
    const existingTitle = (source.title || '').trim().toLowerCase();

    const existingWords = existingTitle.split(/\s+/).length;
    const newWords = normalizedTitle.split(/\s+/).length;

    if (existingWords <= 2 || newWords <= 2) {
      const cleanExisting = existingTitle.replace(/[''`\-]/g, '');
      const cleanNew = normalizedTitle.replace(/[''`\-]/g, '');
      if (cleanExisting === cleanNew) {
        return mapEvent(source);
      }
      continue;
    }

    if (existingTitle.includes(normalizedTitle) || normalizedTitle.includes(existingTitle)) {
      return mapEvent(source);
    }
    const cleanExisting = existingTitle.replace(/[''`\-]/g, '');
    const cleanNew = normalizedTitle.replace(/[''`\-]/g, '');
    if (cleanExisting === cleanNew) {
      return mapEvent(source);
    }
  }

  return null;
}

export async function insertEvent(event: Omit<Event, 'id' | 'created_at'>): Promise<number> {
  return safeAsync(
    async () => {
      const es = getClient();
      const id = nextEventId();
      const now = Math.floor(Date.now() / 1000);

      // Generate embedding for kNN hybrid search (silent failure — BM25-only fallback)
      const embeddingText = buildEventEmbeddingText({
        title: event.title,
        description: event.description,
        keywords: event.keywords,
        location: event.location,
      });
      const embedding = await generateEmbedding(embeddingText);
      if (embedding) {
        console.log(`🔢 [ES] Generated embedding (${embedding.length} dims) for event: "${event.title}"`);
      } else {
        console.log(`⚠️ [ES] No embedding for event "${event.title}" — BM25-only search until backfill`);
      }

      await es.index({
        index: INDICES.events,
        id: String(id),
        document: {
          id,
          message_id: event.message_id,
          event_type: event.event_type,
          title: event.title,
          description: event.description,
          event_time: event.event_time,
          location: event.location,
          participants: event.participants,
          keywords: event.keywords,
          embedding,           // null if generation failed — ES accepts null for dense_vector
          confidence: event.confidence,
          status: event.status || 'discovered',
          context_url: event.context_url || null,
          sender_name: event.sender_name || null,
          reminder_time: null,
          dismiss_count: 0,
          created_at: now,
        },
        refresh: true,
      });

      return id;
    },
    -1,
    'insertEvent',
    { deadLetter: true, payload: event }
  );
}

export async function getEventById(id: number): Promise<Event | undefined> {
  const es = getClient();
  try {
    const res = await es.get({ index: INDICES.events, id: String(id) });
    return mapEvent(res._source as Record<string, any>);
  } catch {
    return undefined;
  }
}

export async function getPendingEvents(limit = 50): Promise<Event[]> {
  const es = getClient();
  const res = await es.search({
    index: INDICES.events,
    size: limit,
    query: { term: { status: 'pending' } },
    sort: [{ created_at: 'desc' }],
  });
  return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
}

export async function getRecentEvents(days = 90, limit = 100): Promise<Event[]> {
  const es = getClient();
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const res = await es.search({
    index: INDICES.events,
    size: limit,
    query: {
      bool: {
        filter: [
          { range: { created_at: { gte: cutoff } } },
          { term: { status: 'pending' } },
        ],
      },
    },
    sort: [{ created_at: 'desc' }],
  });
  return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
}

export async function updateEventStatus(id: number, status: EventStatus): Promise<void> {
  await safeAsync(
    async () => {
      const es = getClient();
      await es.update({
        index: INDICES.events,
        id: String(id),
        doc: { status },
        refresh: true,
      });
      console.log(`📝 [ES] Event ${id} status → ${status}`);
    },
    undefined,
    'updateEventStatus',
    { deadLetter: true, payload: { id, status } }
  );
}

// ============ Search Operations ============
export async function searchEventsByLocation(location: string, days = 90, limit = 10): Promise<Event[]> {
  const es = getClient();
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const res = await es.search({
    index: INDICES.events,
    size: limit,
    query: {
      bool: {
        must: [
          {
            match: { 'location': { query: location, fuzziness: 'AUTO' } },
          },
        ],
        filter: [
          { terms: { status: ['pending', 'scheduled', 'discovered'] } },
          { range: { created_at: { gte: cutoff } } },
        ],
      },
    },
    sort: [{ created_at: 'desc' }],
  });
  return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
}

export async function searchEventsByKeywords(keywords: string[], days = 90, limit = 10): Promise<Event[]> {
  const es = getClient();
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;

  // Try exact location match first
  for (const kw of keywords) {
    const exact = await searchEventsByLocation(kw, days, limit);
    if (exact.length > 0) return exact;
  }

  // Multi-match across title, description, keywords, location
  const queryString = keywords.join(' ');
  const res = await es.search({
    index: INDICES.events,
    size: limit,
    query: {
      bool: {
        must: [
          {
            multi_match: {
              query: queryString,
              fields: ['title^3', 'keywords^2', 'description', 'location'],
              type: 'best_fields',
              fuzziness: 'AUTO',
            },
          },
        ],
        filter: [
          { terms: { status: ['pending', 'scheduled', 'discovered'] } },
          { range: { created_at: { gte: cutoff } } },
        ],
      },
    },
    sort: [{ _score: { order: 'desc' } }],
  });
  return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
}

// ============ Hybrid Search (kNN + BM25) ============

/**
 * Combines kNN vector search (semantic) with BM25 keyword search.
 * Falls back to BM25-only if queryVector is null (embedding not available).
 * ES merges scores via Reciprocal Rank Fusion (RRF) when both are provided.
 */
export async function hybridSearchEvents(
  queryText: string,
  queryVector: number[] | null,
  days = 90,
  limit = 10
): Promise<Event[]> {
  const es = getClient();
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;

  const bm25Query = {
    bool: {
      must: [
        {
          multi_match: {
            query: queryText,
            fields: ['title^3', 'keywords^2', 'description', 'location'],
            type: 'best_fields' as const,
            fuzziness: 'AUTO',
          },
        },
      ],
      filter: [
        { terms: { status: ['pending', 'scheduled', 'discovered'] } },
        { range: { created_at: { gte: cutoff } } },
      ],
    },
  };

  const searchParams: Record<string, unknown> = {
    index: INDICES.events,
    size: limit,
    query: bm25Query,
    sort: [{ _score: { order: 'desc' } }],
  };

  if (queryVector && queryVector.length > 0) {
    searchParams.knn = {
      field: 'embedding',
      query_vector: queryVector,
      k: limit,
      num_candidates: 50,
      filter: { terms: { status: ['pending', 'scheduled', 'discovered'] } },
    };
  }

  try {
    const res = await es.search(searchParams as any);
    return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ [hybridSearchEvents] ${msg}`);
    return [];
  }
}

// ============ Embedding Backfill Helpers ============

/** Returns events that have no embedding (for backfill after Gemini outage). */
export async function getEventsWithoutEmbeddings(limit = 50): Promise<Event[]> {
  const es = getClient();
  const res = await es.search({
    index: INDICES.events,
    size: limit,
    query: {
      bool: {
        must_not: [{ exists: { field: 'embedding' } }],
      },
    } as any,
    sort: [{ created_at: 'desc' }],
  });
  return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
}

/** Stores a generated embedding on an existing event document. */
export async function updateEventEmbedding(eventId: number, embedding: number[]): Promise<void> {
  const es = getClient();
  await es.update({
    index: INDICES.events,
    id: String(eventId),
    doc: { embedding },
    refresh: false, // No need for immediate refresh during backfill
  });
}

// ============ Trigger Operations ============
export async function insertTrigger(trigger: Omit<Trigger, 'id' | 'created_at'>): Promise<number> {
  return safeAsync(
    async () => {
      const es = getClient();
      const id = nextTriggerId();
      const now = Math.floor(Date.now() / 1000);

      await es.index({
        index: INDICES.triggers,
        id: String(id),
        document: {
          id,
          event_id: trigger.event_id,
          trigger_type: trigger.trigger_type,
          trigger_value: trigger.trigger_value,
          is_fired: trigger.is_fired ? true : false,
          fire_count: 0,
          created_at: now,
        },
        refresh: true,
      });

      return id;
    },
    -1,
    'insertTrigger',
    { deadLetter: true, payload: trigger }
  );
}

export async function getUnfiredTriggersByType(type: string): Promise<Trigger[]> {
  const es = getClient();
  const res = await es.search({
    index: INDICES.triggers,
    size: 100,
    query: {
      bool: {
        filter: [
          { term: { trigger_type: type } },
          { term: { is_fired: false } },
        ],
      },
    },
  });
  return res.hits.hits.map(h => h._source as Trigger);
}

export async function getUnfiredUrlTriggers(): Promise<(Trigger & { title?: string; description?: string | null })[]> {
  const es = getClient();
  const res = await es.search({
    index: INDICES.triggers,
    size: 100,
    query: {
      bool: {
        filter: [
          { term: { trigger_type: 'url' } },
          { term: { is_fired: false } },
        ],
      },
    },
  });

  const triggers = res.hits.hits.map(h => h._source as Trigger);
  const result: (Trigger & { title?: string; description?: string | null })[] = [];

  for (const trigger of triggers) {
    const event = await getEventById(trigger.event_id);
    if (event && event.status === 'pending') {
      result.push({ ...trigger, title: event.title, description: event.description });
    }
  }

  return result;
}

export async function markTriggerFired(id: number): Promise<void> {
  const es = getClient();
  await es.update({
    index: INDICES.triggers,
    id: String(id),
    doc: { is_fired: true },
    refresh: true,
  });
}

// ============ Contact Operations ============
export async function upsertContact(contact: Contact): Promise<void> {
  const es = getClient();
  try {
    const existing = await es.get({ index: INDICES.contacts, id: contact.id });
    const source = existing._source as Record<string, any>;
    await es.update({
      index: INDICES.contacts,
      id: contact.id,
      doc: {
        name: contact.name || source.name,
        last_seen: contact.last_seen,
        message_count: (source.message_count || 0) + 1,
      },
      refresh: true,
    });
  } catch {
    await es.index({
      index: INDICES.contacts,
      id: contact.id,
      document: {
        id: contact.id,
        name: contact.name,
        first_seen: contact.first_seen,
        last_seen: contact.last_seen,
        message_count: contact.message_count || 1,
      },
      refresh: true,
    });
  }
}

// ============ Stats ============
export type EventStatus = 'discovered' | 'scheduled' | 'snoozed' | 'ignored' | 'reminded' | 'completed' | 'expired';

export async function getStats(): Promise<{
  messages: number;
  events: number;
  triggers: number;
  discoveredEvents: number;
  scheduledEvents: number;
  snoozedEvents: number;
  ignoredEvents: number;
  remindedEvents: number;
  completedEvents: number;
  expiredEvents: number;
  pendingEvents: number;
}> {
  const es = getClient();

  const [messagesCount, eventsAgg, triggersCount] = await Promise.all([
    es.count({ index: INDICES.messages }).then(r => r.count).catch(() => 0),
    es.search({
      index: INDICES.events,
      size: 0,
      aggs: {
        by_status: { terms: { field: 'status', size: 20 } },
      },
    }).catch(() => null),
    es.count({ index: INDICES.triggers }).then(r => r.count).catch(() => 0),
  ]);

  const statusCounts: Record<string, number> = {};
  if (eventsAgg?.aggregations?.by_status) {
    const buckets = (eventsAgg.aggregations.by_status as any).buckets || [];
    for (const b of buckets) {
      statusCounts[b.key] = b.doc_count;
    }
  }

  const totalEvents = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const discovered = statusCounts['discovered'] || 0;
  const snoozed = statusCounts['snoozed'] || 0;

  return {
    messages: messagesCount,
    events: totalEvents,
    triggers: triggersCount,
    discoveredEvents: discovered,
    scheduledEvents: statusCounts['scheduled'] || 0,
    snoozedEvents: snoozed,
    ignoredEvents: statusCounts['ignored'] || 0,
    remindedEvents: statusCounts['reminded'] || 0,
    completedEvents: statusCounts['completed'] || 0,
    expiredEvents: statusCounts['expired'] || 0,
    pendingEvents: discovered + snoozed,
  };
}

// ============ Message Queries ============
export async function getAllMessages(options: {
  limit?: number;
  offset?: number;
  sender?: string;
}): Promise<Message[]> {
  const { limit = 50, offset = 0, sender } = options;
  const es = getClient();

  const query = sender
    ? { term: { sender } }
    : { match_all: {} };

  const res = await es.search({
    index: INDICES.messages,
    size: limit,
    from: offset,
    query,
    sort: [{ timestamp: 'desc' }],
  });
  return res.hits.hits.map(h => h._source as Message);
}

// ============ Event Queries ============
export async function getAllEvents(options: {
  limit?: number;
  offset?: number;
  status?: EventStatus | 'all' | 'active';
}): Promise<(Event & { source_message?: string; source_sender?: string })[]> {
  const { limit = 50, offset = 0, status = 'all' } = options;
  const es = getClient();

  let query: any;
  if (status === 'active') {
    query = { terms: { status: ['discovered', 'scheduled', 'snoozed', 'reminded'] } };
  } else if (status !== 'all') {
    query = { term: { status } };
  } else {
    query = { match_all: {} };
  }

  const res = await es.search({
    index: INDICES.events,
    size: limit,
    from: offset,
    query,
    sort: [{ created_at: 'desc' }],
  });

  const events: (Event & { source_message?: string; source_sender?: string })[] = [];
  for (const hit of res.hits.hits) {
    const ev = mapEvent(hit._source as Record<string, any>);
    // Try to get source message
    if (ev.message_id) {
      const msg = await getMessageById(ev.message_id);
      if (msg) {
        (ev as any).source_message = msg.content;
        (ev as any).source_sender = msg.sender;
      }
    }
    events.push(ev as Event & { source_message?: string; source_sender?: string });
  }

  return events;
}

// Find pending events matching keywords (for updates/cancellations)
export async function findPendingEventsByKeywords(keywords: string[]): Promise<Event[]> {
  if (keywords.length === 0) return [];
  const es = getClient();

  const res = await es.search({
    index: INDICES.events,
    size: 10,
    query: {
      bool: {
        must: [
          {
            multi_match: {
              query: keywords.join(' '),
              fields: ['keywords', 'title'],
              fuzziness: 'AUTO',
            },
          },
        ],
        filter: [{ term: { status: 'pending' } }],
      },
    },
    sort: [{ created_at: 'desc' }],
  });
  return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
}

// Find active events by keywords
export async function findActiveEventsByKeywords(keywords: string[]): Promise<Event[]> {
  if (keywords.length === 0) return [];
  const es = getClient();

  const res = await es.search({
    index: INDICES.events,
    size: 10,
    query: {
      bool: {
        must: [
          {
            multi_match: {
              query: keywords.join(' '),
              fields: ['keywords^2', 'title^3', 'description', 'location'],
              type: 'best_fields',
              fuzziness: 'AUTO',
            },
          },
        ],
        must_not: [
          { terms: { status: ['completed', 'expired', 'ignored'] } },
        ],
      },
    },
    sort: [{ created_at: 'desc' }],
  });
  return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
}

// Get all active events
export async function getActiveEvents(limit = 20): Promise<Event[]> {
  const es = getClient();
  const res = await es.search({
    index: INDICES.events,
    size: limit,
    query: {
      bool: {
        must_not: [
          { terms: { status: ['completed', 'expired', 'ignored', 'dismissed'] } },
        ],
      },
    },
    sort: [{ created_at: 'desc' }],
  });
  return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
}

// Update event time
export async function updateEventTime(eventId: number, newTime: number): Promise<void> {
  const es = getClient();
  await es.update({
    index: INDICES.events,
    id: String(eventId),
    doc: { event_time: newTime },
    refresh: true,
  });
  console.log(`📝 [ES] Event ${eventId} time updated to ${new Date(newTime * 1000).toISOString()}`);
}

// General-purpose event update
export async function updateEvent(eventId: number, fields: {
  title?: string;
  description?: string | null;
  event_time?: number | null;
  location?: string | null;
  keywords?: string;
  context_url?: string | null;
  event_type?: string;
  participants?: string;
  status?: string;
  sender_name?: string | null;
}): Promise<boolean> {
  return safeAsync(
    async () => {
      const event = await getEventById(eventId);
      if (!event) {
        console.log(`❌ [ES] updateEvent: Event ${eventId} not found`);
        return false;
      }

      const doc: Record<string, any> = {};
      if (fields.title !== undefined) doc.title = fields.title;
      if (fields.description !== undefined) doc.description = fields.description;
      if (fields.event_time !== undefined) doc.event_time = fields.event_time;
      if (fields.location !== undefined) doc.location = fields.location;
      if (fields.keywords !== undefined) doc.keywords = fields.keywords;
      if (fields.context_url !== undefined) doc.context_url = fields.context_url;
      if (fields.event_type !== undefined) doc.event_type = fields.event_type;
      if (fields.participants !== undefined) doc.participants = fields.participants;
      if (fields.status !== undefined) doc.status = fields.status;
      if (fields.sender_name !== undefined) doc.sender_name = fields.sender_name;

      if (Object.keys(doc).length === 0) {
        console.log(`⏭️ [ES] updateEvent: No fields to update for event ${eventId}`);
        return false;
      }

      const es = getClient();
      await es.update({
        index: INDICES.events,
        id: String(eventId),
        doc,
        refresh: true,
      });

      const changedFields = Object.keys(doc).join(', ');
      console.log(`📝 [ES] Event ${eventId} updated: [${changedFields}]`);
      return true;
    },
    false,
    'updateEvent',
    { deadLetter: true, payload: { eventId, fields } }
  );
}

export async function deleteEvent(id: number): Promise<void> {
  await safeAsync(
    async () => {
      const es = getClient();
      // Delete associated triggers
      await es.deleteByQuery({
        index: INDICES.triggers,
        query: { term: { event_id: id } },
        refresh: true,
      });
      // Delete context dismissals
      await es.deleteByQuery({
        index: INDICES.contextDismissals,
        query: { term: { event_id: id } },
        refresh: true,
      });
      // Delete the event
      try {
        await es.delete({ index: INDICES.events, id: String(id), refresh: true });
      } catch {
        // Already deleted
      }
    },
    undefined,
    'deleteEvent'
  );
}

// ============ Enhanced Event Operations ============

export async function scheduleEventReminder(eventId: number): Promise<void> {
  const event = await getEventById(eventId);
  if (!event) {
    await updateEventStatus(eventId, 'scheduled');
    return;
  }

  if (!event.event_time) {
    await updateEventStatus(eventId, 'scheduled');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const intervals: Array<{ type: TriggerType; offset: number }> = [
    { type: 'reminder_24h', offset: 24 * 60 * 60 },
    { type: 'reminder_1hr', offset: 60 * 60 },
    { type: 'reminder_15m', offset: 15 * 60 },
  ];

  let primaryReminderTime: number | null = null;
  for (const { type, offset } of intervals) {
    const triggerTime = event.event_time - offset;
    if (triggerTime > now) {
      if (!primaryReminderTime) primaryReminderTime = triggerTime;
      await insertTrigger({
        event_id: eventId,
        trigger_type: type,
        trigger_value: triggerTime.toString(),
        is_fired: false,
      });
    }
  }

  const es = getClient();
  if (primaryReminderTime) {
    await es.update({
      index: INDICES.events,
      id: String(eventId),
      doc: { status: 'scheduled', reminder_time: primaryReminderTime },
      refresh: true,
    });
  } else {
    await es.update({
      index: INDICES.events,
      id: String(eventId),
      doc: { status: 'scheduled' },
      refresh: true,
    });
  }
}

export async function getDueReminders(): Promise<Event[]> {
  const es = getClient();
  const now = Math.floor(Date.now() / 1000);
  const res = await es.search({
    index: INDICES.events,
    size: 50,
    query: {
      bool: {
        filter: [
          { term: { status: 'scheduled' } },
          { range: { reminder_time: { lte: now } } },
          { exists: { field: 'reminder_time' } },
        ],
      },
    },
    sort: [{ reminder_time: 'asc' }],
  });
  return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
}

export async function markEventReminded(eventId: number): Promise<void> {
  const es = getClient();
  await es.update({
    index: INDICES.events,
    id: String(eventId),
    doc: { status: 'reminded' },
    refresh: true,
  });
}

// Get events with context URL that match a given URL
export async function getContextEventsForUrl(url: string): Promise<Event[]> {
  const es = getClient();
  const urlLower = url.toLowerCase();
  console.log(`🔎 [ES] getContextEventsForUrl: url="${url}"`);

  // Get all scheduled events with context_url or location
  const res = await es.search({
    index: INDICES.events,
    size: 50,
    query: {
      bool: {
        filter: [{ term: { status: 'scheduled' } }],
        should: [
          { exists: { field: 'context_url' } },
          { exists: { field: 'location' } },
        ],
        minimum_should_match: 1,
      },
    },
  });

  const results: Event[] = [];
  for (const hit of res.hits.hits) {
    const source = hit._source as Record<string, any>;
    const contextUrl = (source.context_url || '').toLowerCase();
    const location = (source.location || '').toLowerCase();

    // Match by context_url
    if (contextUrl && urlLower.includes(contextUrl)) {
      results.push(mapEvent(source));
      continue;
    }
    // Match by location when context_url is empty
    if (location && !contextUrl && urlLower.includes(location)) {
      results.push(mapEvent(source));
    }
  }

  console.log(`📊 [ES] Query returned ${results.length} event(s) with status='scheduled'`);
  if (results.length > 0) {
    results.forEach(e => {
      console.log(`   └─ Event #${e.id}: "${e.title}" (status: ${e.status}, context_url: ${e.context_url}, location: ${e.location})`);
    });
  }
  return results;
}

// Get all events for a specific day
export async function getEventsForDay(dayTimestamp: number): Promise<Event[]> {
  const d = new Date(dayTimestamp * 1000);
  d.setHours(0, 0, 0, 0);
  const startOfDay = Math.floor(d.getTime() / 1000);
  const endOfDay = startOfDay + 24 * 60 * 60;

  const es = getClient();
  const res = await es.search({
    index: INDICES.events,
    size: 50,
    query: {
      bool: {
        filter: [
          { range: { event_time: { gte: startOfDay, lte: endOfDay } } },
          { exists: { field: 'event_time' } },
        ],
        must_not: [{ terms: { status: ['ignored', 'expired'] } }],
      },
    },
    sort: [{ event_time: 'asc' }],
  });
  return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
}

// Check for calendar conflicts
export async function checkEventConflicts(eventTime: number, durationMinutes = 60): Promise<Event[]> {
  const startWindow = eventTime - (durationMinutes * 60);
  const endWindow = eventTime + (durationMinutes * 60);

  const es = getClient();
  const res = await es.search({
    index: INDICES.events,
    size: 20,
    query: {
      bool: {
        filter: [
          { range: { event_time: { gte: startWindow, lte: endWindow } } },
          { exists: { field: 'event_time' } },
        ],
        must_not: [{ terms: { status: ['completed', 'expired'] } }],
      },
    },
    sort: [{ event_time: 'asc' }],
  });
  return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
}

// Dismiss a context event for a URL
export async function dismissContextEvent(eventId: number, urlPattern: string, permanent = false): Promise<void> {
  console.log(`💾 [ES] dismissContextEvent: eventId=${eventId}, urlPattern="${urlPattern}", permanent=${permanent}`);
  if (permanent) {
    await updateEventStatus(eventId, 'completed');
    console.log(`✅ [ES] Event ${eventId} permanently dismissed (status → completed)`);
  } else {
    // Increment dismiss count
    const event = await getEventById(eventId);
    if (event) {
      const es = getClient();
      await es.update({
        index: INDICES.events,
        id: String(eventId),
        doc: { dismiss_count: (event.dismiss_count || 0) + 1 },
        refresh: true,
      });
      console.log(`🕐 [ES] Event ${eventId} temporarily dismissed (dismiss_count incremented)`);
    }

    // Store dismissal with URL pattern
    if (urlPattern) {
      try {
        const es = getClient();
        const dismissUntil = Math.floor(Date.now() / 1000) + 1800;
        await es.index({
          index: INDICES.contextDismissals,
          document: {
            event_id: eventId,
            url_pattern: urlPattern,
            dismissed_until: dismissUntil,
            created_at: Math.floor(Date.now() / 1000),
          },
          refresh: true,
        });
      } catch {
        // Ignore errors
      }
    }
  }
}

// Set context URL for an event
export async function setEventContextUrl(eventId: number, contextUrl: string): Promise<void> {
  const es = getClient();
  await es.update({
    index: INDICES.events,
    id: String(eventId),
    doc: { context_url: contextUrl },
    refresh: true,
  });

  await insertTrigger({
    event_id: eventId,
    trigger_type: 'url',
    trigger_value: contextUrl,
    is_fired: false,
  });
}

// ============ Event Status Actions ============

export async function snoozeEvent(eventId: number, snoozeMinutes = 30): Promise<void> {
  const snoozeUntil = Math.floor(Date.now() / 1000) + (snoozeMinutes * 60);
  const es = getClient();
  await es.update({
    index: INDICES.events,
    id: String(eventId),
    doc: { status: 'snoozed', reminder_time: snoozeUntil },
    refresh: true,
  });
  console.log(`💤 [ES] Event ${eventId} snoozed until ${new Date(snoozeUntil * 1000).toLocaleTimeString()}`);
}

export async function ignoreEvent(eventId: number): Promise<void> {
  const es = getClient();
  await es.update({
    index: INDICES.events,
    id: String(eventId),
    doc: { status: 'ignored' },
    refresh: true,
  });
  console.log(`🚫 [ES] Event ${eventId} ignored`);
}

export async function completeEvent(eventId: number): Promise<void> {
  const es = getClient();
  await es.update({
    index: INDICES.events,
    id: String(eventId),
    doc: { status: 'completed' },
    refresh: true,
  });
  console.log(`✅ [ES] Event ${eventId} completed`);
}

export async function getDueSnoozedEvents(): Promise<Event[]> {
  const es = getClient();
  const now = Math.floor(Date.now() / 1000);
  const res = await es.search({
    index: INDICES.events,
    size: 50,
    query: {
      bool: {
        filter: [
          { term: { status: 'snoozed' } },
          { range: { reminder_time: { lte: now } } },
          { exists: { field: 'reminder_time' } },
        ],
      },
    },
    sort: [{ reminder_time: 'asc' }],
  });
  return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
}

export async function getEventsByStatus(status: string, limit = 50): Promise<Event[]> {
  const es = getClient();
  const res = await es.search({
    index: INDICES.events,
    size: limit,
    query: { term: { status } },
    sort: [{ created_at: 'desc' }],
  });
  return res.hits.hits.map(h => mapEvent(h._source as Record<string, any>));
}

export async function closeElastic(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
