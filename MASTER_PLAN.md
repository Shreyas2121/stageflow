# StageFlow — V1 Master Plan

**Product:** StageFlow\
**Document purpose:** Product, architecture, scope, and delivery contract for the portfolio version.\
**Source:** `idea.md`. This document narrows that sketch. On conflict, this file wins.\
**Status:** Phases 1 and 2 complete. Phase 3 implementation committed and verified with test media; physical acceptance remains open. Phase 4 implementation committed and P4-A01–P4-A06 verified with synthetic host devices; P5-C01 is authorized with the physical checks retained as follow-up (Section 16). Phase 5 P5-C01 is verified; P5-C02 through P5-C04 remain planned.\
**Plan version:** `1.0.7`\
**Last revised:** 2026-11-02

**Revision note (1.0.7):** The Phase 5 contract and guide are written. They start no implementation and do not decide the open Phase 3 prerequisite exception. Phase 6 remains unwritten. No moderation endpoint, media path, or acceptance record changes in this revision.

**Revision note (1.0.6):** C20 defines canonical off-stage media flags, join/demotion normalization, rejected activation, and idempotent safe patches. Stage membership and Demo flags retain their existing authority/display roles. No moderation endpoint, attendee cap, capture guarantee, or physical acceptance waiver is added.

**Revision note (1.0.5):** C19 pauses closed-drawer telemetry, bounds each peer read to 800 ms, and defines timestamp/reset semantics while keeping the one-second visible cadence. Mesh connections, media ownership, product phases, and physical acceptance requirements are unchanged.

**Revision note (1.0.4):** C18 makes environment validation, network admission, bounded live queues, and one-owner namespace enforcement explicit. Startup acquires ownership before resetting live presence; graceful shutdown drains work before releasing ownership, and an unclean stop requires confirmed operator recovery. The stage cap, guest JWT lifetime, attendee policy, product phases, and physical acceptance requirements are unchanged.

**Revision note (1.0.3):** Reconcile the completed Phase 4 implementation with the still-open Phase 3 physical acceptance and the unrecorded prerequisite exception. Adopt feature-local media services, affected checks, and behavioral service-regression tests for requested remediation in `review.md`. This documentation revision changes no media behavior and grants no phase-gate waiver. Section 16 records the pending product decision; earlier verification records retain their original scope.

**Revision note (1.0.2):** Schedule the initial offer from the impolite endpoint of a new pair. Repeated Chromium tests exposed ICE transports staying in `new` after simultaneous initial offers and implicit rollback. Both endpoints attach their audio and video tracks before negotiation; subsequent negotiation and all incoming glare decisions still use the shared reducer. This changes initial-offer scheduling in Section 9.2 and preserves RTC-01 through RTC-05 and the mesh media path. Physical microphone, audible output, camera-indicator, and native screen-picker observations remain unverified in the Phase 3 acceptance record.

## 1. How agents must use this document

The chain is:

`idea.md` → `MASTER_PLAN.md` → `plans/phase<N>.md` → `plans/phase<N>/guide.md` → one verified commit at a time.

### 1.1 What to write, and when

Write this master plan once. It is already written. Do not generate every phase file or every guide in advance.

When implementation of phase N is requested, and only then:

1. Read this file and the repository as it actually exists.
2. Write `plans/phase<N>.md`. That file is the contract: outcome, boundaries, invariants, acceptance IDs. It does not contain the implementation sequence.
3. Write one guide, `plans/phase<N>/guide.md`. That file is the only implementation sequence for the phase. It contains every commit for that phase, in order.
4. Implement the next planned slice, run its verification, and commit it before starting the next slice. A later section of the guide is not permission to skip the current one. Section 1.4 is the git rule.

Do not create `guide1.md`, `guide2.md`, and so on for each commit. One commit does not get its own guide. Football-sim used that shape because each guide was one large reviewed commit. StageFlow commits stay smaller, and a separate file per commit makes a later agent treat each slice as a fresh product.

Do not write one guide for the whole product. An agent will mix phases and lose the invariants.

Split `plans/phase<N>/guide.md` into `guide1.md` and `guide2.md` only after that phase has started and the single guide is too long to execute in order. Record the split in `plans/phase<N>.md` first. Leave shared rules in the phase file. Do not pre-split.

Future phases may be outlined only in Section 16 of this file. Do not invent concrete filenames, function bodies, or package versions for a phase whose predecessor has not exited.

### 1.2 Authority

- This master plan overrides `idea.md`, a phase file, a guide, and chat memory.
- A phase file overrides its guide.
- If implementation shows an acceptance criterion is impossible, update this master plan and the active phase file before treating a different behavior as done. Do not quietly redefine success after a check fails.
- Record a cross-cutting change in this file's revision note. Do not leave the real rule only inside a guide.
- Do not implement StageFlow merely because this plan exists. Implementation starts when the user asks for a phase.
- Preserve unrelated changes. Do not claim a command passed without running it. Do not invent commit hashes.
- Resolve ordinary library and file-layout choices inside the contracts below. Ask only when a choice would change a V1 requirement, a media path, or an exclusion.

### 1.4 Git

Git is required from the first implementation slice. `git` must be on `PATH`. If the workspace has no `.git` directory, initialize it at the repo root with `git init -b main` as part of the first slice that gets committed. Do not create a remote, push, or change git config.

A slice is finished only when its verification has passed and that work is in a git commit. The commit uses the proposed message in the guide. Stage the slice's files and the phase and guide status lines that record verification. Do not stage `.env`, secrets, or `apps/api/data`.

Leave `Actual commit` blank in that commit. After it succeeds, write the real hash and set the slice status to `committed`. That hash line rides along in the next slice's commit. The last slice of a phase records its hash in one follow-up commit, `docs(phaseN): record the final slice hash`.

A verified slice with no commit is the first job of the next session. Do not start the following slice until that commit exists.

### 1.3 Change control

Confirmed product decisions and the exclusions in Section 3 require an explicit product decision to change. A tuning value (bitrate, segment length, poll interval) may change inside its stated bound if the phase file records the old value, the new value, and the reason. Tuning does not add features.

Requested maintenance slices in `review.md` Section 8 may proceed independently of outstanding physical observations or gate decisions. Each slice still requires its own verification and commit. The remediation plan does not authorize Phase 5/6 features or close earlier acceptance gaps.

## 2. Product promise

StageFlow is a 4-person WebRTC stage a reviewer can try on one Windows machine. People on stage connect with a raw mesh and the W3C Perfect Negotiation rules. Everyone else watches a host-composited HLS broadcast. Demo peers and a stats drawer make the mesh inspectable without a second person.

The portfolio sentence is: a bounded stage you can demo alone, with the negotiation, the stats, and the broadcast limits made explicit.

V1 is a portfolio system with an honest scale ceiling. It is a finished vertical slice of that system. It is not a production webinar service, and it does not compete with an SFU.

### 2.1 Who it is for

