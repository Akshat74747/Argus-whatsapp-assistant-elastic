import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { initElastic, getStats, getEventById, closeElastic, getAllMessages, getAllEvents, deleteEvent, scheduleEventReminder, dismissContextEvent, setEventContextUrl, getEventsByStatus, snoozeEvent, ignoreEvent, completeEvent as dbCompleteEvent, getEventsForDay, updateEvent, searchEventsByKeywords } from './elastic.js';
import { initGemini, chatWithContext, generatePopupBlueprint } from './gemini.js';
import { processWebhook } from './ingestion.js';
import { matchContext, extractContextFromUrl } from './matcher.js';
import { startScheduler, stopScheduler, checkContextTriggers } from './scheduler.js';
import { parseConfig, WhatsAppWebhookSchema, ContextCheckRequestSchema } from './types.js';
import {
  initEvolutionDb,
  testEvolutionConnection,
  getEvolutionMessages,
  getEvolutionStats,
  getEvolutionInstances,
  getEvolutionContacts,
  getEvolutionChats,
  searchEvolutionMessages,
  closeEvolutionDb,
  getInstanceIdByName
} from './evolution-db.js';

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolved instance ID (UUID)
let resolvedInstanceId: string | null = null;

// Load config
const config = parseConfig();

// Initialize Gemini (sync)
initGemini({
  apiKey: config.geminiApiKey,
  model: config.geminiModel,
  apiUrl: config.geminiApiUrl,
});

// Initialize Evolution PostgreSQL if configured
let evolutionDbReady = false;
if (config.evolutionPg) {
  initEvolutionDb(config.evolutionPg);
  testEvolutionConnection().then(async (ok) => {
    evolutionDbReady = ok;
    if (ok) {
      console.log('✅ Evolution PostgreSQL connected');
      // Resolve instance name to ID
      if (config.evolutionInstanceName) {
        resolvedInstanceId = await getInstanceIdByName(config.evolutionInstanceName);
        if (resolvedInstanceId) {
          console.log(`✅ Instance "${config.evolutionInstanceName}" → ${resolvedInstanceId}`);
        } else {
          console.log(`⚠️ Instance "${config.evolutionInstanceName}" not found, will query all`);
        }
      } else {
        console.log('⚠️ No instance name configured, will query all');
      }
    } else {
      console.log('⚠️ Evolution PostgreSQL not available');
    }
  });
}

