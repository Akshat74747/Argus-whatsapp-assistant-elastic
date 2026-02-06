#!/bin/bash
# Argus Scenario Test Script
# Tests scenarios 1, 4, 5 with all action combos

API="http://localhost:3000"
RESULTS=""
PASS=0
FAIL=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[TEST]${NC} $1"; }
pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}[FAIL]${NC} $1"; FAIL=$((FAIL+1)); }
section() { echo -e "\n${YELLOW}═══════════════════════════════════════${NC}"; echo -e "${YELLOW}  $1${NC}"; echo -e "${YELLOW}═══════════════════════════════════════${NC}"; }

# Helper: send webhook message
send_msg() {
  local id="$1"
  local from_me="$2"
  local sender="$3"
  local msg="$4"
  local ts="$5"
  
  curl -s -X POST "$API/api/webhook/whatsapp" \
    -H "Content-Type: application/json" \
    -d "{
      \"event\": \"messages.upsert\",
      \"instance\": \"test\",
      \"data\": {
        \"key\": {
          \"remoteJid\": \"919876543210@s.whatsapp.net\",
          \"id\": \"$id\",
          \"fromMe\": $from_me
        },
        \"pushName\": \"$sender\",
        \"message\": {
          \"conversation\": \"$msg\"
        },
        \"messageTimestamp\": \"$ts\"
      }
    }" -o /tmp/argus_test_result.json 2>/dev/null
  
  cat /tmp/argus_test_result.json
}

# Helper: check JSON field
check_field() {
  local json_file="$1"
  local field="$2"
  local expected="$3"
  local label="$4"
  
  local actual=$(python3 -c "import json; d=json.load(open('$json_file')); print($field)" 2>/dev/null)
  
  if [[ "$actual" == "$expected" ]]; then
    pass "$label: got '$actual'"
  else
    fail "$label: expected '$expected', got '$actual'"
  fi
}

# ============ HEALTH CHECK ============
section "Health Check"
curl -s "$API/api/health" -o /tmp/argus_health.json 2>/dev/null
STATUS=$(python3 -c "import json; print(json.load(open('/tmp/argus_health.json'))['status'])" 2>/dev/null)
if [[ "$STATUS" == "ok" ]]; then
  pass "Server is running"
else
  fail "Server is not running!"
  echo "Cannot continue without server. Exiting."
  exit 1
fi

# ============ SCENARIO 1: GOA CASHEW ============
section "Scenario 1: Goa Cashew (Recommendation)"

log "1a. Rahul recommends cashews in Goa (no date mentioned)"
RESULT=$(send_msg "S1_GOA_1" "false" "Rahul" "Bro you should definitely try the cashews at Zantyes shop when you go to Goa, they are amazing" "1770500001")
echo "$RESULT" | python3 -m json.tool > /tmp/s1_create.json 2>/dev/null

# Check event was created
EVENTS_CREATED=$(python3 -c "import json; d=json.load(open('/tmp/s1_create.json')); print(d.get('eventsCreated', 0))" 2>/dev/null)
if [[ "$EVENTS_CREATED" -ge 1 ]]; then
  pass "Event created from Goa cashew message"
else
  fail "No event created from Goa cashew message"
fi

# Check event_time is null (no date mentioned!)
EVENT_TIME=$(python3 -c "import json; d=json.load(open('/tmp/s1_create.json')); print(d['events'][0].get('event_time'))" 2>/dev/null)
if [[ "$EVENT_TIME" == "None" ]]; then
  pass "event_time is null (no fabricated date!)"
else
  fail "event_time should be null but got: $EVENT_TIME"
fi

# Check context_url = goa
CONTEXT_URL=$(python3 -c "import json; d=json.load(open('/tmp/s1_create.json')); print(d['events'][0].get('context_url', ''))" 2>/dev/null)
if [[ "$CONTEXT_URL" == "goa" ]]; then
  pass "context_url = 'goa'"
else
  fail "context_url should be 'goa' but got: '$CONTEXT_URL'"
fi

