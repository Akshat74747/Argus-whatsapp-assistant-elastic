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
} from './elastic.js';

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

type NotifyCallback = (event: NotificationPayload) => void | Promise<void>;

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
  reminderInterval = setInterval(checkDueReminders, 30000);
  snoozeInterval = setInterval(checkSnoozedEvents, 30000);

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
async function checkSnoozedEvents(): Promise<void> {
  try {
    const dueEvents = await getDueSnoozedEvents();

    for (const event of dueEvents) {
      if (notifyCallback && event.id) {
        notifyCallback({
          id: event.id,
          title: event.title,
          description: event.description,
          event_time: event.event_time,
          location: event.location,
          event_type: event.event_type,
          triggerType: 'snooze',
          popupType: 'event_discovery',
        });

        console.log(`💤 Snoozed event due: ${event.title}`);

        await updateEventStatus(event.id, 'discovered');
      }
    }
  } catch (err) {
    console.error('Scheduler: checkSnoozedEvents error:', err);
  }
}

// Check for 1-hour-before reminders
async function checkDueReminders(): Promise<void> {
  try {
    const dueReminders = await getDueReminders();

    for (const event of dueReminders) {
      if (notifyCallback && event.id) {
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

      if (event.id) {
        await markEventReminded(event.id);
      }
    }
  } catch (err) {
    console.error('Scheduler: checkDueReminders error:', err);
  }
}

// Check for context URL triggers (called when user visits a URL)
export async function checkContextTriggers(url: string): Promise<NotificationPayload[]> {
  const events = await getContextEventsForUrl(url);
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
export async function checkCalendarConflicts(eventId: number, eventTime: number): Promise<NotificationPayload | null> {
  const conflicts = await checkEventConflicts(eventTime, 60);

  const otherConflicts = conflicts.filter(e => e.id !== eventId);

  if (otherConflicts.length === 0) return null;

  const event = await getEventById(eventId);
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

async function checkTimeTriggers(): Promise<void> {
  try {
    const now = Date.now();
    const triggerTypes = ['time', 'time_24h', 'time_1h', 'time_15m', 'reminder_24h', 'reminder_1hr', 'reminder_15m'];
    let triggers: any[] = [];
    for (const tt of triggerTypes) {
      const batch = await getUnfiredTriggersByType(tt);
      triggers = triggers.concat(batch);
    }

    for (const trigger of triggers) {
      try {
        const triggerTime = new Date(trigger.trigger_value).getTime();

        if (triggerTime <= now + 5 * 60 * 1000) {
          const event = await getEventById(trigger.event_id);

          if (event && (event.status === 'pending' || event.status === 'scheduled' || event.status === 'discovered' || event.status === 'reminded')) {
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

          await markTriggerFired(trigger.id!);
        }
      } catch (error) {
        console.error(`Failed to process trigger ${trigger.id}:`, error);
      }
    }
  } catch (err) {
    console.error('Scheduler: checkTimeTriggers error:', err);
  }
}

// Mark event as completed
export async function completeEvent(eventId: number): Promise<void> {
  await updateEventStatus(eventId, 'completed');
  console.log(`✅ Event ${eventId} marked as completed`);
}

// Mark event as expired
export async function expireEvent(eventId: number): Promise<void> {
  await updateEventStatus(eventId, 'expired');
  console.log(`⏳ Event ${eventId} marked as expired`);
}

// Cleanup old events (run daily)
export function cleanupOldEvents(_daysOld = 90): number {
  return 0;
}