// ============ Auto-setup Evolution API Instance ============
async function autoSetupEvolution(): Promise<void> {
  const apiUrl = config.evolutionApiUrl;
  const apiKey = config.evolutionApiKey;
  const instanceName = config.evolutionInstanceName;

  if (!apiUrl || !apiKey || !instanceName) {
    console.log('⚠️ Evolution API not configured, skipping auto-setup');
    return;
  }

  const headers = { 'Content-Type': 'application/json', apikey: apiKey };
  const selfHost = process.env.DOCKER_ENV === 'true' ? `http://argus:${config.port}` : `http://localhost:${config.port}`;
  const webhookUrl = `${selfHost}/api/webhook/whatsapp`;

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const fetchRes = await fetch(`${apiUrl}/instance/fetchInstances`, { headers });
      if (!fetchRes.ok) throw new Error(`fetchInstances: ${fetchRes.status}`);

      const instances = await fetchRes.json() as Array<{ name?: string; connectionStatus?: string }>;
      const existing = instances.find((i) => i.name === instanceName);

      if (existing) {
        console.log(`✅ Evolution instance "${instanceName}" exists (status: ${existing.connectionStatus || 'unknown'})`);
      } else {
        console.log(`🔧 Creating Evolution instance "${instanceName}"...`);
        const createRes = await fetch(`${apiUrl}/instance/create`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            instanceName,
            integration: 'WHATSAPP-BAILEYS',
            qrcode: true,
            webhook: {
              enabled: true,
              url: webhookUrl,
              byEvents: false,
              base64: false,
              events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'],
            },
          }),
        });

        if (createRes.status === 403) {
          console.log(`✅ Instance "${instanceName}" already exists in DB (restarted)`);
        } else if (!createRes.ok) {
          const errBody = await createRes.text();
          throw new Error(`createInstance: ${createRes.status} — ${errBody}`);
        } else {
          const created = await createRes.json() as Record<string, unknown>;
          console.log(`✅ Instance "${instanceName}" created`);
          if ((created?.qrcode as Record<string, unknown>)?.base64) {
            console.log(`📱 QR Code ready — open Evolution Manager at ${apiUrl} to scan`);
          }
        }
      }

      try {
        const whRes = await fetch(`${apiUrl}/webhook/set/${instanceName}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            webhook: {
              enabled: true,
              url: webhookUrl,
              byEvents: false,
              base64: false,
              events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'],
            },
          }),
        });
        if (whRes.ok) {
          console.log(`✅ Webhook → ${webhookUrl}`);
        } else {
          console.log(`ℹ️  Per-instance webhook: ${whRes.status} (global webhook is backup)`);
        }
      } catch {
        console.log('ℹ️  Per-instance webhook skipped (global webhook active)');
      }

      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < 10) {
        console.log(`⏳ Evolution API not ready (attempt ${attempt}/10): ${msg}`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        console.log(`⚠️ Evolution auto-setup failed after 10 attempts: ${msg}`);
        console.log('   → Create instance manually at Evolution Manager dashboard');
      }
    }
  }
}

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Serve static files (dashboard)
app.use(express.static(join(__dirname, 'public')));

// Create HTTP server
const server = createServer(app);

// WebSocket server for real-time notifications
const wss = new WebSocketServer({ server });
const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('🔌 WebSocket client connected');

  ws.on('close', () => {
    clients.delete(ws);
    console.log('🔌 WebSocket client disconnected');
  });
});

function broadcast(data: object): void {
  const message = JSON.stringify(data);
  const type = 'type' in data ? (data as { type: string }).type : 'unknown';
  console.log(`📢 Broadcasting to ${clients.size} clients:`, type);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      console.log('   ✅ Sent to client');
    }
  }
}

// ============ API Routes ============

// Health check
app.get('/api/health', async (_req: Request, res: Response) => {
  const evolutionOk = evolutionDbReady ? await testEvolutionConnection() : false;
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    model: config.geminiModel,
    version: '3.0.0-elastic',
    evolutionDb: evolutionOk ? 'connected' : 'disconnected',
    elastic: 'connected',
  });
});

// Stats (combined Argus + Evolution)
app.get('/api/stats', async (_req: Request, res: Response) => {
  const argusStats = await getStats();
  let evolutionStats = null;

  if (evolutionDbReady) {
    evolutionStats = await getEvolutionStats(config.evolutionInstanceName);
  }

  res.json({
    ...argusStats,
    evolution: evolutionStats,
  });
});

// Get events (with status filter)
app.get('/api/events', async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;
  const status = (req.query.status as string) || 'all';

  const events = await getAllEvents({ limit, offset, status: status as any });
  res.json(events);
});

// Get single event
app.get('/api/events/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const event = await getEventById(id);
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  res.json(event);
});

// ============ Event Actions ============

// Complete event (mark as done)
app.post('/api/events/:id/complete', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  console.log(`✅ [COMPLETE] Event ${id} marked as done`);
  await dbCompleteEvent(id);
  broadcast({ type: 'event_completed', eventId: id });
  res.json({ success: true, message: 'Event completed' });
});

// Schedule event (approve for reminders)
app.post('/api/events/:id/set-reminder', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const event = await getEventById(id);

  if (!event) {
    console.log(`❌ [SCHEDULE] Event ${id} not found`);
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  console.log(`📅 [SCHEDULE] Event ${id}: "${event.title}" → scheduled`);
  await scheduleEventReminder(id);
  broadcast({ type: 'event_scheduled', eventId: id });
  res.json({ success: true, message: 'Event scheduled for reminders' });
});

// Snooze event
app.post('/api/events/:id/snooze', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const { minutes } = req.body;
  const snoozeMinutes = minutes || 30;

  console.log(`💤 [SNOOZE] Event ${id} snoozed for ${snoozeMinutes} minutes`);
  await snoozeEvent(id, snoozeMinutes);
  broadcast({ type: 'event_snoozed', eventId: id, snoozeMinutes });
  res.json({ success: true, message: `Event snoozed for ${snoozeMinutes} minutes` });
});

// Ignore event
app.post('/api/events/:id/ignore', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  console.log(`🚫 [IGNORE] Event ${id} ignored by user`);
  await ignoreEvent(id);
  broadcast({ type: 'event_ignored', eventId: id });
  res.json({ success: true, message: 'Event ignored' });
});

// Dismiss context reminder
app.post('/api/events/:id/dismiss', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const { permanent, urlPattern } = req.body;

  console.log(`🔕 [DISMISS] Event ${id} context dismissed (permanent: ${permanent})`);
  await dismissContextEvent(id, urlPattern || '', permanent === true);
  broadcast({ type: 'event_dismissed', eventId: id, permanent });
  res.json({ success: true });
});

// Delete event
app.delete('/api/events/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  console.log(`🗑️ [DELETE] Event ${id} permanently deleted`);
  await deleteEvent(id);
  broadcast({ type: 'event_deleted', eventId: id });
  res.json({ success: true, message: 'Event deleted' });
});

// Update event (general-purpose CRUD)
app.patch('/api/events/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const event = await getEventById(id);

  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  const { title, description, event_time, location, keywords, context_url, event_type, participants, status, sender_name } = req.body;

  const fields: Record<string, any> = {};
  if (title !== undefined) fields.title = title;
  if (description !== undefined) fields.description = description;
  if (event_time !== undefined) fields.event_time = event_time;
  if (location !== undefined) fields.location = location;
  if (keywords !== undefined) fields.keywords = keywords;
  if (context_url !== undefined) fields.context_url = context_url;
  if (event_type !== undefined) fields.event_type = event_type;
  if (participants !== undefined) fields.participants = participants;
  if (status !== undefined) fields.status = status;
  if (sender_name !== undefined) fields.sender_name = sender_name;

  if (Object.keys(fields).length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  const updated = await updateEvent(id, fields);
  if (updated) {
    console.log(`📝 [PATCH] Event ${id}: "${event.title}" updated [${Object.keys(fields).join(', ')}]`);
    broadcast({ type: 'event_updated', eventId: id, fields: Object.keys(fields) });
    const updatedEvent = await getEventById(id);
    res.json({ success: true, event: updatedEvent });
  } else {
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// Confirm a pending modify action
app.post('/api/events/:id/confirm-update', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const event = await getEventById(id);
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  const { changes } = req.body;
  if (!changes || typeof changes !== 'object' || Object.keys(changes).length === 0) {
    res.status(400).json({ error: 'No changes provided' });
    return;
  }

  const updated = await updateEvent(id, changes);
  if (updated) {
    const changedStr = Object.keys(changes).join(', ');
    console.log(`✅ [CONFIRM-UPDATE] Event #${id} "${event.title}" updated: [${changedStr}]`);
    broadcast({
      type: 'action_performed',
      action: 'modify',
      eventId: id,
      eventTitle: event.title,
      message: `Updated "${event.title}": changed ${changedStr}`,
    });
    const updatedEvent = await getEventById(id);
    res.json({ success: true, event: updatedEvent });
  } else {
    res.status(500).json({ error: 'Failed to apply update' });
  }
});

