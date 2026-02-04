// Argus Background Service Worker
const API_BASE = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000';
let lastUrl = '';
let debounceTimer = null;
let ws = null;
let reconnectAttempts = 0;

// Debounce URL checks
function debounce(fn, delay) {
  return (...args) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fn(...args), delay);
  };
}

// WebSocket connection for real-time notifications
function connectWebSocket() {
  try {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
      console.log('Argus: WebSocket connected');
      reconnectAttempts = 0;
    };
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('Argus: WS received:', data.type, data);
        
        if (data.type === 'notification') {
          // New event detected from WhatsApp
          console.log('Argus: New event notification, sending to all tabs');
          showNotification(data.event, 'new_event');
          // Also notify content script
          notifyAllTabs({
            type: 'ARGUS_NEW_EVENT',
            event: data.event,
          });
        } else if (data.type === 'trigger') {
          // Reminder triggered
          showNotification({
            title: 'Reminder!',
            description: data.message,
          }, 'reminder');
          notifyAllTabs({
            type: 'ARGUS_REMINDER',
            message: data.message,
            event: data.event,
          });
        }
      } catch (e) {
        console.log('Argus: WS parse error', e);
      }
    };
    
    ws.onclose = () => {
      console.log('Argus: WebSocket disconnected');
      // Reconnect with exponential backoff
      const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts));
      reconnectAttempts++;
      setTimeout(connectWebSocket, delay);
    };
    
    ws.onerror = (error) => {
      console.log('Argus: WebSocket error', error);
    };
  } catch (e) {
    console.log('Argus: Failed to create WebSocket', e);
  }
}

// Notify all tabs
async function notifyAllTabs(message) {
  const tabs = await chrome.tabs.query({});
  console.log('Argus: Notifying', tabs.length, 'tabs with message:', message.type);
  tabs.forEach(tab => {
    if (tab.id && !tab.url?.startsWith('chrome://')) {
      console.log('Argus: Sending to tab', tab.id, tab.url?.substring(0, 50));
      chrome.tabs.sendMessage(tab.id, message).catch((e) => {
        console.log('Argus: Failed to send to tab', tab.id, e.message);
      });
    }
  });
}

// Check context with backend
async function checkContext(url, title) {
  // Skip internal URLs
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
    return;
  }

  // Skip if same as last URL
  if (url === lastUrl) return;
  lastUrl = url;

  try {
    const response = await fetch(`${API_BASE}/api/context-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title }),
    });

    if (!response.ok) {
      console.log('Argus: API error', response.status);
      return;
    }

    const result = await response.json();

    if (result.matched && result.events.length > 0) {
      // Store for popup
      chrome.storage.local.set({
        lastMatch: {
          url,
          events: result.events,
          timestamp: Date.now(),
        },
      });

      // Send to content script for overlay
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'ARGUS_NOTIFICATION',
          events: result.events,
        }).catch(() => {
          // Content script not loaded, show notification instead
          showNotification(result.events[0]);
        });
      }

      // Show Chrome notification
      showNotification(result.events[0]);
    }
  } catch (error) {
    console.log('Argus: Failed to check context', error.message);
  }
}

// Show Chrome notification with actions
function showNotification(event, notificationType = 'context') {
  const notificationId = `argus-${Date.now()}`;
  
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: notificationType === 'new_event' ? '🆕 New Event Detected!' : 
           notificationType === 'reminder' ? '⏰ Reminder!' : '🎯 Argus Reminder',
    message: event.title + (event.description ? '\n' + event.description : ''),
    priority: 2,
    requireInteraction: true,
    buttons: event.id ? [
      { title: '✓ Accept' },
      { title: '✗ Dismiss' }
    ] : [],
  });
  
  // Store event ID for button handling
  if (event.id) {
    chrome.storage.local.set({ [`notification_${notificationId}`]: event.id });
  }
}

// Handle notification button clicks
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  const data = await chrome.storage.local.get(`notification_${notificationId}`);
  const eventId = data[`notification_${notificationId}`];
  
  if (eventId) {
    if (buttonIndex === 0) {
      // Accept - complete event
      await fetch(`${API_BASE}/api/events/${eventId}/complete`, { method: 'POST' });
    } else {
      // Dismiss - delete event
      await fetch(`${API_BASE}/api/events/${eventId}`, { method: 'DELETE' });
    }
    chrome.storage.local.remove(`notification_${notificationId}`);
  }
  
  chrome.notifications.clear(notificationId);
});

// Handle notification clicks
chrome.notifications.onClicked.addListener((notificationId) => {
  // Open dashboard
  chrome.tabs.create({ url: 'http://localhost:3000' });
  chrome.notifications.clear(notificationId);
});

// Debounced check
const debouncedCheck = debounce(checkContext, 1000);

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.active) {
    debouncedCheck(tab.url, tab.title);
  }
});

// Listen for tab activation
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) {
      debouncedCheck(tab.url, tab.title);
    }
  } catch (e) {
    // Tab might be closed
  }
});

// Health check on startup
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const response = await fetch(`${API_BASE}/api/health`);
    if (response.ok) {
      console.log('Argus: Connected to backend ✅');
    }
  } catch {
    console.log('Argus: Backend not running. Start with: npm run dev');
  }
  
  // Connect WebSocket
  connectWebSocket();
});

// Also connect on startup (for when extension already installed)
connectWebSocket();

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_STATS') {
    fetch(`${API_BASE}/api/stats`)
      .then(r => r.json())
      .then(sendResponse)
      .catch(() => sendResponse({ error: 'Failed to fetch stats' }));
    return true;
  }

  if (message.type === 'GET_EVENTS') {
    fetch(`${API_BASE}/api/events?limit=10`)
      .then(r => r.json())
      .then(sendResponse)
      .catch(() => sendResponse({ error: 'Failed to fetch events' }));
    return true;
  }

  if (message.type === 'COMPLETE_EVENT') {
    fetch(`${API_BASE}/api/events/${message.eventId}/complete`, { method: 'POST' })
      .then(r => r.json())
      .then(sendResponse)
      .catch(() => sendResponse({ error: 'Failed to complete event' }));
    return true;
  }

  if (message.type === 'DELETE_EVENT') {
    fetch(`${API_BASE}/api/events/${message.eventId}`, { method: 'DELETE' })
      .then(r => r.json())
      .then(sendResponse)
      .catch(() => sendResponse({ error: 'Failed to delete event' }));
    return true;
  }
});

console.log('Argus Background Service Worker loaded');
