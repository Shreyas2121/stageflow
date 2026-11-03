# Phase 6 — Broadcast, replay, and the README

**Status:** All six feature slices are committed. P6-A01 through P6-A08 have passed within their recorded automated/native-browser scope. RC18 verified real Chrome recording and HLS playback with synthetic devices after the acceptance fixes in `326dea3`. Physical Phase 3 observations remain explicitly unverified; the complete V1 gate remains open.\
**Last updated:** 2026-11-03.\
**Master plan:** `MASTER_PLAN.md` version `1.0.9`, Sections 1.4, 2.2, 6.3, 6.5, 7.2, 11, 12.2, 13, 14.5, 16 (Phase 6), and 18.\
**Execution guide:** [phase6/guide.md](phase6/guide.md). That guide owns P6-C01 through P6-C06. This file owns the rules those commits must satisfy.\
**Requirement IDs:** CAST-01, CAST-02, CAST-03, ROOM-03 for in-flight broadcasts, SHIP-01, RTC-05 for the recorder, and the Section 2.2 demo script.

## 1. Outcome

A webinar attendee watches the host's stage as one live HLS broadcast, then watches that same playlist as a replay. The stage mesh stays up if FFmpeg cannot start. The README explains the ceiling, the delay, and the restart rule without sending the reader to the phase files.

Example: Ava creates a webinar, joins, spawns demo peers, and promotes one onto the stage. In a second window Sam is an attendee and has no peer connection. Ava starts the broadcast. After the normal segment delay, Sam sees the composite. Ava stops it. Sam plays the replay from `/replay/:broadcastId`. A meeting still cannot start a broadcast.

## 2. Entry prerequisites

Phase 5 is complete. `HEAD` is `04f91b7fffa2d1e3fe83b0dd8e5662bc5199a830` (`docs(phase5): record the final slice hash`). The worktree was clean while writing this plan. P5-A01 through P5-A06 passed with synthetic browser devices. P3-A03, P3-A05, and P3-A06 remain open. This phase does not record those observations.

Observed at that commit:

- `broadcast:start` and `broadcast:stop` already ack `broadcast_not_available` and do not touch Redis or PostgreSQL. The attendee region renders `The host has not started the broadcast.` and no media element. Webinar hosts see both broadcast controls. Meetings do not.
- `RoomSnapshot.broadcast` is fixed at `null`. There is no broadcast table and no `sf:room:{roomId}:broadcast` key.
- `liveKeys` returns five keys. `apps/api/src/live/scripts` contains eight Lua files. `common.lua` binds only those five names.
- `FFMPEG_PATH` and `DATA_ROOT` are already in the environment example. `DATA_ROOT` defaults to `apps/api/data`, which is gitignored. Missing FFmpeg must not fail API startup.
- The JSON body limit is `HTTP_BODY_BYTES`, whose schema maximum is 1 MiB. A chunk is 2,000,000 bytes, so it cannot use that parser.
- CORS allows `Authorization` and `Content-Type` on GET and POST.
- Live media services stay in `apps/web/src/features/live/`. Broadcast services do not go there.
- Web dependencies do not include `hls.js`.

Recheck at execution. Git follows master Section 1.4. A full CAST-03 needs `ffmpeg` on `PATH`. If it is missing, leave CAST-03 unverified and still test the missing-binary failure.

## 3. Included and excluded

### 3.1 Included

- One host-only webinar broadcast at a time, composited in the host browser and written by one FFmpeg process to a single 720p event playlist.
- Ordered chunk acceptance, confined HLS serving, the in-room player, and `/replay/:broadcastId`.
- Startup failure of in-flight broadcast rows, and README limitations.

### 3.2 Excluded

Master Sections 3.2 and 11 forbid these. They are the exclusions this phase is most likely to violate.