# Check sender_name = Rahul
SENDER=$(python3 -c "import json; d=json.load(open('/tmp/s1_create.json')); print(d['events'][0].get('sender_name', ''))" 2>/dev/null)
if [[ "$SENDER" == "Rahul" ]]; then
  pass "sender_name = 'Rahul'"
else
  fail "sender_name should be 'Rahul' but got: '$SENDER'"
fi

# Get the event ID for action tests
S1_EVENT_ID=$(python3 -c "import json; d=json.load(open('/tmp/s1_create.json')); print(d['events'][0]['id'])" 2>/dev/null)
log "Created event ID: $S1_EVENT_ID"

# 1b. Test context check (visiting goa travel site)
sleep 1
log "1b. Context check: visiting a Goa travel site"
curl -s -X POST "$API/api/context-check" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.makemytrip.com/goa-hotels", "title": "Goa Hotels - MakeMyTrip"}' \
  -o /tmp/s1_context.json 2>/dev/null

CONTEXT_COUNT=$(python3 -c "import json; d=json.load(open('/tmp/s1_context.json')); print(d.get('contextTriggersCount', 0))" 2>/dev/null)
if [[ "$CONTEXT_COUNT" -ge 1 ]]; then
  pass "Context trigger fired for Goa travel URL ($CONTEXT_COUNT triggers)"
else
  fail "Context trigger should fire for Goa URL but got $CONTEXT_COUNT"
fi

# 1c. Action: "dont remind me about the cashew thing"
sleep 1
log "1c. User says: 'dont remind me about cashews'"
RESULT=$(send_msg "S1_GOA_2" "true" "Me" "dont remind me about the cashew thing" "1770500100")
echo "$RESULT" | python3 -m json.tool > /tmp/s1_action1.json 2>/dev/null

ACTION=$(python3 -c "import json; d=json.load(open('/tmp/s1_action1.json')); ap=d.get('actionPerformed'); print(ap['action'] if ap else 'none')" 2>/dev/null)
if [[ "$ACTION" == "ignore" ]]; then
  pass "Action detected: ignore (dont remind me)"
elif [[ "$ACTION" == "delete" || "$ACTION" == "cancel" ]]; then
  pass "Action detected: $ACTION (acceptable alternative)"
else
  fail "Expected ignore/delete/cancel action but got: $ACTION"
fi

# ============ SCENARIO 4: NETFLIX SUBSCRIPTION ============
section "Scenario 4: Netflix Subscription Cancel"

log "4a. User mentions cancelling Netflix"
RESULT=$(send_msg "S4_NFLX_1" "true" "Me" "I need to cancel my Netflix subscription after I finish watching this show" "1770600001")
echo "$RESULT" | python3 -m json.tool > /tmp/s4_create.json 2>/dev/null

EVENTS_CREATED=$(python3 -c "import json; d=json.load(open('/tmp/s4_create.json')); print(d.get('eventsCreated', 0))" 2>/dev/null)
if [[ "$EVENTS_CREATED" -ge 1 ]]; then
  pass "Event created for Netflix cancellation"
else
  fail "No event created for Netflix cancellation"
fi

# Check context_url = netflix
CONTEXT_URL=$(python3 -c "import json; d=json.load(open('/tmp/s4_create.json')); print(d['events'][0].get('context_url', ''))" 2>/dev/null)
if [[ "$CONTEXT_URL" == "netflix" ]]; then
  pass "context_url = 'netflix'"
else
  fail "context_url should be 'netflix' but got: '$CONTEXT_URL'"
fi

# Check event_type = subscription
EVENT_TYPE=$(python3 -c "import json; d=json.load(open('/tmp/s4_create.json')); print(d['events'][0].get('event_type', ''))" 2>/dev/null)
if [[ "$EVENT_TYPE" == "subscription" ]]; then
  pass "event_type = 'subscription'"
else
  fail "event_type should be 'subscription' but got: '$EVENT_TYPE'"
fi

S4_EVENT_ID=$(python3 -c "import json; d=json.load(open('/tmp/s4_create.json')); print(d['events'][0]['id'])" 2>/dev/null)
log "Created event ID: $S4_EVENT_ID"

