# syntax=docker/dockerfile:1

# ---- Build stage: compile the TypeScript server packages ----
FROM node:22-alpine AS build
WORKDIR /app

# Workspace manifests first so layer caching helps.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci

# Compile the packages the server needs (deps: types -> auth -> core -> sdk -> mcp -> server).
RUN npm run build -w @agentdox/types \
    && npm run build -w @agentdox/auth \
    && npm run build -w @agentdox/core \
    && npm run build -w @agentdox/sdk \
    && npm run build -w @agentdox/mcp \
    && npm run build -w @agentdox/server

# ---- Runtime stage: slim, non-root ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.base.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages

# SQLite DB + WAL files live under /app/data (mounted from the host / volume).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3003
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:3003/health >/dev/null || exit 1

CMD ["sh", "-c", "node --disable-warning=ExperimentalWarning packages/server/dist/index.js"]
