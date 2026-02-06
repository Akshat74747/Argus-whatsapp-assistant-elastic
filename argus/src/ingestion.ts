import { insertMessage, insertEvent, insertTrigger, getRecentMessages, upsertContact, checkEventConflicts, findActiveEventsByKeywords, getActiveEvents, ignoreEvent, completeEvent as dbCompleteEvent, snoozeEvent, deleteEvent, updateEventTime } from './db.js';
import { extractEvents, classifyMessage, detectAction } from './gemini.js';
import type { Message, WhatsAppWebhook } from './types.js';

interface ConflictInfo {
  id: number;
  title: string;
  event_time: number | null;
}

interface CreatedEvent {
  id: number;
  event_type: string;
  title: string;
  description: string | null;
  event_time: number | null;
  location: string | null;
  participants: string;
  keywords: string;
  confidence: number;
  context_url?: string | null;
  sender_name?: string | null;
  conflicts?: ConflictInfo[];
}

interface ActionResult {
  action: string;
  targetEventId: number | null;
  targetEventTitle: string | null;
  message: string;
}

interface IngestionResult {
  messageId: string;
  eventsCreated: number;
  triggersCreated: number;
  skipped: boolean;
  skipReason?: string;
  events?: CreatedEvent[];
  conflicts?: Array<{ eventId: number; conflictsWith: ConflictInfo[] }>;
  // Action results (for when user sends "cancel it", "done", etc.)
  actionPerformed?: ActionResult;
}

export async function processWebhook(
  payload: WhatsAppWebhook,
  options: { processOwnMessages: boolean; skipGroupMessages: boolean }
): Promise<IngestionResult> {
  const { data } = payload;
  
  // Extract message content
  const content = data.message?.conversation || data.message?.extendedTextMessage?.text;
  if (!content) {
    return { messageId: data.key.id, eventsCreated: 0, triggersCreated: 0, skipped: true, skipReason: 'no_content' };
  }

  // Check if from self
  if (data.key.fromMe && !options.processOwnMessages) {
    return { messageId: data.key.id, eventsCreated: 0, triggersCreated: 0, skipped: true, skipReason: 'own_message' };
  }

  // Check if group
  const isGroup = data.key.remoteJid.includes('@g.us');
  if (isGroup && options.skipGroupMessages) {
    return { messageId: data.key.id, eventsCreated: 0, triggersCreated: 0, skipped: true, skipReason: 'group_message' };
  }

  // Create message object
  const timestamp = typeof data.messageTimestamp === 'string' 
    ? parseInt(data.messageTimestamp) 
    : data.messageTimestamp;

  const senderName = data.pushName || null;

  const message: Message = {
    id: data.key.id,
    chat_id: data.key.remoteJid,
    sender: data.key.fromMe ? 'self' : data.key.remoteJid.split('@')[0],
    content,
    timestamp,
  };

  // Store message
  insertMessage(message);

  // Update contact
  upsertContact({
    id: message.sender,
    name: senderName,
    first_seen: timestamp,
    last_seen: timestamp,
    message_count: 1,
  });

  // Quick classification
  const classification = await classifyMessage(content);
  if (!classification.hasEvent) {
    return { messageId: message.id, eventsCreated: 0, triggersCreated: 0, skipped: true, skipReason: 'no_event_detected' };
  }

  // Get context from recent messages
  const recentMessages = getRecentMessages(message.chat_id, 5);
  const context = recentMessages
    .filter(m => m.id !== message.id)
    .map(m => m.content);

  // ============ STEP 1: Check if this is an ACTION on existing event ============
  const activeEvents = getActiveEvents(20);
  const actionResult = await detectAction(content, context, activeEvents.map(e => ({
    id: e.id!,
    title: e.title,
    event_type: e.event_type,
    keywords: e.keywords,
  })));

  if (actionResult.isAction && actionResult.confidence >= 0.6) {
    console.log(`🎯 [ACTION] Detected action: "${actionResult.action}" on "${actionResult.targetDescription}" (confidence: ${actionResult.confidence})`);
    
    // Find the target event
    let targetEvent = null;
    
    // Try to find by keywords
    if (actionResult.targetKeywords.length > 0) {
      const matches = findActiveEventsByKeywords(actionResult.targetKeywords);
      if (matches.length > 0) {
        targetEvent = matches[0]; // Best match
      }
    }
    
    // Fallback: use most recent active event
    if (!targetEvent && activeEvents.length > 0) {
      targetEvent = activeEvents[0];
    }

    if (targetEvent && targetEvent.id) {
      const eventId = targetEvent.id;
      let actionMessage = '';

      switch (actionResult.action) {
        case 'cancel':
        case 'delete':
          deleteEvent(eventId);
          actionMessage = `Deleted: "${targetEvent.title}"`;
          console.log(`🗑️ [ACTION] Deleted event #${eventId}: "${targetEvent.title}"`);
          break;

        case 'complete':
          dbCompleteEvent(eventId);
          actionMessage = `Completed: "${targetEvent.title}"`;
          console.log(`✅ [ACTION] Completed event #${eventId}: "${targetEvent.title}"`);
          break;

        case 'ignore':
          ignoreEvent(eventId);
          actionMessage = `Ignored: "${targetEvent.title}" - won't remind again`;
          console.log(`🚫 [ACTION] Ignored event #${eventId}: "${targetEvent.title}"`);
          break;

        case 'snooze':
        case 'postpone':
          const minutes = actionResult.snoozeMinutes || 30;
          snoozeEvent(eventId, minutes);
          const durationText = minutes >= 10080 ? 'next week' : minutes >= 1440 ? 'tomorrow' : minutes >= 60 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
          actionMessage = `Snoozed: "${targetEvent.title}" → will remind ${durationText}`;
          console.log(`💤 [ACTION] Snoozed event #${eventId} for ${minutes} min: "${targetEvent.title}"`);
          break;

        case 'modify':
          if (actionResult.newTime) {
            try {
              const newTime = Math.floor(new Date(actionResult.newTime).getTime() / 1000);
              updateEventTime(eventId, newTime);
              actionMessage = `Rescheduled: "${targetEvent.title}" → ${new Date(newTime * 1000).toLocaleString()}`;
              console.log(`📅 [ACTION] Rescheduled event #${eventId}: "${targetEvent.title}"`);
            } catch {
              actionMessage = `Could not reschedule: invalid time`;
            }
          } else {
            actionMessage = `Modify requested but no new time provided`;
          }
          break;

        default:
          actionMessage = `Unknown action: ${actionResult.action}`;
      }

      return {
        messageId: message.id,
        eventsCreated: 0,
        triggersCreated: 0,
        skipped: false,
        actionPerformed: {
          action: actionResult.action,
          targetEventId: eventId,
          targetEventTitle: targetEvent.title,
          message: actionMessage,
        },
      };
    }
  }

  // ============ STEP 2: Not an action → extract NEW events ============
  const result = await processMessage(message, context, senderName);
  
  return result;
}

