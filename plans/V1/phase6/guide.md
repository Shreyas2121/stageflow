# Guide 6 — Phase 6, commit by commit

**Status:** All six feature slices are committed. P6-A01 through P6-A08 have passed within their recorded automated/native-browser scope. RC18 verified real Chrome recording and HLS playback with synthetic devices after the acceptance fixes in `326dea3`. Physical Phase 3 observations remain explicitly unverified; the complete V1 gate remains open.\
**Last updated:** 2026-11-03.\
**Phase contract:** [../phase6.md](../phase6.md).\
**Product authority:** [MASTER_PLAN.md](../../../MASTER_PLAN.md) version `1.0.9`.\
**Deliverable:** One webinar HLS broadcast, its replay, and the standalone README, in six commits. This is the only Phase 6 guide.

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `04f91b7fffa2d1e3fe83b0dd8e5662bc5199a830`. Recheck the worktree.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run P6-C01 through P6-C06 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing.
4. After verification, commit that slice under master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(phase6): record the final slice hash`.
5. If a browser cannot be used, leave the related acceptance ID unverified and name the gap.
6. If neither `FFMPEG_PATH` nor `PATH` provides a real FFmpeg binary, leave P6-A05 unverified. Do not skip it silently, and do not fail API startup because the binary is missing.

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

**Status:** committed\
**Proposed commit message:** `feat(api-broadcast): supervise one FFmpeg process and serve HLS`\
**Actual commit:** `0deb68578409c16d817ce5a7bddee35128a425ca`

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

**Status:** committed\
**Proposed commit message:** `feat(web-broadcast): composite the stage and upload chunks in order`\
**Actual commit:** `3c0d2dcec7ef488d598f6715e10834a52839cc57`

**Why:** The host browser is the only media source. Covers P6-A08.

**Depends on:** P6-C03. The webinar host already has broadcast buttons and stage video elements.

**Files:**

- `apps/web/src/features/broadcast/services/stage-recorder.ts`
- `apps/web/src/features/broadcast/services/stage-recorder.test.ts`
- `apps/web/src/features/broadcast/services/chunk-upload.ts`
- `apps/web/src/features/broadcast/services/chunk-upload.test.ts`
- `apps/web/src/features/live/components/room-controls.tsx`
- `apps/web/src/features/live/components/live-room.tsx`
- `apps/web/src/features/live/components/stage-grid.tsx`
- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/services/room-session.test.ts`

**Implementation:**

1. Build the Section 5.4 canvas and audio mix in the broadcast feature. Pass video elements and tracks in from the live room. Do not import a live component.
2. Start recording only after `broadcast:start` acks success. Upload sequence `0` first, and send the next blob only after `204`. Keep at most 8 unsent blobs. On the ninth, stop the recorder and call `broadcast:stop`.
3. Rebuild the mix when the stage set or mute flags change, and disconnect the replaced nodes.
4. On a normal Stop broadcast, finish the recorder before `broadcast:stop`: accept the final blob that arrives before the recorder `stop` event, upload accepted chunks in order, then tell the server to stop. Leave, room end, and page unload abort immediately and do not wait for an upload. Leave still stops the camera and the peer connections. The verification record below describes the earlier drop-on-stop behavior; Section 5.4 is the current contract.
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

**Verification record (2026-11-02):** P6-A08's automated half passed. `pnpm --filter @stageflow/web test` passed (119 tests). Recorder tests cover the 2×2 layout, the empty cell, both columns, a full-frame screen share, ordered uploads that wait for 204, the eight-blob cap, mix rebuild with disconnected nodes, and cleanup while a blob is unsent. The session test covers host leave reaching that cleanup while the camera and peer connections still stop. `pnpm typecheck` and `pnpm lint` passed. A search of `apps/web/src/features/broadcast` for `features/live` printed nothing (`rg` is not on `PATH`; the workspace search was used). No player was added. The attendee missing-broadcast sentence is unchanged.

