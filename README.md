# StageFlow

StageFlow is a bounded stage you can demo alone, with the negotiation, the stats, and the broadcast limits made explicit.

Phase 4 adds three demo peers and live connection stats to the WebRTC stage. One browser can run a four-person meeting with real peer connections, canvas video, and pulsing generated audio. People on stage can also share a screen, return to the camera, and leave. Meeting participants and webinar hosts choose devices in the green room before joining. A meeting has at most four stage members, counting the host. Webinar attendees join without device prompts, can raise a hand, and have no peer connection or stage video. Broadcast is not implemented yet.

Use Node 22.22.1 or newer (`.nvmrc` selects Node 22), pnpm, and Docker Desktop with Linux containers. Postgres 16 uses loopback port 5432, database/user/password `stageflow`, and a named data volume. Redis 7 uses loopback port 6379. Compose publishes both only on `127.0.0.1` and includes health checks. Existing running containers keep their current bindings until recreated; this remediation does not restart developer services.

From the workspace root in PowerShell:

```powershell
pnpm install
Copy-Item .env.example .env
docker compose up -d
docker compose ps
pnpm --filter @stageflow/api migration:run
pnpm typecheck
pnpm lint
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/web test
pnpm --filter @stageflow/api test
```

Copy the example only on first setup; keep any existing `.env` values. Keep `.env` out of version control. `pnpm typecheck` checks shared, then the API, then the web app. The API and web `typecheck`, `test`, `build`, and `dev` commands compile `@stageflow/shared` first, including when `packages/shared/dist` is missing. `pnpm dev` watches that package and runs both apps. `pnpm build` builds both apps. `pnpm test` runs shared tests, web tests, then the API suite. `pnpm test:unit` is shared and web. `pnpm test:integration` is the API suite. `pnpm check` runs typecheck, lint, test, both builds, and the format check. API tests load the root `.env`, execute the real Lua scripts against Redis under unique `sf:itest:*` prefixes, and clean up those keys. Missing or unreachable Redis fails those tests. The first dev process owns the shared watcher; stopping it stops shared compilation. A build or test started while that watcher is running reuses its output instead of starting a second compiler.

`pnpm install` installs the Husky pre-commit hook through the root `prepare` script. Each commit runs lint-staged to format staged files with Prettier and restage the results; formatting failures block the commit. Unstaged edits are preserved; if they conflict with formatting, the commit fails and lint-staged restores the original changes. Run `pnpm format` to format the repository or `pnpm format:check` to check it without writing changes. Generated output, the lockfile, local API data, and environment files are excluded. Files use LF line endings on every platform.

`pnpm lint` covers package source, tests, Vite/Vitest configs, the root ESLint config, and tooling scripts. Web lint enforces Hooks ordering and dependencies. Production TypeScript source also checks floating and misused promises with type information; tests and tool configs retain the basic rules. Import rules keep each app separate and shared source independent of app, browser-framework, and Node packages.

Each lint command uses a content cache under its working directory's `node_modules/.cache/eslint`. Workspace TypeScript, JavaScript, manifests, TS configs, or lockfile changes invalidate those caches so imported type changes cannot leave stale lint results. `tsconfig.check.json` in each package writes a separate `node_modules/.cache/typescript/check.tsbuildinfo`; production builds keep their existing configs and emit behavior. To measure a cold check, remove only these cache directories. They contain no credentials and are ignored with `node_modules`.

Start the API and web app together from the workspace root:

```powershell
pnpm dev
```

Or use separate PowerShell terminals:

```powershell
pnpm --filter @stageflow/api dev
```

```powershell
pnpm --filter @stageflow/web dev
```

The API dev command restarts when shared CommonJS output changes. The web dev server compiles `packages/shared/src` directly, so a shared export edit does not need `vite --force` or a cleared dependency cache.

Open `http://localhost:5173` in current desktop Chrome or Edge. Vite loads the root `.env` and requires port 5173. The API uses `http://localhost:4000/api`; Socket.IO attaches to that same HTTP server at `http://localhost:4000`.

