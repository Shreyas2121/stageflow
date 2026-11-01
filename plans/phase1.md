# Phase 1 — Foundation

**Status:** in progress. P1-C01 through P1-C03 committed (A01–A07 verified). P1-C04 implemented; browser acceptance A08/A09 unverified.\
**Last updated:** 2026-11-01.\
**Master plan:** `MASTER_PLAN.md` version `1.0.1`, Sections 1.4, 6.1, 6.2, 6.4, 12, 13, and 16 (Phase 1).\
**Execution guide:** [phase1/guide.md](phase1/guide.md). That guide owns P1-C01 through P1-C04. This file owns the rules those commits must satisfy.\
**Requirement IDs:** FOUND-01, FOUND-02.

## 1. Outcome

A reviewer can enter a display name, create a meeting or a webinar, and open that room's page. The page shows the title, mode, live status, slug, and host name, and it says that video is not part of this phase. The same reviewer can type the slug again and open the same room. An unknown slug, a blank name, and a missing token fail with a named error.

Example: display name `Ava`, title `Design review`, mode `MEETING`. The browser lands on `/r/` plus a 12-character slug. Reloading that URL still shows Design review. `GET /api/rooms/does-not-exist` with a valid token returns `room_not_found`.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-10-31:

- Workspace `F:\Shreyas\studio` contains `MASTER_PLAN.md`, `idea.md`, and `plans/` only.
- No `package.json`, `apps/`, `packages/`, lockfile, or `.git` directory.
- Node `v22.23.2`, pnpm `12.9.1`, Docker `29.7.2`.
- Git is installed. This directory was not a repository when the plan was written.

Recheck at execution. Git is required, alongside Docker, Node 22, and pnpm. Missing git blocks a slice from being finished, because a verified slice must be committed under master Section 1.4. Do not create a remote or push. Missing Docker, Node 22, pnpm, or git does not justify dropping a requirement.

## 3. Included and excluded

### 3.1 Included

- pnpm workspace with `@stageflow/shared`, `@stageflow/api`, and `@stageflow/web`.
- Strict TypeScript, ESLint, and a root `.env.example` covering the master environment list.
- Docker Compose for PostgreSQL 16 and Redis 7. Redis is started and health-checked. Application code does not connect to it.
- Shared room and session types, input parsers, and slug generation, with unit tests.
- User and room tables via one hand-written TypeORM migration. `synchronize` stays off.
- Guest session issue, room create, room fetch, and an unauthenticated database health check.
- Home page and a room shell. The session lives in `sessionStorage`.

### 3.2 Excluded

Do not add these, even though later phases or `idea.md` mention them:

- Socket.IO, `@nestjs/websockets`, `RTCPeerConnection`, `getUserMedia`, `hls.js`, FFmpeg, BullMQ, or an `ioredis` client.
- Redis presence, Lua, join/leave, green room, device pickers, or a video element.
- Broadcast tables, broadcast routes, and `DATA_ROOT` usage.
- Email, password, OAuth, refresh tokens, and a login route.
- Ending a room. Phase 1 inserts `LIVE` and never writes `ENDED`.
- Chat, a room list, or a public catalog of slugs.
- Component tests, controller tests, Playwright, and a marketing page.

`GET /api/health` is the one extra public route. It returns `{ "ok": true }` or `{ "ok": false }` and does not accept a session. It is an operations check, not a second way to authenticate.

## 4. Requirement mapping

| ID | Meaning in this phase | Later work this does not claim |
| --- | --- | --- |
| FOUND-01 | Install, typecheck, and lint succeed. Compose reports Postgres and Redis healthy. Both apps import `@stageflow/shared` | Sockets, media, and FFmpeg |
| FOUND-02 | Guest session, create meeting, create webinar, fetch by slug. No password column and no login route | Joining the live stage, which is Phase 2 |

## 5. System contracts

### 5.1 Workspace

| Package | Name | Role in this phase |
| --- | --- | --- |
| `packages/shared` | `@stageflow/shared` | Types, parsers, slug function. No React and no Nest imports |
| `apps/api` | `@stageflow/api` | NestJS 11 HTTP API |
| `apps/web` | `@stageflow/web` | Vite, React 19, the two routes |