**P6-A08 browser half remains open:** this slice did not run a browser. Page unload, leave, and broadcast stop were checked in web tests only. P6-A05 remains unverified. No media artifacts are committed.

**Handoff:** Chunks can reach FFmpeg. Nobody plays the playlist yet.

## 6. P6-C05 — Live player and replay

**Status:** committed\
**Proposed commit message:** `feat(web-broadcast): play the live playlist and the replay`\
**Actual commit:** `c247d10732b7a31ef77d950de0527c324c2b0730`

**Why:** The attendee window and the replay route are the broadcast the host just produced. Covers P6-A06 and the visible half of P6-A05.

**Depends on:** P6-C04.

**Files:**

- `apps/web/package.json`
- `pnpm-lock.yaml`
- `apps/web/src/features/broadcast/components/broadcast-player.tsx`
- `apps/web/src/features/broadcast/components/attendee-broadcast.tsx`
- `apps/web/src/features/broadcast/services/playback.ts`
- `apps/web/src/features/broadcast/services/playback.test.ts`
- `apps/web/src/features/broadcast/services/boundaries.test.ts`
- `apps/web/src/features/broadcast/api.ts`
- `apps/web/src/features/broadcast/api.test.ts`
- `apps/web/src/features/broadcast/query-options.ts`
- `apps/web/src/pages/ReplayPage.tsx`
- `apps/web/src/app/route-error-boundary.tsx`
- `apps/web/src/app/entry-graph.test.ts`
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

**Verification record (2026-11-02):** The player and replay route are committed. `hls.js` resolved from the npm `latest` tag to `1.7.4` and is pinned in `apps/web/package.json` and `pnpm-lock.yaml`. `pnpm --filter @stageflow/web test` passed (132 tests). Playback tests cover the live edge for `LIVE` and `STOPPING`, VOD for `READY`, a failure with no playlist, the missing-broadcast state, replay statuses other than a finished playlist, the guest bearer token on playlist and segment requests, standard HLS (`lowLatencyMode: false`), and a 401 clearing the guest session. `pnpm typecheck` and `pnpm lint` passed. A search of `apps/web/src/pages/HomePage.tsx` and `apps/web/src/main.tsx` for `hls` printed nothing (`rg` is not on `PATH`; the workspace search and `entry-graph.test.ts` were used). The production build keeps `/r/:slug` and `/replay/:broadcastId` as dynamic entries. The home entry chunk does not contain the `hls.js` library. Its HTML loads only `assets/index-BSOjE9_Y.js` and `assets/index-B1Pn0x9P.css`. The player chunk is `assets/broadcast-player-BQWSWoOn.js`, imported by the room and replay chunks. Headless Chrome 156 loaded the production preview: the home page made no request for that chunk and rendered no video; `/replay/:broadcastId` without a session showed the guest-session sentence and no video; a signed-in replay whose catalog could not be reached showed the reachability error and no video; an id that is not a UUID showed `No broadcast exists for that id.` and no video.

**P6-A06 is unverified.** **P6-A05 remains unverified.** `ffmpeg` is absent from `PATH` (no `ffmpeg.exe` in the usual install locations). The two-window script was not run, so live playback, `#EXT-X-ENDLIST`, the visible failure sentence, the meeting refusal, and host leave during a healthy broadcast were not observed. A still screenshot was not used as a substitute. P6-A08's browser half remains open. No media artifacts are committed. The README still describes broadcast as unavailable.

**Handoff:** Attendees and `/replay/:broadcastId` have a player. Live playback and the finished-playlist replay were not run. The README still describes broadcast as unavailable.

## 7. P6-C06 — README

**Status:** committed\
**Proposed commit message:** `docs(readme): state the broadcast limits and the demo script`\
**Actual commit:** `ad2a56bdc8e1bf49192112cd5ba2aa8c7cd09da4`

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

