// Argus Content Script - Modal Overlay + Toast Notifications

const STYLES = `
/* ============ MODAL OVERLAY ============ */
#argus-modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 2147483646;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: argus-fade-in 0.2s ease-out;
}

@keyframes argus-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes argus-scale-in {
  from { transform: scale(0.9); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

@keyframes argus-scale-out {
  from { transform: scale(1); opacity: 1; }
  to { transform: scale(0.9); opacity: 0; }
}

#argus-modal {
  background: linear-gradient(145deg, #ffffff, #f8f9fa);
  border-radius: 16px;
  box-shadow: 0 25px 80px rgba(0, 0, 0, 0.4);
  max-width: 420px;
  width: 90%;
  overflow: hidden;
  animation: argus-scale-in 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

#argus-modal.hiding {
  animation: argus-scale-out 0.2s ease-in forwards;
}

.argus-modal-header {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 24px;
  position: relative;
}

.argus-modal-close {
  position: absolute;
  top: 12px;
  right: 12px;
  background: rgba(255,255,255,0.2);
  border: none;
  color: white;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  cursor: pointer;
  font-size: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.argus-modal-close:hover {
  background: rgba(255,255,255,0.3);
  transform: scale(1.1);
}

.argus-modal-icon {
  width: 64px;
  height: 64px;
  background: rgba(255,255,255,0.2);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 16px;
  font-size: 32px;
}

.argus-modal-title {
  color: white;
  font-size: 22px;
  font-weight: 700;
  text-align: center;
  margin: 0;
  text-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.argus-modal-subtitle {
  color: rgba(255,255,255,0.9);
  font-size: 14px;
  text-align: center;
  margin-top: 8px;
}

.argus-modal-body {
  padding: 24px;
}

.argus-modal-event-title {
  font-size: 18px;
  font-weight: 600;
  color: #1a1a2e;
  margin-bottom: 8px;
}

.argus-modal-event-desc {
  color: #666;
  font-size: 14px;
  line-height: 1.5;
  margin-bottom: 16px;
}

.argus-modal-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 20px;
}

.argus-modal-meta-item {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #f0f0f5;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  color: #444;
}

.argus-modal-meta-item span {
  font-size: 16px;
}

.argus-modal-actions {
  display: flex;
  gap: 12px;
}

.argus-modal-btn {
  flex: 1;
  padding: 14px 24px;
  border: none;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.argus-modal-btn-accept {
  background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
  color: white;
  box-shadow: 0 4px 15px rgba(56, 239, 125, 0.3);
}

.argus-modal-btn-accept:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(56, 239, 125, 0.4);
}

.argus-modal-btn-dismiss {
  background: #f0f0f5;
  color: #666;
}

.argus-modal-btn-dismiss:hover {
  background: #e5e5ea;
  transform: translateY(-2px);
}

.argus-modal-footer {
  padding: 12px 24px 16px;
  text-align: center;
  border-top: 1px solid #eee;
}

.argus-modal-powered {
  font-size: 11px;
  color: #999;
}

.argus-modal-powered strong {
  color: #667eea;
}

/* ============ TOAST NOTIFICATIONS ============ */
#argus-overlay-container {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
}

.argus-toast {
  background: linear-gradient(145deg, #1a1a2e, #16213e);
  border: 1px solid rgba(88, 166, 255, 0.3);
  border-radius: 12px;
  padding: 16px 20px;
  min-width: 320px;
  max-width: 400px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  animation: argus-slide-in 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: all;
  color: #e6edf3;
}

.argus-toast.new-event { border-left: 4px solid #3fb950; }
.argus-toast.reminder { border-left: 4px solid #d29922; }
.argus-toast.context { border-left: 4px solid #58a6ff; }

@keyframes argus-slide-in {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

@keyframes argus-toast-out {
  from { transform: translateX(0); opacity: 1; }
  to { transform: translateX(100%); opacity: 0; }
}

.argus-toast.hiding {
  animation: argus-toast-out 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

.argus-toast-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.argus-toast-title {
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.argus-toast-close {
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0;
}

.argus-toast-close:hover { color: #e6edf3; }

.argus-toast-body {
  margin-bottom: 16px;
}

.argus-event-title {
  font-weight: 500;
  font-size: 15px;
  margin-bottom: 4px;
}

.argus-event-desc {
  color: #8b949e;
  font-size: 13px;
  line-height: 1.4;
}

.argus-event-meta {
  display: flex;
  gap: 12px;
  margin-top: 8px;
  font-size: 12px;
  color: #8b949e;
}

.argus-toast-actions {
  display: flex;
  gap: 8px;
}

.argus-btn {
  flex: 1;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.argus-btn-accept {
  background: #238636;
  color: white;
}

.argus-btn-accept:hover {
  background: #2ea043;
  transform: translateY(-1px);
}

.argus-btn-reject {
  background: #21262d;
  color: #f85149;
  border: 1px solid #30363d;
}

.argus-btn-reject:hover {
  background: #30363d;
  transform: translateY(-1px);
}
`;