- A second rendition, LL-HLS, DASH, server-side RTP mixing, or a second FFmpeg process for the same broadcast.
- BullMQ, a worker process, a retry after FFmpeg exits, and any object-storage upload.
- Keeping a second archived WebM, or a retention job. Disk growth is accepted and documented.
- An attendee peer connection, or stage members watching HLS of themselves.
- A broadcast catalog page beyond the replay route and the in-room link.
- A production image, a new admission cap, or a higher global JSON body limit.
- Closing P3-A03, P3-A05, or P3-A06.

## 4. Requirement mapping

| ID      | Meaning in this phase                                                                                             | What this phase does not claim                   |
| ------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| CAST-01 | Only the webinar host starts a broadcast. A second start is rejected. Chunks apply in order or are refused        | A meeting broadcast                              |
| CAST-02 | An attendee plays the live playlist and still has no peer connection. A missing FFmpeg binary leaves the mesh up  | Low-latency delivery                             |
| CAST-03 | A clean stop leaves a playlist that contains `ENDLIST`. A failed FFmpeg run is `FAILED` with a visible error      | A required thumbnail                             |
| ROOM-03 | Owning startup marks `STARTING`, `LIVE`, and `STOPPING` rows `FAILED` with `api restarted`. Room rows stay        | Deleting `READY` files                           |
| SHIP-01 | The README states the demo script, the mesh ceiling, the HLS delay, the restart policy, and the supported browser | A marketing page                                 |
| RTC-05  | Leaving stops the compositor, the mix, the recorder, and the upload loop                                          | The earlier camera-leave checks already recorded |

## 5. System contracts

### 5.1 Who and when

Webinar host only. A meeting start returns the existing `broadcast_not_available` ack and writes nothing. A caller who is not the host receives `not_host`.

One broadcast at a time. `tryBeginBroadcast` sets `sf:room:{roomId}:broadcast` only when that key is absent. If it is present, the start ack is `broadcast_active` with the message `A broadcast is already active.` No second row is inserted.

The order is fixed. Insert the PostgreSQL row as `STARTING`, set the Redis key, then spawn FFmpeg. Spawn only after both of those exist. If the binary cannot start, set `FAILED`, store an error that names the missing binary, clear the Redis key, and emit the snapshot. Do not close peer connections.

If inserting the row or reserving the key throws, do not spawn. A failed reservation deletes that row. A failure after the reservation stops the child, including when the `STOPPING` save or its publication fails, and then finalizes the attempt. Finalization saves one terminal status, clears only that attempt id, publishes, and drops the attempt. It retries a failed save, clear, or publish up to three times and keeps the remaining steps if they still fail. A later stop or the child-exit callback continues those steps. `clearBroadcast` still deletes the key only when the id matches, so a newer attempt stays reserved. Process shutdown still only closes stdin. The next owning startup marks leftover in-flight rows `FAILED`.

The Redis key exists only while the status is `STARTING`, `LIVE`, or `STOPPING`. `clearBroadcast` deletes it. `READY` and `FAILED` do not keep it.

`broadcast_not_available` keeps the sentence `Broadcast is not available yet.` Add `broadcast_active` and `ffmpeg_unavailable`. The missing-binary sentence is `FFmpeg is not available. The stage is still up.`

### 5.2 Broadcast row

One row per attempt. Add it with a TypeORM migration. `synchronize` stays off.

| Field                  | Rule                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| `id`                   | Server UUID                                                                |
| `roomId`               | The webinar                                                                |
| `status`               | `STARTING`, `LIVE`, `STOPPING`, `READY`, or `FAILED`                       |
| `playlistPath`         | Relative path under `DATA_ROOT`, or null                                   |
| `thumbnailPath`        | Relative path, or null. Thumbnail failure does not change `READY`          |
| `errorMessage`         | Null unless `FAILED`. The FFmpeg stderr tail is capped at 2,000 characters |
| `startedAt`, `endedAt` | Set by the server                                                          |

