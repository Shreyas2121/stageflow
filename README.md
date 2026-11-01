# StageFlow

StageFlow is a bounded stage you can demo alone, with the negotiation, the stats, and the broadcast limits made explicit.

Phase 3 connects people on stage with a WebRTC mesh. Two browsers can see and hear each other, share a screen, return to the camera, and leave. Meeting participants and webinar hosts choose devices in the green room before joining. A meeting has at most four stage members, counting the host. Webinar attendees join without device prompts, can raise a hand, and have no peer connection or stage video. Broadcast is not implemented yet.

Use Node 22.22.1 or newer (`.nvmrc` selects Node 22), pnpm, and Docker Desktop with Linux containers. Postgres 16 uses port 5432, database/user/password `stageflow`, and a named data volume. Redis 7 uses port 6379. Both Compose services have health checks.

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

Copy the example only on first setup; keep any existing `.env` values. Keep `.env` out of version control. The root typecheck builds shared output and declarations before checking all three packages. API integration tests load the root `.env`, execute the real Lua scripts against Redis under unique `sf:itest:*` prefixes, and clean up those keys. Missing or unreachable Redis fails the tests.

`pnpm install` installs the Husky pre-commit hook through the root `prepare` script. Each commit runs lint-staged to format staged files with Prettier and restage the results; formatting failures block the commit. Unstaged edits are preserved; if they conflict with formatting, the commit fails and lint-staged restores the original changes. Run `pnpm format` to format the repository or `pnpm format:check` to check it without writing changes. Generated output, the lockfile, local API data, and environment files are excluded. Files use LF line endings on every platform.

Start the API and web app in separate PowerShell terminals at the workspace root:

```powershell
pnpm --filter @stageflow/api dev
```

```powershell
pnpm --filter @stageflow/web dev
```

Open `http://localhost:5173` in current desktop Chrome or Edge. Vite loads the root `.env` and requires port 5173. The API uses `http://localhost:4000/api`; Socket.IO attaches to that same HTTP server at `http://localhost:4000`.

The required environment values are `JWT_SECRET` (at least 16 characters), `DATABASE_URL`, `REDIS_URL`, and `CORS_ORIGIN`. Set `VITE_API_BASE_URL=http://localhost:4000/api`, `VITE_WS_URL=http://localhost:4000`, and `CORS_ORIGIN=http://localhost:5173` for the default setup. Restart the relevant dev server after changing environment values. `STUN_URL` supplies an ICE server; a missing or blank value produces an empty list. A nonblank `TURN_URL` adds TURN with `TURN_USERNAME` and `TURN_CREDENTIAL`. Each stage peer connection uses the ICE servers returned by the API.

To try the meeting in two independent browser windows:

1. As Ava, create a meeting. Click **Enable camera and microphone**, allow both permissions, and check the preview and moving microphone meter. Select the camera, microphone, and speaker before joining. Browsers without speaker selection use their default output. A permission error names the failed device and keeps join disabled.
2. Join the live room. In a second independent window, open the home page, enter Sam and the room slug, enable devices, and join. Each sees the other's camera and hears remote audio; the local tile stays muted. If playback is blocked, click **Play stage audio and video**. Both rosters show Ava as `HOST` and Sam as `SPEAKER`. The host must join a meeting first; a fifth stage member is rejected.
3. As Sam, turn the camera off or mute. Ava's roster flags change and Sam's tile stays mounted. These controls disable captured tracks without renegotiating. Speak to see the **Speaking** border and label; it clears on silence. Click **Share screen** and select a screen or window: the shared tile becomes the large frame. **Stop sharing**, or the browser's own stop control, restores the camera. Screen sharing replaces the video sender track without another offer; the camera stays captured, and an off camera stays off when restored. Cancelling the picker reports an error and leaves the camera in place.
4. Leave as Sam while sharing. Ava's tile and roster entry for Sam disappear. Sam's camera, microphone, and screen tracks stop; peer connections, audio analysis, and video attachments are released. Navigation, room end, and unexpected disconnect use the same cleanup.
5. Create a webinar as Ava. Join as the host. Join that slug as Sam in the other window: Sam needs no device permission, appears as `ATTENDEE`, and can raise/lower a hand visible to Ava. There are no moderation controls in this phase.
6. Ava leaves. The other window shows **This room has ended.** The room remains fetchable with `status: ENDED` and a populated `endedAt`.
7. Join a new meeting, stop the API, and restart it. The open page shows **The live room reset. Join again.** Its local media stops and it does not reconnect automatically. The catalog room stays `LIVE`; explicitly prepare devices and join again.

Guest sessions stay in `sessionStorage` under `stageflow.session`. A new independent tab starts without a session; a direct room URL asks for a name on the home page. Each valid home create/join submission creates a fresh guest session. Room data is fetched with TanStack Query, keyed by slug and token. Display names and titles render as text.

The four HTTP routes remain `POST /api/sessions/guest`, `POST /api/rooms`, `GET /api/rooms/:slug`, and `GET /api/health`. Room calls require a guest bearer token. HTTP and Socket.IO share HS256 verification, UUID subject checks, and a real user lookup. Tokens expire after 12 hours. Health checks PostgreSQL and returns `{ "ok": true }` or HTTP 503 `{ "ok": false }`.

Live presence is server-owned Redis state. Lua enforces stage limits, roles, media flags, and hands atomically; snapshots carry increasing revisions. On startup the API pings Redis and refuses to listen if it is unavailable, then scans and deletes `sf:room:*` only. Catalog rooms and `sf:itest:*` keys stay intact. Host leave/disconnect ends the catalog room and removes its live keys. API process shutdown drops presence without ending catalog rooms. Socket resume is deliberately absent.

The existing migration creates `users` and `rooms`. Schema synchronization and startup migrations are disabled; Phase 3 adds no migration. Accounts, media-file storage, moderation controls, demo peers, connection statistics, and broadcasts remain outside this build.

Production builds are `pnpm --filter @stageflow/api build` and `pnpm --filter @stageflow/web build`. The API build copies its Lua assets beside compiled code. Shared and API use CommonJS; web uses Vite and ES modules. Verification and acceptance records, including physical-device checks still awaiting observation, live in the [phase contract](plans/phase3.md) and [execution guide](plans/phase3/guide.md).
