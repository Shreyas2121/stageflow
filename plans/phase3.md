# V2 Phase 3 — Bounded reconnect

**Status:** in progress. V2P3-C01 and V2P3-C02 are committed and V2P3-C03 is implemented; verification and the remaining browser gaps are recorded in the execution guide. V2P3-C04 has not started.\
**Last updated:** 2026-11-04.\
**Master plan:** `MASTER_PLAN_V2.md` version `2.0.0-draft.4`, Sections 1, 5, 8, 10, 11, and 12 (REC-01 through REC-05). Unchanged mesh, lock, device, and broadcast rules stay in `MASTER_PLAN.md` version `1.0.9` and in the V2-P2 contract.\
**Execution guide:** [phase3/guide.md](phase3/guide.md). That guide owns V2P3-C01 through V2P3-C04. Those ids are not the V1 commits in [V1/phase3/guide.md](V1/phase3/guide.md). This file owns the rules those commits must satisfy.\
**Requirement IDs:** REC-01, REC-02, REC-03, REC-04, REC-05.

## 1. Outcome

A person who is already in a room keeps the same membership when the signaling socket drops for a short time. The stage slot stays reserved. Role, host locks, hand position, and join order stay with that membership. The room does not gain a second copy of that person. When the same page connects again in time, media stays off until that person turns a device on. A drop that lasts too long, an explicit leave, or a host whose grace runs out ends the membership the way a leave does today.

Example: Ava is in a meeting with Sam. Ava's socket drops. Sam sees Ava muted and video-off, and Sam's peer connection to Ava closes. The stage still counts Ava, so a fifth person is rejected. Ava's page shows that it is reconnecting. Her camera and microphone stop. Within the grace period her page binds a new socket to the same membership. Sam builds a new peer connection. Ava's microphone stays off until she turns it on. She does not appear twice. If she is gone longer than the grace period, the slot is released and the page tells her to join again.

`LIVE` catalog status is still not presence. This phase does not change the room list.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-11-03. `HEAD` is `44a10de50a0bdf69f931e6cf057139b8c1ab82d8` (`docs(v2-phase2): record the final slice hash`). `MASTER_PLAN_V2.md` and `plans/phase1.md` already had uncommitted pointer edits. This planning change adds this phase and updates the V2 pointers. Recheck the worktree at execution.

V2-P1 slices V2P1-C01 through V2P1-C05 are committed. The browser checks for WS-01 through WS-03, and the WS-03 smoke, remain unverified. V2-P2 slices V2P2-C01 through V2P2-C06 are committed. The two-window device pass and the playback speaker pass were not run. V1 physical observations P3-A03, P3-A05, and P3-A06 remain open. This phase does not record those gaps as passed.

Observed in that tree:

- `ParticipantState` is keyed by `socketId`. `LiveState.stageSocketIds` and `hands[].socketId` use that same id. `RoomSnapshot` projects `stageSocketIds` and `handSocketIds`. `JoinAck` returns `selfSocketId`. Relay requests use `toSocketId`. Roster rows, the peer map, stage video elements, active speaker, and demo peers use that id.
- Redis room keys from `liveKeys` are revision, participants, stage, hands, ending, and broadcast, in that order. `KEYS[6]` is the broadcast lock. `common.lua` loads every participant on each command. Participants sort by `socketId`, matching `applyStageCommand`. `scripts/check-artifacts.mjs` expects 11 Lua files and a key list of length 6.
- `SignalingGateway.handleDisconnect` calls `leave` unless the process is shutting down. Host leave stops the broadcast through `BroadcastsService.stopRoom`, then ends the catalog room and deletes the room keys. A clean FFmpeg stop can still become `READY`. Guest disconnect deletes that socket's participant hash field. `scripts/smoke-live.mjs` waits for that deletion and then joins a new socket. A later host disconnect in that smoke expects the catalog room to become `ENDED`.
- The web client opens Socket.IO with `reconnection: false`, `forceNew: true`, and `autoConnect: false`. `finishDisconnect` tears the session down and shows `The live room reset. Join again.` Page hide uses `teardownLocal` and does not wait for leave, stop, or upload acknowledgements. Pageshow stays in the lobby.
- `teardownLocal` and `onDemoted` both increment `RoomSession.generation` before `media.stop`. That cancel is the one an in-call replacement already observes. Each peer has one audio sender and one video sender. `replaceDevice` does not call `prepare`.
- Startup that owns the namespace marks in-flight broadcasts `FAILED` with `api restarted` and clears that namespace's `room:*` keys. Catalog rows stay. There is no resume credential, no grace timer, and no second participant id.
- Demo peers are separate guest sockets. Removing them closes those sockets, which the server currently treats as leave. The parent also stops them on leave, room end, disconnect, and page hide.
- Webinar attendees have no peer connection. The host client is the compositor. `stopRoom` is the graceful stop. `failInFlight` is the restart failure. A chunk after stop is rejected as `broadcast_not_active`.