The API validates environment configuration with Zod 4 through Nest ConfigModule's native `validationSchema`; its exported typed config uses the same schema. Required values are `JWT_SECRET`, a PostgreSQL `DATABASE_URL`, a Redis/Rediss `REDIS_URL`, and one exact HTTP(S) `CORS_ORIGIN` without a path or trailing slash. `PORT` is an integer from 1 to 65535 and `HOST` defaults to `127.0.0.1`; set a deliberate bind address for a container or remote deployment. Development/test secrets need at least 16 characters. Production rejects known placeholders and requires at least 32 characters; generate at least 32 random bytes and inject the resulting secret through deployment configuration. Do not reuse the example secret. The migration DataSource validates only `DATABASE_URL`, without loading JWT, Redis, CORS, or ICE configuration. API PostgreSQL connection, statement, and client query timeouts are 3, 5, and 6 seconds respectively. These runtime limits are configured separately from the migration DataSource so future DDL is not subject to the API query budget.

To try the meeting on one machine in one browser:

1. Enter a display name, create a **meeting**, enable camera and microphone in the green room, and join.
2. Click **Spawn demo peer** three times. Each demo has its own guest session, socket, canvas camera, and generated microphone. Four tiles appear, and the three demo roster rows have a **Demo** badge. Spawning never requests another device. The button disables while a start is in progress and after three demos. Humans and demos share the same four-person stage cap; a full-stage rejection shows the server message and cleans up the failed demo.
3. Open **Connection stats**. Each remote connection has a row with outbound/inbound bitrate, packet loss, jitter, round-trip time, frame rate, and local ICE type. Stats update once per second; missing values display `—`. The first sample has no rates. ICE type `host` is normal on one machine.
4. Mute your microphone. Each demo emits a short tone every four seconds; a demo's pulse can take the **Speaking** label. If the browser blocks playback, click **Play stage audio and video** in its tile.
5. Click **Remove demo peers**. Their tiles disappear and their tracks, canvas frames, tones, and audio contexts stop. Your camera stays available, and you can spawn again. Leaving, navigating away, room end, or a host disconnect also removes the demos. Leaving stops your camera and microphone too.
6. Create a **webinar**, join as host, and spawn a demo. It stays an attendee with a **Demo** badge, no video tile, and no peer connection. Spawning does not promote it; there are no promotion or demo screen-share controls.

For a meeting with two independent browser windows:

1. As Ava, create a meeting. Click **Enable camera and microphone**, allow both permissions, and check the preview and moving microphone meter. Select the camera, microphone, and speaker before joining. Browsers without speaker selection use their default output. A permission error names the failed device and keeps join disabled.
2. Join the live room. In a second independent window, open the home page, enter Sam and the room slug, enable devices, and join. Each sees the other's camera and hears remote audio; the local tile stays muted. If playback is blocked, click **Play stage audio and video**. Both rosters show Ava as `HOST` and Sam as `SPEAKER`. The host must join a meeting first; a fifth stage member is rejected.
3. As Sam, turn the camera off or mute. Ava's roster flags change and Sam's tile stays mounted. These controls disable captured tracks without renegotiating. Speak to see the **Speaking** border and label; it clears on silence. Click **Share screen** and select a screen or window: the shared tile becomes the large frame. **Stop sharing**, or the browser's own stop control, restores the camera. Screen sharing replaces the video sender track without another offer; the camera stays captured, and an off camera stays off when restored. Cancelling the picker reports an error and leaves the camera in place.
4. Leave as Sam while sharing. Ava's tile and roster entry for Sam disappear. Sam's camera, microphone, and screen tracks stop; peer connections, audio analysis, and video attachments are released. Navigation, room end, and unexpected disconnect use the same cleanup.
5. Create a webinar as Ava. Join as the host. Join that slug as Sam in the other window: Sam needs no device permission, appears as `ATTENDEE`, and can raise/lower a hand visible to Ava. There are no moderation controls in this phase.
6. Ava leaves. The other window shows **This room has ended.** The room remains fetchable with `status: ENDED` and a populated `endedAt`.
7. Join a new meeting, stop the API, and restart it. The open page shows **The live room reset. Join again.** Its local media stops and it does not reconnect automatically. The catalog room stays `LIVE`; explicitly prepare devices and join again.

