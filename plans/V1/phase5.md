# Phase 5 — Webinar moderation

**Status:** Complete. All four slices committed. P5-A01 through P5-A06 passed with synthetic browser devices. P5-C01 through P5-C04 are authorized by the user on 2026-11-02 with P3-A03, P3-A05, and P3-A06 retained as required physical-device follow-up (master Section 16).\
**Last updated:** 2026-11-02.\
**Master plan:** `MASTER_PLAN.md` version `1.0.7`, Sections 1.4, 5.2, 5.3, 7, 8, 9.1 through 9.4, 10.1, 13, and 16 (Phase 5).\
**Execution guide:** [phase5/guide.md](phase5/guide.md). That guide owns P5-C01 through P5-C04. This file owns the rules those commits must satisfy.\
**Requirement IDs:** ROOM-02 for moderation, ROOM-04 for role, stage, host lock, and the still-absent broadcast, and RTC-03 for "no relay to attendees."

## 1. Outcome

A webinar host can take an attendee from the hand queue onto the stage and later send them back. While that person is an attendee they have no peer connection and see no video element. On stage, after they consent to the camera and microphone, they share the mesh with the other stage members. The host can force their microphone or camera off, and they cannot turn it back on until the host clears the lock. Demotion closes every connection to them and stops their camera.

Example: Ava creates a webinar and joins as host. Sam joins in a second window, raises a hand, and sees the roster plus the sentence that the host has not started the broadcast. Ava promotes Sam. Sam enables the camera and microphone. Each window shows the other person. Ava demotes Sam. Sam's tile disappears, Sam's camera stops, and Sam is an attendee again. Ava's **Start broadcast** control reports that broadcast is not available.

## 2. Entry prerequisites

**Implementation gate:** Master Section 16 records the user's 2026-11-02 authorization to proceed with P5-C01 and the subsequent requests for P5-C02 through P5-C04 while retaining P3-A03, P3-A05, and P3-A06 as required follow-up. This does not verify those observations or mark Phase 3 exited.

Historical entry snapshot while writing this plan, on 2026-11-02:

- Phase 4's four slices and hash follow-up are committed. `HEAD` is `8fcf04051bd52b255cf4dd951d1a5890c767c103` (`review done`). The worktree is clean.
- Phase 3 observations P3-A03, P3-A05, and P3-A06 remain open. The repository still has no product decision accepting that exception.
- `applyStageCommand` and the Lua scripts already implement `promote`, `demote`, `setHand`, and `setHostLock`. The gateway exposes join, leave, media, hand, and stage relay. It does not expose promote, demote, or host lock.
- `RoomSnapshot.broadcast` is fixed at `null`. There is no broadcast table, no broadcast Redis key, and no `broadcast:start` handler.
- A human session already treats a later stage gain as promotion and a stage loss as demotion. Promotion waits for a separate device consent. Demotion stops local tracks and closes that session's peer connections. Nothing in the product can cause those transitions yet.
- Webinar attendees can raise a hand. The roster shows the flag. It does not show the hand queue, and the host has no moderation controls.
- `meshPeers` returns no remote ids for a socket that is off stage. Relay already drops a description or candidate unless both sockets are current stage members.

Recheck at execution. Git follows master Section 1.4. Current service paths are under `apps/web/src/features/live/`. Do not put new media code back under `apps/web/src/live/`.

## 3. Included and excluded

### 3.1 Included

- Socket commands for promote, demote, and host lock, accepted only by the existing stage rules.
- `stage:force-mute` to the locked participant after a lock change.
- A host hand queue in raise order, with promote, demote, and lock controls.
- Peer connections that appear when someone enters the stage and disappear when they leave it, including a promoted demo peer.
- Device consent before a promoted human sends media. Demotion runs the existing leave-style media cleanup for that person without ending the room.
- An attendee sentence that the host has not started the broadcast, and webinar-host broadcast controls that report `broadcast_not_available`.

### 3.2 Excluded

