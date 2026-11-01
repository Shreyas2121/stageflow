# Guide 3 — Phase 3, commit by commit

**Status:** in progress. P3-C01 is committed; P3-C02 is verified; P3-C03 through P3-C05 are not implemented.\
**Last updated:** 2026-11-01.\
**Phase contract:** [../phase3.md](../phase3.md).\
**Product authority:** [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.1`.\
**Deliverable:** A four-person meeting mesh with screen share, in five commits. This is the only Phase 3 guide.

## 1. Execution rules

Read the phase contract before editing code. Phase 2 is the baseline. Planning-time `HEAD` was `71f4c12`. Recheck the worktree and follow the files that are actually there.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run P3-C01 through P3-C05 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing.
4. After verification, commit that slice under master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(phase3): record the final slice hash`.
5. If a browser cannot be used, leave the related acceptance ID unverified and name the gap.
6. Keep Phase 2 join, roster, hand-raise, and leave behavior working for someone who never gets a peer connection.

Do not add demo peers, `getStats`, promote buttons, FFmpeg, or a migration.

### 1.1 Commit index

| Order | ID | Proposed message | Acceptance |
| --- | --- | --- | --- |
| 1 | P3-C01 | `feat(shared): decide glare, candidate order, and stage relay` | A01 |
| 2 | P3-C02 | `feat(api-signaling): relay stage descriptions and ICE candidates` | A02 |
| 3 | P3-C03 | `feat(web-stage): show meeting peers on a mesh` | A03, A04, A06, A07 |
| 4 | P3-C04 | `feat(web-audio): highlight the active speaker` | A03 |
| 5 | P3-C05 | `feat(web-stage): share the screen by replacing the video track` | A05 |

### 1.2 Files to inspect before editing

- `packages/shared/src/signaling.ts`, `stage.ts`, and `index.ts`
- `apps/api/src/live/signaling.gateway.ts` and `live.repository.ts`
- `apps/web/src/live/local-media.ts`, `signaling.ts`, `room-store.ts`, and `pages/RoomPage.tsx`
- `apps/api/tsconfig.json`

## 2. P3-C01 — Negotiation and relay decisions

**Status:** committed\
**Proposed commit message:** `feat(shared): decide glare, candidate order, and stage relay`\
**Actual commit:** `db1a5aad5da39ed239f7c835a90494d8fbee98ab`

**Why:** The glare rule has to be true in a function before a browser connection copies it. Covers P3-A01.

**Depends on:** Phase 2 shared tests.

**Files:**

- `packages/shared/src/negotiation.ts`
- `packages/shared/src/negotiation.test.ts`
- `packages/shared/src/index.ts`

**Implementation:**

1. Add `meshPeers`, `canRelay`, and `reduceNegotiation` from phase Sections 5.1 and 5.2. Export them. Do not import DOM types.
2. `reduceNegotiation(flags, event)` returns the next flags and one action: `none`, `send-offer`, `ignore-description`, `accept-offer`, `accept-answer`, `queue-candidate`, `add-candidate`, or `drop-candidate`.
3. `negotiation-needed` returns `send-offer` and sets `makingOffer` only when `signalingState` is `stable` and `makingOffer` is false. A following `negotiation-needed` while `makingOffer` is true returns `none`. `local-offer-finished` clears `makingOffer`.
4. An offer uses the exact `readyForOffer` and `ignoreOffer` rule in the phase contract. Accepting a description sets `remoteDescriptionSet` and clears `ignoreOffer`. Ignoring an offer sets `ignoreOffer` and leaves the other flags alone.
5. A candidate returns `drop-candidate` while `ignoreOffer` is set, `queue-candidate` while `remoteDescriptionSet` is false, and `add-candidate` otherwise.
6. Tests in this commit:
   - Impolite peer, `makingOffer` true, `have-local-offer`, incoming offer: `ignore-description`.
   - Polite peer in that same glare: `accept-offer`.
   - Impolite peer, `stable`, not making an offer: `accept-offer`.
   - Two `negotiation-needed` events: one `send-offer`, then `none`.
   - Two candidates before a description stay ordered. The test applies them only after `accept-offer`.
   - A candidate after ignore is `drop-candidate` and is not in the queued list.
   - `meshPeers` removes self. An id that is not on stage produces an empty list.
   - `canRelay` rejects an attendee, a missing target, and a send to self.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm typecheck
pnpm lint
```

**Verification result (2026-11-01):** P3-A01 verified. Shared tests passed (72 tests across 3 files); workspace typecheck and lint passed.

**Done when:** P3-A01 passes and the slice is committed.

**Handoff:** No browser connection exists. The gateway does not yet relay.

## 3. P3-C02 — Relay between stage sockets

**Status:** verified\
**Proposed commit message:** `feat(api-signaling): relay stage descriptions and ICE candidates`\
**Actual commit:**

**Why:** The mesh needs a server path that attendees cannot use. Covers P3-A02.

**Depends on:** P3-C01.

**Files:**

- `packages/shared/src/signaling.ts`
- `apps/api/src/live/live.repository.ts`
- `apps/api/src/live/signaling.gateway.ts`

**Implementation:**

1. Add the structural description and candidate types and the two client and server events from phase Section 5.3. Include `fromSocketId` only on the server events. Add `not_on_stage` and `peer_unavailable` to `SignalingError`, and add their messages beside the existing gateway messages.
2. Add `LiveRepository.readStage(prefix)` that returns the members of `{prefix}:stage`. Do not read, edit, and write a participant hash.
3. Handle `webrtc:description` and `webrtc:ice-candidate` on the gateway. Validate the payload. Load the stage set for `client.data.room`. Ack `not_on_stage` when `canRelay` is false. Ack `peer_unavailable` when the target socket is missing or its room id differs. Otherwise emit the server event to that socket id only, with `fromSocketId` set to the sender.
4. A `null` candidate is valid and uses the same relay rule. Do not log SDP or candidate strings.
5. Leave join, media, hand, and leave behavior unchanged.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm typecheck
pnpm lint
```

Start the API, Postgres, and Redis. With two Socket.IO clients, join the same meeting as host and guest. Send a description from one stage socket to the other and confirm the target receives `fromSocketId` and the SDP. From a webinar attendee socket, send a description to the host and confirm the ack is `not_on_stage` and the host receives nothing.

Confirm a Phase 2 roster update still arrives after a third guest joins a meeting.

**Verification result (2026-11-01):** P3-A02 verified against the running API, PostgreSQL, and Redis with Socket.IO clients. Offers and answers arrived only at the target with the sender socket id, including when a forged sender id was supplied. ICE candidates and null relayed. Invalid payloads were rejected. Attendee sends, sends to attendees, self sends, and missing stage targets returned `not_on_stage`; stale or cross-room stage targets returned `peer_unavailable`. Rejected sends reached no recipient. A third meeting join updated the host roster; media updates and webinar hand raise still succeeded. Test hosts left and ended both test rooms. Shared tests (72), API Redis tests (19), workspace typecheck, and lint passed.

**Done when:** P3-A02 passes and the slice is committed.

**Handoff:** The web client does not send these events yet. `iceServers` remain unused.

## 4. P3-C03 — Mesh and tiles

**Status:** planned\
**Proposed commit message:** `feat(web-stage): show meeting peers on a mesh`\
**Actual commit:**

**Why:** Two browsers can see and hear each other, and leave releases the camera. Covers P3-A03, P3-A04, P3-A06, and P3-A07.

**Depends on:** P3-C02. `LocalMedia.prepare` already holds the camera and microphone streams.

**Files:**

- `apps/web/src/live/local-media.ts`
- `apps/web/src/live/peer-manager.ts`
- `apps/web/src/live/stage-grid.tsx`
- `apps/web/src/pages/RoomPage.tsx`
- `apps/web/src/index.css`

**Implementation:**

1. Add `cameraTrack()` and `microphoneTrack()` to `LocalMedia`. They return the live tracks captured before join and do not call `getUserMedia` again.
2. `peer-manager.ts` owns the connection map outside React. `sync(selfSocketId, stageSocketIds, iceServers)` opens a connection for each `meshPeers` result and closes the rest. Creating a connection adds one audio and one video `sendrecv` transceiver, assigns the local tracks, and only then allows `negotiationneeded` to call the reducer. Use the ICE servers from the room store. Do not hardcode a STUN host.
3. Send descriptions and candidates through the new signaling methods. Incoming events call `reduceNegotiation`. Queue and flush candidates in the reducer order. `setRemoteDescription` is the rollback. Do not send a rollback description.
4. Publish one remote `MediaStream` per peer to React. `StageGrid` renders the stage tiles from the snapshot plus those streams. Follow the layout in phase Section 5.5. The local tile uses the existing preview stream and stays muted. Remote tiles do not use the `muted` attribute.
5. Start the manager only when the local participant is on stage. A webinar attendee never constructs `RTCPeerConnection`.
6. Mute and camera-off keep the current `media:state` path and `track.enabled`. They must not call the offer action.
7. Call `peerManager.close()` immediately before `LocalMedia.stop()` in `leave`, `onEnded`, `onDisconnect`, and the unmount cleanup. `close()` closes every connection and sets tile elements' `srcObject` to null.
8. Replace the note that says video arrives later. Stage members see the grid. Attendees keep the roster and the sentence that stage video is only for people on stage.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm typecheck
pnpm lint
```

In two browser windows, join one meeting as Ava and Sam:

1. Each sees the other's camera, and the remote tile is not silent.
2. Ava mutes and turns the camera off. Sam's roster flags change. Sam's tile for Ava stays mounted, and the page does not reload the connection.
3. Ava leaves. Sam's tile for Ava disappears. Ava's tracks report `ended`, and the camera indicator is off when it can be seen.
4. Create a webinar. The guest joins without a camera prompt, sees the roster, and has no remote video tile.

Record any failed step. A still screenshot does not verify A03, A04, A06, or A07.

**Done when:** Those IDs pass and the slice is committed.

**Handoff:** Screen share and the active-speaker border are not implemented. The grid has a place for both.

## 5. P3-C04 — Active speaker

**Status:** planned\
**Proposed commit message:** `feat(web-audio): highlight the active speaker`\
**Actual commit:**

**Why:** A viewer can see who is audible without writing that fact to Redis. Extends P3-A03.

**Depends on:** P3-C03.

**Files:**

- `apps/web/src/live/active-speaker.ts`
- `apps/web/src/live/stage-grid.tsx`
- `apps/web/src/pages/RoomPage.tsx`

**Implementation:**

1. Watch the audio tracks of the current stage tiles, local and remote. Build an `AnalyserNode` per track.
2. The highlighted socket is the highest level at or above `0.08`. A new leader replaces the current one only after leading for 300 ms. When every level stays below `0.08`, clear the highlight.
3. Show the border and the word `Speaking`. Color is not the only cue.
4. Stop the context and the frame loop in the same cleanup as the peer manager. Do not emit a socket event from this module.

**Verification:**

```powershell
pnpm typecheck
pnpm lint
pnpm --filter @stageflow/shared test
```

In the two-window meeting, speak into one microphone and confirm that tile gains `Speaking`, then confirm the label clears after the room goes quiet. If the machine cannot capture audible input, leave that observation unverified and say so.

**Done when:** The highlight follows the rule above and the slice is committed.

**Handoff:** Screen share still is not present. Cleanup now includes this audio context.

## 6. P3-C05 — Screen share

**Status:** planned\
**Proposed commit message:** `feat(web-stage): share the screen by replacing the video track`\
**Actual commit:**

**Why:** A stage member can show a screen and return to the camera without a new offer. Covers P3-A05 and the screen-track part of RTC-05.

**Depends on:** P3-C04.

**Files:**

- `apps/web/src/live/local-media.ts`
- `apps/web/src/live/peer-manager.ts`
- `apps/web/src/pages/RoomPage.tsx`
- `README.md`

**Implementation:**

1. Add `startScreenShare()` and `stopScreenShare()` to `LocalMedia`. `startScreenShare` uses `getDisplayMedia` with video only. Store the screen track apart from the camera track. `stop()` and `stopScreenShare()` call `stop()` on the screen track. Neither method stops the camera track.
2. Add `replaceVideoTrack(track)` on the peer manager. It calls `replaceTrack` on each current video sender and does not call `setLocalDescription`, `createOffer`, or `reduceNegotiation`.
3. The share button is shown to a joined stage member. Success replaces the video track, then sends `{ isScreenSharing: true }`. Picker cancellation shows an error and does not send that flag.
4. `screenTrack.onended` restores `cameraTrack()` with `replaceVideoTrack`, stops the screen track, and sends `{ isScreenSharing: false }`. A second share stops the previous screen track first. Restoring a camera that is already off keeps `enabled` false.
5. The grid treats `isScreenSharing` as the large tile, as phase Section 5.5 describes.
6. Update the README: two browsers can see each other, share a screen, and leave. State the four-person ceiling and that attendees have no peer connection.

**Verification:**

```powershell
pnpm typecheck
pnpm lint
pnpm --filter @stageflow/shared test
rg -n "getStats|hls\.js|ffmpeg" apps packages -g "!dist/**" -g "!node_modules/**"
```

The search prints nothing.

In the two-window meeting:

1. Ava shares a screen. Sam sees the screen in Ava's tile, and Ava's roster shows screen sharing.
2. Ava stops sharing from the page or the browser's share control. Sam sees Ava's camera again.
3. Ava leaves while a share is active. The screen track and the camera track are `ended`, and Sam no longer has Ava's tile.
4. Repeat the Phase 2 attendee join and confirm the guest still has no remote tile.

Record what happened. If no browser is available, leave A05 unverified.

**Done when:** P3-A01 through P3-A07 are verified and the slice is committed.

**Handoff:** Phase 4 can attach demo peers and stats to this peer map. The negotiation reducer stays the only glare policy.

## 7. Phase exit

Update the phase acceptance statuses to `verified` only for checks that were actually run. Those lines belong in the P3-C05 commit. The follow-up commit is `docs(phase3): record the final slice hash`.
