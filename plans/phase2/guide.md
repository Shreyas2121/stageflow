# Guide — V2 Phase 2, commit by commit

**Status:** V2P2-C01 through V2P2-C06 are committed. V2P2-C04's two-window browser pass and V2P2-C05's playback browser pass are unverified.\
**Last updated:** 2026-11-03.\
**Phase contract:** [../phase2.md](../phase2.md).\
**Product authority:** [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md) version `2.0.0-draft.3`. Unchanged V1 rules stay in [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.9`.\
**Deliverable:** A stage member can change camera, microphone, and speaker while joined, and a lost input does not close the room, in six commits. This is the only V2 Phase 2 guide. Its commit ids are not the V1 Phase 2 commits in [../V1/phase2/guide.md](../V1/phase2/guide.md).

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `856907d7ba1e6d5cb936800ee0749871b96abd22`. Recheck the worktree.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run V2P2-C01 through V2P2-C06 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing.
4. After verification, commit that slice under V1 master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(v2-phase2): record the final slice hash`.
5. If a browser cannot be used, leave the browser half of the related acceptance id unverified and name the gap.
6. Do not mark P3-A03, P3-A05, or P3-A06 passed unless that physical or native-picker observation was actually made. Synthetic devices do not close those gaps.

Keep the mesh cap, the negotiation reducer, demo peers, host locks, and the broadcast pipeline. Do not add reconnect, chat, or a second transceiver.

### 1.1 Commit index

| Order | ID       | Proposed message                                                  | Acceptance                        |
| ----- | -------- | ----------------------------------------------------------------- | --------------------------------- |
| 1     | V2P2-C01 | `feat(web-media): replace one captured input at a time`           | MEDIA-03 acquisition              |
| 2     | V2P2-C02 | `feat(web-stage): send a replaced track to current peers`         | MEDIA-01, MEDIA-02                |
| 3     | V2P2-C03 | `feat(web-stage): keep the room when a device ends`               | MEDIA-03 loss                     |
| 4     | V2P2-C04 | `feat(web-room): change devices while on stage`                   | MEDIA-01 through MEDIA-03 browser |
| 5     | V2P2-C05 | `feat(web-playback): route the selected speaker through playback` | MEDIA-04                          |
| 6     | V2P2-C06 | `docs(readme): state the in-call device limits`                   | README limits                     |

### 1.2 Files to inspect before editing

- `apps/web/src/features/live/services/local-media.ts` and `local-media.test.ts`
- `apps/web/src/features/live/services/peer-manager.ts` and `peer-manager.test.ts`
- `apps/web/src/features/live/services/room-session.ts` and `room-session.test.ts`
- `apps/web/src/features/live/services/screen-share.ts`
- `apps/web/src/features/live/services/active-speaker.ts`
- `apps/web/src/features/live/services/output-route.ts` and `output-route.test.ts`
- `apps/web/src/features/live/components/green-room.tsx`, `live-room.tsx`, `stage-grid.tsx`, and `room-controls.tsx`
- `apps/web/src/features/broadcast/services/stage-recorder.ts`
- `apps/web/src/features/broadcast/components/broadcast-player.tsx`
- `apps/web/src/pages/ReplayPage.tsx` and `HomePage.tsx`
- `README.md`

## 2. V2P2-C01 — Replace one captured input

**Status:** committed\
**Proposed commit message:** `feat(web-media): replace one captured input at a time`\
**Actual commit:** `ae00c9946eed0d10e9a0836a7a2798f4958267f8`

**Why:** The stage needs a new track before any sender can change, and the current `prepare` path drops both inputs. Covers the acquisition half of MEDIA-03.

**Depends on:** The existing `LocalMedia` tests.

**Files:**

- `apps/web/src/features/live/services/local-media.ts`
- `apps/web/src/features/live/services/local-media.test.ts`

**Implementation:**

1. Add `replaceInput(kind, deviceId)` for `camera` and `microphone`. Run one attempt at a time. A second call waits until the first settles, then runs. Give each attempt a generation.
2. Acquire only that kind. Use the same constraint shape as `prepare`: an empty id uses the default, and a non-empty id uses an exact device id. Do not call `getUserMedia` for the other kind. Do not call `stop`, `stopScreenShare`, or `releaseLobby`.
3. Apply the current mute and video-off flags to the new track before resolving. Hold that track for the caller. Do not replace the stored track of that kind, and do not stop the previous track, inside `replaceInput`. `cameraTrack` and `microphoneTrack` keep returning the previous tracks until `commitInput`.
4. `commitInput(kind, track)` stores that held track and then stops the previous track of the same kind. `abortInput(track)` stops the held track and leaves both stored tracks unchanged. A commit or abort for a track that is no longer the held track stops the unexpected track and does not replace the stored one.
5. If `getUserMedia` fails, leave both stored tracks live and reject with the existing kind-specific sentence: the camera sentence names the camera, and the microphone sentence names the microphone.
6. If `stop` or a newer replacement advances the generation before the new stream is held, stop the late stream and do not hold it. A replacement that is already queued does not call `getUserMedia` after that generation change. `stop` still stops the screen share and both stored inputs, plus a track that is still held.
7. Tests use fake tracks. Cover: microphone replacement does not call `getUserMedia` with video and does not stop the camera or the previous microphone; `commitInput` then ends the previous microphone and `microphoneTrack` returns the new one; `abortInput` ends the new track and leaves the previous microphone stored; camera replacement during a live screen share leaves the screen track live until commit, and commit changes `cameraTrack`; acquisition failure keeps the previous microphone; a stream that resolves after `stop` is ended and not retained; a stream that resolves after a newer replacement is ended.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

**Done when:** Those acquisition cases pass and the slice is committed.

**Handoff:** No sender calls `replaceInput` yet. `prepare` remains the lobby and promotion path.

## 3. V2P2-C02 — Send the replacement to current peers

**Status:** committed\
**Proposed commit message:** `feat(web-stage): send a replaced track to current peers`\
**Actual commit:** `f322262dade03c5de81b0dcdce3d412465c98ac1`

**Why:** A stored track that never reaches the senders, the analyser, or the recording mix does not change the room. Covers MEDIA-01 and the service half of MEDIA-02.

**Depends on:** V2P2-C01. `PeerManager.replaceVideoTrack` and `ScreenShareController.stop` stay.

**Files:**

- `apps/web/src/features/live/services/peer-manager.ts`
- `apps/web/src/features/live/services/peer-manager.test.ts`
- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/services/room-session.test.ts`

**Implementation:**

1. Add `replaceAudioTrack` beside `replaceVideoTrack`. Both find the existing transceiver by the receiver track kind and call `replaceTrack`. They do not call `addTrack` or `addTransceiver`. If any sender rejects, throw after the attempts settle. A test with two fake peers shows the audio sender count stays one per peer.
2. Add `RoomSession.replaceDevice(kind, deviceId)`. Refuse it for an attendee, a member who is not on stage, a member who still needs capture consent, and any phase other than `joined`. The refusal does not call `getUserMedia`.
3. Apply the current mute, video-off, and host-lock flags before the new track is handed to a sender. A host audio lock keeps the new microphone disabled and does not send an unmute command. Cover that with a session test whose participant has `hostAudioLocked`.
4. For a camera change while `screenTrack` is live, `commitInput` stores the camera and stops the previous camera, and the session does not call `replaceVideoTrack`. A following screen-share stop restores that new camera track. For every other successful change, call the matching sender replacement while the previous track is still the stored track. After every sender accepts it, `commitInput` stores the new track and stops the previous one. Then refresh `syncSpeaker` and `syncBroadcast`. Do not add a second mix in `StageRecorder`. Its existing update path rebuilds nodes when the microphone track object changes. The session test asserts the broadcast sources publish the new microphone track only after commit.
5. If a sender rejects the track, point every sender of that kind back at the previous live track and `abortInput` the new track. The stored track remains the previous one. If the rollback rejects, stop the new track, leave that kind disabled, set a visible error, and do not add a transceiver.
6. Pass the session generation into the attempt. `teardownLocal` already increments it. Increment it, or otherwise cancel the same attempt, at the start of `onDemoted` before `media.stop`. A replacement that resolves after leave or demotion stops the new track and does not call `replaceTrack`.
7. Keep `prepare` for the lobby and for promotion consent. `replaceDevice` does not call `prepare`.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

**Done when:** The peer-count, lock, screen-restore, rollback, and cancellation tests pass and the slice is committed.

**Handoff:** The joined stage UI still has no device selects. Screen share still owns video replacement while a share is active.

## 4. V2P2-C03 — Device loss

**Status:** committed\
**Proposed commit message:** `feat(web-stage): keep the room when a device ends`\
**Actual commit:** `9230cb748905ea09bde94d2592e759f5f9a42d9a`

**Why:** An ended track currently stays in the sender until leave. The member needs a muted, joined state and an explicit retry. Covers the loss half of MEDIA-03.

**Depends on:** V2P2-C02.

**Files:**

- `apps/web/src/features/live/services/local-media.ts`
- `apps/web/src/features/live/services/local-media.test.ts`
- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/services/room-session.test.ts`

**Implementation:**

1. Own `ended` on the stored camera and microphone tracks. Clear that handler before stopping a track during replacement or `stop`. A screen track keeps the screen-share controller's handler.
2. While the session is attached, listen for `devicechange` and refresh the enumerated list. Remove the listener on detach. An added device updates the list and does not start capture.
3. When the owned camera ends, or its selected non-empty id disappears, mark the camera unavailable and video off. When the owned microphone ends, or its selected non-empty id disappears, mark the microphone unavailable and muted. On stage, publish the flag with the existing media command. Do not call `leave`, close peers, or call `getUserMedia`.
4. If the camera ends while the screen track is live, leave the screen sender in place. Do not restore the ended camera when the share stops. The stop path already falls back through `cameraTrack`; an ended camera must not be attached. The member stays video-off until a later replacement succeeds.
5. An empty selected id means the default device. Do not treat a refreshed device list as loss of that default. Loss of the default is its `ended` event.
6. Tests: an ended microphone sends `isAudioMuted: true` and leaves the phase `joined`; an ended camera during screen share does not call `replaceVideoTrack`; a `devicechange` that adds an input does not call `getUserMedia`; `detach` removes the enumeration listener.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

**Done when:** Those loss cases pass and the slice is committed.

**Handoff:** The joined UI does not yet explain the loss or offer a retry. The service state is ready for that panel.

## 5. V2P2-C04 — On-stage device controls

**Status:** committed\
**Proposed commit message:** `feat(web-room): change devices while on stage`\
**Actual commit:** `aa68c2fb41a0bedc6bb56f0baf67bec8be5ea9f2`

**Why:** The service can change devices, and a joined member still only sees mute and screen-share controls. Covers the browser half of MEDIA-01 through MEDIA-03.

**Depends on:** V2P2-C03.

**Files:**

- `apps/web/src/features/live/services/device-controls.ts`
- `apps/web/src/features/live/services/device-controls.test.ts`
- `apps/web/src/features/live/components/device-panel.tsx`
- `apps/web/src/features/live/components/live-room.tsx`
- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/services/room-session.test.ts`

**Implementation:**

1. Add a pure helper that decides which selects are visible. A joined stage member sees camera, microphone, and speaker. A joined attendee sees speaker only. A member who still needs capture consent sees none of this panel, because the green room remains the consent surface. Test those three cases.
2. Render the panel from `LiveRoom` for a joined member. Changing the camera or microphone calls `replaceDevice`. It must not call `prepare`. Disable the select whose kind is in flight. Keep the green-room selects for the lobby and for promotion consent.
3. Show an alert when replacement fails. For an unavailable camera or microphone, say that the room is still open and that another device starts only when chosen. The retry control calls `replaceDevice` with the id currently selected in that control. It does not choose a different enumerated device on its own.
4. The attendee panel does not import `LocalMedia` and does not call `getUserMedia`. Speaker selection still calls the existing `setSpeaker` until V2P2-C05 extends where that choice is applied.
5. Use native `select` and `button` elements. Do not move focus when the device list refreshes.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

Browser, with the local API and two stage windows:

1. Join Ava and Sam. Change Ava's camera and microphone. Sam receives both through the same two peer connections. The previous tracks stop.
2. Mute Ava, then change her microphone. Sam does not hear the new microphone. Lock her camera from Sam's host controls when Sam is the host of a webinar, then change Ava's camera. The new camera stays off.
3. Share Ava's screen, select a different camera, and confirm Sam still sees the screen. Stop sharing and confirm Sam sees the camera selected during the share.
4. End the microphone track from the browser's device tools, or from a test hook if no device can be unplugged. Ava stays in the room, the microphone is muted, and no other microphone starts. Choose a microphone explicitly and confirm it becomes the sent track.
5. Open an attendee window. Confirm it shows no camera or microphone select and requests no capture permission.

If no browser is available, leave this pass unverified. A synthetic device does not close P3-A03 or P3-A06.

**Browser result:** Unverified on 2026-11-03. No browser tool was available, so the two-window script was not run. P3-A03 and P3-A06 stay open.

**Done when:** The browser script has a recorded result, or an explicit unverified gap, and the slice is committed.

**Handoff:** Speaker selection still reaches the green-room preview and remote stage tiles only.

## 6. V2P2-C05 — Speaker output for later playback

**Status:** committed\
**Proposed commit message:** `feat(web-playback): route the selected speaker through playback`\
**Actual commit:** `a1014dfb889483215c5e4cfcfe2ec65b83a3c65a`

**Why:** The speaker choice is local to the stage tiles. Attendee and replay playback, and a tile created after the choice, need the same id. Covers MEDIA-04.

**Depends on:** V2P2-C04. `routeAudioOutput` stays the only `setSinkId` call.

**Files:**

- `apps/web/src/features/live/services/output-route.ts`
- `apps/web/src/features/live/services/output-route.test.ts`
- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/components/stage-grid.tsx`
- `apps/web/src/features/broadcast/components/broadcast-player.tsx`
- `apps/web/src/pages/ReplayPage.tsx`
- `apps/web/src/features/live/components/device-panel.tsx`

**Implementation:**

1. Extend the output helper with a tab-local selection. Save the chosen output id in `sessionStorage`. If storage throws, keep it in memory. Store the id only.
2. `bindAudioOutput(element)` applies the saved id and later changes through `routeAudioOutput`, and returns an unbind function. A missing `setSinkId` reports `supported: false`. Binding does not call `getUserMedia`.
3. Change the saved id when the member selects the default, or when every currently bound element accepts the new id. If one element rejects it, keep the previous id, show the error, and do not describe that element as routed. An element bound later receives the saved id.
4. Bind remote stage videos, the attendee broadcast video, and the replay video. Leave the local muted tile unbound. The green-room `setSpeaker` path writes the same saved id.
5. The attendee panel and the replay page show the speaker select and the default-speaker sentence when output routing is unsupported. Replay must not call `getUserMedia`. An empty output list still offers the default speaker.
6. Tests: a speaker id saved before `bindAudioOutput` is applied on bind; an unsupported element returns `supported: false` and does not throw; a rejected id leaves the previous saved id in place; replay's module does not reference `getUserMedia`.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
rg -n "hls" apps/web/src/pages/HomePage.tsx
```

The search prints nothing.

Browser:

1. Select a speaker on stage. Open the attendee player and a replay. Where `setSinkId` exists, those elements use that id, including an element created after the selection.
2. Where `setSinkId` is absent, the page says this browser uses the default speaker and playback still starts.
3. Replace the microphone during a webinar broadcast. The recording mix uses the new track. After stop, the READY replay contains that later audio. A synthetic device is enough for the track-identity check. Leave human audible confirmation unverified unless someone listens.

If no browser is available, leave this pass unverified.

**Browser result:** Unverified on 2026-11-03. No browser tool was available, so the playback script was not run. Human audible confirmation was not made. P3-A03, P3-A05, and P3-A06 stay open.

**Done when:** The output tests pass, the browser result is recorded or explicitly unverified, and the slice is committed.

**Handoff:** No reconnect behavior is included. Capture still stops when the session generation advances.

## 7. V2P2-C06 — README

**Status:** committed\
**Proposed commit message:** `docs(readme): state the in-call device limits`\
**Actual commit:** `5e76061f88b73722d5495a414e21b40fe579eb1e`

**Why:** The product README still says in-call device changes are not implemented. After they exist, the reader needs the lock, restore, loss, and speaker limits beside the other stage limits.

**Depends on:** V2P2-C05.

**Files:**

- `README.md`
- `plans/phase2.md`
- `plans/phase2/guide.md`
- `plans/README.md`

**Implementation:**

1. Replace the sentence that says in-call device changes are not implemented. State that a joined stage member can change camera, microphone, and speaker without leaving.
2. State that mute and a host lock apply to the replacement, that a camera chosen during screen share is restored when the share stops, and that a lost camera or microphone mutes that input and waits for a deliberate choice.
3. State that speaker selection uses `setSinkId` where the browser provides it, including later stage, attendee, and replay elements, and that an unsupported browser keeps the default speaker.
4. State that attendees do not grant capture permission unless promoted, and that the first stage join still requires both a camera and a microphone.
5. Keep P3-A03, P3-A05, P3-A06, and any unverified V2-P1 or V2-P2 browser check explicit. Do not describe reconnect, chat, or accounts as present.
6. Record each slice hash in this guide. Set this phase's status from the verification that actually ran.

**Verification:**

Read the edited README against phase Section 5. `pnpm exec prettier --check README.md plans/phase2.md plans/phase2/guide.md plans/README.md` passes.

**Verification result:** On 2026-11-03 the README was read against phase Section 5. Prettier check of the four documentation files passed. The two-window and playback browser passes were not run. P3-A03, P3-A05, and P3-A06 stay open. V2 Phase 1 browser checks and the WS-03 smoke stay unverified.

**Done when:** The README matches the shipped device behavior and this guide names every slice hash.

**Handoff:** V2-P3 has not been written. Do not add suspension or reconnect in this commit.
