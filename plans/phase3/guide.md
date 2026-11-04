# Guide — V2 Phase 3, commit by commit

**Status:** implementation complete; acceptance partially verified. V2P3-C01 through V2P3-C04 are committed. Browser and physical/native-picker gaps remain open.\
**Last updated:** 2026-11-04.\
**Phase contract:** [../phase3.md](../phase3.md).\
**Product authority:** [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md) version `2.0.0-draft.4`. Unchanged V1 rules stay in [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.9`.\
**Deliverable:** A short unexpected socket drop keeps the same membership, and resume comes back with media off, in four commits. This is the only V2 Phase 3 guide. Its commit ids are not the V1 Phase 3 commits in [../V1/phase3/guide.md](../V1/phase3/guide.md).

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `44a10de50a0bdf69f931e6cf057139b8c1ab82d8`. Recheck the worktree. `MASTER_PLAN_V2.md` and `plans/phase1.md` were already dirty when this guide was written.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run V2P3-C01 through V2P3-C04 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing. API tests that touch Redis fail when Redis is unreachable. Do not point them at developer keys outside `sf:itest:*`.
4. After verification, commit that slice under V1 master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(v2-phase3): record the final slice hash`.
5. If a browser cannot be used, leave the browser half of the related acceptance id unverified and name the gap.
6. Do not mark P3-A03, P3-A05, or P3-A06 passed unless that physical or native-picker observation was actually made. Synthetic devices do not close those gaps.

Keep the mesh cap, the negotiation reducer, demo spawn, host locks, device replacement, and the single 720p pipeline. Do not add chat, `restartIce`, or a Socket.IO reconnect buffer.

### 1.1 Commit index

| Order | ID       | Proposed message                                             | Acceptance                                   |
| ----- | -------- | ------------------------------------------------------------ | -------------------------------------------- |
| 1     | V2P3-C01 | `feat(live): key a membership by participant id`             | REC-02 identity                              |
| 2     | V2P3-C02 | `feat(api-live): suspend a membership when its socket drops` | REC-01 server, REC-02, REC-04, REC-05 server |
| 3     | V2P3-C03 | `feat(web-live): resume one membership with media off`       | REC-01 client, REC-03, REC-05 client         |
| 4     | V2P3-C04 | `docs(readme): state the reconnect limits`                   | README limits                                |

### 1.2 Files to inspect before editing

- `packages/shared/src/stage.ts`, `stage.test.ts`, `limits.ts`, `signaling.ts`, `signaling.parsers.ts`, and `negotiation.ts`
- `apps/api/src/live/live.keys.ts`, `live.repository.ts`, `live.service.ts`, `signaling.gateway.ts`, and `signaling.messages.ts`
- `apps/api/src/live/scripts/common.lua` and the command scripts beside it
- `apps/api/src/live/live.integration.test.ts`, `live.service.test.ts`, and `signaling.gateway.test.ts`
- `apps/api/src/broadcasts/broadcasts.service.ts` and `broadcasts.service.test.ts`
- `apps/web/src/features/live/services/signaling.ts`, `room-session.ts`, `peer-manager.ts`, and `demo-peer.ts`
- `apps/web/src/features/live/stores/room-store.ts` and `components/live-room.tsx`
- `scripts/smoke-live.mjs` and `scripts/check-artifacts.mjs`
- `README.md`

## 2. V2P3-C01 — Participant identity

**Status:** committed\
**Proposed commit message:** `feat(live): key a membership by participant id`\
**Actual commit:** `dcac0b369d1679ccaba2cef56135c7b1b16f4377`

**Why:** Resume cannot have a stable member while the hash field, the stage set, and the peer map are the socket id. Covers the identity half of REC-02.

**Depends on:** The current stage reducer, Lua scripts, and snapshot consumers.

**Files:**

- `packages/shared/src/stage.ts`
- `packages/shared/src/stage.test.ts`
- `packages/shared/src/limits.ts`
- `packages/shared/src/signaling.ts`
- `packages/shared/src/signaling.parsers.ts`
- `packages/shared/src/negotiation.ts`
- `packages/shared/src/negotiation.test.ts`
- `apps/api/src/live/live.keys.ts`
- `apps/api/src/live/live.repository.ts`
- `apps/api/src/live/scripts/common.lua`
- `apps/api/src/live/scripts/join.lua`
- `apps/api/src/live/scripts/leave.lua`
- `apps/api/src/live/scripts/patchMedia.lua`
- `apps/api/src/live/scripts/setHand.lua`
- `apps/api/src/live/scripts/promote.lua`
- `apps/api/src/live/scripts/demote.lua`
- `apps/api/src/live/scripts/setHostLock.lua`
- `apps/api/src/live/live.service.ts`
- `apps/api/src/live/signaling.gateway.ts`
- `apps/api/src/live/signaling.messages.ts`
- `apps/web/src/features/live/stores/room-store.ts`
- `apps/web/src/features/live/services/signaling.ts`
- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/services/peer-manager.ts`
- `apps/web/src/features/live/services/demo-peer.ts`
- `apps/web/src/features/live/components/live-room.tsx`
- `apps/web/src/features/live/components/participant-list.tsx`
- `apps/web/src/features/live/components/stage-grid.tsx`
- `scripts/smoke-live.mjs`
- `scripts/check-artifacts.mjs`
- The test fixtures those types break

**Implementation:**

1. Add `participantId`, `connectionGeneration`, and `presence` (`connected` or `suspended`) to `ParticipantState`. `socketId` becomes `string | null`. Add `RECONNECT_GRACE_MS` as `20000`. Sort by `participantId`. Rename `stageSocketIds` to `stageParticipantIds` and hand members to `participantId`. Project `handParticipantIds` on `RoomSnapshot`.
2. The gateway generates the UUID and passes it into join. Lua stores the hash field, stage member, and hand member under that id. `connectionGeneration` starts at 1 and `presence` is `connected`. Append a transports hash after the broadcast key. `KEYS[6]` stays the broadcast lock. `liveKeys` length becomes 7. Join writes `socketId → participantId`. Leave deletes that transport entry.
3. Change relay, promote, demote, and lock requests to `participantId`. The server loads the target's current socket from the transports hash and emits there. A missing transport returns `not_connected`. `meshPeers` and `canRelay` take the connected stage ids only. The shared reducer keeps a suspended stage id in the stage set and out of the relay set. Lua implements that command in the next slice. The gateway does not call suspend yet.
4. `JoinAck` returns `participantId` and `iceServers`. The web store, roster, peer map, stage video map, active speaker, and demo engine use that id. Encode a null `socketId` as JSON null wherever a fixture or script builds a participant. Update the artifact check to expect 7 keys. Keep the 11 Lua files. Point the smoke's participant reads through the transports hash. Disconnect still deletes the row, and the smoke's rejoin still uses `room:join`.
5. Add reducer tests for a suspended stage id counting toward four, `not_connected` promotion, and demotion that frees the slot while the row remains. Do not add the resume credential, the deadline key, or a disconnect behavior change in this slice.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

**Done when:** Those tests pass, disconnect still leaves, and the slice is committed.

**Verification result (2026-11-03):** Shared tests passed (181), API tests passed against Redis (171), and web tests passed (269). `pnpm typecheck` and `pnpm lint` passed. `pnpm --filter @stageflow/api build`, `pnpm smoke:live`, and `node scripts/check-artifacts.mjs --api` also passed. The smoke confirms disconnect still removes the membership, rejoin still uses `room:join`, and host disconnect still ends the room. Redis uses seven room keys, with the broadcast lock still sixth, and the API still ships eleven Lua files. REC-02 identity and reducer reservation checks are covered. Resume races and the two-window reconnect browser check remain pending for later slices. Existing physical and native-picker gaps remain open.

**Handoff:** Membership has a stable id. Unexpected disconnect is still leave. The resume key does not exist yet.

## 3. V2P3-C02 — Server suspension

**Status:** committed\
**Proposed commit message:** `feat(api-live): suspend a membership when its socket drops`\
**Actual commit:** `59244b2843ccad1c1a4797b51d8b039282ca0c39`

**Why:** A stable id does not reserve the slot or reject a stale socket until disconnect suspends and expiry is atomic. Covers the server half of REC-01, REC-02, REC-04, and REC-05.

**Depends on:** V2P3-C01. `stopRoom` and `failInFlight` stay.

**Files:**

- `packages/shared/src/stage.ts`
- `packages/shared/src/stage.test.ts`
- `packages/shared/src/signaling.ts`
- `apps/api/src/live/live.keys.ts`
- `apps/api/src/live/live.repository.ts`
- `apps/api/src/live/live.service.ts`
- `apps/api/src/live/live.service.test.ts`
- `apps/api/src/live/live.integration.test.ts`
- `apps/api/src/live/signaling.gateway.ts`
- `apps/api/src/live/signaling.messages.ts`
- `apps/api/src/live/scripts/common.lua`
- `apps/api/src/live/scripts/suspend.lua`
- `apps/api/src/live/scripts/resume.lua`
- `apps/api/src/live/scripts/expire.lua`
- `apps/api/src/broadcasts/broadcasts.service.ts`
- `apps/api/src/broadcasts/broadcasts.service.test.ts`
- `scripts/smoke-live.mjs`
- `scripts/check-artifacts.mjs`

**Implementation:**

1. Append the resume hash and the deadline zset after the transports key. `liveKeys` length becomes 9. `KEYS[6]` stays the broadcast lock. Add `suspend.lua`, `resume.lua`, and `expire.lua`. Put the overdue check in `common.lua` and use it from expire, from the start of join, and from resume. The integration test compares those scripts with `applyStageCommand` the same way it compares the existing commands. Update the artifact check to the new file count and key count.
2. Unexpected human disconnect calls suspend on the leave cleanup reserve. Bind `{ participantId, generation, roomId }` on the socket at join and clear it inside that suspend operation. Suspend sets `presence` to `suspended`, `socketId` to null, deletes the transport, forces muted, video-off, and not sharing, and scores the deadline at `now + RECONNECT_GRACE_MS`. Keep role, locks, `joinedAt`, and a raised hand. Keep a stage id in the stage set.
3. A synthetic disconnect runs leave. Host suspend leaves every remaining synthetic row in that same operation and then publishes. Explicit `room:leave` and shutdown stay on the leave path. Host leave still calls `stopRoom` and `finishShutdown`.
4. Mint 32 random bytes on human join. Store the SHA-256 hex digest. Return the base64url credential only in that socket's join ack. The page may ignore that field until the next slice. Delete the digest on leave, expiry, and room end. Do not log it or put it in the snapshot. `room:resume` checks the guest JWT user id, the digest, and `suspended`. Success binds the new socket, increments `connectionGeneration`, clears the deadline, and leaves media off. `already_connected` does not replace a live socket. Two resumes bind one socket. The loser gets `resume_lost`. A generation mismatch on a later command returns `stale_transport`. Add those codes to the signaling message map.
5. Schedule expiry with an injected clock and sweep rooms this process has suspended. A connected row is unchanged. An overdue human leaves. An overdue host sets the room ended and the service runs `finishShutdown`. A failed expire rejects the conflicting join or resume. Tests advance `now`. They do not wait 20 seconds. Demotion of a suspended speaker frees the stage id and resume stays `ATTENDEE`.
6. Add `failInterrupted` on the broadcast service. Host suspend calls it instead of `stopRoom`. Abort the child so the row becomes `FAILED` with `Host connection lost.` A later chunk is `broadcast_not_active`. Non-host suspend does not call it. The catalog room stays `LIVE` until host leave or host expiry.
7. Update `smoke-live.mjs`. A guest disconnect leaves the participant row and a second `room:join` returns `already_joined`. The smoke calls the same expire operation the sweeper uses, with `now` past the deadline, and then join succeeds. A host disconnect keeps the webinar `LIVE`. Expiring that host ends it. Do not sleep for the grace period. Do not add a client-facing command that expires a reservation early.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
pnpm smoke:live
```

`pnpm smoke:live` uses its own prefix. Missing Redis leaves that command unverified and named.

**Done when:** The race, expiry, host-room, and broadcast-failure tests pass and the slice is committed.

**Verification result (2026-11-03):** Shared tests passed (185), API tests passed against Redis (194), and web tests passed (269). `pnpm typecheck`, `pnpm lint`, `pnpm --filter @stageflow/api build`, `pnpm smoke:live`, and `node scripts/check-artifacts.mjs --api` passed. The Lua/oracle comparisons cover suspension, resume, exact-deadline expiry, credential ownership, preserved locks and hands, suspended demotion, synthetic cleanup, and stale generations. Redis race tests bind one resume and preserve a connected member against expiry. Controlled-clock service tests cover cleanup capacity, failed and ambiguous suspension replies, publication retries, failed expiry, and host shutdown retries without waiting for grace. The socket smoke verifies reserved join rejection, a real socket resume with media off, guest expiry and rejoin, and a host catalog room staying `LIVE` until forced expiry. Interrupted-broadcast tests abort the child, store `FAILED` with `Host connection lost.`, and reject later chunks. Nine room keys retain the sixth-key broadcast lock; all fourteen Lua files ship. Server portions of REC-01, REC-02, REC-04, and REC-05 are covered. The reconnect browser pass, client recovery, and an audible run with real FFmpeg remain unverified. P3-A03, P3-A05, P3-A06, and earlier browser gaps remain open.

**Handoff:** The server can resume. The page still treats every disconnect as a reset and does not send `room:resume`.

## 4. V2P3-C03 — Page recovery

**Status:** committed\
**Proposed commit message:** `feat(web-live): resume one membership with media off`\
**Actual commit:** `4a39252c5faaeaa3f84d86a30fa68fb5c4ea9bfd`

**Why:** A server reservation the page does not reclaim still looks like a reset, and a naive socket reconnect would replay old signaling. Covers REC-03 and the client half of REC-01 and REC-05.

**Depends on:** V2P3-C02. `reconnection: false` stays.

**Files:**

- `apps/web/src/features/live/services/signaling.ts`
- `apps/web/src/features/live/services/signaling.test.ts`
- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/services/room-session.test.ts`
- `apps/web/src/features/live/services/peer-manager.ts`
- `apps/web/src/features/live/services/demo-peer.ts`
- `apps/web/src/features/live/components/live-room.tsx`
- `apps/web/src/features/broadcast/services/stage-recorder.ts`

**Implementation:**

1. Keep the credential in a page-scoped variable. Do not write `sessionStorage` or `localStorage`. Drop it on leave, page hide, unmount, room end, and a rejected resume.
2. An unexpected disconnect during `joined`, when resume is allowed, increments the session generation, stops capture, screen share, demos, peers, analysers, and the upload producer, and enters `recovering`. Open a new socket with `reconnection: false` and `forceNew: true`. Send `room:resume` only. Discard the previous socket's pending events. Retry at 0, 1, 2, and 4 seconds from local detection, and do not start an attempt at or after 20 seconds.
3. On success, replace the snapshot baseline, ignore an older revision, and return to `joined`. Build peers only for connected stage ids. An attendee builds none. Close a peer whose participant is suspended. Do not call `restartIce`, `prepare`, or `getUserMedia`. The device controls call `replaceDevice` later. Screen share stays off. Demos stay stopped until Spawn.
4. Leave during recovery stops the retries. A binding that already succeeded then sends `room:leave`. Page hide and unmount keep the current lobby path and do not resume. `participant_not_found` shows `The live room reset. Join again.` and stops the budget. `resume_expired` and `invalid_resume` show `The connection was gone too long. Join again.` Room end stays `This room has ended.` The recovering sentence is `Reconnecting. This room is still open.`
5. A suspended remote id is absent from the host recorder inputs. Resume does not call broadcast start. Tests use fake timers and fake sockets. Cover: no `getUserMedia` during resume, one resume command and no replayed offer, page hide does not resume, and a non-host suspension drops that source.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
rg -n "hls" apps/web/src/pages/HomePage.tsx
```

The search prints nothing.

Browser, with the local API and two stage windows:

1. Join Ava and Sam. Interrupt only Ava's signaling socket. Sam sees one Ava, muted and video-off, and the stage count still includes her. Ava's camera stops. The page shows the reconnecting sentence.
2. Restore Ava within grace. Sam gets a new peer connection. Ava is the same roster row. Her microphone stays off until she uses the existing control. No second Ava appears.
3. Interrupt Ava past grace. The slot clears. Her page asks her to join again. A refresh during grace, without the in-memory credential, shows the already-joined sentence and does not create a second row.
4. Start a webinar broadcast, then suspend a non-host speaker. The attendee player keeps the current attempt, and that speaker's source is gone. Suspend the host. The attempt becomes `FAILED` with `Host connection lost.` Resume the host and start a new attempt from the existing control.
5. Confirm an attendee resume creates no peer connection and asks for no camera.

If no browser is available, leave this pass unverified. A synthetic device does not close P3-A03 or P3-A06. A missing FFmpeg leaves the audible REC-05 run unverified.

**Done when:** The session tests pass, the browser script has a recorded result or an explicit unverified gap, and the slice is committed.

**Verification result (2026-11-04):** Web tests passed (289), including resume-only sockets, baseline revision ordering, discarded old offers, the absolute retry schedule, the twenty-second budget, late acknowledgements, leave and page lifecycle cancellation, stopped capture and producer resources, explicit device activation, preserved host locks, attendee recovery without peers, and removal of suspended recorder inputs. The local preview selects the camera stream even when the microphone is enabled first after resume. `pnpm typecheck`, `pnpm lint`, `pnpm --filter @stageflow/web build`, and `node scripts/check-artifacts.mjs --web` passed. The `HomePage.tsx` search printed no `hls` matches.

Headless Chromium with synthetic devices verified one Ava membership during suspension, stopped local tracks, the reconnecting status, a new connected peer on Sam's page, the same participant id after resume, and media staying off. Unmute requested only a microphone; the later camera control requested a camera and restored a paintable local preview. Browser storage contained no resume credential. A new page with the same guest and no credential received the already-joined sentence during grace; the recovering page stopped at grace and the slot cleared. A webinar attendee resumed with the same id and raised hand, zero capture requests, and zero peer connections. This browser harness used the real gateway and live service with an isolated shared-reducer presence adapter and in-memory catalog. Docker was stopped, so the browser pass against Redis remains unverified. The webinar playback/host-interruption browser step and the audible FFmpeg run also remain unverified. Existing P3-A03, P3-A05, P3-A06, and earlier browser gaps remain open. The connected-stage filtering and recorder stop behavior introduced earlier were verified and retained.

**Handoff:** The README still describes host disconnect as ending the room and says socket resume is absent.

## 5. V2P3-C04 — README

**Status:** committed\
**Proposed commit message:** `docs(readme): state the reconnect limits`\
**Actual commit:** `501c490dae070b6ae39459eeb9969737c8d182cf`

**Why:** The product README still says every host disconnect ends the room and that socket resume is absent. After this phase, the reader needs the grace, leave, expiry, and media limits.

**Depends on:** V2P3-C03.

**Files:**

- `README.md`
- `plans/phase3.md`
- `plans/phase3/guide.md`
- `plans/README.md`
- `MASTER_PLAN_V2.md`

**Implementation:**

1. Replace the sentence that says bounded reconnect is not implemented. State that an unexpected human socket drop keeps the membership for 20 seconds.
2. State that explicit leave, page hide, navigation, and disposal do not resume. A lost leave during tab close can hold the slot until grace expiry. Refresh, restart, token expiry, and another device do not resume.
3. State that resume returns media off, screen share off, and demos stopped. A host lock still blocks the matching device. The first stage join still requires both a camera and a microphone.
4. State that unexpected host loss fails the current broadcast with `Host connection lost.` and keeps the catalog room until grace expiry or an explicit leave. A non-host suspension leaves the broadcast running without that source. API restart still clears presence and fails in-flight broadcasts with `api restarted`.
5. State the nine room keys and that `KEYS[6]` is still the broadcast lock. Keep P3-A03, P3-A05, P3-A06, and any unverified V2-P1, V2-P2, or V2-P3 browser check explicit. Do not describe chat, accounts, or `restartIce` as present.
6. Record each slice hash in this guide. Set this phase's status from the verification that actually ran.

**Verification:**

Read the edited README against phase Section 5. `pnpm exec prettier --check README.md plans/phase3.md plans/phase3/guide.md plans/README.md MASTER_PLAN_V2.md` passes.

**Done when:** The README matches the shipped reconnect behavior and this guide names every slice hash.

**Verification result (2026-11-04):** Reviewed README behavior against phase Section 5 and the shipped key list, recovery lifecycle, and broadcast interruption paths. The README covers twenty-second grace, explicit leave/page exit, expiry, same-page credential limits, media-off resume, host locks, stopped demos/share, host broadcast failure, continuing non-host broadcasts, restart reset, and all nine keys with `KEYS[6]` unchanged. `pnpm exec prettier --check README.md plans/phase3.md plans/phase3/guide.md plans/README.md MASTER_PLAN_V2.md` passed. Phase statuses distinguish passing automated checks and isolated synthetic-browser observations from the unverified browser pass against Redis, broadcast/playback/FFmpeg recovery check, and earlier physical/browser gaps. C04 changes documentation only; the passing C01 through C03 runtime checks are preserved as dated evidence. The final slice hash is recorded after this slice commit in `docs(v2-phase3): record the final slice hash`.

**Handoff:** V2-P3 implementation is complete with the recorded verification gaps. V2-P4 has not been written or authorized. Do not add chat in this commit.
