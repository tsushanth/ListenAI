#!/bin/bash
# Safe deployment script for TTS GPU service
# This script deploys with canary testing before routing traffic
#
# Usage: ./deploy-safe.sh [--skip-build] [--rollback]
#
# Options:
#   --skip-build   Use the latest existing image (skip building)
#   --rollback     Roll back to the previous revision

set -e

PROJECT_ID="${GCP_PROJECT_ID:-summarizerproxy}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="readaloud-tts-gpu"
IMAGE_REPO="us-central1-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/$SERVICE_NAME"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
echo_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
echo_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Parse arguments
SKIP_BUILD=false
ROLLBACK=false
for arg in "$@"; do
  case $arg in
    --skip-build) SKIP_BUILD=true ;;
    --rollback) ROLLBACK=true ;;
  esac
done

# Handle rollback
if [ "$ROLLBACK" = true ]; then
  echo_warn "Rolling back to previous revision..."

  # Get current and previous revisions
  REVISIONS=$(gcloud run revisions list --service=$SERVICE_NAME --region=$REGION --format='value(REVISION)' --limit=2)
  CURRENT=$(echo "$REVISIONS" | head -n1)
  PREVIOUS=$(echo "$REVISIONS" | tail -n1)

  if [ -z "$PREVIOUS" ] || [ "$CURRENT" = "$PREVIOUS" ]; then
    echo_error "No previous revision to rollback to"
    exit 1
  fi

  echo_info "Rolling back from $CURRENT to $PREVIOUS"
  gcloud run services update-traffic $SERVICE_NAME --region=$REGION --to-revisions=$PREVIOUS=100
  echo_info "Rollback complete!"
  exit 0
fi

# Step 1: Build and push image
if [ "$SKIP_BUILD" = false ]; then
  echo_info "Building Docker image with Dockerfile.gpu..."
  BUILD_TAG="$(date +%Y%m%d-%H%M%S)"

  docker build -f Dockerfile.gpu \
    -t "$IMAGE_REPO:$BUILD_TAG" \
    -t "$IMAGE_REPO:latest" \
    .

  echo_info "Pushing image to Artifact Registry..."
  docker push "$IMAGE_REPO:$BUILD_TAG"
  docker push "$IMAGE_REPO:latest"

  IMAGE_TAG="$BUILD_TAG"
else
  echo_info "Skipping build, using latest image..."
  IMAGE_TAG="latest"
fi

# Step 2: Deploy with no traffic (canary)
echo_info "Deploying new revision with NO traffic (canary)..."
gcloud run deploy $SERVICE_NAME \
  --image="$IMAGE_REPO:$IMAGE_TAG" \
  --region=$REGION \
  --platform=managed \
  --allow-unauthenticated \
  --memory=16Gi \
  --cpu=4 \
  --gpu=1 \
  --gpu-type=nvidia-l4 \
  --timeout=300 \
  --min-instances=0 \
  --max-instances=2 \
  --concurrency=10 \
  --set-env-vars=CACHE_ENABLED=true,LOG_LEVEL=INFO,DEFAULT_TTS_MODEL=kokoro \
  --cpu-boost \
  --no-traffic \
  --tag=canary

# Get the canary URL
CANARY_URL=$(gcloud run services describe $SERVICE_NAME --region=$REGION --format='value(status.traffic[?tag=="canary"].url)')
echo_info "Canary URL: $CANARY_URL"

# Step 3: Run smoke tests
echo_info "Running smoke tests on canary..."
echo ""

# Wait for service to be ready
echo_info "Waiting for canary to be ready (up to 5 minutes)..."
READY=false
for i in {1..30}; do
  HEALTH=$(curl -s "$CANARY_URL/health" 2>/dev/null || echo '{}')
  STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")

  if [ "$STATUS" = "ok" ]; then
    READY=true
    echo_info "Service is ready!"
    break
  fi

  echo "  Attempt $i/30: status=$STATUS"
  sleep 10
done

if [ "$READY" = false ]; then
  echo_error "Service failed to become ready"
  exit 1
fi

# Test 1: Check capabilities
echo ""
echo_info "Test 1: Checking /capabilities endpoint..."
CAPS=$(curl -s "$CANARY_URL/capabilities")
echo "$CAPS" | python3 -m json.tool 2>/dev/null || echo "$CAPS"

VOICE_CLONING=$(echo "$CAPS" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('capabilities',{}).get('voice_cloning',{}).get('available') else 'no')" 2>/dev/null || echo "no")

if [ "$VOICE_CLONING" != "yes" ]; then
  echo_error "SMOKE TEST FAILED: Voice cloning not available!"
  CHATTERBOX_ERROR=$(echo "$CAPS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('capabilities',{}).get('voice_cloning',{}).get('chatterbox_error','unknown'))" 2>/dev/null || echo "unknown")
  echo_error "Chatterbox error: $CHATTERBOX_ERROR"
  echo ""
  echo_warn "Canary deployment kept but NOT receiving traffic."
  echo_warn "Fix the issue and redeploy, or run: $0 --rollback"
  exit 1
fi
echo_info "Voice cloning available: YES"

# Test 2: Check Chatterbox module
CHATTERBOX_MODELS=$(echo "$CAPS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('capabilities',{}).get('voice_cloning',{}).get('models',[]))" 2>/dev/null || echo "[]")
if [[ "$CHATTERBOX_MODELS" != *"chatterbox"* ]]; then
  echo_error "SMOKE TEST FAILED: Chatterbox not in available models: $CHATTERBOX_MODELS"
  exit 1
fi
echo_info "Chatterbox in models: YES"

# Test 3: Basic TTS synthesis
echo ""
echo_info "Test 2: Testing basic TTS synthesis..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$CANARY_URL/synthesize" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello, this is a deployment test.", "voice_id":"am_adam", "model":"kokoro"}')

if [ "$HTTP_CODE" != "200" ]; then
  echo_error "SMOKE TEST FAILED: TTS synthesis returned HTTP $HTTP_CODE"
  exit 1
fi
echo_info "TTS synthesis: OK (HTTP $HTTP_CODE)"

echo ""
echo_info "=========================================="
echo_info "All smoke tests passed!"
echo_info "=========================================="
echo ""

# Step 4: Ask for confirmation before routing traffic
echo_warn "Ready to route 100% traffic to new revision."
read -p "Proceed? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo_info "Aborted. Canary deployment is still available at: $CANARY_URL"
  echo_info "To complete deployment later: gcloud run services update-traffic $SERVICE_NAME --region=$REGION --to-latest"
  echo_info "To rollback: $0 --rollback"
  exit 0
fi

# Step 5: Route traffic
echo_info "Routing 100% traffic to new revision..."
gcloud run services update-traffic $SERVICE_NAME --region=$REGION --to-latest

echo ""
echo_info "=========================================="
echo_info "Deployment complete!"
echo_info "=========================================="
