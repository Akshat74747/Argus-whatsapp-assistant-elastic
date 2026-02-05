# Changelog

All notable changes to Argus will be documented in this file.

## [2.3.1] - 2026-02-05

### Fixed
- **Chrome Popup buttons** - Changed from inline onclick to addEventListener with data-action attributes
- **Dismiss loop bug** - Added dismissedEventIds and handledEventIds Sets to prevent popup reopening
- **Content script actions** - Added schedule, snooze, ignore, complete actions to handleAction()
- **Background.js message handlers** - Added SNOOZE_EVENT and IGNORE_EVENT handlers
- **WebSocket auto-refresh** - Webapp now handles all event types: event_scheduled, event_snoozed, event_ignored, event_completed

### Changed
- **popup.js v2.2** - Buttons disable during API calls, auto-refresh every 5s
- **content.js v2.2** - Tracks handled events to prevent re-showing
- **background.js v2.3** - Better logging for all API calls

## [2.3.0] - 2026-02-05

### Added
- **Proper Event Status System** - Complete lifecycle management with meaningful statuses:
  - `discovered` → New event from WhatsApp (needs user action)
  - `scheduled` → User approved, will show context reminders & 1hr before notifications
  - `snoozed` → User said "later", will remind again in 30 minutes
  - `ignored` → User doesn't care (hidden but not deleted)
  - `reminded` → 1-hour before reminder was shown
  - `completed` → User marked as done
  - `expired` → Event time passed without action

- **New Event Actions**:
  - `📅 Schedule` - Approve event for reminders (discovered → scheduled)
  - `💤 Snooze` - Remind again in 30 minutes (any → snoozed)
  - `🚫 Ignore` - Hide event without deleting (discovered → ignored)
  - `✅ Done` - Mark as completed (scheduled → completed)
  - `↩️ Restore` - Bring back ignored event (ignored → scheduled)
  - `🗑️ Delete` - Permanent removal (only for ignored/completed)

- **API Endpoints**:
  - `POST /api/events/:id/set-reminder` - Schedule event
  - `POST /api/events/:id/snooze` - Snooze for X minutes
  - `POST /api/events/:id/ignore` - Ignore event
  - `POST /api/events/:id/complete` - Mark done
  - `DELETE /api/events/:id` - Delete permanently

- **Snooze Scheduler** - Background job checks every 30s for snoozed events that are due
- **Extension host_permissions** - Changed from localhost-only to `<all_urls>` for popup on any tab
- **Tab detection** - Popups now show on any active tab, not just localhost:3000

### Changed
- **Dashboard tabs** - New: 🆕 New | 📅 Active | 💤 Snoozed | ✅ Done | 🚫 Ignored | 📋 All
- **Chrome popup tabs** - New: 🆕 New | 📅 Active | ✅ Done
- **Stats** - pendingEvents now = discoveredEvents + snoozedEvents
- **Action buttons** - Contextual based on event status (no delete for discovered)

### Fixed
- **Popup not appearing on external sites** - manifest.json host_permissions now `<all_urls>`
- **Context reminders require approval** - Only shows for `scheduled` events
- **Event flow clarity** - Removed ambiguous "pending" status

### User Flow
1. WhatsApp message → Event discovered → Popup on current tab
2. User clicks "📅 Schedule" → Status = scheduled
3. User visits netflix.com → Context reminder popup (only if scheduled)
4. User clicks "✅ Done" → Status = completed

OR

1. User clicks "💤 Snooze" → Status = snoozed, reminder_time = now + 30min
2. After 30 min → Scheduler re-shows popup, status → discovered

## [2.2.0] - 2026-02-05

### Added
- **Calendar conflict detection** - Warns when new events conflict with existing events (±1 hour window)
- **Travel/Goa scenario** - Any message mentioning travel destinations sets context_url for URL matching
- **Service name extraction** - Subscriptions use just the service name (netflix, hotstar) not full domain
- **Enhanced Gemini prompt** - Better extraction of service names and travel destinations

### Fixed
- **URL matching** - Now case-insensitive, matches if URL contains the keyword anywhere
- **Subscription context** - "want to cancel netflix" now correctly sets context_url="netflix"
- **Travel context** - "Rahul recommended cashews in Goa" now sets context_url="goa"

### Scenarios Working
- ✅ **Netflix Subscription** - "cancel my netflix" + visit netflix.com → shows reminder
- ✅ **Goa Cashew** - "cashews in goa" + visit goatourism.com → shows reminder  
- ✅ **Calendar Conflict** - Create overlapping event → shows conflict warning

### Technical
- `checkEventConflicts()` function in db.ts for conflict detection
- `context_url` now stores just keywords (netflix, goa) not full domains
- URL matching: `LOWER(url) LIKE '%' || LOWER(context_url) || '%'`

## [2.1.0] - 2026-02-06

