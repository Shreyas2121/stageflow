# Guide 2 — Phase 2, commit by commit

**Status:** complete. P2-C01 through P2-C04 committed; P2-A01 through P2-A08 verified.\
**Last updated:** 2026-11-01.\
**Phase contract:** [../phase2.md](../phase2.md).\
**Product authority:** [MASTER_PLAN.md](../../../MASTER_PLAN.md) version `1.0.1`.\
**Deliverable:** Redis presence, Socket.IO snapshots, and the green room, in four commits. This is the only Phase 2 guide.

## 1. Execution rules

Read the phase contract before editing code. Phase 1 is the baseline. Planning-time `HEAD` was `20b3fe3`. Recheck the worktree and follow the files that are actually there.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run P2-C01 through P2-C04 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing.
4. After verification, commit that slice under master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash and mark the slice `committed`. That hash line rides into the next slice. The last slice's hash is `docs(phase2): record the final slice hash`.
5. If Redis or a browser cannot be used, leave the related acceptance ID unverified and name the gap.
6. Keep Phase 1 guest create, room create, and room fetch working. Do not add a migration.

Do not construct `RTCPeerConnection`, call `getDisplayMedia`, or register promote, demote, lock, WebRTC, or broadcast socket events.

### 1.1 Commit index

| Order | ID     | Proposed message                                                | Acceptance                        |
| ----- | ------ | --------------------------------------------------------------- | --------------------------------- |
| 1     | P2-C01 | `feat(shared): add stage join and moderation rules`             | A01                               |
| 2     | P2-C02 | `feat(api-redis): apply stage changes with Lua scripts`         | A02                               |
| 3     | P2-C03 | `feat(api-signaling): publish presence snapshots on Socket.IO`  | A03, A07 for the HTTP ended state |
| 4     | P2-C04 | `feat(web-lobby): join from the green room and show the roster` | A04, A05, A06, A07, A08           |

### 1.2 Files to inspect before editing

- `packages/shared/src/contracts.ts` and `contracts.test.ts`
- `apps/api/src/sessions/jwt-auth.guard.ts`, `sessions.service.ts`, and `sessions.module.ts`
- `apps/api/src/rooms/rooms.service.ts`, `room.entity.ts`, and `app.module.ts`
- `apps/api/src/config/env.ts` and `main.ts`
- `apps/web/src/pages/RoomPage.tsx`, `session.ts`, `api.ts`, and `index.css`

## 2. P2-C01 — Stage transition rules

**Status:** committed\
**Proposed commit message:** `feat(shared): add stage join and moderation rules`\
**Actual commit:** `ef4e04bd3501d58536c581f74938f5e109552303`

**Why:** Join caps and roles have to be true in a function before Redis copies them. Covers P2-A01.

**Depends on:** Phase 1 shared package and Vitest.

**Files:**

- `packages/shared/src/stage.ts`
- `packages/shared/src/stage.test.ts`
- `packages/shared/src/index.ts`

**Implementation:**

1. Add the participant, command, error, and live-state types from phase Section 5.2. Export them from `index.ts`. Leave `contracts.ts` on the HTTP types.
2. Implement `applyStageCommand(state, command)` as a pure function. Return a new state. Do not mutate the input.
3. Use the join table in phase Section 5.1 and the reject table in Section 5.2. Stage capacity is 4, counting the host.
4. Canonical output sorts participants by `socketId`, sorts `stageSocketIds`, and orders hands by `raisedAt` then `socketId`.
5. Tests in this commit, with fixed timestamps and no Redis:
   - Host joins an empty meeting and is `HOST` on stage.
   - A second meeting user is rejected with `host_not_present` before that host join, and is a `SPEAKER` after it.
   - Four stage members reject a fifth with `stage_full`, and the state is unchanged.
   - The same user on a new socket is `already_joined`.
   - A webinar guest is an `ATTENDEE`, off stage, before and after the host joins.
   - An ended room rejects join with `room_ended`.
   - Leave of an unknown socket is `ok` and does not request a revision bump. Leave of a speaker removes stage and hand membership.
   - Host leave returns an ended, empty state and `roomEnded: true`.
   - `setHand` works for an attendee and rejects a speaker with `not_attendee`.
   - Promote fills the fourth slot, rejects a full stage, and clears the hand.
   - Demote of the host is `cannot_demote_host`.
   - A locked unmute is `audio_locked` and does not change the state. Clearing the lock still leaves the track muted.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm typecheck
