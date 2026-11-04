# Guide — V2 Phase 4, commit by commit

**Status:** delivered; acceptance partial. V2P4-C01 through V2P4-C04 are committed. V2P4-C05 is verified. CHAT-04's remaining observations and the missing server-timestamp display stay open.\
**Last updated:** 2026-11-04.\
**Phase contract:** [../phase4.md](../phase4.md).\
**Product authority:** [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md) version `2.0.0-draft.5`. Unchanged V1 rules stay in [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.9`.\
**Deliverable:** Connected people can exchange bounded room text, with host pause and recent history, in five commits. This is the only V2 Phase 4 guide. Its commit ids are not the V1 Phase 4 commits in [../V1/phase4/guide.md](../V1/phase4/guide.md).

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `0a1c9492639762928d56716de0c4cfa2f34c89ac`. Recheck the worktree. `plans/phase1.md` and `plans/phase2.md` were already dirty when this guide was written.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run V2P4-C01 through V2P4-C05 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing. API tests that touch Redis fail when Redis is unreachable. Do not point them at developer keys outside `sf:itest:*`.
4. After verification, commit that slice under V1 master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(v2-phase4): record the final slice hash`.
5. If a browser cannot be used, leave the browser half of the related acceptance id unverified and name the gap.
6. Do not mark P3-A03, P3-A05, or P3-A06 passed unless that physical or native-picker observation was actually made.

Keep the mesh cap, the negotiation reducer, device replacement, reconnect, and the single 720p pipeline. Do not add accounts, `restartIce`, or a PostgreSQL message table.

### 1.1 Commit index

| Order | ID       | Proposed message                                            | Acceptance                      |
| ----- | -------- | ----------------------------------------------------------- | ------------------------------- |
| 1     | V2P4-C01 | `feat(shared): parse a room chat message`                   | CHAT-02 parsers                 |
| 2     | V2P4-C02 | `feat(api-chat): accept chat in one Redis script`           | CHAT-01 store, CHAT-02, CHAT-03 |
| 3     | V2P4-C03 | `feat(api-live): authorize chat without touching the stage` | CHAT-03 gateway, CHAT-04 server |
| 4     | V2P4-C04 | `feat(web-room): show room chat beside the stage`           | CHAT-01 client, CHAT-04         |
| 5     | V2P4-C05 | `docs(readme): state the room chat limits`                  | README limits                   |

### 1.2 Files to inspect before editing

- `packages/shared/src/limits.ts`, `signaling.ts`, and `signaling.parsers.ts`
- `apps/api/src/live/live.keys.ts`, `live.repository.ts`, `live.service.ts`, and `signaling.gateway.ts`
- `apps/api/src/live/serialized-operations.ts` and `live.connection.ts`
- `apps/api/nest-cli.json` and `scripts/check-artifacts.mjs`
- `apps/web/src/features/live/services/room-session.ts` and `components/live-room.tsx`
- `apps/web/src/features/live/services/demo-peer.ts`
- `apps/web/src/app/entry-graph.test.ts` and `pages/HomePage.tsx`
- `README.md`

## 2. V2P4-C01 — Shared chat contract

**Status:** committed\
**Proposed commit message:** `feat(shared): parse a room chat message`\
**Actual commit:** `74692c53b6219f39645a773d56f79f2e59c914d9`

**Why:** The API and the page need one message shape and one set of bounds before either side stores text. Covers the parser half of CHAT-02.

**Depends on:** The current shared signaling parsers.

**Files:**

- `packages/shared/src/limits.ts`
- `packages/shared/src/chat.ts`
- `packages/shared/src/chat.test.ts`
- `packages/shared/src/index.ts`

**Implementation:**

1. Export the bounds from Section 5: text length 1 to 1,000 UTF-16 code units after trim, 4,000 UTF-8 bytes, 500 retained messages, 86,400-second idle TTL, history page 50 and 100, 10 accepts per participant and 100 per room per 10 seconds, 500 dedup entries, 5 pending client sends, 1,000 user-rate fields, and 32 queued chat operations per room.
2. Parse a send body as `{ requestId, text }` where `requestId` is a UUID. Reject a body that also contains a room id, a display name, a role, a sequence, or a timestamp. Trim `text` in the parser and reject an empty or oversized result with a distinct parse failure the API can map to `chat_invalid` or `invalid_payload`.
3. Parse history as an optional `beforeSequence` and an optional `limit`. Omit means the latest default page. A limit outside 1 to 100 fails. Parse pause as `{ paused: boolean }` with no other fields.
4. Export the message type from Section 5.2 and a history result with `paused`, `oldestSequence`, `latestSequence`, `retentionGap`, and ascending `messages`. This slice does not open Redis or render a panel.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm typecheck
pnpm lint
```

