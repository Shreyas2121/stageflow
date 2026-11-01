# StageFlow code review and agent implementation plan

Review date: 2026-11-01. Baseline: `b132cc3` (`docs(phase4): record the final slice hash`).

Report revised on 2026-11-01 after checking the independent review in Section 9. Corrections are incorporated into the findings and commit plan; Section 9 records their disposition. Application code is unchanged.

Remediation update (2026-11-01): C01 reconciles the planning documents and records the current rules in master version `1.0.3`. Section 8 records its verification and commit status. The findings and application verification below describe the original `b132cc3` review baseline unless explicitly updated; no application remediation or new physical acceptance is claimed by C01.

C02 update (2026-11-01): The scoped Multer resolution is now `2.5.0`; the production audit reports no advisories. The full audit retains two moderate and one low development-tooling advisory, with temporary exceptions and verification recorded under C02. Application source is unchanged.

## 1. Verdict and scope

The project has a credible V1 foundation, but it needs a reliability and structure pass before adding moderation and broadcasting. Keep the current stack and modular monolith. The highest priorities are recoverable room shutdown, ICE candidate ownership, predictable media lifecycles, and bounded server work. Extracting constants and adopting a consistent Tailwind convention will help maintainability, but those changes should not displace correctness fixes.

I inspected all 103 tracked files: frontend, backend, shared code, tests, Lua, configuration, and planning documents. Generated lockfile review covered workspace resolutions, dependency relationships, tool versions, and the dependency audit; it is not a manual audit of third-party source code. `node_modules`, generated `dist`, local secrets, and media data are outside the source-file inventory. Build artifacts were inspected where relevant.

At the original review, only this report was requested. No application fixes, dependency upgrades, migrations, commits, or pushes were performed during that review. `plans/README.md` was already modified when the review began. The subsequent C01 request authorizes the documentation commit described in Section 8; its index reconciliation retains the user's existing phase links and pending physical checks.

### Product context

`idea.md` is the original broader vision. `MASTER_PLAN.md` v1.0.2 was the V1 authority at review; C01 revises it to v1.0.3 for status, ownership, and verification policy. Its deliberate limits remain:

- Four stage participants, including the host; raw WebRTC mesh between stage members only.
- Webinar attendees have no peer connection; HLS will supply their media in Phase 6.
- Guest identity, one API process, disposable live presence, no automatic socket resume.
- Local disk broadcast output, one rendition, no BullMQ, object storage, or SFU in V1.

The absence of Phase 5 moderation handlers/UI, broadcast processing, and replay playback is planned work, not a regression. Future product growth warrants stable boundaries now, not implementation of the discarded architecture from `idea.md`.

### Existing strengths worth preserving

- Strict TypeScript, `noUncheckedIndexedAccess`, shared wire contracts, and no explicit application `any` found.
- Shared text parsers reject invalid input before database writes; names render as text.
- JWT verification is reused for HTTP and sockets, restricts HS256, validates the subject, and checks the user exists.
- Migrations are explicit; schema synchronization and automatic startup migrations are disabled.
- Stage limits and role transitions are atomic Lua operations. Concurrent last-slot joins/promotions have real Redis tests.
- TypeScript/Lua parity tests are valuable intentional duplication across runtimes.
- WebRTC connections and media sources are service classes, with cancellation generations and mostly idempotent cleanup.
- Synthetic peers have independent sockets and identities; they reuse the human peer manager without replacing the human store.
- Telemetry avoids double-counting candidate-pair and RTP byte counters, handles first samples, and prevents overlapping polls.
- Good foundations for labels, focus visibility, text errors, native disclosure controls, and reduced-motion support.

## 2. Verification performed

Node `v22.23.2`, pnpm `12.9.1`, Windows PowerShell. Existing PostgreSQL 16 and Redis 7 containers were healthy. I did not restart the API: startup deliberately deletes live presence, which would interfere with existing sessions.

| Command/check                          | Observed result                                   | Elapsed wall time |
| -------------------------------------- | ------------------------------------------------- | ----------------- |
| `pnpm typecheck`                       | Pass; builds shared and checks all three packages | 9.22 s            |
| `pnpm lint`                            | Pass                                              | 16.54 s           |
| `pnpm --filter @stageflow/shared test` | 95 tests, 5 files pass                            | 3.33 s            |
| `pnpm --filter @stageflow/web test`    | 23 tests, 6 files pass                            | 4.94 s            |
| `pnpm --filter @stageflow/api test`    | 19 Redis tests, 1 file pass                       | 6.87 s            |
| `pnpm --filter @stageflow/web build`   | Pass with large-chunk warning                     | 4.66 s            |
| `pnpm --filter @stageflow/api build`   | Pass; eight Lua assets copied                     | 18.46 s           |
| `pnpm format:check`                    | Pass before creating this report                  | 9.25 s            |
| `pnpm audit --json`                    | Exit 1: one high, two moderate, one low advisory  | Approximately 1 s |
| Isolated host-leave failure injection  | Reproduced incomplete shutdown after retry        | See F01           |
| Isolated peer-manager event sequence   | Reproduced stale ICE candidate application        | See F02           |

Except typecheck, the timed checks above ran concurrently. These are a local baseline with installed dependencies and existing artifacts, not isolated benchmarks, clean-checkout proof, or an end-to-end latency measurement. Do not add the durations to estimate pipeline time.

Web output reported by Vite: **615.65 kB JavaScript / 186.55 kB estimated gzip**, one entry chunk; **15.93 kB CSS / 4.47 kB estimated gzip**. Vite itself reported 1.28 s build time in the original run. A fresh cross-check build reproduced the same filenames, sizes, and warning. Separately, Node's default `zlib.gzipSync` compressed the same 615,650-byte JavaScript file to **184,990 bytes (184.99 kB)** and the 15,933-byte CSS file to **4,468 bytes**. These are different compression measurements, not evidence of a changed bundle; neither establishes the eventual hosting server's transfer size. The JavaScript warning is real; CSS is currently small in transfer terms despite being difficult to maintain.

During report revision I reran only the web production build and bounded, in-memory probes for slug generation and attendee media transitions. The `NaN` probe returned `AAAAAAAAAAAA`; a negative-byte probe hit a 100 ms VM execution timeout; the stage oracle accepted an attendee advertising microphone/video/screen-share flags while leaving its stage membership empty. This revision did not rerun the full suites, dependency audit, original timings, failure-injection harnesses, or browser acceptance. The table above remains the original verification record.

No browser/media acceptance was rerun in this review. Phase documents record earlier Chromium checks with synthetic media. Physical microphone input, audible output, camera indicator, native screen picker, and browser stop controls remain unverified in the Phase 3 record. A passing unit suite cannot close those gaps. No fresh dependency installation, migration execution, load test, or vulnerability exploit was performed.

## 3. Findings and priorities

Priority meanings: **P1** = important reliability/exposure fix; **P2** = material maintainability, performance, or bounded edge-case issue; **P3** = cleanup/future constraint. These are engineering priorities, not CVSS scores. Reproduction and static analysis are identified separately. Finding IDs remain stable across revisions; the newly integrated F23 retains its P2 priority despite appearing after the original list.

### F01 — P1: host shutdown loses its intent after a partial failure

**Evidence:** `apps/api/src/live/signaling.gateway.ts:315`, especially lines 323–337; `scripts/leave.lua:3`; `rooms/rooms.service.ts:19`.

Host leave first empties Redis participants/stage/hands. It then awaits PostgreSQL ending, Redis deletion, notification, and socket disassociation. If PostgreSQL fails, the host participant has already disappeared. A retry reaches the Lua unknown-participant no-op, returns `roomEnded: false`, and skips the remaining host shutdown. A failure deleting keys after the database update has a similar recovery problem. Disconnect has no durable retry path.

**Reproduced:** instantiated the compiled gateway with an in-memory repository using the real `applyStageCommand`, two associated sockets, and `rooms.end` throwing once. First leave returned `server_error`; retry returned `{ ok: true }`. Database end was called only once, room-key deletion and `room:ended` were never called, the guest remained associated, and live participants were empty. This is an orchestration reproduction with fakes, not a real database outage.

**Impact:** remaining clients can retain media and stale room UI; the catalog can stay LIVE; a retry falsely reports completion. Webinar joins can subsequently use the still-LIVE catalog row.

**Fix:** put room shutdown in a domain service. Preserve an explicit ending intent/tombstone until all effects finish. Make each step idempotent and retryable, keep joins blocked while ending, notify/disassociate all affected sockets, and log incomplete transitions. Merely swapping PostgreSQL and Redis calls changes the failure window; it does not solve it. No distributed transaction is needed for V1, but its failure policy must be explicit.

### F02 — P1: early ICE candidates survive an ignored offer

**Evidence:** `apps/web/src/live/peer-manager.ts:188` and `:212`; `packages/shared/src/negotiation.ts:67`; `peer-manager.test.ts`.

When an impolite peer ignores a colliding offer, the manager returns without invalidating candidates already buffered before that offer. A later accepted answer flushes the entire buffer into the new description. Meanwhile, candidates arriving while `ignoreOffer` remains true are dropped, without checking their provenance. The candidate wire shape also omits `usernameFragment`, which could help identify its ICE generation. Queue draining uses `splice(0)` before applying candidates: one rejection discards the remaining batch and can prevent an accepted offer from being answered. These are confirmed queue behaviors; whether a particular candidate is stale, valid, or shared by both descriptions requires actual ICE credentials and event ordering.

**Reproduced:** transpiled the actual manager in memory and used a minimal peer-connection fake. Sequence: local offer → candidate before remote description → ignored colliding offer → accepted answer. `addIceCandidate` received the earlier candidate, labeled as belonging to the ignored offer by the fixture. That label does not prove the candidate has incompatible ICE credentials in a real browser. The probe proves queue retention/application; it does not prove an ordinary Chromium call fails. The current first-offer scheduling also reduces initial glare.

**Fix:** first add manager-level regressions for retained buffers, candidates received during ignore, and a candidate rejection during draining. Use real SDP/ICE credentials in a browser fixture before claiming stale-generation failure or mandating extra protocol metadata. Where distinguishable, associate candidates with accepted ICE credentials, discard genuinely stale candidates, bound buffers, and preserve valid candidates in order. `usernameFragment` identifies an ICE generation, not a unique offer/answer; descriptions may share credentials. Do not blindly clear a valid answer's early candidates or suppress every candidate error. Include null and empty-string end-of-candidates indications. Keep the existing first-offer scheduling and no-ICE-restart V1 scope.

