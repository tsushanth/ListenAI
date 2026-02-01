#!/bin/bash
# TTS Service Health Monitor
# Run this script periodically via cron or Cloud Scheduler to monitor service health
# and send alerts when issues are detected.
#
# Usage: ./monitor-health.sh [--slack-webhook URL] [--email EMAIL]
#
# Environment variables:
#   SLACK_WEBHOOK_URL - Slack webhook for notifications
#   ALERT_EMAIL - Email for notifications (requires mailx/sendmail)

set -e

# Configuration
SERVICE_URL="${TTS_SERVICE_URL:-https://readaloud-tts-gpu-917362189743.us-central1.run.app}"
TIMEOUT=30
MAX_RETRIES=3

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') $1"; }

# Parse arguments
SLACK_WEBHOOK="${SLACK_WEBHOOK_URL:-}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
for arg in "$@"; do
  case $arg in
    --slack-webhook=*) SLACK_WEBHOOK="${arg#*=}" ;;
    --email=*) ALERT_EMAIL="${arg#*=}" ;;
  esac
done

# Send alert notification
send_alert() {
  local title="$1"
  local message="$2"
  local severity="${3:-error}"

  log_error "$title: $message"

  # Slack notification
  if [ -n "$SLACK_WEBHOOK" ]; then
    local color="#FF0000"
    [ "$severity" = "warning" ] && color="#FFA500"
    [ "$severity" = "info" ] && color="#00FF00"

    curl -s -X POST "$SLACK_WEBHOOK" \
      -H 'Content-type: application/json' \
      -d "{
        \"attachments\": [{
          \"color\": \"$color\",
          \"title\": \"$title\",
          \"text\": \"$message\",
          \"footer\": \"TTS Health Monitor\",
          \"ts\": $(date +%s)
        }]
      }" > /dev/null 2>&1 || log_warn "Failed to send Slack notification"
  fi

  # Email notification
  if [ -n "$ALERT_EMAIL" ] && command -v mail &> /dev/null; then
    echo "$message" | mail -s "$title" "$ALERT_EMAIL" 2>/dev/null || log_warn "Failed to send email notification"
  fi
}

# Check health endpoint
check_health() {
  local retry=0
  local health_response=""

  while [ $retry -lt $MAX_RETRIES ]; do
    health_response=$(curl -s --max-time $TIMEOUT "$SERVICE_URL/health" 2>/dev/null || echo "")

    if [ -n "$health_response" ]; then
      local status=$(echo "$health_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")

      if [ "$status" = "ok" ] || [ "$status" = "loading" ]; then
        log_info "Health check passed: status=$status"
        return 0
      fi
    fi

    retry=$((retry + 1))
    [ $retry -lt $MAX_RETRIES ] && sleep 5
  done

  send_alert "TTS Service Health Check Failed" \
    "Service at $SERVICE_URL is not responding properly after $MAX_RETRIES attempts.\nLast response: $health_response"
  return 1
}

# Check voice cloning capability
check_voice_cloning() {
  local caps=$(curl -s --max-time $TIMEOUT "$SERVICE_URL/capabilities" 2>/dev/null || echo "{}")

  local vc_available=$(echo "$caps" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    vc = d.get('capabilities', {}).get('voice_cloning', {})
    print('yes' if vc.get('available') else 'no')
except:
    print('error')
" 2>/dev/null || echo "error")

  if [ "$vc_available" != "yes" ]; then
    local error_msg=$(echo "$caps" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('capabilities', {}).get('voice_cloning', {}).get('chatterbox_error', 'Unknown error'))
except:
    print('Failed to parse response')
" 2>/dev/null)

    send_alert "TTS Voice Cloning Unavailable" \
      "Voice cloning is not available on the TTS service.\nError: $error_msg"
    return 1
  fi

  log_info "Voice cloning available: YES"
  return 0
}

# Check basic TTS synthesis
check_synthesis() {
  local http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time $TIMEOUT \
    -X POST "$SERVICE_URL/synthesize" \
    -H "Content-Type: application/json" \
    -d '{"text":"Health check test.", "voice_id":"am_adam", "model":"kokoro"}' 2>/dev/null || echo "000")

  if [ "$http_code" != "200" ]; then
    send_alert "TTS Synthesis Failed" \
      "Basic TTS synthesis check failed with HTTP $http_code.\nEndpoint: $SERVICE_URL/synthesize" \
      "warning"
    return 1
  fi

  log_info "TTS synthesis check: OK (HTTP $http_code)"
  return 0
}

# Main execution
main() {
  log_info "Starting TTS service health check..."
  log_info "Service URL: $SERVICE_URL"

  local exit_code=0

  # Run all checks
  check_health || exit_code=1

  # Only run additional checks if basic health passed
  if [ $exit_code -eq 0 ]; then
    check_voice_cloning || exit_code=1
    check_synthesis || exit_code=1
  fi

  if [ $exit_code -eq 0 ]; then
    log_info "All health checks passed!"
  else
    log_error "Some health checks failed!"
  fi

  return $exit_code
}

main "$@"
