# Stage 1: Build the UI assets
FROM node:20-alpine AS ui-build
WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# Stage 2: Build the Go backend
FROM golang:1.25-alpine AS build
WORKDIR /app

# Prevent automatic toolchain switching
ENV GOTOOLCHAIN=local

# Cache dependency downloads
COPY go.mod go.sum ./
RUN go mod download

# Build the binary
COPY . .
# Copy the built UI assets from Stage 1 into the Go build context
# so they can be embedded via //go:embed in ui/embed.go
COPY --from=ui-build /app/ui/dist ./ui/dist
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o server ./cmd/server

# Stage 3: Runtime — the Go server plus a headless Chromium, so the daily
# scrape (scripts/gse_download.py driving gse.com.gh through the chrome-agent
# CDP CLI) runs inside the container instead of only on a workstation. That
# browser stack is most of the image size; without it the collector logs
# "Automated GSE scrape disabled" and CSV upload is the only ingest path.
FROM alpine:3.19

# Pinned so a rebuild can't silently pick up a chrome-agent whose CLI or
# Chrome-discovery behaviour differs from what gse_download.py expects.
ARG CHROME_AGENT_VERSION=0.5.7

# Alpine 3.19 ships Python 3.11, which is chrome-agent's floor. chromium
# pulls its own font/nss/freetype deps; ttf-freefont is added so text-mode
# rendering has a real font rather than falling back to boxes.
RUN apk add --no-cache \
        ca-certificates tzdata wget \
        python3 py3-pip \
        chromium ttf-freefont \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir "chrome-agent==${CHROME_AGENT_VERSION}" \
    && adduser -D -u 10001 -h /home/app app

# chrome-agent finds Chrome by walking a fixed list of absolute paths and
# takes /usr/bin/google-chrome first, and gse_download.py has no way to pass
# Chrome flags through. A wrapper on that path is how the two flags a
# container needs get in: --no-sandbox, because Chrome's namespace sandbox
# wants privileges this image doesn't run with, and --disable-dev-shm-usage,
# because Docker's default 64MB /dev/shm crashes the renderer mid-page.
RUN printf '#!/bin/sh\nexec /usr/bin/chromium-browser --no-sandbox --disable-dev-shm-usage --disable-gpu "$@"\n' \
        > /usr/bin/google-chrome \
    && chmod 0755 /usr/bin/google-chrome

COPY --from=build /app/server /server
# The scraper is interpreted at runtime, so it ships as source rather than
# being embedded in the binary.
COPY scripts/gse_download.py /app/scripts/gse_download.py

EXPOSE 8080
ENV PORT=8080 \
    HOME=/home/app \
    PATH="/opt/venv/bin:$PATH" \
    GSE_DOWNLOAD_SCRIPT=/app/scripts/gse_download.py

USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/healthz || exit 1

CMD ["/server"]
