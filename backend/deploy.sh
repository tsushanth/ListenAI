#!/bin/bash
# =============================================================================
# Listen AI Backend - Cloud Run Deployment Script
# =============================================================================
#
# Usage:
#   1. Copy .env.example to .env.production and fill in your values
#   2. Run: ./deploy.sh
#
# The script will automatically load .env.production if it exists.
# You can also set environment variables directly before running.
# =============================================================================

set -e

# Configuration
PROJECT_ID="${GCP_PROJECT_ID:-summarizerproxy}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="listenai-backend"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# Load .env.production if it exists
load_env_file() {
    local env_file="${1:-.env.production}"

    if [ -f "$env_file" ]; then
        echo "Loading environment from: $env_file"
        # Export variables from env file (skip comments and empty lines)
        set -a
        source "$env_file"
        set +a
    elif [ -f ".env" ]; then
        echo "Loading environment from: .env"
        set -a
        source ".env"
        set +a
    fi
}

# Load env file first
load_env_file

echo "=========================================="
echo "Listen AI Backend - Cloud Run Deployment"
echo "=========================================="
echo "Project:  ${PROJECT_ID}"
echo "Region:   ${REGION}"
echo "Service:  ${SERVICE_NAME}"
echo "=========================================="

# Check if required environment variables are set
check_env_vars() {
    local missing=()

    [ -z "$SUPABASE_URL" ] && missing+=("SUPABASE_URL")
    [ -z "$SUPABASE_SERVICE_ROLE_KEY" ] && missing+=("SUPABASE_SERVICE_ROLE_KEY")
    [ -z "$SUPABASE_JWT_SECRET" ] && missing+=("SUPABASE_JWT_SECRET")

    if [ ${#missing[@]} -ne 0 ]; then
        echo "ERROR: Missing required environment variables:"
        printf '  - %s\n' "${missing[@]}"
        echo ""
        echo "Option 1: Create .env.production file"
        echo "  cp .env.example .env.production"
        echo "  # Edit .env.production with your values"
        echo ""
        echo "Option 2: Export variables directly"
        echo "  export SUPABASE_URL=https://your-project.supabase.co"
        echo "  export SUPABASE_SERVICE_ROLE_KEY=your-key"
        echo "  export SUPABASE_JWT_SECRET=your-secret"
        exit 1
    fi
}

# Enable required APIs
enable_apis() {
    echo ""
    echo "[1/4] Enabling required GCP APIs..."
    gcloud services enable \
        cloudbuild.googleapis.com \
        run.googleapis.com \
        containerregistry.googleapis.com \
        --project="${PROJECT_ID}" \
        --quiet
    echo "      APIs enabled."
}

# Build and push Docker image
build_image() {
    echo ""
    echo "[2/4] Building Docker image..."
    gcloud builds submit \
        --tag "${IMAGE_NAME}" \
        --project="${PROJECT_ID}" \
        --quiet
    echo "      Image built and pushed to: ${IMAGE_NAME}"
}

# Deploy to Cloud Run
deploy_service() {
    echo ""
    echo "[3/4] Deploying to Cloud Run..."

    gcloud run deploy "${SERVICE_NAME}" \
        --image "${IMAGE_NAME}" \
        --platform managed \
        --region "${REGION}" \
        --project "${PROJECT_ID}" \
        --allow-unauthenticated \
        --port 8080 \
        --memory 512Mi \
        --cpu 1 \
        --min-instances 0 \
        --max-instances 10 \
        --set-env-vars "NODE_ENV=production" \
        --set-env-vars "SUPABASE_URL=${SUPABASE_URL}" \
        --set-env-vars "SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}" \
        --set-env-vars "SUPABASE_JWT_SECRET=${SUPABASE_JWT_SECRET}" \
        --set-env-vars "OPENAI_API_KEY=${OPENAI_API_KEY:-}" \
        --set-env-vars "SELFHOSTED_TTS_URL=${SELFHOSTED_TTS_URL:-https://listenai-tts-worker.fly.dev}" \
        --set-env-vars "SELFHOSTED_TTS_API_KEY=${SELFHOSTED_TTS_API_KEY:-}" \
        --set-env-vars "GPU_TTS_URL=${GPU_TTS_URL:-https://listenai-tts-worker.fly.dev}" \
        --set-env-vars "GPU_TTS_ENABLED=${GPU_TTS_ENABLED:-true}" \
        --set-env-vars "RATE_LIMIT_WINDOW_MS=${RATE_LIMIT_WINDOW_MS:-60000}" \
        --set-env-vars "RATE_LIMIT_MAX_REQUESTS=${RATE_LIMIT_MAX_REQUESTS:-60}" \
        --set-env-vars "TTS_WORKER_ENABLED=${TTS_WORKER_ENABLED:-true}" \
        --set-env-vars "JOB_API_ROLLOUT_PERCENT=${JOB_API_ROLLOUT_PERCENT:-100}" \
        --set-env-vars "JOB_API_KILL_SWITCH=${JOB_API_KILL_SWITCH:-false}" \
        --quiet

    echo "      Service deployed."
}

# Get service URL
get_service_url() {
    echo ""
    echo "[4/4] Getting service URL..."
    SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
        --platform managed \
        --region "${REGION}" \
        --project "${PROJECT_ID}" \
        --format 'value(status.url)')

    echo ""
    echo "=========================================="
    echo "Deployment Complete!"
    echo "=========================================="
    echo "Service URL: ${SERVICE_URL}"
    echo ""
    echo "Test the health endpoint:"
    echo "  curl ${SERVICE_URL}/health"
    echo ""
    echo "View logs:"
    echo "  gcloud run logs read ${SERVICE_NAME} --region=${REGION}"
    echo "=========================================="
}

# Main
check_env_vars
enable_apis
build_image
deploy_service
get_service_url
