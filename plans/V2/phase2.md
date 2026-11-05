# V2 Phase 2 — In-call devices

**Status:** V2P2-C01 through V2P2-C06 are committed. MEDIA-01 has a synthetic two-window result. MEDIA-03's physical unplug, MEDIA-04 playback, and P3-A05 remain unverified.\
**Last updated:** 2026-11-05.\
**Master plan:** `MASTER_PLAN_V2.md` version `2.0.0-draft.3`, Sections 1, 5, 7, 10, 11, and 12 (MEDIA-01 through MEDIA-04). Unchanged mesh, lock, and broadcast rules stay in `MASTER_PLAN.md` version `1.0.9`.\
**Execution guide:** [phase2/guide.md](phase2/guide.md). That guide owns V2P2-C01 through V2P2-C06. Those ids are not the V1 commits in [V1/phase2/guide.md](../V1/phase2/guide.md). This file owns the rules those commits must satisfy.\
**Requirement IDs:** MEDIA-01, MEDIA-02, MEDIA-03, MEDIA-04.

## 1. Outcome

A person already on stage changes camera, microphone, or speaker without leaving the room. The other stage members hear and see the replacement through the same peer connections. Mute and a host lock still hold on the new device. Choosing a camera while sharing a screen does not interrupt the share, and stopping the share returns to that camera. Unplugging a camera or microphone leaves the room open and does not switch to another input by itself.

Example: Ava is in a meeting with Sam. She selects a second camera. Sam's tile shows that camera, and the peer count stays the same. She mutes, selects a second microphone, and Sam still hears silence. She shares her screen, selects a third camera, and Sam still sees the screen. She stops sharing and Sam sees the third camera. She unplugs the microphone. The room stays open, her microphone is muted, and no other microphone turns on until she chooses one.

`LIVE` catalog status is still not presence. This phase does not change the room list.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-11-03. `HEAD` is `856907d7ba1e6d5cb936800ee0749871b96abd22` (`docs(v2-phase1): record the final slice hash`). Recheck the worktree at execution.

V2-P1 slices V2P1-C01 through V2P1-C05 are committed. The browser checks for WS-01 through WS-03, and the WS-03 smoke, remain unverified. V1 physical observations P3-A03, P3-A05, and P3-A06 remain open. This phase does not record those gaps as passed.

Observed in that tree:

- Device selects exist only in the green room. `LocalMedia.prepare` stops every owned track, including a screen share, then acquires a camera and a microphone again. Join calls `releaseLobby` and hides the green room. A joined stage member has no camera or microphone select.
- `prepare` is also the promotion-consent path. Attendees do not call `getUserMedia` unless they are promoted and consent.
- `PeerManager.replaceVideoTrack` replaces the video sender on each current peer. Screen share uses it. There is no audio equivalent. New peers call `addTrack` once for the current microphone and for either the live screen track or the camera track. Each connection has one audio transceiver and one video transceiver.
- Mute and host locks are `track.enabled` flags applied by `RoomSession.applyLocalFlags`. The server fields are `isAudioMuted`, `isVideoOff`, `hostAudioLocked`, and `hostVideoLocked`. Unmute and camera-on controls stay disabled while the matching lock is held.
- `ActiveSpeaker.sync` drops an analyser when the track object changes. `StageRecorder.rebuildMix` does the same for its source nodes when `stageSources` publishes a different track. `stageSources` reads `LocalMedia.microphoneTrack` for the local member. Nothing calls that refresh after an in-call microphone change, because that change does not exist.
- `routeAudioOutput` uses `setSinkId` when the element has it. The green-room preview and remote stage tiles use the room session's `speakerId`. The local tile is muted and skips output routing. The attendee broadcast player and the replay player do not.
- A screen track's `onended` stops the share and restores `cameraTrack`. Camera and microphone tracks have no ended handler. There is no `devicechange` listener.
- Leaving, room end, disconnect, and page hide call `teardownLocal`, which increments `RoomSession.generation` and stops local media. Demotion stops media through `onDemoted` and does not increment that generation.
- Initial join still requires both a camera and a microphone for a stage member. Webinar attendees join with no capture.

Recheck at execution. Git follows V1 master Section 1.4. A missing browser leaves the browser half of MEDIA-01 through MEDIA-04 unverified. A missing physical microphone, speaker, camera, or native screen picker leaves that observation unverified. Neither gap authorizes a second peer connection or an automatic device switch.

## 3. Included and excluded

### 3.1 Included