| Person   | What they can do in V1                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer | Create a meeting, spawn three demo peers, watch the mesh and the stats, then leave and see the camera release                          |
| Host     | Create a meeting or a webinar, moderate the stage, start and stop the broadcast                                                        |
| Speaker  | Send and receive stage audio, camera, and one screen share. At most four people are on stage, including the host                       |
| Attendee | Join a webinar with no camera, raise a hand, and watch the live HLS broadcast or the replay. An attendee has no WebRTC peer connection |

### 2.2 Demo script the finished product must support

1. Enter a display name, create a **meeting**, pass the green room, and join.
2. Spawn three demo peers. Four tiles appear. A demo peer's tone briefly wins the active-speaker border.
3. Open the stats drawer and see, per peer, bitrate, packet loss, jitter, round-trip time, and ICE candidate type.
4. Share the screen. The tile switches by replacing the video track. Stats keep updating.
5. Leave. Local camera, microphone, and screen tracks are stopped, and every peer connection is closed.
6. Create a **webinar** in the host window. In a second window, join as an attendee. The attendee sees the roster and no WebRTC video.
7. Spawn demo peers, promote one onto the stage, and start the broadcast. The attendee window plays the live HLS broadcast. Stop it. The same session plays back as a replay.

Steps 1–5 are the Phase 4 demo gate. Steps 6–7 are the V1 gate. Both must work on one machine.

## 3. The V1 scope box

### 3.1 Included ceilings

| Area             | V1 limit                                                                             |
| ---------------- | ------------------------------------------------------------------------------------ |
| Stage            | Host plus speakers, 4 people maximum, counted together                               |
| Meeting          | Every accepted joiner is a speaker. The fifth joiner is rejected                     |
| Webinar          | Host starts on stage. Everyone else joins as an attendee with zero peer connections  |
| Mesh             | Full-mesh `sendrecv` audio and video among current stage members only                |
| Screen share     | One video track per peer, swapped with `replaceTrack`                                |
| Demo peers       | At most 3, created in the host's browser, each with its own socket and guest session |
| Broadcast        | One active broadcast per room, host only, single 720p HLS rendition                  |
| Replay           | The same playlist after FFmpeg exits successfully                                    |
| Accounts         | One-click guest session. Display name plus a JWT                                     |
| Rooms            | Created live. Join by unguessable slug                                               |
| Presence         | Redis. A process restart drops live presence on purpose                              |
| Catalog          | PostgreSQL for users, rooms, and broadcast rows                                      |
| Browsers         | Current Chrome or Edge on Windows desktop                                            |
| Deployment proof | Local Docker for PostgreSQL and Redis, API and web on the host, FFmpeg on `PATH`     |

These are ceilings. Do not add a fifth stage slot, a second video encoding, chat, or an SFU while implementing a phase.

### 3.2 Excluded from V1

- Agora, Daily, LiveKit, mediasoup, or any hosted media SDK.
- An SFU, simulcast, or a mesh edge from a speaker to an attendee.
- Chat, reactions, polls, scheduling, waiting-room admission, and room passwords beyond the unguessable slug.
- Email, password, OAuth, and registered accounts.
- Mid-call camera or microphone device changes. Devices are chosen in the green room.
- Host migration. If the host leaves, the room ends.
- Socket resume and ICE restart. A dropped socket leaves the room.
- Multi-bitrate ladders, LL-HLS, DASH, and server-side RTP mixing.
- Cloudflare R2, S3, and any object-storage adapter.
- TURN as a requirement. STUN is required. TURN is optional configuration.
- Firefox and Safari as acceptance targets.
- A Playwright suite. Media phases are verified in the browser and recorded in the phase handoff.
- Unit tests for React components, Nest controllers, and TypeORM entities.

### 3.3 Changes from `idea.md`

| Sketch                                                 | V1 contract                                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Speakers send WebRTC to every attendee                 | Attendees have zero peer connections. They watch HLS                                                                              |
| Record to disk, then transcode to a VOD ladder         | One live FFmpeg process reads the WebM stream and writes a single 720p event playlist. That playlist is the replay                |
| 720p and 360p, thumbnail required for success          | 720p only. Thumbnail failure does not fail the broadcast                                                                          |
| Upload the ladder to Cloudflare R2                     | The API serves HLS files from local disk                                                                                          |
| Guest accounts and email/password accounts             | Guest sessions only                                                                                                               |
| Chat events                                            | No chat                                                                                                                           |
| Redis hash updates described as atomic                 | Mutations go through Lua scripts. A JSON blob read-modify-write from Node is forbidden                                            |
| `SADD` plus `SCARD` for the 4-slot cap                 | One Lua script decides and writes the stage set                                                                                   |
| WebM chunks appended as they arrive                    | Sequence numbers, in-order accept, duplicate detection                                                                            |
| Camera indicator must go off when video is toggled off | The indicator must go off after **leave**, because leave calls `track.stop()`. Video-off during a call may leave the indicator on |
| Free TURN is part of the happy path                    | The demo is specified for STUN and local loopback                                                                                 |

## 4. Requirement register

An acceptance statement here is mandatory for V1. The phase column is the primary owner.

| ID       | Acceptance statement                                                                                                                                 | Phase   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| FOUND-01 | `pnpm` install, typecheck, and lint run from a clean checkout. PostgreSQL and Redis come up from `docker compose`. Shared types compile in both apps | 1       |
| FOUND-02 | A guest can mint a session and create a meeting or a webinar. The room is fetchable by slug. No password path exists                                 | 1       |
| ROOM-01  | Join, leave, mute, video-off, and hand state survive only in Redis and are readable as one revisioned snapshot                                       | 2       |
| ROOM-02  | Meeting join beyond 4 stage members is rejected and changes nothing. Webinar joiners after the host are attendees                                    | 2, 5    |
| ROOM-03  | API process start deletes live room keys and marks in-flight broadcasts failed. PostgreSQL room rows remain                                          | 2, 6    |
| ROOM-04  | The server, not the client, decides role, stage membership, host mute lock, and broadcast state                                                      | 2, 5, 6 |
| LOBBY-01 | Before join, the user can pick camera, microphone, and speaker, see local preview, and see a live microphone level                                   | 2       |
| RTC-01   | Two peers that offer at the same time converge. The impolite peer ignores the colliding offer. The polite peer accepts it                            | 3       |
| RTC-02   | An ICE candidate that arrives before the remote description is applied in order afterward, and discarded when its offer was ignored                  | 3       |
| RTC-03   | Stage members form a full mesh of `sendrecv` audio and video. A non-stage socket never receives a forwarded description or candidate                 | 3, 5    |
| RTC-04   | Screen share replaces the current video track and restores the camera track when the share ends, without a new offer                                 | 3       |
| RTC-05   | Leaving stops local camera, microphone, and screen tracks, closes every peer connection, and stops meters, recorders, and animation loops            | 3, 4, 6 |
| DEMO-01  | Three demo peers on one page negotiate real peer connections and appear in Redis as stage or attendee members under the same caps as humans          | 4       |
| DEMO-02  | The drawer shows, per peer, outbound and inbound bitrate, packet loss, jitter, round-trip time, frame rate, and nominated ICE type                   | 4       |
| CAST-01  | Only the host starts a broadcast. A second start is rejected. Chunks apply in sequence or are refused                                                | 6       |
| CAST-02  | While the broadcast is live, an attendee plays HLS and still has no peer connection. Stage members keep the mesh if FFmpeg fails to start            | 6       |
| CAST-03  | Stopping a healthy broadcast yields a replayable playlist. A failed FFmpeg run yields `FAILED` and a visible error                                   | 6       |
| QA-01    | Pure tests cover negotiation, stage transitions, chunk acceptance, stats deltas, and the FFmpeg argument list                                        | 2–6     |
| SHIP-01  | The README states the demo script, the mesh ceiling, the HLS delay, the restart policy, and the supported browser                                    | 6       |

