# Phase 4 — Demo peers and stats

**Status:** in progress. P4-C01 stat deltas and P4-C02 connection stats drawer are verified; P4-C03 and P4-C04 remain planned.\
**Last updated:** 2026-11-01.\
**Master plan:** `MASTER_PLAN.md` version `1.0.2`, Sections 1.4, 2.2 (steps 1–5), 10, and 16 (Phase 4).\
**Execution guide:** [phase4/guide.md](phase4/guide.md). That guide owns P4-C01 through P4-C04. This file owns the rules those commits must satisfy.\
**Requirement IDs:** DEMO-01, DEMO-02, and RTC-05 after the demo peers are removed.

## 1. Outcome

One browser can show a four-person meeting. The host spawns three demo peers, sees four tiles, watches a demo peer take the Speaking label when it pulses, and opens a drawer with live stats for each connection. Removing the demo peers releases their canvases and audio. The host's own leave still releases the camera.

Example: Ava joins a meeting and clicks **Spawn demo peer** three times. The roster shows Ava plus Demo Peer 1, 2, and 3. The drawer shows bitrate, loss, jitter, round-trip time, frame rate, and an ICE type for each demo peer. A fourth click does nothing. Leaving removes the tiles and ends the demo tracks.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-11-01:

- Phase 3 slices are committed. `HEAD` is `2a68cf5` (`docs(phase3): record the final slice hash`). Physical microphone, audible output, camera-indicator, and native screen-picker observations are still pending in the Phase 3 record. Phase 4 does not close that record and does not repeat the screen-share picker check.
- The worktree also has uncommitted root `package.json` and `pnpm-lock.yaml` edits that add Prettier, Husky, and lint-staged. Preserve them. Do not revert them, and do not include them in a Phase 4 slice unless that slice is the one that needs those files.
- `openSignaling` is a single human connection. It closes the previous connection and writes `useRoomStore`. A second call would drop the host.
- `PeerManager` reads `microphoneTrack`, `cameraTrack`, and `screenTrack` from `LocalMedia`. Negotiation stays in `reduceNegotiation`.
- Join already accepts `isSyntheticBot` and stores it. Nothing in the web app sets it to true.
- `createGuest` already mints a session from a display name.

Recheck at execution. Git follows master Section 1.4.

## 3. Included and excluded

### 3.1 Included

- `deltaStats` and fixture tests that never open a peer connection.
- A once-per-second collector and a closed-by-default stats drawer on the human's stage connections.
- Three demo peers, each with its own guest session, socket, canvas, tone, and peer connection when it is on stage.
- Spawn and remove controls for the host, and cleanup when the host leaves or the room ends.

### 3.2 Excluded

- A fourth demo peer, auto-promote, and promote or demote buttons.
- Changes to the glare reducer, the 4-person cap, or the active-speaker threshold of `0.08`.
- `getUserMedia` or `getDisplayMedia` for a demo peer.
- Server changes to join privileges. `isSyntheticBot` remains a display flag.
- Broadcast, HLS, and FFmpeg.
- A new migration.

## 4. Requirement mapping

| ID      | Meaning in this phase                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DEMO-01 | Three demo peers on one page negotiate real peer connections. Meeting peers sit on stage. A webinar peer joins as an attendee and does not open a connection |
| DEMO-02 | The drawer shows, per human-side peer, outbound and inbound bitrate, packet loss, jitter, round-trip time, frame rate, and ICE type                          |
| RTC-05  | Removing every demo peer stops its canvas, tone, and tracks. The host leaving still stops the host camera                                                    |

## 5. System contracts

### 5.1 Stats

`deltaStats(previous, next)` lives in `@stageflow/shared`. Both samples are plain numbers, not a browser stats report. A missing counter is `null`.

| Field                        | Rule                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Outbound and inbound bitrate | `(bytesDelta * 8) / secondsDelta`. `secondsDelta <= 0`, a null counter, or a byte counter that moves backward yields `null` |
| Packet loss percent          | `lostDelta / (lostDelta + receivedDelta) * 100`. A null counter, a negative delta, or a zero denominator yields `null`      |
| Jitter                       | Pass through the inbound jitter sample, converted from seconds to milliseconds. Null stays null                             |
| Round-trip time              | `currentRoundTripTime` seconds times 1000. Null stays null                                                                  |
| Frames per second            | `framesDelta / secondsDelta`, with the same null and backward rules as bitrate                                              |
| ICE type                     | `host`, `srflx`, `relay`, or `unknown`. Any other local type, including `prflx`, is `unknown`                               |

The collector maps `getStats()` into those numbers and keeps the previous sample outside React. It sums RTP byte and packet counters. It does not also add candidate-pair byte counters. Jitter prefers the inbound audio report, then the inbound video report. Round-trip time and ICE type come from the nominated candidate pair. Frame rate comes from the inbound video report. The poll interval is one second. The first sample has no delta, so the rates are `null`.

On one machine the ICE type may be `host`. That satisfies the drawer. A relay candidate is not required.

