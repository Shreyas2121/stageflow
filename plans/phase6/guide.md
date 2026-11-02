# Guide 6 — Phase 6, commit by commit

**Status:** in progress. P6-C01 and P6-C02 are committed; P6-C03 is verified with P6-A05 unverified; P6-C04 through P6-C06 are planned.\
**Last updated:** 2026-11-02.\
**Phase contract:** [../phase6.md](../phase6.md).\
**Product authority:** [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.8`.\
**Deliverable:** One webinar HLS broadcast, its replay, and the standalone README, in six commits. This is the only Phase 6 guide.

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `04f91b7fffa2d1e3fe83b0dd8e5662bc5199a830`. Recheck the worktree.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run P6-C01 through P6-C06 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing.
4. After verification, commit that slice under master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(phase6): record the final slice hash`.
5. If a browser cannot be used, leave the related acceptance ID unverified and name the gap.
6. If `ffmpeg` is not on `PATH`, leave P6-A05 unverified. Do not skip it silently, and do not fail API startup because the binary is missing.

Keep the stage cap, the negotiation reducer, demo spawning, and the Phase 5 moderation commands. Do not add a second rendition, a queue, object storage, a retention job, or a media element that plays nothing.

### 1.1 Commit index

| Order | ID     | Proposed message                                                      | Acceptance    |
| ----- | ------ | --------------------------------------------------------------------- | ------------- |
| 1     | P6-C01 | `feat(shared): decide chunk order and the HLS argument list`          | A01           |
| 2     | P6-C02 | `feat(api-broadcast): store a broadcast and fail in-flight rows`      | A02           |
| 3     | P6-C03 | `feat(api-broadcast): supervise one FFmpeg process and serve HLS`     | A03, A04, A05 |
| 4     | P6-C04 | `feat(web-broadcast): composite the stage and upload chunks in order` | A08           |
| 5     | P6-C05 | `feat(web-broadcast): play the live playlist and the replay`          | A05, A06      |
| 6     | P6-C06 | `docs(readme): state the broadcast limits and the demo script`        | A07           |

### 1.2 Files to inspect before editing

- `packages/shared/src/signaling.ts` and `index.ts`
- `apps/api/src/live/live.service.ts`, `live.keys.ts`, `live.connection.ts`, and `scripts/common.lua`
- `apps/api/src/database/data-source.ts` and `apps/api/src/main.ts`
- `apps/web/src/features/live/components/live-room.tsx` and `room-controls.tsx`
- `apps/web/src/App.tsx`
- `scripts/check-artifacts.mjs`
- `README.md`

## 2. P6-C01 — Chunk decision and HLS arguments

**Status:** committed\
**Proposed commit message:** `feat(shared): decide chunk order and the HLS argument list`\
**Actual commit:** `72e2d67bb45c02f63a74f8b703c853777b9d5511`

**Why:** The upload and the process need one decision each, with no browser and no FFmpeg. Covers P6-A01.

**Depends on:** The shared Vitest setup.

**Files:**

- `packages/shared/src/broadcast.ts`
- `packages/shared/src/broadcast.test.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/signaling.ts`
- `apps/api/src/live/signaling.messages.ts` (exhaustive error message table)

**Implementation:**

1. Add `acceptChunk` and `buildHlsArgs` from phase Sections 5.5 and 5.6. Export them. Neither function reads the environment or a request body.
2. Widen `RoomSnapshot.broadcast` to the Section 7.2 object or null. Add `broadcast_active` and `ffmpeg_unavailable` to `SignalingError`. Add their Section 5.1 sentences to the exhaustive API message table in `apps/api/src/live/signaling.messages.ts` so typecheck stays passing. Do not add a socket event.
3. Tests use plain values:
   - Sequence `0` with empty history is accepted and becomes the next expected sequence.
   - The same sequence and the same SHA-256 is a duplicate.
   - The same sequence and a different hash is a conflict.
   - A sequence past the next expected one is future.
   - A body longer than 2,000,000 bytes is oversize.
   - `buildHlsArgs` includes `pipe:0`, H.264, `yuv420p`, `1280x720`, 24 fps, `2500k`, GOP `96`, AAC, `128k`, `48000`, stereo, `hls_time` `4`, event playlist, and `independent_segments`.
   - The list does not contain `delete_segments`. Replacing `outputDir` changes only the output paths.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm typecheck
pnpm lint
```

**Done when:** P6-A01 passes and the slice is committed.

**Verification record (2026-11-02):** P6-A01 passed. `pnpm --filter @stageflow/shared test` passed (149 tests, including 8 broadcast tests). `pnpm test` passed shared (149), web (105), and API (105), including Redis integration. `pnpm typecheck`, `pnpm lint`, and formatting checks passed. The first typecheck overlapped a test-triggered shared build and saw missing shared declarations; the sequential rerun passed. No FFmpeg process or browser is required for this slice.

**Handoff:** Nothing spawns FFmpeg or changes `broadcast:start`.

## 3. P6-C02 — Broadcast catalog and restart

**Status:** committed\
**Proposed commit message:** `feat(api-broadcast): store a broadcast and fail in-flight rows`\
**Actual commit:** `c7504b3d5270f56b0ce612c23f580becf7c76fbc`

**Why:** Restart and the later supervisor need a row and the live key. Covers P6-A02.

**Depends on:** P6-C01. The owner-guard startup in `LiveConnection` exists.

**Files:**

- `apps/api/src/broadcasts/broadcast.entity.ts`
- `apps/api/src/broadcasts/broadcasts.module.ts`
- `apps/api/src/broadcasts/broadcasts.service.ts`
- `apps/api/src/broadcasts/broadcasts.controller.ts`
- `apps/api/src/broadcasts/broadcasts.service.test.ts`
- `apps/api/src/migrations/<timestamp>-CreateBroadcasts.ts`
- `apps/api/src/database/data-source.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/live/live.keys.ts`
- `apps/api/src/live/scripts/tryBeginBroadcast.lua`
- `apps/api/src/live/scripts/clearBroadcast.lua`
- `apps/api/src/live/live.repository.ts`
- `apps/api/src/live/live.repository.test.ts`
- `apps/api/src/live/live.integration.test.ts`
- `apps/api/src/live/live.module.ts`
- `apps/api/src/live/live.connection.ts`
- `apps/api/src/live/live.connection.test.ts`
- `packages/shared/src/contracts.ts` (`broadcast_not_found` REST error)
- `scripts/check-artifacts.mjs`

**Implementation:**

1. Add the Section 5.2 table in a migration and register the entity beside `User` and `Room`. Leave `synchronize` off.
2. Add the broadcast id as the sixth `liveKeys` entry. Leave the five-name unpack in `common.lua` unchanged. `tryBeginBroadcast` sets `KEYS[6]` only when it is absent and rejects when it exists. `clearBroadcast` deletes `KEYS[6]`. Register both scripts on the repository. Do not change join, leave, promote, demote, or lock behavior.
3. `GET /api/rooms/:slug/broadcasts` and `GET /api/broadcasts/:id` require the guest bearer token and return the catalog fields. Add `broadcast_not_found` to the shared REST error union for malformed or unknown broadcast ids. They do not serve media bytes.
4. The startup that acquires the owner marks `STARTING`, `LIVE`, and `STOPPING` rows `FAILED` with `api restarted`, then clears live keys. A startup that loses the owner changes no rows and no keys. `READY` rows stay.
5. Update the artifact check to the shipped Lua count and to six live keys. `broadcast:start` still returns `broadcast_not_available` in this slice.

**Verification:**

```powershell
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

The service test inserts one row of each status, runs the owning startup against a fake repository and the real status rule, and expects only the three in-flight statuses to become `FAILED` with `api restarted`. The Redis integration test covers `tryBeginBroadcast` once, a second rejection, and `clearBroadcast`.

Run the migration against the compose database before the browser slices.

**Done when:** P6-A02 passes and the slice is committed.

**Verification record (2026-11-02):** P6-A02 passed. `pnpm test` passed shared (149), web (105), and API (112), including real Redis integration. Startup tests cover all five broadcast statuses, owner contention, waiting for catalog cleanup, and catalog failure before presence deletion. Redis tests cover concurrent broadcast claims, repeat rejection, clear, room deletion, and namespace isolation. `pnpm typecheck`, `pnpm lint`, API build, `pnpm check:artifacts --api`, and `pnpm smoke:live` passed. `pnpm --filter @stageflow/api migration:run` applied `CreateBroadcasts1793577600000` to the compose database. A compiled-controller HTTP check with real guest JWT verification and transaction-scoped PostgreSQL rows passed list/detail, room isolation and ordering, 401s, 404s, and absence of media serving; its rows were rolled back. The broadcast entity matches its migrated table. Broadcast start/stop still return `broadcast_not_available`.

**Handoff:** The key and the row exist. No process is supervised.

## 4. P6-C03 — FFmpeg supervisor and HLS serving

**Status:** verified\
**Proposed commit message:** `feat(api-broadcast): supervise one FFmpeg process and serve HLS`\
**Actual commit:**

**Why:** The host command can produce a playlist, and a missing binary cannot take down the mesh. Covers P6-A03, P6-A04, and the file half of P6-A05.

**Depends on:** P6-C02.

**Files:**

- `apps/api/src/broadcasts/ffmpeg-supervisor.ts`
- `apps/api/src/broadcasts/ffmpeg-supervisor.test.ts`
- `apps/api/src/broadcasts/hls-path.ts`
- `apps/api/src/broadcasts/hls-path.test.ts`
- `apps/api/src/broadcasts/chunk-parser.ts` and `chunk-parser.test.ts`
- `apps/api/src/broadcasts/broadcasts.runtime.test.ts`
- `apps/api/src/broadcasts/broadcasts.service.test.ts`
- `apps/api/src/broadcasts/broadcasts.module.ts`
- `apps/api/src/broadcasts/broadcasts.controller.ts`
- `apps/api/src/broadcasts/broadcasts.service.ts`
- `apps/api/src/live/live.service.ts`
- `apps/api/src/live/live.service.test.ts`
- `apps/api/src/live/live.repository.ts` and `live.integration.test.ts`
- `apps/api/src/live/scripts/snapshot.lua` and `clearBroadcast.lua`
- `apps/api/src/live/live.module.ts` and `signaling.gateway.ts`
- `apps/api/src/live/signaling.messages.ts`
- `apps/api/src/main.ts`

This slice also adds the existing Express version as a direct API dependency (with the lockfile), validates `FFMPEG_PATH` and `DATA_ROOT` in `config/parse-config.ts`, extends the shared REST error union, and updates `scripts/check-artifacts.mjs` for eleven Lua assets. `snapshot.lua` increments the revision for broadcast-only changes without changing participants or stage membership; `common.lua` and all stage commands remain unchanged. The upload controller delegates `acceptChunk` and the guarded stdin write to the broadcast service so that one in-flight write owns the next-expected counter.

**Implementation:**

1. Replace `startBroadcast` and `stopBroadcast` with the Section 5.1 order. Meeting mode and a missing binary return before a live mesh change. `broadcast_active` and `ffmpeg_unavailable` use the Section 5.1 sentences.
2. Supervise one child per broadcast. Write accepted chunk bytes to its stdin in order. If it exits before stop, mark `FAILED`, clear the key, and publish the snapshot. Do not spawn another child.
3. Mount a raw parser only on `POST /api/broadcasts/:id/chunks`, limited to 2,000,000 bytes. Allow `x-chunk-sequence` in CORS. The controller calls `acceptChunk` and writes only an acceptance. Map duplicate to `204`, and conflict, future, and oversize to a refusal without a write.
4. Confine playlist and segment reads to `{dataRoot}/broadcasts/{broadcastId}/`. Reject a resolved path that escapes `DATA_ROOT`, including `..`. Apply the Section 5.7 cache and MIME values. Do not enable a directory index. Require the guest bearer token.
5. Stop closes stdin and waits for exit. Exit 0 with a playlist becomes `READY`. Any other exit becomes `FAILED` with the stderr tail capped at 2,000 characters. A thumbnail failure after `READY` leaves `thumbnailPath` null.
6. Publish the Section 5.2 snapshot broadcast from the in-flight row, or from the newest row when the key is gone. Host leave stops an in-flight broadcast before the existing room-end deletion.

**Verification:**

```powershell
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

Service tests cover a meeting rejection, a second start, a missing binary, a premature child exit, and a clean stop. Path tests cover a `..` escape and the two media headers. The chunk test drives `acceptChunk` through the service with a fake stdin.

When `ffmpeg` is on `PATH`, feed a few seconds of input through the supervisor and assert that `index.m3u8` contains `#EXT-X-ENDLIST`. When it is not, say so and leave P6-A05 unverified. Do not commit the generated playlist or segments.

**Done when:** P6-A03 and P6-A04 pass, P6-A05 is either verified or explicitly unverified, and the slice is committed.

**Verification record (2026-11-02):** P6-A03 and P6-A04 passed. `pnpm test` passed shared (149), web (105), and API (130); the API suite also passed separately after the final test edits. `pnpm typecheck`, `pnpm lint`, API build, `pnpm check:artifacts --api`, `pnpm smoke:live`, and `pnpm audit:check` passed. Tests cover stored-role authorization, meeting and second-start rejection, failed spawn with stage preservation, premature/nonzero exit, bounded write and stop, clean stop with a playlist, no-playlist failure, shutdown, chunk order/hash/size/concurrency, traversal, symlink confinement, and media headers. Redis integration verifies broadcast revisions without stage changes and conditional key cleanup.

A compiled-controller check used real guest JWT verification, PostgreSQL rows inside a rolled-back transaction, isolated Redis keys, and temporary files. It passed missing-binary failure with unchanged stage membership, one row per start attempt, raw chunk 204/400/403/409/413 behavior including the exact byte limit and duplicate suppression, guarded HLS reads with the correct headers, traversal refusal, monotonic snapshots, and READY/key cleanup using a controlled child. Test keys, rows, and files were cleaned up. No real API startup reset ran against developer presence.

**P6-A05 remains unverified:** `ffmpeg` is absent from `PATH`. The controlled child and fixture playlist do not verify real FFmpeg output or `#EXT-X-ENDLIST`. This slice performs no browser playback check. No media artifacts are committed. Thumbnail generation remains optional and is omitted; `thumbnailPath` stays null.

**Handoff:** The API can accept a broadcast. The browser still does not record or play one.

## 5. P6-C04 — Compositor and ordered upload

**Status:** planned\
**Proposed commit message:** `feat(web-broadcast): composite the stage and upload chunks in order`\
**Actual commit:**

**Why:** The host browser is the only media source. Covers P6-A08.

**Depends on:** P6-C03. The webinar host already has broadcast buttons and stage video elements.

**Files:**

- `apps/web/src/features/broadcast/services/stage-recorder.ts`
- `apps/web/src/features/broadcast/services/stage-recorder.test.ts`
- `apps/web/src/features/broadcast/services/chunk-upload.ts`
- `apps/web/src/features/broadcast/services/chunk-upload.test.ts`
- `apps/web/src/features/live/components/room-controls.tsx`
- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/services/room-session.test.ts`

**Implementation:**

1. Build the Section 5.4 canvas and audio mix in the broadcast feature. Pass video elements and tracks in from the live room. Do not import a live component.
2. Start recording only after `broadcast:start` acks success. Upload sequence `0` first, and send the next blob only after `204`. Keep at most 8 unsent blobs. On the ninth, stop the recorder and call `broadcast:stop`.
3. Rebuild the mix when the stage set or mute flags change, and disconnect the replaced nodes.
4. On broadcast stop, host leave, room end, and unmount, stop the recorder, cancel the canvas frame, stop the upload loop, and close the mix context. Leave still stops the camera and the peer connections.
5. Do not render a player in this slice. An attendee still sees the missing-broadcast sentence.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
rg -n "features/live" apps/web/src/features/broadcast
```

The search prints nothing. Recorder tests cover the 2×2 layout, the screen-share layout, the eight-blob cap, in-order upload, and cleanup while a blob is unsent. The session test covers host leave reaching that cleanup.

**Done when:** P6-A08's automated half passes and the slice is committed.

**Handoff:** Chunks can reach FFmpeg. Nobody plays the playlist yet.

## 6. P6-C05 — Live player and replay

**Status:** planned\
**Proposed commit message:** `feat(web-broadcast): play the live playlist and the replay`\
**Actual commit:**

**Why:** The attendee window and the replay route are the broadcast the host just produced. Covers P6-A06 and the visible half of P6-A05.

**Depends on:** P6-C04.

**Files:**

- `apps/web/package.json`
- `pnpm-lock.yaml`
- `apps/web/src/features/broadcast/components/broadcast-player.tsx`
- `apps/web/src/pages/ReplayPage.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/features/live/components/live-room.tsx`

**Implementation:**

1. Add the current stable `hls.js` and commit the lockfile. Attach the guest bearer token to its playlist and segment requests.
2. When the attendee snapshot has `LIVE` or `STOPPING`, play at the live edge. When it is `READY`, use VOD controls and link to `/replay/:broadcastId`. When it is `FAILED`, show `errorMessage` and no player. When it is null, keep `The host has not started the broadcast.`
3. Add `/replay/:broadcastId`. `READY` uses the same VOD player. Every other status shows the status and the error, with no player.
4. Do not mount the player for a stage member. Do not import `hls.js` from the home page.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
rg -n "hls" apps/web/src/pages/HomePage.tsx apps/web/src/main.tsx
```

The search prints nothing. Confirm the production home graph does not contain `hls.js`, and that `/r/:slug` stays a dynamic entry.

In current desktop Chrome or Edge, with the API, web app, Redis, PostgreSQL, and `ffmpeg` on `PATH`:

1. As Ava, create a webinar, join, spawn demo peers, and promote one. The stage shows the mesh.
2. As Sam, join in a second window. Sam has no device prompt and no peer connection, and sees the missing-broadcast sentence.
3. Ava starts the broadcast. Sam plays the composite without gaining a peer connection. The wait is several seconds and is not a failure. Ava still sees the mesh, not an HLS copy.
4. Stop the API's FFmpeg binary name with an invalid `FFMPEG_PATH` in a separate run. The start fails, the stage mesh remains, and Sam sees the failure sentence instead of a player. Restore `FFMPEG_PATH` afterward.
5. Ava stops a healthy broadcast. The playlist contains `#EXT-X-ENDLIST`. Sam and `/replay/:broadcastId` play it as VOD.
6. Create a meeting and start a broadcast. The existing not-available sentence appears, and no row is created.
7. Leave as Ava during a later broadcast. The recorder, mix, upload loop, camera, and peer connections stop.

Record any failed step. A still screenshot does not verify A05 or A06. If `ffmpeg` or a browser is missing, leave the matching ID unverified.

**Done when:** P6-A06 passes, the visible half of P6-A05 is recorded, and the slice is committed.

**Handoff:** The product path works. The README still describes broadcast as unavailable.

## 7. P6-C06 — README

**Status:** planned\
**Proposed commit message:** `docs(readme): state the broadcast limits and the demo script`\
**Actual commit:**

**Why:** A reviewer can run Section 2.2 and see the limits without opening the plan. Covers P6-A07.

**Depends on:** P6-C05. Do not change application behavior in this slice.

**Files:**

- `README.md`

**Implementation:**

1. Replace the sentences that say broadcast is unavailable or that moderation is the last media step.
2. Write the Section 2.2 steps, including the webinar, the attendee window, the live broadcast, and the replay.
3. State the 4-person mesh, the 8–20 second delay, the `api restarted` rule for in-flight rows, survival of `READY` replays, current Chrome or Edge on Windows, STUN with local loopback, optional TURN, and unbounded local disk under `DATA_ROOT`.
4. State that a missing FFmpeg binary fails the broadcast and leaves the mesh usable. Do not document a ladder, a queue, object storage, or a retention job.

**Verification:**

```powershell
pnpm exec prettier --write README.md
```

Read `README.md` and check each sentence in phase Section 5.8. This slice does not claim a new browser run. Do not mark A05 or A06 from this commit.

**Done when:** P6-A07 passes and the slice is committed.

**Handoff:** Phase 6 has no following feature. The open Phase 3 physical observations stay in their own record.