## 5. Roles, modes, and the two media paths

### 5.1 Modes

**Meeting.** The creator is `HOST` and occupies a stage slot. Each later joiner becomes `SPEAKER` until four stage members exist. The next joiner receives `stage_full` and is not inserted. There are no attendees and no broadcast in a meeting. Broadcast start is rejected.

**Webinar.** The creator is `HOST` and occupies a stage slot. Every later joiner is `ATTENDEE`, with no stage slot and no peer connection. The host may promote an attendee into a free slot and demote a non-host speaker. Attendees see video only through the HLS broadcast.

The mode is chosen at creation and never changes.

### 5.2 Role rules

| Action                    | Allowed actor      | Result                                                                                                   |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| Raise or lower hand       | Attendee           | Sorted set updated. Speakers and the host are rejected                                                   |
| Promote                   | Host               | Attendee becomes `SPEAKER` if the stage has fewer than 4 members. Otherwise `stage_full` and no write    |
| Demote                    | Host               | `SPEAKER` becomes `ATTENDEE` and leaves the stage. Demoting the host is rejected                         |
| Force mute audio or video | Host               | Sets a host lock on that participant. The target's own unmute is rejected until the host clears the lock |
| Leave                     | Any participant    | Removed from participants, stage, and hands. Host leave ends the room                                    |
| Start or stop broadcast   | Host, webinar only | See Section 11                                                                                           |

Promotion removes that socket from the hand queue. Demotion does not raise the hand.

### 5.3 Media paths

```text
Stage members (max 4)
  browser peer connection mesh
  each pair: sendrecv audio + sendrecv video

Host browser
  canvas + mixed stage audio
  MediaRecorder WebM chunks, in order
        |
        v
API process
  one FFmpeg stdin
  local HLS playlist
        |
        v
Attendees
  hls.js only. No RTCPeerConnection
```

A stage of 4 is six peer-connection pairs. An attendee adds none. That ceiling is the product. Do not "optimize" V1 by sending speakers' tracks to attendees.

## 6. Identity, rooms, and durable data

### 6.1 Guest session

`POST /api/sessions/guest` with `{ "displayName": string }` creates a `User` row and returns `{ token, userId, displayName }`.

- Display name is 1–40 characters after trim. Reject empty names and ASCII control characters.
- The JWT expires in 12 hours. There is no refresh token.
- The socket handshake and every REST call except session creation require the bearer token.
- A demo peer requests its own guest session. `isSyntheticBot` is a display flag, not a privilege.

### 6.2 Room

`POST /api/rooms` with `{ "title": string, "mode": "MEETING" | "WEBINAR" }` creates a live room owned by the caller.

- Title is 1–80 characters after trim.
- Slug is a URL-safe id of at least 10 characters, unique, generated by the server.
- `GET /api/rooms/:slug` returns the room for a logged-in caller. The slug is the capability to join. Do not add a second secret.
- Status is `LIVE` or `ENDED`. Creating a room starts it. There is no scheduled state.
- Host leave sets `ENDED` and `endedAt`. Ended rooms reject new joins.

### 6.3 Broadcast row

One row per broadcast attempt:

| Field                  | Rule                                                 |
| ---------------------- | ---------------------------------------------------- |
| `id`                   | Server UUID                                          |
| `roomId`               | The webinar                                          |
| `status`               | `STARTING`, `LIVE`, `STOPPING`, `READY`, or `FAILED` |
| `playlistPath`         | Relative path under the broadcast data root, or null |
| `errorMessage`         | Null unless `FAILED`                                 |
| `startedAt`, `endedAt` | Set by the server                                    |

`GET /api/rooms/:slug/broadcasts` lists rows for the replay UI. `GET /api/broadcasts/:id` returns one row. Media bytes are not stored in PostgreSQL.

### 6.4 Migrations

Use TypeORM migrations from the first schema commit. `synchronize` is forbidden. The commit that needs a new column carries its migration.

### 6.5 Process restart

On API listen:

1. Mark every `STARTING`, `LIVE`, or `STOPPING` broadcast as `FAILED` with the message `api restarted`.
2. Acquire the configured namespace's owner guard, then delete only that namespace's live room keys (`<LIVE_NAMESPACE>:room:*`). A conflicting owner prevents cleanup and listening.

Clients treat the next socket drop as a leave. The UI says the live room reset and offers a fresh join. Do not rebuild peer connections from Redis after a restart.

## 7. Redis live state

Redis is the live room. PostgreSQL is the catalog. Losing Redis empties presence and must not corrupt the catalog.

The configured namespace defaults to `sf_<NODE_ENV>` and may be explicitly set per environment. `sf:` below is an illustrative prefix. Every successful mutation refreshes a 24-hour TTL on that room's keys.

One active API owns each namespace through a non-expiring `<LIVE_NAMESPACE>:owner` guard, acquired atomically before presence cleanup. Graceful shutdown drops readiness, drains admitted live work, closes the server, and releases only its own token. A crash, failed partial startup, or connection loss can retain the guard. Recovery requires stopping the previous API and supervisor, confirming that owner is gone, and administratively removing only that namespace's guard before starting one replacement. There is no automatic takeover or multi-instance failover. Different environments must use separate namespaces and catalog databases.

Configured HTTP/guest/network authentication rates, per-user socket event rates, pending authentication/guest work, and socket/room queues bound public work. Rejections are explicit HTTP 429/503 or socket `rate_limited`/`server_busy` responses. Leave bypasses event rates, receives reserved queue capacity, and runs before waiting normal work at queue boundaries; active mutations retain their order. These engineering budgets do not introduce an attendee maximum or change the four-member stage or 12-hour guest token lifetime. The README and `.env.example` record deployment defaults, trusted proxy handling, limits, and operator recovery.

| Key                             | Type                                    | Meaning                                              |
| ------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| `sf:room:{roomId}:rev`          | integer                                 | Monotonic revision                                   |
| `sf:room:{roomId}:participants` | hash `socketId → JSON`                  | Presence                                             |
| `sf:room:{roomId}:stage`        | set of socket ids                       | Current stage                                        |
| `sf:room:{roomId}:hands`        | sorted set, score = server timestamp ms | Raised hands                                         |
| `sf:room:{roomId}:broadcast`    | string broadcast id                     | Present only while `STARTING`, `LIVE`, or `STOPPING` |

`ParticipantState` fields: `socketId`, `userId`, `displayName`, `role`, `isAudioMuted`, `isVideoOff`, `isScreenSharing`, `isHandRaised`, `isSyntheticBot`, `hostAudioLocked`, `hostVideoLocked`, `joinedAt`.