let overlayContainer = null;
let styleElement = null;
let currentModal = null;

function ensureStyles() {
  if (styleElement) return;
  styleElement = document.createElement('style');
  styleElement.textContent = STYLES;
  document.head.appendChild(styleElement);
}

function createOverlay() {
  if (overlayContainer) return overlayContainer;
  
  ensureStyles();
  overlayContainer = document.createElement('div');
  overlayContainer.id = 'argus-overlay-container';
  document.body.appendChild(overlayContainer);

  return overlayContainer;
}

// ============ MODAL OVERLAY ============
function showModal(event, modalType = 'new-event') {
  ensureStyles();
  
  // Remove existing modal
  if (currentModal) {
    closeModal();
  }

  const icon = modalType === 'new-event' ? '📅' : 
               modalType === 'reminder' ? '⏰' : '🎯';
  const headerTitle = modalType === 'new-event' ? 'New Event Detected!' : 
                       modalType === 'reminder' ? 'Reminder!' : 'Relevant Event Found';
  const headerSubtitle = modalType === 'new-event' ? 'From your WhatsApp messages' : 
                          modalType === 'reminder' ? 'Don\'t forget!' : 'Matches your current context';

  const backdrop = document.createElement('div');
  backdrop.id = 'argus-modal-backdrop';
  
  const eventTime = event.event_time ? new Date(event.event_time * 1000) : null;
  const timeStr = eventTime ? eventTime.toLocaleString('en-US', { 
    weekday: 'short', 
    month: 'short', 
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }) : null;

  backdrop.innerHTML = `
    <div id="argus-modal">
      <div class="argus-modal-header">
        <button class="argus-modal-close">✕</button>
        <div class="argus-modal-icon">${icon}</div>
        <h2 class="argus-modal-title">${headerTitle}</h2>
        <p class="argus-modal-subtitle">${headerSubtitle}</p>
      </div>
      <div class="argus-modal-body">
        <div class="argus-modal-event-title">${event.title || 'Untitled Event'}</div>
        ${event.description ? `<div class="argus-modal-event-desc">${event.description}</div>` : ''}
        <div class="argus-modal-meta">
          ${timeStr ? `<div class="argus-modal-meta-item"><span>📅</span> ${timeStr}</div>` : ''}
          ${event.location ? `<div class="argus-modal-meta-item"><span>📍</span> ${event.location}</div>` : ''}
          ${event.event_type ? `<div class="argus-modal-meta-item"><span>🏷️</span> ${event.event_type}</div>` : ''}
        </div>
        ${event.id ? `
        <div class="argus-modal-actions">
          <button class="argus-modal-btn argus-modal-btn-accept">✓ Accept</button>
          <button class="argus-modal-btn argus-modal-btn-dismiss">✗ Dismiss</button>
        </div>` : ''}
      </div>
      <div class="argus-modal-footer">
        <span class="argus-modal-powered">Powered by <strong>Argus</strong></span>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  currentModal = backdrop;

  // Event handlers
  backdrop.querySelector('.argus-modal-close').onclick = () => closeModal();
  backdrop.onclick = (e) => {
    if (e.target === backdrop) closeModal();
  };

  const acceptBtn = backdrop.querySelector('.argus-modal-btn-accept');
  const dismissBtn = backdrop.querySelector('.argus-modal-btn-dismiss');

  if (acceptBtn) {
    acceptBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'COMPLETE_EVENT', eventId: event.id });
      closeModal();
    };
  }

  if (dismissBtn) {
    dismissBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'DELETE_EVENT', eventId: event.id });
      closeModal();
    };
  }

  // ESC key to close
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);

  // Auto-close after 30 seconds
  setTimeout(() => {
    if (currentModal === backdrop) {
      closeModal();
    }
  }, 30000);
}

function closeModal() {
  if (!currentModal) return;
  
  const modal = currentModal.querySelector('#argus-modal');
  if (modal) {
    modal.classList.add('hiding');
  }
  
  setTimeout(() => {
    if (currentModal) {
      currentModal.remove();
      currentModal = null;
    }
  }, 200);
}

// ============ TOAST NOTIFICATIONS ============
function showToast(event, toastType = 'context') {
  const container = createOverlay();

  const toast = document.createElement('div');
  toast.className = 'argus-toast ' + toastType;
  
  const icon = toastType === 'new-event' ? '🆕' : 
               toastType === 'reminder' ? '⏰' : '🎯';
  const title = toastType === 'new-event' ? 'New Event Detected!' : 
                toastType === 'reminder' ? 'Reminder!' : 'Argus Match';
  
  let html = '<div class="argus-toast-header">';
  html += '<div class="argus-toast-title">' + icon + ' ' + title + '</div>';
  html += '<button class="argus-toast-close">✕</button>';
  html += '</div>';
  html += '<div class="argus-toast-body">';
  html += '<div class="argus-event-title">' + (event.title || 'Untitled Event') + '</div>';
  if (event.description) {
    html += '<div class="argus-event-desc">' + event.description + '</div>';
  }
  html += '<div class="argus-event-meta">';
  if (event.location) {
    html += '<span>📍 ' + event.location + '</span>';
  }
  if (event.event_time) {
    html += '<span>📅 ' + new Date(event.event_time * 1000).toLocaleDateString() + '</span>';
  }
  html += '</div></div>';
  if (event.id) {
    html += '<div class="argus-toast-actions">';
    html += '<button class="argus-btn argus-btn-accept">✓ Accept</button>';
    html += '<button class="argus-btn argus-btn-reject">✗ Reject</button>';
    html += '</div>';
  }
  
  toast.innerHTML = html;  // Event handlers
  toast.querySelector('.argus-toast-close').onclick = () => removeToast(toast);
  
  const acceptBtn = toast.querySelector('.argus-btn-accept');
  const rejectBtn = toast.querySelector('.argus-btn-reject');
  
  if (acceptBtn) {
    acceptBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'COMPLETE_EVENT', eventId: event.id });
      removeToast(toast);
    };
  }
  
  if (rejectBtn) {
    rejectBtn.onclick = () => {
      chrome.runtime.sendMessage({ type: 'DELETE_EVENT', eventId: event.id });
      removeToast(toast);
    };
  }

  container.appendChild(toast);

  // Auto-dismiss after 15 seconds
  setTimeout(() => removeToast(toast), 15000);
}

function removeToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.add('hiding');
  setTimeout(() => toast.remove(), 300);
}

function showNotification(events) {
  events.slice(0, 3).forEach((event, index) => {
    setTimeout(() => showToast(event, 'context'), index * 200);
  });
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Argus Content: Received message:', message.type, message);
  
  if (message.type === 'ARGUS_NOTIFICATION') {
    console.log('Argus Content: Showing notification for events');
    showNotification(message.events);
    sendResponse({ received: true });
  } else if (message.type === 'ARGUS_NEW_EVENT') {
    // Show prominent modal overlay for new events
    console.log('Argus Content: Showing MODAL for new event:', message.event);
    showModal(message.event, 'new-event');
    sendResponse({ received: true });
  } else if (message.type === 'ARGUS_REMINDER') {
    // Show modal for reminders
    console.log('Argus Content: Showing MODAL for reminder');
    showModal(message.event || { title: message.message }, 'reminder');
    sendResponse({ received: true });
  }
  return true;
});

console.log('Argus content script loaded');
