# StageFlow

StageFlow is a bounded stage you can demo alone, with the negotiation, the stats, and the broadcast limits made explicit.

Phase 1 implements guest sessions, room creation, and a web room shell. Enter a display name, create a meeting or webinar, or join an existing room with its 12 character slug. The shell shows the room title, format, live status, slug, and host name. Foundation build: the green room and video arrive in a later phase.

Observed tools: Node `v22.23.2`, pnpm `12.9.1`, Docker `29.7.2`, and Docker Compose `v5.4.0`. Use Node 22 (`.nvmrc`).

From the workspace root in PowerShell:

```powershell
pnpm install
Copy-Item .env.example .env
pnpm typecheck
pnpm lint
pnpm --filter @stageflow/shared test
docker compose up -d
docker compose ps
pnpm --filter @stageflow/api migration:run
```

Copy the example only on first setup; keep any existing local `.env` values. Typecheck builds shared before either app starts. Compose should show Postgres and Redis healthy.

Start the API and web app in separate PowerShell terminals, each at the workspace root:

```powershell
pnpm --filter @stageflow/api dev
```

```powershell
pnpm --filter @stageflow/web dev
```

Open `http://localhost:5173`. The API uses `http://localhost:4000/api`. Vite loads the root `.env` and uses port 5173 strictly, matching the API's configured CORS origin. Restart the web app after changing its environment values.

The home page validates names and room titles through the shared parsers and requires an exact 12 character alphanumeric slug to join. Each valid create/join submission issues a new guest session. A failed join stays on the home page and displays the API error. The room shell at `/r/:slug` fetches its data with TanStack Query, keyed by slug and token.

Guest state is stored in `sessionStorage` under `stageflow.session`. Reloading the same tab keeps the session; a new tab opened independently starts without it. A direct room URL without a session asks you to enter a name on the home page. Corrupt stored session data is cleared. Names and titles render as text.

This phase has no socket, no camera, no Redis client, and no broadcast. It does not join a live stage, end a room, or provide login accounts.

`pnpm --filter @stageflow/web build` creates the web production bundle. Phase 1 is complete: automated checks pass, and all seven browser acceptance steps passed in isolated Chrome 156 on Windows on 2026-11-01. The [phase guide](plans/phase1/guide.md#6-p1-c04--home-page-and-room-shell) records creation, reload, joining, error handling, sessionless tabs, and keyboard focus verification.

Docker Desktop must be running with Linux containers. Postgres 16 uses port 5432, database/user/password `stageflow`, and a named data volume. Redis 7 uses port 6379 without a configured persistent volume. Both services have health checks. If either port is already occupied, resolve that conflict before starting Compose.

The root typecheck builds `@stageflow/shared` declarations and CommonJS output in `dist`, then checks all three packages. Shared uses Node16 resolution. API uses NodeNext resolution for the current Nest integration packages; both retain explicit CommonJS package types and CommonJS output. Web uses Vite with ES modules and bundler resolution. The API enables `experimentalDecorators` and `emitDecoratorMetadata` for Nest and TypeORM.

TypeScript `6.0.3` is the newest stable version supported by typescript-eslint `8.72.1` (which requires TypeScript below 6.1); TypeScript 7 is outside that range. ESLint `10.14.0` and its flat config cover all three packages, with explicit `any` forbidden. `pnpm --filter @stageflow/shared test` runs the shared parser and slug tests.

The environment example includes keys needed by later phases. Its credentials and JWT secret are local development values. Keep the copied `.env` out of version control.

The API listens on port 4000 by default. Its dev and migration commands load the root `.env` with `dotenv-cli`. Startup rejects missing or blank `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, and `CORS_ORIGIN`, and secrets shorter than 16 characters. Redis is only validated as a configuration string.

The four routes are `POST /api/sessions/guest`, `POST /api/rooms`, `GET /api/rooms/:slug`, and `GET /api/health`. Room calls require an `Authorization: Bearer <token>` header from a guest session. Guest tokens use HS256 and expire after 12 hours. Health runs a database query and returns only `{ "ok": true }` or HTTP 503 with `{ "ok": false }`.

The migration creates `users` and `rooms`. Run it explicitly before starting the API: schema synchronization and migrations on startup are disabled. Both entities inherit their UUID `id` and `createdAt` columns from the abstract database `BaseEntity`. PostgreSQL generates ids with `gen_random_uuid()` and timestamps with `now()`.
