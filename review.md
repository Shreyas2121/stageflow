# StageFlow review after Phase 6

Reviewed on **2026-11-02**, against **`9d6f89b`**. This report replaces the previous review, which is absent at this revision. It reviews the current frontend, backend, shared algorithms, Lua scripts, tests, configuration, documentation, dependencies, and development/release tooling. Application source was not changed during this review.

**Maintenance update (2026-11-03):** Sections 1 through 8 preserve the review against 9d6f89b. Section 9 records current requested maintenance, native browser evidence and remaining acceptance limits. Earlier unverified states and unavailable tools describe that review date, not current capabilities.

## 1. Verdict and scope

**The six feature phases are implemented. V1 is not yet fully verified, and several broadcast lifecycle defects should be fixed before calling it finished.** The strongest problems concern resource ownership, the end of a recording, and recovery when a dependency fails after state has changed. They are not lint or folder-naming problems.

The earlier remediation made substantial improvements: Tailwind is installed and used, route components are smaller, media logic has feature-local services, shared validation is stronger, Redis mutations are incremental and atomic, admission/queue limits exist, tests are excluded from production output, and CI selects affected packages. Those improvements remain valid. This report does not carry old findings forward as though they were still unfixed.

The execution authority is `MASTER_PLAN.md` **1.0.8**. `idea.md` is explicitly superseded. A multi-rendition encoder, BullMQ, R2, accounts, chat, an SFU, distributed API ownership, and a retention worker are not missing V1 requirements. Future growth calls for clear ownership and measurable budgets now; it does not justify implementing those systems during this maintenance pass.

Priority meanings:

- **P1:** fix before relying on the completed V1 broadcast or supported Windows development workflow.
- **P2:** concrete resilience, usability, maintainability, or performance work; sequence after P1.
- **P3:** small cleanup or a documented growth consideration; avoid a broad rewrite.
- **Acceptance gap:** missing evidence, distinct from a demonstrated implementation defect.

Section 7 covers every one of the **211 tracked files** at the reviewed revision. Generated output, dependencies under `node_modules`, ignored local secrets, database volumes, and generated recordings are outside that source inventory. The lockfile was assessed as generated dependency metadata through manifest/lock consistency, installation/build results, and audit results; this is not an independent audit of every dependency's implementation. A file marked “No additional finding” is not a guarantee that it contains no defects.

## 2. Verification performed and its limits

| Check                                       | Current result                                                      | What it establishes                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:release`                        | **Pass**, approximately **97.15 seconds** on this Windows workspace | Tooling tests, typechecks, lint, tests, builds, formatting, artifact checks, and isolated socket smoke all pass                    |
| Shared tests                                | **149**, 8 files                                                    | Algorithms, parsers, moderation decisions, ordering, and argument construction                                                     |
| Web tests                                   | **132**, 18 files                                                   | Service behavior with controlled browser/media/transport substitutes                                                               |
| API tests                                   | **130**, 16 files                                                   | Service behavior, controlled process supervision, admission, and real Redis integration                                            |
| Tooling tests                               | **8**                                                               | Audit policy and affected-check selection                                                                                          |
| `pnpm audit:check`                          | **Pass under the committed exception policy**                       | No production advisories reported by this run; three development advisory exceptions remain                                        |
| Production artifacts                        | **Pass**                                                            | No emitted API/shared tests; all **11 Lua assets** copied; expected built-module and browser-entry checks pass                     |
| Socket smoke                                | **Pass**                                                            | Real Redis, JWT verification, gateway/client wiring and selected live events; durable repositories are substitutes                 |
| Real healthy FFmpeg encode                  | **Not run**                                                         | `ffmpeg` is absent from PATH; controlled children and fixture playlists do not prove encoding                                      |
| Actual browser playback/device observations | **Not run in this review**                                          | No available browser automation tool; unit substitutes do not prove audible output, native picker behavior, or hardware indicators |

Environment: Node **22.23.2**, pnpm **12.9.1**. The existing PostgreSQL and Redis containers were healthy. They were not restarted, live presence was not reset, and no FFmpeg installation was performed. The injected catalog-failure log during the socket smoke is an expected negative-path check, not a failed release gate.

The local example configuration sets `NODE_ENV=development`, which affects React output even when Vite runs its production build command. After the release baseline, the web build and `check:artifacts --web` were rerun successfully with **`NODE_ENV=production`**. R14 uses those production-mode measurements. Do not compare the earlier development-mode main bundle against production budgets.

Four additional isolated probes exercised the actual service/recorder implementations with controlled dependencies. They did not alter application source or live Redis/PostgreSQL state:

1. Starting and stopping `StageRecorder` left both owned output-track substitutes with `readyState: "live"`; the recorder itself became inactive. This confirms missing explicit track cleanup, not a measurement of a real browser's garbage collection.
2. After a webinar media mutation, one injected broadcast-snapshot failure returned `server_error`. Retrying the same patch returned success, with **zero publications**, while Redis state had the new mute value and revision. The probe used the real shared stage reducer and compiled live service with isolated state.
3. After a broadcast started, an injected STOPPING publication failure left **zero supervisor stop calls**, no reservation clear, a retained running entry, and catalog state STOPPING. A subsequent controlled child exit was ignored by the stopping guard. A unique temporary media fixture was removed after the probe.
4. A failed startup catalog callback retained the non-expiring owner token, and a second startup was refused. **This matches the documented failed-partial-startup recovery policy**; it is recorded as an operating limitation, not an accidental new defect.

The probes are evidence for this report, not committed regression tests. Section 8 specifies the small behavioral regressions to retain with the fixes.

### V1 acceptance remains open

The current records already say this correctly:

| Acceptance            | Recorded state                               | Required evidence                                                                    |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| P6-A01 through P6-A04 | Passed within their recorded scope           | Preserve these results; do not reinterpret controlled-process tests as real encoding |
| P6-A05                | **Unverified**                               | Real FFmpeg input, playable output, proper stop and `#EXT-X-ENDLIST`                 |
| P6-A06                | **Unverified**                               | Actual host/attendee browser sequence, live playback, replay, and failure behavior   |
| P6-A07                | Passed                                       | README completeness; this is a documentation check                                   |
| P6-A08                | Automated half passed; **browser half open** | Recorder/compositor behavior and cleanup in an actual browser                        |
| P3-A03                | Physical observations open                   | Physical microphone input and human audible output                                   |
| P3-A05                | Physical observations open                   | Native screen picker and browser stop control                                        |
| P3-A06                | Physical observations open                   | Camera indicator after leaving                                                       |

The earlier user-authorized prerequisite exception allowed later phase work. It did not verify these observations. Finishing six commit sequences is different from passing the final demo gate.

## 3. Prioritized current findings

| ID  | Priority   | Finding                                                                                   |
| --- | ---------- | ----------------------------------------------------------------------------------------- |
| R01 | P1         | Recorder-owned output tracks have no deterministic stop                                   |
| R02 | P1         | Normal broadcast stop drops final recorder data and queued uploads                        |
| R03 | P1         | Catalog failure after a Redis mutation can permanently suppress its snapshot              |
| R04 | P1         | Broadcast stop/finalization can strand the child and reservation after dependency failure |
| R05 | P1         | Supported Windows dev restarts force-kill the API that owns a non-expiring guard          |
| R06 | P2         | Native recorder failure and missing input have no coordinated failure path                |
| R07 | P2         | `pagehide` stops only the recorder; full room cleanup/restoration is unspecified          |
| R08 | P2         | HLS reads and host uploads compete in one IP request budget                               |
| R09 | P2         | Shared builds can delete each other's output or accept stale watcher readiness            |
| R10 | P2         | Release checks rebuild shared six times                                                   |
| R11 | P2         | Lint fingerprints the entire workspace for every package and invalidates unrelated caches |
| R12 | P2         | Broadcast REST contract and validation are duplicated across frontend/backend             |
| R13 | P2         | `RoomSession` is again accumulating unrelated lifecycle ownership                         |
| R14 | P2         | Opening any room loads the HLS player dependency, including meetings and hosts            |
| R15 | P2         | Repeatable release checks do not exercise actual Nest/PostgreSQL/FFmpeg integration       |
| R16 | P2         | A replay visitor has no name-only guest-session entry flow                                |
| R17 | P2, growth | Chunk-history copying is quadratic; byte/process/catalog growth needs explicit budgets    |

### R01 — Stop every output track owned by the recorder

**Locations:** `apps/web/src/features/broadcast/services/stage-recorder.ts:123`, `:139`, `:149`, `:164`.

`start()` obtains a canvas capture track and a mixed-audio destination track, then passes them into a newly assembled stream. Neither the owned stream nor its tracks are retained for cleanup. `stop()` stops the recorder, disconnects audio nodes, closes the audio context, and zeroes the canvas; it never calls `stop()` on those tracks. Failure between capture and successful `recorder.start()` has the same ownership hole. The instance does not retain the recorder until after `start()` succeeds either.

**Impact:** explicit cleanup is incomplete after stop, repeated starts, and partial setup failures. The isolated probe confirmed both output tracks remain live. This is about recorder-created tracks; do not stop the camera/microphone tracks borrowed from stage participants when only ending a broadcast.

**Fix:** retain acquired output resources as soon as they exist. Stop all owned tracks exactly once in a common cleanup path, including partial setup. Retain the recorder before invoking potentially throwing operations. Verify normal stop, failed constructor/start, repeated stop, and preservation of borrowed source tracks. Coordinate this with R02 so output tracks are released after normal final-data collection.

### R02 — Finish normal recordings before closing FFmpeg input

**Locations:** `stage-recorder.ts:164`; `apps/web/src/features/broadcast/services/chunk-upload.ts:64`; `apps/web/src/features/live/services/room-session.ts:574`.

