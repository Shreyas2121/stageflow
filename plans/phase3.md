# Phase 3 — Meeting mesh

**Status:** implementation verified with automated test media. P3-C01 through P3-C05 are committed. Phase exit remains pending physical-device and native picker observations.\
**Last updated:** 2026-11-01.\
**Master plan:** `MASTER_PLAN.md` version `1.0.2`, Sections 1.4, 8.3, 9, and 16 (Phase 3).\
**Execution guide:** [phase3/guide.md](phase3/guide.md). That guide owns P3-C01 through P3-C05. This file owns the rules those commits must satisfy.\
**Requirement IDs:** RTC-01, RTC-02, RTC-03, RTC-04, RTC-05 for a meeting.

## 1. Outcome

Two people in a meeting see and hear each other. Either one can share a screen, and the other sees that screen in the same video tile. Leaving stops the camera. A webinar guest still has no peer connection and stays on the Phase 2 roster.

Example: Ava and Sam join one meeting from two windows. Sam sees Ava's camera. Ava shares a screen, Sam sees the screen, and when the share ends Sam sees Ava's camera again. Ava leaves, Sam's tile for Ava disappears, and Ava's camera indicator turns off.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-11-01:

- Phase 2 is complete. `HEAD` is `71f4c12` (`docs(phase2): record the final slice hash`). The worktree is clean.
- Join, leave, mute, video-off, and hand state already go through `applyStageCommand` and the Lua scripts. The gateway in `apps/api/src/live/signaling.gateway.ts` emits `room:state` and `room:ended`.
- The join ack already returns `iceServers` from `STUN_URL` and the optional TURN variables. `useRoomStore` stores them. Nothing reads them into a peer connection.
- `LocalMedia` captures one camera stream and one microphone stream, shows the preview, and runs the local meter. `stop()` ends those tracks.
- `packages/shared/src/signaling.ts` has no WebRTC events. The API TypeScript config includes Node types only, so shared types cannot reference DOM WebRTC interfaces.
- The room page says video between people arrives later. Webinar guests never call `getUserMedia`.

Recheck at execution. Do not change join caps, role assignment, or the green-room permission rules. Git follows master Section 1.4.

## 3. Included and excluded

### 3.1 Included

- A pure negotiation reducer and relay decision, with unit tests.
- Gateway relay of descriptions and ICE candidates between two current stage sockets.
- One peer connection per other person on stage, with `sendrecv` audio and video.
- Stage tiles, an active-speaker border, screen sharing by `replaceTrack`, and cleanup on leave.

### 3.2 Excluded

- Demo peers, the stats drawer, and `getStats`.
- Promote, demote, and host-lock buttons. The peer map follows `stageSocketIds`, so a later promotion can open a connection without a second mesh implementation.
- Broadcast, HLS, and FFmpeg.
- A new migration or a change to Redis key layout.
- Mid-call device switching. Devices stay as chosen in the green room.
- Renegotiation for mute, camera-off, or screen share.

## 4. Requirement mapping

| ID | Meaning in this phase |
| --- | --- |
| RTC-01 | An impolite peer ignores a colliding offer. A polite peer accepts it |
| RTC-02 | Candidates that arrive before the remote description are applied in order afterward. Candidates are dropped while an offer is being ignored |
| RTC-03 | Each stage member connects to each other stage member. An attendee is not a relay endpoint |
| RTC-04 | Screen share replaces the video track and restores the camera track when the share ends, without a new offer |
| RTC-05 | Leave, room end, and unmount stop the camera, microphone, and screen tracks, close every peer connection, and stop the meter and speaker loops |

## 5. System contracts

### 5.1 Who gets a connection

`meshPeers(selfSocketId, stageSocketIds)` is every stage socket except `selfSocketId`. If `selfSocketId` is not in the stage list, the result is empty.

The browser keeps one `RTCPeerConnection` for each id that function returns, and closes a connection whose id disappears from the next snapshot. Webinar attendees are absent from the stage list, so they construct none. The fifth meeting joiner is still rejected by the Phase 2 rule.