These are the exclusions this phase is most likely to violate. Master Sections 3.2 and 11 still apply.

- FFmpeg, HLS, `hls.js`, a `<video>` element for attendees, a broadcast row, and the `sf:room:{roomId}:broadcast` key.
- BullMQ, a second worker, a bitrate ladder, object storage, and a retry of a failed broadcast.
- A fifth stage slot, an attendee cap, or a peer connection to someone off stage.
- Auto-promote when a demo peer is spawned. Spawning still grants no stage role.
- Replay of old descriptions or candidates after a promotion.
- A new migration, a new Lua script, or a change to the eight existing scripts' stage rules.
- Mid-call device switching, host migration, socket resume, and chat.

`broadcast:start` and `broadcast:stop` exist so the control can report `broadcast_not_available`. They must not start a process or write Redis. Phase 6 replaces that rejection.

## 4. Requirement mapping

| ID      | Meaning in this phase                                                                                                    | What remains later                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| ROOM-02 | Promote into a free slot changes the attendee into a speaker. Promote at 4 members fails and writes nothing              | The meeting fifth-join case already belongs to Phase 2                     |
| ROOM-04 | The server assigns the role, the stage set, the host lock, and the absent broadcast. The client cannot send a role       | A real broadcast status, which Phase 6 owns                                |
| RTC-03  | Stage members form a mesh only with current stage members. An attendee never receives a relayed description or candidate | The live HLS path. Attendees still have no media to watch until that phase |

## 5. System contracts

### 5.1 Who may change the stage

The client never sends a role. The existing Lua scripts remain the only writers. A rejection preserves revision and TTLs.

| Action                    | Allowed actor                  | Result                                                                                                  |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Raise or lower hand       | Attendee                       | Hand queue updated. Host and speakers are rejected with `not_attendee`                                  |
| Promote                   | Host                           | Attendee becomes `SPEAKER` when the stage has fewer than 4 members. Otherwise `stage_full` and no write |
| Demote                    | Host                           | A non-host speaker becomes `ATTENDEE` and leaves the stage. Demoting the host is `cannot_demote_host`   |
| Force mute audio or video | Host                           | Sets that participant's host lock and forces the matching mute flag on. Own unmute stays rejected       |
| Start or stop broadcast   | Any caller in V1 of this phase | `broadcast_not_available`. No Redis write and no row                                                    |

Promotion removes that socket from the hand queue. Demotion does not raise the hand. Demotion restores the canonical off-stage state: microphone muted, video off, and screen sharing off. Promotion keeps that same state until a later on-stage media update. Host locks survive that wait.

The existing `stage_full` sentence stays. Do not add a second cap error.

### 5.2 Socket commands

Add these to the shared maps. Unknown payload keys are rejected, the same way a media patch rejects them.

| Event             | Payload                                                         | Result                                                                                        |
| ----------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `stage:promote`   | `{ targetSocketId }`                                            | Existing `promote` command                                                                    |
| `stage:demote`    | `{ targetSocketId }`                                            | Existing `demote` command                                                                     |
| `stage:set-lock`  | `{ targetSocketId, kind: "audio" \| "video", locked: boolean }` | Existing `setHostLock` command                                                                |
| `broadcast:start` | none                                                            | `{ ok: false, error: "broadcast_not_available", message: "Broadcast is not available yet." }` |
| `broadcast:stop`  | none                                                            | The same rejection                                                                            |

`targetSocketId` is a non-empty string. `kind` is only `audio` or `video`.

After a lock command that changes state, the server emits `stage:force-mute` to the target socket only, with `{ kind, locked }`. The room still receives the normal `room:state`. A lock that changes nothing emits neither. Do not add a second error event for a command that already has an ack.

`RoomSnapshot.broadcast` stays `null`. Do not widen that type in this phase.

### 5.3 Mesh membership

Create one peer connection per other current stage socket, and only then. Promoting someone does not replay descriptions or candidates from before the promotion. Demotion makes every remaining stage member close that peer connection, and the demoted client closes all of its own. Tile `srcObject` values for the closed connection become null.