Shared and the API compile as CommonJS so Nest can load the package. The web app is the Vite ESM default. Shared publishes `dist`. Root `typecheck` builds shared before the packages typecheck. Resolve current stable releases at install time and commit `pnpm-lock.yaml`. Do not copy versions from `idea.md`.

Node stays on the installed 22 line. `.nvmrc` contains `22`. Record `node -v` and `pnpm -v` in the README during P1-C01. The planning-time pnpm version is `12.9.1`; write the version the implementer actually runs into `packageManager`.

The API TypeScript config keeps `strict: true` and turns off `strictPropertyInitialization` so TypeORM entities do not need non-null assertions. Decorator settings follow the installed Nest 11 and TypeORM releases. Expect `experimentalDecorators` and `emitDecoratorMetadata` until those releases say otherwise. Record the choice in the README if it differs.

### 5.2 Environment

One root `.env.example`. Developers copy it to a root `.env`, which is gitignored. The API dev and migration scripts load that file with `dotenv-cli` from `apps/api` (`../../.env`). Vite's `envDir` is the repo root.

Startup fails before listen when `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, or `CORS_ORIGIN` is missing or blank. `JWT_SECRET` shorter than 16 characters also fails. `PORT` defaults to `4000`. `NODE_ENV` defaults to `development`.

`REDIS_URL` is checked as a string and then ignored. Do not construct a Redis client to prove the variable exists.

The example file still lists `STUN_URL`, `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`, `FFMPEG_PATH`, `DATA_ROOT`, `VITE_API_BASE_URL`, and `VITE_WS_URL`. Phase 1 code reads `VITE_API_BASE_URL` only. It does not read `VITE_WS_URL`.

Compose publishes Postgres on `5432` and Redis on `6379`, database and user `stageflow`, password `stageflow`. Postgres keeps a named volume. Redis does not. If a port is already taken, stop and report it. Do not silently renumber.

### 5.3 Identity and rooms

Master Sections 6.1 and 6.2, narrowed as follows.

`POST /api/sessions/guest` with a JSON object. The only field read is `displayName`. Extra fields, including `password` and `email`, are ignored and are not stored.

The display name is trimmed. It must then be 1–40 characters and must not contain ASCII control characters (`U+0000`–`U+001F` or `U+007F`). Failure is HTTP 400:

```json
{ "statusCode": 400, "error": "invalid_display_name", "message": "Enter a display name from 1 to 40 characters." }
```

Success creates a user and returns the trimmed name:

```json
{ "token": "<jwt>", "userId": "<uuid>", "displayName": "Ava" }
```

The JWT is HS256, `sub` is the user id, and it expires in 12 hours. There is no refresh token.

`POST /api/rooms` requires `Authorization: Bearer <token>`. Body fields used are `title` and `mode`. Title uses the same trim and control-character rules, with length 1–80:

```json
{ "statusCode": 400, "error": "invalid_title", "message": "Enter a title from 1 to 80 characters." }
```

`mode` must be the exact string `MEETING` or `WEBINAR`. Anything else, including different casing:

```json
{ "statusCode": 400, "error": "invalid_mode", "message": "Choose a meeting or a webinar." }
```

A missing or invalid token on a protected route:

```json
{ "statusCode": 401, "error": "unauthorized", "message": "Sign in as a guest before calling this route." }
```

The created room is `LIVE`, `endedAt` is null, and `hostId` is the caller. The slug is 12 characters from `A–Z`, `a–z`, and `0–9`, produced by `createRoomSlug`. Bytes `248–255` are rejected and another byte is drawn, so the alphabet is uniform. Thirty-two consecutive rejects throw. On a unique-slug collision, the service tries a new slug up to five times, then responds 500 with `error: "slug_exhausted"`.

`GET /api/rooms/:slug` requires the bearer token. A slug that is not exactly 12 alphanumeric characters, or a slug with no row, is the same response:

```json
{ "statusCode": 404, "error": "room_not_found", "message": "No room exists for that slug." }
```

Room JSON:

```json
{
  "id": "<uuid>",
  "slug": "<12 chars>",
  "title": "Design review",
  "mode": "MEETING",
  "status": "LIVE",
  "hostId": "<uuid>",
  "hostDisplayName": "Ava",
  "createdAt": "<ISO-8601>",
  "endedAt": null
}
```

Any authenticated guest who knows the slug may fetch the room. Do not add a room password. Do not add `GET /api/rooms`.

`GET /api/health` runs `SELECT 1`. Success is `{ "ok": true }`. Database failure is HTTP 503 `{ "ok": false }` and does not include a connection string.

CORS allows only `CORS_ORIGIN`, methods `GET` and `POST`, and headers `Authorization` and `Content-Type`.

Parsers live in `@stageflow/shared`. The controller passes `unknown` into them. Do not add a second class-validator schema for the same fields.

### 5.4 Tables

One migration. No `synchronize`.

`users`

| Column | Type |
| --- | --- |
| `id` | uuid primary key, default `gen_random_uuid()` |
| `display_name` | `varchar(40)` not null |
| `is_guest` | boolean not null, default `true` |
| `created_at` | `timestamptz` not null, default `now()` |

Every insert sets `is_guest` true. There is no email column and no password column.

`rooms`

| Column | Type |
| --- | --- |
| `id` | uuid primary key, default `gen_random_uuid()` |
| `slug` | `varchar(12)` not null, unique |
| `title` | `varchar(80)` not null |
| `mode` | text not null, check `MEETING` or `WEBINAR` |
| `status` | text not null, check `LIVE` or `ENDED` |
| `host_id` | uuid not null, references `users(id)` |
| `created_at` | `timestamptz` not null, default `now()` |
| `ended_at` | `timestamptz` null |

Use text plus check constraints, not PostgreSQL enum types. Entity properties stay camelCase and map to these column names.

At the user's request, both entities inherit the identical `id` and `createdAt` columns from an abstract database `BaseEntity`. This code reuse does not alter the table contract or migration.

### 5.5 Web

| Route | Behavior |
| --- | --- |
| `/` | Display name, title, slug, buttons for create meeting, create webinar, and join |
| `/r/:slug` | Room shell, or a named error |
| Any other path | A short not-found line and a link to `/` |

Submitting the home form always mints a new guest session from the display name in the field, stores `{ token, userId, displayName }` under `sessionStorage` key `stageflow.session`, then creates or fetches. A reload of the tab keeps the session. A new tab does not. Replacing the session replaces the stored guest.

Create validates the name and title, posts the room, and navigates to `/r/<slug>`. Join validates the name and requires an exact 12-character alphanumeric slug before calling the API. The client slug error is `Enter the 12 character room slug.` A 404 stays on the home page and shows the server message.

The room page with no session does not call the API. It says to enter a name on the home page and links there. With a session, it loads the room and shows title, mode, status, slug, and host display name. It also shows: `Foundation build. The green room and video arrive in a later phase.` HTTP 404 and 401 use the sentences from Section 5.3.

Render names and titles as text. No video element, no `getUserMedia`, no socket.

The page is dark, with light text, visible keyboard focus, and labels tied to inputs. Error text includes the word `Error`, not a color change alone. This is not a landing page.

## 6. Acceptance matrix

| ID | Observable result | Method | Status |
| --- | --- | --- | --- |
| P1-A01 | `pnpm install`, root typecheck, and root lint exit 0 | Commands | verified |
| P1-A02 | Compose Postgres and Redis are healthy | `docker compose ps` | verified |
| P1-A03 | Parser and slug tests pass | `pnpm --filter @stageflow/shared test` | verified |
| P1-A04 | Guest session, meeting create, and fetch return the contracts in Section 5.3 | HTTP | verified |
| P1-A05 | Webinar create returns `mode: "WEBINAR"` | HTTP | verified |
| P1-A06 | Blank name, bad mode, missing token, and unknown slug return the named errors | HTTP | verified |
| P1-A07 | App source has no password column, login route, socket, Redis client, WebRTC, or FFmpeg import | Search | verified |
| P1-A08 | The browser can create a meeting and the shell shows its title, mode, slug, host, and the foundation sentence | Browser | unverified (no browser tool) |
| P1-A09 | The browser can open that slug from home, and an unknown slug shows `room_not_found` without leaving home | Browser | unverified (no browser tool) |

FOUND-01 is A01–A03. FOUND-02 is A04–A07, demonstrated in the browser by A08–A09. Do not mark an ID verified because the file exists.

P1-C01 verification (2026-10-31): install, root typecheck, and root lint exited 0. Compose startup and health wait exited 0; `docker compose ps` showed Postgres 16 and Redis 7 healthy on ports 5432 and 6379. The root `.env` was copied from `.env.example`. See the execution guide's P1-C01 verification record for the installed tooling versions. Later acceptance IDs remain planned.

P1-C02 verification (2026-10-31): all 43 shared tests passed with Vitest 5.0.5. Root install, typecheck, and lint exited 0, including both apps importing `RoomMode` from `@stageflow/shared`. Shared build excludes the tests. A04–A09 remain planned.

P1-C03 verification (2026-10-31): migration succeeded and rerunning it reported no pending migrations. Root typecheck, lint, API build, and all 43 shared tests passed. Live HTTP checks verified guest JWTs, both room modes, exact fetch responses, contract errors, CORS, and invalid authentication. A real database fixture verified slug retry and exhaustion. Health returned exactly HTTP 503 `{ "ok": false }` during a database outage, then recovered after Postgres was restored. The original room survived API restarts and remained fetchable by another guest. After extracting the base entity, generated IDs/timestamps and both room modes were checked again. The prohibited-source search had no matches. Details and the corrected first outage attempt are recorded in the guide. A08–A09 remain planned.

P1-C04 implementation verification (2026-10-31 / 2026-11-01): install, root typecheck, root lint, all 43 shared tests, and the web production build passed. Both database containers remain healthy; the migration has no pending work. The Vite dev server delivered the home, room, and fallback documents and transformed the application modules; the root API environment value was present. A07 still has no source matches. The implementation includes the home forms, guest session storage, shared validation, room queries, error states, and dark responsive styling. No browser tool was available, so the seven required browser steps were not performed and A08/A09 remain unverified. The phase remains in progress.

## 7. Verification commands

Created during the phase, then used at the exit. Paths assume the repo root and PowerShell.

```powershell
pnpm install
pnpm typecheck
pnpm lint
pnpm --filter @stageflow/shared test
docker compose up -d
docker compose ps
pnpm --filter @stageflow/api migration:run
pnpm --filter @stageflow/api dev
pnpm --filter @stageflow/web dev
```

`pnpm typecheck` builds shared before typechecking the workspace. `migration:run` and the API dev script load the root `.env`. The guide records the exact `curl.exe` calls for A04–A06.

Search A07 from the repo root, in `apps` and `packages` only:

```powershell
rg -n "socket\.io|ioredis|webrtc|getUserMedia|ffmpeg|hls\.js|passwordHash|password_hash" apps packages -g "!dist/**" -g "!node_modules/**"
```

No matches is the pass. Planning documents are allowed to mention those words.

## 8. Risks

| Risk | What to do |
| --- | --- |
| `idea.md` still describes email, password, chat, and Socket.IO | Follow this file. Do not port those entities |
| Redis is required in the environment, so a client gets added "while we're here" | Validate the string. Do not import `ioredis` |
| `synchronize: true` hides a missing migration | Leave it false. The migration is hand-written |
| Shared ESM output cannot be loaded by Nest | CommonJS shared package, as Section 5.1 |
| The room page fakes a video tile so the route looks finished | The foundation sentence is the UI. No media element |
| A health route or a catalog route leaks the database or the slug list | Health returns only `ok`. There is no collection route |

## 9. Exit and handoff

Phase 1 is done when A01–A09 are verified and the guide statuses say so. Phase 2 may rely on:

- The user and room tables, the migration, and `synchronize: false`.
- Guest JWTs whose `sub` is the user id, expiring in 12 hours.
- `RoomResponse` and the error codes in Section 5.3.
- Slugs of exactly 12 alphanumeric characters.
- Root `.env`, including a validated but unused `REDIS_URL`.
- `sessionStorage` key `stageflow.session` and routes `/` and `/r/:slug`.

Phase 2 replaces the interior of the room page. It does not replace guest creation or room fetch. Do not write `plans/phase2.md` until that work starts.
