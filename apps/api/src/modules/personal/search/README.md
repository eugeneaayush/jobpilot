# Budgeted employer-career search

`PersonalSearchService.search(userId, input)` reads `searchProvider: {provider: "brave", apiKey}` through `personalConfiguration(userId)` at runtime. No key is read at import time or stored in search receipts. The controller must use the existing private-account guard and pass only `personalSearchSchema` input. Missing/invalid provider setup returns `missing_setup` without reserving money or requesting the provider.

```ts
await search.search(userId, {
  query: "Example Capital careers MBA internships",
  maxPages: 3, // 1–10, default 3
  pageSize: 20, // 1–20, default 20
});
```

The entire supplied query is sent as an encoded `q` parameter to the fixed HTTPS Brave Web Search endpoint. No applicant facts, resume files, location coordinates, cookies, or employer forms are read. Query text cannot change the endpoint or headers. Candidate URLs are returned as untrusted research leads and never fetched by this module. Their identity and full job description remain explicitly unverified. Snippets cannot be promoted to complete job evidence, eligibility, readiness, or submission authorization.

## Verified provider contract

Verified 2026-09-16: [Brave's Search pricing](https://brave.com/search/api/) is $5 per 1,000 requests. The local reservation is exactly 5,000 micro-USD ($0.005) for every attempted page, without assuming free monthly credits. This is a dated public price assumption, not knowledge of the account's contract, invoice, taxes, or discounts.

[Brave's official Web Search reference](https://api-dashboard.search.brave.com/api-reference/web/search/get) allows queries up to 600 characters / 75 words, count up to 20 and page offsets 0–9. Pages may overlap. The connector disables spell correction, requests web results only, and verifies query correlation. It follows `query.more_results_available === true`; a short page alone does not prove exhaustion. A missing results array or missing pagination flag is unknown/failed, while an explicit empty array with `more_results_available:false` establishes an empty response for this query. The provider's index is not a census of employers or available jobs.

## Budget and recovery semantics

`reservePersonalSpend(prisma, userId, request, now?)` is a server-side shared budget primitive for `search`, `tailoring`, and `other` categories. Callers supply a justified fixed or upper-bound charge before invoking their provider. It locks the user row, reads authoritative `PersonalPolicy`, sums all retained reservations inside the current policy timezone's month, checks the monthly cap and search subcap, then inserts the reservation in the same transaction. The promise resolves only after commit. Each network request gets a fresh reservation; the search connector performs no automatic retry.

Limits are the lower of policy values and hard ceilings of $200/month overall and $50/month for search. All statuses count, including reserved, failed, blocked and uncertain. A timeout, process death or lost receipt never refunds budget automatically. Local accounting covers providers that use this ledger; unmetered external activity and account billing remain unknown. The response reports `tracking: local_reservations` and `actualProviderBillKnown:false` to preserve that distinction. Future tailoring integration must use the same primitive before making a paid call.

Monthly boundaries use `PersonalPolicy.timezone` (default America/New_York), including daylight saving transitions. Queries sum reservation timestamps within the current authoritative calendar instead of relying on previously stored month labels. Old receipts remain intact across month rollover.

HTTP 429 and supplied `Retry-After` produce persisted provider-wide `nextEligibleAt`. A subsequent reservation for the same user/provider reads that cooldown even for another query. A malformed/missing rate-limit delay conservatively defaults to 60 seconds. No provider call happens when budget or cooldown denies a reservation. The reservation retains the charge if response persistence fails, and the service stops before requesting another page.

## Persistence and privacy

The additive `personal_spend_reservations` table stores the user, category, provider, micro-USD charge, policy calendar, request URL hash, timestamps and sanitized result receipt. Query plaintext and API keys are never written by this module, returned in errors, or logged. Receipts keep query hash, endpoint without query, response-byte hash, candidate source URLs/hashes, snippet metadata, counts and pagination status. Provider error text/bodies are not persisted. A terminal receipt must match the reserved user, provider, category, charge and request hash, and is written once. There is no release/refund/delete API here.

The isolated Prisma model uses scalar `userId`; the reviewed SQL migration owns its FK to `users`. Keep that manual FK when reviewing future migrations. New enum mirrors live in `@jobpilot/contracts/personal-search`; parent owns central enum parity entries and route integration.

## Validation and migration commands

Synthetic unit tests, with PostgreSQL opt-in explicitly disabled:

```sh
env -u PERSONAL_TEST_DATABASE_URL bun test apps/api/src/modules/personal/search
bunx biome ci --error-on-warnings apps/api/src/modules/personal/search packages/contracts/src/personal-search.ts
bun --cwd=apps/api run typecheck
```

For the existing isolated PostgreSQL harness, set `PERSONAL_TEST_DATABASE_URL` to an authorized local synthetic database, then run from `apps/api`:

```sh
bun test src/modules/personal/search/budget.postgres.test.ts
```

That harness creates/drops a unique test schema and applies repository migrations only inside it. It must never receive the private production database URL. Five PG cases cover concurrent reservations, shared category limits, uncertain charge retention, durable cooldown and policy month rollover. Unit tests do not prove database locking by themselves.

Migration SQL was handwritten create-only at `apps/api/prisma/migrations/20260917020000_personal_search_spend/migration.sql`, then reviewed with the new schema. Validation used the installed Prisma binary from `/tmp`, avoiding runtime configuration and any database connection:

```sh
DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused /Users/eugenekainly/jobpilot/apps/api/node_modules/.bin/prisma validate --schema /Users/eugenekainly/jobpilot/apps/api/prisma/schema
```

Migration application, client generation, and route wiring are parent-owned integration steps. No provider request or private database operation is part of this module's synthetic validation.
