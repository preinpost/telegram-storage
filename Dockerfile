# syntax=docker/dockerfile:1

# ---- Build the React SPA (web/dist) ----
FROM node:24 AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Install backend dependencies (compiles native better-sqlite3) ----
FROM node:24 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- Runtime (kept small; reuses the prebuilt native modules) ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    STATIC_DIR=./web/dist \
    DB_PATH=./data/telegram-storage.db \
    TMP_DIR=./tmp
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY --from=web-build /app/web/dist ./web/dist
RUN mkdir -p data tmp
EXPOSE 3000
# Node 24 runs the TypeScript entry with the full transform (incl. TS
# parameter properties, which plain type-stripping rejects).
CMD ["node", "--experimental-transform-types", "src/index.ts"]
