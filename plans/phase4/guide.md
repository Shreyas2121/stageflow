# Guide 4 — Phase 4, commit by commit

**Status:** complete. P4-C01 through P4-C04 are committed; P4-A01 through P4-A06 are verified.\
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

**Status:** committed\
**Proposed commit message:** `feat(shared): compute connection deltas from stat samples`\
**Actual commit:** `2b8b0a08fa17e44801c87ca1f531f29badcdc24b`

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

**Status:** committed\
**Proposed commit message:** `feat(web-hud): show a connection stats drawer`\
**Actual commit:** `46852ecdf272e7b4588953a26fd3b7c7044b1027`

**Why:** The host can inspect the connections they already have. Prepares DEMO-02.

**Depends on:** P4-C01 and the host `PeerManager`.

**Files:**

- `apps/web/src/live/peer-manager.ts`
- `apps/web/src/live/stats-collector.ts`
- `apps/web/src/live/stats-collector.test.ts`
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

**Verification result (2026-11-01):** `pnpm typecheck`, `pnpm lint`, shared tests (92), and web tests (16, including seven collector tests) passed. Collector tests cover RTP-only sums, audio/video jitter preference, nominated candidate selection, null first-sample rates, one-second polling, removed connections, failed reads, overlapping requests, and cleanup with an in-flight report.

Two independent Chrome contexts with fake camera/microphone devices joined a real meeting. The host drawer started closed, rendered the empty state before the guest joined, then displayed the guest's name and all seven metrics, including numeric bitrate/frame rate and ICE type `host`. Opening and closing the drawer did not create or replace a connection. The guest had no host drawer. Guest leave removed its row; host leave stopped the collector timer and further stats reads. Navigating away also stopped the timer. Captured tracks ended on both host cleanup paths. Screenshots were inspected. This verifies the P4-C02 browser check; P4-A03 through P4-A06 still await demo peers in P4-C04.

**Done when:** The drawer renders collector output and the slice is committed.

**Handoff:** Demo peers do not exist. The drawer is ready for their connections.

## 4. P4-C03 — One independent demo peer

**Status:** committed\
**Proposed commit message:** `feat(web-bots): negotiate a demo peer on its own socket`\
**Actual commit:** `61618c7b01c432317d6347185cc800fef1bedc74`

**Why:** A demo peer has to negotiate without replacing the host session. Covers P4-A02 and the connection split in phase Section 5.2.

**Depends on:** P4-C02. `createGuest` and `PeerManager` exist.

**Files:**

- `packages/shared/src/demo-peers.ts`
- `packages/shared/src/demo-peers.test.ts`
- `packages/shared/src/index.ts`
- `apps/web/src/live/signaling.ts`
- `apps/web/src/live/peer-manager.ts`
- `apps/web/src/live/demo-peer.ts`
- `apps/web/src/live/demo-peer.test.ts`
- `apps/web/src/live/signaling.test.ts`

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

**Verification result (2026-11-01):** Shared tests passed (95, including three name-selection tests); web tests passed (23). Workspace typecheck and lint passed. Signaling tests confirm independent snapshots and closure do not replace the host socket or change its store, while the host factory still replaces its previous connection and writes/clears the store. Early descriptions and candidates follow the join callback. Demo engine tests cover synthetic join flags, own-snapshot sync, idempotent stop, rejected joins, cancellation during guest creation, and partial audio setup cleanup. Reading the independent factory confirms it does not reference `useRoomStore`; the page has no demo engine import or spawn control yet. P4-A02 is verified. Browser media verification follows in P4-C04.

**Done when:** P4-A02 passes, the independent factory does not reference `useRoomStore`, and the slice is committed.

**Handoff:** The engine can start and stop one peer. The page has no button yet.

## 5. P4-C04 — Spawn and remove

**Status:** committed\
**Proposed commit message:** `feat(web-bots): spawn and remove up to three demo peers`\
**Actual commit:** `1af2d2687ddd0167c11936c83c8cfc5a4edef92b`

**Why:** A reviewer can run the four-tile meeting alone. Covers P4-A03 through P4-A06.

**Depends on:** P4-C03.

**Files:**

- `apps/web/src/pages/RoomPage.tsx`
- `apps/web/src/live/demo-peer.ts`
- `apps/web/src/live/stage-grid.tsx`
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

**Verification result (2026-11-01):** Workspace typecheck and lint, shared tests (95), web tests (23), and the production web build passed. The demo engine capture search printed nothing. The production build reports a large-chunk advisory; it completed successfully.

Chrome with a fake host camera/microphone and real canvas/audio demo sources verified P4-A03 through P4-A06. Three demos produced four tiles, three Demo speaker rows, and twelve connected peer-connection endpoints for the six mesh edges. The host retained its original socket identity and guest session, and only its two original device-capture calls ran. Each stats row showed numeric bitrate/frame rate and ICE type `host`. With the host muted, a demo pulse won Speaking. The fourth spawn stayed disabled. A separate human filled the last slot while only two demos were managed; clicking Spawn showed the server's `stage_full` message without a new row or retained failed-source resources. Removing one demo preserved the others; a later spawn reused the first free name.

Remove stopped all demo video/audio tracks, oscillators, audio contexts, and canvas frame counters while preserving the host tracks. Host leave with demos still active stopped all sources, peer connections, contexts, and the stats timer. Navigation, unexpected host transport closure, and a real `room:ended` event independently exercised that cleanup. Removing during a held guest-creation request prevented a late socket or source; a fresh spawn then succeeded. A webinar demo remained an attendee with a Demo badge, no remote tile, and no peer connection. Inspected meeting and webinar screenshots confirm the layouts; demo video uses contain sizing to keep its full name, role, level bar, and frame count visible.

**Resolved verification failures:** The first run used a stale Vite shared-package dependency cache; restarting with `--force` loaded the new export. The initial pulse gain `0.18` failed the Speaking check. Gain `0.24` plus per-name pulse offsets passed; phase Section 5.2 records the tuning and keeps the `0.08` threshold. Phase 3 physical-device/native-picker observations remain separate and unverified.

**Done when:** P4-A01 through P4-A06 are verified and the slice is committed.

**Handoff:** Phase 5 can promote a demo attendee with the existing stage rules. This phase does not add that button.

## 6. Phase exit

Update the phase acceptance statuses to `verified` only for checks that were actually run. Those lines belong in the P4-C04 commit. The follow-up commit is `docs(phase4): record the final slice hash`.