- Serialized replacement of the camera or the microphone while on stage.
- `replaceTrack` on the existing audio and video senders, with rollback when a sender rejects the replacement.
- Host locks and mute applied to the new track before any sender or recorder receives it.
- A camera chosen during screen share, used when the share stops.
- Refresh of the active-speaker graph and the host recording mix after a new microphone track is published.
- Device loss that mutes or turns video off without leaving the room, and a deliberate retry.
- One speaker choice applied to current and later playback elements, including the attendee broadcast and the replay.
- README text for these limits.

### 3.2 Excluded

These are the exclusions this phase is most likely to violate. V2 master Sections 3.2, 7.2, and 8 still apply.

- A fifth stage slot, an extra peer connection, or an extra audio or video transceiver.
- `restartIce`, reconnect, suspension, or keeping capture alive across a socket drop.
- Audio-only join, listen-only stage entry, or an attendee `getUserMedia` call. Promotion still waits for the existing consent step.
- Silently activating a different input after a failure or a device-loss event.
- Automatic screen-share resume, a second video track beside the screen, or a server-side device id.
- Chat, accounts, scheduling, and a new recording format.
- Closing P3-A03, P3-A05, P3-A06, or the unverified V2-P1 browser and smoke checks.
- Claiming that `setSinkId` works in every browser. Unsupported output stays on the default speaker and says so.

## 4. Requirement mapping

| ID       | Meaning in this phase                                                                                                                                                                 | What this phase does not claim                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| MEDIA-01 | A camera or microphone change reaches every current peer through `replaceTrack`. The peer count and the transceiver count stay the same. The previous track is stopped after success  | A new offer for every hardware format, or a second video sender      |
| MEDIA-02 | Mute and host locks are already applied when the new track is attached. A camera chosen while sharing is the camera restored when the share stops                                     | Native picker observation, which remains P3-A05                      |
| MEDIA-03 | A denied replacement keeps the previous device. A lost camera or microphone mutes that input and stays in the room. A late track after leave or demotion is stopped                   | An automatic fallback device                                         |
| MEDIA-04 | The selected speaker is applied to current and later playback elements where `setSinkId` exists. A replaced microphone is the track published to the stage mix and the host recording | Proof that a physical room heard it, unless that observation is made |

## 5. System contracts

### 5.1 Who can replace a device

A joined stage member can replace a camera or a microphone. An attendee cannot, including while the promotion consent step is still open. Consent continues to use `prepare`. Off-stage members, a leaving session, and a torn-down session do not call `getUserMedia` for a replacement.

The green room may keep `prepare` before the first join. `prepare` still acquires both kinds and still stops owned tracks. An in-call change must not call `prepare`. Calling it on stage would drop the screen share and the other input, then leave the existing senders on the stopped tracks.

Device ids are not socket fields and are not catalog fields. The server still learns mute, video-off, and screen-share only through the existing media commands.

### 5.2 Replacement

One replacement runs at a time. Each attempt has a generation taken when it starts. Leave, room end, disconnect, page hide, and demotion must cancel it. `onDemoted` today stops media without incrementing `RoomSession.generation`; this phase includes demotion in the same cancellation as `teardownLocal`.

The attempt acquires only the requested kind. An empty id asks for the browser default, using the same constraint shape as `prepare`. A non-empty id uses an exact device id. The other kind stays live, and a live screen share stays live.

The current mute, video-off, and host-lock flags are applied to the new track before it is passed to a sender, the local preview, the active-speaker graph, or the recording mix. A locked kind stays disabled. The replacement does not send an unmute.

The stored camera or microphone stays the previous track until the attempt commits. `microphoneTrack` and `cameraTrack` keep returning that previous track while senders are still being updated, so a mix rebuild during the attempt does not publish an uncommitted track.

On success, every current peer's sender of that kind receives the new track through `replaceTrack`. Peer count and transceiver count do not change. After every sender accepts it, the attempt commits: the new track becomes the stored track, and only then is the previous track of that kind stopped and its meter, analyser, and recording nodes released. The new microphone is then published through the existing `syncSpeaker` and `syncBroadcast` paths. `StageRecorder.rebuildMix` already replaces its nodes when the track object changes. Do not give the recorder a second mix.

A camera change during screen share updates the stored camera and does not call `replaceVideoTrack`. The outgoing video remains the screen track. `stop` on the screen-share controller already restores `cameraTrack`. That restored track is the camera from the latest successful change, with the current video-off and video-lock flags already applied.

If acquisition throws, the previous tracks stay live and the visible error names the kind that failed. No sender changes.

If one sender rejects `replaceTrack`, every sender of that kind is pointed back at the previous track, which is still live because it has not been stopped. The new track is stopped and the stored track stays the previous one. Peers must not remain on different devices. If the rollback itself fails, stop the new track, disable or clear that kind, show the error, and keep the room. Do not add a transceiver to finish the attempt.

