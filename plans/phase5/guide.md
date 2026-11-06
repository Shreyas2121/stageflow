# Guide — V3 Phase 5, commit by commit

**Status:** in progress. V3P5-C01 is committed and C02 is verified. The release broadcast smoke remains unverified because `ffmpeg` is absent from `PATH`. C03 through C06 remain planned.\
**Last updated:** 2026-11-06.\
**Phase contract:** [../phase5.md](../phase5.md).\
**Product authority:** [MASTER_PLAN_V3.md](../../MASTER_PLAN_V3.md) version `3.0.0-draft.6`. Identity, Google, replay lifecycle, and scheduling stay as shipped in [../phase1.md](../phase1.md), [../phase2.md](../phase2.md), [../phase3.md](../phase3.md), and [../phase4.md](../phase4.md). Unchanged V2 rules stay in [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md). Unchanged V1 rules stay in [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.9`.\
**Deliverable:** Connected members can ask and upvote, the host can feature one question, and a webinar that is already drawing frames burns that question into the 1280×720 canvas, in six commits. This is the only V3 Phase 5 guide. Its commit ids are not the V1 Phase 5 commits in [../V1/phase5/guide.md](../V1/phase5/guide.md) or the V2 Phase 5 commits in [../V2/phase5/guide.md](../V2/phase5/guide.md).

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `23635d32ab7c`. Recheck the worktree.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run V3P5-C01 through V3P5-C06 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing.
4. After the focused commands, inspect `pnpm check:affected --plan --files <changed-paths>` and run the checks it selects.
5. After verification, commit that slice under V1 master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(v3-phase5): record the final slice hash`.
6. QA3-01 and QA3-02 use real Redis under an owned `sf:itest:` prefix. Delete that prefix's Q&A keys in `afterAll`. Do not `FLUSHDB` and do not clear a developer namespace.
7. A missing browser leaves the browser halves unverified and named. A missing `ffmpeg` on `PATH` leaves the played-HLS half of QA3-03 unverified and named. Neither gap authorizes a canvas mock to stand in for the played file, and neither authorizes skipping the unit checks.
8. Do not write `plans/phase6.md`.

Keep guest create, register, login, promotion, Google sign-in, replay visibility, deletion, scheduling, waiting, demo peers, the mesh, reconnect, chat, and the broadcast pipeline.

### 1.1 Commit index

| Order | ID       | Proposed message                                                 | Acceptance                   |
| ----- | -------- | ---------------------------------------------------------------- | ---------------------------- |
| 1     | V3P5-C01 | `feat(shared): add question bounds`                              | QA3-01 parsers               |
| 2     | V3P5-C02 | `feat(api-qa): accept a question and one vote`                   | QA3-01 server, QA3-04 server |
| 3     | V3P5-C03 | `feat(api-qa): let the host feature or dismiss a question`       | QA3-02                       |
| 4     | V3P5-C04 | `feat(web-room): show the question list and host banner`         | QA3-01 and QA3-02 browser    |
| 5     | V3P5-C05 | `feat(web-broadcast): paint the featured question on the canvas` | QA3-03, QA3-04 paint         |
| 6     | V3P5-C06 | `docs(readme): describe moderated questions`                     | README limits                |

### 1.2 Files to inspect before editing

- `packages/shared/src/limits.ts`, `chat.ts`, `signaling.ts`, `stage.ts`, and `index.ts`
- `apps/api/src/chat/chat.repository.ts`, `chat.service.ts`, and `scripts/accept.lua`
- `apps/api/src/chat/chat.repository.test.ts` and `chat.service.test.ts`
- `apps/api/src/live/live.keys.ts`, `live.service.ts`, `live.module.ts`, and `live.connection.ts`
- `apps/api/src/live/signaling.gateway.ts` and `signaling.messages.ts`
- `apps/api/src/live/scripts/common.lua` and `tryBeginBroadcast.lua`
- `apps/web/src/features/chat/chat-panel.tsx`
- `apps/web/src/features/live/components/live-room.tsx`
- `apps/web/src/features/live/services/signaling.ts` and `room-session.ts`
- `apps/web/src/features/broadcast/services/stage-recorder.ts`, `stage-recorder.test.ts`, and `broadcast-session.ts`
- `apps/web/src/app/entry-graph.test.ts`
- `README.md`

## 2. V3P5-C01 — Question bounds

**Status:** committed\
**Proposed commit message:** `feat(shared): add question bounds`\
**Actual commit:** `8a807c3`

**Why:** Submit and the panel need one parser and one set of numbers before Redis accepts a question. Covers the parse half of QA3-01.

**Depends on:** The current shared chat and signaling contracts.

**Files:**

- `packages/shared/src/limits.ts`
- `packages/shared/src/qa.ts`
- `packages/shared/src/qa.test.ts`
- `packages/shared/src/signaling.ts`
- `packages/shared/src/index.ts`
- `apps/api/src/live/signaling.messages.ts`

**Implementation:**

1. Add the constants from phase Section 5.1. Leave every `CHAT_*` constant at its current value.
2. Add `parseQaSubmit`, `parseQaQuestionId`, and `parseQaSetSubmissions`. Trim first. Reject the wrong length, the byte cap, and ASCII controls with `qa_invalid`. Allow `<b>hi</b>` through as text. Reject any field other than the ones in phase Section 5.4 with `invalid_payload`.
3. Add the Q&A events, acks, `QaQuestion`, `QaFeature`, and `QaState` types to `signaling.ts`. Add the eight `qa_*` codes to `SignalingError` only. Do not add them to `StageError` and do not add a question field to `RoomSnapshot`.
4. Export the new module from `index.ts`. Add the eight sentences from phase Section 5.1 to `signaling.messages.ts` in the same slice. `Record<SignalingError, string>` must stay complete so API typecheck passes. Do not add Redis yet.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/shared typecheck
pnpm --filter @stageflow/api typecheck
```

Then `pnpm typecheck` and `pnpm lint` if the affected-check plan selects them.

**Done when:** The parser tests cover trim, 200 code units, 1,000 bytes, a control character, angle brackets, a bad question id, and a forged author field. Chat parser tests still pass. `Actual commit` is recorded after the slice commit.

**Verification record (2026-11-06):**

- Added all twelve Q&A limits, strict submit/id/submission-lock parsers, the board/feature/question/ack and event types, exports, and all eight API error sentences. Chat constants, `StageError`, and `RoomSnapshot` are unchanged. No Redis or UI implementation was added.
- `pnpm --filter @stageflow/shared test` passed: 12 files, 454 tests, including the new Q&A cases and existing chat parsers. Shared and API package typechecks passed.
- Parser cases cover trim before validation, UTF-16 boundaries with BMP and astral text, all 33 ASCII controls, literal `<b>hi</b>`, decimal id bounds, booleans, malformed bodies, and forged identity fields. A valid 200-code-unit string cannot reach 1,000 UTF-8 bytes (at most 600); the explicit byte check remains, and tests reject 1,000-byte and over-budget inputs that also exceed the code-unit cap.
- `pnpm check:affected --plan --files packages/shared/AGENTS.md packages/shared/src/limits.ts packages/shared/src/qa.ts packages/shared/src/qa.test.ts packages/shared/src/signaling.ts packages/shared/src/index.ts apps/api/src/live/signaling.messages.ts` selected `check:release`.
- `pnpm check:release` passed tooling (49 tests), all workspace typechecks and lint, shared (454), web (499), and API (470) tests, both production builds, repository formatting, artifact checks, and the owned-fixture live smoke. It then failed at the final `smoke:broadcast` command with `spawn ffmpeg ENOENT`: `ffmpeg` is absent from `PATH`. The broadcast smoke is unverified; the release gate is not fully passed. Vite reported its existing large-chunk warning.
- QA3-01 has parser evidence only. Its server/browser halves and QA3-02 through QA3-04 remain planned. No browser, canvas, or played-HLS acceptance was claimed; existing V1/V2 gaps remain open.

## 3. V3P5-C02 — Accept a question and one vote

**Status:** verified; ready for slice commit\
**Proposed commit message:** `feat(api-qa): accept a question and one vote`\
**Actual commit:**

**Why:** The board has to exist, ignore forged names, and enforce the cap and rates before the host can moderate it. Covers the server half of QA3-01 and the server half of QA3-04.

**Depends on:** V3P5-C01.

**Files:**

- `apps/api/src/qa/qa.repository.ts`
- `apps/api/src/qa/qa.repository.test.ts`
- `apps/api/src/qa/qa.service.ts`
- `apps/api/src/qa/qa.service.test.ts`
- `apps/api/src/qa/scripts/submit.lua`
- `apps/api/src/qa/scripts/vote.lua`
- `apps/api/src/qa/scripts/state.lua`
- `apps/api/src/qa/scripts/delete.lua`
- `apps/api/nest-cli.json` (copy the new Lua assets)
- `apps/api/AGENTS.md` (Q&A owner navigation)
- `apps/api/src/live/live.module.ts`
- `apps/api/src/live/live.service.ts`
- `apps/api/src/live/live.service.test.ts`
- `apps/api/src/live/live.integration.test.ts` (scope the existing Redis monitor to its owned room)
- `apps/api/src/live/signaling.gateway.ts`
- `apps/api/src/live/signaling.gateway.test.ts`
- `apps/api/src/live/signaling.messages.ts`
- `scripts/check-artifacts.mjs` (verify compiled Q&A Lua)
- `scripts/smoke-live.mjs` (supply the new gateway dependency and exercise Q&A over sockets)

**Implementation:**

1. Add `qaKeys` and the four scripts from phase Section 5.2. Follow `accept.lua`: no `common.lua`, participants as the extra key, the connected-binding check, and copy `displayName` from the hash. Refuse `WAITING` and `isSyntheticBot` with `qa_not_allowed`.
2. Submit in the order membership, role, closed, full, rate, then `INCR` and `HSET`. Vote checks the question, then an existing `SADD` member, then rate. A repeat vote returns the current board and does not increment. Expire the fixed keys and the vote sets for 86,400 seconds. Do not expire or delete the participants key.
3. `delete.lua` deletes the fixed keys and each vote set named by the hash. Call it from `finishShutdown` immediately after `chat.delete`. Leave `deleteRoom` and `liveKeys` unchanged. `clearPresence` already matches `:qa:` keys under `room:*`.
4. Wire `QaRepository` and `QaService` in `LiveModule` the way chat is wired. `LiveService` receives the repository delete handle. `QaService` uses its own `SerializedOperations` on `room:{roomId}:qa` with `QA_MAX_QUEUED_OPERATIONS`. Add `authorizeQa` beside `authorizeChat`, returning `qa_busy` when Redis is not ready. Do not call `authorizeChat` from Q&A.
5. Handle `qa:submit`, `qa:vote`, and `qa:state` on the gateway. Emit `qa:state` to the room after a successful submit or vote. The ack includes `votedQuestionIds` for the caller. The room event does not.
6. A repository throw or a full queue returns `qa_busy`. The test shows the stage snapshot is unchanged, leave still completes, and broadcast stop is not called.

**Verification:**

```powershell
pnpm --filter @stageflow/api test -- src/qa/qa.repository.test.ts src/qa/qa.service.test.ts src/chat/chat.repository.test.ts src/chat/chat.service.test.ts
pnpm --filter @stageflow/shared test
```

Redis tests require `REDIS_URL` and an owned prefix, as `chat.repository.test.ts` does. Assert the ten `liveKeys` are not written by a question command. Then run typecheck, lint, and the affected-check selection.

**Done when:** Two seeded members can submit and vote on real Redis. A forged author is ignored. Question 101, the rate caps, a waiter, and a synthetic speaker fail as specified. Chat tests pass without a behavior change. A thrown repository does not drop the stage or the broadcast. `Actual commit` is recorded after the slice commit.

**Verification record (2026-11-06):**

- Added the independent repository and four atomic Lua scripts, `qaKeys`, the 32-waiting service queue, `authorizeQa`, and `qa:submit`, `qa:vote`, and `qa:state` handlers. Mutations publish the public board; only the caller's ack includes `votedQuestionIds`. The eight error messages were already complete in C01. Host moderation, UI, and canvas work remain planned.
- Real Redis tests use unique owned `sf:itest:` prefixes and delete their Q&A keys and fixture live/chat keys in `afterAll`. Twelve repository tests cover NOSCRIPT-only retry, empty state without writes, server identity, concurrent submit and repeat votes, all numeric caps, eligibility and transport bindings, rate-hash capacity/reclamation, resumed membership buckets, ordering including ids above JavaScript's safe integer range, feature projection, TTL refresh, and scoped/idempotent deletion. DUMP comparisons and participant TTL assertions show Q&A leaves all ten live keys and chat keys alone.
- Fourteen service tests cover publication order, private vote acks, server bounds/time, all store failures, Redis readiness/throws, stale/queued bindings, pre-start hosts, waiter/demo rejection, and ended rooms. A thrown repository and a full queue leave the stage snapshot and active broadcast unchanged; guest leave completes without calling broadcast stop. Gateway tests verify strict fields, room binding, empty-state payloads and event budgets. Shutdown tests verify deletion immediately after chat and retry before transport end.
- `pnpm --filter @stageflow/api test -- src/qa/qa.repository.test.ts src/qa/qa.service.test.ts src/chat/chat.repository.test.ts src/chat/chat.service.test.ts src/live/live.service.test.ts src/live/signaling.gateway.test.ts`, `pnpm --filter @stageflow/shared test`, `pnpm typecheck`, and `pnpm lint` passed. Additional ordering/resume coverage was then included in the full API run.
- The affected-check plan for all changed code/config/tooling selected `check:release`. Its tooling (49), typechecks, lint, shared (454) and web (499) tests passed. Its first full API run exposed a pre-existing global Redis MONITOR assertion that included another fixture's writes. The assertion now filters to its own room prefix. After that fix, `pnpm --filter @stageflow/api test` passed all 35 files / 498 tests, including the concurrent Redis suites. Final API typecheck/lint were rerun for that test edit.
- The remaining selected commands were run explicitly: both package builds, `pnpm format:check`, `pnpm check:artifacts`, and `pnpm smoke:live` passed. Nest copies all four Q&A Lua files and artifacts verify byte equality with source. The compiled live smoke uses real sockets and Redis to check trimmed submit, membership author, one vote, duplicate vote, caller-only votes, strict forged-author refusal, unchanged stage revision, and room-end cleanup. This is server evidence, not browser UI evidence.
- `pnpm smoke:broadcast` failed before encoder verification with `spawn ffmpeg ENOENT`; FFmpeg is absent from `PATH`. The selected release gate is not fully passed. Vite retained its existing large-chunk warning. QA3-01 now has parser/server evidence and its browser half remains planned. QA3-04 has chat/server failure-isolation evidence; its paint half remains planned. No existing V1/V2 acceptance gaps were closed.

## 4. V3P5-C03 — Host feature and dismiss

**Status:** planned\
**Proposed commit message:** `feat(api-qa): let the host feature or dismiss a question`\
**Actual commit:**

**Why:** The host has to be able to close the board and choose the one question the canvas will later paint. Covers QA3-02 and the server half of the meeting-broadcast rule.

**Depends on:** V3P5-C02.

**Files:**

- `apps/api/src/qa/scripts/dismiss.lua`
- `apps/api/src/qa/scripts/feature.lua`
- `apps/api/src/qa/scripts/clear-feature.lua`
- `apps/api/src/qa/scripts/set-submissions.lua`
- `apps/api/src/qa/qa.repository.ts`
- `apps/api/src/qa/qa.service.ts`
- `apps/api/src/qa/qa.repository.test.ts`
- `apps/api/src/qa/qa.service.test.ts`
- `apps/api/src/live/signaling.gateway.ts`

**Implementation:**

1. Dismiss, feature, clear, and set-submissions follow phase Section 5.3. Non-hosts receive `not_host`. Dismiss deletes the question and its vote set and clears the feature when the ids match. Featuring a second id replaces the first. Clear succeeds when the key is already absent. Closing writes `0` and leaves the questions in place.
2. A missing id returns `qa_missing` and writes nothing. Closed submissions still allow these four commands and still reject submit with `qa_closed`, including a submit from the host.
3. The feature service method writes Redis and returns. It does not call `tryBeginBroadcast`, `BroadcastsService.start`, or `startBroadcast`. A meeting `broadcast:start` still returns `broadcast_not_available`.
4. Emit `qa:state` after each success. The featured object is `{ questionId, text, authorName }` or null.

**Verification:**

```powershell
pnpm --filter @stageflow/api test -- src/qa/qa.repository.test.ts src/qa/qa.service.test.ts src/live/live.service.test.ts
```

Then typecheck, lint, and the affected-check selection. Include a concurrent double feature if the Redis harness can issue two scripts; the stored featured id is one of the two questions, never both.

**Done when:** Host moderation matches the matrix for QA3-02. A speaker, an attendee, and a waiter cannot moderate. Featuring a meeting question does not create a broadcast. `Actual commit` is recorded after the slice commit.

## 5. V3P5-C04 — Question list and host banner

**Status:** planned\
**Proposed commit message:** `feat(web-room): show the question list and host banner`\
**Actual commit:**

**Why:** Members need the board, and the host needs the same words locally, before any pixel is recorded. This slice does not close QA3-03.

**Depends on:** V3P5-C03.

**Files:**

- `apps/web/src/features/qa/qa-panel.tsx`
- `apps/web/src/features/qa/qa-session.ts`
- `apps/web/src/features/qa/qa-panel.test.tsx`
- `apps/web/src/features/qa/qa-session.test.ts`
- `apps/web/src/features/live/services/signaling.ts`
- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/components/live-room.tsx`
- `apps/web/src/app/entry-graph.test.ts`

**Implementation:**

1. Add ack helpers beside `chatSend`, with the same 8 second timeout. Subscribe to `qa:state`. Request state after join.
2. Mount the panel from `live-room.tsx` next to `ChatPanel` when the participant is in the room and the role is `HOST`, `SPEAKER`, or `ATTENDEE`. Omit it for `WAITING` and before join. The pre-start host still sees it. The panel receives a session object. It does not import the recorder, the peer manager, or `hls.js`.
3. Render text nodes only. The webinar and meeting sentences are the ones in phase Section 5.5. Host controls use `self.role === 'HOST'`, not the registered-account flag. The banner sits above the mesh and shows the featured question and author. The row marker is `Featured`. Upvote shows the count. Disable Ask while the ack is in flight and while submissions are closed. After end, keep the list and show `This room has ended. Questions are closed.`
4. Extend the home entry-graph test so home, the account panel, and the Google return page do not mention the Q&A panel. Leave the chat delay sentence unchanged.
5. Exercise a two-window room when a browser is available: submit, one upvote, a second upvote that does not raise the count, dismiss, close, feature, and clear. Confirm a waiting membership does not render the panel. Record the browser and say that this pass does not play HLS.

**Verification:**

```powershell
pnpm --filter @stageflow/web test -- src/features/qa src/app/entry-graph.test.ts src/features/chat
```

Then typecheck, lint, and the affected-check selection. Browser verification clicks the controls. A screenshot of the panel is not the result.

**Done when:** The list, the banner, and the waiting omission match Section 5.5. Home still excludes live, chat, playback, and Q&A. QA3-03 remains planned. `Actual commit` is recorded after the slice commit.

## 6. V3P5-C05 — Canvas lower-third

**Status:** planned\
**Proposed commit message:** `feat(web-broadcast): paint the featured question on the canvas`\
**Actual commit:**

**Why:** The replay has to contain the question. The sidebar is live and the HLS is behind it. Covers QA3-03 and the paint half of QA3-04.

**Depends on:** V3P5-C04.

**Files:**

- `apps/web/src/features/broadcast/services/stage-recorder.ts`
- `apps/web/src/features/broadcast/services/stage-recorder.test.ts`
- `apps/web/src/features/broadcast/services/broadcast-session.ts`
- `apps/web/src/features/live/services/room-session.ts`
- `apps/web/src/features/live/services/room-session.test.ts`

**Implementation:**

1. Add `setLowerThird` to `BroadcastRecorder` and forward it from `BroadcastSession`. The argument is `{ text, authorName } | null`. Do not import `features/live` or `features/qa` from `features/broadcast`.
2. In `paint`, draw the existing background and `placeStageFrames` first. Then, when a lower-third is set, paint the band from phase Section 5.5 with `fillText` only. Truncate with `…` using `measureText`. Catch a measurement throw per line and continue. Do not accept a vote count.
3. `room-session` supplies the current feature when it creates the webinar recorder and when the feature changes while that recorder is drawing. It does not call `setLowerThird` for a meeting. Featuring does not call broadcast start. Meeting start stays rejected.
4. Keep the existing rectangle tests green: one full frame, two columns, a 2×2 grid, and a screen share that replaces the other frames. Add a test that those `drawImage` rectangles are the same when a lower-third is set, and that the recorded text calls are the author and the truncated question.
5. When `ffmpeg` is on `PATH`, start a disposable webinar broadcast, feature a question, and play the HLS far enough to see that question and author. Use an owned data directory. Do not point it at `apps/api/data` and do not run `pnpm smoke:broadcast` against the developer database. Record the command and what was visible. If `ffmpeg` is absent, write that the played-HLS half is unverified. Do not mark MEDIA-04 or REC-05 passed.
6. A thrown `measureText` in the unit test leaves the recorder drawing later frames. Together with the C02 service test, that is the QA3-04 isolation evidence.

**Verification:**

```powershell
pnpm --filter @stageflow/web test -- src/features/broadcast/services/stage-recorder.test.ts src/features/live/services/room-session.test.ts
```

Then typecheck, lint, and the affected-check selection. Browser or FFmpeg evidence is recorded in this guide when it is run.

**Done when:** The unit test shows unchanged tile rectangles and the two text lines. The meeting path does not paint and does not start a broadcast. The played-HLS result is either observed or named unverified. `Actual commit` is recorded after the slice commit.

## 7. V3P5-C06 — README

**Status:** planned\
**Proposed commit message:** `docs(readme): describe moderated questions`\
**Actual commit:**

**Why:** The README has to say who can ask, that the webinar frame carries the featured question, and that a meeting does not gain a broadcast.

**Depends on:** V3P5-C05.

**Files:**

- `README.md`
- `plans/phase5.md`
- `plans/phase5/guide.md`
- `plans/README.md`

**Implementation:**

1. Say that connected hosts, speakers, and attendees can ask a plain-text question and upvote once, that waiters and demo peers cannot, and that the host can dismiss, close, feature, and clear.
2. Say that the featured question and author are drawn on the webinar canvas and travel with the current HLS, that the sidebar is live and ahead of that video, and that upvote counts stay in the sidebar. Say that a meeting keeps the list and the banner and still cannot start a broadcast. Say that questions are Redis state and are not a replay transcript.
3. Point this behavior at `plans/phase5.md` and this guide. Leave the phase 1, phase 2, phase 3, and phase 4 links in place.
4. Record the C04 browser result and the C05 canvas and FFmpeg result, including a missing browser or a missing `ffmpeg`. Do not mark open V1 or V2 ids passed.

**Verification:**

```powershell
pnpm exec prettier --check README.md plans/phase5.md plans/phase5/guide.md plans/README.md
```

Read the edited README against phase Sections 5 and 6.

**Done when:** The README matches the Q&A limits and this guide records C01 through C05. C06's hash is recorded in the follow-up `docs(v3-phase5): record the final slice hash`.

**Handoff:** V3 phase 6 is local acceptance. Do not write `plans/phase6.md` until that phase is requested.
