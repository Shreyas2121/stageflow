# Phase 2 — Presence and green room

**Status:** complete. P2-C01 through P2-C04 committed; P2-A01 through P2-A08 verified on 2026-11-01.\
**Last updated:** 2026-11-01.\
**Master plan:** `MASTER_PLAN.md` version `1.0.1`, Sections 1.4, 5.2, 5.3, 7, 8, 9.5, and 16 (Phase 2).\
**Execution guide:** [phase2/guide.md](phase2/guide.md). That guide owns P2-C01 through P2-C04. This file owns the rules those commits must satisfy.\
**Requirement IDs:** ROOM-01, ROOM-02 for join, ROOM-03 for live-key deletion only, ROOM-04 for role assignment, LOBBY-01.

## 1. Outcome

Two browsers can enter one live room and see the same roster. The host, and anyone joining a meeting, picks a camera, microphone, and speaker, sees their own preview, and sees a microphone level before they join. A webinar guest joins without a camera prompt, can raise a hand, and appears as an attendee. Nobody gets a peer connection.

Example: Ava creates a meeting and joins from the green room. Sam opens the slug in a second window and joins. Both rosters show Ava as `HOST` and Sam as `SPEAKER`. Sam leaves, and Ava's roster drops Sam. Ava leaves, and Sam sees that the room has ended.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-11-01:

- Phase 1 is complete. `HEAD` is `20b3fe3` (`docs(phase1): verify browser acceptance and close phase`). The worktree is clean.
- Guest sessions, room create, and room fetch work. Tables are `users` and `rooms`. `synchronize` is off. Redis is required in the environment and unused by application code.
- The room page at `/r/:slug` renders the catalog shell and says the green room arrives later.
- Web dependencies do not include `socket.io-client`. API dependencies do not include `ioredis` or Socket.IO.
- Shared contracts live in `packages/shared/src/contracts.ts`. HTTP errors use `ApiException` and `ApiErrorBody`.

Recheck at execution. Phase 1 routes and the session key `stageflow.session` stay as they are. Git follows master Section 1.4: each verified slice is one local commit before the next slice. Do not push.

## 3. Included and excluded

### 3.1 Included

- A pure stage-transition function and its tests, including promote, demote, and host locks.
- Redis Lua scripts for those transitions, plus an integration test that fails when Redis is unreachable.
- A Socket.IO gateway: authenticated join and leave, media flags, hand state, revisioned snapshots, and host-leave ending the PostgreSQL room.
- Startup connects to Redis, pings it, and deletes `sf:room:*`.
- Green room: device choice, local preview, microphone meter, then the live roster.

### 3.2 Excluded

Do not add these in this phase:

- `RTCPeerConnection`, `getDisplayMedia`, tiles of remote video, or active-speaker borders.
- Promote, demote, and host-lock buttons. The rules and Lua scripts exist so Phase 5 can call them. No socket event exposes them yet.
- Broadcast rows, FFmpeg, HLS, demo peers, and the stats drawer.
- Socket resume. A dropped socket leaves the room.
- A new migration. `status` and `ended_at` already exist.

`GET /api/health`, guest session create, and room create/fetch keep their Phase 1 responses.

## 4. Requirement mapping

| ID       | Meaning in this phase                                                                       | What remains later                                                       |
| -------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| ROOM-01  | Join, leave, mute, video-off, and hand state are a Redis snapshot with a revision           | Peer connections and broadcast status                                    |
| ROOM-02  | A fifth meeting joiner is rejected and changes nothing. A webinar guest joins as `ATTENDEE` | Promote and demote, which Phase 5 exposes in the UI                      |
| ROOM-03  | Process start deletes `sf:room:*`. Catalog rows stay                                        | Failing in-flight broadcasts, which needs the broadcast table in Phase 6 |
| ROOM-04  | The server assigns `HOST`, `SPEAKER`, or `ATTENDEE`                                         | Host mute locks in the UI                                                |
| LOBBY-01 | Camera, microphone, speaker, preview, and a live level meter before join                    | In-call device changes, which V1 does not add                            |