Guest sessions stay in `sessionStorage` under `stageflow.session`. A new independent tab starts without a session; a direct room URL asks for a name on the home page. Each valid home create/join submission creates a fresh guest session. Room data is fetched with TanStack Query, keyed by slug and token. Display names and titles render as text.

The HTTP routes are `POST /api/sessions/guest`, `POST /api/rooms`, `GET /api/rooms/:slug`, `GET /api/health`, and `GET /api/health/live`. Room calls require a guest bearer token. HTTP and Socket.IO share HS256 verification, UUID subject checks, and a real user lookup. Tokens expire after 12 hours. `GET /api/health` checks PostgreSQL only and returns `{ "ok": true }` or HTTP 503 `{ "ok": false }`. It stays successful when Redis is down, so a database probe must not restart the process. `GET /api/health/live` uses the same response shape for the live Redis session.

Live presence is server-owned Redis state. Lua enforces stage limits, roles, media flags, and hands atomically; snapshots carry increasing revisions. Before clearing any presence, startup pings Redis and acquires a unique non-expiring `<LIVE_NAMESPACE>:owner` guard with `SET NX`. An existing guard prevents listening and prevents cleanup. Startup then clears only `<LIVE_NAMESPACE>:room:*`; catalog rows and independent test/environment keys remain intact. Host leave/disconnect ends the catalog room and removes its live keys. On graceful application shutdown, readiness drops, pending live operations drain, the server closes, and the owner guard is released with a compare-token delete. Unexpected Redis loss still disconnects sockets and exits within one second without ending catalog rooms or reconnecting. A PostgreSQL error does not exit the process. Socket resume remains absent.

Live Redis supports **standalone Redis only**, with one active API owner per namespace. `LIVE_NAMESPACE` accepts 1 to 64 letters, digits, underscores, or hyphens and defaults to `sf_<NODE_ENV>` (`sf_development`, `sf_test`, or `sf_production`); the example explicitly uses `sf_development`. Existing explicit namespaces remain honored. Use separate Redis namespaces and PostgreSQL databases for independent environments: namespacing live state does not isolate catalog rows. The owner guard has no expiry or automatic takeover. After a crash, forced stop, Redis connection loss, or partial startup failure, a surviving guard fails closed. Stop the previous API and its supervisor, confirm that no process can still act for that namespace, inspect that exact owner key, then use an administrative Redis client to remove only `<LIVE_NAMESPACE>:owner` and restart one API. Never remove the guard of a running owner or clear a whole Redis database to recover. If Redis lost the guard during restart, startup can acquire it normally. Configure supervisors to back off on startup failure and alert on a retained guard; this is a deliberate manual recovery policy, not multi-instance failover.

Live scripts receive the five actual Redis key names through `KEYS`. A changed command updates only affected participant fields, stage memberships, and hand entries, then refreshes the existing live-key TTLs and returns one atomic revisioned snapshot. No-ops and rejections retain their revision and TTL policy; a repeated host-ending leave still refreshes the ending intent. Full-roster snapshot reads remain. Scripts normally run with `EVALSHA`; a `NOSCRIPT` miss falls back to `EVAL` to populate Redis's script cache. Other failures are not automatically replayed.

The existing migration creates `users` and `rooms`. Schema synchronization and startup migrations are disabled; Phases 3 and 4 add no migration. Accounts, media-file storage, moderation controls, and broadcasts remain outside this build.