**Verification record (2026-11-02):** `pnpm exec prettier --write README.md` left the file unchanged. `README.md` was read against every sentence in phase Section 5.8. The two-window steps state the webinar, the attendee window, the live broadcast, and the replay, and the earlier steps state the Section 2.2 meeting mesh. The limits paragraph states the 4-person mesh, the 8–20 second delay, `api restarted` for `STARTING`, `LIVE`, and `STOPPING`, survival of `READY` playlist files, current Chrome or Edge on Windows, STUN with local loopback, optional TURN, and growth of the directory under `DATA_ROOT`. A missing FFmpeg binary fails the broadcast and leaves the mesh usable. Each attempt keeps its HLS playlist and segments. The artifact sentence now says eleven Lua files, matching `scripts/check-artifacts.mjs`. The README does not add a ladder, a queue, object storage, or a retention job. No application code changed. This slice claims no new browser run. P6-A05 and P6-A06 are not marked. P6-A07 passed.

**Handoff:** Phase 6 has no following feature. The open Phase 3 physical observations stay in their own record.

**RC06 maintenance (2026-11-02):** Added terminal producer failure handling, no-media finish failure, browser and server input deadlines, and stop acknowledgement reconciliation by attempt id. Controlled-clock tests cover missing first input, later inactivity, native error/stop, empty blobs, deadline renewal, final collection failure, server cleanup, and a 10-second stop. Real FFmpeg and browser failure observations remain open.

RC06 automated evidence: all web tests (163) and API tests (145, including Redis) passed; API/web typechecks and lint passed. Focused cases use controlled processes and clocks, not real encoder or browser observations. Build/artifact and socket-smoke results are recorded below after execution.

RC06 build evidence: API build, production web build, artifact checks, and isolated live socket smoke passed. The smoke logged its expected injected catalog failure. Vite retained the existing large player chunk warning. Real encoding/playback remains unverified.

**RC07 maintenance (2026-11-02), following RC06 `8e2bcb1`:** Page exit and unmount share idempotent local teardown and signaling close. Restored documents remain in the lobby for explicit device preparation/rejoin. Store updates and stale join/device completions cannot restore the exited session. Service cases cover persisted/non-persisted exit, initial pageshow, repeated exit/disposal, pending permission/join, screen capture, demo peers, and exit during upload drain.

**RC07 browser half OPEN:** No supported browser observations were performed in this slice. In Chrome/Edge on Windows, still verify ordinary navigation and back/forward restoration from a live room, native camera/microphone/screen indicators after exit, attendee status after host exit, and explicit rejoin against the current server room/broadcast status. Confirm no automatic recording/capture restart on return. P6-A05/A06 and the browser half of P6-A08, plus Phase 3 physical observations, remain open. Automated release evidence follows after execution.

RC07 integrated automated evidence (2026-11-02): tooling tests (17), shared tests (149), web tests (168), API tests (145, including Redis), workspace typechecks/lint, API/web builds, artifact validation, live socket smoke, and the audit gate passed. The combined pnpm check:release command stopped at formatting solely because the unrelated untracked briefing.html is unformatted; that file was preserved. Prettier with only briefing.html excluded passed, and the remaining artifact/smoke commands passed separately. No browser or physical-device observation is claimed.

**RC08 maintenance (2026-11-02):** All shared compilers use one token-owned writer directory acquired by atomically publishing a complete ownership record. Dead-owner recovery and release remove only metadata belonging to that token, never recursively deleting a replacement lock. TypeScript runs inside the owning process, so a killed owner cannot leave a compiler writing live output. Compiles invalidate readiness before program creation, emit into private buffers, and publish complete files atomically only after diagnostics succeed. Ready generations include source/configuration/compiler fingerprints and hashes for every emitted file. Readiness records are immutable, so a Windows reader holding an older record cannot block publication of a new one; obsolete records are collected without blocking readers. Atomic output replacement uses bounded retries for transient Windows sharing errors. One-shot builds remain standalone and still compile each time; release-graph build reuse is reserved for RC09. Dev followers observe successful generations, and API startup/restarts wait for current shared readiness.