The gateway also accepts a **non-empty** candidate string with both `sdpMid` and `sdpMLineIndex` null, which `addIceCandidate` rejects with `TypeError`. Reject that invalid combination before relay, while preserving an **empty-string** end-of-candidates object with both fields null and the existing null marker. [WebRTC addIceCandidate algorithm](https://www.w3.org/TR/webrtc/#dom-rtcpeerconnection-addicecandidate)

### F03 — P1 before exposure: guest creation and signaling work are unbounded

**Evidence:** `sessions/sessions.controller.ts:9`, `sessions.service.ts:44`, `signaling.gateway.ts:74`, `:102`, `:219`; Lua `common.lua:10`.

There are no application rate limits, pending-command limits, room attendee limits, or SDP/candidate length limits. Anonymous callers can create persistent user rows. Authenticated clients can queue work faster than the per-socket/per-room promise chains drain. Webinar attendees have no roster ceiling, and expensive snapshots magnify each accepted update. Existing Socket.IO message-size defaults are not a substitute for per-event and queue limits; the documented default is 1 MB per message. [Socket.IO server options](https://socket.io/docs/v4/server-options)

The browser also has two uncapped buffers: per-peer candidates in `peer-manager.ts` and pre-join signaling callbacks in `signaling.ts:62`, `:108`–`:116`. The latter drains after successful join and clears on close. Existing connect/join timeouts and caller cleanup limit normal retention time, but do not impose a message-count or byte budget within that interval. This is not evidence that normal calls retain messages indefinitely.

**Fix:** define configurable admission and event-rate budgets, validate before enqueuing, cap server pending work and browser buffers, reject excess work explicitly, and make leave/disconnect cleanup able to proceed under load. Use stricter limits for SDP/ICE than a future chunk-upload endpoint. Throttle guest creation by an appropriate network identity; only trust forwarded addresses behind a configured proxy. A future public deployment also needs guest-data retention and abuse monitoring. Do not silently add a new product attendee cap without recording it in the contract.

### F04 — P1 operational gap: Redis loss leaves an apparently healthy but unusable live server

**Evidence:** `apps/api/src/live/live.module.ts:11` sets `retryStrategy: () => null`; `health/health.controller.ts:9` checks PostgreSQL only; disconnect failures are only converted to acknowledgements in the gateway.

Static analysis: after a runtime Redis connection failure, there is no reconnect policy or process-failure policy. Existing sockets remain connected even though commands fail. If the host disconnects while Redis is unavailable, live shutdown cannot complete. Database health can still report `{ ok: true }`.

**Fix:** retain the V1 reset behavior: define a dependency-loss policy that marks live readiness unhealthy and drops affected sockets or exits under supervision. Keep liveness separate from readiness so a database hiccup does not cause uncontrolled restart loops. If reconnecting is chosen instead, define how lost presence and revisions are reset; never resume stale media sessions by accident. Reproduce with an isolated Redis instance, not by stopping a shared developer container.

### F05 — P2: the green-room meter continues driving the live room

**Evidence:** `apps/web/src/live/local-media.ts:51`–`:68`; `pages/RoomPage.tsx:147`, `:302`, `:539`.

The microphone meter starts a requestAnimationFrame loop with `setLevel`. Joining hides/unmounts the green-room preview, but the meter/context and retained preview reference remain until full media stop. With changing microphone levels, this can update the large `LiveRoom` tree at display refresh rate while it is rendering stage tiles and a roster. Active-speaker analysis separately samples the microphone.

**Fix:** separate capture ownership from lobby preview/meter ownership. On successful join, detach/pause the old preview and stop its meter/context while keeping camera/microphone tracks live. Isolate meter updates to a small lobby component and publish at a sensible UI frequency. Do not call the current all-purpose `media.stop()` on join, because that stops the call tracks. Profile before adding memoization everywhere.

### F06 — P2: output-device errors are treated as capture/playback failures

**Evidence:** `pages/RoomPage.tsx:306`, `:308`–`:311`, `:626`; `local-media.ts:146`; `stage-grid.tsx:89`–`:94` and `:121`.

A rejected `setSinkId` during prepare reaches the catch that stops otherwise valid camera/microphone capture and keeps join unready. This call routes the **muted green-room preview**, which is unmounted on join; actual remote audio is routed separately by non-local stage tiles. Failure to route that preview should not disable capture or joining. This conflicts with master Section 9.5: output selection must not block joining. In a tile, output routing rejection sets the autoplay-blocked state, but the displayed retry button only calls `play()` and never retries or resets the sink. The selection also updates before routing succeeds.

**Fix:** make output routing a separate recoverable operation, revert or fall back to the default device, and report the actual cause. Distinguish autoplay denial from output-routing denial. Keep successful capture ready. Test unsupported sinks and rejected sink promises as service behavior, plus verify physical routing manually.

### F07 — P2: `RoomPage.tsx` owns too many lifecycles and state machines

**Evidence:** `apps/web/src/pages/RoomPage.tsx` is 765 physical lines. `LiveRoom` owns sockets, media, peer manager, speaker analysis, device setup, demo registry, screen-share rollback, transport commands, errors, and most room markup.

There are paired ref/state handles (`peers` and `peerManager`), several independent operation counters, one `busy` flag for unrelated operations, and duplicated cleanup in `stopMedia` and the effect destructor. Role handling is split: the catalog-derived `attendee` flag gates device preparation, join media flags, lobby content, and mute/camera controls; roster labels, hand/demo/stats controls use `self.role`, and sharing uses stage membership. After promotion, the hand button could disappear and sharing become eligible while capture and mute/camera controls still follow the initial attendee classification. Phase 5 therefore cannot simply add a promote button. Demotion currently closes peers through the store subscription but does not itself stop captured local media/screen tracks. The latter is a Phase 5 readiness issue, not a claim that an exposed demote path exists today.

**Fix:** separate the route/query, room controller, lobby, stage controls, roster, demo controls, and media hooks. Keep imperative media handles in service ownership; keep rendering state in narrowly subscribed stores/hooks. Establish one cleanup operation and explicit joining/joined/leaving phases. Promotion must prepare devices after consent; demotion must deterministically release them. Do not move 600 lines unchanged into one giant hook and call that modularization.

### F08 — P2: gateway is a room orchestration service in disguise

**Evidence:** `apps/api/src/live/signaling.gateway.ts`, 350 physical lines, owns promise queues, database lookup, lifecycle transitions, persistence ordering, snapshot mapping, transport membership, and error messages.

Atomic role decisions correctly stay in Lua; they are not all duplicated in the gateway. The architectural problem is lifecycle/persistence orchestration in the transport adapter, contrary to master Section 12.2. Adding moderation and a child-process supervisor here will make failure reasoning harder.

**Fix:** introduce a `LiveService` and a focused serialized-operation helper. Gateway handlers should parse unknown input, supply trusted socket identity, call the service, and emit/ack transport results. Keep Socket.IO objects out of the domain service by returning explicit effects/results. Do not add a generic repository abstraction over every TypeORM operation; the current small CRUD services are reasonable.

### F09 — P2: every Lua mutation reconstructs and rewrites the whole room

**Evidence:** `apps/api/src/live/scripts/common.lua:10`–`:16`, `:43`–`:64`; `live.repository.ts:36`.

All commands read all participants/hands; every changed command deletes and recreates the hash, set, and sorted set, then sorts/serializes a full snapshot. Even a single mute or hand change is proportional to the roster. Full Lua runs block Redis while executing. The complete script source is sent through `EVAL` every time. Broadcasting an O(N) snapshot to N members incurs O(N²) aggregate payload bytes per update.

**Fix now:** retain the required full-snapshot protocol but change only the affected hash fields/set/zset members inside Lua, refresh TTLs, and use cached scripts through `defineCommand`/EVALSHA with reload behavior. Measure representative rosters. Avoid optimizing away atomicity or parity tests.

**Future constraint:** snapshots/deltas and roster pagination need a product/protocol decision when attendee counts grow. A fourth stage slot is bounded; webinar roster growth is not.

### F10 — P2 before multi-instance use: state is globally destructive and process-local

**Evidence:** `live.module.ts:29` clears all `sf:room:*`; `signaling.gateway.ts:74` queues in process and `:210` resolves sockets in a local map; `live.repository.ts:37` declares only a synthetic prefix as a Redis script key.

A second API instance sharing Redis will delete the first one's presence on startup. Redis does not make the rest of the application multi-instance safe: queues, Socket.IO target resolution, and future FFmpeg handles remain local. Scripts derive real keys instead of declaring them; that should not be carried into Redis Cluster. Redis requires accessed keys to be explicit inputs. [Redis scripting requirements](https://redis.io/docs/latest/commands/eval/)

**V1 action:** document/enforce one API instance per isolated environment, use a configurable environment namespace, and avoid shared Redis between unrelated development/preview instances. Pass real keys explicitly when revising repository scripts. A namespace alone does not make replicas safe.

**Later:** room ownership, a compatible Socket.IO adapter, coordinated startup, distributed serialization, and broadcast worker ownership need a separate design. Adding just the Redis adapter or increasing replicas is insufficient. A larger stage would require revisiting mesh topology, outside this review's implementation plan.

### F11 — P2: shared output can be missing or stale when app scripts run

**Evidence:** `packages/shared/package.json` exports only `dist`; root typecheck builds shared; app build/dev/test scripts do not. `vite.config.ts:9` prebundles shared. README explicitly requires manual rebuild and Vite `--force` after export changes.

Today commands work because shared output exists. An isolated app build/dev command after a clean install has no declared prerequisite to build shared. Shared tests import source, while application tests import the built workspace package, allowing stale output to hide a change. This also costs agents time debugging old exports.

**Fix:** define a dependency-aware build/dev/check path. Build shared before consumers from a clean checkout, watch its source during development, and ensure consumer tests use current shared code. Initially retain CJS compatibility; add a deliberate ESM/source development entry or subpath exports only with tests in both consumers. Do not introduce a dual-package hazard to chase tree shaking. No generic package-wide barrel imports inside feature internals.

### F12 — P2: production builds include tests or skip the typecheck gate

**Evidence:** `apps/api/tsconfig.json` includes all `src`; actual output includes `dist/live/live.integration.test.js`. `apps/web/package.json` build runs only `vite build`.

API production compilation emits the Redis test, including its Vitest imports. It is not imported by the API entry today, so this is artifact leakage/build overhead rather than an observed startup crash. Vite transpiles TypeScript without checking types, so a web build alone is not a verification gate. [Vite TypeScript behavior](https://vite.dev/guide/features.html#typescript)

**Fix:** add a separate API build config excluding tests while keeping tests in the check config. Keep Lua copying intact. Add a root release/check pipeline with explicit typecheck prerequisites. Do not typecheck twice inside every app build when the task graph already guarantees it. Include a production startup/migration entry that does not require ts-node/devDependencies when deployment becomes part of scope.

### F13 — P2: home route eagerly loads the complete room/media stack

**Evidence:** `apps/web/src/App.tsx:3` statically imports `RoomPage`, whose imports include signaling, WebRTC, demo engine, and stats. Measured entry chunk: 615.65 kB, with Vite's warning.

**Fix:** lazy-load the room route with an accessible Suspense fallback and an error boundary for chunk-load failures. Consider deferring host-only diagnostics/demo modules after measuring. Keep future hls.js confined to the playback feature. Do not simply raise `chunkSizeWarningLimit`, manually split every library, or assume every byte is caused by React. `React.lazy` defers component loading until first rendering. [React lazy](https://react.dev/reference/react/lazy)

### F14 — P2: lint/check policy misses the most relevant React and async errors

**Evidence:** `eslint.config.js` enables basic JS/TS recommended rules and `no-explicit-any`, but has no React Hooks rules, promise-safety rules, or import-boundary checks. Package lint scripts omit some root/test configs. There is no ESLint cache or incremental TypeScript setup.

**Fix:** enable compatible React Hooks rules in the web package; introduce type-aware promise checks for selected source files with `projectService` where useful. Add simple boundary restrictions: no web→API imports, no API→web imports, shared stays runtime-independent. Check the configuration files too. Do not globally suppress useful rules or immediately apply every expensive rule to every file. React's dependency rule specifically catches missing effect dependencies and stale closures. [React exhaustive-deps](https://react.dev/reference/eslint-plugin-react-hooks/lints/exhaustive-deps)

### F15 — P2: no reproducible CI/release gate, and redundant whole-repo work will grow

**Evidence:** no `.github/workflows` or equivalent pipeline is tracked; root has typecheck/lint/format scripts but no build, test, verify, or development orchestration. Existing phase guides run workspace-wide checks repeatedly; shared production sources compile before shared checks them again.

**Fix:** add a clear task graph, targeted local commands, package-specific incremental/cache files, and a full merge/release gate. CI must run Redis tests against an ephemeral Redis service and fail if unavailable. Use frozen installs and correct cache invalidation. Formatting can remain staged and fast. Avoid placing Docker, all builds, and every test on each pre-commit hook. See Section 6 for the check policy.

### F16 — P2: HTTP/session errors lose information and cancellation

**Evidence:** `apps/web/src/api.ts:5`, `:23`, `:25`; `session.ts:44`; `RoomPage.tsx:20`.

HTTP errors become plain `Error`, losing status/code needed for 401 recovery. Success JSON is asserted to `T` without boundary parsing. Queries ignore TanStack Query's AbortSignal; there is no explicit request timeout. Reading storage catches denial, but `setSession` does not: valid guest creation can fail UI progress when storage is blocked. There is no session-clear action, and expired sessions stay in the room error state. Raw tokens appear in query keys; this isolates caches today but unnecessarily exposes credentials to query inspection/logging and churns keys on token replacement.

**Fix:** create a typed `ApiError`, propagate abort signals, add bounded timeout behavior and minimal response parsers, and support clear/expired-session recovery. If storage writes fail, keep an in-memory session and explain persistence limitations only when needed. Replace token-bearing query keys with stable user/session identity and clear private cache on identity change. This is a hygiene improvement; I found no current token logging. TanStack Query supplies a signal that fetch must consume to cancel network work. [Query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation)

### F17 — P2: runtime validation and repeated policy values need explicit owners

**Evidence:** duplicate UUID regex in `sessions.service.ts:35` and `rooms.service.ts:15`; duplicate slug regex in `HomePage.tsx:21` and `rooms.service.ts:74`; scattered stage cap 4, demo cap 3, timeouts 8000, TTL 86400, pulse settings, colors, text limits. `env.ts:11` merely applies `Number()` to PORT. `vite-env.d.ts` declares only the API URL.

**Fix:** shared parsers/constants for actual cross-boundary policy (slug, UUID, limits, wire validation), feature-local constants for browser tuning, API-local constants for infrastructure policy, CSS theme tokens for visuals. Validate integer port/range, URL schemes, origin shape, and complete optional TURN credentials at startup. Separate database CLI config from web/signaling config so migrations do not require unrelated JWT/Redis/CORS values. Keep environment parsing testable rather than throwing during unrelated module imports.

Do not put every literal into a root `constants.ts`, or move every local type into a giant `types.ts`. PostgreSQL/Lua constraints still need equivalent values in their own runtimes and parity coverage. Type aliases alone do not validate external JSON; avoid unsafe assertions after partially validating an object.

### F18 — P2 before wider use: local services are exposed on every interface

**Evidence:** Compose publishes `5432:5432` and `6379:6379`; `docker compose ps` confirms `0.0.0.0` and IPv6 publication. Redis has no password; PostgreSQL uses documented development credentials. API listens without an explicit host. `.gitignore` excludes `.env`, but not `.env.local`/`.env.production`.

**Fix:** bind local database ports to `127.0.0.1`, make API host binding explicit for local/public use, and ignore environment variants while allowing `.env.example`. Whether other machines can currently connect depends on host networking/firewall; no remote exposure test was performed. CORS does not authenticate requests, and Socket.IO documents that CORS restrictions do not apply to WebSocket transport. If origin restrictions are part of deployment policy, enforce them for that transport too. [Socket.IO CORS limits](https://socket.io/docs/v4/handling-cors)

### F19 — P2: installed dependencies have current security advisories

**Evidence:** `pnpm audit --json` against the present lockfile reported the following on the review date. These are dependency findings, not demonstrated StageFlow exploits.

| Package/version                                          | Classification                                                                    | Reachability and response                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `multer@2.4.0` through `@nestjs/platform-express`        | High, pending asynchronous fileFilter teardown DoS; audit reports patch `>=2.5.0` | No multipart upload handler/fileFilter exists in current code, so the trigger is not currently exposed. Update the compatible parent/transitive resolution before adding upload features. [Multer advisory](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) |
| `minimatch@10.2.6` and `3.1.5` through lint/Nest tooling | Moderate, glob-parts resource amplification; audit reports patch `>=11.0.1`       | Development/tooling paths; do not blindly force a new major under every parent. Prefer supported parent updates and check compatibility. [Minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)                                               |
| `glob@13.0.6` through Nest CLI                           | Moderate, cancellation bypass; audit reports patch `>=14.0.2`                     | Development build tooling. Upgrade through a compatible toolchain path. [Glob advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)                                                                                                                     |
| `deepmerge@4.3.1` through Nest CLI checker               | Low, prototype poisoning; audit reports no published patched version              | Record temporary exception with owner/review date if no compatible fix is available. Avoid untrusted configuration input. [Deepmerge advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)                                                              |

Keep upgrades separate from behavior refactors, rerun both builds and relevant tests, and recheck advisories at implementation time. Do not use blanket `audit fix --force`, remove the lockfile, or treat differing Nest integration package majors as proof of incompatibility; inspect peer ranges. Existing checks pass with the installed versions. This audit is not a full supply-chain or application security audit.

**C02 disposition (2026-11-01):** Rechecked all four advisories against the registry and publisher/advisory records. A parent-scoped override upgrades only `@nestjs/platform-express@11.2.8>multer` from `2.4.0` to `2.5.0`. The fresh production audit is clear; the full audit still exits 1 for `minimatch`, `glob`, and `deepmerge` in development tooling. These findings remain visible, with owner, review date, reachability, and removal criteria under C02. F19 is partially remediated, not closed.

### F20 — P2: documentation and displayed build identity contradict the code

**Evidence:** the uncommitted `plans/README.md` says Phase 4 is planned/unimplemented while its contract/guide and Git history show it committed; the committed index is older still and says Phase 4 is not written. The master status stops at Phase 3. Phase 3's final handoff says no Phase 4 plan exists. `App.tsx:16` displays Presence build 02, `App.tsx:38`–`:39` retains the presence-only footer, and `HomePage.tsx:152`–`:153` says video arrives later despite working mesh code. Line 150 is the obsolete roster heading, not the video sentence.

The master requires a prior phase exit before the next phase, but Phase 4 proceeded with documented Phase 3 physical acceptance gaps. The Phase 4 document acknowledges those gaps; the master does not record a gate exception. Also, master Section 12.2 requires media services under `src/services`, whereas the code/phase guides use `src/live`. This path mismatch is less important than lifecycle ownership, but agents need one rule.

**Fix:** reconcile the current handoff/status with actual commits, distinguish historical records from current instructions, and explicitly preserve the outstanding hardware checks. Decide whether the phase-gate exception was accepted and record that; do not manufacture an acceptance result. Record the new feature-folder convention before moving files. Stop presenting old development milestones as product functionality.

**C01 disposition:** Planning status, historical handoffs, feature-local service ownership, affected-check policy, and service-test scope are reconciled in master v1.0.3 and the phase records. Phase 4's own acceptance is recorded as verified with synthetic host devices; Phase 3 physical observations remain open. No explicit product decision accepting the Phase 3→4 prerequisite exception was found, so master Section 16 records it as pending before the next product phase. Obsolete application copy remains for C11; C01 does not fully close F20.

### F21 — P3: telemetry can waste hidden work and mislead in edge cases

**Evidence:** `stats-drawer.tsx:21` starts the collector even when its `<details>` is closed; `stats-collector.ts:86` waits for all peer reports; `stats.ts:45` computes loss without a positive time interval.

Closed details hide DOM but do not stop polling or React updates. One unresolved `getStats` promise prevents subsequent polls for all rows because `polling` stays true. Loss can be numeric with identical/backward timestamps even though rate fields are null; the current phase contract does not explicitly forbid that loss behavior. Aggregate counters can also hide stream membership/counter resets if another stream grows simultaneously.

**Fix:** choose and document polling while closed (for immediate history) versus polling on open (less work); do not call either choice a correctness defect without that decision. Bound stalled reads and isolate peer failures. Define stale timestamp behavior; later preserve per-report baselines if stream churn proves significant. Show unknown/missing values honestly. Resolution from the sketch is not a missing Phase 4 requirement: the master narrowed the metric list.

### F22 — P3: smaller library/data hygiene issues

- `RoomsService.create` retries every `23505`, rather than specifically the slug unique constraint. This can hide future unrelated unique violations. Name the constraint and inspect it. Its repeated response mapping and `getBySlug` mapping can share a feature-local mapper.
- `getBySlug` loads the full host entity to return one display name. Small today; use an explicit select/projection as user profiles grow. Add query-driven indexes (for example host/date catalog lookup) with the feature and query plan that needs them, not speculative indexes now.
- `SessionsModule` exports `JwtModule` and `TypeOrmModule` even though consumers currently need its service/guard. Minimize public exports. `ConfigModule` is registered globally while most code directly imports `env`; choose one configuration ownership pattern.
- API `strictPropertyInitialization: false` applies to every class to accommodate entities. Prefer entity-local definite assignment and stricter service initialization if compatible with Nest decorators.
- `createRoomSlug(nextByte)` assumes its callback returns a byte. The production crypto source does. With `NaN`, however, `charAt(NaN)` selects the first character and the helper returns `AAAAAAAAAAAA`; it does **not** loop indefinitely. A callback repeatedly returning `-1` produces an empty character, never grows the slug or rejection count, and loops indefinitely. Validate integer/range `0..255` or narrow/document the helper's internal API; retain the separate 248–255 rejection-sampling rule. Bounded in-memory probes confirmed both behaviors; no production exploit was demonstrated.
- A quiet room can outlive the mutation-refreshed 24-hour Redis TTL while its sockets stay open. After expiry, `client.data.room` remains set: join returns `already_joined`, while media/hand commands find no participant. Other clients retain stale presence, and a new low revision can be ignored by `room-store.ts`. Explicit leave clears the caller's association but does not recover the whole room or complete missing host shutdown. Before supporting long sessions, impose a documented lifetime or reset/close all affected sockets on presence expiry. Do not silently change the existing no-op TTL rule. This is static analysis of a long-duration edge case, not a 24-hour test result.
- Frontend form inputs can add `maxLength` aligned with shared limits; this is usability, not a server validation substitute. Add a skip link and review roster live-region verbosity as attendance grows. Keep native labels and focus styles.

### F23 — P2: off-stage attendees can advertise active media in the current API

**Evidence:** `signaling.gateway.ts:279`, `scripts/patchMedia.lua:1`–`:13`, and `packages/shared/src/stage.ts:146`–`:159`. Join also copies the initial audio/video flags without normalizing them for attendees (`scripts/join.lua:18`).

Any joined webinar attendee can send `{ isAudioMuted: false, isVideoOff: false, isScreenSharing: true }`. The current mutation path accepts the booleans and the roster reports microphone/video/screen-sharing state even though the attendee remains off stage. A direct probe of the real TypeScript oracle confirmed the accepted transition; the equivalent Lua branch was checked in source. Existing parity tests already exercise media patches on attendee fixtures, so this permissiveness is partly encoded in today's tests rather than introduced by Phase 5.

This is a **live roster/state-policy gap**, not a stage-access escalation: `stageSocketIds`, `meshPeers`, and relay checks still exclude the attendee. Boolean media flags also cannot prove whether an untrusted stage browser actually sends media. Define which off-stage states are legal, normalize join flags, and reject or normalize contradictory patches in the authoritative Lua/oracle pair. Record that behavior change in the current contract and update tests; defer exposed promotion/demotion workflows to Phase 5.

`isSyntheticBot` is also client-supplied, but that is explicitly contracted as display-only. A guest can choose a Demo badge; this is not an authorization defect and does not bypass the stage cap. Do not build privileged bot verification unless the product later changes the meaning of the badge.

## 4. Tailwind assessment and recommendation

**Tailwind is already configured correctly.** `apps/web/package.json` includes `tailwindcss` and `@tailwindcss/vite`; `vite.config.ts:7` registers the plugin; `index.css:1` imports Tailwind. This matches the current Vite integration. A Tailwind v3 config file is not required just because it is absent. [Tailwind Vite installation](https://tailwindcss.com/docs/installation/using-vite)

The observation is nevertheless fair: almost all UI styling is implemented with custom semantic classes in an **847-line global `index.css`**, not utility composition. Tailwind currently contributes its base/generated styles and utilities such as `sr-only`, while custom selectors own most layout and appearance. The guides require Tailwind setup but also ask for custom dark styling; I found no recorded decision requiring utility-first usage or explaining the choice of predominantly plain CSS. The repository shows the implementation choice, not its author's rationale.

**Flag: P2 consistency/maintainability debt, not “Tailwind missing.”** Plain CSS is valid and is not inherently slower or less scalable. In this project, the concrete problems are repeated colors/spacing, global element selectors, repeated mobile media-query blocks, broad stylesheet ownership, and repeated button/field class composition. The emitted CSS is small, so a rewrite cannot honestly be sold as a proven page-speed win.

Recommended convention for the growing project:

1. Keep Tailwind v4 and define design tokens with theme variables: surfaces, text, borders, accent, danger, spacing, radii, typography.
2. Use utility classes for component layout, spacing, typography, responsive behavior, and simple visual states.
3. Add small shared `Button`, form-field, and page-state components only where repeated behavior/semantics justify them. Keep real button types, focus rings, disabled states, and accessible names.
4. Keep ordinary CSS for global base rules, meter browser pseudo-elements, and genuinely complex media behavior. Put global resets in an explicit base layer so they do not unexpectedly override utilities. Use a feature stylesheet/CSS module if a complex rule has only one owner.
5. Migrate home/shell first, then lobby/stage/stats, removing superseded selectors in each commit. Preserve layout and media behavior. Do not add a UI kit or class-variant dependency without an actual requirement.
6. For conditional utilities, use complete class-name maps. The current `stage-count-${stage.length}` is valid with manually written CSS; copying that interpolation into utility names would prevent static detection. Scope source scanning to actual web/shared UI sources as the monorepo grows. [Tailwind class detection](https://tailwindcss.com/docs/detecting-classes-in-source-files)

## 5. Structure, constants, DRY, and long-term ownership

Use feature-oriented modules with small shared infrastructure. A generic root `lib/` or `constants/` directory must not become the next dumping ground. Below is a proposed destination for **existing capabilities**, not a request to scaffold future broadcast features.

```text
apps/web/src/
  app/                       # App, providers, router, route error boundary
  config/env.ts
  lib/http/                  # request, ApiError, cancellation
  components/ui/             # reusable Button, field, PageState
  features/session/          # session store, persistence, API
  features/rooms/             # room API, query options, home workflows
  features/live/
    constants.ts             # browser tuning, not every literal
    components/              # lobby, controls, roster, tiles, stats, demos
    hooks/                   # room orchestration and service adapters
    services/                # media, signaling, peers, speaker, demos, stats
    stores/room-store.ts
  pages/                     # route-level composition
  styles/                    # tokens and base CSS

apps/api/src/
  config/                    # pure env parser + runtime configuration
  database/                  # durable connection/migrations
  sessions/                  # controller, guard, identity service
  rooms/                     # durable catalog service, mapper, entity
  live/
    signaling.gateway.ts     # transport adapter
    live.service.ts          # orchestration and shutdown
    serialized-operations.ts
    signaling.parsers.ts
    signaling.messages.ts
    live.connection.ts       # Redis lifecycle, separate from module metadata
    live.repository.ts       # Lua invocation and snapshots
    scripts/

packages/shared/src/
  contracts.ts               # HTTP contracts and parsers
  identifiers.ts             # UUID/slug validation and policy
  limits.ts                  # genuinely shared domain limits
  signaling.ts               # socket event contracts
  stage.ts                   # state transitions and domain types
  negotiation.ts
  stats.ts
  demo-peers.ts
```

C01 adopts this ownership layout in master v1.0.3 Section 12. Existing `src/live` paths remain valid until C09 performs the move; this decision does not scaffold future broadcast capabilities. Services do not import components. UI may call hooks/services through a feature API; cross-feature imports should use a small deliberate surface. Shared must not import Nest, React, browser globals at module initialization, or database clients.

### Constant/type rules

| Kind                                        | Owner                                              | Examples                                                                               |
| ------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Cross-boundary domain policy                | `packages/shared`                                  | Stage cap, slug length/validator, supported modes, names/title limits                  |
| Browser feature tuning                      | `features/live/constants.ts` or its owning service | Ack timeout, meter rate, stats interval, speaker threshold/hold, canvas/pulse settings |
| Backend infrastructure                      | `apps/api/src/live` / config                       | Redis TTL/namespace, queue budgets, dependency timeouts                                |
| Visual tokens                               | Tailwind theme/base styles                         | Surface/text/accent/danger colors, radii, typography                                   |
| Local derived values and tiny private types | Same file                                          | Component props used once, one-off calculation, private helper                         |

Use descriptive names with units such as `SIGNALING_ACK_TIMEOUT_MS`. Keep independently configurable policies independent even if their current numeric values match. A codebase-wide preference for `const` over `function` declarations does not improve React correctness; use consistent exports and extract by responsibility. Local types and constants are not defects merely because they share a component file.

### DRY decisions

Extract repeated room response mapping, identifier validation, transport timeout values, cleanup orchestration, and visual primitives. Keep the TypeScript oracle and Lua implementation with shared fixtures/parity testing: they execute in different runtimes and atomic Lua cannot simply call a TS function. Do not replace small Nest services with a generic base CRUD service or abstract every callback into a utility.

TanStack Query should own durable server fetch state; Zustand should own current live snapshots and session state; services should own mutable media handles. Do not copy the same room catalog into several stores. Keep high-frequency meter/stats updates outside broad room subscriptions. Adding `memo`, `useMemo`, or React Compiler without fixing ownership is not the first step.

## 6. Keeping checks, builds, and development fast

### Immediate policy

| Situation                        | Required work                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Editing a document               | Prettier on changed documents; validate links/claims. No application build unless code/config changed.                               |
| Web-only service change          | Current shared prerequisite, web typecheck/lint, affected service tests; relevant browser acceptance for media changes.              |
| API-only lifecycle change        | Current shared prerequisite, API typecheck/lint, service regressions and real Redis tests when Lua/persistence changes.              |
| Shared contract/algorithm change | Build/check/test shared plus both dependent app checks and affected consumer tests.                                                  |
| Dependency/config change         | Frozen install validation, affected checks, both builds for workspace/toolchain changes.                                             |
| Merge/release gate               | Complete workspace typecheck/lint/tests/builds/format, isolated Redis integration, artifact checks and relevant recorded acceptance. |

Use affected checks while iterating; this does not remove the full merge/release gate. Root lint/config or lockfile changes can affect every package even if a naive directory filter selects none. A docs-only path bypass must not skip a required media acceptance record.

### Concrete tooling changes

- Add root `build`, `test:unit`, `test:integration`, `check`, and `dev` entry points with explicit dependency order. Do not add recursive scripts that call themselves.
- Give each package separate `tsBuildInfoFile` paths and use incremental checking. Keep build and check caches separate; handle API `deleteOutDir` without invalidating the intended cache every time. Consider project references only after measuring the simpler setup. [TypeScript incremental](https://www.typescriptlang.org/tsconfig/incremental.html), [project references](https://www.typescriptlang.org/docs/handbook/project-references)
- Enable ESLint content caching per package with ignored cache paths; invalidate on config, parser, and dependency changes. Typed lint may cost more, so measure it separately from syntax lint. [ESLint cache](https://eslint.org/docs/latest/use/command-line-interface#--cache)
- Use pnpm dependency/dependent filters for local tasks; shared changes select both consumers. A changed-package-only filter is insufficient. [pnpm filtering](https://pnpm.io/filtering)
- Keep pre-commit to staged formatting and optionally quick staged lint. Retain full checks in CI/pre-push/manual verification, not every keystroke or every staged CSS change.
- Split API unit/service tests from infrastructure tests once more tests exist. Never skip Redis tests in their required gate. Vitest startup overhead matters when invoking three tiny suites; one workspace/project invocation can help if measured and configuration remains clear.
- Cache the package store and deterministic task outputs. Cache keys must include lockfile, Node/toolchain, package configs, shared dependencies, and relevant environment inputs. Never cache a live database result, a passing Redis test as proof for another service state, or secrets.
- Record clean and warm durations without concurrent contention, entry transfer size, and affected-package count. Establish warning budgets from that baseline; do not invent a universal 5-second threshold.
- A lightweight pnpm task graph is sufficient for three packages. Add Turborepo/Nx only when cross-package task caching and dependency scheduling produce a measured benefit. If adopted, include Lua assets, shared outputs, and environment inputs in the graph.
- Consider Nest's SWC compiler only if API compilation remains a bottleneck after test exclusion/incremental changes. Typechecking must remain explicit; decorator metadata, migrations, and Lua assets need parity checks. [Nest SWC](https://docs.nestjs.com/recipes/swc)
- Run advisory scanning on dependency changes and on a schedule, with actionable severity/reachability exceptions. A slow network audit need not run on every local commit.

### Acceptance checks to preserve in the repository

The valuable HTTP/socket/browser harnesses described in guides were temporary. Preserve a small reproducible service/socket smoke harness for authentication, stage-only relay, join/leave/disconnect, failure injection, and cleanup. Test behavior, not controller boilerplate or component markup. Keep manual hardware checks clearly separate; the master excludes a permanent Playwright suite. Record browser/tool versions and cleanup instructions so future agents can repeat evidence rather than trust prose from the prior session.

## 7. File-by-file disposition

Every tracked file appears below. “Keep” means no separate defect beyond referenced cross-cutting findings; it does not mean formally verified in every runtime. Tests were read as well as run. The generated lockfile is assessed as described in Section 1.

### Root, tooling, and documentation

| File                    | Disposition                                                                                                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.example`          | Keep as template; validate real configuration and separate CLI requirements (F17). Future FFmpeg/data keys being unused is expected.                                                                                                                                                      |
| `.gitattributes`        | Keep LF normalization.                                                                                                                                                                                                                                                                    |
| `.gitignore`            | Add env variants and new tool-cache paths; retain example template (F18).                                                                                                                                                                                                                 |
| `.husky/pre-commit`     | Keep staged formatting fast; CI owns full gates (F15).                                                                                                                                                                                                                                    |
| `.nvmrc`                | `22` is intentional major pin; align README/CI and document runtime upgrade policy.                                                                                                                                                                                                       |
| `.prettierignore`       | Sensible generated/secret exclusions; no application defect found.                                                                                                                                                                                                                        |
| `.prettierrc.json`      | Keep consistent formatting; no need for additional formatting tools.                                                                                                                                                                                                                      |
| `package.json`          | Add orchestrated check/build/test/dev and cache policy; keep package manager pin (F11/F15).                                                                                                                                                                                               |
| `pnpm-workspace.yaml`   | Current app/package globs are sufficient. Store future pnpm policy here deliberately.                                                                                                                                                                                                     |
| `pnpm-lock.yaml`        | Preserve generated resolutions; address F19. Its multiple YAML documents include pnpm environment/package-manager resolution and application dependencies; that is supported format, not corruption. [pnpm lockfile format](https://github.com/pnpm/pnpm/blob/main/pnpm/docs/lockfile.md) |
| `tsconfig.base.json`    | Good strict baseline; add measured package-specific incremental configuration (F14/F15).                                                                                                                                                                                                  |
| `eslint.config.js`      | Add web hooks, targeted promise safety, boundaries, config coverage, caching (F14).                                                                                                                                                                                                       |
| `docker-compose.yml`    | Healthy local setup; bind DB ports to loopback (F18). No API/web Dockerfile is required for current local proof.                                                                                                                                                                          |
| `README.md`             | Strong setup/limitations; improve shared watch/build prerequisites and single-instance/Redis-loss statement (F04/F10/F11).                                                                                                                                                                |
| `idea.md`               | Historical vision; retain superseded label, update stale master version reference without reviving excluded features.                                                                                                                                                                     |
| `MASTER_PLAN.md`        | Good scope discipline; reconcile status/gates/service-path rule and hardening policies (F20).                                                                                                                                                                                             |
| `plans/README.md`       | Stale Phase 4 status; preserve user's existing edits while reconciling (F20).                                                                                                                                                                                                             |
| `plans/phase1.md`       | Historical foundation contract; label superseded assertions as phase-local, retain real acceptance history.                                                                                                                                                                               |
| `plans/phase1/guide.md` | Useful commit evidence; historical “not committed” lines need clear dates/context, not rewritten hashes.                                                                                                                                                                                  |
| `plans/phase2.md`       | Atomic presence contract is sound; update recovery assumptions in current authority, preserve this historical gate.                                                                                                                                                                       |
| `plans/phase2/guide.md` | Preserve socket/Redis verification as reproducible harnesses; current historical exclusion searches are phase-local.                                                                                                                                                                      |
| `plans/phase3.md`       | Preserve outstanding physical checks; final statement about Phase 4 is stale (F20).                                                                                                                                                                                                       |
| `plans/phase3/guide.md` | Useful recorded negotiation corrections; reducer evidence does not cover manager candidate queues (F02).                                                                                                                                                                                  |
| `plans/phase4.md`       | Current completion record; host-only stats and absent promotion UI are intentional in this phase.                                                                                                                                                                                         |
| `plans/phase4/guide.md` | Preserve demo cleanup checks; reconcile prior-phase gate exception and extract reusable smoke evidence (F20).                                                                                                                                                                             |

### API

| File                                                           | Disposition                                                                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/package.json`                                        | Build/test dependency ordering, production commands, advisory remediation (F11/F12/F19).                                    |
| `apps/api/tsconfig.json`                                       | Split build/check configs; reconsider global property-initialization exemption (F12/F22).                                   |
| `apps/api/nest-cli.json`                                       | Lua asset copying works; retain when changing compiler/build paths.                                                         |
| `apps/api/vitest.config.ts`                                    | Redis failure behavior is correct; split integration/service projects when needed and include config checks.                |
| `apps/api/src/main.ts`                                         | Explicit host/config, live dependency policy, deployment transport limits (F03/F04/F18).                                    |
| `apps/api/src/app.module.ts`                                   | Module composition reasonable; resolve duplicate configuration ownership (F22).                                             |
| `apps/api/src/config/env.ts`                                   | Pure validated parser, dependency-specific config, complete optional TURN validation (F17).                                 |
| `apps/api/src/database/base.entity.ts`                         | Useful reuse; no reason to add a generic entity/service hierarchy.                                                          |
| `apps/api/src/database/data-source.ts`                         | Keep explicit migrations/no sync; decouple from unrelated env checks (F17).                                                 |
| `apps/api/src/migrations/1730332800000-CreateUsersAndRooms.ts` | Schema matches current entities; never edit a deployed migration to add new constraints.                                    |
| `apps/api/src/users/user.entity.ts`                            | Minimal guest entity is appropriate; retention is a later public-service policy (F03).                                      |
| `apps/api/src/sessions/current-user.decorator.ts`              | Thin and appropriate; keep behind guard.                                                                                    |
| `apps/api/src/sessions/jwt-auth.guard.ts`                      | Reused token verification is good; request user type is a guard-enforced assumption.                                        |
| `apps/api/src/sessions/sessions.controller.ts`                 | Thin; protect anonymous creation from abuse (F03).                                                                          |
| `apps/api/src/sessions/sessions.module.ts`                     | Reduce exports to consumed API; inspect compatible upgrade peer ranges (F19/F22).                                           |
| `apps/api/src/sessions/sessions.service.ts`                    | Good verify/lookup reuse; UUID helper and guest budget/retention boundary (F03/F17).                                        |
| `apps/api/src/rooms/room.entity.ts`                            | Correct mapping/check constraints; name slug uniqueness for precise retries (F22).                                          |
| `apps/api/src/rooms/rooms.controller.ts`                       | Thin, guarded; keep validation/service behavior centralized.                                                                |
| `apps/api/src/rooms/rooms.module.ts`                           | Suitable module boundary; no speculative repository layer required.                                                         |
| `apps/api/src/rooms/rooms.service.ts`                          | Recoverable ending, precise collision retry, mapper/projection helpers (F01/F17/F22).                                       |
| `apps/api/src/health/health.controller.ts`                     | Keep existing response contract; add separate live readiness for Redis (F04).                                               |
| `apps/api/src/http/api.exception.ts`                           | Good shared error shape; extend stable codes for new budgets/failure cases.                                                 |
| `apps/api/src/http/api-exception.filter.ts`                    | Small/possibly redundant, but preserves response contract. Revisit only with deliberate global error mapping.               |
| `apps/api/src/live/live.module.ts`                             | Separate connection lifecycle provider; explicit single-instance namespace and Redis failure policy (F04/F10).              |
| `apps/api/src/live/live.repository.ts`                         | Explicit real keys, cached scripts, bounded/validated result boundary, complete shutdown cleanup (F01/F09/F10).             |
| `apps/api/src/live/signaling.gateway.ts`                       | Extract orchestration; fix ending, budgets, input parsing (F01/F03/F08).                                                    |
| `apps/api/src/live/live.integration.test.ts`                   | Keep real atomic/parity tests; add operation-count, explicit-key, ending/recovery regressions in appropriate service tests. |
| `apps/api/src/live/scripts/common.lua`                         | Preserve atomic snapshot/revision behavior; eliminate whole-room rewrites and declare actual keys (F09/F10).                |
| `apps/api/src/live/scripts/join.lua`                           | Stage cap/host-first decision good; preserve duplicate-user checks during optimization.                                     |
| `apps/api/src/live/scripts/leave.lua`                          | Persist/recover host-ending intent before losing host identity (F01).                                                       |
| `apps/api/src/live/scripts/patchMedia.lua`                     | Partial updates and locks work; attendees can already advertise active media, a current state-policy gap (F23).             |
| `apps/api/src/live/scripts/setHand.lua`                        | Idempotent hand behavior correct; update only affected hash/zset records (F09).                                             |
| `apps/api/src/live/scripts/promote.lua`                        | Atomic cap and hand clearing good; lifecycle/device consent belongs in Phase 5 client/service work.                         |
| `apps/api/src/live/scripts/demote.lua`                         | Removes stage/hand; define media/share flag reset and client capture teardown when exposed (F07).                           |
| `apps/api/src/live/scripts/setHostLock.lua`                    | Lock does not auto-enable on unlock, correctly; define screen-share/video-lock interaction in Phase 5.                      |

### Web

| File                                        | Disposition                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/package.json`                     | Tailwind is present; scripts need prerequisites/gates, hooks lint dependency (F11/F12/F14).                                       |
| `apps/web/tsconfig.json`                    | Good strict bundler config; add isolated incremental cache, retain tests in checking.                                             |
| `apps/web/vite.config.ts`                   | Tailwind plugin correct; fix shared development invalidation, later scope scans (F11).                                            |
| `apps/web/index.html`                       | Adequate static entry; hosting deep-link fallback/security headers belong to deployment setup.                                    |
| `apps/web/src/vite-env.d.ts`                | Declare WS URL and avoid pretending declarations validate environment at runtime (F17).                                           |
| `apps/web/src/main.tsx`                     | Stable QueryClient and StrictMode good; providers can move when app boundaries grow.                                              |
| `apps/web/src/App.tsx`                      | Lazy route/error boundary and stale milestone text (F13/F20).                                                                     |
| `apps/web/src/api.ts`                       | Extract typed HTTP boundary, status/errors, signal/timeout/response parsing (F16).                                                |
| `apps/web/src/session.ts`                   | Handle storage writes/clear/expiry and identity-aware cache reset (F16).                                                          |
| `apps/web/src/index.css`                    | Tailwind imported; tokenize/split/migrate large custom global stylesheet (Section 4).                                             |
| `apps/web/src/pages/HomePage.tsx`           | New guest on each submit is contracted; extract workflow/query ownership, shared slug parser, update obsolete copy (F16/F17/F20). |
| `apps/web/src/pages/RoomPage.tsx`           | Highest frontend structure priority; meter, routing errors, lifecycle/role transitions (F05/F06/F07).                             |
| `apps/web/src/live/room-store.ts`           | Revision and room filtering good; add focused source tests and use narrower subscriptions.                                        |
| `apps/web/src/live/signaling.ts`            | Good human/demo ownership split; centralize timeouts, bound early buffer, guard closed/join cancellation paths (F02/F03/F17).     |
| `apps/web/src/live/signaling.test.ts`       | Useful independence/order tests; add close-before-connect/late-ack/timeout/invalid-envelope cases.                                |
| `apps/web/src/live/local-media.ts`          | Good capture cancellation; split preview/meter lifecycle from capture and output routing (F05/F06).                               |
| `apps/web/src/live/local-media.test.ts`     | Good share ownership cases; expand permission, setup cancellation, meter detach, output rejection behavior.                       |
| `apps/web/src/live/peer-manager.ts`         | Good track-source interface; fix candidate generations, bounded buffer, partial construction cleanup (F02).                       |
| `apps/web/src/live/peer-manager.test.ts`    | Current 3 tests cover share/scheduling, not real candidate orchestration; expand high-value cases (F02).                          |
| `apps/web/src/live/active-speaker.ts`       | Good owned analysis with threshold/hold and no network writes; local tuning constants belong here/feature constants.              |
| `apps/web/src/live/active-speaker.test.ts`  | Keep behavioral timing/resource tests; no need for markup snapshots.                                                              |
| `apps/web/src/live/stage-grid.tsx`          | Stable socket keys/local mute good; separate sink/autoplay recovery; extract tile after feature move (F06/F07).                   |
| `apps/web/src/live/demo-peer.ts`            | Strong independent reuse/idempotent stop; future moderation must apply authoritative flags to generated tracks.                   |
| `apps/web/src/live/demo-peer.test.ts`       | Useful partial setup/cancellation tests; add moderation only when that feature is implemented.                                    |
| `apps/web/src/live/stats-collector.ts`      | Sensible RTP mapping and in-flight guard; handle stalls and lifecycle identity if peers are replaced (F21).                       |
| `apps/web/src/live/stats-collector.test.ts` | Good errors/removal/timing coverage; add unresolved peer and report-counter churn fixtures.                                       |
| `apps/web/src/live/stats-drawer.tsx`        | Semantic table/details good; decide hidden polling and keep formatting feature-local (F21).                                       |

### Shared

| File                                      | Disposition                                                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/package.json`            | Keep framework independence; explicit fresh build/dev contract, deliberate exports (F11).                                                 |
| `packages/shared/tsconfig.json`           | Strict checking good; add check cache and consistent Node typing policy.                                                                  |
| `packages/shared/tsconfig.build.json`     | Correctly excludes tests; ensure no stale output and add cache/output discipline.                                                         |
| `packages/shared/vitest.config.ts`        | Simple config sufficient; include config files in tooling verification.                                                                   |
| `packages/shared/src/index.ts`            | Small public barrel acceptable today; avoid using it for internal circular imports; consider deliberate subpaths later.                   |
| `packages/shared/src/contracts.ts`        | Good shared parsing; split identifiers/limits and guard injected bytes: NaN returns all A, negatives can loop (F17/F22).                  |
| `packages/shared/src/contracts.test.ts`   | Strong boundaries/uniform-byte tests; add identifier/runtime-envelope cases where introduced.                                             |
| `packages/shared/src/signaling.ts`        | Good structural DTOs without DOM dependencies; add bounded parsers, preserve valid ICE markers, verify provenance requirements (F02/F17). |
| `packages/shared/src/stage.ts`            | Keep pure immutable oracle; fix current attendee media policy and define future demotion cleanup (F07/F17/F23).                           |
| `packages/shared/src/stage.test.ts`       | Good immutability/cap/roles/locks coverage; keep independent expectations as well as Lua parity.                                          |
| `packages/shared/src/negotiation.ts`      | Reducer separation good; manager owns actual asynchronous success and candidate-buffer provenance (F02).                                  |
| `packages/shared/src/negotiation.test.ts` | Covers decision states; not proof that actual peer queue handling is correct.                                                             |
| `packages/shared/src/stats.ts`            | Good basic deltas/nulls; document timestamp/loss and stream-reset semantics (F21).                                                        |
| `packages/shared/src/stats.test.ts`       | Keep calculations; current zero-loss test accepts same-timestamp loss behavior, so changing it requires an intentional contract update.   |
| `packages/shared/src/demo-peers.ts`       | Simple name helper appropriate; it is not server-side authorization or an abuse limit.                                                    |
| `packages/shared/src/demo-peers.test.ts`  | Adequate coverage; do not add more cases just for test-count growth.                                                                      |

## 8. Commit-by-commit implementation plan for agents

This is the remediation sequence, not permission to start Phase 5/6 features. C01's documentation and C02's dependency work are recorded below; C03–C20 remain **planned**, with no actual commit hashes. Execute only the requested slice(s) and reinspect the repo before execution. Use the exact current source paths below until the explicit move commit; update later slice paths when that move lands.

The immediate reliability chain is C03–C08 after C01. Dependency remediation C02 and exposure hardening C18 must precede any public rollout; C18 can run as soon as C03/C06 finish, ahead of UI cleanup. C20 corrects today's attendee state policy after C03 and does not require Phase 5 UI. The remaining slices follow their stated dependencies, so a high-priority fix need not wait for a styling migration.

### Execution rules

1. Read this report, the master, the current phase handoff, and `git status`. Preserve unrelated edits, especially the existing `plans/README.md` work.
2. Fix one behavior per commit. Tests for a bug land with its fix. Run affected typecheck/lint and existing relevant tests; shared changes also verify consumers. Until the task graph is fixed, explicitly rebuild shared first.
3. Do not introduce component snapshots, boilerplate controller/entity tests, a permanent Playwright suite, or excluded product capabilities. Focus new tests on parsing, lifecycle services, concurrency, failure recovery, and media adapters. Record this test-policy clarification in C01.
4. Keep test fixtures isolated. Never start a second API against the user's live Redis just to run a test: its startup clears presence. Do not stop shared containers to simulate outages.
5. Run browser acceptance for changed media behavior and record failures/gaps. Physical observations stay pending until actually seen.
6. Commit only after verification, using the message listed. Record real hashes after commits, as the master requires. Do not invent hashes or push. The original review request required no implementation commit; a subsequent request to do a named slice authorizes that slice and its local commit.

### C01 — `docs(architecture): reconcile current phase status and remediation rules`

**Status:** committed.\
**Actual commit:** `b3b533f9a1eb65ef556c46a3bd24bfebdc7c692e`

**Depends on:** none. **Addresses:** F20 and implementation ownership.

**Files:** `MASTER_PLAN.md`, `plans/README.md`, `plans/phase3.md`, `plans/phase4.md`, `review.md`.

Record actual Phase 4 state, outstanding Phase 3 checks, the status of the phase-gate exception, feature-local `services` ownership, affected-check policy, and service-regression test scope. Preserve historical evidence and the user's uncommitted edits. Do not claim physical acceptance or silently waive a product gate. If a product decision is still missing, record that pending decision while proceeding with independent bug fixes.

**Verify/done:** Prettier on edited docs; check referenced commit hashes with Git; all current status summaries agree while physical gaps remain explicit.

**Implementation record (2026-11-01):** Master v1.0.3 and the phase index now reflect all four committed Phase 4 slices while keeping Phase 3 physical microphone, audible output, native picker/stop control, and camera-indicator observations pending. The master records the prerequisite exception as a pending product decision, permits independently requested maintenance, and requires resolution before the next product phase. It adopts feature-local `services` ownership for the later C09 move, affected checks with a full merge/release gate, and meaningful service regressions without expanding the component/controller/entity or Playwright test scope. Historical entry snapshots, slice hashes, test counts, and browser evidence are preserved; preexisting index links remain. Application milestone copy and all application fixes stay in their planned slices.

**Verification record (2026-11-01):** `pnpm exec prettier --write MASTER_PLAN.md plans/README.md plans/phase3.md plans/phase4.md review.md`, the corresponding `--check`, and `git diff --check` passed. Validated all 14 local Markdown links and eight distinct referenced Git commits across the five edited documents; every commit exists in the current history with the recorded subject. Read back the status summaries against the Phase 3/4 contracts and guides: Phase 4's own checks are recorded as verified, Phase 3 physical observations remain pending, and the prerequisite exception remains a pending product decision. This slice changes only documentation; no application checks or physical acceptance were rerun. Record the actual hash after commit under master Section 1.4; that status/hash update rides with the next requested slice.

### C02 — `chore(deps): remediate audited dependencies with compatible resolutions`

**Status:** committed.\
**Actual commit:** `bb6db3fdbd38cdf91c542d828745c1a950fd8138`

**Depends on:** C01. **Addresses:** F19.

**Files:** `package.json`, `apps/api/package.json`, `pnpm-workspace.yaml` only if a narrowly scoped override is needed, `pnpm-lock.yaml`, `review.md`.

Recheck the four advisories. Prefer supported parent upgrades and compatible transitive patches. Do not force minimatch/glob majors through incompatible parents. Record any unavoidable temporary exception with reachability, owner, and review date. No application refactor in this commit.

**Verify/done:** frozen install validation, `pnpm audit --json`, root typecheck/lint, all current suites and both builds; report remaining exceptions honestly rather than requiring an impossible zero if no patch exists.

**Resolution (2026-11-01):** The latest NestJS 11 Express adapter is still `11.2.8`, pins `multer@2.4.0`, and requires Nest common/core `^11.0.0`. The latest adapter overall is `12.3.2` and requires common/core `^12.0.0`; upgrading it alone would violate those peers. Keep the NestJS 11 stack and use the exact parent-scoped override in `pnpm-workspace.yaml` to install `multer@2.5.0`. The [Multer release](https://github.com/expressjs/multer/releases/tag/v2.5.0) fixes the advisory within major 2 and retains its entry-point API, dependency ranges, and Node engine floor. Both the adapter and Multer load successfully in a standalone Node check without starting the API. There is no current multipart/fileFilter endpoint; this removes the vulnerable production dependency before upload work exposes it. The regenerated lockfile changes only that resolution, its integrity, and the scoped override; direct dependency versions stay unchanged. Recheck the override on every Nest upgrade and remove it when the selected supported adapter itself resolves patched Multer.

**Temporary advisory exceptions:** Owner for all three is the **StageFlow repository maintainer**. Recorded/rechecked **2026-11-01**; next review **2026-11-08**, or earlier when a compatible parent/fix is published or tooling starts accepting untrusted input. No audit-ignore rules, forced cross-major replacements, or vendored patches were added.

| Advisory / retained version                                                                                        | Why retained and current reachability                                                                                                                                                                                                                                                                                                                                                                                                        | Removal criterion                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), moderate; `minimatch@10.2.6` and `3.1.5` | Current parents `eslint@10.14.0`, `@eslint/config-array@0.23.5`, `typescript-eslint@8.72.1`, and Nest CLI 11/checker are already at their latest applicable releases and still request majors 10 or 3. The published fix is `11.0.1`, outside those ranges; the checker calls major 3's function export. Used for local lint/build/watch patterns, with no application request path found. Keep configuration/patterns repository-controlled | Parent releases adopt the patched major with a supported API, or upstream publishes a compatible backport; then update and rerun lint/build/tests |
| [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), moderate; `glob@13.0.6`                  | Latest CLI 11 is `11.0.24` and pins `13.0.6`; the available fix `14.0.2` crosses that declared major. The installed CLI uses it for local asset discovery/copy/watch from `nest-cli.json`, including the fixed Lua asset pattern. No application request path found; do not accept untrusted asset globs                                                                                                                                     | A supported CLI 11 update/backport adopts a fixed release, or a separately verified toolchain migration replaces this dependency                  |
| [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), low; `deepmerge@4.3.1`                   | No published patch. Latest `fork-ts-checker-webpack-plugin@9.1.0` still depends on it; its webpack checker path merges local configuration/options. No application request path found; use trusted build configuration                                                                                                                                                                                                                       | A patched compatible release or supported parent removes/replaces it; recheck the checker and API build                                           |

The above reachability statements are source/dependency-path observations, not exploit proofs or a claim that development tools are safe with hostile configuration. Latest-parent checks used npm registry metadata, including declared dependencies, engines, and peer ranges; advisory fix thresholds were checked against the linked records.

**Verification record (2026-11-01):** Node `22.23.2`, pnpm `12.9.1`. Shared was explicitly built before dependent checks. All three existing suites ran, including the real Redis integration suite using its isolated UUID prefixes; no API server was started and no shared container was stopped.

| Check                                  | Result                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`       | Pass; lockfile SHA-256 unchanged                                                                                  |
| `pnpm audit --json`                    | Exit 1 as expected: zero high/critical, two moderate and one low advisory, all development-only; exceptions above |
| `pnpm audit --prod --json`             | Pass; zero advisories                                                                                             |
| `pnpm typecheck` / `pnpm lint`         | Pass across all packages                                                                                          |
| `pnpm --filter @stageflow/shared test` | 95 tests, 5 files pass                                                                                            |
| `pnpm --filter @stageflow/web test`    | 23 tests, 6 files pass                                                                                            |
| `pnpm --filter @stageflow/api test`    | 19 real Redis tests, 1 file pass                                                                                  |
| `pnpm --filter @stageflow/web build`   | Pass; unchanged existing large-chunk warning (615.65 kB JavaScript, Vite estimated gzip 186.55 kB)                |
| `pnpm --filter @stageflow/api build`   | Pass; eight Lua assets emitted                                                                                    |

`pnpm format:check` and `git diff --check` also passed after formatting the edited workspace configuration and report.

**Additional strict-peer check:** `pnpm install --no-frozen-lockfile --strict-peer-dependencies` installed the scoped update but exited 1 for two **preexisting optional-peer mismatches**: TypeORM `1.1.2` requests `ioredis ^5.0.4` while `6.0.0` is installed; `schema-utils@4.8.1` requests `webpack ^5.112.0` while the CLI pins `5.106.2`. Registry peer metadata and the baseline lockfile confirm both precede C02, and neither resolution changed. Standard frozen installation, checks, tests, and both builds pass; strict peer validation does not. No peer suppression or unrelated driver/toolchain change was added. Retain these mismatches as explicit follow-up maintenance rather than representing the strict check as green.

Record the actual C02 hash after commit under master Section 1.4; that status/hash update rides with the next requested slice. C02 also carries C01's post-commit status/hash entry.

### C03 — `refactor(shared): centralize identifiers and bounded signaling parsers`

**Depends on:** C01. **Addresses:** F03/F17.

**Files:** create `packages/shared/src/identifiers.ts`, `limits.ts`, `signaling.parsers.ts`, their focused `.test.ts` files; update `contracts.ts`, `signaling.ts`, `stage.ts`, `index.ts`; update `apps/api/src/sessions/sessions.service.ts`, `rooms/rooms.service.ts`, `live/signaling.gateway.ts`, `apps/web/src/pages/HomePage.tsx`.

Centralize slug/UUID validation and actual shared policy; parse unknown socket inputs into exact DTOs before queues. Set explicit SDP/candidate/id bounds and stable errors. Reject non-empty ICE candidate strings with both media identifiers null, while accepting valid empty-string/null end markers. Guard the slug helper against non-integer/out-of-range callback results; regression tests must reject NaN and negative values after the fix. Use a bounded pre-fix probe if demonstrating the old negative-byte hang, not an unbounded call that stalls CI. Keep infrastructure/browser tuning separate. Keep existing role/stage behavior and Lua parity; no second class-validator schema for the same contract.

**Verify/done:** shared build/tests, all package typechecks/lints, web tests and real Redis suite; malformed/oversize inputs reject before repository work and existing valid payloads still pass.

### C04 — `refactor(api-live): extract room lifecycle orchestration from the gateway`

**Depends on:** C03. **Addresses:** F08.

**Files:** create `apps/api/src/live/live.service.ts`, `serialized-operations.ts`, `signaling.messages.ts`, focused service/queue test files; update `signaling.gateway.ts`, `live.module.ts`.

Move queue ownership and application operations behind transport-independent results/effects. Keep trusted identity from the handshake. The gateway retains Socket.IO emission/membership mechanics. Do not change persistence order yet; separate regression coverage from C05's behavior fix.

**Verify/done:** shared prerequisite, API typecheck/lint/service tests/Redis tests/build; isolated socket smoke confirms joins, ack shape, stage-only target relay, and disconnect behavior stay compatible.

### C05 — `fix(api-live): complete host shutdown after partial persistence failures`

**Depends on:** C04. **Addresses:** F01.

**Files:** `apps/api/src/live/live.service.ts`, `live.repository.ts`, `scripts/leave.lua`, `scripts/common.lua`, `signaling.gateway.ts`, relevant service/Redis tests, `packages/shared/src/stage.ts` and its tests if the domain result changes.

Implement retained ending intent and idempotent completion. Reject joins while ending. Retry completion independently of the vanished host participant. Define notification/socket cleanup when PostgreSQL or Redis is unavailable; keep catalog-reset behavior on process restart as contracted. Test failure at each awaited boundary, duplicate leave, and disconnect during leave.

**Verify/done:** original F01 reproduction now completes all effects on retry; zero stale associated guests; appropriate catalog ENDED state; all affected checks and real Redis parity pass.

### C06 — `fix(api-live): expose Redis readiness and reset failed live sessions`

**Depends on:** C05. **Addresses:** F04/F10 runtime failure.

**Files:** create `apps/api/src/live/live.connection.ts`, readiness service/controller and focused tests; update `live.module.ts`, `live.service.ts`, `main.ts`, `health/health.controller.ts` only if preserving its contract, `README.md`.

Separate Redis connection lifecycle from module metadata. Implement the selected V1 dependency-loss policy, distinct live readiness, and bounded shutdown. Do not quietly enable session resume. Test against disposable Redis or an injected failing client without touching developer live keys.

**Verify/done:** Redis loss cannot leave readiness healthy and sockets silently stuck; PG-only health compatibility remains documented; API checks/build and isolated outage/reset smoke pass.

### C07 — `fix(webrtc): bind queued ICE candidates to accepted descriptions`

**Depends on:** C03. **Addresses:** F02.

**Files:** `apps/web/src/live/peer-manager.ts`, `peer-manager.test.ts`, `signaling.ts`, `signaling.test.ts`; `packages/shared/src/signaling.ts`, `signaling.parsers.ts` and tests; `apps/api/src/live/signaling.gateway.ts` parser/relay mapping as needed.

Add manager-level regression cases first: candidates queued before ignore, candidates arriving during ignore, and a rejection partway through draining. Use a real SDP/ICE browser fixture to establish which candidates remain valid before expanding the wire protocol. Preserve usernameFragment when needed/available, but do not assume each description has a distinct ICE generation. Bound both per-peer candidate queues and pre-join `pending` callbacks by count/size, with timeout/close cleanup and an explicit overflow outcome. Handle candidate failures without losing unrelated valid work or hiding malformed input. Preserve valid pre-description ordering and null/empty-string end markers, including the both-null identifier exception for the empty string. Cover late events after close and failed remote descriptions. Do not rewrite the reducer or add ICE restart.

**Verify/done:** a fixture with genuinely incompatible ICE credentials cannot poison the accepted description; accepted early candidates flush in order and a failed candidate does not silently discard the remaining valid batch. Buffer overflow, timeout, and close release queued work. Shared/consumer tests/checks pass; repeat two/four-member browser mesh and share checks with no added share offer. Do not declare success merely because a fake's labeled candidate was dropped.

### C08 — `fix(web-media): release lobby analysis without stopping call tracks`

**Depends on:** C07. **Addresses:** F05/F06.

**Files:** `apps/web/src/live/local-media.ts`, `local-media.test.ts`, `stage-grid.tsx`, `pages/RoomPage.tsx`; add a small output-routing helper/test if needed.

Provide separate preview/meter detach and full capture stop. Stop hidden lobby rendering work after join. Handle output selection rejection with default fallback and a distinct routing error. Keep join ready after capture succeeds, and make the visible retry perform the failed operation. Cover concurrent prepare/cancel and all cleanup paths.

**Verify/done:** no meter callbacks/detached preview playback after join, local tracks remain live until leave, sink failure does not disable join, share/leave cleanup tests pass; browser/device checks recorded with physical limitations explicit.

### C09 — `refactor(web-live): separate room orchestration from route components`

**Depends on:** C08 and C01 ownership decision. **Addresses:** F07.

**Files:** `apps/web/src/pages/RoomPage.tsx`; move existing `src/live` services/tests to `src/features/live/services/`, room store to `features/live/stores/`; create `features/live/hooks/use-live-room.ts`, `use-screen-share.ts`, `use-demo-peers.ts`; create `features/live/components/green-room.tsx`, `room-controls.tsx`, `participant-list.tsx`, `demo-controls.tsx`; move stage/stats components under that directory. Update imports in all moved files and page consumers.

Use one cleanup owner, explicit connection phases, and separate operation states. Keep imperative handles out of UI stores. Preserve synchronous snapshot→peer ordering. Use authoritative participant role after join; prepare promotion/demotion extension points without implementing Phase 5. Keep the lobby meter locally subscribed. Update subsequent paths in this plan after the move.

**Verify/done:** no service→component imports, route is composition/query/error states, source tests/checks/build pass; browser regression covers join, reject, share, demos, remove-during-start, navigation, disconnect, host end.

### C10 — `fix(web-api): preserve request errors cancellation and session recovery`

**Depends on:** C09. **Addresses:** F16/F17 web config.

**Files:** replace `apps/web/src/api.ts` with `lib/http/client.ts`/`api-error.ts`; move session to `features/session/session-store.ts` and API to `features/session/api.ts`; create `features/rooms/api.ts`, `query-options.ts`, `config/env.ts`; update `pages/HomePage.tsx`, `pages/RoomPage.tsx`, demo service, `vite-env.d.ts`; add focused HTTP/session tests.

Preserve status/error codes; consume AbortSignal and bound timeout; parse success envelopes; make storage writes resilient and provide clear/expiry handling. Use identity-aware query keys and clear old private caches. Preserve the contracted fresh guest on each home submission; do not add registered accounts.

**Verify/done:** aborted requests do not become false network errors; 401 recovery returns to a usable name flow; denied storage still permits an in-memory session; API/web checks/tests/build and create/join smoke pass.

### C11 — `refactor(web-ui): define Tailwind tokens and reusable form primitives`

**Depends on:** C10. **Addresses:** styling debt and F20 UI text.

**Files:** `apps/web/src/index.css`, create `styles/theme.css`, `styles/base.css`, `components/ui/button.tsx`, `form-field.tsx`, `page-state.tsx`; update `App.tsx`, `pages/HomePage.tsx`, `main.tsx`.

Adopt Section 4's Tailwind v4 convention. Migrate shell/home, preserve focus/labels/errors/responsiveness, add skip link and sensible input limits, and replace obsolete video/build milestone copy. Keep button semantics explicit. No new design system dependency.

**Verify/done:** web typecheck/lint/build; manual keyboard/home create/join/320px and desktop inspection; obsolete home/shell selectors removed. No component snapshot suite.

### C12 — `refactor(web-ui): migrate live-room styles to feature components`

**Depends on:** C11. **Addresses:** remaining styling debt.

**Files:** live components under `apps/web/src/features/live/components/`, `index.css`, `styles/theme.css`, feature CSS only where needed.

Migrate lobby, roster, stage, stats, demo controls with complete static utility maps. Keep meter pseudo-element CSS. Remove unused selectors and duplicated breakpoint blocks, retain screen-share aspect ratio, local-camera mirroring, and unmirrored screen capture.

**Verify/done:** web checks/build plus existing meeting/share/demo/browser acceptance; focus and video layout survive at supported widths, CSS ownership is clear. Do not change media behavior in the style migration.

### C13 — `perf(api-live): update only changed Redis records and cache Lua scripts`

**Depends on:** C05. **Addresses:** F09/F10 script discipline.

**Files:** `apps/api/src/live/live.repository.ts`, all eight `scripts/*.lua` files, `live.integration.test.ts`, relevant shared oracle fixtures if policy changes are required.

Pass real key names through KEYS, update only changed records, preserve one atomic revisioned snapshot and all no-op/rejection rules, cache scripts safely. Keep environment namespace configurable; if cluster compatibility is claimed, demonstrate same-slot hash tags and actual cluster behavior. Otherwise explicitly retain standalone-only support.

**Verify/done:** real Redis parity/concurrency/TTL tests pass; instrumented operations show one mute does not recreate unrelated records; compare bounded-roster latency to a recorded baseline. No full-room protocol change or unapproved attendee cap.

### C14 — `fix(tooling): build and watch shared before dependent tasks`

**Depends on:** C03. **Addresses:** F11.

**Files:** root/package scripts, `packages/shared/package.json` and TS configs, `apps/web/vite.config.ts`, app scripts, optional `scripts/dev.mjs`, `README.md`.

Create explicit shared prerequisites for build/dev/test/check. Watch shared source and avoid stale Vite prebundling after export changes. Keep API CJS runtime working. Document root supported commands; avoid recursive script loops. Add subpath/development exports only if necessary and verified in both app runtimes.

**Verify/done:** in a disposable checkout without dist artifacts, documented commands build dependencies automatically; editing/adding a shared export is reflected in API/web/tests without manual --force instructions.

### C15 — `perf(build): exclude API tests and defer the room route`

**Depends on:** C09 and C14. **Addresses:** F12/F13.

**Files:** create `apps/api/tsconfig.build.json`; update `nest-cli.json`, API scripts if required; `apps/web/src/App.tsx`, create `app/route-error-boundary.tsx`; root build/check scripts.

Exclude tests from emitted API output while retaining their check config. Keep Lua assets. Lazy-load the room route with loading and failure states. Keep release typecheck as a graph prerequisite and maintain the size warning. Record before/after entry chunks and actual total room-load cost.

**Verify/done:** both builds/typechecks pass; API dist contains no tests and all Lua files; production module smoke works; home does not fetch room/media chunk before navigation and deep-link room loading still works.

### C16 — `chore(quality): add focused lint rules and incremental check caches`

**Depends on:** C14. **Addresses:** F14/F15.

**Files:** `eslint.config.js`, root/web package manifests/lockfile as needed, all package TS configs, `.gitignore`, root scripts; only source files with real lint findings.

Add compatible hooks rules, targeted type-aware promise checks, boundary restrictions, configuration coverage, per-package ESLint content caches, and separate incremental check caches. Keep generated files excluded. Do not “fix” effects by blindly expanding dependencies into reconnection loops. Measure cold/warm results before and after without concurrent benchmark contention.

**Verify/done:** whole-workspace lint/check/tests pass, caches do not mask edits or shared type changes, clean and warm timings recorded; no blanket suppressions.

### C17 — `ci(checks): verify affected packages and full release artifacts`

**Depends on:** C15/C16. **Addresses:** F15 and repeatability.

**Files:** create `.github/workflows/checks.yml` (or the repository's chosen CI equivalent), optional `scripts/check-affected.mjs` and `scripts/smoke-live.mjs`; update root scripts/README.

Frozen install, correct shared/dependent graph, ephemeral Redis integration, deterministic artifact checks, format/lint/typecheck/tests/build, cancellation of superseded jobs, useful caches. Run full checks for root config/lockfile changes and a full merge/release path. Preserve a small socket/service smoke harness; do not launch the destructive API startup against developer Redis. Scan advisories on dependency changes/schedule with explicit exceptions.

**Verify/done:** simulate web-only/shared/root/docs changes; correct tasks selected; missing Redis fails its gate; a clean uncached checkout passes; no secret or live-service artifacts in caches.

### C18 — `fix(config): isolate local infrastructure and bound public API work`

**Depends on:** C03/C06. **Addresses:** F03/F10/F17/F18.

**Files:** `docker-compose.yml`, `.gitignore`, `.env.example`, API config parser/database source, `main.ts`, `sessions` rate-limit boundary, `live.service.ts`, `serialized-operations.ts`, gateway transport options, shared error codes/parsers if needed, `README.md`.

Bind local DBs to loopback; validate configuration; separate migration requirements; namespace environments; explicitly document/enforce one active API owner. Add configured request/event/queue budgets and cleanup priority without changing the stage cap. Introduce a documented deployment policy for origins, JWT secrets, forwarded addresses, and guest issuance. Keep future binary-upload limits separate. Any new attendee maximum or session lifetime needs a recorded contract decision before enforcement.

**Verify/done:** invalid config fails clearly; migration config no longer needs unrelated services; `docker compose config` shows local bindings; burst tests reject early and leave/disconnect stays bounded; independent environments do not clear one another; API/shared checks/tests/build pass.

### C19 — `perf(telemetry): isolate stalled reads and document hidden polling`

**Depends on:** C09. **Addresses:** F21.

**Files:** live stats service/tests and drawer at their new paths, `packages/shared/src/stats.ts`/tests only if semantics change, active phase/master tuning notes where appropriate.

Choose hidden-drawer behavior, bound stalled reads per peer, retain healthy rows, and define timestamp/reset semantics. Avoid stale publications after close or manager replacement. Preserve honest null/unknown values and one-second visible update cadence.

**Verify/done:** fake-timer tests cover one never-resolving peer, healthy peer updates, close during await, reopening drawer and baseline behavior; browser stats/demos still work with no additional peer connections.

### C20 — `fix(api-live): normalize off-stage participant media state`

**Depends on:** C03 and a recorded attendee-state policy in C01/current contract. **Addresses:** F23.

**Files:** `packages/shared/src/stage.ts`, `stage.test.ts`, shared error contracts if a new rejection code is selected; `apps/api/src/live/scripts/join.lua`, `patchMedia.lua`, `live.integration.test.ts`, `signaling.messages.ts`; current contract notes in `MASTER_PLAN.md`.

Define valid off-stage flags and normalize joins accordingly. Apply the same reject/normalize policy for attendee patches in Lua and the pure oracle. Keep permitted no-op updates idempotent, stage membership server-owned, and Demo display flags nonprivileged. Update the existing tests that intentionally patch attendee media instead of assuming they already enforce the desired policy. Do not expose promotion/demotion or claim booleans prove actual capture/transmission.

**Verify/done:** an attendee cannot advertise an active camera/microphone/share contrary to the documented role policy; rejected changes leave state/revision unchanged, normalized no-ops follow the existing revision rule, and shared/Redis parity plus socket smoke checks pass. Stage peers retain ordinary mute/video/share behavior and attendee relay is still rejected.

### Completion gate for the remediation pass

All selected fixes have real commits and evidence; no claimed passing check was skipped. Re-run the full release gate once after the sequence and the one-machine meeting/demo/share/leave script for changed media paths. Reconcile the report's remaining items and explicitly retain physical checks and future multi-instance limits. Only then continue the next authorized product phase; do not use this maintenance plan to add an SFU, storage provider, queue worker, accounts, or broadcast implementation.

## 9. Independent cross-check and resolution

The independent pass on 2026-11-01 checked source, the 103-path inventory, expanded test cases, lockfile versions, and generated artifacts. It did not rerun the suites, audit feed, original timings, or original failure-injection harnesses. The author of this report then checked its corrections against source and performed the bounded probes/build recorded in Section 2. This section replaces the contradictory correction appendix with the disposition below; the main findings and commit instructions now incorporate it.

| Cross-check item                                     | Resolution in this revision                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slug helper with NaN                                 | Accepted. NaN returns `AAAAAAAAAAAA`; negative callback values can loop. Confirmed by a direct NaN call and a VM-limited negative-value probe. Corrected F22, inventory, and C03.                                                                                             |
| Role UI described too broadly                        | Accepted. Catalog-derived controls coexist with live-role and stage-derived controls. Corrected F07 to identify exactly which controls would disagree after promotion.                                                                                                        |
| JavaScript gzip size called incorrect                | Qualified. Fresh Vite output still estimates 186.55 kB; Node default gzip measures 184.99 kB for the same 615,650-byte artifact. Both are now labeled in Section 2. The original number was faithful to the Vite output, not an independently measured hosting transfer size. |
| Home sentence/source line and footer                 | Accepted. Corrected the sentence reference to lines 152?153 and included the outdated footer in F20. Distinguished committed versus worktree planning-index text.                                                                                                             |
| Host-shutdown failure                                | Retained F01. Source ordering and unknown-participant no-op support the original isolated reproduction; no new real database outage was simulated.                                                                                                                            |
| ICE buffers before/during ignore and failed draining | Incorporated into F02/C07. Source confirms retention, drops during ignore, and batch removal before asynchronous candidate application. A labeled fake does not establish ICE incompatibility; browser credentials/order must distinguish valid from stale candidates.        |
| Detached preview/meter and sink failure              | Incorporated into F05/F06/C08. The meter and preview are retained until full media stop; routing the muted preview is separate from routing remote audio. Retention does not by itself prove a detached browser video continues decoding; verify that with browser profiling. |
| Redis expiry strands existing sockets                | Incorporated into F22. Rejoining is blocked by the stale socket association, not only by revision filtering. Long-duration recovery remains a policy/test gap; no 24-hour run was performed.                                                                                  |
| Attendee media flags already accepted                | Promoted from a future-only note to current F23 and C20. Confirmed with the pure transition function and matching Lua source. Existing tests encode permissive attendee patches and must change with the documented policy. Stage access is still blocked.                    |
| Client-supplied Demo flag                            | Confirmed but not elevated to an authorization issue: the master explicitly makes it display-only. Included in F23.                                                                                                                                                           |
| Both ICE media identifiers null                      | Accepted for a non-empty candidate string only. An empty-string end-of-candidates object can legitimately have both null under the current W3C addIceCandidate algorithm. F02/C03/C07 preserve that exception rather than rejecting every both-null object.                   |
| Pre-join signaling queue                             | Incorporated into F03/C07. Count/bytes are uncapped; normal timeout/caller cleanup bounds retention time. No claim of indefinite normal retention.                                                                                                                            |
| Inventory, test totals, versions and artifacts       | Retained 103 tracked paths, 95 shared + 23 web + 19 Redis cases, and copied Lua/test artifact observations. This revision did not independently rerun every original command or refresh the audit.                                                                            |

The independent pass corroborated the remaining source-based findings, including Redis failure handling, full-room Lua rewrites, destructive startup, shared dist prerequisites, eager route loading, cache/error handling, and development-service bindings. All original acceptance limitations still apply. This is a corrected report and proposed implementation sequence, not completed application remediation.**Implementation/verification record (2026-11-01):** Centralized UUID/slug validation and generation, text limits, and the unchanged four-slot stage policy. Existing contracts re-export slug generation for compatibility. Invalid byte sources (NaN, negative, fractional, infinite, or above 255) throw immediately; 248?255 rejection sampling and its bounded retry policy remain. Shared signaling parsers copy exact DTO fields before gateway socket/room queues and repository work, preserving the existing invalid_payload error. SDP is bounded at 65,536 UTF-16 code units, ICE text at 4,096, socket IDs at 128, mid at 256, and m-line index at 65,535; these are transport admission budgets, not SDP syntax validation. Non-empty ICE with both identifiers null is rejected; null and empty-string end markers remain accepted. Role/media policy and Lua are unchanged. Shared tests (117), web tests (23), real Redis tests (19), all-package lint and typecheck, and web production build passed; the existing large-chunk warning remains. Physical/browser media acceptance was not rerun for this parser slice. API build also passed. A compiled-gateway probe rejected malformed join, description, ICE, media, and hand events with invalid_payload before execute/relay/update or repository work. Workspace formatting and whitespace checks passed. C03 carries C02?s post-commit hash; record C03?s real hash after commit for the next slice.