pnpm lint
```

**Done when:** P2-A01 passes and the slice is committed.

**Verification result (2026-11-01):** Shared tests passed (56 tests, including 13 stage cases); workspace typecheck and lint passed. P2-A01 verified.

**Handoff:** Redis does not exist yet. The tests are the oracle for the Lua scripts.

## 3. P2-C02 — Lua scripts and the Redis integration test

**Status:** committed\
**Proposed commit message:** `feat(api-redis): apply stage changes with Lua scripts`\
**Actual commit:** `a0a097e387f172e21968ac703018c5b4c38ba89d`

**Why:** Two Node requests must not lose a mute or admit a fifth speaker. Covers P2-A02.

**Depends on:** P2-C01. Compose Redis is running. The root `.env` has `REDIS_URL`.

**Files:**

- `apps/api/src/live/scripts/*.lua` for join, leave, patch media, hand, promote, demote, and host lock
- `apps/api/src/live/live.repository.ts`
- `apps/api/src/live/live.integration.test.ts`
- `apps/api/package.json`
- `apps/api/vitest.config.ts`
- `apps/api/nest-cli.json` to copy Lua assets into the build
- `pnpm-lock.yaml`

**Implementation:**

1. Add `ioredis` and Vitest to the API. The test script loads the root `.env` with `dotenv-cli` and runs Vitest. Do not add a Nest test harness.
2. Each script receives the key prefix as `KEYS[1]` and the command JSON as `ARGV[1]`. It reads and writes only `{prefix}:rev`, `:participants`, `:stage`, and `:hands`. It refreshes a 86400-second TTL on those keys after a successful change. Use Redis `cjson`.
3. `LiveRepository.apply` calls the matching script and returns the canonical snapshot, including the revision. It does not read a hash into Node, modify it, and write it back.
4. The integration test builds each P2-C01 case in Redis under `sf:itest:{runId}`, runs the script, and expects the pure function's state. It then deletes that prefix. Connect with `REDIS_URL`. A connection failure fails the test. Do not skip.
5. Cover join, leave, patch, hand, promote, demote, and lock, not only one happy path. Include the fifth-join and locked-unmute cases.

**Verification:**

```powershell
docker compose up -d
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** P2-A02 passes against the Compose Redis and the slice is committed.

**Verification result (2026-11-01):** Compose PostgreSQL and Redis are healthy. All 56 shared tests and all 19 API integration tests passed. Every sequential Lua result matched the pure transition function, including rejection/no-op revision behavior and canonical ordering. Additional checks covered TTL refresh, no broadcast key, concurrent joins/promotions into the fourth slot, and concurrent independent media patches. Missing `REDIS_URL` and an unreachable Redis each failed the suite as required. Workspace typecheck and lint passed. API build passed, and the compiled repository loaded all eight Lua assets. No forbidden media API references were found in app/package source. P2-A02 verified. No gateway or startup Redis connection was added.

**Handoff:** Scripts are callable, and no gateway is listening. Startup does not connect to Redis yet.

## 4. P2-C03 — Socket.IO presence

**Status:** committed\
**Proposed commit message:** `feat(api-signaling): publish presence snapshots on Socket.IO`\
**Actual commit:** `9ed55691b815a2d331d5ddc1da865e03355ca470`

**Why:** Two browsers need one server-owned snapshot. Covers P2-A03 and the server half of P2-A07.

**Depends on:** P2-C02.

**Files:**

- `apps/api/src/main.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/sessions/jwt-auth.guard.ts`
- `apps/api/src/sessions/sessions.service.ts`
- `apps/api/src/sessions/sessions.module.ts`
- `apps/api/src/rooms/rooms.service.ts`
- `apps/api/src/live/live.module.ts`
- `apps/api/src/live/signaling.gateway.ts`
- `apps/api/package.json`
- `packages/shared/src/signaling.ts`
- `packages/shared/src/index.ts`

**Implementation:**

1. Add the Socket.IO event types and `RoomSnapshot` to shared. This phase's client events are `room:join`, `room:leave`, `media:state`, and `stage:raise-hand`. Server events are `room:state` and `room:ended`. `broadcast` on the snapshot is `null`. Do not add WebRTC or moderation events.
2. Read `STUN_URL`, `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL` in `env.ts`. Missing STUN is an empty ICE list. A blank TURN URL omits TURN. Startup still requires `REDIS_URL`.
3. Move bearer verification from the guard into `SessionsService` and call it from the guard. HTTP 401 text and status stay the same. Export the service to the gateway.
4. Add Socket.IO through the Nest adapter on the existing HTTP server. CORS origin is `CORS_ORIGIN`. Handshake `auth.token` uses the shared verifier. Reject the connection when the token is bad.
5. On application init, ping Redis and abort listen if the ping fails. Delete keys matching `sf:room:*` with `SCAN`. Leave `sf:itest:*` alone.
6. `room:join` loads the room by UUID from PostgreSQL. Missing and ended rooms use the ack messages in phase Section 5.4. A successful join uses `LiveRepository`, joins the Socket.IO room, and emits `room:state` to that room. The ack includes `selfSocketId` and `iceServers`.
7. `media:state` and `stage:raise-hand` call the repository for that socket's room. Rejected commands do not emit a new snapshot.
8. `room:leave` and `disconnect` share one path. A non-host removal emits `room:state`. Host removal sets `rooms.status` to `ENDED` and `endedAt` to the current time, deletes that room's Redis keys, and emits `room:ended`. Do not delete the room row.
9. Add `RoomsService.end(roomId)` for that update. Keep `create` and `getBySlug` behavior. No migration.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

Start the API. Create a guest and a meeting with the Phase 1 `curl.exe` calls. Fetch the slug and confirm the JSON is unchanged.

Restart the API and fetch that room again. It is still `LIVE`. With `redis-cli`, confirm no `sf:room:*` keys remain from a join made before the restart. A new socket join after restart works.

Join as the host over Socket.IO, then join a second guest. Confirm the second snapshot lists `HOST` and `SPEAKER`. Disconnect the host socket. `GET` the room and confirm `status` is `ENDED` and `endedAt` is set. A further join ack is `room_ended`.

Stop Redis and start the API. The process exits before it listens, and the error names Redis.

**Done when:** P2-A03 passes, host leave persists `ENDED`, and the slice is committed.

**Verification result (2026-11-01):** All 56 shared tests and 19 Redis integration tests passed; workspace typecheck, lint, and API build passed. A temporary native Socket.IO/HTTP harness verified guest/create/fetch response compatibility, unchanged HTTP 401, bad/missing/expired/wrong-algorithm tokens, malformed UUID subjects and absent users, host-first meeting joins, server-assigned roles, duplicate user/socket rejection, invalid payloads, media updates, speaker leave, host disconnect, persisted `ENDED`/`endedAt`, ended join rejection, and Redis room-key deletion. Webinar guests joined before the host and raised/lowered hands in snapshots. Restart removed `sf:room:*`, preserved an `sf:itest:*` sentinel and unchanged PostgreSQL `LIVE` rows, and allowed a fresh join. Empty STUN returned no ICE servers; configured TURN returned its credentials. An unavailable Redis caused nonzero startup exit before listening. P2-A03 and the HTTP/server half of P2-A07 are verified. Initial verification attempts exposed incompatible Nest 12 socket packages (now pinned to the existing Nest 11 major) and a browser-only client's unavailable Node polling transport (temporary harness switched to native WebSocket). No application test harness or dependency was added for these manual checks.

**Handoff:** The web app still shows the Phase 1 shell. `iceServers` are returned and unused.

## 5. P2-C04 — Green room and roster

**Status:** committed\
**Proposed commit message:** `feat(web-lobby): join from the green room and show the roster`\
**Actual commit:** `626722d9334aa157fa40559e5cd0fdeb3bddd49a`

**Why:** This is the phase a person can see: devices, a shared roster, hands, and leave. Covers P2-A04 through P2-A08.

**Depends on:** P2-C03. API and web dev servers can run together. `VITE_WS_URL` is in the root `.env`.

**Files:**

- `apps/web/package.json`
- `apps/web/src/live/signaling.ts`
- `apps/web/src/live/room-store.ts`
- `apps/web/src/live/local-media.ts`
- `apps/web/src/pages/RoomPage.tsx`
- `apps/web/src/index.css`
- `apps/web/src/App.tsx` and `pages/HomePage.tsx` to replace obsolete Phase 1 copy
- `README.md`
- `pnpm-lock.yaml`

**Implementation:**

1. Add `socket.io-client` at the same major version as the API's `socket.io`. Connect to `import.meta.env.VITE_WS_URL` with the guest token in `auth.token`. One socket for the tab.
2. `room-store.ts` keeps the latest snapshot and ignores a revision that is not greater. Clear it on leave and on `room:ended`.
3. `local-media.ts` requests camera and microphone, enumerates devices, draws the preview, and runs the meter. Expose `stop()` that stops every owned track, closes the `AudioContext`, and cancels the meter frame. Speaker changes call `setSinkId` only when that method exists.
4. Replace the room shell with the phase Section 5.5 flow. Keep the Phase 1 session gate and the `GET` room query. Remove the sentence that says the green room arrives later. The new note says video between people arrives later.
5. Meeting joiners and the webinar host cannot join until both permissions succeed. A webinar guest never calls `getUserMedia`. Rejected join shows the ack message and keeps the preview. Mute and camera controls after join send `media:state` and set `track.enabled` from the applied snapshot. Video-off does not call `track.stop()`.
6. Attendees get the hand control. Do not render promote, demote, lock, share, or a remote video element.
7. On leave, `room:ended`, unmount, and an unexpected disconnect, call `local-media.stop()` and tear down the socket. An unexpected disconnect shows `The live room reset. Join again.`
8. Update the README so the run steps include Redis, the socket URL, and the two-browser roster. State that this phase does not connect browsers with WebRTC.

**Verification:**

```powershell
pnpm typecheck
pnpm lint
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
rg -n "RTCPeerConnection|getDisplayMedia|hls\.js|ffmpeg" apps packages -g "!dist/**" -g "!node_modules/**"
```

The search prints nothing.

With the API, web, Postgres, and Redis running, use two browser windows:

1. As Ava, create a meeting, allow the camera and microphone, see the preview and a moving level, and join.
2. As Sam, open that slug, join, and see both names. Ava's row is `HOST`. Sam's row is `SPEAKER`.
3. Sam turns the camera off. Ava's roster shows Sam's video as off. Sam's hardware indicator may stay on.
4. Sam leaves. Ava's roster shows only Ava. Sam's preview is gone, the tracks' `readyState` is `ended`, and the hardware indicator is off when it can be seen.
5. Create a webinar as Ava and join as the host. In the other window, join as a guest. The guest is not prompted for a camera, is an `ATTENDEE`, and raises a hand. Ava sees that hand. There is no promote control.
6. Ava leaves. Sam sees `This room has ended.` Fetching the slug returns `ENDED`.
7. Join a meeting as the host, stop the API, and start it again. The open page says the live room reset and does not restore the roster by itself. Fetching the slug still returns `LIVE`.

Record what happened, including a failed step. A screenshot without these actions does not verify A04–A07. If no browser is available, leave those IDs unverified.

**Done when:** P2-A01 through P2-A08 are verified and the slice is committed.

**Verification result (2026-11-01):** Workspace typecheck and lint, all 56 shared tests, all 19 API Redis integration tests, and API/web production builds passed. The source exclusion search printed no matches. The web bundle retains a non-failing size warning (about 589 kB before gzip). No migration, remote video, peer connection, moderation event, or broadcast handler was added.

**Browser acceptance (2026-11-01):** Verified in installed headless Chrome `156.0.8078.74` on Windows through native Chrome DevTools Protocol, using independent browser contexts and Chrome's fake camera/microphone. No Playwright suite or application test dependency was added. Native media calls, track states, AudioContext states, and meter cancellation were observed through delegating instrumentation. Permissions were granted/denied with DevTools; a physical camera indicator and physical speaker routing could not be observed.

1. Ava created a meeting from the home form. Join was disabled until both camera and microphone succeeded. A real preview frame and a nonzero microphone-meter value were observed. Changing the selected microphone acquired the requested device and ended the previous tracks. Camera/microphone lists were populated. A keyboard Tab reached the next device field with the existing solid 3px focus outline. Green-room and roster screenshots were inspected.
2. Sam opened the slug independently and prepared devices. An attempted join before Ava was rejected with `host_not_present` and kept Sam's live preview. After Ava joined, both pages showed Ava `HOST`, Sam `SPEAKER`, and their own `(You)` marker.
3. Sam turned camera and microphone off. Ava's roster showed `Video off` and `Muted`. Sam's corresponding tracks remained `live` with `enabled: false`. Injecting equal/older revisions into the actual room store left the existing snapshot unchanged.
4. Sam left. Ava's roster dropped Sam. Every owned Sam track became `ended`, all owned AudioContexts became `closed`, the preview was cleared, and the meter frame was cancelled. Three other browser participants filled the four stage slots with Ava. A fifth participant received `stage_full`, retained its live preview, and left the existing roster unchanged. Navigating away stopped that rejected joiner's tracks. Leaving the other participants and navigating Ava home also released their media.
5. Ava created/joined a webinar. Sam joined without a media control, video element, or additional `getUserMedia` call and appeared as `ATTENDEE`. Raise/lower hand changed Ava's roster. There were no promote, demote, lock, or share controls.
6. Ava left. Both pages showed `This room has ended.` Ava's media stopped. HTTP fetch returned `ENDED` with `endedAt`; reloading Sam's page showed ended without a join button.
7. Ava joined a new meeting, then the API process was terminated and restarted. The page displayed exactly `The live room reset. Join again.`, cleared its roster, and stopped tracks/context/meter. The fetched catalog room stayed unchanged and `LIVE`. No automatic rejoin occurred; explicit device preparation and join succeeded after restart.
8. A denied camera and a denied microphone each produced a device-specific `Error` and kept join disabled. A microphone rejection also stopped the camera acquired before it. A browser context with `setSinkId` unavailable showed the default-output note and allowed setup/join readiness. A sessionless direct room URL requested neither room data nor media. The final full run recorded zero uncaught browser exceptions.

Initial attempts and corrections: Calling `setSinkId` redundantly for the already-selected default output caused Chrome to abort setup; the helper now avoids that unnecessary call. A temporary browser assertion initially read local track flags before React's snapshot effect ran; it now waits for the observable flag update. The first permission-denial check used Chrome's automatic fake-permission flag, which overrides denials; the final run removed that flag and used DevTools permission grants/denials. All eight groups passed on the final run. P2-A04 through P2-A08 are verified; the hardware limits above remain explicit.

**Handoff:** Phase 3 can attach a peer connection to each other stage socket. The green room, the snapshot, and track cleanup stay in place.

## 6. Phase exit

Update the phase acceptance statuses to `verified` only for checks that were actually run. Those lines belong in the P2-C04 commit. The follow-up commit is `docs(phase2): record the final slice hash`.