**Off-stage media policy (C20):** Off-stage participants advertise `isAudioMuted: true`, `isVideoOff: true`, and `isScreenSharing: false`. Webinar attendee joins normalize their requested flags to this state; the Demo display flag grants no stage access. An off-stage media patch that requests an unmuted microphone, video on, or screen sharing is rejected atomically with `not_on_stage`, preserving state, revision, and TTLs. Empty patches and patches that only reaffirm the off state succeed without a revision/TTL change when already canonical. A safe patch repairs legacy noncanonical off-stage flags as one actual change while preserving identity, hands, host locks, and stage membership. Internal demotion also restores these flags; promotion retains the off state until an on-stage media update, subject to host locks. Stage membership is server-owned and is never granted through media or Demo flags. This metadata policy does not prove capture/transmission, and it adds no public promotion/demotion handler.

### 7.1 Lua is the only writer

Node code loads scripts and passes arguments. It does not `GET` a participant, edit it, and `SET` it back. It does not enforce the 4-slot cap with a separate read.

Each changed transition increments `rev`, refreshes live-key TTLs, and returns the atomic snapshot. The gateway publishes changed snapshots. Successful no-ops and rejected transitions preserve revision and TTLs; rejection returns a stable error code. Host-ending retries retain their separate intent-refresh policy.

Required scripts:

| Script              | Success writes                                                   | Rejects                                                               |
| ------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `join`              | Participant, and stage membership when the mode and cap allow it | `stage_full`, `room_ended`, `already_joined`                          |
| `leave`             | Removes participant, stage, and hand                             | Unknown socket is a no-op success                                     |
| `patchMedia`        | Stage media flags or safe off-stage normalization                | Off-stage activation, locked activation, unknown socket               |
| `setHand`           | Add or remove a hand                                             | Non-attendee                                                          |
| `promote`           | Role and stage                                                   | `stage_full`, target missing, target not attendee, caller is not host |
| `demote`            | Role, stage, and canonical off-stage media flags                 | Target is host or not a speaker                                       |
| `setHostLock`       | Lock flags                                                       | Caller is not host                                                    |
| `tryBeginBroadcast` | Sets the broadcast key if absent                                 | Key already set                                                       |
| `clearBroadcast`    | Deletes the broadcast key                                        | —                                                                     |

The stage-cap decision is a pure TypeScript function with the same cases as the Lua script. Tests hit the TypeScript function. One Redis integration test runs the real `join` and `promote` scripts when `REDIS_URL` is reachable. If Redis is down, that test fails in the phase that owns it. It is not a permanent skip.

### 7.2 Snapshots

After every successful mutation the server emits `room:state` to the room:

```ts
type RoomSnapshot = {
  revision: number;
  roomId: string;
  mode: 'MEETING' | 'WEBINAR';
  status: 'LIVE' | 'ENDED';
  participants: ParticipantState[];
  stageSocketIds: string[];
  handSocketIds: string[]; // ascending raise time
  broadcast: {
    id: string;
    status: 'STARTING' | 'LIVE' | 'STOPPING' | 'READY' | 'FAILED';
    playlistUrl: string | null;
    errorMessage: string | null;
  } | null;
};
```

The client replaces local room state when `revision` is greater than the revision it holds. It ignores an equal or lower revision. Deltas are not part of V1.

The host check uses the participant role stored in Redis, not a `hostId` sent by the client. `hostId` on the PostgreSQL room identifies the creator for catalog queries.

## 8. Signaling

Socket.IO with the shared `ClientToServerEvents` and `ServerToClientEvents` maps. Those types live in `@stageflow/shared`. The API gateway and the web client import them. A payload that is not in the map does not exist.

### 8.1 Client → server

| Event                  | Payload                                                            | Server rule                                                       |
| ---------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `room:join`            | `{ roomId, isAudioMuted, isVideoOff, isSyntheticBot }` plus an ack | Ack `{ ok, error?, selfSocketId?, iceServers? }`                  |
| `room:leave`           | none                                                               | Same as disconnect                                                |
| `media:state`          | `{ isAudioMuted?, isVideoOff?, isScreenSharing? }`                 | `patchMedia`                                                      |
| `webrtc:description`   | `{ toSocketId, description }`                                      | Relay only if both sockets are current stage members of this room |
| `webrtc:ice-candidate` | `{ toSocketId, candidate }`                                        | Same relay rule                                                   |
| `stage:raise-hand`     | `{ raised: boolean }`                                              | `setHand`                                                         |
| `stage:promote`        | `{ targetSocketId }`                                               | `promote`                                                         |
| `stage:demote`         | `{ targetSocketId }`                                               | `demote`                                                          |
| `stage:set-lock`       | `{ targetSocketId, kind: "audio" \| "video", locked: boolean }`    | `setHostLock`                                                     |
| `broadcast:start`      | none                                                               | Section 11                                                        |
| `broadcast:stop`       | none                                                               | Section 11                                                        |

Ack and `room:state` are the result. Do not add a parallel error event for a command that already has an ack, except for server-driven `room:ended`.

### 8.2 Server → client

| Event                  | When                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `room:state`           | After join and after every successful mutation                                                        |
| `room:ended`           | Host left or the room was ended. Payload `{ roomId }`                                                 |
| `webrtc:description`   | Relayed. Payload adds `fromSocketId`                                                                  |
| `webrtc:ice-candidate` | Relayed. Payload adds `fromSocketId`                                                                  |
| `stage:force-mute`     | After a lock is applied. Payload `{ kind: "audio" \| "video", locked: boolean }` to the target socket |

`iceServers` in the join ack is the server's configured list. The client does not hardcode a STUN host. An empty TURN URL means the list contains only STUN.

### 8.3 Relay invariant

`webrtc:*` from or to a socket that is not in the stage set is dropped. Promoting a participant does not replay old signaling. Demoting a participant causes every remaining stage member to close that peer connection. The demoted client closes all of its peer connections.

## 9. WebRTC mesh

`webrtcPeerManager` is a module owned outside React state. React holds remote `MediaStream`s by socket id for rendering. Components do not call `RTCPeerConnection` directly.

### 9.1 When a peer connection exists

Create one connection per other **current** stage socket, and only then. Always add an audio transceiver and a video transceiver, both `sendrecv`, before the first offer, even if the local video track is disabled.

Attendees construct no `RTCPeerConnection`. Promoting an attendee creates connections to current stage members and negotiates. Demotion closes them and sets each tile's `srcObject` to null.

### 9.2 Perfect Negotiation

Compare socket ids with ordinary string order: `isPolite = selfSocketId < remoteSocketId`.

Per peer, keep `makingOffer`, `ignoreOffer`, and `isSettingRemoteAnswerPending`.

For a new pair with no remote description, the polite endpoint waits for the impolite endpoint's first offer. Both endpoints already have their audio and video transceivers and local tracks attached. After that initial scheduling rule, on `negotiationneeded`, if the connection is stable and not already making an offer, set `makingOffer`, call `setLocalDescription()` with no argument, send that local description, then clear `makingOffer` in `finally`.

