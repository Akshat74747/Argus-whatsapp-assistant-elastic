import { getUnfiredTriggersByType, markTriggerFired, getEventById, updateEventStatus } from './db.js';

type NotifyCallback = (event: { id: number; title: string; description: string | null; triggerType: string }) => void;

let schedulerInterval: NodeJS.Timeout | null = null;
let notifyCallback: NotifyCallback | null = null;

export function startScheduler(callback: NotifyCallback, intervalMs = 60000): void {
  notifyCallback = callback;
  
  // Run immediately
  checkTimeTriggers();
  
  // Then run periodically
  schedulerInterval = setInterval(checkTimeTriggers, intervalMs);
  
  console.log('⏰ Scheduler started (checking every', intervalMs / 1000, 'seconds)');
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('⏰ Scheduler stopped');
  }
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
        
        if (event && event.status === 'pending') {
          // Fire notification
          if (notifyCallback) {
            notifyCallback({
              id: event.id!,
              title: event.title,
              description: event.description,
              triggerType: 'time',
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
