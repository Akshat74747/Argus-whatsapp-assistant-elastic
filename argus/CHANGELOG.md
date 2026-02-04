# Changelog

All notable changes to Argus will be documented in this file.

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