**Done when:** The parser cases pass and the slice is committed.

**Verification result (2026-11-04):** `pnpm --filter @stageflow/shared test` passed (262 tests), `pnpm typecheck` passed, and `pnpm lint` passed. CHAT-02's parser half covers trimmed UTF-16 bounds, oversized UTF-8 input, preserved internal newlines and plain text, UUID request ids, rejected extra fields, default and bounded history pages, safe positive sequence cursors, and strict pause booleans. Redis and browser acceptance remain planned for later slices. Existing physical and native-picker gaps remain open.

**Handoff:** No socket event accepts chat yet. The room page is unchanged.

## 3. V2P4-C02 — Redis accept path

**Status:** committed\
**Proposed commit message:** `feat(api-chat): accept chat in one Redis script`\
**Actual commit:** `d77747c3cd57a6e2dbb4fe6bb65e434ac48ca890`

**Why:** Order, pause, rate, and dedup have to commit together or two callers can disagree. Covers the store half of CHAT-01, CHAT-02, and CHAT-03.

**Depends on:** V2P4-C01. Stage `liveKeys` stay nine entries.

**Files:**

- `apps/api/src/chat/chat.repository.ts`
- `apps/api/src/chat/chat.repository.test.ts`
- `apps/api/src/chat/scripts/accept.lua`
- `apps/api/src/chat/scripts/history.lua`
- `apps/api/src/chat/scripts/setPaused.lua`
- `apps/api/nest-cli.json`
- `scripts/check-artifacts.mjs`

**Implementation:**

1. Keep chat keys off `liveKeys`. Use `chat:seq`, `chat:messages`, `chat:paused`, `chat:dedup`, `chat:room-rate`, and `chat:user-rate` under the existing room prefix. Pass the participant hash as an extra key so the script can read the row. Do not prepend `common.lua`. Adding these files must not change the 14 live-script count or the key length of 9.
2. `accept.lua` reads the participant, requires `presence` connected and the supplied generation and socket id, then reads pause. A duplicate request id returns the stored message. Otherwise it applies both rate windows, appends one JSON message, trims the list to the supplied retention, remembers the request id, trims that map to the supplied dedup cap, and refreshes the 86,400-second TTL. The service passes the shared constants. Tests pass a smaller retention, dedup cap, and rate cap, and they pass `now`.
3. A paused room returns `chat_paused` for the host and for a synthetic participant. A stale generation returns `stale_transport`. Over either rate returns `chat_rate_limited` and does not append. A new user-rate field past the cap returns `chat_busy` and does not evict an existing field. A message past the retention cap drops the oldest. History then sets `retentionGap` for a cursor the list no longer holds.
4. `history.lua` returns one consistent page in ascending sequence, plus `paused`, `oldestSequence`, and `latestSequence`. `setPaused.lua` requires a connected host at the current generation and writes the flag. `delete` removes the chat keys and is safe to call twice.
5. Copy `chat/scripts/*.lua` in `nest-cli.json`. Extend the artifact check to compare those source and dist files, and construct the chat repository the way it constructs `LiveRepository`. Leave the live-script assertion at 14.

**Verification:**