## 5. System contracts

### 5.1 Who may join

The catalog `hostId` is the host. The client does not send a role.

| Room           | Joiner                                                        | Result                                                                   |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Any ended room | Anyone                                                        | `room_ended`. No Redis write                                             |
| Any            | Same `userId` already present                                 | `already_joined`. No write                                               |
| Meeting        | The host                                                      | `HOST` on stage, unless the stage already has 4                          |
| Meeting        | Anyone else, before the host is present                       | `host_not_present`. No write                                             |
| Meeting        | Anyone else, after the host, while the stage has fewer than 4 | `SPEAKER` on stage                                                       |
| Meeting        | Anyone else, when the stage has 4                             | `stage_full`. No write                                                   |
| Webinar        | The host                                                      | `HOST` on stage                                                          |
| Webinar        | Anyone else                                                   | `ATTENDEE`, not on stage, even if the host's socket is not connected yet |

`host_not_present` is the rule that keeps the creator's stage slot from being taken before they arrive. Display name, user id, and host identity come from the verified guest and the room row. `isSyntheticBot` is stored from the join payload and grants nothing. Phase 2 has no button that sets it.

Leaving a non-host removes that socket from the participants, the stage, and the hands. Leaving the host sets the PostgreSQL room to `ENDED` with `endedAt`, deletes that room's Redis keys, and emits `room:ended`. A disconnect uses the same leave path. There is no second host.

### 5.2 Pure transitions

`applyStageCommand` in `@stageflow/shared` is the oracle. It takes the current live state plus one command and returns either the next state or an error. It does not read Redis, the clock, or `Math.random`. `joinedAt` and hand timestamps arrive inside the command.

Successful commands that change state ask the caller to increment the revision. Leaving an unknown socket succeeds, changes nothing, and does not increment the revision.

Commands and the failures that must not write:

| Command       | Rejects                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `join`        | `room_ended`, `already_joined`, `host_not_present`, `stage_full`                                                                       |
| `leave`       | Unknown socket is an empty success                                                                                                     |
| `patchMedia`  | Unknown socket. Turning audio on while `hostAudioLocked` is `audio_locked`. Turning video on while `hostVideoLocked` is `video_locked` |
| `setHand`     | A participant who is not an `ATTENDEE` gets `not_attendee`                                                                             |
| `promote`     | Actor is not host (`not_host`), target missing, target is not an attendee, stage already has 4 (`stage_full`)                          |
| `demote`      | Actor is not host, target missing, target is the host (`cannot_demote_host`), target is not a speaker                                  |
| `setHostLock` | Actor is not host, target missing                                                                                                      |

Promote removes that socket from the hands. Demote does not raise a hand. A lock forces the matching mute or video-off flag on. Clearing a lock does not turn the device back on. `patchMedia` may set `isScreenSharing`, and the Phase 2 client never sends that field.

The unit tests include a fifth meeting join, a webinar guest join, promote into the last free slot, promote when the stage is full, demote of the host, and unmute while locked.

### 5.3 Redis

Lua is the only writer. Node passes a command and reads back a snapshot. It does not `GET` a participant, edit it, and `SET` it back.

Keys, with a 24-hour TTL refreshed on every successful change:

| Key                             | Type                                 |
| ------------------------------- | ------------------------------------ |
| `sf:room:{roomId}:rev`          | integer                              |
| `sf:room:{roomId}:participants` | hash of socket id to JSON            |
| `sf:room:{roomId}:stage`        | set of socket ids                    |
| `sf:room:{roomId}:hands`        | sorted set, score = server timestamp |
| `sf:room:{roomId}:broadcast`    | unused in this phase and left absent |

Scripts live under `apps/api/src/live/scripts/` and receive the key prefix as `KEYS[1]`, so tests can use `sf:itest:{runId}` without touching `sf:room:*`. Redis 7 `cjson` encodes the participant JSON.

