# JobPilot API - run interpreted by Bun so the entrypoint can migrate at startup and tsyringe keeps its decorator metadata.
FROM oven/bun:1-alpine AS deps
WORKDIR /app

# Prisma's CLI/engine needs openssl present.
RUN apk add --no-cache openssl

# Copy the workspace manifests first so the install layer caches on lockfile changes.
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/api-client/package.json ./packages/api-client/

# Install only the API and its workspace deps.
RUN bun install --frozen-lockfile --filter @jobpilot/api

# Source needed to generate the Prisma client.
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api

WORKDIR /app/apps/api
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" bun run db:generate

# Runtime - same alpine/musl base so the copied engine binaries match.
FROM oven/bun:1-alpine AS runner
WORKDIR /app/apps/api

RUN apk add --no-cache openssl curl

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/package.json /app/package.json
COPY --from=deps /app/packages/contracts /app/packages/contracts
COPY --from=deps /app/apps/api /app/apps/api
# Two personal controllers import pure helpers from the plugin's browser scripts by relative path.
COPY plugin/scripts/personal-browser /app/plugin/scripts/personal-browser

# Local-storage fallback dir (resumes / generated PDFs); compose mounts a volume here.
RUN mkdir -p storage

ENV NODE_ENV=production
ENV PORT=4101
EXPOSE 4101

# Migrations are applied manually, not at startup.
CMD ["bun", "run", "start"]