An attendee, including a webinar demo peer, has zero `RTCPeerConnection` objects. A meeting is unchanged: there are still no attendees, and the fifth joiner is still `stage_full`.

A promoted human has not chosen devices yet. Do not call `getUserMedia` from the snapshot. Return them to the green room and open connections only after camera and microphone consent succeeds. A denied permission leaves them on stage in the roster, with no peer connection, and names the failed permission. They can leave.

A promoted demo peer uses the canvas and tone it already has. It does not call `getUserMedia` or `getDisplayMedia`. When its own snapshot first shows it on stage, it sends one media patch with microphone unmuted and video on, so the canonical off-stage flags do not keep the tracks disabled. A failed patch shows the server message and does not invent a local unmute.

### 5.4 Host locks

A lock forces `track.enabled = false` for that kind. The local control cannot set `enabled = true` while the current snapshot says the lock is on. Clearing the lock does not unmute. The participant uses the existing mute or camera control afterward, and the server still rejects that control while the lock remains.

Apply the same enabled rule to a demo peer's canvas and tone tracks from its own snapshot. The host has no separate demo-only lock command.

### 5.5 What the pages show

The host sees the hand queue in `handSocketIds` order, which is ascending raise time. Each raised attendee can be promoted from that queue. Speaker rows other than the host offer demote. Other participants offer audio and video lock controls. The words on those controls are Promote, Demote, Lock microphone, Unlock microphone, Lock camera, and Unlock camera.

A joined webinar host also sees **Start broadcast** and **Stop broadcast**. Both send the matching command and show the server sentence, including the words `Broadcast is not available yet.` A meeting host does not see them. A disabled control is not a substitute for the ack.

A joined attendee sees the roster, the existing hand control, and the sentence `The host has not started the broadcast.` That region contains no media element and does not import `hls.js`. Stage members keep the mesh tiles and do not show that sentence.

Empty, denied, `stage_full`, and lock failures use the server sentence and name the cause. Names render as text.

## 6. Acceptance matrix

| ID     | Observable result                                                                                                                                           | Method                                              | Status |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------ |
| P5-A01 | Promote, demote, and lock follow Section 5.1 through the socket. Broadcast start and stop return `broadcast_not_available` and do not write                 | API service test and the existing Redis integration | passed |
| P5-A02 | The host sees hands in raise order and can promote, demote, and lock. The target cannot turn the locked device back on                                      | Browser                                             | passed |
| P5-A03 | A second window joins as an attendee and receives no description. After promotion and device consent, the two windows show each other                       | Browser                                             | passed |
| P5-A04 | Demotion closes both sides of that connection, clears the tile, and stops the demoted camera. The person remains an attendee with no peer connection        | Browser                                             | passed |
| P5-A05 | The attendee view shows the missing-broadcast sentence and no media element. Webinar broadcast controls report the Section 5.2 sentence. A meeting has none | Browser and search                                  | passed |
| P5-A06 | Promoting a demo peer opens real peer connections. Before promotion it has none. Demotion closes them. The demo never calls `getUserMedia`                  | Browser and search                                  | passed |

ROOM-02 for moderation is A01. ROOM-04 is A01 and A02. RTC-03 is A03, A04, and A06.