```powershell
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

Missing Redis leaves this slice unverified and named.

**Done when:** The script tests pass and the slice is committed.

**Verification result (2026-11-04):** `pnpm --filter @stageflow/api test` passed against Redis (205 tests), `pnpm typecheck` passed, and `pnpm lint` passed. Eleven chat repository tests cover script cache fallback, concurrent ordering and duplicate retries, sender identity, bounded dedup and history, pause, stale transports, rate windows, user-rate capacity, TTL refresh, and repeated deletion. Tests use isolated `sf:itest:*` keys, injected time, and small limits. The API build and `node scripts/check-artifacts.mjs --api` passed: fourteen live scripts and three independent chat scripts match source, and `liveKeys` still has nine entries. No browser or physical observation is claimed.

**Handoff:** The gateway has no chat events. Room shutdown does not call `delete` yet.

## 4. V2P4-C03 — Authorize and isolate

**Status:** committed\
**Proposed commit message:** `feat(api-live): authorize chat without touching the stage`\
**Actual commit:** `712f7f9fb8bdfd78d3a6f17b2916b53ab4c5b9fd`

**Why:** A stored script that the socket cannot call, or that shares the stage queue, does not meet the room contract. Covers CHAT-03 at the gateway and the server half of CHAT-04.

**Depends on:** V2P4-C02. `validateBinding` and `finishShutdown` stay the membership authorities.

**Files:**

- `apps/api/src/chat/chat.service.ts`
- `apps/api/src/chat/chat.service.test.ts`
- `apps/api/src/live/live.module.ts`
- `apps/api/src/live/signaling.gateway.ts`
- `apps/api/src/live/signaling.gateway.test.ts`
- `apps/api/src/live/signaling.messages.ts`
- `apps/api/src/live/live.service.ts`
- `apps/api/src/live/live.service.test.ts`
- `packages/shared/src/signaling.ts`
- `scripts/smoke-live.mjs`

**Implementation:**

1. Add `chat:send`, `chat:history`, and `chat:set-paused` with acks. Add server events `chat:message` and `chat:paused`. Map `chat_invalid`, `chat_paused`, `chat_rate_limited`, and `chat_busy` to stable sentences. Reuse `stale_transport`, `not_host`, `invalid_payload`, and `not_joined`.
2. Give chat its own `SerializedOperations` instance and queue key. Cap waiting work at 32 per room. A full chat queue returns `chat_busy`. Do not enqueue chat on the stage queue. A test fills the chat queue and still completes `room:leave`.
3. On send and pause, require the socket's bound room and participant. The script result is authoritative. Publish `chat:message` or `chat:paused` only after the script commits, and do not put messages into `room:state`. History is an ack to the caller.
4. Call chat `delete` from `finishShutdown` after `deleteRoom`. A second delete succeeds. Host leave and host expiry both reach that path. A chat delete error uses the existing shutdown retry and does not mark a broadcast `READY`.
5. Chat events still pass through the socket event budget. They do not use the leave bypass. This slice does not render a panel and does not make a demo emit text.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** The gateway, pause, and queue-isolation tests pass and the slice is committed.

**Verification result (2026-11-04):** `pnpm --filter @stageflow/shared test` passed (262 tests), `pnpm --filter @stageflow/api test` passed against Redis (219 tests), `pnpm typecheck` passed, and `pnpm lint` passed. Ten chat service tests plus gateway and shutdown regressions cover authorization, script authority, delayed publication, stable failures, event-budget accounting, and one running chat operation with 32 waiting while room leave completes. Host leave and host expiry retry failed chat deletion before notifying; interrupted broadcast status stays `FAILED`. The API build, `node scripts/check-artifacts.mjs --api`, and `pnpm smoke:live` passed. The isolated real Socket.IO/Redis smoke covers host/attendee delivery, history, duplicate ack, pause, forged payloads, unchanged stage revision, and chat key cleanup. CHAT-03 and the server half of CHAT-04 are verified. Client/browser acceptance and the earlier browser, playback, physical, and native-picker gaps remain open.

**Handoff:** A client can call the events. The room page still has no composer.

## 5. V2P4-C04 — Room panel

**Status:** committed\
**Proposed commit message:** `feat(web-room): show room chat beside the stage`\
**Actual commit:** `dd993548c7472f71ad99e7e15fb70d2529943cad`

**Why:** The server can store a line that nobody in the room can see or answer. Covers the client half of CHAT-01 and CHAT-04.

**Depends on:** V2P4-C03. The demo engine stays free of generated lines.

**Files:**

- `apps/web/src/features/chat/chat-session.ts`
- `apps/web/src/features/chat/chat-session.test.ts`
- `apps/web/src/features/chat/chat-panel.tsx`
- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/services/signaling.ts`
- `apps/web/src/features/live/components/live-room.tsx`
- `apps/web/src/app/entry-graph.test.ts`
- `apps/web/src/pages/RoomPage.tsx` (keep the live view mounted after room end)
- Adjacent signaling, room-session, and demo-peer tests