`GET /api/rooms/:slug/broadcasts` lists that room's public catalog objects for a logged-in caller. `GET /api/broadcasts/:id` returns one public catalog object: `id`, `roomId`, `status`, `playlistUrl`, `errorMessage`, `startedAt`, `endedAt`, and `createdAt`. `playlistUrl` is `/api/broadcasts/:id/hls/index.m3u8` while a playlist exists, otherwise null. `playlistPath` and `thumbnailPath` stay on the stored row and are omitted from this JSON. The guest bearer token is sent only with that same-origin playlist and its segment files (`segment` plus at least six digits, then `.ts`). Absolute and cross-origin media URLs are outside this contract and must not receive the token. Media bytes are not stored in PostgreSQL.

The room snapshot's `broadcast` field becomes the master Section 7.2 object or null. It carries the in-flight attempt, or the newest attempt when none is in flight, so a `FAILED` or `READY` result is visible. It does not carry the thumbnail. Null remains the value before the first attempt.

The API keeps that projection with the attempt. A `STARTING` row is projected only after its Redis reservation succeeds. A successful save of `LIVE`, `STOPPING`, `READY`, or `FAILED` replaces it. Ordinary stage publication reuses the projection and does not read the catalog again. The first publication for a room reads the catalog once, including a room with no row. A broadcast lifecycle publication refreshes the projection before Redis assigns the next revision. If publication fails after a revision is committed, that revision stays pending. The next command in the room queue delivers it, including an unchanged retry, and the retry does not create a revision. A join that fails during publication leaves the caller joined. Repeating that join delivers the pending snapshot and acknowledges success without applying join again. A joined caller with nothing pending still receives `already_joined`.

Set `LIVE` only after the process is running. Set `STOPPING` when a stop begins. Do not spawn a replacement if the process exits first. Mark `FAILED`, clear the key, and emit the snapshot.

### 5.3 Startup and leave

The process that acquires the namespace owner performs both broadcast failure and presence cleanup before it becomes ready. A process that does not acquire the owner changes neither.

1. Mark every `STARTING`, `LIVE`, or `STOPPING` row `FAILED` with `api restarted`.
2. Delete only that namespace's live room keys, as startup already does.

`READY` rows and their files stay. Catalog room rows stay. Clients still treat the socket drop as a leave.

Host leave ends the room through the existing path. Before that deletion, stop an in-flight broadcast with the Section 5.6 stop rules. A clean exit may still become `READY`. Shutdown closes FFmpeg's stdin and does not wait forever. The next owning startup applies the `api restarted` rule to anything still in flight.

### 5.4 Host compositor

The recorder lives under `apps/web/src/features/broadcast/`. It may be called from the live room. It does not import a live component, and live services do not move into that feature.

An offscreen canvas, 1280×720, draws the current stage video elements at 24 fps.

| Stage count                                 | Layout                                                        |
| ------------------------------------------- | ------------------------------------------------------------- |
| 1                                           | Full frame                                                    |
| 2                                           | Two columns                                                   |
| 3 or 4                                      | 2×2. Empty cells stay the background color                    |
| Any, while a stage member is screen sharing | That frame fills the canvas. Other stage videos are not drawn |

One `AudioContext` mixes the current unmuted stage tracks, local and remote, into a `MediaStreamAudioDestination`. Rebuild the graph when the stage set or mute flags change. Disconnect the old nodes on rebuild.

`MediaRecorder` uses `video/webm;codecs=vp8,opus`, `videoBitsPerSecond: 2_500_000`, and a 1000 ms timeslice. The first blob is sequence `0` and must be uploaded. It carries the WebM header.

Send sequence `n+1` only after `n` returns 204. Hold at most 8 unsent blobs and 8,000,000 unsent bytes, including the in-flight blob. Refuse a blob that would exceed either bound. Each request has a 10-second deadline, including response headers; expiry aborts the request. Overflow, non-204 responses, and request failure use the existing producer-failure path and report an upload failure, including to a later drain. Stop and drain expiry clear the request deadline. The 8-second normal-finish drain can expire first. These are fixed browser work budgets, not broadcast duration or attendee caps.