`canRelay(stageSocketIds, fromSocketId, toSocketId)` is true only when the ids differ and both are in the stage list. The gateway reads the live stage set and drops anything else. It emits to the target socket, not to the whole room.

### 5.2 Negotiation

`isPolite` is `selfSocketId < remoteSocketId`, using ordinary string order.

For a new pair with no remote description, the impolite endpoint schedules the first offer and the polite endpoint waits for it, with both local tracks already attached. This follows master Section 9.2 revision 1.0.2. Repeated Chromium runs found simultaneous initial offers could leave ICE transports in `new` after rollback; serializing initial offer creation removed that stall in the repeated browser checks. The shared reducer remains the only incoming glare policy and every subsequent negotiation request still calls it.

The shared reducer owns the collision rule. The peer manager calls it and does not repeat the boolean test. Flags are `polite`, `makingOffer`, `ignoreOffer`, `isSettingRemoteAnswerPending`, `signalingState`, and `remoteDescriptionSet`.

For an incoming offer:

```text
readyForOffer = !makingOffer && (signalingState === "stable" || isSettingRemoteAnswerPending)
offerCollision = !readyForOffer
ignoreOffer = !polite && offerCollision
```

The impolite peer ignores that offer and does not touch the connection. The polite peer accepts it. `setRemoteDescription` performs the rollback. Do not send a hand-rolled rollback description.

`negotiationneeded` sends an offer only when the state is `stable` and `makingOffer` is false. A second request while an offer is in flight does nothing. Both transceivers exist, with the local camera and microphone tracks assigned, before that first offer. A disabled camera track is still assigned.

An ICE candidate is queued while `remoteDescriptionSet` is false. After the remote description is applied, queued candidates flush in arrival order. While `ignoreOffer` is set, a candidate is dropped and is not queued. A later accepted description clears `ignoreOffer`.

The unit tests cover glare for both roles, a non-colliding offer, a stable `negotiationneeded`, a suppressed second offer, queued candidate order, and a dropped candidate during ignore.

### 5.3 Relay payloads

Shared types stay free of DOM interfaces. A description is `{ type: "offer" | "answer"; sdp: string }`. A candidate is `{ candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }`. `null` marks the end of candidates and is relayed under the same rule.

Client events `webrtc:description` and `webrtc:ice-candidate` carry `toSocketId` plus that payload, and they ack. The server adds `fromSocketId` and emits the matching server event to the target socket. Failures:

| Error | When |
| --- | --- |
| `not_on_stage` | `canRelay` is false |
| `peer_unavailable` | The target socket is not connected in this room |
| `invalid_payload` | The description or candidate shape is wrong |

`not_on_stage` message: `Only people on stage can exchange media.` `peer_unavailable` message: `That person is no longer on stage.`

Mute and camera-off stay on `media:state` and `track.enabled`. They do not send an offer.

### 5.4 Screen share and the active speaker

Screen share calls `getDisplayMedia` for video, then `replaceTrack(screenTrack)` on the video sender of every current peer. It then sends `media:state` with `isScreenSharing: true`. It does not create an offer. The camera track stays live so it can be restored.

`screenTrack.onended`, including the browser's own stop control, restores the camera with `replaceTrack`, stops the screen track, and sends `isScreenSharing: false`. A second share stops the previous screen track first. Cancelling the picker leaves the camera in place and does not send `isScreenSharing: true`. If the camera is off, the restored track stays disabled.

The active-speaker border uses an `AnalyserNode` on each playing stage audio track. The highlighted socket is the highest level at or above `0.08`, and a new leader must hold that lead for 300 ms. Below the threshold, the highlight clears. This writes nothing to Redis.

### 5.5 Tiles and cleanup

Stage members see a tile for each current stage participant, including themselves. One tile fills the frame, two sit side by side, and three or four use a two-by-two grid. While a participant has `isScreenSharing`, that tile is the large frame and the other stage tiles are a strip. A video-off tile shows the name and the words `Video off`. Remote tiles are audible. The local tile stays muted. The roster remains.

Attendees do not see stage tiles and do not start the peer manager. Their page stays the green-room roster and hand control.

