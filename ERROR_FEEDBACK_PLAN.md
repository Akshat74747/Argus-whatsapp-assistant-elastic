# Extension Error Feedback — Implementation Plan

The Chrome extension has a full toast system (`showToast()`) that shows success messages for user actions (📅 Scheduled, 💤 Snoozed, etc.). But when API calls fail, almost all actions **silently fail** — the modal closes, the button re-enables, and the user has no idea their action didn't work.

This plan adds **error toasts for failed actions, error checking on message responses, and popup button error states**.

---

## Current Gap Analysis

| Action in `content.js` | Success toast? | Error handling? |
|:---|:---|:---|
| Set Reminder | ✅ "📅 Scheduled!" | ❌ Fire-and-forget (no response check) |
| Snooze | ✅ "💤 Snoozed!" | ❌ Fire-and-forget |
| Ignore | ✅ "🚫 Ignored" | ❌ Fire-and-forget |
| Complete | ✅ "✅ Completed!" | ❌ Fire-and-forget |
| Delete | ✅ "🗑️ Deleted" | ❌ Fire-and-forget |
| Dismiss | ❌ None | ❌ Fire-and-forget |
| Confirm Update | ✅ "📝 Updated!" | ✅ Shows "❌ Update failed" (only error toast that exists) |
| View Day | ✅ Shows schedule | ❌ No error feedback |

| Action in `popup.js` | Success feedback? | Error handling? |
|:---|:---|:---|
| Schedule/Snooze/Ignore/Complete | Button shows "..." briefly | ❌ Button re-enables silently on error |

| Scenario | Current behavior |
|:---|:---|
| Server down | Modal closes, nothing happens, user thinks action worked |
| Elastic write fails | Modal closes, success toast shows, but event wasn't saved |
| Background script error | `{ error: msg }` returned but never read by content.js |

---

## Proposed Changes

### Content Script Error Feedback

#### [MODIFY] [content.js](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/extension/content.js)

**1. Add `showErrorToast()` function** — separate error toast styling (red accent instead of green):
```javascript
function showErrorToast(title, description) {
  injectStyles();
  const container = createToastContainer();
  const toast = document.createElement('div');
  toast.className = 'argus-toast argus-toast-error';
  toast.innerHTML =
    '<div class="argus-toast-icon">✕</div>' +
    '<div class="argus-toast-content">' +
    '<div class="argus-toast-title">' + escapeHtml(title) + '</div>' +
    '<div class="argus-toast-desc">' + escapeHtml(description) + '</div>' +
    '</div>' +
    '<button class="argus-toast-close">✕</button>';
  toast.querySelector('.argus-toast-close').addEventListener('click', function () {
    removeToast(toast);
  });
  container.appendChild(toast);
  setTimeout(function () { removeToast(toast); }, 5000); // 5s for errors (vs 4s success)
}
```

**2. Add error toast CSS** to the styles constant:
```css
.argus-toast-error {
  border-left: 3px solid #f87171;
}
.argus-toast-error .argus-toast-icon {
  color: #f87171;
}
```

**3. Convert fire-and-forget actions to response-checked** — each action now reads the background response:

```diff
  case 'set-reminder':
  case 'schedule':
-   chrome.runtime.sendMessage({ type: 'SET_REMINDER', eventId: eventId });
-   showToast('📅 Scheduled!', 'You will be reminded before the event.');
+   chrome.runtime.sendMessage({ type: 'SET_REMINDER', eventId: eventId }, function(response) {
+     if (response && response.error) {
+       showErrorToast('❌ Couldn\'t Schedule', response.error);
+     } else {
+       showToast('📅 Scheduled!', 'You will be reminded before the event.');
+     }
+   });
    break;
```

Apply same pattern to: `snooze`, `ignore`, `complete`, `delete`, `acknowledge`, `dismiss`, `dismiss-permanent`.