# 4b. Context check: visiting netflix.com
sleep 1
log "4b. Context check: visiting netflix.com"
curl -s -X POST "$API/api/context-check" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.netflix.com/browse", "title": "Netflix"}' \
  -o /tmp/s4_context.json 2>/dev/null

CONTEXT_COUNT=$(python3 -c "import json; d=json.load(open('/tmp/s4_context.json')); print(d.get('contextTriggersCount', 0))" 2>/dev/null)
if [[ "$CONTEXT_COUNT" -ge 1 ]]; then
  pass "Context trigger fired on netflix.com ($CONTEXT_COUNT triggers)"
else
  fail "Context trigger should fire on netflix.com but got $CONTEXT_COUNT"
fi

# 4c. Action: "already cancelled it"
sleep 1
log "4c. User says: 'already cancelled netflix'"
RESULT=$(send_msg "S4_NFLX_2" "true" "Me" "already cancelled netflix" "1770600100")
echo "$RESULT" | python3 -m json.tool > /tmp/s4_action1.json 2>/dev/null

ACTION=$(python3 -c "import json; d=json.load(open('/tmp/s4_action1.json')); ap=d.get('actionPerformed'); print(ap['action'] if ap else 'none')" 2>/dev/null)
if [[ "$ACTION" == "complete" ]]; then
  pass "Action detected: complete (already cancelled)"
else
  fail "Expected complete action but got: $ACTION"
fi

# ============ SCENARIO 5: CALENDAR CONFLICT ============
section "Scenario 5: Calendar Conflict"

