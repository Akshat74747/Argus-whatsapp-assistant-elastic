import type { GeminiExtraction, GeminiValidation, Event } from './types.js';

interface GeminiConfig {
  apiKey: string;
  model: string;
  apiUrl: string;
}

let config: GeminiConfig | null = null;

export function initGemini(cfg: GeminiConfig): void {
  config = cfg;
  console.log('✅ Gemini initialized:', cfg.model);
}

function getConfig(): GeminiConfig {
  if (!config) {
    throw new Error('Gemini not initialized. Call initGemini() first.');
  }
  return config;
}

async function callGemini(prompt: string, jsonMode = true): Promise<string> {
  const cfg = getConfig();
  
  const response = await fetch(`${cfg.apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 2000,
      ...(jsonMode && { response_format: { type: 'json_object' } }),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as { choices: Array<{ message?: { content?: string } }> };
  return data.choices[0]?.message?.content || '';
}

// ============ ACTION DETECTION ============
// Detects if a WhatsApp message is an ACTION on an existing event (cancel, done, postpone, etc.)

export interface ActionResult {
  isAction: boolean;
  action: 'cancel' | 'complete' | 'postpone' | 'snooze' | 'ignore' | 'delete' | 'modify' | 'none';
  targetKeywords: string[];  // keywords to find the target event
  targetDescription: string; // what the user is referring to
  snoozeMinutes?: number;    // for postpone actions
  newTime?: string;          // for reschedule actions
  confidence: number;
}

export async function detectAction(
  message: string,
  context: string[] = [],
  existingEvents: Array<{ id: number; title: string; event_type: string; keywords: string }> = []
): Promise<ActionResult> {
  const eventsBlock = existingEvents.length > 0
    ? `\nUser's existing events/reminders:\n${existingEvents.map((e, i) => `[${i}] #${e.id}: "${e.title}" (type: ${e.event_type}, keywords: ${e.keywords})`).join('\n')}\n`
    : '';

  const contextBlock = context.length > 0
    ? `\nRecent chat messages:\n${context.map((m, i) => `${i + 1}. "${m}"`).join('\n')}\n`
    : '';

  const prompt = `Analyze this WhatsApp message. Is the user trying to PERFORM AN ACTION on a previously stored event/reminder/task? Or is this a NEW event?
${contextBlock}${eventsBlock}
Message: "${message}"

Return JSON:
{
  "isAction": true/false,
  "action": "cancel" | "complete" | "postpone" | "snooze" | "ignore" | "delete" | "modify" | "none",
  "targetKeywords": ["keywords", "to", "find", "target", "event"],
  "targetDescription": "what the user is referring to",
  "snoozeMinutes": null or number (for postpone: 30, 60, 1440 for tomorrow, 10080 for next week),
  "newTime": null or "ISO datetime" (for reschedule),
  "confidence": 0.0 to 1.0
}

RULES - Detect these as ACTIONS (isAction=true):
- "cancel it" / "cancel the meeting" / "cancel netflix reminder" → action=cancel
- "done" / "already done" / "ho gaya" / "kar liya" / "completed" → action=complete
- "not now" / "later" / "baad mein" / "remind me later" → action=snooze, snoozeMinutes=30
- "remind me tomorrow" / "kal yaad dilana" → action=postpone, snoozeMinutes=1440
- "remind me next week" → action=postpone, snoozeMinutes=10080
- "don't remind me" / "mat yaad dilao" / "stop reminding" / "never show" → action=ignore
- "delete it" / "remove it" / "hata do" → action=delete
- "don't bring it up" / "I don't care" / "not interested" / "nahi chahiye" → action=ignore
- "I already cancelled it" / "already unsubscribed" → action=complete
- "change to 5pm" / "move to Friday" / "reschedule" → action=modify
- "postpone" / "push it" / "aage karo" → action=postpone, snoozeMinutes=1440
- "skip it" / "chhod do" / "leave it" → action=ignore

CRITICAL: If it matches an existing event from the list, use that event's keywords in targetKeywords.
If it's a new event/task/recommendation (NOT an action), return: {"isAction": false, "action": "none", "targetKeywords": [], "targetDescription": "", "confidence": 0}`;

  const response = await callGemini(prompt);
  
  try {
    const parsed = JSON.parse(response);
    return {
      isAction: parsed.isAction || false,
      action: parsed.action || 'none',
      targetKeywords: parsed.targetKeywords || [],
      targetDescription: parsed.targetDescription || '',
      snoozeMinutes: parsed.snoozeMinutes || undefined,
      newTime: parsed.newTime || undefined,
      confidence: parsed.confidence || 0,
    };
  } catch {
    console.error('Failed to parse action detection response:', response);
    return { isAction: false, action: 'none', targetKeywords: [], targetDescription: '', confidence: 0 };
  }
}

// ============ SMART NOTIFICATION MESSAGE GENERATOR ============
// Generates human-readable, scenario-specific popup messages

export async function generateNotificationMessage(
  event: { title: string; description?: string | null; event_type: string; location?: string | null; sender_name?: string | null; keywords?: string },
  triggerContext: { url?: string; pageTitle?: string; conflictingEvents?: Array<{ title: string; event_time?: number | null }> },
  popupType: string
): Promise<{ title: string; subtitle: string; body: string; question: string }> {
  const prompt = `Generate a SHORT, HUMAN-READABLE notification message for a proactive memory assistant called Argus.

Event: "${event.title}"
Description: "${event.description || ''}"
Type: ${event.event_type}
Location: ${event.location || 'none'}
Original sender: ${event.sender_name || 'unknown'}
Keywords: ${event.keywords || ''}
Popup type: ${popupType}
Current URL: ${triggerContext.url || 'none'}
Page title: ${triggerContext.pageTitle || 'none'}
${triggerContext.conflictingEvents ? `Conflicting events: ${triggerContext.conflictingEvents.map(e => `"${e.title}"`).join(', ')}` : ''}

Return JSON:
{
  "title": "short header (max 6 words)",
  "subtitle": "one-line context (who mentioned, when)",
  "body": "the main message to show user - natural, conversational, specific. Include sender name if known. Max 2 sentences.",
  "question": "what should user do? (1 sentence question)"
}

EXAMPLES:
- Recommendation: {"title": "Remember This?", "subtitle": "From your chat with Rahul", "body": "Rahul recommended cashews at Zantye's shop in Goa. You're browsing travel sites right now!", "question": "Want to save the location for your trip?"}
- Subscription: {"title": "Subscription Alert!", "subtitle": "From your notes", "body": "You planned to cancel Netflix after finishing that show. You're on Netflix right now.", "question": "Should we help you navigate to the cancellation page?"}
- Conflict: {"title": "Schedule Conflict!", "subtitle": "From Dinner Group chat", "body": "You told the group you'd join Thursday dinner, but this new meeting overlaps.", "question": "Want to suggest Friday instead?"}

Be SPECIFIC, use the actual names/places/services. Never be generic.`;

  const response = await callGemini(prompt);

  try {
    return JSON.parse(response);
  } catch {
    return {
      title: event.title,
      subtitle: `From ${event.sender_name || 'your messages'}`,
      body: event.description || event.title,
      question: 'Would you like to take action?',
    };
  }
}

export async function extractEvents(
  message: string,
  context: string[] = [],
  currentDate: string = new Date().toISOString()
): Promise<GeminiExtraction> {
  const contextBlock = context.length > 0 
    ? `\nPrevious messages in this chat (for context):\n${context.map((m, i) => `${i + 1}. "${m}"`).join('\n')}\n`
    : '';

  const prompt = `Extract events/tasks/reminders from this WhatsApp message. Return JSON only.
Current date: ${currentDate}
${contextBlock}
Message to analyze:
"${message}"

Return JSON with this exact schema:
{
  "events": [
    {
      "type": "meeting" | "deadline" | "reminder" | "travel" | "task" | "subscription" | "recommendation" | "other",
      "title": "short title",
      "description": "full details or null",
      "event_time": "ISO datetime or null",
      "location": "place name (goa, mumbai) or service name (netflix, hotstar, amazon)",
      "participants": ["names mentioned"],
      "keywords": ["searchable", "keywords", "include place names and service names"],
      "confidence": 0.0 to 1.0
    }
  ]
}

Rules:
- Understand informal/broken English and Hinglish (Hindi+English mix)
- Handle typos: "cancle" = "cancel", "tomoro" = "tomorrow", "goa" = "goa"
- "kal" = tomorrow, "aaj" = today, "parso" = day after tomorrow
- "this week" = within 7 days, use end of week as event_time
- Extract times like "5pm", "shaam ko" (evening), "subah" (morning)

CRITICAL DATE/TIME RULE:
- ONLY set event_time if the message EXPLICITLY mentions a date, time, or relative time reference
- "meeting tomorrow at 5pm" → event_time = tomorrow 5pm ✅
- "cancel netflix this month" → event_time = end of this month ✅  
- "kal 10 baje" → event_time = tomorrow 10am ✅
- "You should try cashews from Zantye's in Goa" → event_time = null ❌ (NO date mentioned!)
- "I need to cancel Amazon Prime" → event_time = null ❌ (NO specific date!)
- "Rahul recommended this restaurant" → event_time = null ❌ (just a recommendation)
- Do NOT fabricate or guess dates. If no time reference exists, event_time MUST be null.

- For SUBSCRIPTIONS (Netflix, Hotstar, Amazon Prime, gym, domain, hosting):
  - type = "subscription"
  - location = JUST the service name (netflix, hotstar, amazon) - NOT full domain!
  - keywords = include the service name
  - title = action to take (Cancel Netflix, Renew Hotstar, etc)

- For TRAVEL/RECOMMENDATIONS (trips, places, things to buy/do):
  - type = "travel" or "recommendation"
  - location = place name (goa, mumbai, delhi)
  - keywords = include the place name and any products/shops mentioned
  - Example: "Rahul recommended cashews at Zantye's in Goa" → type=recommendation, location=goa, keywords=[goa, cashews, zantyes, rahul]

- For MEETINGS and INFORMAL COMMITMENTS:
  - IMPORTANT: Questions like "Can we meet at 5pm?" or "Dinner Thursday?" ARE events!
  - Informal commitments like "I'll be there Thursday" or "See you at dinner" ARE events
  - "Let's do Thursday dinner" = meeting, event_time = this Thursday evening
  - "Can we have a meeting on 15th at 10:30?" = meeting, extract the date/time
  - Group chat commitments ("I'll join", "count me in", "I'm coming") = meeting events

- Intent phrases like "want to", "need to", "have to", "should" indicate tasks
- If no event/task found, return: {"events": []}
- Keywords should include: location names, service names, product names, people names, group names
- Confidence < 0.5 if uncertain
- Even casual mentions of tasks/intentions should be captured with lower confidence`;

  const response = await callGemini(prompt);
  
  try {
    const parsed = JSON.parse(response);
    return {
      events: parsed.events || [],
    };
  } catch {
    console.error('Failed to parse Gemini response:', response);
    return { events: [] };
  }
}

export async function validateRelevance(
  url: string,
  title: string,
  candidates: Event[]
): Promise<GeminiValidation> {
  if (candidates.length === 0) {
    return { relevant: [], confidence: 0 };
  }

  const prompt = `User is browsing this webpage. Determine which saved events are relevant RIGHT NOW.

Current URL: ${url}
Page Title: ${title}

Candidate events from user's WhatsApp history:
${candidates.map((e, i) => `[${i}] ${e.title}: ${e.description || 'no description'} (location: ${e.location || 'none'}, keywords: ${e.keywords}, sender: ${(e as any).sender_name || 'unknown'})`).join('\n')}

Return JSON with:
{
  "relevant": [0, 2, 5],  // indices of relevant events
  "confidence": 0.85      // overall confidence 0-1
}

Rules:
- Only mark events that user would find USEFUL to be reminded about NOW
- Travel booking site + travel/recommendation event = relevant
- Shopping site + gift/purchase mention = relevant  
- Subscription site + subscription cancellation = relevant
- Be conservative - fewer false positives is better
- If nothing relevant, return: {"relevant": [], "confidence": 0}`;

  const response = await callGemini(prompt);
  
  try {
    const parsed = JSON.parse(response);
    return {
      relevant: parsed.relevant || [],
      confidence: parsed.confidence || 0,
    };
  } catch {
    console.error('Failed to parse validation response:', response);
    return { relevant: [], confidence: 0 };
  }
}

// ============ AI CHAT WITH EVENTS CONTEXT ============
// Conversational AI that can see and query the user's events

export interface ChatResponse {
  response: string;
  relevantEventIds: number[];
}

export async function chatWithContext(
  query: string,
  events: Array<{ id: number; title: string; description: string | null; event_type: string; event_time: number | null; location: string | null; status: string; keywords: string; sender_name?: string | null; context_url?: string | null }>,
  history: Array<{ role: string; content: string }> = []
): Promise<ChatResponse> {
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const eventsBlock = events.length > 0
    ? events.map((e, i) => {
        let timeStr = 'no date set';
        if (e.event_time) {
          const d = new Date(e.event_time * 1000);
          timeStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
          timeStr += ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        return `[${i}] ID#${e.id} | "${e.title}" | type: ${e.event_type} | time: ${timeStr} | location: ${e.location || 'none'} | status: ${e.status} | sender: ${e.sender_name || 'unknown'} | keywords: ${e.keywords}${e.description ? ' | desc: ' + e.description : ''}`;
      }).join('\n')
    : 'No events stored yet.';

  const historyBlock = history.length > 0
    ? history.slice(-6).map(h => `${h.role === 'user' ? 'User' : 'Argus'}: ${h.content}`).join('\n')
    : '';

  const prompt = `You are Argus AI, a helpful and conversational memory assistant. You have access to the user's saved events, tasks, reminders and recommendations from their WhatsApp conversations.

Today's date: ${todayStr}
Current time: ${now.toLocaleTimeString('en-US')}

=== USER'S EVENTS/TASKS ===
${eventsBlock}

${historyBlock ? `=== RECENT CONVERSATION ===\n${historyBlock}\n` : ''}
User's question: "${query}"

INSTRUCTIONS:
- Answer naturally and conversationally, like a smart personal assistant
- Reference specific events by name, date, sender when relevant
- If user asks "what do I have today/this week", filter events by date
- If user asks about recommendations or gifts, search through event descriptions and types
- If user asks about a specific person (e.g., "what did Rahul say?"), filter by sender_name
- If user asks about subscriptions, filter by event_type = "subscription"
- If no relevant events found, say so honestly and offer to help with something else
- Keep responses concise but informative (2-5 sentences usually)
- Use emoji sparingly for readability
- If the user wants to take an action (mark done, delete, snooze), tell them they can use the buttons on the event cards below, or say it in WhatsApp chat
- Return the IDs of events you reference in your response

Return JSON:
{
  "response": "your conversational response text",
  "relevantEventIds": [1, 5, 12]
}`;

  const response = await callGemini(prompt);

  try {
    const parsed = JSON.parse(response);
    return {
      response: parsed.response || 'I could not process that. Try asking differently.',
      relevantEventIds: parsed.relevantEventIds || [],
    };
  } catch {
    // If JSON parse fails, try to extract text response
    console.error('Failed to parse chat response:', response);
    return {
      response: response || 'Sorry, something went wrong.',
      relevantEventIds: [],
    };
  }
}

export async function classifyMessage(message: string): Promise<{ hasEvent: boolean; confidence: number }> {
  // Quick heuristic check first - include common typos and variations
  const eventKeywords = /\b(meet|meeting|call|tomorrow|kal|today|aaj|deadline|reminder|book|flight|hotel|birthday|party|event|task|todo|buy|get|bring|send|submit|complete|finish|cancel|cancle|unsubscribe|subscription|netflix|amazon|prime|pay|payment|order|deliver|pickup|pick up|doctor|dentist|appointment|gym|class|lesson|exam|test|interview|plan|plans|planning|want to|need to|have to|should|must|gonna|going to|will|dinner|lunch|coffee|drinks|visit|shop|recommend|try|cashew|trip|travel)\b/i;
  const timePatterns = /\b(\d{1,2}:\d{2}|\d{1,2}\s*(am|pm)|morning|evening|night|subah|shaam|raat|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|next|this|tonight|today|tomorrow|kal|parso|\d{1,2}(st|nd|rd|th))\b/i;
  const intentPatterns = /\b(want|need|have|should|must|gonna|going|will|planning|plan|remind|remember|don't forget|dont forget|let's|lets|can we|shall we|how about|what about)\s+(to|me|do|go|have|meet)?\b/i;
  
  // ACTION patterns - detect actions on existing events
  const actionPatterns = /\b(cancel|cancle|done|already done|ho gaya|kar liya|completed|not now|later|baad mein|remind me later|remind me tomorrow|don't remind|mat yaad|stop reminding|never show|delete|remove|hata do|don't bring|not interested|nahi chahiye|skip|chhod do|leave it|postpone|push it|aage karo|already cancelled|already unsubscribed|change to|move to|reschedule|I don't care)\b/i;
  
  const hasKeyword = eventKeywords.test(message);
  const hasTime = timePatterns.test(message);
  const hasIntent = intentPatterns.test(message);
  const hasAction = actionPatterns.test(message);
  
  // Action on existing event - always process
  if (hasAction) {
    return { hasEvent: true, confidence: 0.9 };
  }
  
  // If message has intent + keyword, it's likely an event
  if (hasIntent && hasKeyword) {
    return { hasEvent: true, confidence: 0.85 };
  }
  
  if (!hasKeyword && !hasTime && !hasIntent) {
    return { hasEvent: false, confidence: 0.9 };
  }
  
  if ((hasKeyword && hasTime) || (hasIntent && hasTime)) {
    return { hasEvent: true, confidence: 0.85 };
  }
  
  // Single signal - still worth checking with Gemini
  return { hasEvent: hasKeyword || hasTime || hasIntent, confidence: 0.6 };
}