RC08 tests use disposable roots under the OS temporary directory, real TypeScript compilers, independent app-consumer processes, and isolated dev-owner Redis namespaces. They cover cold concurrency, declaration readers, failed rebuild/recovery, inherited-config edits, missing output, watcher followers/exit, stale-owner races, failed first compile, repeated stop, and obsolete output cleanup. Workspace dist/lock files are not fixture targets. Verification evidence follows after the checks.

RC08 verification (2026-11-02, Windows, Node 22.23.2): final pnpm test:tooling passed all 30 tests, including 12 shared-build cases and the Windows dev-owner integration. Workspace typechecks, lint, shared tests (149), web tests (168), API tests (145 including Redis), API/web builds, artifact checks, and isolated socket smoke passed. The final tooling lint and production web build/artifact check passed after the immutable-record refinement. Expected negative-path diagnostics were observed for failed compile, forced dev shutdown, and smoke catalog failure. The combined pnpm check:release command stopped only at the unrelated untracked briefing.html formatting issue; that file was preserved. Prettier with only briefing.html excluded passed. No application source or package task graph changed.

**RC09 maintenance (2026-11-03), following RC08 `4914eb1`:** Root check commands execute a flat dependency graph that prepares shared once; package prerequisites use verified ensure instead of unconditional compile. Success records use immutable files and are checked under the RC08 writer lock against build-source/config/dependency/helper fingerprints and the complete output inventory and hashes. Watcher failure/readiness remains authoritative. No global skip flag bypasses validation, and a mid-graph source edit rebuilds. Standalone explicit shared build forces a compile; standalone app tasks repair missing or stale output. Shared test-source typechecking and production exclusions remain unchanged.

RC09 preparation timing on this Windows workspace: RC08 six separate preparations took 9,504 ms. RC09 root preparation plus six validating consumers took 3,281 ms from a cold success-record cache and 3,284 ms warm; both emitted shared exactly once. These are prerequisite-only measurements, not complete release timings. Cold deleted-output recovery is exercised in disposable fixtures, not by removing a running workspace dist. Final gate evidence follows after execution.

RC09 final evidence (2026-11-03): pnpm check:release emitted shared once at graph entry; all six API/web prerequisites logged verified reuse. All 36 tooling tests, workspace typechecks/lint, shared tests (149), web tests (168), API tests (145 including Redis), and API/web builds passed. The combined release command stopped at formatting solely because the unrelated untracked briefing.html remains unformatted. That file was preserved; Prettier with only briefing.html excluded passed. The production web build, artifact validation (including absence of emitted tests), isolated socket smoke, and audit gate passed separately. Six warm standalone prerequisites emitted zero times (3,409 ms in this run). Fixtures verified cold deleted-output recovery, corruption/extra-artifact repair, source/config/dependency invalidation, failed build rejection, malformed record repair, and mid-graph edits. No acceptance observations were reclassified.

**RC16 maintenance (2026-11-03):** Chunk decisions now read sequence/hash metadata without copying the ledger. Each attempt retains one hash map and commits its hash/next sequence only after the FFmpeg write succeeds under the existing write exclusion. Browser uploads retain at most 8 blobs and 8,000,000 bytes, including the active request; accepted bytes leave the budget. A 10-second request deadline aborts stalled uploads through the existing producer-failure path. Stop, overflow, and drain timeout clear the timer and queued bytes; late acknowledgements cannot restart sending. A later drain retains an earlier upload failure. The 8-second normal-finish drain remains in effect. Hash storage still grows linearly; no encoder concurrency, broadcast duration, retention, or catalog pagination cap was added.