### 5.2 Demo peers

`demoPeerNames` is `Demo Peer 1`, `Demo Peer 2`, and `Demo Peer 3`. `nextDemoPeerName` returns the first name that is not in use, or `null` when all three are in use.

Only a joined host sees **Spawn demo peer**. The click resumes an `AudioContext` before creating the tone. The engine then:

1. Mints a guest session with `createGuest` and the chosen name.
2. Opens a Socket.IO connection that is not the human connection.
3. Draws a 640×360 canvas at 24 frames per second with the name, the role from that peer's own snapshot, a level bar, and a frame counter.
4. Plays a short low-gain oscillator pulse every 4 seconds from that same click-resumed context.
5. Joins with `isSyntheticBot: true` and the normal mute flags false.

The human path keeps `openSignaling`, `useRoomStore`, and the host's `selfSocketId`. A demo connection must not call `begin`, `joined`, `receive`, or `clear` on that store, and it must not close the host socket. The host's existing `room:state` events already include the demo peers, so the host mesh connects to them through the current `PeerManager.sync`.

Each demo peer that is on stage runs its own `PeerManager` against its own socket and ICE list. `PeerManager` takes a track source with `microphoneTrack`, `cameraTrack`, and `screenTrack`. `LocalMedia` remains the host source. A demo source returns the canvas track, the oscillator track, and a null screen track. A demo attendee is not on stage, so `meshPeers` is empty and it opens no connection.

A meeting demo peer becomes a speaker when a slot remains, and the join ack `stage_full` leaves the roster unchanged. A webinar demo peer becomes an attendee. Spawning does not promote. A failed join discards that peer's socket, canvas, and audio context.

The fourth click stays disabled. Removing one peer leaves the others. Removal, host leave, room end, host disconnect, and unmount each leave the demo socket, close its peer connections, stop its tracks, cancel the canvas frame, and close its audio context.

The pulse is tuned so a remote stage tile crosses the existing `0.08` level. Do not change that threshold. Mute the host microphone during the check if the host mic would otherwise hold the Speaking label.

### 5.3 Drawer

The drawer is closed until the host opens **Connection stats**. It lists one row for each remote connection in the host's `PeerManager`, labeled with that participant's display name. Each row shows the fields from Section 5.1, using `—` for null. An empty list says the stage has no remote connections yet. Opening the drawer does not create a peer connection.

Roster rows with `isSyntheticBot` include the word `Demo`.

## 6. Acceptance matrix

| ID     | Observable result                                                                                                           | Method                                 | Status                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| P4-A01 | Bitrate, loss, frame rate, and ICE type follow Section 5.1, including a zero interval and zero packets                      | `pnpm --filter @stageflow/shared test` | verified (2026-11-01; 92 shared tests passed) |
| P4-A02 | Name selection returns the first free demo name and null after three                                                        | Shared test                            | planned                                       |
| P4-A03 | Three meeting demo peers appear as tiles and as stage members. Stats update for each. One pulse moves Speaking to that peer | Browser                                | planned                                       |
| P4-A04 | The fourth spawn stays disabled. A full meeting rejects another demo join without a new roster row                          | Browser                                | planned                                       |
| P4-A05 | A webinar demo peer is an attendee, has no tile, and is not promoted                                                        | Browser                                | planned                                       |
| P4-A06 | Removing the demo peers stops their tracks and frames. The host leaving still ends the host camera track                    | Browser                                | planned                                       |

DEMO-01 is A03 and A05. DEMO-02 is A01 and A03. RTC-05 for this phase is A06.

## 7. Verification commands

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
docker compose up -d
pnpm --filter @stageflow/api dev
pnpm --filter @stageflow/web dev
```

Search:

```powershell
rg -n "getDisplayMedia|hls\.js|ffmpeg" apps/web/src/live apps/web/src/pages -g "!**/*.test.ts"
```

A demo-peer file that matches `getUserMedia` or `getDisplayMedia` fails the check. The host green room may still call `getUserMedia`.

## 8. Risks

| Risk                                                                 | What to do                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| The second socket reuses `openSignaling` and drops the host          | Section 5.2. The demo factory must not touch the human store |
| The bot is only a canvas and never negotiates                        | The demo peer runs `PeerManager` while it is on stage        |
| Stats parse candidate-pair bytes and RTP bytes together              | Section 5.1 sums RTP counters only                           |
| The pulse is too quiet to move Speaking, so the threshold is lowered | Keep `0.08`. Raise the pulse and record the value            |
| Removing a bot leaves an `AudioContext` or a frame loop              | Section 5.2 cleanup runs on every removal path               |

## 9. Exit and handoff

Phase 4 is done when A01–A06 are verified and each slice has been committed under master Section 1.4. This is the early portfolio gate: one machine, three demo peers, four tiles, and the stats drawer.

Phase 5 may rely on demo attendees appearing in the roster with `isSyntheticBot: true`, and on a stage demo peer already having a peer connection. Promotion UI is still absent. Do not write `plans/phase5.md` until that work starts.