Recheck at execution. Git follows V1 master Section 1.4. API tests need a reachable Redis and clean up only their `sf:itest:*` keys. A missing browser leaves the browser half of REC-01 through REC-05 unverified. A missing physical microphone, speaker, camera, or native screen picker leaves that observation unverified. Neither gap authorizes a fifth stage slot, a second peer connection, or `restartIce`.

## 3. Included and excluded

### 3.1 Included

- A server-issued participant id that survives a new socket.
- Unexpected human socket loss enters suspension for 20 seconds. The stage reservation counts toward the cap of four.
- One resume credential, held in page memory, with a server-side verifier.
- A connection generation. Commands from an older binding do not mutate the room.
- Resume of the same role, locks, hand position, and `joinedAt`, with media off.
- Fresh peer connections only between connected stage members.
- Expiry of an overdue reservation, including when a timer is late.
- Host transport loss fails the in-flight broadcast. Host grace expiry or an explicit host leave ends the room.
- A non-host suspension leaves the host broadcast running without that source.
- Disposal of demo memberships when the host suspends, and on any demo socket loss.
- README text for these limits.

### 3.2 Excluded

These are the exclusions this phase is most likely to violate. V2 master Sections 3.2, 8.3, and 9 still apply.

- Chat, chat history, or a chat pause control.
- `restartIce`, ICE-only recovery, seamless media continuity, or a network handoff.
- Resume after tab refresh, browser restart, guest-token expiry, API restart, Redis presence reset, or from another device.
- Persisting the resume credential in `sessionStorage`, `localStorage`, logs, or a room snapshot.
- A fifth stage slot, an extra peer connection, or an extra audio or video transceiver.
- Automatic camera, microphone, or screen-share recovery. Enabling a device stays an explicit action and still obeys host locks.
- Turning a host's interrupted broadcast into `READY`, or appending a resumed recorder to that attempt.
- Host transfer, automatic promotion, or a demo that keeps the room or the broadcast alive.
- Accounts, scheduling, and a new recording format.
- Closing P3-A03, P3-A05, P3-A06, or the unverified V2-P1 and V2-P2 browser and smoke checks.
- A Socket.IO `reconnection: true` buffer. A new attempt uses a new socket and does not replay SDP, ICE, media, or moderation from the old one.

## 4. Requirement mapping

| ID     | Meaning in this phase                                                                                                                                                                                       | What this phase does not claim                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| REC-01 | Resume within grace returns the same participant id, role, locks, hand position, `joinedAt`, and stage reservation, with one current socket and a higher generation                                         | Resume after refresh, restart, or token expiry        |
| REC-02 | A suspended stage member counts toward four. Concurrent resume, expiry, join, and demotion leave one row and at most four stage ids. A stale socket cannot signal or moderate                               | A second identity keyed by socket id                  |
| REC-03 | Local capture, screen share, meters, demos, and the upload producer stop when this page detects the drop. Resume stays muted and video-off until an explicit device action. Screen share stays off          | `restartIce` or a track that keeps flowing            |
| REC-04 | Unexpected host loss keeps the catalog room `LIVE` until grace expiry or an explicit leave. Explicit host leave still ends it immediately. API restart still fails in-flight broadcasts and clears presence | A host reservation that survives process restart      |
| REC-05 | A suspended non-host leaves the current broadcast `LIVE` and drops out of the mix. Host suspension fails that attempt. A later chunk cannot revive it. A new attempt starts only from the existing control  | An uninterrupted replay across the host's socket loss |