**Implementation:**

1. Own the transcript in a chat session the room session constructs. The panel renders that state and does not touch the socket. Fetch history after join. Ignore a live sequence at or below the applied history. Fetch a hole once. Show `Earlier messages are no longer available.` when `retentionGap` is set.
2. Show the panel for `joined`, `recovering`, and a page that already has lines after room end. Hide it on the green room before join. Recovering cannot send. Resume marks in-flight sends failed, then fetches history, and does not call send for those request ids.
3. The composer is a labeled textarea and a Send button. Enter sends. Shift+Enter inserts a newline. At most 5 sends wait for an ack. Retry uses the same request id. Render each line as text. Do not move focus when a line arrives. Away from the latest line, show a button with the new-message count.
4. The host's pause control calls `chat:set-paused`. Everyone sees `The host paused chat.` The panel shows `Chat is live. It is not synced to the delayed video.` Room end disables the composer, keeps the lines, and shows `This room has ended. Chat is closed.`
5. Keep the home page free of the panel and of the letters `hls`. The demo engine does not send chat.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
rg -n "hls" apps/web/src/pages/HomePage.tsx
```

The search prints nothing.

Browser, with the local API, one host window, and one attendee window:

1. Ava sends a line. Sam sees it once, with Ava's name and host role. Sam sends a question. Ava sees it after her line.
2. Ava pauses. Sam's send fails and both panels show the pause sentence. Ava resumes chat. Sam sends again.
3. Interrupt Sam's socket and resume within grace. The accepted question appears once. A line that was still in flight is marked not sent and is not sent again until Retry.
4. End the room. Both composers close. The lines already on the page remain. The mesh error paths are unchanged: a `chat_busy` result does not show the room-reset sentence.
5. Confirm the attendee panel includes the delayed-video sentence and that joining did not ask for a camera.

If no browser is available, leave this pass unverified. A synthetic device does not close P3-A03 or P3-A06.

**Done when:** The session tests pass, the browser script has a recorded result or an explicit unverified gap, and the slice is committed.

**Verification result (2026-11-04):** `pnpm --filter @stageflow/web test` passed (306 tests), shared tests passed (262), API tests passed against Redis (219), `pnpm typecheck` passed, and `pnpm lint` passed. The web build, web artifact check, and formatting check for the slice files passed. The home-page `hls` search printed nothing. Fourteen chat-session tests cover join history, sequence deduplication, one gap fetch with bounded older pages, retention gaps, five pending sends, preserved drafts, pause races, stale acknowledgements, explicit same-id retry, and room-end retention. Signaling and room-session regressions cover early chat outside the media signaling queue, membership gating, history after resume, stale socket callbacks, and a chat-busy rejection while the stage and an active recorder remain running. The panel renders text, preserves focus and scroll, and keeps the ended transcript mounted.

**Browser result (2026-11-04):** Two isolated Chrome headless contexts ran the room page against the real local Socket.IO gateway, chat/live services, and Redis with only `sf:itest:*` keys. The catalog and guest repository were in-memory fixtures; host capture used synthetic devices. Ava's host line and Sam's attendee question appeared once in matching order with their names and roles. A send held across host pause failed; both panels showed the pause sentence, and unpause accepted a new line. A transport interruption refetched history within grace, marked the unacknowledged send failed, and made no automatic resend; Retry reused its request id and kept one accepted line. Enter sent, Shift+Enter inserted a newline, HTML and URLs stayed plain text, and an off-bottom arrival preserved focus and scroll with a polite new-message button. `chat_busy` stayed on chat while room controls remained available. Host leave closed both composers, retained both lists, and deleted the chat keys. Sam made zero capture requests, and the delayed-video sentence was present. This verifies CHAT-01 and the chat UI portion of CHAT-04. Full API/PostgreSQL catalog, multi-peer media, live broadcast/playback, physical P3-A03/P3-A05/P3-A06, native-picker, and the earlier V2 browser/playback gaps remain open.

**Handoff:** The README still has no room-chat limits.

## 6. V2P4-C05 — README

**Status:** verified\
**Proposed commit message:** `docs(readme): state the room chat limits`\
**Actual commit:**

**Why:** The product README does not yet tell a host what chat remembers, what pause does, or that the log is not the delayed video.

**Depends on:** V2P4-C04.

**Files:**

- `README.md`
- `plans/phase4.md`
- `plans/phase4/guide.md`
- `plans/README.md`
- `MASTER_PLAN_V2.md`

**Implementation:**

1. Replace the sentence that says room chat is not implemented. State that a connected host, speaker, and attendee share one plain-text channel.
2. State the 1,000-character and 4,000-byte bounds, the 500-message retention, the 50- and 100-line pages, and the 10-per-10-seconds and 100-per-10-seconds rates.
3. State that the host pause blocks everyone, that resume of the socket refetches history and does not send an uncertain line, and that room end keeps the lines on the page and stores none of them in the catalog.
4. State that chat is live and is not synced to the delayed video, and that a chat failure leaves the stage and the broadcast up.
5. Keep P3-A03, P3-A05, P3-A06, and any unverified V2-P1, V2-P2, V2-P3, or V2-P4 browser check explicit. Do not describe accounts, a replay transcript, or `restartIce` as present.
6. Record each slice hash in this guide. Set this phase's status from the verification that actually ran.

**Verification:**

Read the edited README against phase Section 5. `pnpm exec prettier --check README.md plans/phase4.md plans/phase4/guide.md plans/README.md MASTER_PLAN_V2.md` passes.

**Done when:** The README matches the shipped chat behavior and this guide names every slice hash.

**Verification result (2026-11-04):** Reviewed the README against phase Section 5 and the shipped shared constants, Redis accept/pause scripts, and client session/panel. `pnpm exec prettier --check README.md plans/phase4.md plans/phase4/guide.md plans/README.md MASTER_PLAN_V2.md` and `pnpm format:check` passed. The README documents plain-text room membership, 1,000 UTF-16 code units and 4,000 bytes, 500-message retention and 24-hour idle TTL, 50/100-message history pages, 10-per-participant and 100-per-room accepts per 10 seconds, five pending sends, bounded same-id retry, capacity/queue limits, host pause, resume without automatic resend, current-page retention after room end, ephemeral storage, failure isolation, and the live/delayed-video sentence. The API Lua-asset description now matches fourteen live scripts plus three chat scripts. C04's hash and recorded runtime evidence carry forward; this documentation-only slice uses the repository's documentation formatting gate and adds no runtime tests or browser observation. CHAT-01 through CHAT-03 retain their verified scope; CHAT-04 and all earlier physical/native-picker and V2 browser/playback/FFmpeg gaps remain open.

**Implementation gap:** Master Section 9.1 calls for a visible server timestamp. The server stores `ChatMessage.sentAt`, while the panel currently renders name, role, and text without time. The README, phase contract, plan index, and master status now identify this as missing implementation. This documentation slice does not waive or implement that requirement.

**Handoff:** V2-P5 has not been written. Do not add the combined acceptance pass in this commit.