Leave, `room:ended`, an unexpected disconnect, and unmount close every peer connection, set every tile `srcObject` to null, stop the camera, microphone, and screen tracks, close the meter and speaker audio contexts, and cancel their animation frames. The existing `LocalMedia.stop()` remains the owner of the camera and microphone tracks. Extend it so it also stops an active screen track.

## 6. Acceptance matrix

| ID | Observable result | Method | Status |
| --- | --- | --- | --- |
| P3-A01 | Glare, candidate order, candidate drop, and the empty mesh for an attendee pass | `pnpm --filter @stageflow/shared test` | verified (2026-11-01; 72 tests passed) |
| P3-A02 | A description between two stage sockets is delivered to the target only. An attendee send is `not_on_stage` | Gateway check with two sockets, plus the `canRelay` tests | verified (2026-11-01; live relay and attendee rejection passed) |
| P3-A03 | Two meeting browsers show each other's camera and play remote audio | Browser | automated test media and speaker changes verified (2026-11-01); physical microphone and human audible output unverified |
| P3-A04 | Mute and camera-off do not send a new offer. The other tile stays up, and the roster flag changes | Browser | verified (2026-11-01; Chromium test media) |
| P3-A05 | Screen share replaces the remote picture and restores the camera when sharing stops | Browser | automated screen-fixture pixels, restoration and no new offers verified (2026-11-01); native picker and browser stop UI unverified |
| P3-A06 | Leave closes the remote tile, ends local tracks, and turns the camera indicator off when it can be seen | Browser | automated camera/microphone/screen and peer cleanup verified on leave, navigation and room end (2026-11-01); physical camera indicator unverified |
| P3-A07 | A webinar guest has no remote tile and no peer connection | Browser | verified (2026-11-01; zero capture calls and connections) |

RTC-01 and RTC-02 are A01. RTC-03 is A01, A02, A03, and A07. RTC-04 is A05. RTC-05 is A06.

## 7. Verification commands

```powershell
pnpm --filter @stageflow/shared test
pnpm typecheck
pnpm lint
docker compose up -d
pnpm --filter @stageflow/api dev
pnpm --filter @stageflow/web dev
```

Phase 2 regression: a second meeting guest still appears on the roster, and a fifth join is still rejected. Search:

```powershell
rg -n "getStats|hls\.js|ffmpeg" apps packages -g "!dist/**" -g "!node_modules/**"
```

No matches is the pass. `RTCPeerConnection` in `apps/web/src/live` is expected. It is not expected under `apps/api`.

## 8. Risks

| Risk | What to do |
| --- | --- |
| The manager copies the glare test instead of calling the reducer | One function owns the condition. Tests import that function |
| An attendee receives an offer because the handler emits to the room | Emit to the target socket after `canRelay` |
| Screen share calls `addTrack` and renegotiates | `replaceTrack` only. The camera track is the one captured before join |
| Leave stops the socket and leaves the peer connection open | Close the peer map in the same path as `LocalMedia.stop()` |
| Shared types import `RTCSessionDescriptionInit` and the API stops compiling | Use the structural payload in Section 5.3 |

## 9. Exit and handoff

Phase 3 is done when A01–A07 are verified and each slice has been committed under master Section 1.4. Phase 4 may rely on:

- The negotiation reducer and a peer map keyed by stage socket id.
- `iceServers` from the join ack.
- Local camera and microphone tracks that survive screen share and stop on leave.
- Tiles that render one `MediaStream` per stage socket.

Phase 4 adds demo peers and the stats drawer on top of those connections. It does not replace the negotiation rule. Do not write `plans/phase4.md` until that work starts.

## 10. Implementation verification record (2026-11-01)

All five slices have implementation and automated verification. Shared tests: 72; web tests: 9; API Redis tests: 19. Workspace typecheck, lint, web production build, and the excluded-feature search passed. Four repeated browser screen-share flows and an expanded four-person mesh/fifth-rejection flow passed after master revision 1.0.2. The native screen picker and stop UI, human audible playback, physical microphone input, and physical camera indicator still need observation. These gaps keep the full phase exit open; no Phase 4 plan has been written.