Focused verification: shared broadcast tests passed (8), API broadcast runtime/supervisor tests passed (21), and web uploader/recorder tests passed (36). The deterministic 50,000-chunk regression forbids ledger iteration/copying while checking accepted, duplicate, conflicting, future, and delayed retry decisions. API regressions prove pending/failed writes do not commit history, successful writes retain map identity, and retry after a refused write still accepts that sequence. Uploader cases cover exact byte capacity, one-byte overflow, budget reuse, stalled requests, late success, abort, and drain. Real FFmpeg/browser observations remain open. Affected verification selected the full release gate: 41 tooling, 149 shared, 215 web, and 155 API tests passed, as did all typechecks, lint, and builds. The release command stopped at formatting solely on the pre-existing untracked briefing.html; that file was preserved. Formatting with only that file excluded passed. The remaining artifact and isolated socket smoke checks passed separately, and pnpm audit:check passed under the existing development exceptions. The intentional URL control-character guard in broadcast.ts now documents its narrow ESLint exception, resolving the lint failure exposed by this run.

**RC17 maintenance (2026-11-03), following RC16 `c39a22d`:** Added `pnpm smoke:broadcast` using the real compiled Nest main/modules, both compiled migrations, disposable PostgreSQL database, unique Redis namespace, random loopback ports and OS temp media directory. It creates a guest over HTTP, verifies persistence, joins the real gateway, generates six seconds of VP8/Opus WebM with FFmpeg, uploads sequential chunks plus a duplicate, stops over Socket.IO, and verifies READY, ENDLIST, authenticated segment bytes and decoded H.264/AAC output at 1280x720 with roughly six seconds of media. Independent API boots verify startup recovery of persisted STARTING/LIVE/STOPPING rows, preservation of READY and its served playlist, foreign namespace isolation, and missing-binary failure while stage media commands remain usable. No controlled child or persistence substitute is used in this integration.

CI now supplies PostgreSQL 16 and Redis 7. It conditionally downloads the FFmpeg 6.0 Linux x64 asset from ffmpeg-static release b6.0, checks compressed SHA-256 `17c1ae10b52ac499180679fe6ba77e17642390c4eedb0f1e3b0ac045da55128f`, and logs the version. Full release checks and API changes include both smokes; browser broadcast service changes select the full gate. Markdown-only changes, including documentation under application directories, skip application/integration execution unless a full gate is explicitly selected. Selection regressions cover these boundaries. The existing socket smoke remains accurately described as using persistence substitutes. Standalone integration requires a compiled API, FFmpeg and a PostgreSQL connection with CREATE DATABASE permission; only the random database is migrated and dropped.

Local evidence: Node 22.23.2, PostgreSQL 16.15, Redis 7.4.12, Windows FFmpeg `6.0-essentials_build-www.gyan.dev` from the b6.0 Windows x64 asset (compressed SHA-256 `450d66226c79405c724e821f291cab0911e934bfa9fa2231adcab587f3e07b50`). The initial and final real integration runs passed: five posted chunks, two HLS segments, successful audio/video decode, clean normal stop, recovery, missing binary and cleanup. A separate intentional failure with UPLOAD_NETWORK_RATE_LIMIT=1 rejected the duplicate post with 429; the harness exited nonzero as expected and still removed its database, Redis keys and media directory, with no fixture encoder remaining. Existing containers were neither restarted nor reset. The Ubuntu CI configuration was inspected but has not been executed remotely from this workspace.

Verification: affected selection ran the full release graph; 41 tooling, 149 shared, 215 web and 155 API tests, all typechecks, lint and both builds passed. Updated selection regressions also passed separately (6). The release command stopped at formatting solely on the pre-existing untracked briefing.html, preserved unchanged. Formatting with only that file excluded, artifact checks, socket smoke, the final real broadcast smoke, and audit passed separately. Browser playback, native recorder and physical-device observations remain open for RC18; this integration does not close them.

## RC18 acceptance and current handoff (2026-11-03)

Feature implementation through RC17 is `1879ad0`. The user authorized focused fixes after native browser verification found startup blockers; those fixes are `326dea3`. Physical observations were explicitly left unverified by the user. This records available acceptance evidence and retains the complete V1 gate as open.