Production builds are `pnpm build`, or `pnpm --filter @stageflow/api build` and `pnpm --filter @stageflow/web build`. Each app build compiles shared first. `pnpm check` is the release gate: it typechecks shared, the API, and web, including API tests, before lint, tests, both builds, and the format check. The API build uses `tsconfig.build.json`, so test files are typechecked but not emitted. Nest still copies the Lua assets beside compiled code. The web build does not run a second typecheck. The room route loads in its own chunk when a room URL renders; the home page does not download that chunk. Shared and the API stay CommonJS; Node loads `packages/shared/dist`. Web production, tests, and the dev server compile the same shared TypeScript source through Vite, so there is no second package export. Phase 4 verification and acceptance records live in the [phase contract](plans/phase4.md) and [execution guide](plans/phase4/guide.md). Physical-device and native screen-picker observations still awaiting verification are recorded separately in the [Phase 3 contract](plans/phase3.md) and [guide](plans/phase3/guide.md).

GitHub Actions runs `.github/workflows/checks.yml` for every pull request, pushes to `main` and `v*` tags, merge queues, manual requests, and a weekly schedule. Pull requests compare against their base commit: web-only edits check/build/test web, API-only edits check/build/test API plus the socket smoke, and shared, package-manifest, root config, or tooling changes select the full release gate. Unknown non-document paths also select the full gate. Docs-only changes run formatting. Renames and deletions retain both affected packages. Pushes, merge queues, scheduled runs, and manual requests always run the full gate. Superseded runs are cancelled. The workflow installs the package-manager version from `package.json`, uses Node 22 from `.nvmrc`, and requires a frozen lockfile. Its only persisted cache is the pnpm package store keyed by platform and lockfile; it does not persist task results, Redis data, `.env`, credentials, media, or application output.

Use `pnpm check:affected --plan --files apps/web/src/App.tsx` to inspect a simulated selection, `pnpm check:affected --plan --base <commit-SHA>` to inspect the Git selection, or omit `--plan` to execute it. With no base or file list it selects the full gate. A missing Git base fails clearly; fetch history or use `--full`. Package scripts build shared before dependent checks. `pnpm test:tooling` verifies selection and the audit policy. `pnpm check:release` runs those tooling tests, `pnpm check`, deterministic artifact checks, and the live socket smoke. `pnpm check:artifacts --api` and `--web` check one output; no flag checks both. API artifacts must omit tests and preserve all eight Lua files byte-for-byte. The Vite manifest must contain the room as a dynamic entry, absent from the home static import graph, with every referenced file present. Raw home/room asset totals are printed; the existing 500 kB warning threshold is unchanged. For comparable release sizes, use `NODE_ENV=production` or a clean CI environment. The example `.env` sets `NODE_ENV=development`, which changes the React code emitted by Vite build.

The CI job starts its own healthy Redis 7 service. Required Redis integration tests and smoke tests fail when Redis is unavailable. No PostgreSQL service is needed: catalog/user repositories are controlled test doubles, while Lua, JWT verification, compiled gateway/service code, and Socket.IO are real. `pnpm smoke:live` loads local Redis configuration through the API package's dotenv command; you can override `REDIS_URL` to use a disposable instance. The harness listens only on a random loopback port, creates unique `sf:itest:smoke:<UUID>:room:*` keys, and deletes only its own keys. It never starts Nest, opens `LiveConnection`, runs migrations, or invokes startup presence cleanup. It checks invalid/unknown-user JWTs, join validation, stage-only SDP/ICE relay, disconnect/rejoin, a catalog-end failure and successful retry, attendee relay denial, and room cleanup. It is a gateway/service transport smoke, not a replacement for Nest bootstrap, PostgreSQL persistence, browser media, or physical-device acceptance.

`pnpm audit:check` runs production and whole-workspace audits. Dependency changes and all full non-PR CI runs invoke it. Production advisories always fail. Only the three C02 development-tooling exceptions in `audit-exceptions.json` are accepted, by advisory ID, package, severity, maintainer, reason, and review date; unknown findings, malformed/network-error reports, and overdue exceptions fail. Review those exceptions by 2026-11-08 and update them only after reassessing the upstream fix and reachability. The workflow can be run manually after an exception or dependency update.