// ============ Legacy Endpoints ============

app.post('/api/events/:id/acknowledge', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  broadcast({ type: 'event_acknowledged', eventId: id });
  res.json({ success: true, message: 'Reminder acknowledged' });
});

app.post('/api/events/:id/done', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  await dbCompleteEvent(id);
  broadcast({ type: 'event_completed', eventId: id });
  res.json({ success: true, message: 'Event marked as done' });
});

app.post('/api/events/:id/context-url', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const { url } = req.body;

  if (!url) {
    res.status(400).json({ error: 'URL required' });
    return;
  }

  await setEventContextUrl(id, url);
  res.json({ success: true, message: 'Context URL set' });
});

app.get('/api/events/day/:timestamp', async (req: Request, res: Response) => {
  try {
    const timestamp = parseInt(req.params.timestamp as string);
    if (isNaN(timestamp)) {
      res.status(400).json({ error: 'Invalid timestamp' });
      return;
    }
    const events = await getEventsForDay(timestamp);
    const d = new Date(timestamp * 1000);
    res.json({
      date: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
      events,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch day events' });
  }
});

app.get('/api/events/status/:status', async (req: Request, res: Response) => {
  const status = req.params.status as string;
  const limit = parseInt(req.query.limit as string) || 50;
  const events = await getEventsByStatus(status, limit);
  res.json(events);
});

// ============ Messages API ============
app.get('/api/messages', async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;
  const sender = req.query.sender as string;

  const messages = await getAllMessages({ limit, offset, sender });
  res.json(messages);
});

// ============ Evolution API (WhatsApp PostgreSQL) ============

app.get('/api/whatsapp/messages', async (req: Request, res: Response) => {
  if (!evolutionDbReady) {
    res.status(503).json({ error: 'Evolution DB not connected' });
    return;
  }

  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;
  const fromMe = req.query.fromMe === 'true' ? true : req.query.fromMe === 'false' ? false : null;
  const isGroup = req.query.isGroup === 'true' ? true : req.query.isGroup === 'false' ? false : null;
  const search = req.query.search as string;

  const messages = await getEvolutionMessages({
    instanceId: resolvedInstanceId || undefined,
    limit,
    offset,
    fromMe,
    isGroup,
    search,
  });

  res.json(messages);
});

app.get('/api/whatsapp/search', async (req: Request, res: Response) => {
  if (!evolutionDbReady) {
    res.status(503).json({ error: 'Evolution DB not connected' });
    return;
  }

  const query = req.query.q as string;
  if (!query) {
    res.status(400).json({ error: 'Query parameter q required' });
    return;
  }

  const limit = parseInt(req.query.limit as string) || 20;
  const messages = await searchEvolutionMessages(query, limit);
  res.json(messages);
});

app.get('/api/whatsapp/contacts', async (req: Request, res: Response) => {
  if (!evolutionDbReady) {
    res.status(503).json({ error: 'Evolution DB not connected' });
    return;
  }

  const limit = parseInt(req.query.limit as string) || 100;
  const contacts = await getEvolutionContacts(resolvedInstanceId || undefined, limit);
  res.json(contacts);
});

app.get('/api/whatsapp/chats', async (req: Request, res: Response) => {
  if (!evolutionDbReady) {
    res.status(503).json({ error: 'Evolution DB not connected' });
    return;
  }

  const limit = parseInt(req.query.limit as string) || 50;
  const chats = await getEvolutionChats(resolvedInstanceId || undefined, limit);
  res.json(chats);
});

app.get('/api/whatsapp/instances', async (_req: Request, res: Response) => {
  if (!evolutionDbReady) {
    res.status(503).json({ error: 'Evolution DB not connected' });
    return;
  }

  const instances = await getEvolutionInstances();
  res.json(instances);
});

app.get('/api/whatsapp/stats', async (_req: Request, res: Response) => {
  if (!evolutionDbReady) {
    res.status(503).json({ error: 'Evolution DB not connected' });
    return;
  }

  const stats = await getEvolutionStats(resolvedInstanceId || undefined);
  res.json(stats);
});

// ============ AI Chat API ============
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { query, history } = req.body;
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'Query is required' });
      return;
    }

    const allEvents = await getAllEvents({ limit: 100, offset: 0, status: 'all' });
    const eventsForContext = allEvents.map((e: any) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      event_type: e.event_type,
      event_time: e.event_time,
      location: e.location,
      status: e.status,
      keywords: e.keywords,
      sender_name: e.sender_name,
      context_url: e.context_url,
    }));

    console.log(`💬 [CHAT] Query: "${query}" (${eventsForContext.length} events in context)`);

    const chatResult = await chatWithContext(query, eventsForContext, history || []);

    const referencedEvents = chatResult.relevantEventIds
      .map((id: number) => allEvents.find((e: any) => e.id === id))
      .filter(Boolean);

    console.log(`💬 [CHAT] Response: "${chatResult.response.substring(0, 80)}..." (${referencedEvents.length} events referenced)`);

    res.json({
      response: chatResult.response,
      events: referencedEvents,
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process chat query' });
  }
});

