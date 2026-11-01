# StageFlow

StageFlow is a bounded stage you can demo alone, with the negotiation, the stats, and the broadcast limits made explicit.

Phase 4 adds three demo peers and live connection stats to the WebRTC stage. One browser can run a four-person meeting with real peer connections, canvas video, and pulsing generated audio. People on stage can also share a screen, return to the camera, and leave. Meeting participants and webinar hosts choose devices in the green room before joining. A meeting has at most four stage members, counting the host. Webinar attendees join without device prompts, can raise a hand, and have no peer connection or stage video. Broadcast is not implemented yet.

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

Live presence is server-owned Redis state. Lua enforces stage limits, roles, media flags, and hands atomically; snapshots carry increasing revisions. On startup the API pings Redis and refuses to listen if it is unavailable, then scans and deletes `sf:room:*` only. Catalog rooms and `sf:itest:*` keys stay intact. Host leave/disconnect ends the catalog room and removes its live keys. API process shutdown drops presence without ending catalog rooms. Socket resume is deliberately absent. If Redis closes after startup, live readiness becomes unhealthy, open sockets are disconnected, and the process exits one second later. Clients show the live-room reset and do not reconnect or resume media. Catalog rows are not ended. The API does not reconnect to Redis in-process. Start it again after Redis is reachable; startup still refuses to listen while Redis is down and then deletes `sf:room:*`. Give a supervisor a restart delay so a down Redis does not become a tight restart loop. A PostgreSQL error does not exit the process.

The existing migration creates `users` and `rooms`. Schema synchronization and startup migrations are disabled; Phases 3 and 4 add no migration. Accounts, media-file storage, moderation controls, and broadcasts remain outside this build.

Production builds are `pnpm --filter @stageflow/api build` and `pnpm --filter @stageflow/web build`. The API build copies its Lua assets beside compiled code. Shared and API use CommonJS; web uses Vite and ES modules. After changing shared exports during development, run `pnpm --filter @stageflow/shared build` and restart Vite with `pnpm --filter @stageflow/web dev --force` to refresh its dependency cache. Phase 4 verification and acceptance records live in the [phase contract](plans/phase4.md) and [execution guide](plans/phase4/guide.md). Physical-device and native screen-picker observations still awaiting verification are recorded separately in the [Phase 3 contract](plans/phase3.md) and [guide](plans/phase3/guide.md).