Set `VITE_API_BASE_URL=http://localhost:4000/api`, `VITE_WS_URL=http://localhost:4000`, and `CORS_ORIGIN=http://localhost:5173` for local development. Blank `STUN_URL` disables STUN; otherwise it must use `stun:` or `stuns:`. TURN requires a `turn:`/`turns:` URL, username, and credential together. Restart the relevant server when changing configuration. `.env` and `.env.*` are ignored except the tracked `.env.example`; never commit deployment secrets.

For deployment, terminate TLS at the ingress, use the exact HTTPS frontend origin, and restrict direct API access to the ingress when trusting its forwarding headers. `TRUSTED_PROXIES` is an explicit comma-separated list of proxy IPs, blank by default. Only a trusted immediate peer enables right-to-left `X-Forwarded-For` processing, stopping at the first untrusted hop. Malformed/oversized chains fall back to the immediate peer. Do not use a trust-all proxy setting; the ingress must append or overwrite forwarded addresses correctly. HTTP and sockets share this identity policy. Socket handshakes also enforce the configured origin for WebSocket transport; native clients without an Origin still require a valid guest JWT.

Admission is process-local and configurable. All rate counters have fixed windows (`RATE_WINDOW_MS=60000`) and at most `RATE_KEYS_MAX=10000` identities each. A full counter map rejects new identities until entries expire; it never evicts active counters to admit another identity. HTTP admission runs before JSON parsing and the guest controller, returns 429 with `rate_limited` and `Retry-After`, and leaves GET health probes available. CORS runs before admission so allowed browser clients can read those errors. Guest creation also has a separate in-flight ceiling that stays occupied until its write/sign operation settles, even after the request disconnects. Socket authentication is bounded before user lookup, and command rates are counted by verified user ID across sockets, including invalid payloads. Rejected commands receive `rate_limited` or `server_busy` before queueing; `room:leave` bypasses command rates.

| Setting                     | Default    | Scope                                                     |
| --------------------------- | ---------- | --------------------------------------------------------- |
| `HTTP_RATE_LIMIT`           | 240/window | Network identity, all ordinary API requests               |
| `GUEST_RATE_LIMIT`          | 20/window  | Network identity, guest issuance                          |
| `GUEST_PENDING_LIMIT`       | 64         | Concurrent guest write/sign operations                    |
| `SOCKET_CONNECT_RATE_LIMIT` | 60/window  | Network identity, namespace authentication attempts       |
| `AUTH_PENDING_LIMIT`        | 64         | Concurrent socket authentication lookups                  |
| `SOCKET_EVENT_RATE_LIMIT`   | 600/window | Verified user, all socket commands except leave           |
| `LIVE_PENDING_LIMIT`        | 512        | Normal queued plus running jobs in each socket/room scope |
| `LIVE_PENDING_PER_KEY`      | 32         | Normal jobs for one socket or room                        |
| `LIVE_CLEANUP_RESERVE`      | 128        | Additional cleanup jobs in each socket/room scope         |
| `HTTP_BODY_BYTES`           | 16384      | JSON body bytes                                           |
| `SOCKET_MESSAGE_BYTES`      | 524288     | Engine.IO message bytes                                   |

Cleanup takes priority over waiting normal work at each queue boundary and has separate bounded capacity in both scopes. Repeated leave/disconnect work for one socket coalesces into the active attempt and at most one retry after a failure. In-flight operations finish in order; cleanup does not interrupt an active database/Redis mutation. Exhausting the cleanup reserve is an explicit busy failure, not an unbounded queue or a promise of instant cleanup during dependency stalls. PostgreSQL and Redis I/O timeouts limit ordinary stalls. These are admission budgets, not attendee caps or token expiry rules: the stage still holds four participants and guest JWTs still expire after 12 hours. Future binary broadcast upload endpoints need separate payload/rate policies rather than increasing signaling limits. Before public guest issuance, set budgets for expected shared-network traffic, monitor rejections and guest-row growth, and establish retention and abuse response for persistent guest data.
