# Guide 1 — Phase 1, commit by commit

**Status:** Phase 1 complete. P1-C01 committed (`c2cce0d`), P1-C02 committed (`1faf5b9`), P1-C03 committed (`2eb1371`), and P1-C04 committed (`eb95669`). A01–A09 verified.\
**Last updated:** 2026-11-01.\
**Phase contract:** [../phase1.md](../phase1.md).\
**Product authority:** [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.1`.\
**Deliverable:** Guest sessions and room create/fetch, in four commits. This is the only Phase 1 guide.

## 1. Execution rules

Read the phase contract before editing code. This guide is a sequence, not evidence that the code exists. The repository at planning time had no application files and no git repository.

When the user authorizes implementation:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run P1-C01 through P1-C04 in order. Stop after the requested slice. A later section is not permission to skip the current one.
3. Each slice leaves `pnpm typecheck` and `pnpm lint` passing, plus the tests introduced so far.
4. Set a slice to `implemented`, then `verified`, only when that is true. Verification is not the end of the slice. Commit it before the next slice, using master Section 1.4. If `.git` is missing, `git init -b main` from the repo root first. Do not create a remote, push, or change git config. Leave `Actual commit` blank inside the slice commit, then write the real hash and set the status to `committed`. P1-C01 and P1-C02 are committed.
5. If a check cannot be run, leave its acceptance ID unverified and name the gap. Do not invent a passing result.
6. If the installed Nest or TypeORM release forces a file move, update the remaining guide before continuing.

Do not add Socket.IO, `ioredis`, WebRTC, `hls.js`, FFmpeg, BullMQ, email, or password storage in any slice.

### 1.1 Commit index

| Order | ID     | Proposed message                                                      | Acceptance         |
| ----- | ------ | --------------------------------------------------------------------- | ------------------ |
| 1     | P1-C01 | `chore(workspace): initialize the pnpm workspace and local databases` | A01, A02           |
| 2     | P1-C02 | `feat(shared): add session and room input contracts`                  | A03                |
| 3     | P1-C03 | `feat(api): issue guest sessions and persist rooms`                   | A04, A05, A06, A07 |
| 4     | P1-C04 | `feat(web): create a room and open its shell`                         | A08, A09           |

## 2. Environment

Planning-time tools: Node `v22.23.2`, pnpm `12.9.1`, Docker `29.7.2`. Recheck with `node -v`, `pnpm -v`, and `docker --version`.

From the repo root, in PowerShell. Use `curl.exe`, not the `curl` alias.

## 3. P1-C01 — Workspace and local databases

**Status:** committed\
**Proposed commit message:** `chore(workspace): initialize the pnpm workspace and local databases`\
**Actual commit:** `c2cce0d`

**Why:** FOUND-01 needs a workspace, strict TypeScript, lint, and healthy Postgres and Redis before any product route exists. Covers P1-A01 and P1-A02.

**Depends on:** The planning files already in the repo.

**Files:**

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `tsconfig.base.json`
- `eslint.config.js`
- `.nvmrc`
- `.gitignore`
- `.env.example`
- `docker-compose.yml`
- `README.md`
- `packages/shared/package.json`
- `packages/shared/tsconfig.json`
- `packages/shared/tsconfig.build.json`
- `packages/shared/src/index.ts`
- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/api/src/index.ts`
- `apps/web/package.json`
- `apps/web/tsconfig.json`
- `apps/web/src/index.ts`

**Implementation:**

1. Create the workspace. Package names are `@stageflow/shared`, `@stageflow/api`, and `@stageflow/web`. Root scripts are `typecheck` and `lint`. `.nvmrc` is `22`. `packageManager` is the pnpm version actually run. `pnpm-workspace.yaml` includes `apps/*` and `packages/*`.
2. `tsconfig.base.json` sets `strict`, `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`, `target` `ES2022`, and `forceConsistentCasingInFileNames`. Shared and API extend it with CommonJS module output. Shared `tsconfig.json` typechecks `src` with `noEmit`. Shared `tsconfig.build.json` emits declarations to `dist` and excludes tests. The API config turns `strictPropertyInitialization` off. The web config uses the Vite bundler defaults and strict TypeScript.
3. Each package exports a trivial typed constant from `src/index.ts` so the first typecheck has a real file. Shared `package.json` points `types` and the default export at `dist`. Its scripts are `typecheck` (`tsc --noEmit`) and `build` (`tsc -p tsconfig.build.json`). API and web scripts are `typecheck` and `lint` only. Do not add Nest, Vite, or React in this slice.
4. Root `typecheck` builds shared, then runs `pnpm -r typecheck`. Root `lint` runs `pnpm -r lint`. One root ESLint flat config covers the three packages. `no-explicit-any` is an error. Each package `lint` script uses that config.
5. `.gitignore` includes `node_modules`, `dist`, `.env`, `apps/api/data`, coverage, and TypeScript build info.
6. `.env.example` contains every key in master Section 12.3. Use `PORT=4000`, `NODE_ENV=development`, a `JWT_SECRET` of at least 16 characters marked as a dev secret, `CORS_ORIGIN=http://localhost:5173`, `DATABASE_URL=postgresql://stageflow:stageflow@localhost:5432/stageflow`, `REDIS_URL=redis://localhost:6379`, empty TURN values, `STUN_URL=stun:stun.l.google.com:19302`, `FFMPEG_PATH=ffmpeg`, `DATA_ROOT=apps/api/data`, `VITE_API_BASE_URL=http://localhost:4000/api`, and `VITE_WS_URL=http://localhost:4000`.
7. `docker-compose.yml` runs `postgres:16` and `redis:7` with the health checks and the Postgres volume from the phase contract. Redis has no volume.
8. README states the product sentence, that this checkout cannot create a room yet, the observed Node and pnpm versions, and the commands `pnpm install`, `pnpm typecheck`, `pnpm lint`, and `docker compose up -d`.

Install current stable TypeScript and ESLint packages that satisfy those scripts. Do not add application dependencies yet.

**Verification:**

```powershell
pnpm install
pnpm typecheck
pnpm lint
docker compose up -d
docker compose ps
```

`typecheck` and `lint` exit 0. Compose shows Postgres and Redis healthy. Copy `.env.example` to `.env` for later slices and do not commit `.env`.

**Done when:** P1-A01 and P1-A02 pass, no app dependency beyond the toolchain is installed, and the slice has a git commit under master Section 1.4. That commit is still outstanding.

**Handoff:** The three packages compile. Product types are not defined yet.

**Verification record (2026-10-31):** `pnpm install`, `pnpm typecheck`, and `pnpm lint` exited 0. Shared emitted CommonJS JavaScript and declarations to `dist`. Installed only toolchain dev dependencies: TypeScript 6.0.3, ESLint 10.14.0, @eslint/js 10.0.1, and typescript-eslint 8.72.1. TypeScript is held to 6.0 because the current lint tooling requires TypeScript <6.1. Node16 module resolution plus explicit CommonJS package types provides the required shared/API output without deprecated resolution settings. `.env.example` was copied to the ignored root `.env`. Docker Desktop's Linux engine became available after `docker desktop start`; `docker compose up -d` exited 0. `docker compose up -d --wait --wait-timeout 60` also exited 0, and `docker compose ps` reported `studio-postgres-1` (`postgres:16`, port 5432) and `studio-redis-1` (`redis:7`, port 6379) healthy. P1-A01 and P1-A02 are verified. The slice was left uncommitted under the old rule. Master `1.0.1` requires that commit before P1-C02.

## 4. P1-C02 — Shared session and room contracts

**Status:** committed\
**Proposed commit message:** `feat(shared): add session and room input contracts`\
**Actual commit:** `1faf5b9`

**Why:** The API and the web app need one parser for names, titles, modes, and slugs. Covers P1-A03.

**Depends on:** P1-C01.

**Files:**

- `packages/shared/src/index.ts`
- `packages/shared/src/contracts.ts`
- `packages/shared/src/contracts.test.ts`
- `packages/shared/vitest.config.ts`
- `packages/shared/package.json`
- `pnpm-lock.yaml`
- `apps/api/package.json`
- `apps/web/package.json`
- `apps/api/src/index.ts`
- `apps/web/src/index.ts`

**Implementation:**

1. Add Vitest to shared. Script `test` runs `vitest run`. Keep tests inside the typecheck program and outside the build program.
2. Replace the trivial shared export with the types and functions below. Both apps import `RoomMode` from `@stageflow/shared` so the dependency is real. Leave their entry files otherwise trivial.
3. Implement the parsers and slug function in `contracts.ts`. Messages and codes match the phase contract exactly.

```ts
export type RoomMode = 'MEETING' | 'WEBINAR';
export type RoomStatus = 'LIVE' | 'ENDED';

export type GuestSessionResponse = {
  token: string;
  userId: string;
  displayName: string;
};

export type CreateRoomRequest = {
  title: string;
  mode: RoomMode;
};

export type RoomResponse = {
  id: string;
  slug: string;
  title: string;
  mode: RoomMode;
  status: RoomStatus;
  hostId: string;
  hostDisplayName: string;
  createdAt: string;
  endedAt: string | null;
};

export type ApiErrorBody = {
  statusCode: number;
  error:
    | 'invalid_display_name'
    | 'invalid_title'
    | 'invalid_mode'
    | 'unauthorized'
    | 'room_not_found'
    | 'slug_exhausted';
  message: string;
};

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; error: ApiErrorBody['error']; message: string };
```

`parseDisplayName(input: unknown)` accepts only a string, trims it, and applies the phase length and control-character rules. `parseRoomTitle` does the same for 1–80. `parseRoomMode` accepts only `MEETING` and `WEBINAR`.

`createRoomSlug(nextByte: () => number)` draws until it has 12 alphabet characters. Alphabet is `A-Za-z0-9` (62 characters). A byte greater than or equal to 248 is discarded. Per the phase contract, 32 consecutive rejected draws throw an error whose message is `slug_source_exhausted`; an accepted byte resets that counter. `createRoomSlugFromCrypto()` passes a one-byte `crypto.getRandomValues` source.

4. Tests, in the same commit:
   - Empty, whitespace, 41 characters, and a name containing `\n` fail as `invalid_display_name`. A 40-character name and surrounding spaces succeed with the trimmed value.
   - Title length 0 and 81 fail. Length 80 succeeds.
   - `meeting` fails as `invalid_mode`. Both exact modes succeed.
   - A stub byte source that returns `0`, then values above 247, then enough accepted bytes produces a 12-character slug from the alphabet. An always-rejected source cannot complete a slug.
   - A source that always returns `255` throws `slug_source_exhausted`.
   - Two calls with different byte sequences can differ. Do not assert cryptographic uniqueness.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm typecheck
pnpm lint
```

**Done when:** P1-A03 passes and both apps still typecheck against the shared export.

**Handoff:** Callers can validate input without a database. No HTTP server exists yet.

**Verification record (2026-10-31):** Installed Vitest 5.0.5 in shared and linked both apps to shared via `workspace:*`. `pnpm install`, `pnpm typecheck`, `pnpm lint`, and `pnpm --filter @stageflow/shared test` exited 0. All 43 tests passed, covering input boundaries, wrong input types, trimming, every ASCII control character, exact modes, rejected bytes, all 248 accepted byte mappings, the consecutive rejection limit and reset, different deterministic sources, and a real crypto-generated slug. Shared build output contains only `index` and `contracts` JavaScript/declarations; tests remain in the typecheck program. The Vitest config uses CommonJS syntax to match this package. The guide's rejection counter and fixture were corrected to follow the phase contract. P1-A03 is verified. No commit was made for P1-C02.

## 5. P1-C03 — Guest sessions and rooms

**Status:** committed\
**Proposed commit message:** `feat(api): issue guest sessions and persist rooms`\
**Actual commit:** `2eb1371`

**Why:** FOUND-02 is an HTTP contract. The browser in the next slice needs these routes. Covers P1-A04, P1-A05, P1-A06, and P1-A07.

**Depends on:** P1-C02 and a copied root `.env`. Postgres from P1-C01 must be running.

**Files:**

- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/api/nest-cli.json`
- `pnpm-lock.yaml`
- `README.md`
- `apps/api/src/main.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/database/data-source.ts`
- `apps/api/src/database/base.entity.ts`
- `apps/api/src/migrations/1730332800000-CreateUsersAndRooms.ts`
- `apps/api/src/users/user.entity.ts`
- `apps/api/src/sessions/sessions.module.ts`
- `apps/api/src/sessions/sessions.controller.ts`
- `apps/api/src/sessions/sessions.service.ts`
- `apps/api/src/sessions/jwt-auth.guard.ts`
- `apps/api/src/sessions/current-user.decorator.ts`
- `apps/api/src/rooms/room.entity.ts`
- `apps/api/src/rooms/rooms.module.ts`
- `apps/api/src/rooms/rooms.controller.ts`
- `apps/api/src/rooms/rooms.service.ts`
- `apps/api/src/health/health.controller.ts`
- `apps/api/src/http/api.exception.ts`
- `apps/api/src/http/api-exception.filter.ts`
- Delete `apps/api/src/index.ts` if Nest's entry replaces it.

**Implementation:**

1. Add NestJS 11, TypeORM, the PostgreSQL driver, `@nestjs/config`, `@nestjs/jwt`, and `dotenv-cli`. Use the decorator mode those releases require. API uses NodeNext module resolution with its CommonJS package type, allowing current ESM Nest integrations on Node 22 while emitting CommonJS. `synchronize` is `false`. Migrations do not run on boot.
2. `env.ts` reads the variables from the phase contract and throws a message that names every missing key before `NestFactory.create`. Do not open Redis.
3. Dev and migration scripts load `../../.env` through `dotenv-cli`. `migration:run` uses the TypeORM CLI against `src/database/data-source.ts`. If the installed package's binary name differs, use the binary that runs and correct this guide.
4. Hand-write the migration for the two tables in phase Section 5.4. Entities use the same column names. Both entities extend an abstract database `BaseEntity` with the UUID `id` and `createdAt` columns (user-requested code reuse; no schema change). Register the migration on the data source. Use `uuidExtension: 'pgcrypto'` for `gen_random_uuid()` metadata and disable automatic extension installation.
5. `POST /api/sessions/guest` uses `parseDisplayName` on the raw body. On failure, throw the shared error through `ApiException`, which the filter renders as `ApiErrorBody`. On success, insert the user with `isGuest: true` and sign the JWT.
6. The guard reads only `Authorization: Bearer`. It verifies HS256 with `JWT_SECRET`, requires `sub` to be a UUID, and loads that user. Failure is `unauthorized`. Attach the user for the controller. Do not accept the token as a query parameter.
7. `POST /api/rooms` parses title and mode, generates a slug with `createRoomSlugFromCrypto`, and inserts a `LIVE` room. Retry the insert up to five times on Postgres unique violation `23505`. The sixth failure is HTTP 500 `slug_exhausted`.
8. `GET /api/rooms/:slug` rejects a slug that fails `/^[A-Za-z0-9]{12}$/` with `room_not_found` and does not query. A missing row is the same error. The response is `RoomResponse`, with `createdAt` in ISO-8601 and `hostDisplayName` from the user row.
9. `GET /api/health` runs `SELECT 1`. It has no guard.
10. Enable CORS for the single configured origin and the methods and headers in the phase contract.
11. Delete the Nest sample controller if the generator created one. The only routes are the four in this section.

**Verification:**

Start Postgres, run the migration, and start the API. Then:

```powershell
curl.exe -s -i http://localhost:4000/api/health

curl.exe -s -i http://localhost:4000/api/sessions/guest -H "Content-Type: application/json" -d "{\"displayName\":\"Ava\"}"

curl.exe -s -i http://localhost:4000/api/sessions/guest -H "Content-Type: application/json" -d "{\"displayName\":\"  \"}"

curl.exe -s -i http://localhost:4000/api/rooms -H "Content-Type: application/json" -d "{\"title\":\"Design review\",\"mode\":\"MEETING\"}"

curl.exe -s -i http://localhost:4000/api/rooms -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d "{\"title\":\"Design review\",\"mode\":\"CLASS\"}"

curl.exe -s -i http://localhost:4000/api/rooms -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d "{\"title\":\"Design review\",\"mode\":\"MEETING\"}"

curl.exe -s -i http://localhost:4000/api/rooms/<slug> -H "Authorization: Bearer <token>"

curl.exe -s -i http://localhost:4000/api/rooms/does-not-exist -H "Authorization: Bearer <token>"

curl.exe -s -i http://localhost:4000/api/rooms -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d "{\"title\":\"Town hall\",\"mode\":\"WEBINAR\"}"
```

Replace `<token>` and `<slug>` with the values just returned. Health is `ok: true`. The blank name is `invalid_display_name`. The unauthenticated create and the bad mode match Section 5.3. The meeting and webinar fetches echo the created fields, `status` `LIVE`, and `endedAt` null. The unknown slug is `room_not_found`.

```powershell
pnpm typecheck
pnpm lint
pnpm --filter @stageflow/shared test
rg -n "socket\.io|ioredis|webrtc|getUserMedia|ffmpeg|hls\.js|passwordHash|password_hash" apps packages -g "!dist/**" -g "!node_modules/**"
```

The search prints nothing.

**Done when:** P1-A04 through P1-A07 pass. A restarted API without `synchronize` still serves a room created before the restart.

**Handoff:** The web slice can call these routes. Room rows are not ended by any route.

**Verification record (2026-10-31):** Nest 11.2.8, TypeORM 1.1.2, @nestjs/typeorm 12.0.2, @nestjs/config 12.0.1, and @nestjs/jwt 12.0.3 run on Node 22.23.2 with NodeNext resolution and CommonJS output. The CLI binary is `typeorm-ts-node-commonjs`; the migration ran successfully, and a second run reported no pending migrations. `pnpm typecheck`, `pnpm lint`, `pnpm --filter @stageflow/api build`, and all 43 shared tests passed. The dev command compiled and started only the four specified routes.

Live HTTP verification passed 46 assertions: health, trimmed guest names, the user UUID, HS256 and the 12-hour token lifetime, meeting and webinar creation and exact fetch responses, named errors for invalid names/titles/modes, missing or invalid tokens, malformed and absent slugs, expired tokens, wrong signing algorithms, invalid UUID subjects, nonexistent users, query-token rejection, and CORS preflight. Startup checks rejected all four missing required keys together and a short JWT secret. A real Postgres collision fixture verified a successful retry and `slug_exhausted` after the sixth insert; those fixture rows were removed. The health outage check returned exactly HTTP 503 `{ "ok": false }` with Postgres stopped; Postgres was restored healthy afterward. The first outage attempt coincided with a watch rebuild and could not connect to the API; the rerun after startup passed. A room created before API restarts remained unchanged and fetchable by another guest. After extracting `BaseEntity`, both modes were created and fetched again with generated inherited IDs/timestamps. A07's source search printed no matches. A04–A07 are verified; browser work remains P1-C04.

Tooling note: Nest CLI 11 pins Webpack 5.106.2, while its current transitive schema-utils declares a newer Webpack peer range. pnpm reports that upstream peer warning. The verified scripts use the TypeScript compiler path rather than Webpack.

## 6. P1-C04 — Home page and room shell

**Status:** committed (A01–A09 verified)\
**Proposed commit message:** `feat(web): create a room and open its shell`\
**Actual commit:** `eb95669`

**Why:** FOUND-02 is demonstrated by a person creating a room and opening it again. Covers P1-A08 and P1-A09.

**Depends on:** P1-C03. The API is running and the migration has been applied.

**Files:**

- `apps/web/package.json`
- `apps/web/tsconfig.json`
- `apps/web/vite.config.ts`
- `apps/web/index.html`
- `apps/web/src/main.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/index.css`
- `apps/web/src/session.ts`
- `apps/web/src/api.ts`
- `apps/web/src/pages/HomePage.tsx`
- `apps/web/src/pages/RoomPage.tsx`
- `apps/web/src/vite-env.d.ts`
- `README.md`
- `pnpm-lock.yaml`
- Delete `apps/web/src/index.ts` when the Vite entry replaces it.

**Implementation:**

1. Add React 19, Vite, React Router, TanStack Query, Zustand, and the current Tailwind release that supports this Vite version. Follow that Tailwind release's Vite setup. `vite.config.ts` sets `envDir` to the repo root and prebundles the linked CommonJS shared package with `optimizeDeps.include`. Use port 5173 with `strictPort` so CORS remains consistent. Include the Vite config in web typecheck and lint.
2. `session.ts` is the Zustand store for `{ token, userId, displayName }`. It reads and writes `sessionStorage` key `stageflow.session`. Corrupt JSON clears the key.
3. `api.ts` reads `import.meta.env.VITE_API_BASE_URL`. It exposes `createGuest`, `createRoom`, and `getRoom`. It sends the bearer token for the room calls. It does not read `VITE_WS_URL`.
4. Build the home page and room page to the behavior in phase Section 5.5. Use the shared parsers before sending. Always mint a new guest on submit. Navigate only after create or a successful join fetch.
5. Router: `/`, `/r/:slug`, and a fallback with a link home. Room data is a TanStack Query keyed by the slug and the current token. The room page renders server fields as text.
6. Style for the phase contract: dark background, light text, labeled controls, visible focus, and the word `Error` on failures. No hero section and no media element.
7. Extend the README with the phase outcome, the copy-`.env` step, `migration:run`, both dev commands, and an explicit list of what this phase does not do: no socket, no camera, no Redis client, no broadcast.

**Verification:**

```powershell
pnpm typecheck
pnpm lint
pnpm --filter @stageflow/shared test
```

With the API already running, start the web app and use it in the browser:

1. Open `/`. The foundation limitation is visible.
2. Create a meeting as `Ava` titled `Design review`. The shell shows that title, `MEETING`, `LIVE`, a 12-character slug, host `Ava`, and the sentence `Foundation build. The green room and video arrive in a later phase.`
3. Reload the room URL. The same room remains.
4. Go home, enter the same slug, and join with a display name. The shell loads that room.
5. Join `zzzzzzzzzzzz`. Stay on `/` and see the not-found message.
6. Open `/r/<that real slug>` in a new tab and confirm it asks for a name instead of calling the API with an empty session.
7. Tab to the home controls and confirm focus is visible.

Record what happened, including any failed step. A screenshot of the shell without those actions does not verify A08 or A09. If no browser tool is available, leave A08 and A09 unverified and say so.

Repeat the A07 search. It still prints nothing.

**Done when:** P1-A01 through P1-A09 are verified. The README can take a clean checkout through compose, migration, and the two dev servers.

**Handoff:** Phase 2 can attach presence to `POST /api/sessions/guest`, `GET /api/rooms/:slug`, and `/r/:slug` without changing their Phase 1 meanings. Do not start that phase in this commit.

**Implementation verification (2026-10-31 / 2026-11-01):** React 19.3.1, Vite 8.3.5, React Router 8.5.1, TanStack Query 5.105.0, Zustand 5.0.16, and Tailwind 4.3.3 are installed and locked. Vite uses the React and Tailwind plugins, the root environment directory, port 5173 with `strictPort`, and explicit prebundling for the linked CommonJS shared package. Web typecheck and lint include `vite.config.ts`. Root `pnpm install`, `pnpm typecheck`, `pnpm lint`, all 43 shared tests, and `pnpm --filter @stageflow/web build` passed. The build emitted a non-failing warning for its 523.97 kB JavaScript chunk (159.48 kB gzip). Compose reports both databases healthy, and migration execution reports no pending migrations. The existing API dev server was reused and the web dev command started successfully. HTTP checks confirmed delivery of the root, a room deep link, and a fallback URL; all app modules transformed successfully; the API module received the root `VITE_API_BASE_URL`. The A07 source search had no matches.

**Browser acceptance (2026-11-01):** A08 and A09 verified in isolated headless Chrome `156.0.8078.74` on Windows using the native Chrome DevTools Protocol. No Playwright or application dependency was added. The earlier verification gap was closed by driving the installed browser through its debugging endpoint. Inputs were filled with browser input events and buttons were clicked through browser mouse events; checks observed the rendered DOM, session storage, URL, and network requests.

1. `/` rendered the home controls and exact foundation limitation sentence.
2. Created `Design review` as `Ava`. `/r/L1fVHRTo6f4I` showed `Design review`, `MEETING`, `LIVE`, the 12 character slug, host `Ava`, and the exact foundation sentence.
3. Reloaded that URL. The same room and stored guest user ID remained.
4. Returned home, changed the display name to `Joining reviewer`, and joined `L1fVHRTo6f4I`. The original room opened, host remained `Ava`, and the guest user ID changed, confirming a new session.
5. Returned home and joined `zzzzzzzzzzzz`. Stayed at `/` and saw `Error: No room exists for that slug.`
6. Opened the real room URL in an independent browser tab. It asked for a name on the home page, had no session in storage, and sent zero API requests.
7. Used actual Tab key events to reach the brand link, display name, title, create meeting, create webinar, slug, and join controls in order. Every control matched `:focus-visible` and had a solid 3px outline. Inspected full-page screenshots of the home, room shell, and focused join button; dark styling, labels, room fields, limitation text, and keyboard focus were visible. No uncaught browser exceptions occurred.

The first browser harness run incorrectly tried to serialize a DOM element as a Boolean and timed out despite the home page rendering. Corrected that observation in the temporary harness; all seven steps passed on the next run. No product code changed. The final A07 source search again had no matches. All phase acceptance IDs are now verified; Phase 1 has exited.

## 7. Phase exit

After P1-C04, the phase contract's Section 7 commands have been run and Section 6 statuses can be updated to `verified` only for IDs whose output was actually seen. Those status lines belong in the P1-C04 commit. The follow-up that records that commit's hash is the `docs(phase1): record the final slice hash` commit from master Section 1.4.