## 5. System contracts

### 5.1 Identity

`participantId` is a UUID issued by the server when the membership is created. It is the participants-hash field, the stage-set member, and the hand-zset member. `socketId` is only the current transport. A suspended human has `socketId: null`. JSON uses null, not an omitted field.

The snapshot fields are `stageParticipantIds` and `handParticipantIds`. Hands keep `raisedAt`. Participants, stage ids, and equal-time hands sort by `participantId`, in the same order in `applyStageCommand` and Lua. Do not sort a resumed member by the new socket id.

`RoomSnapshot`, relay payloads, moderation targets, the peer map, roster keys, stage video elements, the active-speaker id, and demo identity use `participantId`. The server resolves a connected participant to its current socket through a transports hash and emits to that socket. The transports hash is `socketId` to `participantId`. It is not part of the snapshot.

Each room's key list stays one list for every script. Order: revision, participants, stage, hands, ending, broadcast, transports, resume, deadlines. `KEYS[6]` remains the broadcast lock. `deleteRoom` deletes the whole list. Startup still clears only this namespace's room keys, and it still does not resume an old presence.

The join acknowledgement returns `participantId` and the resume credential. It does not return a socket id as the membership id.

### 5.2 Resume credential and generation

The credential is 32 random bytes, encoded as base64url without padding. The server stores only its SHA-256 hex digest in the resume hash, keyed by `participantId`. The raw value is returned once, to the joining socket. It is held in page memory for that live page. It is not written to `sessionStorage` or `localStorage`, not logged, and not copied into a snapshot or a participant record.

The credential authorizes `room:resume` only while that membership is suspended, the guest JWT is still valid, and the token's user id is the participant's user id. Leave, expiry, and room end delete the verifier. A connected membership rejects resume with `already_connected` and keeps the current socket. Two racing resumes bind one socket. The loser receives `resume_lost`.

`connectionGeneration` starts at 1 and increments on a successful resume. The server remembers the generation on the socket that just bound. Every later command from that socket, including relay, media, moderation, broadcast, and leave, must match the current generation. A mismatch returns `stale_transport` and changes nothing. Resume rotates nothing about the role. The credential itself stays until leave or expiry.

Synthetic bots do not receive a resume credential.

### 5.3 Suspension, expiry, and leave

`RECONNECT_GRACE_MS` is `20000` in shared limits. The server grace starts when this process handles the unexpected disconnect. The client shows recovery when its own socket drops. Those clocks differ. The server deadline is the one that frees the slot.

An unexpected disconnect of a human who is the current transport calls suspend, on the same per-room queue and cleanup reserve as leave. Suspend sets `presence` to `suspended`, clears the socket and the transports entry, sets `isAudioMuted` and `isVideoOff` to true, sets `isScreenSharing` to false, and writes the deadline into the room's deadline zset. Role, locks, `joinedAt`, `participantId`, and a raised hand stay. A stage member stays in the stage set and still counts toward four. A suspended member is not a signaling peer.

Explicit `room:leave`, a delivered host leave, room end, and process shutdown do not suspend. Host leave still ends the catalog room immediately. Page hide, route exit, and component disposal set the page to not resume and use the existing teardown. If that leave packet is lost, the server may suspend until grace expiry. The page does not reconnect, and it does not store the credential anywhere that would survive the document.

A demo socket does not suspend. Any loss of a synthetic participant runs leave for that participant. Host suspension also leaves every remaining synthetic participant in the same room operation, so a bot cannot hold a slot or keep a broadcast alive. Spawn is the only way to create a demo after that.