A normal Stop broadcast finishes the recorder before `broadcast:stop`. The recorder delivers its final blob through `dataavailable` and then fires `stop`. The client uploads that blob, and every earlier accepted chunk, in order. Owned capture and mix tracks stay live until those uploads settle, then they are released. The final-blob wait and the upload drain each give up after 8 seconds. A failed or timed-out drain shows an error and still asks the server to stop; that partial recording is not a clean completion. Blobs that arrive after the recorder's `stop` event are ignored.

Leave, room end, and page unload abort instead. They cancel the canvas frame, drop unsent chunks, release owned tracks, and close the mix without waiting for an upload. Leave still stops the camera and the peer connections.

Page lifecycle (RC07): pagehide releases camera, microphone, screen capture, peers, demo peers, speaker analysis, and recorder/upload resources immediately, including when the browser retains the document in its back/forward cache. It closes signaling without waiting for leave, stop, or upload acknowledgements. Server disconnect handling ends a host room; RC06 producer-loss protection bounds an abandoned encoder if disconnect delivery is delayed. On pageshow after exit, the page stays in the lobby and asks the user to join again. Stage members must enable devices again; attendees can join without capture. Nothing restarts automatically, and a host room that the server has ended stays ended. Switching tabs alone does not trigger this exit policy.

RC16 ledger ownership: shared chunk validation only decides accept/duplicate/conflict/future/oversize from metadata and a read-only ledger view. The attempt owns one append-only hash map. After a successful FFmpeg write, under the existing write exclusion, the API appends that sequence/hash and advances nextExpected. Failed writes commit neither. Decisions never enumerate or copy earlier hashes, so sequence processing is linear in chunk count (plus hashing the incoming bytes). Hash storage still grows with accepted chunks; encoder concurrency, disk retention, and catalog pagination require separate deployment work.

RC06 producer health: native recorder errors, unexpected stops, and 12 seconds without a nonempty blob use one local failure path. Room media stays available. A finish with no media reports recorder failure. FFmpeg bounds first input and later inactivity to 20 seconds; only a completed nonempty write renews that deadline. Empty chunks are rejected and duplicate uploads do not renew it. Producer loss aborts the child and finalizes FAILED through the existing reservation-clear/publication path. Normal stop cancels the input deadline and retains the 10-second child exit bound. The client allows 15 seconds for a stop acknowledgement and reconciles READY/FAILED snapshots for the same attempt if the acknowledgement is lost. An unresolved stop reports that confirmation is pending. Producers do not restart automatically.

Stage members keep the mesh tiles. They do not play HLS of themselves.

### 5.5 Chunks

`POST /api/broadcasts/:id/chunks` with a raw body, header `x-chunk-sequence` as a non-negative integer, and `content-type: application/octet-stream`.

Allow `x-chunk-sequence` in CORS. Parse this route with its own raw parser limited to 2,000,000 bytes. Do not raise `HTTP_BODY_BYTES`. Early network admission bounds these posts separately from HLS reads and ordinary API requests, before that parser runs. After the caller is confirmed as the host, the upload also spends that user's allowance and that attempt's allowance.

| Rule            | Behavior                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------- |
| Caller          | The host user of that broadcast                                                              |
| Maximum body    | 2,000,000 bytes                                                                              |
| Accept          | `sequence === nextExpected`. Write those bytes to the FFmpeg stdin. Increment `nextExpected` |
| Duplicate       | Same sequence and the same SHA-256 already accepted: `204`, and write nothing                |
| Conflict        | Same sequence and a different hash: `409`                                                    |
| Future sequence | `409`. V1 does not reorder a window                                                          |
| Oversize        | Refuse before a write                                                                        |