The explicit Stop broadcast action calls synchronous recorder cleanup before sending `broadcast:stop`. That cleanup removes `ondataavailable` before calling `MediaRecorder.stop()`, clears the upload queue, and aborts an in-flight upload. The native recording API delivers final data asynchronously before its stop event. Its timeslice is not a guarantee that all data has already been delivered when the user clicks Stop. See the [W3C recording algorithm](https://www.w3.org/TR/mediastream-recording/#dom-mediarecorder-stop).

**Impact:** an ordinary successful stop necessarily discards pending final data and can discard earlier queued data. Very short recordings may deliver no initial chunk. Longer recordings can lose their ending, while the backend still reports READY for an existing playlist. The exact visible truncation depends on timing; real playback was not available to measure it.

**Fix:** distinguish bounded asynchronous `finish()` from immediate `abort()` cleanup. Normal stop should collect final data, await ordered upload acknowledgements, then request backend stop. Leave/unload may still need immediate cancellation. A failed or timed-out drain needs an explicit failure outcome, rather than silently treating a partial recording as a clean completion. Record the refined lifecycle in the Phase 6 contract/guide because the current drop-on-stop behavior was deliberately implemented there.

**Regression:** use a fake that follows native asynchronous final-data/stop ordering, hold one upload pending, and assert the final accepted chunk precedes the server stop. Test a recording shorter than one interval. Keep emergency teardown bounded; do not await an unbounded upload during leave.

### R03 — Do not lose committed live changes when catalog enrichment fails

**Locations:** `apps/api/src/live/live.service.ts:76`, `:143`; `apps/api/src/broadcasts/broadcasts.service.ts:63`.

Every changed webinar snapshot now awaits a broadcast catalog query before publication. This includes ordinary media/hand/role changes. The Redis command has already committed at that point. If PostgreSQL rejects the enrichment query, the command returns an error without publishing. Retrying the same mutation produces `changed: false`, so `publish()` returns immediately and the committed state is never sent unless another changed command happens later.

**Impact:** clients can remain at an old revision indefinitely even after a successful retry. UI state and media flags applied from snapshots can disagree with server state. Join also establishes room association/membership before this fallible publication, so failure can leave the caller joined despite a failed join acknowledgement. The mute/retry case was reproduced in an isolated probe.

**Fix:** keep ordinary live publication independent of an extra database round trip. Maintain authoritative broadcast snapshot data with its lifecycle, or use a clearly defined cached projection. Track/reconcile an unpublished revision after an error; an unchanged retry must not prevent recovery. Preserve ordering through the existing room queue and do not manufacture revisions for every no-op.

**Regression:** inject enrichment failure after a committed mutation and after join, retry, and prove clients converge without an unrelated user action. Also verify catalog load is not repeated for every media toggle.

### R04 — Make child cleanup independent of catalog/notification success

**Locations:** `apps/api/src/broadcasts/broadcasts.service.ts:80`, `:106`, `:134`, `:168`.

`stopRoom()` sets `entry.stopping = true`, saves STOPPING, and publishes it **before** calling `supervisor.stop()`. A save or publication error exits early. The supervisor's later `done` callback ignores any entry marked stopping, so it cannot recover the abandoned attempt. The reproduced publication failure left the child unstopped and the entry/reservation retained.

`finish()` similarly performs save, reservation clear, publication, and registry deletion in a single fallible sequence. It resets `entry.finishing` after an error, but a child-exit-triggered failure only gets logged; no later retry is guaranteed. Startup also saves a STARTING row and reserves its key before entering its main compensation block. Reservation or setup failure can therefore leave partial attempt state.

**Impact:** a transient dependency error can keep a process or active reservation around, block the next broadcast, and leave the catalog in a misleading transitional state. Host-leave retries improve one path but do not cover every explicit stop, early start failure, and child exit.

**Fix:** define an idempotent per-attempt lifecycle with cleanup obligations that survive notification failure. Attempt process termination in a `finally`/equivalent independent branch. Retain the final outcome and pending cleanup for bounded retries; do not silently forget incomplete finalization. Cover the entire create/reserve/start sequence with appropriate compensation. No durable job queue or automatic encode restart is required.

**Regression:** fail each save/reserve/clear/publish boundary once. Prove the child is stopped, a later exit is consumed exactly once, finalization can retry, and a newer attempt's reservation cannot be cleared accidentally.

### R05 — Gracefully stop the API before a Windows dev restart

**Locations:** `scripts/dev.mjs:26`, `:111`; `apps/api/src/live/live.connection.ts:82`, `:106`; `apps/api/src/main.ts`.

On Windows, `killTree()` uses `taskkill /t /f`. Both a normal shared-source restart and normal dev shutdown use that path. Namespace ownership is non-expiring and is released in Nest application shutdown. Forcefully terminating the process bypasses that release, so the next API can refuse startup because the previous token is still present. FFmpeg descendants are also forcibly killed rather than finalized.

This follows directly from the shutdown paths; a live development API was not killed to demonstrate it. The retained-token startup behavior was independently confirmed with a fake Redis client. The master plan intentionally requires operator recovery after a crash; a routine development restart should not turn into that crash-recovery procedure.

**Fix:** add an explicit local graceful-shutdown channel to the API process and await shutdown completion before replacing its process tree. Use force termination only after a deadline and report the recovery consequence. Exercise the Nest watch restart path as well as shared-source restarts. Merely replacing `/f` with a Node SIGTERM call does not establish graceful Windows behavior; Windows signal behavior differs, as documented in [Node's child-process API](https://nodejs.org/download/release/v22.23.2/docs/api/child_process.html#subprocesskillsignal).

**Regression:** use an isolated namespace and a helper/real API lifecycle fixture on Windows. Perform two successive dev restarts, confirm graceful owner release and child exit, and prove an unrelated owner is never deleted. Keep the explicit no-automatic-takeover policy.

### R06 — Surface native recording failures and detect missing input

**Locations:** `stage-recorder.ts:123`; `room-session.ts:905`; `apps/api/src/broadcasts/ffmpeg-supervisor.ts:34`, `:98`; `apps/web/src/features/live/services/signaling.ts`.

The recorder catches synchronous setup exceptions and upload refusal, but does not subscribe to native `error` or unexpected `stop` events. After a native asynchronous encoder failure, the server can remain LIVE with an FFmpeg process waiting for input. A client can also start a broadcast and never send a first chunk. Write timeouts cover a write that is attempted; they do not cover the absence of writes. The active Redis broadcast claim has no TTL/watchdog.

The server allows up to **10 seconds** for FFmpeg stop, while normal signaling acknowledgements time out at **8 seconds**. A valid bounded slow stop can therefore look like a failed command before its result arrives.

**Fix:** handle recorder terminal events once, surface an actionable error, and release resources. Introduce first-input/idle supervision appropriate to the supported browser behavior, with a defined FAILED outcome; backgrounding must not silently create a forever-LIVE attempt. Align the operation deadline with server stop or reconcile the eventual status after timeout. Preserve the product rule of failing an attempt rather than restarting its encoder.

**Regression:** native recorder error, unexpected stop, no initial input, stalled producer, and a slow-but-successful server stop. Use controlled time; no broad browser test suite is needed for those service boundaries.

### R07 — Define page lifecycle cleanup and return behavior

**Locations:** `apps/web/src/features/live/services/room-session.ts:331`, `:882`; corresponding pagehide test in `room-session.test.ts`.

The new `pagehide` handler stops only the recorder. It does not release camera/microphone/screen capture, close peers, or disconnect the live session. The test expressly preserves the camera and does not request backend stop. A browser that destroys the document may eventually clean up these resources itself; a frozen or retained page needs an explicit lifecycle policy. There is no corresponding restoration flow to reconcile a locally stopped recorder with a still-LIVE backend after a return.

**Impact:** incomplete deterministic cleanup and a possible live broadcast with no producer, depending on actual browser navigation/lifecycle behavior. A real BFCache/hardware leak was not claimed or demonstrated in this environment.

**Fix:** make pagehide use idempotent local teardown, promptly close the signaling connection when appropriate, and define pageshow/re-entry behavior. Do not rely on awaited uploads/socket acknowledgements during unload. Let server producer-loss handling close abandoned attempts. Observe native camera indicators and return navigation in the supported Windows browser.

### R08 — Separate media-read admission from upload/control admission

**Locations:** `apps/api/src/admission/http-admission.ts:6`; `apps/api/src/config/parse-config.ts:92`; `broadcasts.controller.ts`; `chunk-upload.ts`.

Every HLS playlist/segment GET and every host chunk POST consumes the same default **240 requests per 60 seconds per network identity**. One host normally sends about 60 chunks per minute. Each attendee adds segment and repeated playlist reads. Several windows on localhost, or viewers behind a shared NAT, share that identity. Their playback requests can exhaust the budget for the host upload; any non-204 upload response immediately ends the client recorder.

**Impact:** playback demand can interrupt the producer instead of simply limiting viewers. This is a workload/configuration mismatch, not evidence that the documented two-window demo necessarily exceeds the default limit.

**Fix:** give HLS reads a separate bounded budget and give authenticated producer uploads a defined per-user/per-attempt allowance, while keeping early network and byte/concurrency bounds. Verify shared-network traffic, correct 429 headers, and control-request availability. Do not solve this with an arbitrary attendee cap or by removing admission entirely.

For future scale, note that each media request also verifies a real user and reads broadcast metadata before file checks. Measure that database load before adding caches or changing the bearer-auth model.

### R09 — Serialize shared builds and tie readiness to the latest compile

**Locations:** `scripts/shared-build.mjs:90`, `:110`, `:165`; app package scripts.

One-shot builds have no mutual exclusion: each removes shared `dist` before compiling. Running app typecheck/test/build commands concurrently can delete declarations another process is reading. The Phase 6 guide already records a missing-declaration failure during overlapping checks, followed by a passing sequential rerun.

When a watcher exists, `buildShared()` accepts an existing ready marker. The watcher does not remove that marker at the start of a rebuild or after a failed rebuild. A dependent command can therefore accept earlier output or output being rewritten during a failed/current compile.

**Fix:** serialize writers, publish a specific successful generation, invalidate readiness when compilation begins/fails, and require dependent tasks to observe the current generation. Never report a stale successful compile as readiness for newer source. Use temporary/atomic output where useful. Test in disposable fixture directories; do not write a test that deletes the workspace's real `dist` while other checks run.

### R10 — Build shared once per release dependency graph

**Locations:** root `package.json`; `apps/api/package.json`; `apps/web/package.json`; `scripts/shared-build.mjs`.

A release with no running watcher compiles shared **six times**: API typecheck, web typecheck, web test, API test, API build, and web build. Shared's own typecheck runs too. These one-shot compiles delete output and do not use an incremental build configuration. This is avoidable fixed work today and increasingly expensive as the shared package grows.

**Fix:** one release invocation should prepare shared once and reuse a verified result keyed by its inputs/configuration. Preserve safe standalone app commands and cold-clone behavior. A small task graph/fingerprint is sufficient; a new monorepo framework is optional, not a prerequisite. Address R09 before parallelizing independent package work.

**Validation:** compare cold and unchanged runs on the same machine, count actual compiler invocations, change shared source/config, delete output, and prove invalidation works. Do not trade correctness for a lower stopwatch result.

### R11 — Scope typed-lint invalidation to dependencies

**Locations:** `scripts/lint.mjs:10` through fingerprint construction; root lint scripts.

Every lint invocation reads root config, scripts, and all three source trees, then uses that global hash to invalidate its package cache. Root lint invokes this four times. A web-only edit consequently invalidates API and shared lint caches too.

**Fix:** retain protection against stale type-aware lint results, but fingerprint a package and its transitive inputs: API/shared/config for API, web/shared/config for web, and shared/config for shared. Compute common inputs once where practical. Verify that shared type changes invalidate both consumers and isolated web changes preserve API cache reuse. The existing affected-check selection is useful and should remain.

### R12 — Share the public broadcast boundary, not the persistence entity

**Locations:** `apps/api/src/broadcasts/broadcasts.service.ts:35`; `apps/web/src/features/broadcast/api.ts:6`; `packages/shared/src/broadcast.ts`.

Only the status type is shared. The API defines a catalog DTO from its TypeORM entity while the frontend independently defines `BroadcastDetails`, status values, and response validation. The frontend also requires `playlistPath` and `thumbnailPath` just to discard them. This is new protocol duplication at the FE/BE boundary, where drift matters most.

**Fix:** put the transport DTO, status values, and pure parser/validator in shared, including nullability and date/URL policy. Keep filesystem paths, ORM entities, Node modules, and FFmpeg process code out of the browser contract. Keep UI-only playback decisions local. A status check constraint in SQL remains appropriate defense in depth; DRY does not require generated migrations.

**Adjacent future security boundary:** the frontend accepts absolute HTTP(S) playlist URLs and its HLS callbacks attach the bearer token to every loaded URL. Today's API produces confined relative playlists, so no current external-URL exploit was demonstrated. Before supporting external manifests/CDNs, restrict which origins receive credentials and validate resolved segment destinations. Keep this explicit in the shared URL policy.

### R13 — Give broadcast orchestration its own owner

**Locations:** `apps/web/src/features/live/services/room-session.ts` (**963 lines**); `use-live-room.ts`; broadcast service interfaces.

Moving logic out of a page was a good correction, but `RoomSession` now coordinates green-room capture, role consent, peers, screen sharing, active speaker, demo peers, signaling, store updates, page lifecycle, stage DOM refs, and recorder/upload orchestration. Broadcast start, source synchronization, cancellation, and error handling are interleaved with room transitions. R01/R02/R06/R07 show why lifecycle responsibilities need clearer boundaries.

**Fix:** extract a feature-local broadcast controller with a narrow stage-source input and explicit start/finish/abort/error lifecycle. `RoomSession` should coordinate room membership and pass events/data through that interface. Retain existing local-media, peer, role-transition, screen-share, and demo owners. Do not create a global `lib` dumping ground or split each small helper into a file merely to reduce line count.

The hooks subscribe independently and trigger whole-session rerenders; measure before replacing them. If this grows, a stable external-store snapshot/selector boundary is a better direction than adding more notification counters.

### R14 — Defer the HLS runtime until a player is needed

**Locations:** `apps/web/src/features/live/components/live-room.tsx:3`; `attendee-broadcast.tsx`; `broadcast-player.tsx:2`; `apps/web/src/app/entry-graph.test.ts`.

Home/room/replay route splitting works. However, `LiveRoom` statically imports `AttendeeBroadcast`, which statically imports the HLS player. The room dependency graph therefore includes HLS even for meetings, hosts, and stage speakers who do not render it.

Current Vite output with `NODE_ENV=production`:

| Artifact             | Raw size reported by Vite | Gzip estimate reported by Vite |
| -------------------- | ------------------------- | ------------------------------ |
| Main JS              | 301.64 kB                 | 95.11 kB                       |
| HLS/player shared JS | 588.73 kB                 | 183.66 kB                      |
| Room route JS        | 113.21 kB                 | 33.39 kB                       |
| Replay route JS      | 3.86 kB                   | 1.50 kB                        |
| Main CSS             | 24.59 kB                  | 6.13 kB                        |

The artifact graph measured **326,234 raw bytes** of home JS/CSS and **1,028,534 raw bytes** for the room entry and its static JS/CSS dependencies. These are build artifacts and compression estimates, not measured browser network transfer or load time. The earlier local development-mode build measured 546,439 and 1,266,995 raw bytes respectively; its extra React development output is not a production bundle regression. Vite's >500 kB warning remains for the HLS chunk and is advisory; it does not prove that arbitrary manual chunks will help.

**Fix:** lazily load the HLS player at the attendee/replay playback boundary with an appropriate pending/error state. Extend the graph check so a meeting/host entry can avoid the HLS runtime. Investigate the main bundle with a dependency report before setting realistic budgets; do not replace React/Router/Query to chase a warning.

### R15 — Make infrastructure proof repeatable and accurately named

**Locations:** `.github/workflows/checks.yml`; `scripts/check-artifacts.mjs`; `scripts/smoke-live.mjs`; `apps/api/src/broadcasts/broadcasts.runtime.test.ts`; `ffmpeg-supervisor.test.ts`.

CI supplies Redis but sets an intentionally unused PostgreSQL URL. The socket smoke substitutes room/user persistence and manually wires selected handlers; it does not boot the whole Nest application or cover the new moderation/broadcast path as a deployed module. Artifact loading verifies selected compiled modules, not every DI/bootstrap lifecycle.

Broadcast runtime tests use controlled child streams and write fixture playlist text themselves. They are useful for state/error behavior, but cannot establish FFmpeg codec availability, a valid WebM-to-HLS stream, real segment content, or playback. The guide records a one-off real PostgreSQL catalog/migration check; this review did not rerun it, and the release gate cannot reproduce it.

**Fix:** add an isolated service-integration command for migrations and actual Nest bootstrap against disposable PostgreSQL/Redis, and a small healthy-FFmpeg encode/stop/HLS inspection. Run these on relevant backend/shared/media changes and full release gates, not every documentation edit. Keep physical-device acceptance as explicit observations and do not add boilerplate entity/controller unit tests. Any browser harness should match the existing testing policy rather than silently introduce a permanent broad E2E suite.

### R16 — Let a fresh replay visitor obtain a guest session

**Locations:** `apps/web/src/pages/ReplayPage.tsx:18`; `apps/web/src/pages/HomePage.tsx:25`; session API.

A replay link opened without a session says to enter a name on the home page. The home page only issues a guest session as part of creating a room or joining a room by slug. There is no name-only action and no return-to-replay destination. Someone holding only a replay ID must create an unrelated room, or obtain an unrelated room slug, to get authenticated.

**Fix:** provide the existing guest-session step inline or as a small reusable entry route, preserve a validated local return destination, and continue to the original replay. Reuse the existing session API; do not add account registration or refresh tokens. Verify expired-session, canceled-request, and malformed-return cases.

### R17 — Remove avoidable duration-dependent work before broadening usage

**Locations:** `packages/shared/src/broadcast.ts:27`; `chunk-upload.ts:5`; `broadcasts.service.ts:59`, `:238`; `ffmpeg-supervisor.ts`; `buildHlsArgs()`.

`acceptChunk()` copies every accepted hash into a new Map for each chunk. With n chunks it stores O(n) hashes and performs O(n²) cumulative entry copying. At roughly one chunk per second this is minor for a short demo and avoidable work for longer sessions. Preserve duplicate/conflict semantics while changing storage ownership; do not silently reject duplicates currently accepted by the contract.

The browser bounds **blob count**, not total bytes. Native recording delivery can be delayed, so eight blobs are not a precise memory ceiling. There is no upload request deadline independent of future blobs. The backend bounds each chunk and one write at a time, but does not bound the total number of active encoder processes across rooms. The catalog list returns every broadcast for a room without pagination. Data retention is explicitly manual and the local directory deliberately grows with every attempt.

**Fix now/next:** avoid copying the full hash ledger per chunk, add explicit upload byte/deadline accounting, and measure process capacity before allowing broad usage. Preserve full retry semantics or explicitly decide a new replay window in the contract. Before a larger deployment, define encoder concurrency, catalog pagination, disk alerts, and data lifecycle. Disk cleanup, a worker queue, object storage, or a maximum attendee count are product/operations decisions outside this V1 maintenance authorization; their absence alone is not a V1 feature defect.

## 4. Tailwind, React, DRY, and library use

**The old “Tailwind is missing” concern is resolved.** `apps/web/package.json` includes Tailwind and its Vite plugin; `vite.config.ts` installs that plugin; `src/index.css` imports Tailwind with an explicit source; the theme is expressed in `@theme`; UI components use utilities extensively. No Tailwind migration is needed.

The remaining CSS has legitimate responsibilities:

- `styles/theme.css`: shared design tokens used by utilities.
- `styles/base.css`: document defaults and element styling in the base layer.
- `green-room.css`: browser-specific native meter pseudo-elements and reduced-motion handling.

There is a little duplicated input styling between base CSS and `FormField`, and disabled-button cursor rules overlap. Consolidate when touching the shared control styles; this is P3 consistency work, not a reason to ban CSS. Keep utility strings local until a repeated semantic component or variant is clear. A class-merging dependency is only useful if conflicting user-supplied utilities become a real supported component requirement.

For React structure, the feature layout is generally sound. Pages handle routing/query states, feature APIs own transport calls, `lib/http` owns cross-feature HTTP behavior, and imperative media work is outside render. Module constants such as recorder dimensions and layout rectangles are already out of components. Move values into shared only when both runtimes share the meaning, into feature constants when multiple feature modules need them, and into `lib` only when truly cross-feature. A one-use module constant does not need a separate file. Shared limits should replace duplicated protocol limits; UI copy does not need a global constant registry.

TanStack Query receives abort signals and private cache keys are partitioned by user; session replacement cancels/removes private cache entries. Zustand keeps transient room state and rejects older revisions. Socket and REST authentication reuse a single verifier. Thin Nest controllers delegate business work to services, SQL checks defend storage, and Lua atomically enforces stage rules. Preserve these choices. Current public rooms/broadcasts intentionally require a valid guest token rather than an account/membership authorization model; this review does not invent a missing private-room feature.

Smaller P3 items worth addressing when adjacent code changes:

- `RoomsService` repeats its REST mapping and treats every PostgreSQL `23505` as a slug collision. Restrict retries to the slug constraint; select only host fields actually needed. This is not a demonstrated current duplicate-PK failure.
- `SessionsModule` exports JWT/TypeORM modules although consumers primarily need the session service/guard. Narrow exports when confirming consumers, without introducing an auth-framework rewrite.
- API-wide `strictPropertyInitialization: false` accommodates ORM properties but weakens checks for every service. Consider local definite assignment for ORM-owned properties and restore the compiler check for ordinary classes.
- Room and broadcast API modules duplicate token-aware 401 handling; a small authenticated-request helper may help if it preserves the current token-match protection. The chunk path has a different streaming/ack contract and should not be forced through JSON parsing.
- `RouteErrorBoundary` has similar room/replay wrappers and labels any render exception as a download failure. A common route wrapper and accurate fallback copy are optional; a generic routing framework is unnecessary.
- Remove the misleading comment that `MediaRecorder` forbids `stop()` inside `dataavailable`; event handling should follow the actual API contract. Keep deferred overflow handling if it helps reentrancy, with an accurate explanation.

## 5. Build/check speed and dependency health

Keep the existing separation between no-emit checks, production builds, unit/service tests, and optional/full integration proof. The present 97-second release result is a single-machine baseline, not a CI SLA. API Vitest reported about **12.96 seconds**, with imports accounting for roughly **87%** of its reported work; web tests took about **3.41 seconds**. Worker time/import totals are parallel-run diagnostics and should not be summed as independent wall-clock durations.

The best next optimizations are R09–R11: correct shared-build serialization/readiness, reuse one successful compile, and scope lint invalidation. Only then overlap independent web/API work. Keep changed-package checks on pull requests and full checks for shared/config/dependency changes and release/main/scheduled runs. Do not remove runtime/Redis regressions to make the gate appear faster. Avoid raising test worker concurrency without measuring memory/import overhead on the actual CI runner.

Add small budgets for total check duration, unchanged check duration, shared compiler invocation count, and browser entry dependencies. Report cold and warm runs separately. Once checks pass after a change, broaden testing only when a new failure or risk justifies it; no repeated full gate is needed for each prose edit.

The audit run reported no production advisories. The committed development exceptions cover **minimatch `GHSA-g3hv-75wg-m249`**, **glob `GHSA-3g3m-2fjr-6pw4`**, and **deepmerge `GHSA-gcqx-w48m-w2h4`**. They have a maintainer owner and review date **2026-11-08**. The audit script checks expiry/policy; keep that requirement and re-evaluate upgrades by the date. A policy pass is not a claim of zero development advisories. There is no reason to perform a blanket dependency upgrade during this review.

`check:release` does not itself invoke the audit command; the CI selector runs audit separately when appropriate, and this review ran it separately. Either document that split consistently or expose a single explicit full release command covering both. Do not accidentally make network audit part of every tiny local check.

## 6. Scale boundaries and accepted V1 limits

Keep the four-person mesh and single-rendition broadcast constraints visible. The key foundations for a larger project are stable transport contracts, deterministic resource ownership, failure recovery, bounded hot paths, measured entry dependencies, and correct incremental tooling. Splitting every helper into `const`/`lib` folders does not provide those properties.

Incremental Lua writes do not make all live work constant time: snapshots still read/serialize the full roster and are emitted to room members. With a large audience, payload size and aggregate fan-out grow substantially even though only four people exchange stage media. The EVENT HLS playlist also accumulates segments for replay. Measure roster size, command latency, outbound snapshot bytes, playlist growth, database reads per viewer, and encoder CPU/memory before claiming a large-audience capacity. A later delta/paginated roster protocol or media-delivery tier should be an explicit evolution of shared contracts, not an incidental optimization that changes V1 semantics.

These existing decisions are intentional, not newly discovered correctness bugs:

- One API owns one Redis namespace; there is no distributed takeover or multi-instance Socket.IO synchronization. Failed partial startup, crash, and connection loss can retain its guard. Administrative recovery must first establish that the prior owner/supervisor is gone. Never delete a guard simply because a replacement wants to start.
- Startup fails in-flight catalog attempts and clears only the owning namespace's live keys. READY recordings persist. This is the chosen restart model, not seamless broadcast recovery.
- Redis room state uses mutation-refreshed TTLs. Socket authentication is checked at handshake; there is no refresh/reconnect session model. If sessions are to span the documented operating window, revisit idle-room lifetime and connected-session expiry together rather than adding a periodic global rewrite.
- Local HLS files and guest/catalog rows grow; README explicitly requires operational planning before public guest issuance. A retention worker and remote storage are excluded from V1.
- HLS has normal latency and Chrome/Edge-on-Windows support. Native Safari playback and low-latency HLS are not required here.

An environment detail merits attention separately from source fixes: the running compose containers still publish PostgreSQL/Redis on **all interfaces**, although the current compose file correctly binds loopback. README already explains that old containers need recreation. This review did not recreate containers or interrupt the database. Apply the documented recreation procedure when appropriate; do not call the committed compose configuration insecure because an older container retains its original bindings.

Documentation cleanup should accompany final verification: README's room-query description still says slug/token while the code uses user-partitioned private keys; its live-repository description says five keys although current `liveKeys()` returns six. Its release-gate naming should distinguish `check` from `check:release`. `plans/README.md` still describes the earlier remediation sequence as planned. Historical per-slice evidence should remain historical; update current status text without retroactively claiming checks were run.

## 7. File-by-file coverage

Each row identifies a reviewed tracked file or a specific group expanded in the tables below. “Coverage gap” means the existing tests are useful but do not cover the listed failure; it does not mean a test file itself fails. R references link a file to the findings above. The report itself is the new, additional file.

### Root configuration and tooling

| File                              | Review outcome                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.example`                    | Useful explicit deployment/admission defaults; add producer/media budget settings only with R06/R08. No live secrets copied into the report. |
| `.gitattributes`                  | LF normalization is appropriate for mixed Windows/CI use. No additional finding.                                                             |
| `.github/workflows/checks.yml`    | Affected/full checks, frozen install, restricted permissions and concurrency are useful; Redis-only integration coverage is R15.             |
| `.gitignore`                      | Ignores secrets, output, caches and local media. No additional finding.                                                                      |
| `.husky/pre-commit`               | Fast staged formatting hook; appropriate to keep the complete release gate outside every commit.                                             |
| `.nvmrc`                          | Pins Node major 22; package engine states the minimum patch. Record actual patch when comparing performance.                                 |
| `.prettierignore`                 | Excludes generated output/media, secrets and the generated lockfile. No additional finding.                                                  |
| `.prettierrc.json`                | Small consistent formatting policy. No additional finding.                                                                                   |
| `audit-exceptions.json`           | Explicit owned/time-limited development exceptions; review by 2026-11-08. See Section 5.                                                     |
| `docker-compose.yml`              | Current loopback binding and health checks are appropriate; existing older containers need separate recreation.                              |
| `eslint.config.js`                | Typed rules and hooks/promise checks are valuable. Cache strategy, rather than rule removal, needs R11.                                      |
| `package.json`                    | Clear package/full gates and tooling tests; repeated shared compilation is R10; audit is a separate command.                                 |
| `pnpm-lock.yaml`                  | Generated dependency graph assessed through current builds and audit; no manual source audit of transitive dependencies claimed.             |
| `pnpm-workspace.yaml`             | Scoped dependency override has context; historical C02 reference should be clarified during documentation cleanup.                           |
| `tsconfig.base.json`              | Strict/no-unchecked-index settings provide a useful common baseline. No additional finding.                                                  |
| `scripts/audit.mjs`               | Checks advisory policy and dated exceptions; retain explicit failure behavior and separate network cost.                                     |
| `scripts/audit.test.mjs`          | Meaningful policy/expiry regressions; passed in tooling suite. No additional finding.                                                        |
| `scripts/check-affected.mjs`      | Conservative full gate for shared/config changes; package selection is useful. Extend for R15 infrastructure checks.                         |
| `scripts/check-affected.test.mjs` | Useful selection regressions; passed. Extend when integration command selection changes.                                                     |
| `scripts/check-artifacts.mjs`     | Verifies emitted tests/Lua/browser graph and selected module loading; do not describe it as full Nest bootstrap. R14/R15.                    |
| `scripts/dev.mjs`                 | Windows force termination conflicts with graceful owner release, R05; shared restart readiness depends on R09.                               |
| `scripts/lint.mjs`                | Conservative typed-cache correctness, but workspace-wide invalidation/read amplification is R11.                                             |
| `scripts/shared-build.mjs`        | Shared watcher ownership is useful; one-shot concurrency/latest-readiness issues are R09; repeated compiles are R10.                         |
| `scripts/smoke-live.mjs`          | Useful real Redis/socket smoke with scoped cleanup; durable persistence and new feature routes are outside its proof. R15.                   |

### Backend

| File                                                           | Review outcome                                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/package.json`                                        | CommonJS output and explicit build/check commands are coherent. Shared prerequisites repeat, R10.                                             |
| `apps/api/nest-cli.json`                                       | Excludes tests through build config and copies Lua assets; current artifact check confirms all 11.                                            |
| `apps/api/tsconfig.json`                                       | Strict base preserved; API-wide property-initialization exception is a P3 tightening opportunity.                                             |
| `apps/api/tsconfig.check.json`                                 | Incremental no-emit check includes tests. Preserve separate check/build state.                                                                |
| `apps/api/tsconfig.build.json`                                 | Correctly excludes test/spec directories from output. No additional finding.                                                                  |
| `apps/api/vitest.config.ts`                                    | Explicit Node tests and bounded timeouts; expensive imports merit measurement, not fewer behavioral tests.                                    |
| `apps/api/src/main.ts`                                         | Admission before route parsers, constrained CORS, trusted-proxy configuration and shutdown hooks are sound. R05 needs a graceful dev channel. |
| `apps/api/src/app.module.ts`                                   | Explicit module graph and PostgreSQL timeouts; real bootstrap coverage is R15.                                                                |
| `apps/api/src/admission/http-admission.ts`                     | Health/preflight bypass and early admission are useful; shared media/control bucket is R08.                                                   |
| `apps/api/src/admission/http-admission.test.ts`                | Tests request rejection/boundaries; mixed HLS/read/upload workload coverage needs R08.                                                        |
| `apps/api/src/admission/network-identity.ts`                   | Explicit trusted-proxy identity policy; preserve spoofing defenses when separating media budgets.                                             |
| `apps/api/src/admission/network-identity.test.ts`              | Useful forwarding/normalization trust-boundary coverage. No additional finding.                                                               |
| `apps/api/src/admission/window-budget.ts`                      | Bounded identity/window state is appropriate. Per-route workload allocation is outside this class.                                            |
| `apps/api/src/admission/window-budget.test.ts`                 | Meaningful rate/window/capacity cases; passed. No additional finding.                                                                         |
| `apps/api/src/config/env.ts`                                   | One parsed runtime configuration boundary. No additional finding.                                                                             |
| `apps/api/src/config/parse-config.ts`                          | Strong URL/origin/secret/proxy/numeric validation; add new limits here rather than scattering env reads. R06/R08.                             |
| `apps/api/src/config/parse-config.test.ts`                     | Useful invalid/default/environment cases; extend for any new bounds.                                                                          |
| `apps/api/src/database/base.entity.ts`                         | Small shared ORM columns; local definite assignment could replace the global initialization exception.                                        |
| `apps/api/src/database/data-source.ts`                         | Explicit entities/migrations, synchronization disabled, no implicit extension install. Actual migration proof should become repeatable, R15.  |
| `apps/api/src/health/health.controller.ts`                     | PostgreSQL-only health matches contract; do not conflate with live readiness.                                                                 |
| `apps/api/src/http/api.exception.ts`                           | Typed application error envelope. No additional finding.                                                                                      |
| `apps/api/src/http/api-exception.filter.ts`                    | Narrow application exception mapping; no inappropriate blanket swallowing found.                                                              |
| `apps/api/src/users/user.entity.ts`                            | Minimal guest entity matches migration. Guest retention is an acknowledged operations concern.                                                |
| `apps/api/src/sessions/current-user.decorator.ts`              | Small request adapter behind the auth guard. No boilerplate unit test needed.                                                                 |
| `apps/api/src/sessions/jwt-auth.guard.ts`                      | Delegates bearer verification to the shared server auth service. No additional finding.                                                       |
| `apps/api/src/sessions/sessions.controller.ts`                 | Thin unknown-body boundary; display-name validation stays in service/shared.                                                                  |
| `apps/api/src/sessions/sessions.module.ts`                     | Explicit JWT setup is sound; narrowing exported infrastructure modules is P3.                                                                 |
| `apps/api/src/sessions/sessions.service.ts`                    | Shared validation, bounded pending creation, real-user verification and fixed JWT algorithm are good foundations.                             |
| `apps/api/src/sessions/sessions.service.test.ts`               | Auth/admission behavior regressions pass; a real repository/bootstrap path is R15.                                                            |
| `apps/api/src/rooms/room.entity.ts`                            | Constraints/columns agree with current migration; no V1 schema redesign required.                                                             |
| `apps/api/src/rooms/rooms.controller.ts`                       | Thin authenticated REST adapter. No additional finding.                                                                                       |
| `apps/api/src/rooms/rooms.module.ts`                           | Small feature ownership/export boundary. No additional finding.                                                                               |
| `apps/api/src/rooms/rooms.service.ts`                          | Shared validation and bounded slug retry are good; duplicate mapping, broad 23505 handling and host overfetch are P3.                         |
| `apps/api/src/migrations/1730332800000-CreateUsersAndRooms.ts` | Explicit tables/checks/references and reversible order. Add repeatable fresh-database verification, R15.                                      |
| `apps/api/src/migrations/1793577600000-CreateBroadcasts.ts`    | Broadcast status check and room/date index match entity; optional future pagination index should follow measured query shape.                 |
| `apps/api/src/live/live.keys.ts`                               | Central actual six-key list and namespace validation are useful; current docs still mention five.                                             |
| `apps/api/src/live/live.connection.ts`                         | Safe single-owner startup/reset and explicit failure policy. Guard retention after failed startup is intentional; forced dev restart is R05.  |
| `apps/api/src/live/live.connection.test.ts`                    | Startup/loss/ownership behavior covered; add supported Windows restart integration at the tooling boundary.                                   |
| `apps/api/src/live/live.module.ts`                             | Explicit factories avoid injecting constructor test seams as runtime dependencies. No additional finding.                                     |
| `apps/api/src/live/live.readiness.controller.ts`               | Separate live dependency readiness matches operating model. No additional finding.                                                            |
| `apps/api/src/live/live.repository.ts`                         | Incremental command-specific Lua/EVALSHA and namespaced keys improve prior design. Preserve Redis behavior when fixing publication, R03.      |
| `apps/api/src/live/live.repository.test.ts`                    | Useful real Redis script/namespace/mutation regressions. No replacement with fake-only coverage.                                              |
| `apps/api/src/live/live.integration.test.ts`                   | Real Redis validates stage/race behavior; does not establish PostgreSQL/Nest/FFmpeg integration.                                              |
| `apps/api/src/live/live.service.ts`                            | Queued room effects and host-leave retry improve correctness; committed-state publication gap is R03, broadcast cleanup integration R04.      |
| `apps/api/src/live/live.service.test.ts`                       | Substantial role/queue/lifecycle coverage; missing post-mutation catalog failure and retry cases, R03/R04.                                    |
| `apps/api/src/live/serialized-operations.ts`                   | Bounded normal/cleanup capacity and ordered execution are useful. Avoid unbounded recovery queues.                                            |
| `apps/api/src/live/serialized-operations.test.ts`              | Capacity/ordering/cleanup regressions passed. No additional finding.                                                                          |
| `apps/api/src/live/signaling.gateway.ts`                       | Parsing/auth/admission/transport delegation are appropriate. Do not move broadcast process ownership into handlers.                           |
| `apps/api/src/live/signaling.gateway.test.ts`                  | Handler/admission/transport coverage is useful; real deployed module wiring remains R15.                                                      |
| `apps/api/src/live/signaling.messages.ts`                      | Central typed domain messages; preserve actionable encoder/mesh failure distinction.                                                          |
| `apps/api/src/live/socket-options.ts`                          | Transport origin and payload-size controls exist in addition to application parsing. No additional finding.                                   |
| `apps/api/src/live/scripts/common.lua`                         | Shared snapshot/revision/TTL primitives avoid repeated full-state rewrites. Preserve all key positions.                                       |
| `apps/api/src/live/scripts/join.lua`                           | Atomic admission/stage/participant mutation and canonical off-stage flags. Covered by Redis suite.                                            |
| `apps/api/src/live/scripts/leave.lua`                          | Atomic member/hand/stage removal; host-end orchestration remains in service. No additional finding.                                           |
| `apps/api/src/live/scripts/patchMedia.lua`                     | Incremental safe-media policy and no-op behavior are useful; R03 must not break no-op revision semantics.                                     |
| `apps/api/src/live/scripts/setHand.lua`                        | Ordered bounded-by-membership hand changes; appropriate Redis ownership. No additional finding.                                               |
| `apps/api/src/live/scripts/promote.lua`                        | Host/stage checks and atomic slot allocation. No additional finding.                                                                          |
| `apps/api/src/live/scripts/demote.lua`                         | Resets off-stage flags and membership state atomically. No additional finding.                                                                |
| `apps/api/src/live/scripts/setHostLock.lua`                    | Host lock/media consistency enforced server-side. No additional finding.                                                                      |
| `apps/api/src/live/scripts/snapshot.lua`                       | Read/projection script; publication enrichment is a service concern, R03.                                                                     |
| `apps/api/src/live/scripts/tryBeginBroadcast.lua`              | Atomic one-attempt claim; producer absence needs lifecycle supervision, R06.                                                                  |
| `apps/api/src/live/scripts/clearBroadcast.lua`                 | Conditional attempt identity protects newer reservations; retain during R04 recovery.                                                         |
| `apps/api/src/broadcasts/broadcast.entity.ts`                  | Explicit status/check/reference/date index and nullable fields; keep entity out of public shared exports. R12.                                |
| `apps/api/src/broadcasts/broadcasts.controller.ts`             | Authenticated thin catalog/upload/file routes and strict chunk metadata; media budgets are R08, public DTO is R12.                            |
| `apps/api/src/broadcasts/broadcasts.module.ts`                 | Explicit factory correctly supplies runtime dependencies while retaining test seams. No DI-constructor defect found.                          |
| `apps/api/src/broadcasts/broadcasts.service.ts`                | Core new risk: cleanup side-effect ordering R04, snapshot enrichment R03, DTO duplication R12, unbounded catalog/process growth R17.          |
| `apps/api/src/broadcasts/broadcasts.service.test.ts`           | Useful authorization/catalog/restart tests; add failed side-effect recovery cases, R04.                                                       |
| `apps/api/src/broadcasts/broadcasts.runtime.test.ts`           | Useful controlled runtime/file cases; fixtures do not prove an actual FFmpeg encode. R04/R15.                                                 |
| `apps/api/src/broadcasts/chunk-parser.ts`                      | Route-local 2,000,000-byte raw parser with inflation disabled; do not raise global JSON size.                                                 |
| `apps/api/src/broadcasts/chunk-parser.test.ts`                 | Meaningful raw body/size/parser behavior. Keep route integration coverage in R15.                                                             |
| `apps/api/src/broadcasts/ffmpeg-supervisor.ts`                 | One child, argument array, bounded stderr/write/stop are good. Producer inactivity/ack deadline is R06; total process budget R17.             |
| `apps/api/src/broadcasts/ffmpeg-supervisor.test.ts`            | Controlled child failures/timeouts are useful; healthy binary/codec/output proof absent, R15.                                                 |
| `apps/api/src/broadcasts/hls-path.ts`                          | Filename allowlist, UUID validation, canonical path/symlink confinement and distinct playlist/segment headers are appropriate.                |
| `apps/api/src/broadcasts/hls-path.test.ts`                     | Traversal/symlink/header regressions are valuable. No extra speculative local-filesystem attacker finding.                                    |

### Frontend

| File                                                                | Review outcome                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/package.json`                                             | React/Query/Zustand/router/HLS are real dependencies; Tailwind is present. Shared prerequisites repeat, R10.                  |
| `apps/web/index.html`                                               | Minimal metadata/root/module entry; no external font dependency. No additional finding.                                       |
| `apps/web/tsconfig.json`                                            | Strict bundler/DOM/no-emit settings fit Vite. No additional finding.                                                          |
| `apps/web/tsconfig.check.json`                                      | Incremental checks include source/config. No additional finding.                                                              |
| `apps/web/vite.config.ts`                                           | Tailwind plugin installed; shared source is consistently compiled for web, avoiding CommonJS browser output. Preserve parity. |
| `apps/web/src/vite-env.d.ts`                                        | Typed optional env declarations paired with runtime validation. No additional finding.                                        |
| `apps/web/src/main.tsx`                                             | One QueryClient/provider graph and session-cache binding; StrictMode cleanup remains a required lifecycle behavior.           |
| `apps/web/src/App.tsx`                                              | Route shells and lazy room/replay boundaries are appropriate. No additional finding.                                          |
| `apps/web/src/app/route-error-boundary.tsx`                         | Retry recreates lazy route; duplicated wrappers and download-only error copy are P3.                                          |
| `apps/web/src/app/entry-graph.test.ts`                              | Existing home boundary protection is useful; extend to conditional HLS download, R14.                                         |
| `apps/web/src/config/env.ts`                                        | Absolute service URL validation rejects credentials/query/hash; no additional finding.                                        |
| `apps/web/src/index.css`                                            | Tailwind import and explicit source discovery are active. Old Tailwind finding is resolved.                                   |
| `apps/web/src/styles/theme.css`                                     | Semantic tokens centralized in Tailwind theme. Appropriate CSS use.                                                           |
| `apps/web/src/styles/base.css`                                      | Legitimate base styles; input/disabled-button overlap is small P3 consistency debt.                                           |
| `apps/web/src/components/ui/button.tsx`                             | Small semantic variants and explicit button type; no need for a large component library.                                      |
| `apps/web/src/components/ui/form-field.tsx`                         | Label/hint associations are useful; input styling overlaps base CSS slightly.                                                 |
| `apps/web/src/components/ui/page-state.tsx`                         | Small shared page-state shell with clear semantics. No boilerplate test needed.                                               |
| `apps/web/src/lib/http/api-error.ts`                                | Focused cross-feature error type. Good use of lib.                                                                            |
| `apps/web/src/lib/http/client.ts`                                   | Shared JSON transport/cancellation/error validation; keep binary upload semantics separate.                                   |
| `apps/web/src/lib/http/client.test.ts`                              | Useful invalid/network/abort/error boundary tests. No additional finding.                                                     |
| `apps/web/src/features/session/api.ts`                              | Guest response validation and abort propagation; reuse for R16 guest-only entry.                                              |
| `apps/web/src/features/session/session-store.ts`                    | Expiry/session replacement/token-match cleanup is useful. No new account/refresh requirement.                                 |
| `apps/web/src/features/session/session-store.test.ts`               | Persistence/expiry/session replacement regressions passed. No additional finding.                                             |
| `apps/web/src/features/rooms/api.ts`                                | Typed room response parsing and token-aware 401 handling; small cross-feature duplication is P3.                              |
| `apps/web/src/features/rooms/query-options.ts`                      | User-partitioned keys, skipToken, cancellation and private cache clearing are appropriate. Docs need alignment.               |
| `apps/web/src/pages/HomePage.tsx`                                   | Shared form validation and request cancellation are useful; session creation exists only through room actions, R16.           |
| `apps/web/src/pages/RoomPage.tsx`                                   | Thin query/routing view with keyed room ownership; direct guest entry can reuse R16 approach if requested.                    |
| `apps/web/src/pages/ReplayPage.tsx`                                 | READY-only playback and invalid/error states are appropriate; fresh visitor cannot complete name-only flow, R16.              |
| `apps/web/src/features/live/stores/room-store.ts`                   | Transient state and revision guard are appropriate. Server must actually publish committed revisions, R03.                    |
| `apps/web/src/features/live/hooks/use-live-room.ts`                 | Stable service instance and effect lifecycle; multiple whole-session notifications may grow costly, R13.                      |
| `apps/web/src/features/live/hooks/use-screen-share.ts`              | Small service adapter; avoid adding ownership here. Shared subscription approach is a measured future cleanup.                |
| `apps/web/src/features/live/hooks/use-demo-peers.ts`                | Small demo adapter; preserve explicit media cleanup owners. No additional finding.                                            |
| `apps/web/src/features/live/components/live-room.tsx`               | Mostly orchestration/rendering; static attendee-player import causes R14 even for hosts/meetings.                             |
| `apps/web/src/features/live/components/green-room.tsx`              | Device selection/preview/control UI delegates to services; physical behavior remains open acceptance.                         |
| `apps/web/src/features/live/components/green-room.css`              | Native meter pseudo-elements and reduced-motion styling justify the small CSS file.                                           |
| `apps/web/src/features/live/components/room-controls.tsx`           | Explicit role/media controls; preserve disabled/pending states when normal stop becomes asynchronous.                         |
| `apps/web/src/features/live/components/participant-list.tsx`        | Roles, hand queue and host controls reflect server authority. No additional finding.                                          |
| `apps/web/src/features/live/components/stage-grid.tsx`              | Stage-limited media rendering/video refs feed compositor; borrow elements/tracks without owning source capture.               |
| `apps/web/src/features/live/components/demo-controls.tsx`           | Small bounded demo UI. No additional finding.                                                                                 |
| `apps/web/src/features/live/components/stats-drawer.tsx`            | Stats UI remains separate from peer ownership. No additional finding.                                                         |
| `apps/web/src/features/live/services/room-session.ts`               | Main maintainability/lifecycle hotspot, R02/R06/R07/R13; do not expand with more capture owners.                              |
| `apps/web/src/features/live/services/room-session.test.ts`          | Substantial role/leave/recorder coverage; current pagehide expectation preserves camera, R07; final flush absent, R02.        |
| `apps/web/src/features/live/services/local-media.ts`                | Explicit capture owner, operation replacement and cleanup improve prior implementation. Physical observations still required. |
| `apps/web/src/features/live/services/local-media.test.ts`           | Useful async capture/cleanup races; substitutes cannot verify physical microphone/camera indicators.                          |
| `apps/web/src/features/live/services/output-route.ts`               | Focused output-device capability/application boundary. No additional finding.                                                 |
| `apps/web/src/features/live/services/output-route.test.ts`          | Output routing failures/capabilities tested; audible physical output remains acceptance.                                      |
| `apps/web/src/features/live/services/peer-manager.ts`               | Peer/negotiation state owner and ordered operations remain appropriate; keep attendees outside mesh.                          |
| `apps/web/src/features/live/services/peer-manager.test.ts`          | Meaningful collision/candidate/track/cleanup cases. Preserve during broadcast refactor.                                       |
| `apps/web/src/features/live/services/signaling.ts`                  | Typed parsed transport and acknowledgements; broadcast stop deadline mismatch is R06.                                         |
| `apps/web/src/features/live/services/signaling.test.ts`             | Useful transport/parsing/ack tests; add operation-specific slow-stop reconciliation.                                          |
| `apps/web/src/features/live/services/screen-share.ts`               | Dedicated replace/restore ownership is appropriate; native picker/stop observation still open.                                |
| `apps/web/src/features/live/services/active-speaker.ts`             | Audio-analysis resource owner separated from UI. No additional finding.                                                       |
| `apps/web/src/features/live/services/active-speaker.test.ts`        | Focused analysis/cleanup behavior tested. No additional finding.                                                              |
| `apps/web/src/features/live/services/role-transition.ts`            | Pure consent/stage transition decisions are a useful extracted boundary.                                                      |
| `apps/web/src/features/live/services/role-transition.test.ts`       | Stage gain/loss/consent regressions pass. Preserve while changing recorder lifecycle.                                         |
| `apps/web/src/features/live/services/demo-peer.ts`                  | Explicit synthetic media/peer lifetime; keep independent of real input capture ownership.                                     |
| `apps/web/src/features/live/services/demo-peer.test.ts`             | Useful synthetic lifecycle coverage; does not replace physical-device observations.                                           |
| `apps/web/src/features/live/services/demo-registry.ts`              | Focused demo identity/lifetime registry. No additional finding.                                                               |
| `apps/web/src/features/live/services/stats-collector.ts`            | Polling and delta parsing separated from render; retain stop/dispose behavior.                                                |
| `apps/web/src/features/live/services/stats-collector.test.ts`       | Useful polling/delta/reset regressions. No additional finding.                                                                |
| `apps/web/src/features/live/services/boundaries.test.ts`            | Source-boundary guard is useful; architecture checks supplement behavior, not replace it.                                     |
| `apps/web/src/features/broadcast/api.ts`                            | Runtime validation exists, but public DTO/status/date/URL contract is duplicated, R12.                                        |
| `apps/web/src/features/broadcast/api.test.ts`                       | Response/auth/abort cases useful; use shared contract fixtures after RC12.                                                    |
| `apps/web/src/features/broadcast/query-options.ts`                  | User-scoped key, invalid-ID skip and abort propagation are appropriate. No additional finding.                                |
| `apps/web/src/features/broadcast/components/attendee-broadcast.tsx` | Explicit waiting/live/failed/replay states; static player import is R14.                                                      |
| `apps/web/src/features/broadcast/components/broadcast-player.tsx`   | Effect destroys HLS and attaches auth/fatal errors; deferred loading R14, real playback proof R15.                            |
| `apps/web/src/features/broadcast/services/playback.ts`              | Useful pure view decisions and authenticated HLS config; future external-origin credential policy R12.                        |
| `apps/web/src/features/broadcast/services/playback.test.ts`         | Covers state/config/auth decisions, not actual media playback. Keep that distinction.                                         |
| `apps/web/src/features/broadcast/services/chunk-upload.ts`          | Ordered 204 sequencing and blob-count bound exist; normal-stop data loss R02, rate interaction R08, bytes/deadlines R17.      |
| `apps/web/src/features/broadcast/services/chunk-upload.test.ts`     | Sequencing/refusal/cap tests useful; add graceful drain, final blob, byte/deadline cases.                                     |
| `apps/web/src/features/broadcast/services/stage-recorder.ts`        | Layout/mix/compositor separated from UI; output ownership R01, final data R02, async error R06.                               |
| `apps/web/src/features/broadcast/services/stage-recorder.test.ts`   | Useful layout/mix cleanup checks but owned tracks/final event ordering missing, R01/R02.                                      |
| `apps/web/src/features/broadcast/services/boundaries.test.ts`       | Preserves no broadcast-to-live dependency; pass capabilities during R13 extraction.                                           |

### Shared package

| File                                            | Review outcome                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/package.json`                  | One CommonJS server package boundary, source used consistently by Vite; unnecessary dual-output complexity avoided.  |
| `packages/shared/tsconfig.json`                 | Pure strict source/check baseline. No additional finding.                                                            |
| `packages/shared/tsconfig.check.json`           | Incremental no-emit cache separated from emitted build. No additional finding.                                       |
| `packages/shared/tsconfig.build.json`           | Emits declarations/runtime, excludes tests; build reuse/readiness is tooling R09/R10.                                |
| `packages/shared/vitest.config.ts`              | Small pure-logic test configuration. No additional finding.                                                          |
| `packages/shared/src/index.ts`                  | Central exports; keep browser-safe when adding public broadcast DTO.                                                 |
| `packages/shared/src/contracts.ts`              | Shared transport/domain types improve FE/BE synchronization; broadcast REST gap R12.                                 |
| `packages/shared/src/contracts.test.ts`         | Contract/pure validation coverage passes. Extend only for meaningful new boundaries.                                 |
| `packages/shared/src/limits.ts`                 | Shared protocol/display/stage limits are appropriately central. Avoid duplicate chunk byte limits when refining R17. |
| `packages/shared/src/identifiers.ts`            | Shared identifier validation and cryptographic slug generation support both boundaries.                              |
| `packages/shared/src/identifiers.test.ts`       | Identifier/slug validation regressions pass. No additional finding.                                                  |
| `packages/shared/src/signaling.ts`              | Typed events/snapshots/errors keep transport synchronized. Preserve revision/authority semantics.                    |
| `packages/shared/src/signaling.parsers.ts`      | Explicit bounded unknown-input parsing is valuable; keep parser and DTO aligned.                                     |
| `packages/shared/src/signaling.parsers.test.ts` | Useful malformed/oversize/identity/ack parsing coverage. No additional finding.                                      |
| `packages/shared/src/stage.ts`                  | Pure authoritative reducer/canRelay and canonical off-stage rules are useful. No new permission bug found.           |
| `packages/shared/src/stage.test.ts`             | Extensive stage/lock/hand/media rules; keep in sync with Lua integration.                                            |
| `packages/shared/src/negotiation.ts`            | Pure Perfect Negotiation decisions remain separate from RTC ownership.                                               |
| `packages/shared/src/negotiation.test.ts`       | Collision/role decision regressions pass. No additional finding.                                                     |
| `packages/shared/src/stats.ts`                  | Pure delta calculations/reset behavior separate from collection/UI.                                                  |
| `packages/shared/src/stats.test.ts`             | Meaningful rate/loss/stale sample cases pass. No additional finding.                                                 |
| `packages/shared/src/demo-peers.ts`             | Pure synthetic peer limit/identity decisions remain small.                                                           |
| `packages/shared/src/demo-peers.test.ts`        | Bounded demo allocation decisions tested. No additional finding.                                                     |
| `packages/shared/src/broadcast.ts`              | Pure ordering and argument construction useful; ledger copy growth R17, shared REST contract missing R12.            |
| `packages/shared/src/broadcast.test.ts`         | Ordering/hash/oversize/argument tests pass; generated argument assertions cannot prove real encoder output, R15.     |

### Product and execution documents

| File                    | Review outcome                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idea.md`               | Original future-facing sketch, explicitly superseded. Do not use excluded R2/BullMQ/ladder/account features as V1 defects.                                       |
| `MASTER_PLAN.md`        | 1.0.8 is authority; accurately retains open physical/Phase 6 gates and single-owner limitations. Preserve historical C references.                               |
| `README.md`             | Useful runnable setup/demo/limits; current query-key/key-count/gate wording needs cleanup, Section 6. Playback narrative still needs actual acceptance evidence. |
| `plans/README.md`       | Phase status table retains open gates; old remediation-planned sentence should be brought current.                                                               |
| `plans/phase1.md`       | Historical scope and evidence; no reason to rewrite completed phase behavior.                                                                                    |
| `plans/phase1/guide.md` | Historical atomic implementation sequence; preserve recorded evidence/hashes.                                                                                    |
| `plans/phase2.md`       | Historical live-state contract; current six-key/Phase 6 changes are later evolution, not a reason to falsify old snapshots.                                      |
| `plans/phase2/guide.md` | Historical Redis/socket evidence; current recovery defects are described in R03/R04/R05.                                                                         |
| `plans/phase3.md`       | Automated media results do not close physical observations. Current acceptance gap remains explicit.                                                             |
| `plans/phase3/guide.md` | Preserve outstanding physical mic/output/picker/camera checks until observed.                                                                                    |
| `plans/phase4.md`       | Demo/stats acceptance uses synthetic media; no independent new defect found in scope.                                                                            |
| `plans/phase4/guide.md` | Completed slices/evidence retained; do not reuse as real hardware proof.                                                                                         |
| `plans/phase5.md`       | Moderation/stage consent behavior implemented; no missing broadcast-unavailable feature should be re-reported after Phase 6.                                     |
| `plans/phase5/guide.md` | Recorded two-window/synthetic acceptance is useful historical evidence, not a new run in this review.                                                            |
| `plans/phase6.md`       | Feature scope is implemented; graceful-stop semantics need R02 refinement; A05/A06/browser A08 remain open.                                                      |
| `plans/phase6/guide.md` | Six commits and bounded verification are honestly recorded; includes prior shared-build overlap failure, R09. Final feature commits do not close acceptance.     |

## 8. Commit-by-commit implementation guide for agents

This is a proposed maintenance sequence, **not a record of implemented fixes**. At the original review all RC slices below were **planned**; Section 9 records their later requested implementation and evidence. It supersedes the old remediation task list for current work, while old C01–C20 references in historical records retain their historical meaning. Reading this review does not instruct an agent to implement every slice automatically; follow the user's actual implementation request.

For a requested slice, inspect the current diff first, preserve user changes, change only the named responsibility, run the focused checks, update its evidence, and commit it before the next slice. Do not reuse this review's successful baseline as proof that a later patch passed. Never claim a real FFmpeg/browser/physical observation from a substitute. Maintenance does not waive acceptance gates or change explicit V1 exclusions. If a slice changes a protocol/lifecycle contract, update the relevant contract and callers in the same commit.

Use the current package commands as safe standalone entry points. Until RC08/RC09, run commands that build shared **sequentially**. A focused test example is `pnpm --filter @stageflow/web test -- src/features/broadcast/services/stage-recorder.test.ts`; substitute the relevant test paths. Run package typecheck/lint for changed code, select affected verification at a slice boundary, and run the complete release/audit gate once after the integrated sequence. Do not add boilerplate component, controller, or ORM entity unit tests.

| Slice | Proposed commit                                                       | Findings                | Dependencies                                 |
| ----- | --------------------------------------------------------------------- | ----------------------- | -------------------------------------------- |
| RC01  | `fix(web-broadcast): release recorder-owned media resources`          | R01                     | None                                         |
| RC02  | `fix(web-broadcast): drain final media before normal stop`            | R02                     | RC01                                         |
| RC03  | `fix(live): reconcile committed snapshots after enrichment failure`   | R03                     | None                                         |
| RC04  | `fix(api-broadcast): complete cleanup after lifecycle failures`       | R04                     | RC03 interface decisions                     |
| RC05  | `fix(dev): gracefully restart the Windows API owner`                  | R05                     | None                                         |
| RC06  | `fix(broadcast): fail abandoned producers and reconcile stop results` | R06                     | RC02, RC04                                   |
| RC07  | `fix(web-live): reconcile page exit and return cleanup`               | R07                     | RC01, RC06                                   |
| RC08  | `fix(tooling): serialize shared builds and track compile readiness`   | R09                     | None                                         |
| RC09  | `perf(checks): reuse one shared build per dependency graph`           | R10                     | RC08                                         |
| RC10  | `perf(lint): scope type-aware cache inputs to dependencies`           | R11                     | None                                         |
| RC11  | `fix(admission): isolate HLS reads from producer traffic`             | R08                     | RC06 error semantics                         |
| RC12  | `refactor(shared): define the public broadcast response contract`     | R12                     | RC03, RC04                                   |
| RC13  | `refactor(web-live): isolate broadcast session ownership`             | R13                     | RC02, RC06, RC07, RC12                       |
| RC14  | `perf(web): load HLS only when playback is requested`                 | R14                     | None; coordinate RC13 imports                |
| RC15  | `fix(web-replay): preserve playback through guest entry`              | R16                     | RC12                                         |
| RC16  | `perf(broadcast): bound upload work and avoid history copying`        | R17 immediate code work | RC02, RC04                                   |
| RC17  | `test(release): verify real API and FFmpeg integration`               | R15                     | RC03, RC04, RC06, RC08                       |
| RC18  | `docs(v1): record verified acceptance and maintenance outcomes`       | Acceptance/docs         | After relevant fixes and actual observations |

### RC01 — Resource ownership

**Files:** `apps/web/src/features/broadcast/services/stage-recorder.ts`, `stage-recorder.test.ts` in that directory; `room-session.test.ts` only if its recorder fixture needs the refined interface.

Retain every acquired owned track immediately, release it through one idempotent cleanup path, and keep source tracks borrowed. Cover partial canvas/audio/recorder setup failures and repeated stop. **Verify:** recorder-focused web tests, web typecheck and lint. Done when all owned tracks are ended after each terminal path and source tracks remain live when the room continues.

### RC02 — Graceful finish versus cancellation

**Files:** broadcast `services/stage-recorder.ts`, `chunk-upload.ts`, their tests; live `services/room-session.ts`, `room-session.test.ts`; `plans/phase6.md`, `plans/phase6/guide.md` for the changed stop semantics.

Expose bounded finish/drain separately from abort. Maintain native final event ordering, flush accepted sequential chunks before backend EOF, prevent new non-final input after finishing begins, and make stop UI state reflect pending/failure. Leave must still release local media promptly. **Verify:** final-blob/queued-upload/short-recording/timeout regressions, web typecheck/lint; real stop-to-replay observation later in RC18. Do not mark complete based only on a fake whose stop emits no data.

### RC03 — Publication recovery

**Files:** `apps/api/src/live/live.service.ts`, `live.service.test.ts`; `apps/api/src/broadcasts/broadcasts.service.ts` and tests if changing the snapshot projection; `live.repository.ts`/tests only if the recovery protocol requires them.

Remove fallible repeated catalog enrichment from the normal live hot path, define last-known broadcast state and pending publication behavior, and reconcile retries without fabricating no-op revisions. Verify membership/ack semantics after a failed join publication. **Verify:** focused live service and Redis tests, API typecheck/lint, socket smoke. The key assertion is eventual delivery of an already committed revision after a one-off dependency failure.

### RC04 — Idempotent attempt cleanup

**Files:** `apps/api/src/broadcasts/broadcasts.service.ts`, `broadcasts.service.test.ts`, `broadcasts.runtime.test.ts`, `ffmpeg-supervisor.ts`/tests if process completion ownership changes; live service tests for host leave and exit callbacks.

Keep one attempt outcome and explicit pending cleanup; make child stop independent of persistence/notification success; compensate partial create/reserve/start failures; retry finalization safely. Do not implement encode retries or BullMQ. **Verify:** injected failure at each side-effect boundary, simultaneous stop/child-exit, host leave, and reservation token safety; API typecheck/lint and Redis integration. Done when no tested failure can leave an unobserved child or permanently block the next attempt.

### RC05 — Windows graceful owner shutdown

**Files:** `scripts/dev.mjs`, `apps/api/src/main.ts`, `apps/api/src/live/live.connection.ts` only for the shutdown interface if needed; new focused `scripts/dev.test.mjs` or a lifecycle integration fixture; README shutdown/recovery notes.

Create a local, non-public shutdown channel, await Nest close/owner release, and supervise descendants. Cover Nest watch and shared rebuild restarts. Keep the force-kill fallback bounded and visible. **Verify:** Windows helper lifecycle and isolated real owner tests, two successive restarts, forced-fallback recovery, foreign-owner preservation, tooling tests. Linux-only signal tests cannot close this Windows-specific finding.

### RC06 — Producer health and deadline reconciliation

**Files:** web broadcast recorder/uploader and tests; `room-session.ts`/tests; `signaling.ts`/tests; API broadcast service/supervisor and tests; `config/parse-config.ts`/tests and `.env.example` if adding configurable bounds; Phase 6 contract/README for changed failure/deadline behavior.

Route native errors/unexpected stops through one terminal path. Bound first input/producer inactivity, define outcomes, and reconcile slow stop acknowledgements against server state. **Verify:** controlled-clock failure cases, no-blob start, upload failure, and 8–10 second stop boundary without wall-clock sleeps. Preserve the mesh when a broadcast fails.

### RC07 — Page lifecycle

**Files:** `apps/web/src/features/live/services/room-session.ts`, `room-session.test.ts`; existing media/signaling owners only for required cleanup APIs; Phase 6/README verification records.

Use one idempotent teardown for page exit and define return/rejoin behavior. Avoid awaited unload work and use server producer-loss protection. **Verify:** service lifecycle tests plus actual navigation, back/forward, camera indicator, and broadcast status observation on supported Chrome/Edge. Record a browser half as open if it cannot be observed.

### RC08 — Build concurrency correctness

**Files:** `scripts/shared-build.mjs`, new `scripts/shared-build.test.mjs`, `scripts/dev.mjs` only where its ready/rebuild protocol changes.

Use exclusive writer ownership, current-generation readiness, failure invalidation, and safe stale-owner handling. **Verify:** disposable concurrent app-build consumers, failed watcher rebuild followed by a consumer, successful recovery, missing output, writer exit, and cold first build. The fixture must not touch a running workspace's output/lock files. Keep standalone commands working.

### RC09 — Shared build reuse

**Files:** root/API/web/shared `package.json`; `scripts/shared-build.mjs`; shared build/check tsconfigs if justified; `scripts/check-affected.mjs`/tests if the task graph changes; README check instructions.

Prepare shared once in the root graph, preserve standalone prerequisites and source/config/dependency invalidation, and only parallelize independent tasks after RC08. **Verify:** one shared emit per unchanged release invocation, cold deleted-output recovery, source/config edits, standalone app tasks, and cold/warm timing comparison. Keep test sources typechecked and absent from artifacts.

### RC10 — Lint cache scope

**Files:** `scripts/lint.mjs`, a focused `scripts/lint.test.mjs` for fingerprint dependency behavior if extracting that logic, package scripts only if needed.

Scope fingerprints to actual package/transitive/config inputs. **Verify:** shared type changes invalidate API/web; a web-only edit does not invalidate API/shared; root ESLint/TS/lock changes invalidate the relevant caches. Run a cold and warm lint comparison. Do not replace type-aware checks with syntax-only lint.

### RC11 — Media admission

**Files:** API `admission/http-admission.ts`/tests, `config/parse-config.ts`/tests, broadcast controller/upload boundary as needed, `.env.example`, README; upload client only if explicitly adding bounded retries.

Separate traffic classes without removing network protection. Keep early byte parsing limits, authenticated host ownership, pending work limits, and accurate Retry-After. **Verify:** mixed localhost/NAT workload with several viewers, host upload continuity, exhausted media reads, abusive uploads, and ordinary control requests. Use a deterministic request simulation; do not claim a viewer capacity from arithmetic alone.

### RC12 — Shared broadcast contract

**Files:** `packages/shared/src/broadcast.ts`, its test and `index.ts`; API `broadcasts.service.ts`/tests; web broadcast `api.ts`/tests, `query-options.ts`, playback tests if shapes change.

Define one public DTO/parser, remove unnecessary raw paths from transport, and document same-origin credential policy. Maintain any intended API compatibility explicitly. **Verify:** round-trip API projection through the shared parser, malformed/null/status/date cases, URL policy, API/web typechecks and builds. Keep TypeORM and Node imports out of shared browser exports.

### RC13 — Broadcast controller extraction

**Files:** `apps/web/src/features/live/services/room-session.ts`, its tests; new `apps/web/src/features/broadcast/services/broadcast-session.ts` and focused tests; recorder interface and existing boundary tests where needed.

Transfer broadcast lifecycle ownership behind stage-source and signaling adapters. Keep the broadcast service independent of live-feature imports; pass capabilities in. **Verify:** existing leave/promotion/demotion/media tests plus recorder-source synchronization, normal finish, abort, and error propagation. Do not rewrite peer negotiation or change unrelated visual behavior.

### RC14 — Player loading boundary

**Files:** web broadcast `components/attendee-broadcast.tsx`, `components/broadcast-player.tsx`, `pages/ReplayPage.tsx` as needed; `app/entry-graph.test.ts`; artifact graph checker only for the new budget/assertion.

Load HLS only for actual playback, retain meaningful loading/error states, and keep auth cleanup. **Verify:** build manifest/static dependency graph for home, meeting/host room, attendee playback, and replay; player behavior tests; actual playback later. Report raw/gzip estimates separately from observed transfer. Do not merely hide Vite's warning.

### RC15 — Guest entry for replay

**Files:** `apps/web/src/pages/ReplayPage.tsx`, session feature UI/controller files only as needed, `pages/HomePage.tsx` if reusing its guest step, existing route/session boundaries, targeted behavior tests.

Use guest creation without an unrelated room operation; preserve a safe local replay destination. **Verify:** no-session replay entry through session creation to the same replay, expired token, request cancellation, invalid replay ID, and disallowed external return URLs. No account feature or new authentication backend is needed.

### RC16 — Duration/byte work bounds

**Files:** `packages/shared/src/broadcast.ts`/tests; API broadcast service/supervisor and tests; web `chunk-upload.ts`/tests; contract/config docs for any new explicit limit.

Separate pure order/hash decisions from ownership of the append-only hash ledger so each accepted chunk does not copy its history. Bound browser queued bytes and request duration. **Verify:** old duplicate/conflict/future behavior, committed history only after a successful write, overflow/abort/drain behavior, and a long deterministic chunk sequence with near-linear work. Encoder concurrency, retention, and pagination can be separate explicitly requested deployment slices; do not silently add a product cap in this optimization commit.

### RC17 — Repeatable service integration

**Files:** `.github/workflows/checks.yml`, root/API scripts, `scripts/check-affected.mjs`/tests, new `scripts/smoke-broadcast.mjs` and/or a narrowly scoped API service-integration fixture; existing artifact/smoke scripts for accurate descriptions; README.

Use isolated disposable database/namespace/media directory, run both migrations, boot the real compiled Nest modules, issue a real guest token, exercise one broadcast, send valid WebM bytes, stop, and inspect actual HLS/segments. Verify missing binary and restart failure isolation separately. Pin/log the FFmpeg version used. Always clean up owned child processes and fixture files. **Verify:** the new command locally/CI with real infrastructure, affected selection for shared/API/media changes, and no execution on prose-only changes. Keep secrets and generated media out of git.

### RC18 — Acceptance and current documentation

**Files:** `README.md`, `MASTER_PLAN.md` current delivery state, `plans/README.md`, `plans/phase3.md`/guide and `plans/phase6.md`/guide only for newly obtained evidence, this report's slice status. Update `pnpm-workspace.yaml`'s historical `review.md C02` comment reference if making it a current maintenance reference.

Run P6-A05/A06/A08 in an actual supported browser with real FFmpeg and complete P3-A03/A05/A06 physical observations. Exercise the short-stop/final-tail case, host leave during live output, native encoder failure where reproducible, and replay guest entry. Record exact command/browser/binary versions, outcomes, and commit hashes. Update current key/cache/check descriptions, preserve earlier historical evidence, and leave any unavailable observation explicitly unverified. **Final gate:** `pnpm check:release`, `pnpm audit:check`, new relevant integration command, and the actual demo observations. Only then assess whether V1 is verified complete.

## 9. Maintenance outcomes and acceptance handoff (2026-11-03)

This updates slice status without rewriting the historical review or treating substitutes as physical observations. MASTER_PLAN.md 1.0.9 and the current Phase 6 guide govern the handoff.

| Slice | State                                                      | Commit                                                           | Outcome                                                                                                                                  |
| ----- | ---------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| RC01  | Committed                                                  | `b98adb2`                                                        | Recorder resource ownership                                                                                                              |
| RC02  | Committed                                                  | `458e9d3`                                                        | Final recorder data and ordered drain                                                                                                    |
| RC03  | Committed                                                  | `7e71ac0`                                                        | Committed publication recovery                                                                                                           |
| RC04  | Committed                                                  | `8f24799`                                                        | Idempotent attempt cleanup                                                                                                               |
| RC05  | Committed                                                  | `1bd04c3`                                                        | Windows graceful owner shutdown                                                                                                          |
| RC06  | Committed                                                  | `8e2bcb1`                                                        | Producer health and stop reconciliation                                                                                                  |
| RC07  | Committed                                                  | `a1f4b2d`                                                        | Page exit and return cleanup                                                                                                             |
| RC08  | Committed                                                  | `4914eb1`                                                        | Shared writer/readiness correctness                                                                                                      |
| RC09  | Committed                                                  | `e7387e1`                                                        | Shared build reuse                                                                                                                       |
| RC10  | Committed                                                  | `206fe7d`                                                        | Lint cache dependency scope                                                                                                              |
| RC11  | Committed                                                  | `54b6f8f`                                                        | Media admission classes                                                                                                                  |
| RC12  | Committed                                                  | `e64fd33`                                                        | Shared public broadcast DTO/parser                                                                                                       |
| RC13  | Committed                                                  | `e116dbe`                                                        | Broadcast ownership extraction                                                                                                           |
| RC14  | Committed                                                  | `2198f5e`                                                        | Deferred HLS player                                                                                                                      |
| RC15  | Committed                                                  | `f2e8a1e`                                                        | Replay guest entry                                                                                                                       |
| RC16  | Committed                                                  | `c39a22d`                                                        | Append-only ledger and upload byte/deadline budgets                                                                                      |
| RC17  | Committed                                                  | `1879ad0`                                                        | Real API/PostgreSQL/FFmpeg integration                                                                                                   |
| RC18  | Acceptance/documentation recorded; physical follow-up open | Focused acceptance fixes: `326dea3`; current documentation slice | P6-A05/A06/A08 now verified with native Chrome, synthetic devices and real FFmpeg. Physical P3-A03/A05/A06 remain explicitly unverified. |

The RC18 browser run found and fixed two additional startup defects in `326dea3`: native frame functions lost their Window receiver, and the first live-playlist 404 exhausted playback immediately despite configured retries. Focused regressions and real browser recording/playback passed after those fixes. The final headless Chrome 156.0.8078.74 run observed live HLS, replay, final-chunk-before-server-stop ordering, a short recording, guest replay entry, actual encoder termination with the mesh preserved, unexpected native recorder stop, leave cleanup and navigation/history return. Its method, versions, metrics and artifact checksum are in plans/phase6/guide.md. No permanent browser suite was added.

The user explicitly asked to leave physical observations unverified. Human audible output/physical microphone input, native screen picker/browser stop UI and the camera indicator therefore remain open. Native browser evidence uses synthetic media and muted output; it does not close those physical gaps. The full V1 definition of done is not satisfied. Real encoding is now verified through RC17/RC18; the original absent-FFmpeg limitation is historical. Encoder concurrency measurement, catalog pagination, disk alerts and retention remain separate deployment decisions.

Final RC18 release/audit/integration command results are recorded in the Phase 6 guide. The final release command stopped only at formatting in the pre-existing untracked briefing.html, preserved unchanged. All tests, typechecks, lint and builds passed; formatting with only that file excluded, production artifact checks, both smokes and audit passed separately. No claim of a green combined release command or a remote CI run is made without corresponding evidence.