The initial browser runs demonstrated two defects absent from controlled tests: the recorder invoked stored native frame functions with its own receiver (Chrome threw Illegal invocation after native recording began), and the first live manifest 404 was fatal because hls.js excludes 4xx retries by default. Native frame functions now retain the global Window receiver. Live manifest 404 retries use the existing six-retry/backoff budget; VOD, auth failures and other client errors keep their existing policy. Receiver-sensitive and retry-budget regressions were added. These are application fixes, not changes to the acceptance criteria.

**Environment:** Windows, Node 22.23.2, pnpm 12.9.1, Chrome 156.0.8078.74 (DevTools protocol 1.3; V8 15.6.75.25), PostgreSQL 16.15, Redis 7.4.12, and FFmpeg 6.0-essentials_build-www.gyan.dev. FFmpeg was supplied through FFMPEG_PATH from the b6.0 Windows x64 temporary download recorded in RC17; it was not installed globally. Browser launch used a fresh temporary profile, headless=new, use-fake-device-for-media-stream, use-fake-ui-for-media-stream and autoplay-policy=no-user-gesture-required. Audio output was muted. No physical device, human audible output, native screen picker/stop UI or hardware indicator observation is claimed. No Edge run or remote Ubuntu CI execution is claimed.

**Method and commands:** a temporary DevTools driver extended the isolated RC17 fixture, started the real compiled API and a Vite dev server on random loopback ports, and interacted with actual UI controls in independent Chrome windows. It observed native MediaRecorder/MediaStreamTrack/AudioContext/RTCPeerConnection instances and upload acknowledgements; it did not substitute media or transport implementations. The exact invocation was `pnpm --filter @stageflow/api exec dotenv -e ../../.env -- node ../../scripts/.rc18-run.mjs` with FFMPEG_PATH set to the temporary binary. The temporary driver and launcher were removed after verification; no permanent browser suite was added. Manual repetition uses the README demo steps plus the cases below. Screenshots and the JSON report remain local ignored artifacts under `node_modules/.cache/rc18-evidence/`. The final report SHA-256 is `68049146104d36bad52e804a2202379de2c95e9b82d810b0f21f95e33a5c9d7c`.

| Acceptance / case                      | Newly observed result                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Scope                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| P6-A05: real encoding and nonzero exit | Real WebM-to-HLS integration produced two segments, ENDLIST and READY; FFmpeg decoded H.264/AAC. Terminating the browser attempt's actual encoder produced a visible attendee error and removed its player while two stage peer endpoints stayed connected.                                                                                                                                                                                                                      | Passed with real FFmpeg and native Chrome; generated/test devices                |
| P6-A06: webinar live and replay        | Host created a webinar through the UI, enabled synthetic devices, joined, spawned and promoted a demo. Both stage peer endpoints connected. The independent attendee had zero capture tracks and zero peer connections. Live video decoded at 1280x720 with seven decoded frames and advancing currentTime (0.226285s at sample). After stop, room replay decoded at 1280x720, eight frames, currentTime 0.214768s. The captured frame showed both stage sources in two columns. | Passed in native Chrome with synthetic devices; not human audible playback       |
| Normal stop / final tail               | Nine chunks were acknowledged with 204. The final blob was delivered before native stop, and every accepted upload completed before the WebSocket server-stop command. Recorder output tracks ended and its mix closed; borrowed capture tracks stayed live.                                                                                                                                                                                                                     | Native recorder and real HTTP/FFmpeg                                             |
| Short stop before the first timeslice  | After a 200ms wait from native recording start, Stop produced one 19,017-byte final blob at sequence 0; its 204 at 18432.100ms preceded server stop at 18433.400ms on that document's clock. Catalog reached READY.                                                                                                                                                                                                                                                              | Native asynchronous final-data ordering                                          |
| Fresh replay entry                     | A new independent window with no guest session entered a name on the replay page, remained at the same replay path and played 1280x720 video (eight frames, currentTime 0.226760s).                                                                                                                                                                                                                                                                                              | Actual guest API and browser route                                               |
| Native recorder failure path           | Calling stop on the actual active MediaRecorder unexpectedly displayed the producer error, ended owned outputs and preserved borrowed input tracks.                                                                                                                                                                                                                                                                                                                              | Native unexpected stop; native onerror remains covered by controlled regressions |
| P6-A08: leave during live output       | Host leave ended all observed input/output tracks, closed peers and recorder mix, and showed This room has ended to the attendee.                                                                                                                                                                                                                                                                                                                                                | Native Chrome cleanup with synthetic sources                                     |
| Page exit and history return           | During another recording, navigation synchronously ended input/output tracks and closed peers. History return did not restart capture/recording or leave the client joined.                                                                                                                                                                                                                                                                                                      | Actual navigation/history; no claim of persisted BFCache restoration             |