## 7. Verification commands

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
docker compose up -d
pnpm dev
```

Search from the repo root:

```powershell
rg -n "hls\.js|ffmpeg|BullMQ" apps packages
rg -n "getUserMedia|getDisplayMedia" apps/web/src/features/live/services/demo-peer.ts
```

Both searches print nothing. The API artifact check still requires exactly the eight existing Lua files.

## 8. Risks

| Risk                                                       | What to do                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| An attendee is added to the mesh to make promotion simpler | Section 5.3. Connections exist only while the snapshot lists that socket  |
| The client sends a role and the server trusts it           | Section 5.1. Parsers reject unknown keys, and Lua assigns the role        |
| Promotion replays the last offer                           | Section 5.3. Negotiation starts only with the new pair                    |
| Broadcast buttons render a video element "for later"       | Section 5.5. Text only                                                    |
| A new broadcast script or table lands in this phase        | Section 3.2. The broadcast commands return before any repository call     |
| Promotion calls `getUserMedia` without consent             | Section 5.3. The green room stays the only capture prompt                 |
| A demo snapshot is written into the host room store        | Keep the demo on its independent socket. The host store remains the human |

## 9. Exit and handoff

Phase 5 is done when A01–A06 are verified and each slice is committed under master Section 1.4. The two-window check is a host window and a real attendee window. A demo peer does not replace that attendee.

Phase 6 may rely on promote, demote, and lock changing the stage; on `stage:force-mute`; on an attendee region that already names the missing broadcast; and on `broadcast:start` and `broadcast:stop` acking `broadcast_not_available`. It may rely on a promoted demo peer already negotiating. It must not expect a playlist URL, a broadcast row, or a media element. Phase 6 replaces the broadcast rejection. It does not get a contract in this phase.

## 10. P5-C01 verification (2026-11-02)

Shared tests passed (141), API tests passed (105, including real Redis integration with isolated test key prefixes), and workspace typecheck and lint passed. Moderation payloads reject unknown keys; the service tests cover promote, stage-full and role rejections, demote-host rejection, targeted audio/video locks, unlocks, no-op suppression, and broadcast rejection without repository access. The eight existing Lua scripts remain unchanged. P5-A02 through P5-A06 remain unverified and belong to later slices. P3-A03, P3-A05, and P3-A06 remain required physical-device follow-up under the recorded exception.

## 11. P5-C02 verification (2026-11-02)

Web tests passed (90), shared tests passed (141), API tests passed (105, including Redis integration), workspace typecheck, workspace lint, and formatting passed. The API build and artifact check passed. The demo test fixture was extended for the new connection methods; demo production code sends no moderation commands.

In desktop Chrome 156.0.8078.74 on Windows, three independent contexts joined a real webinar using an API in the isolated `p5c02-browser-20261102` namespace. The host used synthetic camera/microphone devices. Two attendees joined without capture or media elements, raised hands, and appeared in raise order. The host had Promote, Demote, Lock microphone, Unlock microphone, Lock camera, and Unlock camera as appropriate; the host row had no self-moderation controls. Attendees and the promoted speaker had no moderation controls. Queue promotion removed the hand and changed the role to SPEAKER; demotion restored ATTENDEE on both pages. Audio/video lock and unlock labels followed server snapshots. Desktop and 390px screenshots were inspected, with no horizontal overflow or browser page errors.

This verifies the P5-C02 controls portion of P5-A02. P5-A02 remains incomplete until device-lock enforcement is checked in P5-C03/P5-C04. Promoted device consent, two-way media, and the remaining P5-A03 through P5-A06 checks remain for those slices. No media consent was granted to the promoted attendee in this check. The Phase 3 physical observations remain open.

## 12. P5-C03 verification (2026-11-02)

Workspace tests passed: shared 141, web 102, API 105 (including real Redis integration). Workspace typecheck, lint, and formatting passed. The search for device-capture APIs in `demo-peer.ts` printed nothing. Stage capacity, demo spawn limit, active-speaker threshold, negotiation reducer, and all eight Lua scripts remain unchanged.

New service regressions cover consent before capture/connections, a single on-stage activation patch, rejected activation leaving tracks disabled, denied microphone permission, lock rejection without an enabling patch, immediate force-mute and authoritative newer snapshots, demotion during permission resolution, bounded consent-time signaling, and discarded off-stage/previous-stage descriptions. The demo regression uses the real PeerManager with fake browser connections to verify zero attendee connections, one activation per stage gain, snapshot-controlled tracks, and demotion disposal. Capture starts with the current disabled flags. Only current-stage messages received while awaiting consent are buffered (32 messages / 256 KiB); demotion and leave discard them.

Chrome 156.0.8078.74 on Windows, against an API with a unique isolated `p5c03-browser-` namespace, verified a host and an independent attendee with synthetic devices. Before promotion the attendee made zero capture calls and peer connections, and received no description. Promotion still made zero capture calls and connections until the user enabled devices. Consent then produced connected endpoints and nonzero decoded remote video dimensions in both windows. Microphone and camera locks disabled the matching tracks and controls; unlock left them off until the participant used the existing control. Demotion ended the camera/microphone tracks, closed both endpoints, removed attendee media elements, and preserved signaling (the attendee raised a new hand afterward). A spawned webinar demo peer had no connection before promotion; promotion connected both endpoints without any new device capture, camera lock disabled its canvas track, and demotion closed both endpoints. The connected-window screenshot was inspected; no page errors occurred.

These are the automated and scoped browser checks for P5-C03, supporting P5-A02 through P5-A04 and P5-A06. The complete P5-C04 browser sequence and final acceptance records remain pending, including broadcast UI/rejection and the stage-full UI check. P3-A03, P3-A05, and P3-A06 remain required physical-device follow-up.

## 13. P5-C04 and final acceptance (2026-11-02)

All workspace tests passed: shared 141, web 105, API 105, including real Redis integration. Workspace typecheck and lint, formatting, the production web build, and web artifact validation passed. Searches for `hls.js`, `ffmpeg`, and `BullMQ` in apps/packages, and for device-capture APIs in `demo-peer.ts`, printed nothing. No script, migration, broadcast storage, or broadcast media implementation was added; snapshots retain `broadcast: null`.

The complete guide Section 5 browser sequence passed in Chrome 156.0.8078.74 on Windows, using independent host and attendee contexts, synthetic camera/microphone devices, and a real API with a unique isolated `p5c04-browser-` Redis namespace:

1. Ava created a webinar, explicitly enabled both devices, and joined as HOST.
2. Sam joined as ATTENDEE with zero capture calls and zero peer connections. The roster and exact missing-broadcast sentence rendered; the Broadcast region and the attendee page contained no video, audio, or canvas. Sam raised a hand.
3. Ava saw Sam in the queue. Neither endpoint had a connection to Sam, and no description was delivered to Sam before promotion. Queue ordering was also verified with two raised attendees in P5-C02.
4. Ava promoted Sam. Sam saw the green room, with zero capture calls and connections until consent. After explicit consent, both endpoints connected and both windows decoded the other person's video. The role changed to SPEAKER.
5. Microphone and camera locks disabled the matching captured tracks and controls. Unlocking left each device off; Sam could then enable it through the existing control.
6. Both Start broadcast and Stop broadcast showed `Error: Broadcast is not available yet.` The entire snapshot, including revision and roster, stayed unchanged. Ava joined a separate meeting as host; it had neither broadcast button.
7. Demotion ended Sam's camera and microphone tracks, closed both endpoints, and cleared retained remote video attachments to `srcObject: null`. Sam returned to ATTENDEE with the same broadcast sentence and no media elements. Raising a new hand proved that the signaling connection remained joined.
8. A spawned demo attendee made no device-capture call and had no peer connection. Promotion opened its two connected endpoints and decoded video. Camera lock disabled its canvas track; demotion closed both endpoints.
9. Promoting three demo peers filled the four-person stage and connected all 12 mesh endpoints. Promoting Sam then showed the existing `stage_full` sentence. Sam remained an attendee, the stage stayed at four, and the complete snapshot and revision were unchanged.

No browser step failed and no page error occurred. Attendee, connected-stage, demoted-attendee, and full-stage screenshots were inspected. P5-A01 through P5-A06 passed within this synthetic-device scope. Phase 5's four slices are committed; the guide records the final slice hash. P3-A03, P3-A05, and P3-A06 remain required physical-device follow-up under master Section 16. Phase 6 can replace the explicit broadcast rejection; this phase supplies no player or broadcast media.
