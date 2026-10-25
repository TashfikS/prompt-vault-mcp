# ==============================================================================
# Stage 1: Build the React + Tailwind Frontend
# ==============================================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ==============================================================================
# Stage 2: Production Python FastAPI + FastMCP Server
# ==============================================================================
FROM python:3.12-slim

# Create non-root user (UID 1000 is standard for Hugging Face Spaces & Render)
RUN useradd -m -u 1000 appuser

WORKDIR /app

# Install system dependencies for psycopg (PostgreSQL driver)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r backend/requirements.txt

# Copy backend source code and built frontend static bundle
COPY --chown=appuser:appuser backend/ ./backend/
COPY --chown=appuser:appuser --from=frontend-builder /app/frontend/dist ./frontend/dist

# Ensure /app/backend is writable for default SQLite fallback when DATABASE_URL is not set
RUN chown -R appuser:appuser /app

USER appuser
WORKDIR /app/backend

# Default port: 7860 for Hugging Face Spaces, overridden via $PORT on Render/Railway
ENV PORT=7860
ENV PYTHONUNBUFFERED=1

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os, urllib.request; port = os.getenv('PORT', '7860'); urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=3)" || exit 1

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-7860} --proxy-headers --forwarded-allow-ips '*'"]
