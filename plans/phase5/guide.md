# Guide 5 — Phase 5, commit by commit

**Status:** P5-C01 through P5-C03 committed; P5-C04 verified. P5-A01 through P5-A06 passed with synthetic browser devices.\
**Last updated:** 2026-11-02.\
**Phase contract:** [../phase5.md](../phase5.md).\
**Product authority:** [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.7`.\
**Deliverable:** Webinar promote, demote, and host lock, in four commits. This is the only Phase 5 guide.

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `8fcf04051bd52b255cf4dd951d1a5890c767c103`. Recheck the worktree.

Master Section 16 records the user's 2026-11-02 authorization to proceed with P5-C01 while retaining P3-A03, P3-A05, and P3-A06 as required follow-up. The user subsequently requested P5-C02 through P5-C04 under the same exception. Later slices retain their own verification gates.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run P5-C01 through P5-C04 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing.
4. After verification, commit that slice under master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(phase5): record the final slice hash`.
5. If a browser cannot be used, leave the related acceptance ID unverified and name the gap.
6. Keep the current join cap, negotiation reducer, demo spawn limit, and active-speaker threshold.

Do not add FFmpeg, `hls.js`, a broadcast table, a broadcast Redis key, a migration, or a ninth Lua file. Do not render a media element for an attendee.

### 1.1 Commit index

| Order | ID     | Proposed message                                                 | Acceptance              |
| ----- | ------ | ---------------------------------------------------------------- | ----------------------- |
| 1     | P5-C01 | `feat(api-signaling): accept promote, demote, and host lock`     | A01                     |
| 2     | P5-C02 | `feat(web-room): give the host a hand queue and stage controls`  | A02 controls            |
| 3     | P5-C03 | `feat(web-stage): open the mesh only for current stage members`  | A03, A04, A06 automated |
| 4     | P5-C04 | `feat(web-room): tell attendees that broadcast is not available` | A02, A03, A04, A05, A06 |

### 1.2 Files to inspect before editing

- `packages/shared/src/signaling.ts`, `signaling.parsers.ts`, and `stage.ts`
- `apps/api/src/live/signaling.gateway.ts`, `signaling.messages.ts`, `live.service.ts`, and `scripts/*.lua`
- `apps/web/src/features/live/services/signaling.ts`, `room-session.ts`, `demo-peer.ts`, and `peer-manager.ts`
- `apps/web/src/features/live/components/live-room.tsx`, `participant-list.tsx`, and `room-controls.tsx`
- `scripts/check-artifacts.mjs`

## 2. P5-C01 — Moderation commands

**Status:** committed\
**Proposed commit message:** `feat(api-signaling): accept promote, demote, and host lock`\
**Actual commit:** `298ad5c53a66e4266b855e242418ecc13407cf60`

**Why:** The host's later buttons need a server command that already enforces the stage rules. Covers P5-A01.

**Depends on:** The existing `promote`, `demote`, and `setHostLock` scripts. Do not edit those scripts.

**Files:**

- `packages/shared/src/signaling.ts`
- `packages/shared/src/signaling.parsers.ts`
- `packages/shared/src/signaling.parsers.test.ts`
- `apps/api/src/live/signaling.messages.ts`
- `apps/api/src/live/signaling.gateway.ts`
- `apps/api/src/live/live.service.ts`
- `apps/api/src/live/live.service.test.ts`

**Implementation:**

1. Add the five client events and `stage:force-mute` from phase Section 5.2. Add `broadcast_not_available` to `SignalingError`. Leave `RoomSnapshot.broadcast` typed as `null`.
2. Parse promote, demote, and set-lock payloads. Reject a missing or empty target, a kind other than `audio` or `video`, a non-boolean lock, and any unknown key.
3. Handle the three stage events by calling the existing live update path with `promote`, `demote`, or `setHostLock`. The gateway still does not decide the role.
4. On a changed lock, emit `stage:force-mute` to the target socket only, then keep the normal snapshot publish. A no-op lock emits nothing new.
5. Handle both broadcast events inside the service and return the Section 5.2 rejection before any repository call.
6. Extend the failure-message record with `Broadcast is not available yet.` Existing stage sentences stay.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

The new service test, with a fake repository, covers:

- A host promote of an attendee calls `promote` and no other command.
- Promote when the script returns `stage_full` does not publish a snapshot.
- Demote of the host returns `cannot_demote_host` and does not publish.
- A changed audio lock publishes one snapshot and one `stage:force-mute` to the target, with `locked: true`.
- Broadcast start and stop return `broadcast_not_available` and do not call the repository.
- A non-host promote returns `not_host`.

The existing Redis integration test still covers the Lua promote and demote cases. Do not add a ninth script. `pnpm check:artifacts --api` is not required for this slice unless the build output changes; the eight-file expectation must still be true.

**Verification result (2026-11-02):** Shared tests (141), API tests (105, including real Redis integration), workspace typecheck, and workspace lint passed. Eight Lua files remain unchanged. P5-A01 passed. P5-A02 through P5-A06 are unverified and belong to later slices.

**Done when:** P5-A01 passes and the slice is committed.

**Handoff:** The page has no moderation buttons. Attendees still have no broadcast sentence.

## 3. P5-C02 — Host controls

**Status:** committed\
**Proposed commit message:** `feat(web-room): give the host a hand queue and stage controls`\
**Actual commit:** `d9c926e742bab2e7a0950ab1836848fca384e747`

**Why:** The host can cause the transitions from P5-C01. Prepares P5-A02.

**Depends on:** P5-C01. The human signaling connection and the participant list exist.

**Files:**

- `apps/web/src/features/live/services/signaling.ts`
- `apps/web/src/features/live/services/signaling.test.ts`
- `apps/web/src/features/live/services/demo-peer.test.ts` (connection fixture only)
- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/services/room-session.test.ts`
- `apps/web/src/features/live/components/participant-list.tsx`
- `apps/web/src/features/live/components/live-room.tsx`

**Implementation:**

1. Add promote, demote, and set-lock methods on the human room connection. The demo connection may carry the same methods and must not call them. Neither factory writes the other factory's store.
2. Show the hand queue to a joined host, using `handSocketIds` order and each participant's display name as text. Each row has **Promote**.
3. On another attendee, show **Promote**. On a non-host speaker, show **Demote**. On any other participant, show the lock and unlock labels from phase Section 5.5. Hide all of these controls from everyone except the joined host.
4. Send the command and show `Error:` plus the server message when the ack fails. Do not change the roster until `room:state` arrives with a higher revision.
5. Do not add broadcast buttons or an attendee media region in this slice.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

The session test covers a failed promote leaving the local roster unchanged and surfacing the server message. The signaling test covers that a demo connection still does not call the human store.

With the API running, join a webinar as host and confirm the queue and buttons render. Leave the two-window promote check for P5-C04 if a second browser is not available, and say so.

**Verification result (2026-11-02):** Web tests (90), shared tests (141), API tests (105, including Redis integration), workspace typecheck/lint, formatting, API build, and API artifact check passed. Chrome 156 on Windows verified the host queue in raise order, host-only moderation controls, audio/video lock and unlock labels, and promote/demote role updates across independent pages. Desktop and 390px layouts were inspected. P5-A02 remains incomplete pending device-lock enforcement; two-way media consent and P5-A03 through P5-A06 remain for P5-C03/P5-C04. See phase Section 11 for the browser evidence and scope.

**Done when:** The host can send the three commands, and the slice is committed.

**Handoff:** A successful promote still needs the mesh and capture rules in P5-C03 before it is a call.

## 4. P5-C03 — Stage membership and locks

**Status:** committed\
**Proposed commit message:** `feat(web-stage): open the mesh only for current stage members`\
**Actual commit:** `3b26024210919e3372a5c80c9ef9a0bc135a4e13`

**Why:** Promotion and demotion have to change who holds a peer connection. Covers the automated part of P5-A03, P5-A04, and P5-A06.

**Depends on:** P5-C02. `meshPeers`, `PeerManager.sync`, and the session's promote and demote hooks exist.

**Files:**

- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/services/room-session.test.ts`
- `apps/web/src/features/live/services/local-media.ts`
- `apps/web/src/features/live/services/local-media.test.ts`
- `apps/web/src/features/live/services/demo-peer.ts`
- `apps/web/src/features/live/services/demo-peer.test.ts`
- `apps/web/src/features/live/services/signaling.ts`
- `apps/web/src/features/live/services/signaling.test.ts`
- `apps/web/src/features/live/components/live-room.tsx` (lock-control props)
- `apps/web/src/features/live/components/room-controls.tsx`

**Implementation:**

1. Keep the human rule that a stage gain waits for device consent and a stage loss stops camera, microphone, and screen tracks and closes that session's peer connections. Do not close the signaling socket on demotion. Do not end the room.
2. After consent succeeds, and only once the snapshot already lists that socket on stage, send one media patch with the green-room microphone and camera intentions. If the patch fails, show the server message and leave the tracks disabled.
3. While `hostAudioLocked` or `hostVideoLocked` is true, keep that track disabled and do not send an enabling patch. Disable the matching unmute or camera-on control and keep the existing lock sentence available from a rejected command. Clearing a lock does not itself unmute.
4. Handle `stage:force-mute` on the human socket and on a demo socket by disabling that kind immediately. The next higher snapshot still wins.
5. A demo peer still constructs no `RTCPeerConnection` while it is absent from `stageSocketIds`. On the first snapshot that places it on stage, sync the mesh and send one `{ isAudioMuted: false, isVideoOff: false }` patch. On demotion, sync closes those connections. Apply mute and video flags from its own snapshot to the canvas and tone tracks.
6. Do not replay queued descriptions from before the socket was on stage. Retain only current-stage descriptions and candidates received during capture consent, bounded to 32 events / 256 KiB, and discard them on demotion or leave. This preserves a current-stage initial offer until consent without opening a connection early. `PeerManager.sync` remains the only place that creates and disposes connections.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
rg -n "getUserMedia|getDisplayMedia" apps/web/src/features/live/services/demo-peer.ts
```

The search prints nothing.

Session tests cover: promotion does not call `getUserMedia` until consent; consent then syncs peers and sends one on-stage media patch; a locked microphone does not send an unmute; demotion stops tracks, closes peers, and leaves the socket joined. Demo tests cover: an attendee snapshot creates no peer connection; a later speaker snapshot syncs the stage ids and sends one unmuted patch; demotion disposes those connections.

**Verification result (2026-11-02):** Workspace tests (shared 141, web 102, API 105 including Redis), workspace typecheck/lint, and formatting passed. Demo source has no device-capture API calls. Chrome 156 on Windows verified consent-gated two-window media, audio/video lock behavior, demotion cleanup with signaling retained, and promoted demo media without device capture. The final P5-C04 sequence and full acceptance records remain pending. See phase Section 12 for scope and evidence.

**Done when:** Those tests pass and the slice is committed.

**Handoff:** The attendee page still does not name the missing broadcast.

## 5. P5-C04 — Missing broadcast and the two-window check

**Status:** verified\
**Proposed commit message:** `feat(web-room): tell attendees that broadcast is not available`\
**Actual commit:**

**Why:** An attendee can see why there is no video, and the host can see that broadcast is not live. Closes P5-A02 through P5-A06 in the browser.

**Depends on:** P5-C03.

**Files:**

- `apps/web/src/features/live/services/signaling.ts`
- `apps/web/src/features/live/services/signaling.test.ts`
- `apps/web/src/features/live/services/demo-peer.test.ts` (connection fixture only)
- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/services/room-session.test.ts`
- `apps/web/src/features/live/components/live-room.tsx`
- `apps/web/src/features/live/components/room-controls.tsx`
- `README.md`

**Implementation:**

1. For a joined attendee, render the roster and the sentence `The host has not started the broadcast.` Do not render a `video`, `audio`, or `canvas` for that broadcast region, and do not import `hls.js`.
2. For a joined webinar host, add **Start broadcast** and **Stop broadcast**. Each calls the matching command and shows the server sentence. A meeting does not render either control.
3. Update the README sentences that say moderation controls are absent and that public moderation handlers are still planned. Describe promote, demote, host lock, the attendee sentence, and the broadcast rejection. Do not document a playlist, FFmpeg, or a replay.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
rg -n "hls\.js|ffmpeg|BullMQ" apps packages
```

The search prints nothing. A session test covers the broadcast ack message being stored as the visible error and no local broadcast state being invented.

In current desktop Chrome or Edge, with the API and web app running:

1. As Ava, create a webinar, allow the camera and microphone, and join.
2. In a second window, join as Sam with no device prompt. Sam sees the roster and `The host has not started the broadcast.` The page has no media element in that region. Sam raises a hand.
3. Ava sees Sam in the hand queue. Before promotion, neither side has a peer connection for Sam, and the API does not deliver a description to Sam.
4. Ava promotes Sam. Sam sees the green room. After Sam allows both devices, each window shows the other person's camera. Sam's role is `SPEAKER`.
5. Ava locks Sam's microphone. Sam's mute control cannot turn it back on, and Sam's microphone track is disabled. Ava unlocks it. Sam can then unmute with the existing control.
6. Ava clicks **Start broadcast**. The page shows `Broadcast is not available yet.` The roster does not change. Ava's meeting, created separately, has no broadcast control.
7. Ava demotes Sam. Sam's camera track ends, both windows lose that peer connection, and Sam is an `ATTENDEE` again with the same broadcast sentence.
8. As Ava, spawn one demo peer, promote it, and confirm a tile and a peer connection appear. Demote it and confirm that connection closes. The demo spawn path still does not call `getUserMedia`.
9. Fill the stage to 4 and promote another attendee. The server sentence for `stage_full` appears and the roster does not gain a fifth stage member.

Record any failed step. A still screenshot does not verify A02–A06. If no browser is available, leave those IDs unverified.

**Verification result (2026-11-02):** All workspace tests (shared 141, web 105, API 105 including Redis), workspace typecheck/lint, formatting, production web build, and web artifact validation passed. Both forbidden-import and demo-capture searches printed nothing. All nine browser steps passed in Chrome 156 on Windows with synthetic devices, including broadcast start/stop rejection without snapshot mutation, meeting button visibility, demotion cleanup, demo promotion, and full-stage rejection. P5-A01 through P5-A06 passed. Phase Section 13 records the evidence and retained Phase 3 physical-device obligations.

**Done when:** P5-A02 through P5-A06 are verified and the slice is committed.

**Handoff:** Phase 6 can replace the broadcast rejection. It cannot treat this phase as a player, a playlist, or a waived Phase 3 observation.
