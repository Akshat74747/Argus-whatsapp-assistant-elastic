# Argus - Proactive Memory Assistant

AI-powered WhatsApp assistant that learns from your conversations and reminds you about relevant events while browsing.

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run tests (fast!)
npm test
```

## 📁 Project Structure

```
argus/
├── src/
│   ├── server.ts      # Express server + WebSocket
│   ├── db.ts          # SQLite + FTS5 database
│   ├── gemini.ts      # Gemini API integration
│   ├── ingestion.ts   # Message processing
│   ├── matcher.ts     # URL context matching
│   ├── scheduler.ts   # Time-based triggers
│   └── types.ts       # Zod schemas
├── extension/         # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── background.js  # URL detection
│   ├── content.js     # Overlay notifications
│   ├── popup.html/js  # Extension popup
│   └── icons/         # Extension icons
├── tests/             # Vitest tests
├── data/              # SQLite database
└── docker-compose.yml # Full stack deployment
```

## 🔧 Development

### Prerequisites

- Node.js 22+
- npm 10+

### Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Build for production |
| `npm test` | Run tests (fast, ~2s) |
| `npm run lint` | Lint code |
| `npm run format` | Format code |
| `npm run typecheck` | Type check |

### Load Chrome Extension

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/` folder

## 🐳 Docker Deployment

```bash
# Start all services (Argus + Evolution API + PostgreSQL)
docker-compose up -d

# View logs
docker-compose logs -f argus

# Stop
docker-compose down
```

## 📡 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/stats` | GET | Get statistics |
| `/api/events` | GET | List pending events |
| `/api/events/:id` | GET | Get single event |
| `/api/events/:id/complete` | POST | Mark event done |
| `/api/webhook/whatsapp` | POST | Evolution API webhook |
| `/api/context-check` | POST | Check URL for relevant events |
| `/ws` | WebSocket | Real-time notifications |

## 🎯 How It Works

1. **WhatsApp messages** arrive via Evolution API webhook
2. **Gemini extracts** events, tasks, and reminders
3. **SQLite FTS5** stores and indexes everything
4. **WebSocket broadcasts** events to connected browser extensions
5. **Chrome extension** receives real-time event notifications
6. **Modal overlay** appears on any browser tab with event details
7. **Context matching** finds relevant events when browsing
8. **Proactive notification** appears when visiting related URLs

### Features

- ✅ Real-time event detection from WhatsApp messages
- ✅ Centered modal overlay notifications (like survey popups)
- ✅ Chrome native notifications with Accept/Dismiss actions
- ✅ Direct Evolution PostgreSQL integration for message history
- ✅ WebSocket push for instant updates
- ✅ Context-aware reminders based on browsing activity
- ✅ Full-text search across all messages
- ✅ Event cancellation/update detection

## ⚙️ Configuration

Copy `.env.example` to `.env` and set:

```bash
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3-flash-preview
```

## 📊 Performance

- Message ingestion: <500ms
- Context check: <800ms
- Database query: <10ms
- Memory usage: <200MB
- 50k messages: ~40MB storage

## 🧪 Testing

Tests run in ~2 seconds using Vitest with:
- Single fork pool (faster)
- Dot reporter (minimal output)
- In-memory SQLite
- Cached dependencies

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```

## 📝 License

Private - All rights reserved