A newer attempt or a cancelled generation stops the late track immediately and does not attach it.

The browser may reject a particular format. Report that failure and restore the previous track. Do not add a second transceiver and do not promise that every replacement avoids negotiation.

Remote playback keeps the existing `ontrack` path: one track per kind on the remote stream. A local microphone change does not create a peer. The remote element that is already playing that stream continues to play it.

### 5.3 Device loss

Listen for `devicechange` while the session is attached, and for `ended` on the owned camera and microphone tracks. Refresh the device list when enumeration changes. Adding a device does not select it.

A camera track that ends, or a selected camera id that disappears, marks the camera unavailable and video off. A microphone track that ends, or a selected microphone id that disappears, marks the microphone unavailable and muted. Publish those flags with the existing media command when the member is on stage. Do not leave the room and do not start another capture.

A camera that ends during screen share does not stop the share and does not replace the outgoing screen track. The stored camera is unavailable. Stopping the share must not send that ended track. The member stays on stage with video off until a camera replacement succeeds.

The default device is represented by an empty id. Its loss is the ended track, not a missing id in the device list.

The recovery control runs the same replacement for the id the member chooses. It does not invent an id. Failure leaves the unavailable state in place.

### 5.4 Speaker output

One selected output id is shared by the green room, the stage, the attendee player, and the replay player in this tab. Persist it only as a device id in `sessionStorage`. Storage failure keeps the choice in memory. Do not store labels, tokens, or media.

Apply it through `routeAudioOutput` to every applicable playback element, including an element created after the choice. Applicable elements are remote stage videos, the attendee broadcast video, and the replay video. The local stage tile stays muted. A missing `setSinkId` reports the output as unsupported and leaves the default speaker, with the existing sentence that this browser uses the default speaker.

The saved id changes when the member chooses a new output and every current element accepts it, or when the member chooses the default. If an element rejects an explicit change, restore the previous saved id and show the error. V2R-C07 resets the saved choice and bound elements to default if the previous output cannot be restored, or if a newly created element rejects the saved id. An unsupported new element also resets the choice to default. The failed binding reports its error to both the player and the live/replay speaker controls; it is not described as successfully routed to the saved speaker. A later element receives the current saved id when it is created.

An attendee may change the speaker. That control does not call `getUserMedia`. An empty output list still offers the default speaker and does not request capture to obtain labels.

V2R-C07 initializes the allowed device list after successful join and resume, independently of capture. Enumeration failures keep the existing list and do not block joining. The browser's permitted devices and labels are used as returned. The latest enumeration request wins, and results from before leave, page exit, or disposal are ignored. Explicit preparation uses the same request ordering so an older enumeration cannot overwrite a newer device list. The existing native selects remain mounted across refreshes.

### 5.5 Stage controls

A joined stage member sees camera, microphone, and speaker selects. Changing a camera or microphone calls replacement, not `prepare`. The control for the kind in flight is unavailable until the attempt settles. An error uses `role="alert"`.

An attendee sees the speaker select and no camera or microphone select. Promotion still shows the green room and its enable action before capture.

A lost input shows that the room is still open and that another device starts only when chosen. The selects are native controls and remain keyboard reachable.

### 5.6 What stays unchanged

The four-person mesh, Perfect Negotiation, demo peers, host locks, screen share, ordered upload, and the single 720p recording stay. Initial stage join still requires both permissions. Replay links stay available to any guest who has the link. The home page still must not contain the letters `hls`.

## 6. Acceptance matrix

| ID       | Observable result                                                                                                                                                                                                                            | Method                                                                                       | Status                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| MEDIA-01 | With two current peers, a camera change and a microphone change each call `replaceTrack` and do not change the peer count or transceiver count. The replaced track is stopped. A remote stream still has one audio track and one video track | `peer-manager` and `room-session` tests, then a two-window browser check                     | tests passed; synthetic browser partial      |
| MEDIA-02 | A muted or host-locked replacement is disabled before `replaceTrack`. A camera id chosen during screen share is the track restored when the share stops, and the screen sender is not replaced by that camera                                | Service tests. Native picker observation stays P3-A05 unless it is actually repeated         | tests passed; synthetic restore; P3-A05 open |
| MEDIA-03 | Acquisition failure keeps the previous live tracks. Leave and demotion during acquisition stop the late track and do not attach it. An ended microphone mutes and stays joined. No second device is opened                                   | `local-media` and `room-session` tests. Physical unplug stays unverified unless observed     | tests passed; unplug unverified              |
| MEDIA-04 | A speaker id chosen before a playback element exists is applied when that element is created. Unsupported output shows the default-speaker sentence. The recording mix receives the replaced microphone track                                | Output tests and a browser playback check. Human audible proof stays unverified unless heard | output tests passed; browser unverified      |