### Added
- **Root dev script** - `npm run dev` from project root runs both Evolution API and Argus concurrently
- **Subscription keyword detection** - Classifier now recognizes netflix, amazon, prime, subscription keywords
- **Typo tolerance** - Message classifier handles typos like "cancle" → "cancel"
- **Intent pattern recognition** - Detects "want to", "need to", "planning to" patterns

### Fixed
- **Chrome notification removed** - All popups now display as in-page overlays (no more native Chrome notifications)
- **Context check API response** - Returns full `contextTriggers` array instead of just count
- **Popup persistence** - Context reminder popups stay visible until user takes action
- **Tab change handling** - Popups no longer disappear when switching tabs

### Changed
- **Extension v2.1** - Complete rewrite of background.js and content.js for cleaner code
- **Consistent logging** - All extension logs use `[Argus]` prefix
- **Variable naming** - Standardized variable names across extension files

### Scenarios Supported
- ✅ Netflix Subscription (visit netflix.com → shows cancel reminder)
- ⏳ Goa Cashew (visit travel sites → shows recommendation)
- ⏳ Gift Intent (visit shopping sites → shows suggestion)
- ⏳ Insurance Accuracy (visit insurance sites → shows correction)
- ⏳ Calendar Conflict (scheduling conflicts → shows warning)

## [1.2.0] - 2026-02-05

### Added
- **Multi-type popup system** - 5 different modal types for different scenarios:
  - `event_discovery` - New event detected, ask user to set reminder
  - `event_reminder` - 1 hour before event notification (with countdown)
  - `context_reminder` - URL-based triggers (Netflix scenario) - persistent until done
  - `conflict_warning` - Calendar conflict alerts
  - `insight_card` - Recommendations and suggestions
- **Smart reminder flow**:
  - New events start as `discovered` (not auto-scheduled)
  - User can choose to "Set Reminder" or dismiss
  - Automatic 1-hour-before reminder for scheduled events
  - Context reminders reappear when visiting same URL
- **Event status system** - Events now have proper lifecycle:
  - `discovered` → `scheduled` → `reminded` → `completed`
  - `dismissed` status for temporary dismissals
- **Context URL triggers** - Set URL patterns to trigger events (like Netflix cancellation reminder)
- **New API endpoints**:
  - `POST /api/events/:id/set-reminder` - Schedule reminder for event
  - `POST /api/events/:id/dismiss` - Temporary or permanent dismissal
  - `POST /api/events/:id/acknowledge` - Acknowledge 1-hour reminder
  - `POST /api/events/:id/done` - Mark event as completed
  - `POST /api/events/:id/context-url` - Set URL trigger for event
  - `GET /api/events/status/:status` - Query events by status
- **Reminder scheduler** - Background job checks for due reminders every 30 seconds
- **Temporary dismissal tracking** - Context reminders wait 30 minutes before showing again

### Changed
- Extension popups now have 3 buttons for more control (Set Reminder / Not Now / Delete)
- Modal headers have different colors based on popup type
- Reminder popups have pulsing animation for urgency
- Events are created with `discovered` status by default

## [1.1.0] - 2026-02-05

### Added
- **WebSocket event broadcasting** - Events are now pushed to browser extension in real-time
- **Modal overlay notifications** - Centered modal popup for new events (similar to survey overlays)
- **Chrome notification integration** - Native notifications with Accept/Dismiss actions
- **Extension debug logging** - Added comprehensive logging for troubleshooting
- **Evolution DB direct integration** - Query PostgreSQL directly for WhatsApp messages
- **Instance ID resolution** - Auto-resolve instance name to UUID for queries
- **JSONB query support** - Proper extraction from Evolution's JSONB columns
- **Source message tracking** - Events now include reference to originating WhatsApp message
- **Event cancellation detection** - DB function to find events by keywords for updates

### Fixed
- **Content script syntax error** - Fixed escaped backticks in template strings
- **Foreign key constraint error** - Delete triggers before events to avoid FK violation
- **JSONB parsing** - Handle pg auto-parsed JSONB objects in message content
- **Instance name vs UUID** - Proper resolution from name to UUID for database queries

### Changed
- Ingestion now returns created events with full data for broadcasting
- WebSocket clients receive full event objects instead of just counts
- Extension shows centered modal for new events instead of toast notification
- Background service worker logs WebSocket messages for debugging

## [1.0.0] - 2026-02-04

### Added
- Initial project setup with ultra-simple architecture
- SQLite database with FTS5 full-text search
- Gemini 3 Flash integration for event extraction
- Chrome Extension (Manifest V3) for URL detection
- WebSocket support for real-time notifications
- Evolution API webhook integration
- Context matching with cascading SQL queries
- Time-based trigger scheduler
- Overlay notifications in browser
- Docker Compose deployment with pre-built images
- Fast test suite with Vitest (~2s execution)
- ESLint + Prettier for code quality

### Architecture Decisions
- No FAISS/Vector embeddings - using SQLite FTS5 instead
- No OpenAI - Gemini only (per hackathon requirements)
- Single container per user model
- 90-day hot window for context matching
- URL detection only (no DOM reading for MVP)

