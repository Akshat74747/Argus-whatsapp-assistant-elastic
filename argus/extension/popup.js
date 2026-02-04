// Argus Popup Script

const statusDot = document.querySelector('.status-dot');
const statusText = document.querySelector('.status-text');
const statMessages = document.getElementById('stat-messages');
const statEvents = document.getElementById('stat-events');
const statTriggers = document.getElementById('stat-triggers');
const eventsList = document.getElementById('events-list');

// Load stats
async function loadStats() {
  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_STATS' }, resolve);
    });

    if (response.error) throw new Error(response.error);

    statMessages.textContent = response.messages || 0;
    statEvents.textContent = response.events || 0;
    statTriggers.textContent = response.triggers || 0;

    statusDot.classList.add('connected');
    statusText.textContent = 'Connected';
  } catch (error) {
    statusDot.classList.add('error');
    statusText.textContent = 'Offline';
  }
}

// Load events
async function loadEvents() {
  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_EVENTS' }, resolve);
    });

    if (response.error) throw new Error(response.error);

    if (!response.length) {
      eventsList.innerHTML = '<p class="empty">No pending events</p>';
      return;
    }

    eventsList.innerHTML = response
      .slice(0, 5)
      .map(
        (event) => `
        <div class="event-item" data-id="${event.id}">
          <div class="event-title">${escapeHtml(event.title)}</div>
          <div class="event-meta">
            <span class="event-type">${event.event_type}</span>
            ${event.location ? `📍 ${escapeHtml(event.location)}` : ''}
          </div>
        </div>
      `
      )
      .join('');

    // Add click handlers
    eventsList.querySelectorAll('.event-item').forEach((item) => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        chrome.runtime.sendMessage({ type: 'COMPLETE_EVENT', eventId: parseInt(id) }, () => {
          item.style.opacity = '0.5';
          setTimeout(loadEvents, 500);
        });
      });
    });
  } catch (error) {
    eventsList.innerHTML = '<p class="empty">Failed to load events</p>';
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Initialize
loadStats();
loadEvents();
