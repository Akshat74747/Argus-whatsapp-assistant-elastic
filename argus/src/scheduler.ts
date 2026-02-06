import { 
  getUnfiredTriggersByType, 
  markTriggerFired, 
  getEventById, 
  updateEventStatus,
  getDueReminders,
  markEventReminded,
  getContextEventsForUrl,
  checkEventConflicts,
  getDueSnoozedEvents
} from './db.js';

// Extended notification with popup type
interface NotificationPayload {
  id: number;
  title: string;
  description: string | null;
  event_time?: number | null;
  location?: string | null;
  event_type?: string;
  triggerType: string;
  popupType: 'event_discovery' | 'event_reminder' | 'context_reminder' | 'conflict_warning' | 'insight_card' | 'snooze_reminder';
  conflictingEvents?: Array<{ id: number; title: string; event_time: number | null }>;
}

type NotifyCallback = (event: NotificationPayload) => void;

let schedulerInterval: NodeJS.Timeout | null = null;
let reminderInterval: NodeJS.Timeout | null = null;
let snoozeInterval: NodeJS.Timeout | null = null;
let notifyCallback: NotifyCallback | null = null;

export function startScheduler(callback: NotifyCallback, intervalMs = 60000): void {
  notifyCallback = callback;
  
  // Run immediately
  checkTimeTriggers();
  checkDueReminders();
  checkSnoozedEvents();
  
  // Then run periodically
  schedulerInterval = setInterval(checkTimeTriggers, intervalMs);
  reminderInterval = setInterval(checkDueReminders, 30000); // Check reminders every 30 seconds
  snoozeInterval = setInterval(checkSnoozedEvents, 30000); // Check snoozed events every 30 seconds
  
  console.log('⏰ Scheduler started (triggers every', intervalMs / 1000, 's, reminders/snooze every 30s)');
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
  if (snoozeInterval) {
    clearInterval(snoozeInterval);
    snoozeInterval = null;
  }
  console.log('⏰ Scheduler stopped');
}

// Check for snoozed events that are due
function checkSnoozedEvents(): void {
  const dueEvents = getDueSnoozedEvents();
  
  for (const event of dueEvents) {
    if (notifyCallback && event.id) {
      // Re-show the event discovery popup
      notifyCallback({
        id: event.id,
        title: event.title,
        description: event.description,
        event_time: event.event_time,
        location: event.location,
        event_type: event.event_type,
        triggerType: 'snooze',
        popupType: 'event_discovery', // Show as discovery again so user can act
      });
      
      console.log(`💤 Snoozed event due: ${event.title}`);
      
      // Change status back to discovered so it appears in "New" again
      updateEventStatus(event.id, 'discovered');
    }
  }
}

// Check for 1-hour-before reminders
function checkDueReminders(): void {
  const dueReminders = getDueReminders();
  
  for (const event of dueReminders) {
    if (notifyCallback && event.id) {
      // Broadcast to ALL clients so popup shows on any tab/window
      notifyCallback({
        id: event.id,
        title: event.title,
        description: event.description,
        event_time: event.event_time,
        location: event.location,
        event_type: event.event_type,
        triggerType: 'reminder_1hr',
        popupType: 'event_reminder',
      });
      
      console.log(`🔔 1-hour reminder fired: ${event.title}`);
    }
    
    // Mark as reminded so it doesn't fire again
    if (event.id) {
      markEventReminded(event.id);
    }
  }
}

// Check for context URL triggers (called when user visits a URL)
export function checkContextTriggers(url: string): NotificationPayload[] {
  const events = getContextEventsForUrl(url);
  const notifications: NotificationPayload[] = [];
  
  console.log(`[Scheduler] Checking URL "${url}" - found ${events.length} matching events`);
  
  for (const event of events) {
    if (event.id) {
      console.log(`[Scheduler] Context match: Event #${event.id} "${event.title}" (context_url: ${event.context_url})`);
      notifications.push({
        id: event.id,
        title: event.title,
        description: event.description,
        event_time: event.event_time,
        location: event.location,
        event_type: event.event_type,
        triggerType: 'url',
        popupType: 'context_reminder',
      });
    }
  }
  
  return notifications;
}

// Check for calendar conflicts with a new event
export function checkCalendarConflicts(eventId: number, eventTime: number): NotificationPayload | null {
  const conflicts = checkEventConflicts(eventTime, 60); // 1 hour window
  
  // Filter out the event itself
  const otherConflicts = conflicts.filter(e => e.id !== eventId);
  
  if (otherConflicts.length === 0) return null;
  
  const event = getEventById(eventId);
  if (!event) return null;
  
  console.log(`[Scheduler] Conflict detected: Event #${eventId} conflicts with ${otherConflicts.length} events`);
  
  return {
    id: event.id!,
    title: event.title,
    description: event.description,
    event_time: event.event_time,
    location: event.location,
    event_type: event.event_type,
    triggerType: 'conflict',
    popupType: 'conflict_warning',
    conflictingEvents: otherConflicts.map(e => ({
      id: e.id!,
      title: e.title,
      event_time: e.event_time
    }))
  };
}

function checkTimeTriggers(): void {
  const now = Date.now();
  const triggers = getUnfiredTriggersByType('time');
  
  for (const trigger of triggers) {
    try {
      const triggerTime = new Date(trigger.trigger_value).getTime();
      
      // Check if trigger time has passed (with 5 min buffer)
      if (triggerTime <= now + 5 * 60 * 1000) {
        const event = getEventById(trigger.event_id);
        
        if (event && (event.status === 'pending' || event.status === 'scheduled' || event.status === 'discovered' || event.status === 'reminded')) {
          // Fire notification
          if (notifyCallback) {
            notifyCallback({
              id: event.id!,
              title: event.title,
              description: event.description,
              event_time: event.event_time,
              location: event.location,
              event_type: event.event_type,
              triggerType: 'time',
              popupType: 'event_reminder',
            });
          }
          
          console.log(`🔔 Time trigger fired: ${event.title}`);
        }
        
        markTriggerFired(trigger.id!);
      }
    } catch (error) {
      console.error(`Failed to process trigger ${trigger.id}:`, error);
    }
  }
}

// Mark event as completed
export function completeEvent(eventId: number): void {
  updateEventStatus(eventId, 'completed');
  console.log(`✅ Event ${eventId} marked as completed`);
}

// Mark event as expired
export function expireEvent(eventId: number): void {
  updateEventStatus(eventId, 'expired');
  console.log(`⏳ Event ${eventId} marked as expired`);
}

// Cleanup old events (run daily)
export function cleanupOldEvents(_daysOld = 90): number {
  // const cutoff = Math.floor(Date.now() / 1000) - _daysOld * 24 * 60 * 60;
  
  // This would need a new db function, but for simplicity we'll skip
  // In production, you'd want to archive or delete old events
  
  return 0;
}