A missing browser, disposable FFmpeg run, physical device, or native picker leaves only that method unverified. On 2026-11-03 the V2P2-C04 web tests passed and the V2P2-C05 output tests passed. On 2026-11-04 the combined session changed the host camera, microphone, and speaker while the second peer stayed connected, the peer count stayed the same, and the remote video stayed live. Synthetic screen share selected a restore camera and stopped sharing. The native picker was not used, so P3-A05 stays open. Chrome's fake tracks did not dispatch `ended`; the existing handler showed the camera-stopped sentence and **Try this camera** cleared it. That is not a physical unplug, so MEDIA-03 stays unverified for unplug. MEDIA-04 playback was not run. Human audible confirmation was not made. The README states the shipped device limits. P3-A03, P3-A05, and P3-A06 stay open. The WS-03 smoke stays unverified.

## 7. Verification commands

**V2R-C07 maintenance verification (2026-11-05):** Web tests passed (352 across 27 files), including 88 room-session and 19 output-route tests. Eleven new regressions failed before the implementation. Coverage includes attendee initialization without capture, empty/rejected/unavailable enumeration, stale results after leave and a new join, a newer devicechange winning over join/prepare enumeration, saved-sink binding failure and unsupported output, default fallback across existing elements, failed rollback, final-result notification, ignored late unbound failures, and listener disposal. Existing output rollback, storage-failure, capture, reconnect, chat, and deferred-player checks remain passing. Web typecheck, lint, build, and web artifact checks passed. In isolated Chrome 156.0.8078.80 on Windows, the actual RoomSession, LocalMedia, SpeakerSelect, BroadcastPlayer, and ReplayPage passed initial attendee enumeration, stable select focus during devicechange, visible live/replay saved-sink errors, selector/storage reset to default, successful explicit reselection with error clearing, and zero capture calls. Signaling, device enumeration, and sink routing were controlled; media requests were blocked. This is no decoded playback or human audible-output result. MEDIA-04 playback/audibility and the earlier physical/native-picker observations remain open.

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
rg -n "hls" apps/web/src/pages/HomePage.tsx
```

The search prints nothing.

The two-window check uses the local web app and API. Synthetic devices are enough for the repeatable browser pass. Physical microphone, speaker, camera-indicator, and native screen-picker results stay open unless they are observed in this phase.

## 8. Risks

| Risk                                                                             | What to do                                                            |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| In-call selection calls `prepare` and drops the screen share and the other input | Section 5.1. Replacement acquires one kind                            |
| A failed sender leaves peers on different devices                                | Section 5.2. Roll every sender back or mark the kind unavailable      |
| The new track is attached before the lock disables it                            | Section 5.2. Apply flags before any sender or recorder sees the track |
| Camera loss during a share replaces the screen sender                            | Section 5.3. The screen track stays the outgoing video                |
| Device loss selects the next enumerated input                                    | Section 5.3. Wait for a deliberate choice                             |
| Demotion lets a late `getUserMedia` turn the camera back on                      | Section 5.2. Demotion cancels the attempt and stops the late track    |
| The speaker control calls `getUserMedia` for an attendee or a replay             | Section 5.4. Output routing does not acquire an input                 |
| A second transceiver is added because `replaceTrack` rejected a format           | Section 5.2. Restore the previous track and report the error          |
| Reconnect or chat is added so device recovery survives a refresh                 | Section 3.2. Those phases are not started                             |

## 9. Exit and handoff

V2-P2 is done when MEDIA-01 through MEDIA-04 have a result, each slice is committed under V1 master Section 1.4, and the README describes on-stage device changes, lock behavior, screen-share restore, device loss, and the speaker fallback. Unverified browser, physical, and native-picker checks stay named. P3-A03, P3-A05, P3-A06, and the V2-P1 browser and smoke gaps stay open.

On 2026-11-03 the README states those limits. V2P2-C01 through V2P2-C06 are committed. The two-window and playback browser passes were not run.

V2-P3 may rely on local capture stopping when the session generation advances, and on one audio sender and one video sender per peer. It may not rely on reconnect. The replacement cancel used by leave and demotion is the cancel V2-P3 must call when a member is suspended. Do not implement suspension in this phase.

V2 phase 3 is specified in [phase3.md](phase3.md). That file does not authorize implementation.
