# StageFlow

StageFlow is a bounded stage you can demo alone, with the negotiation, the stats, and the broadcast limits made explicit.

This checkout contains the workspace, shared contracts, and P1-C03 HTTP API. Guests can create and fetch rooms through the API. The web package is still a typed placeholder; the home page and room shell arrive in P1-C04.

Observed tools: Node `v22.23.2`, pnpm `12.9.1`, Docker `29.7.2`, and Docker Compose `v5.4.0`. Use Node 22 (`.nvmrc`).

From the workspace root in PowerShell:

```powershell
pnpm install
Copy-Item .env.example .env
pnpm typecheck
pnpm lint
docker compose up -d
docker compose ps
pnpm --filter @stageflow/api migration:run
pnpm --filter @stageflow/api dev
```

Docker Desktop must be running with Linux containers. Postgres 16 uses port 5432, database/user/password `stageflow`, and a named data volume. Redis 7 uses port 6379 without a configured persistent volume. Both services have health checks. If either port is already occupied, resolve that conflict before starting Compose.

The root typecheck builds `@stageflow/shared` declarations and CommonJS output in `dist`, then checks all three packages. Shared uses Node16 resolution. API uses NodeNext resolution for the current Nest integration packages; both retain explicit CommonJS package types and CommonJS output. Web uses ES modules and bundler resolution in preparation for Vite. The API enables `experimentalDecorators` and `emitDecoratorMetadata` for Nest and TypeORM.

TypeScript `6.0.3` is the newest stable version supported by typescript-eslint `8.72.1` (which requires TypeScript below 6.1); TypeScript 7 is outside that range. ESLint `10.14.0` and its flat config cover all three packages, with explicit `any` forbidden. `pnpm --filter @stageflow/shared test` runs the shared parser and slug tests.

The environment example includes keys needed by later phases. Its credentials and JWT secret are local development values. Keep the copied `.env` out of version control.

The API listens on port 4000 by default. Its dev and migration commands load the root `.env` with `dotenv-cli`. Startup rejects missing or blank `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, and `CORS_ORIGIN`, and secrets shorter than 16 characters. Redis is only validated as a configuration string.

The four routes are `POST /api/sessions/guest`, `POST /api/rooms`, `GET /api/rooms/:slug`, and `GET /api/health`. Room calls require an `Authorization: Bearer <token>` header from a guest session. Guest tokens use HS256 and expire after 12 hours. Health runs a database query and returns only `{ "ok": true }` or HTTP 503 with `{ "ok": false }`.

The migration creates `users` and `rooms`. Run it explicitly before starting the API: schema synchronization and migrations on startup are disabled. Both entities inherit their UUID `id` and `createdAt` columns from the abstract database `BaseEntity`. PostgreSQL generates ids with `gen_random_uuid()` and timestamps with `now()`.