export async function processMessage(
  message: Message,
  context: string[] = [],
  senderName: string | null = null
): Promise<IngestionResult> {
  let eventsCreated = 0;
  let triggersCreated = 0;
  const createdEvents: CreatedEvent[] = [];

  try {
    // Extract events using Gemini
    const extraction = await extractEvents(message.content, context);

    for (const event of extraction.events) {
      if (event.confidence < 0.4) continue; // Skip low confidence

      // Parse event time
      let eventTime: number | null = null;
      if (event.event_time) {
        try {
          eventTime = Math.floor(new Date(event.event_time).getTime() / 1000);
        } catch {
          eventTime = null;
        }
      }

      // Determine context_url based on event type
      let contextUrl: string | null = null;
      
      // Known streaming/service keywords that should trigger context reminders
      const serviceKeywords = [
        'netflix', 'hotstar', 'amazon', 'prime', 'disney', 'spotify', 
        'youtube', 'hulu', 'hbo', 'zee5', 'sonyliv', 'jiocinema',
        'gym', 'domain', 'hosting', 'hostinger', 'aws', 'azure', 'vercel', 'heroku'
      ];
      
      // Build search text from all fields
      const searchText = `${event.location || ''} ${event.keywords.join(' ')} ${event.title} ${event.description || ''}`.toLowerCase();
      
      // Check for service keywords in ANY event type
      for (const service of serviceKeywords) {
        if (searchText.includes(service)) {
          contextUrl = service;
          console.log(`[Ingestion] Found context keyword "${service}" in event "${event.title}"`);
          break;
        }
      }
      
      // For travel: extract location keywords (goa, mumbai, delhi, etc.)
      if (event.type === 'travel' || event.type === 'recommendation') {
        const travelKeywords = [
          'goa', 'mumbai', 'delhi', 'bangalore', 'chennai', 'kolkata', 'hyderabad',
          'jaipur', 'udaipur', 'kerala', 'manali', 'shimla', 'ladakh', 'kashmir',
          'thailand', 'bali', 'singapore', 'dubai', 'maldives', 'europe'
        ];
        
        const travelSearchText = `${event.location || ''} ${event.keywords.join(' ')} ${event.title} ${event.description || ''}`.toLowerCase();
        
        for (const place of travelKeywords) {
          if (travelSearchText.includes(place)) {
            contextUrl = place;
            break;
          }
        }
      }
      
      // For any event mentioning a location, also try to set context_url
      if (!contextUrl && event.location) {
        const locationLower = event.location.toLowerCase();
        // Check for travel destinations in location
        const places = ['goa', 'mumbai', 'delhi', 'bangalore', 'chennai', 'kolkata'];
        for (const place of places) {
          if (locationLower.includes(place)) {
            contextUrl = place;
            break;
          }
        }
      }

      // For events WITHOUT a time, auto-schedule them (context/URL-based events)
      // For events WITH a time, they start as 'discovered' and user can set reminder
      const initialStatus = eventTime ? 'discovered' as const : 'scheduled' as const;

      // Insert event
      const eventData = {
        message_id: message.id,
        event_type: event.type,
        title: event.title,
        description: event.description,
        event_time: eventTime,
        location: event.location,
        participants: JSON.stringify(event.participants),
        keywords: event.keywords.join(','),
        confidence: event.confidence,
        status: initialStatus,
        context_url: contextUrl,
        sender_name: senderName,
      };
      const eventId = insertEvent(eventData);
      eventsCreated++;
      
      // Track for return
      createdEvents.push({
        id: eventId,
        event_type: event.type,
        title: event.title,
        description: event.description,
        event_time: eventTime,
        location: event.location,
        participants: JSON.stringify(event.participants),
        keywords: event.keywords.join(','),
        confidence: event.confidence,
        context_url: contextUrl,
        sender_name: senderName,
      });

      // Check for calendar conflicts
      if (eventTime) {
        const conflicts = checkEventConflicts(eventTime, 60);
        const otherConflicts = conflicts.filter(e => e.id !== eventId);
        if (otherConflicts.length > 0) {
          const lastEvent = createdEvents[createdEvents.length - 1];
          lastEvent.conflicts = otherConflicts.map(e => ({
            id: e.id!,
            title: e.title,
            event_time: e.event_time
          }));
          console.log(`⚠️ Conflict: Event "${event.title}" conflicts with ${otherConflicts.length} events`);
        }
      }

      // Create triggers
      // Time-based trigger
      if (eventTime) {
        insertTrigger({
          event_id: eventId,
          trigger_type: 'time',
          trigger_value: new Date(eventTime * 1000).toISOString(),
          is_fired: false,
        });
        triggersCreated++;
      }

      // Location/URL triggers
      if (event.location) {
        insertTrigger({
          event_id: eventId,
          trigger_type: 'url',
          trigger_value: event.location.toLowerCase(),
          is_fired: false,
        });
        triggersCreated++;
      }

      // Keyword triggers (for important keywords)
      const importantKeywords = event.keywords.filter(kw => 
        ['travel', 'flight', 'hotel', 'buy', 'gift', 'birthday', 'meeting', 'deadline', 'dinner', 'lunch', 'coffee'].some(ik => kw.toLowerCase().includes(ik))
      );
      for (const kw of importantKeywords.slice(0, 3)) {
        insertTrigger({
          event_id: eventId,
          trigger_type: 'keyword',
          trigger_value: kw.toLowerCase(),
          is_fired: false,
        });
        triggersCreated++;
      }
    }

    console.log(`📥 Processed message ${message.id}: ${eventsCreated} events, ${triggersCreated} triggers`);
    
  } catch (error) {
    console.error(`❌ Failed to process message ${message.id}:`, error);
  }

  return { messageId: message.id, eventsCreated, triggersCreated, skipped: false, events: createdEvents };
}

// Batch import for initial data load
export async function batchImportMessages(
  messages: Array<{ content: string; sender: string; chatId: string; timestamp: number }>
): Promise<{ total: number; processed: number; events: number }> {
  let processed = 0;
  let totalEvents = 0;

  for (const msg of messages) {
    const message: Message = {
      id: `import_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      chat_id: msg.chatId,
      sender: msg.sender,
      content: msg.content,
      timestamp: msg.timestamp,
    };

    insertMessage(message);

    const classification = await classifyMessage(msg.content);
    if (classification.hasEvent) {
      const result = await processMessage(message);
      totalEvents += result.eventsCreated;
      processed++;
    }
  }

  return { total: messages.length, processed, events: totalEvents };
}