Expiry uses one Lua path shared by the timer, a sweep of rooms this process has suspended, and the start of join and resume. Tests pass `now`. They do not sleep 20 seconds. A participant who already resumed is unchanged. An overdue human leaves. An overdue host sets the room ended, and the service then runs the existing shutdown. A failed expiry rejects a conflicting join or resume and does not insert another participant.

Join by a user who already has a row returns `already_joined`, including while that row is suspended. The message stays `This guest is already in the room.` Resume is the only way back before expiry.

Demotion of a suspended speaker removes that person from the stage set, clears the hand, and sets the role to `ATTENDEE`. The row stays suspended. Resume returns that attendee and does not restore the stage slot. Promotion of a suspended attendee returns `not_connected`.

The client retry budget is the same 20 seconds, measured from its own detection. It opens a new socket at 0, 1, 2, and 4 seconds and does not start an attempt at or after 20 seconds. Each attempt uses `reconnection: false` and a new manager. The old socket's pending SDP, ICE, media, and moderation are discarded. The only membership command on that socket before a fresh snapshot is `room:resume`.

Leave during recovery stops further attempts. If a resume has already bound, the page sends `room:leave` on that binding. If the server has already expired the row, the page stays in the lobby.

### 5.4 Media and peers

On local detection, this page runs the same generation cancel as `teardownLocal`: local capture, screen share, meters, demo resources, peer connections, and the upload producer stop. A late `replaceDevice` track is stopped and is not attached.

Resume replaces the snapshot baseline. Ignore a revision older than the snapshot that came with the resume. Build peer connections only to stage members whose `presence` is `connected`. A resumed attendee builds none. Close a peer when that participant becomes suspended or leaves. Do not call `restartIce`. Do not add a transceiver. Stats belong to the new connections.

After resume the membership is joined, both tracks are stopped, and the flags are muted, video-off, and not sharing. The device controls call `replaceDevice`. They do not call `prepare`, and they do not acquire a device by themselves. Host locks still disable the matching control. The green room stays the first-join and promotion-consent surface. Screen share starts only from the existing control.

An ICE failure that leaves the signaling socket up does not suspend the membership.

### 5.5 Broadcast

Explicit host leave still uses `stopRoom`. A clean stop may become `READY`.

Unexpected host loss calls a separate interrupted-broadcast failure. Abort the FFmpeg child so the attempt becomes `FAILED` with `Host connection lost.` Clear the broadcast key. A later chunk receives `broadcast_not_active`. Do not mark the catalog room `ENDED` at this moment. On host resume, nothing starts a recorder. The existing start control creates a new attempt.

A non-host suspension does not stop the broadcast. The host compositor drops that participant because the connected-stage set no longer includes them. The current attempt stays `LIVE`.

API restart keeps `failInFlight` with `api restarted` and the presence reset. A resume against missing presence returns `participant_not_found`, and the page shows `The live room reset. Join again.` It does not keep retrying for the rest of the grace period.

### 5.6 What the page shows

A recoverable drop shows `Reconnecting. This room is still open.` An expired or rejected resume shows `The connection was gone too long. Join again.` Room end still shows `This room has ended.` The reset sentence is reserved for a missing membership after restart or a dropped presence. Use a status announcement. Leave remains available during recovery.

A refresh that lost the credential and finds the row still reserved shows the existing already-joined sentence. The page does not submit join in a loop.

### 5.7 What stays unchanged

The four-person mesh, Perfect Negotiation, host locks, in-call device replacement, ordered upload, and the single 720p recording stay. Initial stage join still requires both permissions. Attendees still join without capture. Replay links stay available to any guest who has the link. The home page still must not contain the letters `hls`. This phase adds no database migration.

## 6. Acceptance matrix

