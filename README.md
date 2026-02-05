# Argus - WhatsApp Memory Assistant

> AI-powered proactive memory assistant that learns from your WhatsApp conversations and reminds you about relevant events while browsing.

[![License](https://img.shields.io/badge/license-Private-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

## 🎯 What is Argus?

Argus is a smart assistant that:
- 📱 **Monitors your WhatsApp** messages via Evolution API
- 🧠 **Extracts events** using Gemini AI (meetings, deadlines, reminders)
- 🔔 **Pushes notifications** to your browser in real-time via WebSocket
- 🎨 **Shows modal overlays** on any browser tab when events are detected
- 🔍 **Matches context** by analyzing URLs you visit
- ⏰ **Triggers reminders** at the right time and place

**Example:** Your friend texts "Let's meet at 3pm tomorrow at Starbucks". Argus:
1. Detects the event using Gemini
2. Pushes it to your browser via WebSocket
3. Shows a beautiful modal overlay with Accept/Dismiss actions
4. Later, when you visit Google Maps or Starbucks website, reminds you again

## 🚀 Quick Start

### Prerequisites

- Node.js 22+
- Docker & Docker Compose
- Chrome browser
- Gemini API key

### Installation

```bash
# Clone the repository
git clone https://github.com/nityam2007/argus-whatsapp-assistant.git
cd argus-whatsapp-assistant

# Install dependencies
cd argus
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY

# Start all services (Argus + Evolution API + PostgreSQL)
docker-compose up -d

# Or run Argus standalone
npm run dev
```

### Load Chrome Extension

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `argus/extension/` folder

### Configure Evolution API

1. Access Evolution API at `http://localhost:8080`
2. Create a WhatsApp instance named "arguas"
3. Connect your WhatsApp by scanning QR code
4. Set webhook URL: `http://localhost:3000/api/webhook/whatsapp`

## 📁 Project Structure

```
whatsapp-chat-rmd-argus/
├── argus/                    # Main application
│   ├── src/
│   │   ├── server.ts        # Express + WebSocket server
│   │   ├── db.ts            # SQLite database
│   │   ├── evolution-db.ts  # PostgreSQL Evolution DB integration
│   │   ├── gemini.ts        # Gemini AI integration
│   │   ├── ingestion.ts     # Message processing pipeline
│   │   ├── matcher.ts       # URL context matching
│   │   └── scheduler.ts     # Time-based triggers
│   ├── extension/           # Chrome Extension (Manifest V3)
│   │   ├── background.js    # WebSocket client, URL detection
│   │   ├── content.js       # Modal overlay injection
│   │   └── manifest.json    # Extension config
│   ├── tests/               # Vitest test suite
│   └── docker-compose.yml   # Full stack deployment
├── evolution-api/           # WhatsApp API (submodule/separate)
├── RULES.md                 # Development rules
└── README.md               # This file
```

## ✨ Features

### Real-Time Event Broadcasting
- WebSocket connection pushes events instantly to browser
- No polling - zero delay notifications
- Automatic reconnection with exponential backoff

### Modal Overlay Notifications
- Centered, beautiful modal popup (like survey overlays)
- Gradient header with event icon
- 5 popup types: discovery, reminder, context, conflict, insight
- Accept/Dismiss/Set Reminder action buttons
- Context reminders persist until user acts

### Context-Aware Triggers
- **Subscriptions:** "cancel netflix" → triggers on netflix.com
- **Travel:** "cashews in goa" → triggers on any goa URL
- **Conflicts:** overlapping events → shows warning popup

### Direct Evolution DB Integration
- Query WhatsApp messages directly from PostgreSQL
- JSONB extraction for message content
- Instance name to UUID auto-resolution
- 43,000+ message search in <10ms

### Smart Context Matching
- URL keyword extraction
- Cascading SQL queries with FTS5
- Location/keyword trigger detection
- 90-day hot window optimization

## 🔧 Development

```bash
cd argus

# Development with hot reload
npm run dev

# Run tests (fast, ~2s)
npm test

# Lint & format
npm run lint
npm run format

# Type checking
npm run typecheck

# Production build
npm run build
npm start
```

## 📡 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check with DB status |
| `/api/stats` | GET | Message/event statistics |
| `/api/events` | GET | List events (pending/completed/all) |
| `/api/events/:id` | GET | Get single event details |
| `/api/events/:id/complete` | POST | Mark event as completed |
| `/api/events/:id` | DELETE | Delete event |
| `/api/webhook/whatsapp` | POST | Evolution API webhook receiver |
| `/api/context-check` | POST | Check URL for relevant events |
| `/api/whatsapp/messages` | GET | Query WhatsApp messages |
| `/api/whatsapp/stats` | GET | WhatsApp statistics |
| `/ws` | WebSocket | Real-time event notifications |

## 🐳 Docker Deployment

The project uses pre-built Docker images for fast deployment:

```yaml
services:
  argus:              # Main application (Node 22 Alpine)
  evolution-api:      # WhatsApp bridge (atendai/evolution-api:v2.1.1)
  evolution-postgres: # Database (Postgres 16 Alpine)
```

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f argus

# Restart Argus
docker-compose restart argus

# Stop all
docker-compose down
```

## 📊 Performance

- **Message ingestion:** <500ms (Gemini extraction included)
- **Context check:** <800ms (FTS5 search + matching)
- **Database query:** <10ms (50k messages indexed)
- **Memory usage:** <200MB (includes SQLite + Node runtime)
- **WebSocket latency:** <50ms (event → browser overlay)
- **Storage:** ~40MB for 50k messages

## 🧪 Testing

Fast test suite with Vitest:

```bash
npm test              # Run all tests (~2s)
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

Tests use:
- In-memory SQLite (no disk I/O)
- Single fork pool (parallel execution)
- Dot reporter (minimal output)
- Cached dependencies

## 🏗️ Architecture

### Tech Stack
- **Runtime:** Node.js 22 (ESM)
- **Language:** TypeScript 5.7
- **Database:** SQLite 3 with FTS5 full-text search
- **AI:** Google Gemini 3 Flash Preview
- **WhatsApp:** Evolution API v2.1.1
- **Evolution DB:** PostgreSQL 16
- **Browser:** Chrome Extension (Manifest V3)
- **Real-time:** WebSocket (ws library)
- **Testing:** Vitest

### Key Design Decisions

✅ **SQLite FTS5 instead of vector embeddings**
- No FAISS/pgvector complexity
- Sub-10ms full-text search on 50k messages
- Zero external dependencies

✅ **Gemini only (no OpenAI)**
- Per hackathon requirements
- Cost-effective for extraction tasks
- Fast response times

✅ **Single container per user**
- Simplified deployment
- Easy scaling horizontally
- Isolated data/state

✅ **90-day hot window**
- Balance between relevance and performance
- Automatic cleanup of old data
- Configurable via environment

✅ **URL detection only (no DOM reading)**
- MVP scope - fast implementation
- Privacy-friendly
- Low overhead

## 📝 Changelog

See [CHANGELOG.md](argus/CHANGELOG.md) for version history.

### Latest: v2.2.0 (2026-02-05)

**Scenarios Working:**
- ✅ Netflix Subscription - cancel reminder on netflix.com
- ✅ Goa Cashew - travel recommendations on goa URLs
- ✅ Calendar Conflict - overlapping event warnings

**Added:**
- Calendar conflict detection (±1 hour window)
- Travel/location context extraction (goa, mumbai, delhi)
- Service name extraction for subscriptions (netflix, hotstar)

**Fixed:**
- URL matching now case-insensitive
- context_url uses keywords not full domains
- All popups show as in-page overlays (no Chrome notifications)

## 🤝 Contributing

This is a private project. For collaboration inquiries, contact the maintainer.

## 📄 License

Private - All rights reserved

## 🙏 Acknowledgments

- [Evolution API](https://github.com/EvolutionAPI/evolution-api) - WhatsApp integration
- [Google Gemini](https://ai.google.dev/) - AI event extraction
- [SQLite FTS5](https://www.sqlite.org/fts5.html) - Full-text search
- Chrome Extension Manifest V3 - Browser integration

---

Built with ❤️ for seamless WhatsApp-browser integration