On a remote description:

```text
readyForOffer = !makingOffer && (signalingState === "stable" || isSettingRemoteAnswerPending)
offerCollision = description.type === "offer" && !readyForOffer
ignoreOffer = !isPolite && offerCollision
```

If `ignoreOffer`, return without touching the connection. Otherwise:

- If the description is an answer, set `isSettingRemoteAnswerPending` around `setRemoteDescription`.
- `setRemoteDescription` performs the rollback for the polite peer. Do not hand-roll a second collision policy.
- If the description is an offer, `setLocalDescription()` and send the answer.
- Flush queued ICE candidates for this description, in arrival order.

On a remote candidate, queue it while `remoteDescription` is null. If `ignoreOffer` is set, ignore the candidate. Otherwise `addIceCandidate`.

These rules are a pure reducer over `{ makingOffer, ignoreOffer, isSettingRemoteAnswerPending, signalingState, remoteDescriptionSet }` plus an inbound description or candidate. Phase 3 tests the reducer with a glare fixture. The browser manager calls the same reducer. Do not fork a second copy of the condition into the class.

### 9.3 Tracks

- Mute and camera-off use `track.enabled`. They do not `stop()` the track and do not renegotiate.
- A host lock forces `enabled = false`. The local control cannot set `enabled = true` while the snapshot says the lock is on.
- Screen share calls `getDisplayMedia`, then `videoSender.replaceTrack(screenTrack)` on every current peer. It does not create an offer.
- `screenTrack.onended` restores the camera track with `replaceTrack` and clears `isScreenSharing`.
- The camera track is kept while the screen is shared so restore does not need a new `getUserMedia`.
- One screen share at a time per participant. A second share request replaces the previous screen track and stops the previous screen track.

### 9.4 Cleanup

On leave, room end, demotion, or page unload:

- `stop()` local camera, microphone, and screen tracks.
- `close()` every peer connection and drop the map.
- Set every video element's `srcObject` to null.
- Close every `AudioContext` created for the meter, active speaker, demo tone, or broadcast mix.
- `cancelAnimationFrame` for demo canvases and the compositor.
- `stop()` an active `MediaRecorder` and stop its upload loop.
- Disconnect demo-peer sockets.

Leaving with the camera indicator still on fails RTC-05. Camera-off during the call is not that test.

### 9.5 Green room

Meeting join and webinar **host** join require a granted camera and microphone. If either permission is denied, join stays disabled and the page says which permission failed. Webinar attendees skip device capture.

Speaker output is chosen with `HTMLMediaElement.setSinkId` when the browser provides it. If it does not, show the default output and continue. Do not block join on `setSinkId`.

Device ids are fixed at join. V1 has no in-call device picker.

### 9.6 Active speaker

An `AnalyserNode` on each playing stage audio track produces a level. The highlighted socket is the highest level at or above `0.08`, held for 300 ms so it does not flicker. Levels below the threshold clear the highlight. This is presentation only. It never writes Redis.

## 10. Demo peers and telemetry

### 10.1 Demo peers

The host clicks **Spawn demo peer**. The page:

1. Mints a new guest session named from a fixed list in `@stageflow/shared` (`Demo Peer 1` through `Demo Peer 3`).
2. Opens a second Socket.IO connection with that token.
3. Draws a 640×360 canvas at 24 fps: name, role, a simple level bar, and a frame counter.
4. Creates a low-gain oscillator pulse every 4 seconds. The pulse exists so the active-speaker highlight moves. Resume the `AudioContext` inside the click handler.
5. Joins through the normal `room:join` path with `isSyntheticBot: true`.

Caps are unchanged. A meeting with a full stage rejects the bot's join. A webinar bot joins as an attendee. The host promotes it like any other attendee. Spawning does not auto-promote.

At most three demo connections exist. The fourth click is disabled. Removing a demo peer runs the normal leave cleanup for that connection.

Demo peers are how a reviewer sees a 4-way mesh. They do not replace the second window in the webinar demo. The attendee window must be a real join with no peer connection.

### 10.2 Stats

While the drawer is open, read `getStats()` once per second for each peer. Closing it stops polling and clears baselines; reopening starts with fresh samples. Each read has an 800 ms deadline. A stalled peer shows unknown values while healthy peers continue; there is at most one outstanding native read per connection, including across close/reopen. Late expired results are ignored. This does not create additional peer connections.

Pure function `deltaStats(previous, next)`:

- Bitrate: `(bytesDelta * 8) / secondsDelta`, outbound and inbound separately. A non-positive interval yields `null`, not a spike.
- Packet loss percent: `lostDelta / (lostDelta + receivedDelta) * 100`. A zero denominator or non-finite/non-positive sample interval yields `null`.
- Jitter from the inbound RTP report.
- Round-trip time from the nominated candidate pair's `currentRoundTripTime`, converted to milliseconds.
- Frames per second from the inbound video report's frame delta.
- ICE type from the nominated pair's local candidate type: `host`, `srflx`, `relay`, or `unknown`.

The collector stores the previous counters outside React and publishes the computed view. Tests feed fixture reports. They do not open a peer connection.

Use finite report timestamps, without mixing in a local fallback clock. Missing, repeated, or backward report times make the row unavailable and clear its baseline; the next valid sample has null deltas. Replaced connections reset baselines even if the socket ID is reused. Decreased aggregate counters yield null for the affected delta, and the current counters become the next baseline.

## 11. Broadcast and replay

The broadcast is the attendee media path. It is also the replay. There is no second transcode job and no upload to object storage.

### 11.1 Who and when

- Webinar only. Meeting start is rejected with `broadcast_not_available`.
- Host only.
- One at a time. `tryBeginBroadcast` fails with `broadcast_active` if the Redis key exists.
- FFmpeg is spawned only after the PostgreSQL row is `STARTING` and the Redis key is set.
- If the binary cannot start, set `FAILED`, clear the Redis key, emit the snapshot. The mesh stays up. This is CAST-02.

### 11.2 Host compositor

An offscreen canvas, 1280×720, draws the current stage video elements at 24 fps.

| Stage count                                 | Layout                                                        |
| ------------------------------------------- | ------------------------------------------------------------- |
| 1                                           | Full frame                                                    |
| 2                                           | Two columns                                                   |
| 3 or 4                                      | 2×2, empty cells stay the background color                    |
| Any, while a stage member is screen sharing | That frame fills the canvas. Other stage videos are not drawn |

Audio: one `AudioContext` mixes current unmuted stage tracks, local and remote, into a `MediaStreamAudioDestination`. Rebuild the graph when the stage set or mute flags change. Disconnect old nodes on rebuild.

`MediaRecorder` uses `video/webm;codecs=vp8,opus`, `videoBitsPerSecond: 2_500_000`, and a 1000 ms timeslice. The first blob is sequence `0` and must be uploaded. It carries the WebM header.

### 11.3 Chunks

`POST /api/broadcasts/:id/chunks` with raw body, header `x-chunk-sequence` as a non-negative integer, and `content-type: application/octet-stream`.

