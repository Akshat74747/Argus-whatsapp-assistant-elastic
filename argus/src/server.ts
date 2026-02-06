import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { initDb, getStats, getEventById, closeDb, getAllMessages, getAllEvents, deleteEvent, scheduleEventReminder, dismissContextEvent, setEventContextUrl, getEventsByStatus, snoozeEvent, ignoreEvent, completeEvent as dbCompleteEvent } from './db.js';
import { initGemini, chatWithContext } from './gemini.js';
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

// Initialize services
initDb(config.dbPath);
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

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Serve static files (dashboard)
app.use(express.static(join(__dirname, 'public')));

// Create HTTP server
const server = createServer(app);

// WebSocket server for real-time notifications (on root path for browser compatibility)
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

// Start scheduler - broadcasts reminders/triggers
startScheduler((event) => {
  // Scheduler sends different popup types - forward them correctly
  const type = event.popupType === 'event_reminder' ? 'trigger' : 
               event.popupType === 'snooze_reminder' ? 'notification' :
               event.popupType === 'context_reminder' ? 'context_reminder' :
               'notification';
  broadcast({ type, event, popupType: event.popupType });
});

// ============ API Routes ============

// Health check
app.get('/api/health', async (_req: Request, res: Response) => {
  const evolutionOk = evolutionDbReady ? await testEvolutionConnection() : false;
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    model: config.geminiModel,
    version: '1.0.0',
    evolutionDb: evolutionOk ? 'connected' : 'disconnected',
  });
});

// Stats (combined Argus + Evolution)
app.get('/api/stats', async (_req: Request, res: Response) => {
  const argusStats = getStats();
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
app.get('/api/events', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;
  const status = (req.query.status as string) || 'all';
  
  // Use EventStatus type for proper status filtering
  const events = getAllEvents({ limit, offset, status: status as any });
  res.json(events);
});

// Get single event
app.get('/api/events/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const event = getEventById(id);
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  res.json(event);
});

// ============ Event Actions ============

// Complete event (mark as done)
app.post('/api/events/:id/complete', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  console.log(`✅ [COMPLETE] Event ${id} marked as done`);
  dbCompleteEvent(id);
  broadcast({ type: 'event_completed', eventId: id });
  res.json({ success: true, message: 'Event completed' });
});

// Schedule event (approve for reminders)
app.post('/api/events/:id/set-reminder', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const event = getEventById(id);
  
  if (!event) {
    console.log(`❌ [SCHEDULE] Event ${id} not found`);
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  
  console.log(`📅 [SCHEDULE] Event ${id}: "${event.title}" → scheduled`);
  scheduleEventReminder(id);
  broadcast({ type: 'event_scheduled', eventId: id });
  res.json({ success: true, message: 'Event scheduled for reminders' });
});

// Snooze event (remind later - 30 minutes by default)
app.post('/api/events/:id/snooze', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const { minutes } = req.body;
  const snoozeMinutes = minutes || 30;
  
  console.log(`💤 [SNOOZE] Event ${id} snoozed for ${snoozeMinutes} minutes`);
  snoozeEvent(id, snoozeMinutes);
  broadcast({ type: 'event_snoozed', eventId: id, snoozeMinutes });
  res.json({ success: true, message: `Event snoozed for ${snoozeMinutes} minutes` });
});

// Ignore event (user doesn't care, hide but don't delete)
app.post('/api/events/:id/ignore', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  console.log(`🚫 [IGNORE] Event ${id} ignored by user`);
  ignoreEvent(id);
  broadcast({ type: 'event_ignored', eventId: id });
  res.json({ success: true, message: 'Event ignored' });
});

// Dismiss context reminder (temporary - will show again in 30 min)
app.post('/api/events/:id/dismiss', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const { permanent, urlPattern } = req.body;
  
  console.log(`🔕 [DISMISS] Event ${id} context dismissed (permanent: ${permanent})`);
  dismissContextEvent(id, urlPattern || '', permanent === true);
  broadcast({ type: 'event_dismissed', eventId: id, permanent });
  res.json({ success: true });
});

// Delete event (permanent removal)
app.delete('/api/events/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  console.log(`🗑️ [DELETE] Event ${id} permanently deleted`);
  deleteEvent(id);
  broadcast({ type: 'event_deleted', eventId: id });
  res.json({ success: true, message: 'Event deleted' });
});

// ============ Legacy Endpoints (for backwards compat) ============

// Acknowledge reminder (user saw 1-hour reminder)
app.post('/api/events/:id/acknowledge', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  broadcast({ type: 'event_acknowledged', eventId: id });
  res.json({ success: true, message: 'Reminder acknowledged' });
});

// Done is same as complete
app.post('/api/events/:id/done', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  dbCompleteEvent(id);
  broadcast({ type: 'event_completed', eventId: id });
  res.json({ success: true, message: 'Event marked as done' });
});

// Set context URL for an event (for URL-based triggers like Netflix)
app.post('/api/events/:id/context-url', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string);
  const { url } = req.body;
  
  if (!url) {
    res.status(400).json({ error: 'URL required' });
    return;
  }
  
  setEventContextUrl(id, url);
  res.json({ success: true, message: 'Context URL set' });
});

// Get events by status (for extension to fetch discovered events)
app.get('/api/events/status/:status', (req: Request, res: Response) => {
  const status = req.params.status as string;
  const limit = parseInt(req.query.limit as string) || 50;
  const events = getEventsByStatus(status, limit);
  res.json(events);
});