// WhatsApp webhook
app.post('/api/webhook/whatsapp', async (req: Request, res: Response) => {
  try {
    console.log(`📩 [WEBHOOK] Received event: ${req.body.event} from instance: ${req.body.instance}`);

    if (req.body.event !== 'messages.upsert') {
      res.json({ skipped: true, reason: 'event_type_ignored', event: req.body.event });
      return;
    }

    const parsed = WhatsAppWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid payload', details: parsed.error.errors });
      return;
    }

    const result = await processWebhook(parsed.data, {
      processOwnMessages: config.processOwnMessages,
      skipGroupMessages: config.skipGroupMessages,
    });

    // Handle ACTION results
    if (result.actionPerformed && result.actionPerformed.action !== 'none') {
      console.log(`🎯 [WEBHOOK] Action performed: ${result.actionPerformed.action} on "${result.actionPerformed.targetEventTitle}" (id: ${result.actionPerformed.targetEventId})`);

      broadcast({
        type: 'action_performed',
        action: result.actionPerformed.action,
        eventId: result.actionPerformed.targetEventId,
        eventTitle: result.actionPerformed.targetEventTitle,
        message: result.actionPerformed.message,
      });
    }

    // Handle PENDING MODIFY
    if (result.pendingAction) {
      const pa = result.pendingAction;
      console.log(`📋 [WEBHOOK] Modify needs confirmation: "${pa.targetEventTitle}" → ${pa.description}`);

      const existingEvent = await getEventById(pa.targetEventId);
      let popup;
      try {
        popup = await generatePopupBlueprint(
          existingEvent || { title: pa.targetEventTitle },
          { conflictingEvents: [] },
          'update_confirm'
        );
      } catch (err) {
        console.error('⚠️ Popup blueprint generation failed (update_confirm):', err);
      }

      broadcast({
        type: 'update_confirm',
        eventId: pa.targetEventId,
        eventTitle: pa.targetEventTitle,
        changes: pa.changes,
        description: pa.description,
        popup,
      });
    }

    // Handle NEW events
    if (result.eventsCreated > 0 && result.events) {
      console.log(`✨ [WEBHOOK] Created ${result.eventsCreated} event(s) from message`);
      for (const event of result.events) {
        console.log(`   └─ Event #${event.id}: "${event.title}" (type: ${event.event_type}, status: discovered, context_url: ${event.context_url || 'none'}, sender: ${event.sender_name || 'unknown'})`);

        const hasConflicts = event.conflicts && event.conflicts.length > 0;
        const popupType = hasConflicts ? 'conflict_warning' : 'event_discovery';

        let popup;
        try {
          popup = await generatePopupBlueprint(
            event,
            { conflictingEvents: event.conflicts },
            popupType
          );
        } catch (err) {
          console.error('⚠️ Popup blueprint generation failed (webhook), using defaults:', err);
        }

        if (hasConflicts) {
          broadcast({
            type: 'conflict_warning',
            event,
            conflictingEvents: event.conflicts,
            popupType,
            popup
          });
          console.log(`📡 [WEBHOOK] Broadcasted CONFLICT warning for event #${event.id} (conflicts with ${event.conflicts!.length} events)`);
        } else {
          broadcast({ type: 'notification', event, popup });
          console.log(`📡 [WEBHOOK] Broadcasted discovery notification for event #${event.id}`);
        }
      }
    }

    res.json(result);
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Context check (from Chrome extension)
app.post('/api/context-check', async (req: Request, res: Response) => {
  try {
    console.log(`🔍 [CONTEXT-CHECK] Checking URL: ${req.body.url}`);
    const parsed = ContextCheckRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.errors });
      return;
    }

    const contextTriggers = await checkContextTriggers(parsed.data.url);
    console.log(`📊 [CONTEXT-CHECK] Found ${contextTriggers.length} context trigger(s) for URL`);
    if (contextTriggers.length > 0) {
      contextTriggers.forEach(t => {
        console.log(`   └─ Event #${t.id}: "${t.title}" (type: ${t.event_type}, context_url: ${t.location})`);
      });
    }

    if (contextTriggers.length > 0) {
      const contextTriggersWithPopups = [];
      for (const trigger of contextTriggers) {
        let popup;
        try {
          popup = await generatePopupBlueprint(
            trigger,
            { url: parsed.data.url, pageTitle: parsed.data.title },
            'context_reminder'
          );
        } catch (err) {
          console.error('⚠️ Popup blueprint generation failed (context), using defaults:', err);
        }

        broadcast({
          type: 'context_reminder',
          event: trigger,
          popupType: 'context_reminder',
          url: parsed.data.url,
          popup
        });

        contextTriggersWithPopups.push({ ...trigger, popup });
      }

      const result = await matchContext(
        parsed.data.url,
        parsed.data.title,
        config.hotWindowDays
      );

      res.json({
        ...result,
        contextTriggers: contextTriggersWithPopups,
        contextTriggersCount: contextTriggersWithPopups.length,
      });
      return;
    }

    const result = await matchContext(
      parsed.data.url,
      parsed.data.title,
      config.hotWindowDays
    );

    res.json({
      ...result,
      contextTriggers: contextTriggers,
      contextTriggersCount: contextTriggers.length,
    });
  } catch (error) {
    console.error('Context check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/extract-context', (req: Request, res: Response) => {
  try {
    const { url, title } = req.body;
    if (!url) {
      res.status(400).json({ error: 'URL required' });
      return;
    }
    const context = extractContextFromUrl(url, title);
    res.json(context);
  } catch (_error) {
    res.status(500).json({ error: 'Failed to extract context' });
  }
});

// Form field mismatch check (Insurance Accuracy scenario)
app.post('/api/form-check', async (req: Request, res: Response) => {
  try {
    const { fieldValue, fieldType, parsed: parsedBody } = req.body;
    if (!fieldValue) {
      res.status(400).json({ error: 'fieldValue required' });
      return;
    }

    console.log(`[Argus] 🔍 Form check: "${fieldValue}" (type: ${fieldType})`);

    let remembered: string | null = null;

    if (fieldType === 'car_model' && parsedBody) {
      const make = (parsedBody.make || '').toLowerCase();
      const model = (parsedBody.model || '').toLowerCase();
      const enteredYear = parsedBody.year || null;

      // Demo hardcoded fallback
      if (make === 'honda' && model === 'civic') {
        if (enteredYear && enteredYear !== '2018') {
          remembered = 'Honda Civic 2018';
          console.log('[Argus] 🎯 Demo hardcoded: Honda Civic 2018');
        }
      } else {
        const keywords = [make, model].filter(Boolean);
        if (keywords.length > 0) {
          const events = await searchEventsByKeywords(keywords, 365, 20);
          for (const ev of events) {
            const text = `${ev.title} ${ev.description || ''} ${ev.keywords || ''}`.toLowerCase();
            const yearMatch = text.match(/\b(20[0-9]{2})\b/);
            if (yearMatch && enteredYear && yearMatch[1] !== enteredYear) {
              const capitalMake = make.charAt(0).toUpperCase() + make.slice(1);
              const capitalModel = model.charAt(0).toUpperCase() + model.slice(1);
              remembered = `${capitalMake} ${capitalModel} ${yearMatch[1]}`;
              break;
            }
          }

          if (!remembered) {
            const allMessages = await getAllMessages({ limit: 200 });
            for (const msg of allMessages) {
              const text = (msg.content || '').toLowerCase();
              if (text.includes(make) && text.includes(model)) {
                const yearMatch = text.match(/\b(20[0-9]{2})\b/);
                if (yearMatch && enteredYear && yearMatch[1] !== enteredYear) {
                  const capitalMake = make.charAt(0).toUpperCase() + make.slice(1);
                  const capitalModel = model.charAt(0).toUpperCase() + model.slice(1);
                  remembered = `${capitalMake} ${capitalModel} ${yearMatch[1]}`;
                  break;
                }
              }
            }
          }
        }
      }

      if (remembered) {
        const entered = `${(parsedBody.make || '').charAt(0).toUpperCase() + (parsedBody.make || '').slice(1)} ${(parsedBody.model || '').charAt(0).toUpperCase() + (parsedBody.model || '').slice(1)} ${enteredYear || ''}`.trim();
        console.log(`[Argus] ⚠️ Form mismatch! Entered: "${entered}", Remembered: "${remembered}"`);
        res.json({
          mismatch: true,
          entered,
          remembered,
          suggestion: `You mentioned owning a ${remembered} in your WhatsApp chats. This quote is for a ${entered} — you might be overpaying! Consider changing it for a lower premium.`,
        });
        return;
      }
    }

    res.json({ mismatch: false });
  } catch (error) {
    console.error('Form check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  stopScheduler();
  await closeElastic();
  await closeEvolutionDb();
  server.close(() => {
    console.log('👋 Goodbye!');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM...');
  stopScheduler();
  await closeElastic();
  await closeEvolutionDb();
  server.close(() => process.exit(0));
});

// ============ Bootstrap: Init Elastic then start server ============
async function bootstrap(): Promise<void> {
  try {
    await initElastic({
      cloudId: config.elasticCloudId,
      apiKey: config.elasticApiKey,
    });
  } catch (err) {
    console.error('❌ Failed to connect to Elasticsearch:', err);
    process.exit(1);
  }

  // Start scheduler AFTER Elastic is ready
  startScheduler(async (event) => {
    const popupType = event.popupType || 'event_reminder';
    const type = popupType === 'event_reminder' ? 'trigger' :
                 popupType === 'snooze_reminder' ? 'notification' :
                 popupType === 'context_reminder' ? 'context_reminder' :
                 'notification';

    let popup;
    try {
      popup = await generatePopupBlueprint(event, {}, popupType);
    } catch (err) {
      console.error('⚠️ Popup blueprint generation failed (scheduler), using server defaults:', err);
    }

    broadcast({ type, event, popupType, popup });
  });

  // Fire and forget
  autoSetupEvolution();

  server.listen(config.port, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║     █████╗ ██████╗  ██████╗ ██╗   ██╗███████╗            ║
║    ██╔══██╗██╔══██╗██╔════╝ ██║   ██║██╔════╝            ║
║    ███████║██████╔╝██║  ███╗██║   ██║███████╗            ║
║    ██╔══██║██╔══██╗██║   ██║██║   ██║╚════██║            ║
║    ██║  ██║██║  ██║╚██████╔╝╚██████╔╝███████║            ║
║    ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚══════╝            ║
║                                                           ║
║    Proactive Memory Assistant v3.0.0-elastic              ║
║    Backend: Elasticsearch (Serverless)                    ║
║    Model: ${config.geminiModel.padEnd(30)}        ║
║    Port:  ${config.port.toString().padEnd(30)}        ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
  });
}

bootstrap();

export { app, server };