| Rule            | Behavior                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------- |
| Caller          | The host user of that broadcast                                                              |
| Maximum body    | 2_000_000 bytes                                                                              |
| Accept          | `sequence === nextExpected`. Write those bytes to the FFmpeg stdin. Increment `nextExpected` |
| Duplicate       | Same sequence, same SHA-256 already accepted → `204` and write nothing                       |
| Conflict        | Same sequence, different hash → `409`                                                        |
| Future sequence | `409`. V1 does not reorder a window                                                          |
| Client pipeline | Send sequence `n+1` only after `n` returns `204`                                             |
| Client buffer   | Hold at most 8 unsent blobs. Beyond that, stop locally and call broadcast stop with failure  |

The accept decision is the pure function tested under QA-01. The controller uses it.

### 11.4 FFmpeg

`FFMPEG_PATH` defaults to `ffmpeg`. Arguments come from `buildHlsArgs(outputDir)` and include no client string.

Locked output:

- Input is stdin WebM (`pipe:0`), timestamps generated.
- Video: H.264, `yuv420p`, 1280×720, 24 fps, about 2500 kbps, GOP length 96 so keyframes meet the 4-second segment.
- Audio: AAC, 128 kbps, 48 kHz, stereo.
- HLS event playlist, 4-second segments, `independent_segments`, every segment kept, `ENDLIST` written when the process exits.
- Segment files and `index.m3u8` stay inside `{dataRoot}/broadcasts/{broadcastId}/`.

Reject a resolved path that escapes `dataRoot`.

The API writes accepted chunk bytes to that process stdin, in order, and does not start a second FFmpeg for the same broadcast. If FFmpeg exits before stop, mark `FAILED`, clear Redis, and tell the room. Do not restart it. A restart would append a second WebM header to a dead pipe.

Stop closes stdin, waits for process exit, then:

- Exit code 0 and a playlist on disk → `READY`, clear the live Redis key, keep the files.
- Anything else → `FAILED` with the captured stderr tail, capped at 2_000 characters.

After a successful exit, a second short FFmpeg invocation may write `thumbnail.jpg` from the playlist. If it fails, leave `thumbnailUrl` null and keep `READY`.

Expected glass-to-glass delay is about 8–20 seconds because segments are 4 seconds and the player stays a few segments behind the live edge. Do not add low-latency HLS to shrink it.

### 11.5 Playback

The API serves that broadcast directory and nothing above it.

- Playlists: `Cache-Control: no-cache`, MIME `application/vnd.apple.mpegurl`.
- Segments: long cache, MIME `video/mp2t`.
- No directory index.

Attendees, and the replay page, use `hls.js` against the playlist URL in the snapshot. While status is `LIVE` or `STOPPING`, the player follows the live edge. While `READY`, it is a VOD control. `FAILED` shows `errorMessage` and no fake player. Before the first broadcast, the attendee view shows the roster and the sentence that the host has not started the broadcast.

Stage members do not watch HLS of themselves. They keep the mesh tiles.

### 11.6 Disk

V1 keeps the HLS directory after the broadcast ends. It does not keep a second archived WebM. Disk growth is an accepted limitation and goes in the README. Do not add a retention job in V1.

## 12. Repository shape and engineering rules

```text
stageflow/
├── MASTER_PLAN.md
├── idea.md
├── plans/
│   ├── README.md
│   ├── phase1.md                 # written only when Phase 1 starts
│   └── phase1/guide.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docker-compose.yml            # PostgreSQL 16 + Redis 7
├── .env.example
├── packages/shared/
└── apps/
    ├── api/
    └── web/
```

The tree above is the target. A phase may add files only inside its scope. Absence of `apps/` before Phase 1 is expected.

### 12.1 Stack

Resolve current stable versions when the package is introduced, then commit the lockfile. Do not copy version numbers out of `idea.md`.

| Piece     | Choice                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------- |
| Workspace | pnpm                                                                                                  |
| Web       | React 19, Vite, TypeScript, Tailwind, Zustand, TanStack Query, React Router, Socket.IO client, hls.js |
| API       | NestJS 11, TypeORM, PostgreSQL, ioredis, Socket.IO                                                    |
| Shared    | TypeScript types and pure functions with no React and no Nest imports                                 |
| Node      | Current 22 LTS, recorded in the Phase 1 README                                                        |

BullMQ is not used. One broadcast is one child process supervised by the API. A queue would imply a second worker and a retry story V1 has rejected.

### 12.2 Code rules

- `strict: true`. No `any`. Use `unknown` and narrow it.
- Shared enums and socket maps are the only wire contracts.
- Nest gateways and controllers validate and call a service. Role and stage rules do not live in the gateway.
- WebRTC, media capture, signaling, stats, canvas, and `MediaRecorder` belong to feature-local services. For existing live capabilities the destination is `apps/web/src/features/live/services/`, with adjacent `hooks/`, `components/`, and `stores/`. C09 moved them out of `apps/web/src/live/`. Do not scaffold future broadcast services under the live feature.
- Services own mutable media handles and cleanup, and must not import components. Hooks adapt service state for rendering; stores hold session data and live snapshots, not peer connections, tracks, or audio contexts. Cross-feature imports use a small deliberate public surface; shared code stays free of React, Nest, and runtime browser/database dependencies.
- Every media handle named in RTC-05 has a cleanup path in the same commit that creates it.
- Do not add a dependency that exists only to draw the UI for a feature this plan excludes.

### 12.3 Environment

API example keys: `PORT`, `NODE_ENV`, `JWT_SECRET`, `CORS_ORIGIN`, `DATABASE_URL`, `REDIS_URL`, `STUN_URL`, `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`, `FFMPEG_PATH`, `DATA_ROOT`.

Web example keys: `VITE_API_BASE_URL`, `VITE_WS_URL`.

Empty `TURN_URL` is valid. Missing `JWT_SECRET`, `DATABASE_URL`, or `REDIS_URL` fails startup. Missing FFmpeg fails broadcast start and does not fail API startup.

`DATA_ROOT` defaults to `apps/api/data`. That directory is gitignored.

### 12.4 Suggested web ownership

Exact filenames are fixed when the phase guide is written against the repo. These names describe responsibilities, not a requirement to introduce every named store. Existing `LocalMedia` and other live services retain imperative media ownership; Section 12.2 records their destination, and C09 moved them there.

| Area                 | Owns                                             |
| -------------------- | ------------------------------------------------ |
| `useSessionStore`    | Token, user id, display name                     |
| Media UI state       | Selected device ids and local mute intentions    |
| `useRoomStore`       | Last applied snapshot                            |
| `signalingClient`    | One typed socket for the human user              |
| `webrtcPeerManager`  | Peer map, negotiation, ICE queue, replaceTrack   |
| `statsCollector`     | Poll loop and `deltaStats`                       |
| `syntheticBotEngine` | Extra sockets, canvases, tones                   |
| `stageRecorder`      | Compositor, mix, `MediaRecorder`, ordered upload |

## 13. UX map

| Route                  | Behavior                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `/`                    | Display name, create meeting, create webinar, join by slug                                          |
| `/r/:slug`             | Green room, then the room. Attendees and stage members share this route and render different bodies |
| `/replay/:broadcastId` | VOD player for a `READY` broadcast. Other statuses show the status and the error                    |