**4. Handle background script disconnection:**
```javascript
// Wrapper for all chrome.runtime.sendMessage calls
function safeSendMessage(msg, successToast, errorTitle) {
  chrome.runtime.sendMessage(msg, function(response) {
    if (chrome.runtime.lastError) {
      showErrorToast('❌ Extension Error', 'Argus background service is not running.');
      return;
    }
    if (response && response.error) {
      showErrorToast(errorTitle || '❌ Action Failed', response.error);
    } else if (successToast) {
      showToast(successToast.title, successToast.desc);
    }
  });
}
```

This consolidates all the sendMessage calls and handles:
- `chrome.runtime.lastError` — service worker crashed
- `response.error` — API returned error from background.js
- `response.timeout` — server not responding (from API Error Handling Plan)

---

### Popup Button Error States

#### [MODIFY] [popup.js](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/extension/popup.js)

**Currently:** Buttons show "..." while loading, then reload the entire list on completion (even on error).

**Change:** Show error state on the button itself:
```diff
  try {
-   await handleEventAction(action, id);
+   const result = await handleEventAction(action, id);
+   if (result && result.error) {
+     this.textContent = '❌';
+     this.style.background = '#f87171';
+     setTimeout(() => { this.textContent = originalText; this.style.background = ''; this.disabled = false; }, 2000);
+     return;
+   }
  } catch (err) {
-   console.error('[Argus Popup] Action error:', err);
+   this.textContent = '❌ Failed';
+   this.style.background = '#f87171';
+   setTimeout(() => { this.textContent = originalText; this.style.background = ''; this.disabled = false; }, 2000);
+   return;
  }
```

#### [MODIFY] [popup.html](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/extension/popup.html)

**Add connection error banner** — shown when stats fetch fails:
```html
<div class="error-banner hidden" id="error-banner">
  ⚠️ Cannot reach Argus server
</div>
```
```css
.error-banner {
  padding: 6px 16px;
  background: rgba(248, 113, 113, 0.15);
  color: #f87171;
  font-size: 11px;
  text-align: center;
  border-bottom: 1px solid rgba(248, 113, 113, 0.2);
}
```

Show/hide based on server connectivity:
```diff
  // In loadStats() catch block:
+ document.getElementById('error-banner').classList.remove('hidden');
  // In loadStats() success:
+ document.getElementById('error-banner').classList.add('hidden');
```

---

### Background Script Error Classification

#### [MODIFY] [background.js](file:///d:/Elastic/whatsapp-chat-rmd-argus/argus/extension/background.js)

**Classify errors** so content.js can show appropriate messages:
```diff
  } catch (error) {
-   return { error: error.message };
+   const isTimeout = error.name === 'AbortError';
+   const isOffline = error.message.includes('Failed to fetch');
+   return {
+     error: isTimeout ? 'Server not responding' :
+            isOffline ? 'Cannot reach Argus server' :
+            error.message,
+     timeout: isTimeout,
+     offline: isOffline,
+   };
  }
```

---

## Files Changed Summary

| File | Action | Purpose |
|:---|:---|:---|
| `content.js` | MODIFY | `showErrorToast()`, `safeSendMessage()`, response checking on all actions |
| `popup.js` | MODIFY | Button error states (❌ + red flash), connection error banner |
| `popup.html` | MODIFY | Error banner HTML + CSS |
| `background.js` | MODIFY | Classify errors (timeout/offline/generic) |

---

## Verification Plan

### Automated
```bash
# No TypeScript for extension files — manual testing only
```

### Manual

1. **Server down** — Stop Argus server → click "Schedule" in popup → verify:
   - Popup shows ❌ on button + red flash
   - Error banner "⚠️ Cannot reach Argus server" appears
   - Content.js shows error toast: "❌ Couldn't Schedule — Cannot reach Argus server"

2. **API error** — Trigger a 500 from server → verify error toast with specific message

3. **Service worker crash** — Reload extension while modal is open → click action → verify "Extension Error" toast via `chrome.runtime.lastError`

4. **Success paths unchanged** — Ensure all existing success toasts still work when server is healthy

5. **Timeout scenario** — Simulate slow server (>10s) → verify "Server not responding" error toast