// ============ Messages API (Argus local DB) ============
app.get('/api/messages', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;
  const sender = req.query.sender as string;
  
  const messages = getAllMessages({ limit, offset, sender });
  res.json(messages);
});

// ============ Evolution API (WhatsApp PostgreSQL) ============

// Get WhatsApp messages from Evolution
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

// Search WhatsApp messages
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

// Get WhatsApp contacts from Evolution
app.get('/api/whatsapp/contacts', async (req: Request, res: Response) => {
  if (!evolutionDbReady) {
    res.status(503).json({ error: 'Evolution DB not connected' });
    return;
  }
  
  const limit = parseInt(req.query.limit as string) || 100;
  const contacts = await getEvolutionContacts(resolvedInstanceId || undefined, limit);
  res.json(contacts);
});

// Get WhatsApp chats from Evolution
app.get('/api/whatsapp/chats', async (req: Request, res: Response) => {
  if (!evolutionDbReady) {
    res.status(503).json({ error: 'Evolution DB not connected' });
    return;
  }
  
  const limit = parseInt(req.query.limit as string) || 50;
  const chats = await getEvolutionChats(resolvedInstanceId || undefined, limit);
  res.json(chats);
});

// Get WhatsApp instances
app.get('/api/whatsapp/instances', async (_req: Request, res: Response) => {
  if (!evolutionDbReady) {
    res.status(503).json({ error: 'Evolution DB not connected' });
    return;
  }
  
  const instances = await getEvolutionInstances();
  res.json(instances);
});

// Get WhatsApp stats
app.get('/api/whatsapp/stats', async (_req: Request, res: Response) => {
  if (!evolutionDbReady) {
    res.status(503).json({ error: 'Evolution DB not connected' });
    return;
  }
  
  const stats = await getEvolutionStats(resolvedInstanceId || undefined);
  res.json(stats);
});

// ============ AI Chat API (for Chrome Extension sidebar) ============
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { query, history } = req.body;
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'Query is required' });
      return;
    }

    // Get all active events for context
    const allEvents = getAllEvents({ limit: 100, offset: 0, status: 'all' });
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

    // Get referenced event objects
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
    // Only process messages.upsert events (new messages)
    // Ignore messages.update (read receipts, status updates)
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

    // ============ Handle ACTION results (cancel, done, postpone, etc.) ============
    if (result.actionPerformed) {
      console.log(`🎯 [WEBHOOK] Action performed: ${result.actionPerformed.action} on "${result.actionPerformed.targetEventTitle}" (id: ${result.actionPerformed.targetEventId})`);
      
      // Broadcast the action to all clients so they update their UI
      broadcast({
        type: 'action_performed',
        action: result.actionPerformed.action,
        eventId: result.actionPerformed.targetEventId,
        eventTitle: result.actionPerformed.targetEventTitle,
        message: result.actionPerformed.message,
      });
    }

    // ============ Handle NEW events ============
    // Broadcast each event to WebSocket clients for overlay notifications
    if (result.eventsCreated > 0 && result.events) {
      console.log(`✨ [WEBHOOK] Created ${result.eventsCreated} event(s) from message`);
      for (const event of result.events) {
        console.log(`   └─ Event #${event.id}: "${event.title}" (type: ${event.event_type}, status: discovered, context_url: ${event.context_url || 'none'}, sender: ${event.sender_name || 'unknown'})`);
        
        // Send ONE notification per event - include conflict info if present
        const hasConflicts = event.conflicts && event.conflicts.length > 0;
        if (hasConflicts) {
          // If conflicts, send as conflict_warning (which includes the event)
          broadcast({ 
            type: 'conflict_warning', 
            event,
            conflictingEvents: event.conflicts,
            popupType: 'conflict_warning'
          });
          console.log(`📡 [WEBHOOK] Broadcasted CONFLICT warning for event #${event.id} (conflicts with ${event.conflicts!.length} events)`);
        } else {
          // No conflicts, send as regular notification
          broadcast({ type: 'notification', event });
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

    // First check for URL-based context triggers (Netflix scenario)
    const contextTriggers = checkContextTriggers(parsed.data.url);
    console.log(`📊 [CONTEXT-CHECK] Found ${contextTriggers.length} context trigger(s) for URL`);
    if (contextTriggers.length > 0) {
      contextTriggers.forEach(t => {
        console.log(`   └─ Event #${t.id}: "${t.title}" (type: ${t.event_type}, context_url: ${t.location})`);
      });
    }
    
    if (contextTriggers.length > 0) {
      // Broadcast context reminders to all clients
      for (const trigger of contextTriggers) {
        broadcast({ 
          type: 'context_reminder', 
          event: trigger,
          popupType: 'context_reminder',
          url: parsed.data.url
        });
      }
    }

    // Also do keyword-based matching
    const result = await matchContext(
      parsed.data.url,
      parsed.data.title,
      config.hotWindowDays
    );

    // Return context triggers directly in response (for extension to show popups)
    res.json({
      ...result,
      contextTriggers: contextTriggers,  // Return full event objects
      contextTriggersCount: contextTriggers.length,
    });
  } catch (error) {
    console.error('Context check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Quick context extraction (for extension)
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

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  stopScheduler();
  closeDb();
  await closeEvolutionDb();
  server.close(() => {
    console.log('👋 Goodbye!');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM...');
  stopScheduler();
  closeDb();
  await closeEvolutionDb();
  server.close(() => process.exit(0));
});

// Start server
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
║    Proactive Memory Assistant v1.0.0                      ║
║    Model: ${config.geminiModel.padEnd(30)}        ║
║    Port:  ${config.port.toString().padEnd(30)}        ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

export { app, server };