Room body for a stage member: tile grid, controls (mute, camera, share, leave), participant list, and the stats drawer closed by default. Hosts also see promote, demote, lock, and broadcast controls when the mode allows them.

Room body for an attendee: roster, own hand control, and the HLS region. No camera preview and no share button.

Empty, permission-denied, `stage_full`, `broadcast_active`, and `FAILED` states use a sentence that names the cause. A disabled control does not pretend the action succeeded.

Visual design stays quiet and dark, with readable type and visible focus. Do not spend a phase on a marketing landing page.

## 14. Verification policy

### 14.1 Every commit

From the repo root, the phase guide or requested remediation slice names the exact commands. Use affected checks while iterating:

| Change                         | Required verification                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documents only                 | Prettier on edited documents; validate local links, referenced Git hashes, and status claims. No application build unless code/config also changes                                    |
| Web services or UI             | Build shared first, then web typecheck/lint and relevant existing tests plus service regressions. Changed media behavior also requires the relevant browser acceptance                |
| API lifecycle                  | Build shared first, then API typecheck/lint and relevant service regressions. Lua or live-persistence changes also run real Redis integration tests                                   |
| Shared contracts or algorithms | Shared build/typecheck/lint/tests, both dependent app checks, and affected consumer tests                                                                                             |
| Dependencies or configuration  | Validate frozen installation and affected checks. Workspace tooling, root lint/config, and lockfile changes can affect every package; run both builds for workspace/toolchain changes |
| Merge or release               | Full workspace typecheck/lint/tests/format, both builds, isolated Redis integration, artifact checks, and relevant recorded browser/media acceptance                                  |

Dependent `dev`, `build`, `test`, and `typecheck` commands compile `@stageflow/shared` before they use it (remediation C14). Root `dev`, `build`, `test`, `test:unit`, `test:integration`, and `check` use that order. `pnpm --filter @stageflow/shared build` remains available. Affected package selection is still manual until the CI slice. Docs-only checks cannot substitute for missing product acceptance. Full merge/release verification remains required after the selected remediation sequence.

A commit that adds a pure function includes its tests. A bug fix includes a behavioral regression when it can be reproduced in a service or adapter; existing relevant tests remain part of the gate.

### 14.2 Pure tests worth writing

| Function            | Fixtures must include                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Negotiation reducer | Simultaneous offers, polite accept, impolite ignore, candidate queued before description, candidate dropped while ignoring |
| Stage transitions   | Meeting fifth join, webinar attendee join, promote into the last slot, promote when full, demote host, unmute while locked |
| Chunk acceptor      | Next sequence, duplicate hash, conflicting hash, future sequence, oversize                                                 |
| `deltaStats`        | Normal interval, zero interval, zero packets                                                                               |
| `buildHlsArgs`      | The locked codecs, sizes, and playlist flags. No argument slot is taken from a request body                                |

Do not test component markup.

Behavioral regression tests for parsing, lifecycle services, media adapters, concurrency, failure recovery, and shutdown orchestration are in scope. This includes Nest service behavior with controlled collaborators and browser media services with meaningful fakes; it does not change Section 3.2's exclusions for component, controller, or entity unit tests or a permanent Playwright suite. Keep tests beside their owning services and retain real Redis parity/concurrency coverage for atomic transitions.

Use isolated dependencies and fixtures for destructive startup or failure injection. Do not start another API against developer live Redis, because startup clears presence; do not stop shared containers to simulate an outage. A fake proves its event sequence and assertions, not physical device behavior or browser ICE compatibility.

### 14.3 Redis

Phase 2's exit runs the Lua integration test against the compose Redis. A skip is a failure of that gate.

### 14.4 Browser

Phases that change the green room, the mesh, demo peers, or the player are not done until the agent has performed that phase's demo steps in a browser and written what happened, including a failure. A screenshot of the page is not that check.

If no browser tool is available, say so in the handoff and leave the browser acceptance ID unverified. Do not mark it passed.

### 14.5 FFmpeg

The argument builder test does not spawn FFmpeg. Phase 6's exit also runs one real broadcast of a few seconds with FFmpeg on `PATH` and confirms `ENDLIST` is in the playlist. If the binary is missing, CAST-03 stays unverified and the API-startup behavior in CAST-02 is still testable.

## 15. Security boundaries

- CORS origin is the configured web origin.
- JWT is checked on the socket handshake and on REST.
- Host, stage, and lock decisions use Redis state inside Lua, not a role sent in the event.
- Signaling relay follows Section 8.3.
- FFmpeg arguments and output paths are built from server ids. User title and display name never enter a command line or a filesystem path.
- Broadcast download routes resolve inside `DATA_ROOT` and reject `..`.
- Names are rendered as text.
- Guest slugs are unguessable. That is the only access control on a room.

## 16. Delivery phases and exit gates

Phases are dependency gates. Finish a playable meeting before building the webinar broadcast. Do not start Phase 5 while Phase 4's demo is broken.

**Current delivery state (2026-11-02):** Phases 1 and 2 exited. Phase 3's five slices and hash follow-up are committed through `2a68cf5`, with automated media verification; full exit is open. Phase 4's four slices are committed through `1af2d26`, with its final hash recorded by `b132cc3`. Its own P4-A01–P4-A06 checks passed with synthetic host camera/microphone devices, as recorded in [plans/phase4.md](plans/phase4.md) and its guide. Phase 5 P5-C01 is verified with API service tests and Redis integration; P5-C02 through P5-C04 remain planned. The Phase 6 contract and guide are not written.

**Outstanding Phase 3 observations:** P3-A03 physical microphone input and human audible output; P3-A05 native screen picker and browser stop control; P3-A06 physical camera indicator after leave. The recorded automated checks remain valid within their scope and do not verify these observations.

**Prerequisite exception - authorized 2026-11-02:** The user explicitly authorized proceeding with P5-C01 while P3-A03, P3-A05, and P3-A06 remain open. Preserve Phase 4 and its evidence. These physical-device observations remain required follow-up; this decision does not mark Phase 3 exited or verify the full Section 2.2 early demo gate. This authorization covers P5-C01; later slices retain their own verification gates.

### Phase 1 — Foundation

**Goal:** A reviewer can mint a guest session and create a meeting or a webinar, and both apps typecheck against shared contracts.

**Deliver:** pnpm workspace, compose file for PostgreSQL and Redis, base TypeScript config, env examples, user and room migrations, guest session, room create and fetch, home page that can create and open a room route. The room route may be an empty shell.

**Exit gate:** FOUND-01 and FOUND-02. A created slug loads the shell. No socket, Redis presence, or media code is imported yet.

**Depends on:** Local Docker, Node, and pnpm.

### Phase 2 — Presence and green room

**Goal:** A second browser can join and see the roster update, with devices chosen before join.

**Deliver:** Lua scripts, snapshot emit, join and leave, green room preview and meter, participant list. Meeting cap and webinar attendee assignment work on the server. No `RTCPeerConnection` yet.

**Exit gate:** ROOM-01, ROOM-02 for join, ROOM-04 for role assignment, LOBBY-01, and the stage-transition tests. Two browsers see join and leave. Redis integration test passes.

