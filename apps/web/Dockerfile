# JobPilot web - Next.js standalone. Needs the API source at build time (@jobpilot/api-client imports the App type).
FROM oven/bun:1-slim AS base
WORKDIR /app

FROM base AS build
# NEXT_PUBLIC_* are baked into the bundle at build time.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_TERMINAL_URL=http://localhost:4102
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_TERMINAL_URL=$NEXT_PUBLIC_TERMINAL_URL

COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/api-client/package.json ./packages/api-client/

RUN bun install --frozen-lockfile --ignore-scripts

COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web ./apps/web
# The App type reaches personal controllers that import these helpers; type-checking needs them.
COPY plugin/scripts/personal-browser ./plugin/scripts/personal-browser

# Generate the Prisma client so @jobpilot/api types resolve for the web build.
WORKDIR /app/apps/api
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" bun run db:generate

WORKDIR /app/apps/web
RUN bun run build

# Runtime - Next.js standalone output on Node.
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache curl

COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

ENV PORT=4100
ENV HOSTNAME=0.0.0.0
EXPOSE 4100

CMD ["node", "apps/web/server.js"]
