# Guide 4 — Phase 4, commit by commit

**Status:** in progress. P4-C01 is verified; P4-C02 through P4-C04 are not implemented.\
**Last updated:** 2026-11-01.\
**Phase contract:** [../phase4.md](../phase4.md).\
**Product authority:** [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.2`.\
**Deliverable:** Three solo demo peers and a stats drawer, in four commits. This is the only Phase 4 guide.

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `2a68cf5`. Recheck the worktree. Preserve the uncommitted Prettier and Husky edits in the root `package.json` and `pnpm-lock.yaml`. Do not stage them as part of a Phase 4 slice unless that slice actually changes those lines.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run P4-C01 through P4-C04 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing.
4. After verification, commit that slice under master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(phase4): record the final slice hash`.
5. If a browser cannot be used, leave the related acceptance ID unverified and name the gap.
6. Keep the host's current socket, store, and negotiation behavior. Do not replace `reduceNegotiation`.

Do not add promote buttons, FFmpeg, or a migration. Do not lower the active-speaker threshold.

### 1.1 Commit index

| Order | ID     | Proposed message                                            | Acceptance              |
| ----- | ------ | ----------------------------------------------------------- | ----------------------- |
| 1     | P4-C01 | `feat(shared): compute connection deltas from stat samples` | A01                     |
| 2     | P4-C02 | `feat(web-hud): show a connection stats drawer`             | A01, drawer empty state |
| 3     | P4-C03 | `feat(web-bots): negotiate a demo peer on its own socket`   | A02                     |
| 4     | P4-C04 | `feat(web-bots): spawn and remove up to three demo peers`   | A03, A04, A05, A06      |

### 1.2 Files to inspect before editing

- `apps/web/src/live/signaling.ts`, `peer-manager.ts`, `local-media.ts`, `room-store.ts`, and `pages/RoomPage.tsx`
- `apps/web/src/api.ts`
- `packages/shared/src/signaling.ts` and `index.ts`

## 2. P4-C01 — Stat deltas

**Status:** verified\
**Proposed commit message:** `feat(shared): compute connection deltas from stat samples`\
**Actual commit:**

**Why:** The drawer needs rates that do not spike on the first sample or a zero interval. Covers P4-A01.

**Depends on:** The shared Vitest setup.

**Files:**

- `packages/shared/src/stats.ts`
- `packages/shared/src/stats.test.ts`
- `packages/shared/src/index.ts`

**Implementation:**

1. Add the sample and view types and `deltaStats` from phase Section 5.1. Export them. Do not import browser stats types.
2. Tests in this commit, with plain objects:
   - A one-second sample with 125 outbound bytes and 250 inbound bytes reports 1000 and 2000 bits per second.
   - Equal timestamps, a null counter, and a byte counter that decreases each return null rates.
   - 2 lost and 8 received packets report 20 percent. Zero lost and zero received returns null. A negative lost delta returns null.
   - Jitter `0.02` seconds becomes 20 milliseconds. Round-trip `0.05` seconds becomes 50 milliseconds.
   - 24 new frames over one second reports 24 frames per second.
   - `prflx` and null become `unknown`. `host`, `srflx`, and `relay` pass through.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm typecheck
pnpm lint
```

**Verification result (2026-11-01):** Shared tests passed (92 tests, including 20 stats cases). `pnpm typecheck` and `pnpm lint` passed across the workspace. P4-A01 is verified.

**Done when:** P4-A01 passes and the slice is committed.

**Handoff:** Nothing polls `getStats` yet.

## 3. P4-C02 — Stats drawer

**Status:** planned\
**Proposed commit message:** `feat(web-hud): show a connection stats drawer`\
**Actual commit:**

**Why:** The host can inspect the connections they already have. Prepares DEMO-02.

**Depends on:** P4-C01 and the host `PeerManager`.

**Files:**

- `apps/web/src/live/peer-manager.ts`
- `apps/web/src/live/stats-collector.ts`
- `apps/web/src/live/stats-drawer.tsx`
- `apps/web/src/pages/RoomPage.tsx`
- `apps/web/src/index.css`

**Implementation:**

1. Add a read-only listing on `PeerManager` of `{ socketId, getStats }` for current remote connections. Do not change negotiation or track assignment.
2. `stats-collector.ts` polls those callbacks once per second. Map RTP reports into a `deltaStats` sample using phase Section 5.1. Keep the previous sample in the collector, not in React. Publish the view, and stop the timer on close.
3. Add **Connection stats**. The drawer starts closed. Each row uses the remote participant's display name and shows bitrate, loss, jitter, round-trip time, frame rate, and ICE type. Render `—` for null. The empty state says the stage has no remote connections yet.
4. Mount the collector only while the host is on stage. Closing the page and leaving the room stop the timer.

**Verification:**

```powershell
pnpm typecheck
pnpm lint
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/web test
```

With two browsers in one meeting, open the drawer and confirm one row shows numbers or `—`, including an ICE type. Then close it and leave. If a second browser is unavailable, leave this visual check for P4-C04 and say so.

**Done when:** The drawer renders collector output and the slice is committed.

**Handoff:** Demo peers do not exist. The drawer is ready for their connections.

## 4. P4-C03 — One independent demo peer

**Status:** planned\
**Proposed commit message:** `feat(web-bots): negotiate a demo peer on its own socket`\
**Actual commit:**

**Why:** A demo peer has to negotiate without replacing the host session. Covers P4-A02 and the connection split in phase Section 5.2.

**Depends on:** P4-C02. `createGuest` and `PeerManager` exist.

**Files:**

- `packages/shared/src/demo-peers.ts`
- `packages/shared/src/demo-peers.test.ts`
- `packages/shared/src/index.ts`
- `apps/web/src/live/signaling.ts`
- `apps/web/src/live/peer-manager.ts`
- `apps/web/src/live/demo-peer.ts`

**Implementation:**

1. Add `demoPeerNames` and `nextDemoPeerName`. Test that used names are skipped and that three used names return null.
2. Split a socket factory out of `openSignaling` without changing the host behavior. The host factory still updates `useRoomStore` and remains the single host connection. The independent factory takes a token and room id, exposes the same join, media, description, candidate, and leave methods, and accepts `room:state`, `room:ended`, descriptions, and candidates through its own callbacks. It does not call `begin`, `joined`, `receive`, or `clear`.
3. Change `PeerManager` to accept a track source with `microphoneTrack`, `cameraTrack`, and `screenTrack`. `LocalMedia` already has those methods. The host keeps passing `LocalMedia`.
4. `demo-peer.ts` builds one peer: a 640×360 canvas at 24 fps, an oscillator graph, `captureStream(24)`, and an independent socket. The canvas draws the name, the role from that peer's own snapshot, a level bar, and a frame counter. `start(roomId)` expects the caller to have resumed the `AudioContext` in the click. `stop()` leaves the socket, closes its `PeerManager`, stops both tracks, cancels the frame, and closes the audio context. Calling `stop()` twice is safe.
5. The demo source's screen track is null. Its camera track is the canvas track and its microphone track is the oscillator track. It joins with `isSyntheticBot: true`. It calls `PeerManager.sync` only from its own snapshot. Do not add the spawn button in this slice.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm typecheck
pnpm lint
```

Confirm by reading the host factory that spawning is not wired yet and that `openSignaling` still writes the room store.

**Done when:** P4-A02 passes, the independent factory does not reference `useRoomStore`, and the slice is committed.

**Handoff:** The engine can start and stop one peer. The page has no button yet.

## 5. P4-C04 — Spawn and remove

**Status:** planned\
**Proposed commit message:** `feat(web-bots): spawn and remove up to three demo peers`\
**Actual commit:**

**Why:** A reviewer can run the four-tile meeting alone. Covers P4-A03 through P4-A06.

**Depends on:** P4-C03.

**Files:**

- `apps/web/src/pages/RoomPage.tsx`
- `apps/web/src/live/demo-peer.ts`
- `apps/web/src/index.css`
- `README.md`

**Implementation:**

1. Show **Spawn demo peer** only to a joined host. On click, resume the audio context, choose `nextDemoPeerName`, mint the guest, and start the demo peer. Disable the button when three peers are active or a start is in flight.
2. A `stage_full` ack shows the server message and does not leave a roster row or a running canvas. Any other failed start also runs `stop()`.
3. Show **Remove demo peers**. It stops every running demo peer and leaves the host in the room.
4. Run that same full stop from host leave, `room:ended`, host disconnect, and unmount, before the host `LocalMedia.stop()` path finishes. The host camera still stops on host leave.
5. Mark `isSyntheticBot` roster rows with the word `Demo`. Do not auto-promote. Do not give a demo peer a screen-share control.
6. Update the README with the one-machine meeting: join, spawn three peers, open the drawer, and remove them. State that a webinar spawn stays an attendee.

**Verification:**

```powershell
pnpm typecheck
pnpm lint
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/web test
rg -n "getUserMedia|getDisplayMedia" apps/web/src/live/demo-peer.ts
```

The search prints nothing.

In one browser, as the host of a new meeting:

1. Spawn three demo peers. Four tiles are visible. The roster shows the host and three Demo names on stage. The fourth click stays disabled.
2. Open **Connection stats**. Each demo peer has a row. After the first second, bitrate or frame rate is a number, and the ICE type is visible. `host` is a valid type.
3. Mute the host. During a demo pulse, the Speaking label moves to that demo peer. If it never does, raise the pulse and record the gain. Do not change `0.08`.
4. Remove the demo peers. Their tiles disappear, their tracks are `ended`, and the host camera remains available until the host leaves.
5. Leave. The host camera track is `ended`.
6. Create a webinar, join as host, and spawn one demo peer. It is an attendee, the word Demo is visible, and it has no video tile.

Record any failed step. A still screenshot does not verify A03–A06.

**Done when:** P4-A01 through P4-A06 are verified and the slice is committed.

**Handoff:** Phase 5 can promote a demo attendee with the existing stage rules. This phase does not add that button.

## 6. Phase exit

Update the phase acceptance statuses to `verified` only for checks that were actually run. Those lines belong in the P4-C04 commit. The follow-up commit is `docs(phase4): record the final slice hash`.
