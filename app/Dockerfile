# Kompl v2 — Next.js app container.
#
# Build context: project root (not ./app). This gives the Dockerfile
# access to both app/ and scripts/ directories without BuildKit context
# gymnastics. See docker-compose.yml: `context: .` + `dockerfile: app/Dockerfile`.
#
# Single-container entrypoint enforces architecture rule #1:
#   "kompl.db has exactly one open file handle at any instant."
#
# At container start: python3 runs scripts/migrate.py (stdlib sqlite3 only,
# no pip deps), then EXITS. Only after that does Node fork and open the DB.
# This guarantees no overlapping file handles and no stale fcntl locks
# across container restarts.
#
# python3 (full stdlib) is ~45MB. We intentionally AVOID python3-minimal
# because debian-slim's python3-minimal strips the sqlite3 stdlib module
# (it's shipped only with the full python3 package via libpython3-stdlib).
# Verified by runtime failure 2026-04-08: "ModuleNotFoundError: No module
# named 'sqlite3'" when using python3-minimal. Still no pip/venv/setuptools.

# ---- Build stage ----
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies first for better layer caching
COPY app/package.json app/package-lock.json* ./
RUN npm install

# Copy app source and build
COPY app/ ./
RUN npm run build

# ---- Runtime stage ----
FROM node:20-slim AS runtime

# Install python3 (full stdlib, includes sqlite3) for migrate.py.
# --no-install-recommends keeps pip/setuptools/venv out. migrate.py uses
# ONLY the stdlib sqlite3 module which requires the full python3 package
# (python3-minimal does NOT include the sqlite3 module on debian-slim).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the Next.js standalone build output (self-contained server.js +
# minimal node_modules) and the static assets.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Copy the migration script from the project root's scripts/ directory.
COPY scripts/migrate.py /app/scripts/migrate.py

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DB_PATH=/data/db/kompl.db

EXPOSE 3000

# Entrypoint sequence: run migration to completion, THEN exec Node.
# `exec` replaces the shell process so Node becomes PID 1 and receives
# signals correctly. If migrate.py fails (non-zero exit), the container
# fails fast and Node never starts — the DB is never touched by two
# processes simultaneously.
ENTRYPOINT ["sh", "-c", "python3 /app/scripts/migrate.py && exec node server.js"]
