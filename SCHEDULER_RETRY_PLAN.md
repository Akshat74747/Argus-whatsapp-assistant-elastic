# Scheduler Retry System — Implementation Plan

The scheduler currently fires reminders via `notifyCallback` and **immediately marks them as sent** (`markTriggerFired`, `markEventReminded`). If the callback fails (WebSocket disconnected, broadcast error, no tabs available), the reminder is permanently lost — it will never fire again.

This plan adds retry logic with exponential backoff so failed reminders are retried 3 times before being logged as permanently failed.

---

## Current Problem

```
Trigger due → notifyCallback() → markTriggerFired() → done
                    ↓ (if fails)
               ❌ Reminder lost forever (already marked as fired)
```

**Three reminder paths affected:**
1. `checkTimeTriggers()` — time-based triggers (24h, 1h, 15m before event)
2. `checkDueReminders()` — 1-hour-before reminders for scheduled events
3. `checkSnoozedEvents()` — snoozed events coming due

All three have the same bug: **mark-before-verify**.

---

## Proposed Solution

```
Trigger due → notifyCallback() → success? → markTriggerFired()
                    ↓ (if fails)
              Add to retry queue → retry in 1m → retry in 5m → retry in 15m
                                                                   ↓ (all fail)
                                                     Log to data/failed-reminders.jsonl
```

---

## Proposed Changes

### New: Retry Queue (added to `scheduler.ts`)

No new file needed — the retry logic is small enough to add directly to `scheduler.ts`.

#### [MODIFY] [scheduler.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/scheduler.ts)

**New in-memory retry queue:**
```typescript
interface RetryItem {
  payload: NotificationPayload;
  attempt: number;       // 0, 1, 2 (max 3 attempts total)
  nextRetryAt: number;   // Unix ms timestamp
  reason: string;        // why it failed
}

const retryQueue: RetryItem[] = [];
const BACKOFF_MS = [60_000, 300_000, 900_000]; // 1m, 5m, 15m
const MAX_ATTEMPTS = 3;
```

**`scheduleRetry(payload, error)` function:**
- Called when `notifyCallback` throws or returns failure
- Adds item to `retryQueue` with `nextRetryAt = now + BACKOFF_MS[attempt]`
- If `attempt >= MAX_ATTEMPTS`, logs to `data/failed-reminders.jsonl` instead

**`processRetryQueue()` function:**
- Runs every 30 seconds (piggyback on existing `reminderInterval`)
- Iterates `retryQueue`, fires items where `nextRetryAt <= now`
- On success: remove from queue, mark trigger/reminder as fired
- On failure: increment attempt, reschedule with next backoff
- On max attempts: remove from queue, log to failure file

**Changes to existing functions:**

`checkTimeTriggers()`:
```diff
- notifyCallback({ ... });
- await markTriggerFired(trigger.id!);
+ const success = await safeNotify({ ... });
+ if (success) {
+   await markTriggerFired(trigger.id!);
+ } else {
+   scheduleRetry({ ... }, 'callback_failed');
+ }
```

`checkDueReminders()`:
```diff
- notifyCallback({ ... });
- await markEventReminded(event.id);
+ const success = await safeNotify({ ... });
+ if (success) {
+   await markEventReminded(event.id);
+ } else {
+   scheduleRetry({ ... }, 'callback_failed');
+ }
```

`checkSnoozedEvents()`:
```diff
- notifyCallback({ ... });
- await updateEventStatus(event.id, 'discovered');
+ const success = await safeNotify({ ... });
+ if (success) {
+   await updateEventStatus(event.id, 'discovered');
+ } else {
+   scheduleRetry({ ... }, 'callback_failed');
+ }
```

**`safeNotify(payload): Promise<boolean>`:**
- Wraps `notifyCallback` in try-catch
- Returns `true` on success, `false` on any error
- Logs the error with event ID and title

---

### Failure Logging

#### [MODIFY] [errors.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/errors.ts)

Add `logFailedReminder(payload, attempts, lastError)`:
- Appends to `data/failed-reminders.jsonl`
- Each line: `{ timestamp, eventId, eventTitle, triggerType, attempts, lastError }`
- Same file rotation logic as `logDeadLetter` (>10MB rotate)

---

### Status Visibility

#### [MODIFY] [server.ts](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/src/server.ts)

Add retry queue info to existing `/api/health` endpoint:
```diff
  res.json({
    status: 'ok',
+   scheduler: {
+     retryQueueSize: getRetryQueueSize(),
+     failedRemindersToday: getFailedReminderCount(),
+   },
  });
```

Export `getRetryQueueSize()` and `getFailedReminderCount()` from `scheduler.ts`.

---

## Files Changed Summary

| File | Action | Purpose |
|:---|:---|:---|
| `scheduler.ts` | MODIFY | Retry queue, `safeNotify`, `scheduleRetry`, `processRetryQueue`, mark-after-verify |
| `errors.ts` | MODIFY | Add `logFailedReminder()` |
| `server.ts` | MODIFY | Expose retry queue stats in health endpoint |

---

## Verification Plan

### Automated
```bash
cd d:\Elastic\whatsapp-chat-rmd-argus\argus && npx tsc --noEmit
```

### Manual

1. **Normal reminder delivery** — Schedule an event for 1h from now → verify reminder fires and trigger is marked as fired

2. **Retry on WebSocket failure** — Disconnect all WebSocket clients → fire a trigger → verify:
   - Reminder is NOT marked as fired
   - Retry queue has 1 item
   - After 1 minute, retry attempt #2 logged

3. **Max retries exhausted** — Keep WebSocket disconnected for >21 minutes → verify:
   - 3 attempts logged (at 0m, 1m, 5m, 15m)
   - After 3rd failure, entry written to `data/failed-reminders.jsonl`
   - Retry queue is empty

4. **Recovery mid-retry** — Disconnect WS, fire trigger, reconnect WS within 1 minute → verify:
   - Retry attempt #2 succeeds
   - Trigger is marked as fired
   - Item removed from queue

5. **Health endpoint** — `GET /api/health` → verify `scheduler.retryQueueSize` reflects actual queue
