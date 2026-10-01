# =============================================================================
# Listen AI Backend - Dockerfile for Cloud Run
# =============================================================================

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install ffmpeg for audio conversion (WAV to MP3)
# Install Python + modal CLI for per-user deployment orchestration (lib/modalDeployments.ts). PINNED: teardown relies on
# `modal secret delete --yes --allow-missing` and `modal volume delete --yes --allow-missing` and on the JSON shape of
# `modal app list --json`, all verified against 1.3.4. Bump it deliberately and re-run scripts/modal-deploy-smoke.ts.
# Unpinned deliberately: Modal's server rejects old client versions outright
# ("client version too old") once they age out, so a hardcoded pin (was
# 0.63.0) silently breaks every per-user self-serve deploy once that
# happens - confirmed live during a real voice-isolate deploy test.
RUN apk add --no-cache ffmpeg python3 py3-pip && \
    pip3 install "modal==1.3.4" --break-system-packages

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm install --only=production && npm cache clean --force

# Copy built files
COPY --from=builder /app/dist ./dist

# Copy Modal deployment files (voice-convert deployable)
COPY modal ./modal

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start server
CMD ["node", "dist/index.js"]