| ID     | Observable result                                                                                                                                                                                                             | Method                                                                                             | Status  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------- |
| REC-01 | A suspended human resumes to the same participant id, role, locks, hand, `joinedAt`, and stage reservation. One socket is current. Generation increases. A second join while suspended returns `already_joined`               | Shared reducer tests, real Redis integration, then a two-window browser check                      | planned |
| REC-02 | Suspended stage ids count toward four. A racing resume and expiry leave one row. Demotion during suspension frees the slot and resume stays an attendee. A stale generation does not relay or moderate                        | Real Redis concurrency tests. The socket smoke covers suspend and a forced expiry                  | planned |
| REC-03 | The recovering page has stopped capture, share, demos, peers, and the upload producer. Resume does not call `prepare` or `getUserMedia`. A later explicit device action uses `replaceDevice`. Screen share stays off          | Web session tests. Browser confirmation when a browser is available                                | planned |
| REC-04 | Host socket loss keeps the catalog room `LIVE`. Explicit host leave or host expiry ends it. API restart still fails in-flight rows with `api restarted` and clears presence. A resume then is `participant_not_found`         | Service tests with a controlled clock, plus the existing restart test                              | planned |
| REC-05 | Non-host suspension leaves the broadcast row `LIVE` and removes that id from the host mix inputs. Host suspension stores `FAILED` and `Host connection lost.` A following chunk is rejected. Resume does not start a recorder | Broadcast service tests and a web source test. A real FFmpeg run stays unverified unless it is run | planned |

A missing browser, disposable FFmpeg run, physical device, or native picker leaves only that method unverified.

## 7. Verification commands

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
rg -n "hls" apps/web/src/pages/HomePage.tsx
```

The search prints nothing. API tests require Redis. `pnpm smoke:live` is part of the server slice and must use its own `sf:itest:smoke:*` keys.

The two-window check uses the local web app and API. Drop the signaling socket, resume inside grace, and confirm one membership, new peer connections, and media off. Synthetic devices are enough for the repeatable browser pass. Physical microphone, speaker, camera-indicator, and native screen-picker results stay open unless they are observed in this phase.

## 8. Risks

| Risk                                                                    | What to do                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| The socket id remains the hash field, so resume creates a second person | Section 5.1. One participant id owns the row and the stage slot         |
| Socket.IO replays the old SDP buffer after the drop                     | Section 5.3. A new socket sends resume and then waits for a snapshot    |
| The resume credential is copied into the snapshot or `sessionStorage`   | Section 5.2. Page memory and a server-side digest only                  |
| A late command from the old socket unmutes or relays after resume       | Section 5.2. Generation is checked before the mutation                  |
| Expiry runs after resume and deletes the member                         | Section 5.3. The expire path no-ops a connected row                     |
| A suspended speaker is invisible to the cap and a fifth person joins    | Section 5.3. The stage set keeps that id until leave, demote, or expiry |
| Host loss marks the interrupted attempt `READY`                         | Section 5.5. Abort the child. `stopRoom` stays the explicit-leave path  |
| Resume calls `prepare` and opens a camera by itself                     | Section 5.4. Media stays off until `replaceDevice`                      |
| A demo remains on stage after the host drops and holds the room         | Section 5.3. Host suspension leaves synthetic rows                      |
| Chat or `restartIce` is added so recovery looks complete                | Section 3.2. Those behaviors are not started                            |

## 9. Exit and handoff

V2-P3 is done when REC-01 through REC-05 have a result, each slice is committed under V1 master Section 1.4, and the README describes grace, explicit leave, host expiry, failed host broadcasts, media staying off, and the cases that do not resume. Unverified browser, physical, and native-picker checks stay named. P3-A03, P3-A05, P3-A06, and the V2-P1 and V2-P2 browser and smoke gaps stay open.

V2-P4 may rely on `participantId`, the connection generation, and rejection of a stale transport. It may rely on a suspended member remaining in the room until expiry. It may not rely on chat. The generation check added here is the check a later chat command must pass. Do not implement chat in this phase.

Do not write `plans/phase4.md` until that work starts.