The integration test loads the real scripts, runs the same cases as the unit tests, and compares the Redis snapshot with `applyStageCommand`. A missing `REDIS_URL`, a refused connection, or a skipped test is a failure of P2-A02. The test deletes its own prefix afterward.

On API startup, `PING` Redis. If that fails, the process exits before it listens. Then `SCAN` and delete `sf:room:*` only. Do not delete `sf:itest:*`. PostgreSQL rooms are unchanged.

### 5.4 Signaling

Socket.IO attaches to the existing HTTP server. The handshake carries the guest JWT in `auth.token`. The gateway uses the same verification as `JwtAuthGuard`: HS256, a UUID `sub`, and a real user row. A bad token never joins a room. Extract that check into one shared method so HTTP and the socket cannot drift. Phase 1 HTTP 401 behavior stays.

`POST /api/sessions/guest` remains the only public mutating HTTP route. `GET /api/health` stays public.

Client to server this phase:

| Event              | Behavior                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `room:join`        | Payload `{ roomId, isAudioMuted, isVideoOff, isSyntheticBot }`. Ack `{ ok: true, selfSocketId, iceServers }` or `{ ok: false, error, message }` |
| `room:leave`       | Same path as disconnect                                                                                                                         |
| `media:state`      | `{ isAudioMuted?, isVideoOff?, isScreenSharing? }`. The client waits for the next snapshot                                                      |
| `stage:raise-hand` | `{ raised: boolean }`                                                                                                                           |

Server to client:

| Event        | Behavior                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------- |
| `room:state` | Full snapshot after every successful change. Clients apply it only when `revision` is greater |
| `room:ended` | `{ roomId }` after the host leaves                                                            |

Do not register WebRTC, promote, demote, lock, or broadcast handlers. `iceServers` is built from `STUN_URL` and, when `TURN_URL` is non-empty, the TURN username and credential. An empty TURN URL means the list contains only STUN. The client stores the list and does not construct a peer connection.

The snapshot matches master Section 7.2, with `broadcast: null`. Participants are ordered by socket id. `stageSocketIds` is sorted. `handSocketIds` follows ascending raise time.

Join looks up the room by its UUID. An unknown id or a slug-shaped id is `room_not_found`. An ended room is `room_ended`.

Ack messages:

| Error              | Message                                               |
| ------------------ | ----------------------------------------------------- |
| `room_ended`       | This room has ended.                                  |
| `already_joined`   | This guest is already in the room.                    |
| `host_not_present` | The host has to join this meeting before anyone else. |
| `stage_full`       | This meeting already has 4 people on stage.           |
| `room_not_found`   | No room exists for that slug.                         |
| `not_attendee`     | Only attendees can raise a hand.                      |
| `audio_locked`     | The host has muted your microphone.                   |
| `video_locked`     | The host has turned off your camera.                  |

### 5.5 Green room and roster

`/r/:slug` still loads the room through `GET /api/rooms/:slug`. An `ENDED` room shows `This room has ended.` and no join button.

Before join:

| Person                             | Devices                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| Meeting joiner, including the host | Camera and microphone are required. A denied permission names which one failed and disables join |
| Webinar host                       | Same as a meeting joiner                                                                         |
| Webinar guest                      | No `getUserMedia`. The page says they will join as an attendee                                   |

The device form lists cameras, microphones, and speakers after permission is granted. The preview uses the selected camera. The meter uses an `AnalyserNode` on the selected microphone and a `requestAnimationFrame` loop. Speaker output uses `setSinkId` when the element has that method. If it does not, show the default output and still allow join.

Join sends the current mute and video-off choices. A rejected join stays on the green room and shows the ack message. Leaving the page, leaving the room, or receiving `room:ended` calls `stop()` on the local camera and microphone tracks, closes the meter `AudioContext`, and cancels the animation frame. Video-off during the call sets `track.enabled` and does not `stop()` the track.

After join, the page shows the roster from the latest snapshot: name, role, muted, video off, and raised hand. The viewer's own row is marked. Attendees get a raise-hand control. People with local tracks get mute and camera controls that send `media:state` and apply `track.enabled` only from the snapshot. The page says `People can see the roster. Video between people arrives in a later phase.` There is no remote video element and no promote button.