**Depends on:** Phase 1.

### Phase 3 — Meeting mesh

**Goal:** Two to four people in a meeting see and hear each other, share a screen, and release the camera on leave.

**Deliver:** Negotiation reducer, peer manager, tiles, active speaker, `replaceTrack` screen share, cleanup. Fifth joiner still rejected. Webinar attendees still have no peer connection; their page stays the Phase 2 roster.

**Exit gate:** RTC-01 through RTC-05 for a meeting, including a glare unit test and a two-browser call. Screen share does not renegotiate.

**Depends on:** Phase 2.

### Phase 4 — Demo peers and stats

**Goal:** One browser can show a four-way stage and the stats drawer.

**Deliver:** `deltaStats`, the drawer, the demo-peer engine, spawn limit 3.

**Exit gate:** DEMO-01 and DEMO-02, demonstrated with three bots. RTC-05 still holds after the bots are removed. This is the early portfolio gate.

**Depends on:** Phase 3.

### Phase 5 — Webinar moderation

**Goal:** The host can move an attendee onto the mesh and back off it, and the attendee never keeps a peer connection while off stage.

**Deliver:** Hand queue, promote, demote, host locks, client connection create and destroy on role change. Attendee view names the missing broadcast without a player.

**Exit gate:** ROOM-02 and ROOM-04 for moderation, RTC-03 for "no relay to attendees," shown with a host window and an attendee window. Broadcast buttons may be visible and must report `broadcast_not_available` until Phase 6 wires them. Do not fake a video element.

**Depends on:** Phase 4.

### Phase 6 — Broadcast, replay, and the README

**Goal:** The attendee window plays the host's composite live, then plays the replay. The README can stand alone.

**Deliver:** Compositor, ordered uploader, chunk acceptor, FFmpeg supervisor, HLS serving, player, replay route, restart failure handling, README limitations.

**Exit gate:** CAST-01, CAST-02, CAST-03, ROOM-03, SHIP-01, and the Section 2.2 demo script. A missing FFmpeg binary fails the broadcast and leaves the mesh usable.

**Depends on:** Phase 5 and a local FFmpeg binary for the full gate.

## 17. Contracts for the phase file and the guide

### 17.1 `plans/phase<N>.md`

Write it against the repository at the start of the phase. Include:

1. Status, date, master version, and the requirement IDs owned.
2. Outcome, as one action a person can perform and what they observe.
3. Entry prerequisites, including the previous phase's real exit evidence.
4. Included work and excluded work. Repeat the exclusions that this phase is most likely to violate.
5. System contracts: new endpoints, socket events, Redis scripts, state fields, and cleanup. Reference master sections instead of copying the whole plan.
6. Acceptance matrix: ID, observable result, test or browser method, status.
7. Verification commands that exist, or that this phase creates.
8. Risks that would silently break an earlier phase.
9. Exit handoff: what the next phase may rely on.

The phase file does not list step-by-step code. That is the guide.

### 17.2 `plans/phase<N>/guide.md`

One sequence, about four to six commits, fewer if the phase is smaller. Each commit stays reviewable and leaves typecheck, lint, and existing tests passing.

Start with the commit index, then one section per commit:

```markdown
### P<N>-C<nn> — <behavior>

Status: planned | implemented | verified | committed
Proposed commit message: <type>(<area>): <outcome>
Actual commit: <hash after it exists>

Why:
Depends on:
Files:
Implementation:
Verification:
Done when:
```

A guide edit is not an implementation commit. If the code has to diverge, update the remaining guide before continuing. Do not rewrite a committed slice to pretend the original text was executed.

### 17.3 Commit discipline

- Each commit has one behavior a reviewer can name.
- Tests for a pure function land in the commit that adds the function.
- Do not add a production flag whose only purpose is to make a test pass.
- Do not start the next phase's feature in the last commit of this one.
- After the slice verifies, commit it as Section 1.4 describes. Writing a plan or guide without being asked to implement does not by itself create a commit.

### 17.4 Prompt for the next planning step

Use this when Phase 1 implementation is requested. Do not use it to generate Phases 2–6.

> Read `MASTER_PLAN.md` version 1.0.0. Write `plans/phase1.md` and `plans/phase1/guide.md` only. Inspect the repository first. Phase 1's outcome is FOUND-01 and FOUND-02. Do not add Socket.IO, Redis presence, WebRTC, FFmpeg, or a broadcast module. Do not implement code unless implementation was also requested.

## 18. Definition of done

V1 is done when all of the following are true:

- [ ] Section 2.2 can be performed on one Windows machine with Chrome or Edge.
- [ ] Every ID in Section 4 has an implementation location and a verification note.
- [ ] A meeting never opens a fifth stage slot or a peer connection to a non-stage socket.
- [ ] A webinar attendee can watch a live broadcast and a replay without a peer connection.
- [ ] A broadcast failure is visible and does not drop the stage mesh.
- [ ] Leave stops the camera track.
- [ ] API restart clears live presence, fails in-flight broadcasts, and leaves past `READY` replays playable.
- [ ] The README states the 4-person mesh ceiling, the HLS delay, the restart policy, STUN-only networking, local disk, and the supported browser.
- [ ] The repo contains no secrets, no filled `.env`, and no broadcast media.

## 19. Risks

| Risk                                                             | Contract that contains it                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| The project becomes another Nest CRUD app with a video tag       | Phase 4 is a demo gate. Do not start the broadcast until the bots and the drawer work |
| Attendees are added to the mesh "temporarily"                    | RTC-03 and Section 5.3. A stage member's peer count equals other stage members        |
| Redis updates lose a mute or a role                              | Section 7.1. Lua is the only writer                                                   |
| Chunk uploads corrupt the WebM stream                            | Section 11.3. One in-flight chunk, sequence checked again on the server               |
| FFmpeg becomes a second product (ladder, R2, queue, retries)     | Section 11. One process, one rendition, fail instead of retry                         |
| The camera light stays on after leave                            | RTC-05 requires `track.stop()` on leave                                               |
| Agents write all six guides up front and then follow stale paths | Section 1.1                                                                           |
| Scope returns through the sketch                                 | This file overrides `idea.md`                                                         |

## 20. Resolved decisions

- **Portfolio shape:** A solo-demo mesh plus an HLS attendee path. Confirmed by the planning review on 2026-10-31.
- **Guide shape:** One phase contract and one multi-commit guide, written at the start of that phase. Confirmed in the same review.
- **Accounts:** Guest JWT only.
- **Scale:** Four stage peers. Attendees are not WebRTC endpoints.
- **Broadcast storage:** Local disk beside the API.
- **Restart:** Live presence is disposable. Catalog rows and finished playlists are not.
- **Supported browser:** Current Chrome or Edge on Windows.
- **Git:** Required. Each verified implementation slice is one local commit before the next slice starts. Confirmed 2026-10-31. No push unless the user asks.

Unresolved items are phase-local and must not block later writing of this plan: exact package versions, the visual spacing of the grid, and the wording of error sentences. They are settled in the phase that first needs them.