# Get next Thursday timestamp
NEXT_THU=$(python3 -c "
from datetime import datetime, timedelta
now = datetime(2026, 2, 6)
days_ahead = 3 - now.weekday()  # Thursday = 3
if days_ahead <= 0: days_ahead += 7
thu = now + timedelta(days=days_ahead)
# Set to 7:30 PM
thu = thu.replace(hour=19, minute=30)
print(int(thu.timestamp()))
")
log "Next Thursday 7:30 PM timestamp: $NEXT_THU"

# Same time for meeting conflict
MEETING_TIME=$NEXT_THU

log "5a. Group chat: dinner plan for Thursday"
RESULT=$(send_msg "S5_CONF_1" "false" "Priya" "Hey everyone lets do dinner this Thursday at 7:30pm, theres a new Italian place!" "$NEXT_THU")
echo "$RESULT" | python3 -m json.tool > /tmp/s5_dinner.json 2>/dev/null

EVENTS_CREATED=$(python3 -c "import json; d=json.load(open('/tmp/s5_dinner.json')); print(d.get('eventsCreated', 0))" 2>/dev/null)
if [[ "$EVENTS_CREATED" -ge 1 ]]; then
  pass "Dinner event created from group chat"
else
  fail "No dinner event created"
fi

S5_DINNER_ID=$(python3 -c "import json; d=json.load(open('/tmp/s5_dinner.json')); print(d['events'][0]['id'])" 2>/dev/null)
log "Dinner event ID: $S5_DINNER_ID"

# Schedule the dinner event so it shows in conflict checks
sleep 1
curl -s -X POST "$API/api/events/$S5_DINNER_ID/set-reminder" -o /dev/null 2>/dev/null
log "Scheduled dinner event for reminders"

# 5b. New meeting at same time
sleep 1
log "5b. New meeting at same Thursday time"
RESULT=$(send_msg "S5_CONF_2" "false" "Boss" "Team standup meeting on Thursday at 7:30pm on Zoom" "$MEETING_TIME")
echo "$RESULT" | python3 -m json.tool > /tmp/s5_meeting.json 2>/dev/null

EVENTS_CREATED=$(python3 -c "import json; d=json.load(open('/tmp/s5_meeting.json')); print(d.get('eventsCreated', 0))" 2>/dev/null)
if [[ "$EVENTS_CREATED" -ge 1 ]]; then
  pass "Meeting event created"
else
  fail "No meeting event created"
fi

# Check for conflicts
HAS_CONFLICTS=$(python3 -c "
import json
d=json.load(open('/tmp/s5_meeting.json'))
events = d.get('events', [])
if events and events[0].get('conflicts'):
    print('yes')
else:
    print('no')
" 2>/dev/null)

if [[ "$HAS_CONFLICTS" == "yes" ]]; then
  pass "Conflict detected between dinner and meeting!"
  CONFLICT_TITLE=$(python3 -c "import json; d=json.load(open('/tmp/s5_meeting.json')); print(d['events'][0]['conflicts'][0]['title'])" 2>/dev/null)
  log "Conflicts with: $CONFLICT_TITLE"
else
  fail "No conflict detected (events at same time)"
fi

# ============ AI CHAT TEST ============
section "AI Chat Sidebar"

log "Testing /api/chat endpoint"
curl -s -X POST "$API/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"query": "What events do I have?", "history": []}' \
  -o /tmp/chat_test.json 2>/dev/null

CHAT_RESP=$(python3 -c "import json; d=json.load(open('/tmp/chat_test.json')); print(d.get('response', 'ERROR')[:100])" 2>/dev/null)
if [[ "$CHAT_RESP" != "ERROR" && -n "$CHAT_RESP" ]]; then
  pass "AI Chat responded: '$CHAT_RESP...'"
else
  fail "AI Chat failed to respond"
fi

# ============ ACTION COMBO TESTS ============
section "Action Combos (NLP)"

# Create a test event for action testing
log "Creating test event for action combos"
RESULT=$(send_msg "ACT_1" "false" "Amit" "Remind me to buy groceries tomorrow morning" "1770700001")
echo "$RESULT" | python3 -m json.tool > /tmp/act_create.json 2>/dev/null
ACT_EVENT_ID=$(python3 -c "import json; d=json.load(open('/tmp/act_create.json')); print(d['events'][0]['id'])" 2>/dev/null)
log "Test event ID: $ACT_EVENT_ID"

# Action: "ho gaya" (Hindi for "done")
sleep 1
log "Action: 'ho gaya' (Hindi done)"
RESULT=$(send_msg "ACT_2" "true" "Me" "groceries ho gaya" "1770700100")
echo "$RESULT" | python3 -m json.tool > /tmp/act_done.json 2>/dev/null
ACTION=$(python3 -c "import json; d=json.load(open('/tmp/act_done.json')); ap=d.get('actionPerformed'); print(ap['action'] if ap else 'none')" 2>/dev/null)
if [[ "$ACTION" == "complete" ]]; then
  pass "Hindi 'ho gaya' → complete"
else
  fail "Hindi 'ho gaya' should → complete, got: $ACTION"
fi

# Create another test event
sleep 1
RESULT=$(send_msg "ACT_3" "false" "Amit" "We have client meeting at 3pm today" "1770700200")
echo "$RESULT" | python3 -m json.tool > /tmp/act_create2.json 2>/dev/null

# Action: "remind me tomorrow"
sleep 1
log "Action: 'remind me about the meeting tomorrow'"
RESULT=$(send_msg "ACT_4" "true" "Me" "remind me about the meeting tomorrow" "1770700300")
echo "$RESULT" | python3 -m json.tool > /tmp/act_postpone.json 2>/dev/null
ACTION=$(python3 -c "import json; d=json.load(open('/tmp/act_postpone.json')); ap=d.get('actionPerformed'); print(ap['action'] if ap else 'none')" 2>/dev/null)
if [[ "$ACTION" == "postpone" || "$ACTION" == "snooze" ]]; then
  pass "Postpone/snooze detected: $ACTION"
else
  fail "Expected postpone/snooze, got: $ACTION"
fi

# ============ SUMMARY ============
section "Test Summary"
TOTAL=$((PASS + FAIL))
echo -e "${GREEN}PASSED: $PASS${NC} / ${TOTAL}"
echo -e "${RED}FAILED: $FAIL${NC} / ${TOTAL}"

if [[ $FAIL -eq 0 ]]; then
  echo -e "\n${GREEN}🎉 ALL TESTS PASSED!${NC}"
else
  echo -e "\n${RED}⚠️  Some tests failed. Check logs above.${NC}"
fi