The final native-browser run reported no uncaught runtime exceptions and completed cleanup successfully. One earlier harness run measured pagehide before the application's listener; the observer was moved after that listener before accepting the cleanup result. Another earlier cleanup hit a Chrome profile lock; the owned profile was removed and the final temporary harness used bounded deletion retries. These were harness corrections, not application patches. The final run left no fixture database, Redis keys or temporary media/profile directory; existing containers and live namespaces were not reset.

P6-A05, P6-A06 and P6-A08 now pass in the above scope; P6-A01 through P6-A04 and P6-A07 retain earlier evidence and automated regressions. P3-A03 physical microphone/human audible output, P3-A05 native picker/browser stop UI, and P3-A06 physical camera indicator remain unverified by explicit user instruction. This is not a waiver and the full V1 definition of done stays open. Process capacity, catalog pagination and retention remain deployment work outside these maintenance slices.

**Final gate (2026-11-03):** the corrected normal-environment `pnpm check:release` run passed all 41 tooling, 149 shared, 217 web and 155 API tests, all package typechecks/lint and both builds. It stopped at whole-worktree formatting solely on the pre-existing untracked `briefing.html`, which remains untouched. `pnpm exec prettier --check . '!briefing.html'` passed. The remaining `pnpm check:artifacts`, `pnpm smoke:live` and `pnpm smoke:broadcast` passed separately; the final broadcast integration again produced five chunks, two decoded HLS segments, ENDLIST/READY and successful cleanup. `pnpm audit:check` passed with only the three existing unexpired development exceptions. Local Markdown links (29) and all 18 referenced maintenance commits were validated. An initial attempt set NODE_ENV=production for the entire local gate and correctly rejected the example development JWT secret before six API suites could load; that environment mistake was corrected without changing any config file. The results above are from the corrected run.

The web build was additionally rerun with `NODE_ENV=production`, followed by both artifact checks. Raw/gzip-estimate bytes were: home 328,337/103,264; room including entry 458,647/142,274; replay including entry 344,448/109,520; deferred HLS playback chunk 579,836/178,965. These are artifact sizes, not measured network transfer. The deferred-player size warning remains visible; no threshold was raised. The automated checks and native-browser observations are positive evidence, while the combined release command remains non-green because of the unrelated formatting file. V1 remains not fully verified because the three physical observations are explicitly open.

## Maintenance: V3M-C09 — Bound room projections (2026-11-06)

Status: committed. Proposed commit: `fix(broadcast): bound reloadable room projections`.
Actual commit: `62fbaf9`.

R08's reloadable BroadcastsService projection cache is capped at 256 LRU entries, including nulls and unfinished reads. Entry identity prevents an older read from undoing a lifecycle write or invalidation. Domain cleanup and encoder reservations are retained independently of eviction. Focused tests passed (73); all selected API gates passed (587 tests, typecheck/lint/build/artifacts, formatting, live smoke, and real FFmpeg broadcast/restart/deletion-recovery smoke). Commands, regression scope, and observation limits are in [phase6.md](../phase6.md). This does not establish VPS capacity or close existing physical acceptance gaps.