`acceptChunk` is the pure function the controller uses. The next-expected counter and the accepted hashes live with the one supervisor. They are not PostgreSQL columns.

### 5.6 FFmpeg and files

`FFMPEG_PATH` defaults to `ffmpeg`. `buildHlsArgs(outputDir)` returns the argument list and takes no client string, title, or display name.

The list must encode these locked choices:

- Input is stdin WebM, `pipe:0`, with generated timestamps.
- Video is H.264, `yuv420p`, 1280×720, 24 fps, 2500 kbps, GOP length 96.
- Audio is AAC, 128 kbps, 48 kHz, stereo.
- HLS event playlist, 4-second segments, `independent_segments`, no `delete_segments`, playlist `index.m3u8` inside `outputDir`.

Segment files and the playlist stay inside `{dataRoot}/broadcasts/{broadcastId}/`. Resolve the directory and reject any path that escapes `dataRoot`. User text never enters the command or the path.

The API writes accepted chunk bytes to that process stdin, in order. It does not start a second FFmpeg for the same broadcast.

Stop closes stdin and waits for process exit even when catalog notification failed. A child exit during that wait is finalized once. Then:

- Exit code 0 and a playlist on disk become `READY`, clear the live key, and keep the files.
- Anything else becomes `FAILED` with the captured stderr tail, capped at 2,000 characters.

After a successful exit, one short extra FFmpeg invocation may write `thumbnail.jpg` from the playlist. If it fails, leave `thumbnailPath` null and keep `READY`.

Expected glass-to-glass delay is about 8–20 seconds. Do not add low-latency HLS.

### 5.7 Playback

Serve that broadcast directory and nothing above it. Both playlist and segment routes require the guest bearer token.

- Playlists: `Cache-Control: no-cache`, MIME `application/vnd.apple.mpegurl`.
- Segments: a long cache, MIME `video/mp2t`.
- No directory index.

Attendees, and the replay page, use `hls.js` against the playlist URL. While the status is `LIVE` or `STOPPING`, the in-room player follows the live edge. While `READY`, it is a VOD control, in the room and on `/replay/:broadcastId`. `FAILED` shows `errorMessage` and no player. Other replay statuses show the status and the error, not a live player. Before the first broadcast, the attendee view keeps the roster and `The host has not started the broadcast.`

Add `hls.js` when the player slice starts. Resolve the current stable version then and commit the lockfile. Do not copy a version from `idea.md`. The home page must not download it.

A `READY` broadcast links to `/replay/:broadcastId`. A visitor without a usable session enters a name on that replay route, receives a guest session without a room operation, and stays at the validated local replay destination. Do not add a library tab.

### 5.8 Disk and the README

V1 keeps the HLS directory after the broadcast ends. It does not keep a second WebM. Do not add a retention job.

The README states the Section 2.2 script, the 4-person mesh ceiling, the 8–20 second HLS delay, the restart rule, current Chrome or Edge on Windows, STUN with local loopback, optional TURN, and local disk growth under `DATA_ROOT`. It tells the reader that a missing FFmpeg binary fails the broadcast and leaves the mesh usable.

## 6. Acceptance matrix