A socket drop that is not a local leave shows `The live room reset. Join again.` and returns to the green room after stopping local tracks. The client does not reconnect by itself.

Keep the existing dark page, labels, and visible focus. Error text includes the word `Error`.

## 6. Acceptance matrix

| ID     | Observable result                                                                                                  | Method                                 | Status   |
| ------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | -------- |
| P2-A01 | The pure transition cases in Section 5.2 pass                                                                      | `pnpm --filter @stageflow/shared test` | verified |
| P2-A02 | The same cases through the Lua scripts match the pure function. Redis must be up                                   | API integration test                   | verified |
| P2-A03 | API startup pings Redis and deletes `sf:room:*` without ending PostgreSQL rooms                                    | Restart the API, then fetch the room   | verified |
| P2-A04 | Two browsers show the host and one meeting speaker. One leave updates the other roster. Local tracks stop on leave | Browser                                | verified |
| P2-A05 | The fifth meeting join does not write. A webinar guest is an attendee and is not prompted for a camera             | Integration test and browser           | verified |
| P2-A06 | An attendee hand appears on the host roster. The server assigns the roles                                          | Browser                                | verified |
| P2-A07 | The host leaving ends the room for the other browser, and `GET` returns `ENDED`                                    | Browser and HTTP                       | verified |
| P2-A08 | Web source does not construct a peer connection or call `getDisplayMedia`                                          | Search                                 | verified |

ROOM-01 is A01, A02, A04, and A06. ROOM-02 is A01 and A05. ROOM-03 in this phase is A03 only. ROOM-04 for assignment is A01 and A06. LOBBY-01 is A04.

Verification on 2026-11-01 used Compose PostgreSQL/Redis, live HTTP/Socket.IO checks, and independent headless Chrome 156 contexts with fake camera/microphone and explicit permission grants/denials. All automated checks and browser actions passed. Physical hardware indicators and physical speaker routing were unavailable; track termination, context closure, preview removal, and meter cancellation were observed directly. See the guide's C03/C04 verification records for actions, initial failures, corrections, and limitations.

## 7. Verification commands

From the repo root, after the slices that introduce them:

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
docker compose up -d
pnpm --filter @stageflow/api dev
pnpm --filter @stageflow/web dev
```

Phase 1 regression on the running API: guest session, create meeting, and fetch by slug still return the Phase 1 JSON.

Search from the repo root:

```powershell
rg -n "RTCPeerConnection|getDisplayMedia|hls\.js|ffmpeg" apps packages -g "!dist/**" -g "!node_modules/**"
```

No matches is the pass. `getUserMedia` in the web app is expected.

## 8. Risks

| Risk                                                               | What to do                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| The roster is painted from client-chosen roles                     | Role is assigned only in `applyStageCommand` and Lua                           |
| Node updates a participant hash outside Lua                        | The integration test is the check. A manual `hset` in the gateway fails review |
| Promote buttons appear because the script exists                   | No promote, demote, or lock event is registered                                |
| The preview starts a peer connection "so the next phase is easier" | P2-A08. Store `iceServers` and stop                                            |
| API startup deletes the integration-test keys                      | Startup scans `sf:room:*` only                                                 |
| Host leave deletes the catalog row                                 | Set `ENDED` and `endedAt`. The row remains fetchable                           |

## 9. Exit and handoff

Phase 2 is done when A01–A08 are verified and each slice has been committed under master Section 1.4. Phase 3 may rely on:

- `applyStageCommand`, the Lua scripts, and the `sf:room:{roomId}` keys.
- `room:state`, `room:join`, and `iceServers` on the join ack.
- Local camera and microphone tracks that already exist for stage members, stopped on leave.
- `/r/:slug` as the green room and the roster.

Phase 3 adds peer connections for current stage members. It does not reopen join rules or the green-room permission rules. Do not write `plans/phase3.md` until that work starts.