| ID     | Observable result                                                                                                                                       | Method                                             | Status                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| P6-A01 | `acceptChunk` covers the next sequence, a duplicate hash, a conflicting hash, a future sequence, and an oversize body. `buildHlsArgs` locks Section 5.6 | `pnpm --filter @stageflow/shared test`             | passed                                                                |
| P6-A02 | Owning startup marks in-flight rows `FAILED` with `api restarted`, keeps `READY`, and still clears only that namespace's live keys. Room rows remain    | API test                                           | passed                                                                |
| P6-A03 | A meeting and a second start are rejected with no extra row. A missing FFmpeg binary sets `FAILED`, clears the key, and does not remove stage members   | API service test                                   | passed                                                                |
| P6-A04 | A resolved path outside `DATA_ROOT` is rejected. Playlist and segment responses use the Section 5.7 cache and MIME values                               | API test                                           | passed                                                                |
| P6-A05 | A few seconds of real FFmpeg output include `#EXT-X-ENDLIST`. A non-zero exit is `FAILED` with a visible error and no player                            | Real FFmpeg via `FFMPEG_PATH`/`PATH`, then browser | passed (2026-11-03; real FFmpeg and native Chrome, synthetic devices) |
| P6-A06 | The Section 2.2 webinar script plays live HLS to an attendee with no peer connection, then plays the replay. Stage members keep the mesh                | Browser                                            | passed (2026-11-03; native Chrome, synthetic devices)                 |
| P6-A07 | The README states every limitation in Section 5.8                                                                                                       | Read `README.md`                                   | passed                                                                |
| P6-A08 | Host leave stops the canvas frame, the recorder, the upload loop, and the mix context                                                                   | Web test and browser                               | passed (2026-11-03; service regressions and native Chrome cleanup)    |

CAST-01 is A01 and A03. CAST-02 is A03 and A06. CAST-03 is A05. ROOM-03 for broadcasts is A02. SHIP-01 is A07. RTC-05 for the recorder is A08. The Section 2.2 gate is A06.

If neither `FFMPEG_PATH` nor `PATH` provides real FFmpeg, A05 stays unverified. A03 still covers the missing-binary half of CAST-02.

## 7. Verification commands

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
docker compose up -d
pnpm dev
```

The artifact check must follow the script count and the key count this phase actually ships. Do not leave it asserting eight Lua files or five live keys after those files exist.

Search from the repo root:

```powershell
rg -n "BullMQ|delete_segments|R2|S3" apps packages
rg -n "hls" apps/web/src/pages/HomePage.tsx apps/web/src/main.tsx
```

Both searches print nothing.

## 8. Risks

| Risk                                                            | What to do                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| Attendees receive a peer connection so the broadcast is easier  | Section 5.4. Attendees stay on HLS                                |
| Chunks arrive out of order and are appended anyway              | Section 5.5. One in-flight sequence, decided by `acceptChunk`     |
| FFmpeg exits and the API restarts it, appending a second header | Section 5.2. Mark `FAILED` and do not spawn again                 |
| A title or display name reaches the FFmpeg argument list        | Section 5.6. Arguments come from `buildHlsArgs` and server ids    |
| The chunk route raises the global JSON limit                    | Section 5.5. Its parser is separate and capped at 2,000,000 bytes |
| The recorder is placed under the live feature                   | Section 5.4. It stays in `features/broadcast`                     |
| A failed thumbnail fails the broadcast                          | Section 5.6. `READY` stands, with a null thumbnail                |
| Startup deletes `READY` files or marks them failed              | Section 5.3. Only `STARTING`, `LIVE`, and `STOPPING` change       |

## 9. Exit and handoff

Phase 6 is done when A01–A08 are verified and each slice is committed under master Section 1.4. A missing FFmpeg binary leaves A05 unverified rather than failed by a skip. The two-window check uses a real attendee window. A demo peer can fill the stage, and it does not replace that attendee.

There is no later phase. A finished V1 still carries the open Phase 3 physical observations until those are recorded. `READY` replays remain playable after a restart. The repository must contain no secrets, no filled `.env`, and no broadcast media.

RC18 current evidence (2026-11-03): P6-A05/A06/A08 were exercised through native Chrome 156.0.8078.74 on Windows with synthetic devices and real FFmpeg 6.0, against `326dea3`. The Phase 6 guide records live/replay metrics, final-tail ordering, a short recording, native recorder stop, actual encoder termination, guest replay entry, host leave, navigation/history cleanup and command results. These observations do not verify physical input, human audible output, the native picker/stop UI, or hardware indicators. The user explicitly retained those P3-A03/P3-A05/P3-A06 gaps.
