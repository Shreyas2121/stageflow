# Guide — V3 Phase 4, commit by commit

**Status:** complete. C01 through C06 are committed and the final slice hash is recorded.\
**Last updated:** 2026-11-06.\
**Phase contract:** [../phase4.md](../phase4.md).\
**Product authority:** [MASTER_PLAN_V3.md](../../MASTER_PLAN_V3.md) version `3.0.0-draft.5`. Identity and replay lifecycle stay as shipped in [../phase1.md](../phase1.md), [../phase2.md](../phase2.md), and [../phase3.md](../phase3.md). Unchanged V2 rules stay in [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md). Unchanged V1 rules stay in [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.9`.\
**Deliverable:** A registered host can schedule a room, hold early joiners off stage, and start or cancel it, in six commits. This is the only V3 Phase 4 guide. Its commit ids are not the V1 Phase 4 commits in [../V1/phase4/guide.md](../V1/phase4/guide.md) or the V2 Phase 4 commits in [../V2/phase4/guide.md](../V2/phase4/guide.md).

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `ed93ee7a2463`. Recheck the worktree.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run V3P4-C01 through V3P4-C06 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing.
4. After the focused commands, inspect `pnpm check:affected --plan --files <changed-paths>` and run the checks it selects.
5. After verification, commit that slice under V1 master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(v3-phase4): record the final slice hash`.
6. SCH-03 uses real Redis. Do not replace that race with a mock of the stage set.
7. A missing browser leaves the browser halves of SCH-01, SCH-02, SCH-04, and SCH-05 unverified and named. A missing disposable Postgres leaves the migration run unverified. Neither gap authorizes skipping the unit checks or deleting developer data.

Keep guest create, register, login, promotion, Google sign-in, replay visibility, deletion, demo peers after Start, the mesh, reconnect for seated members, chat, and the broadcast pipeline. Do not add Q&A.

### 1.1 Commit index

| Order | ID       | Proposed message                                            | Acceptance             |
| ----- | -------- | ----------------------------------------------------------- | ---------------------- |
| 1     | V3P4-C01 | `feat(api-rooms): record scheduled fields on a room`        | SCH-01 storage         |
| 2     | V3P4-C02 | `feat(api-rooms): let a host schedule a room`               | SCH-01 create          |
| 3     | V3P4-C03 | `feat(api-live): hold early joiners off stage`              | SCH-02                 |
| 4     | V3P4-C04 | `feat(api-live): start, admit, and cancel a scheduled room` | SCH-03, SCH-04, SCH-05 |
| 5     | V3P4-C05 | `feat(web-room): schedule a room and wait without media`    | SCH-01 through SCH-05  |
| 6     | V3P4-C06 | `docs(readme): describe scheduled rooms and admission`      | README limits          |

### 1.2 Files to inspect before editing

- `packages/shared/src/contracts.ts`, `stage.ts`, `stage.test.ts`, and `signaling.ts`
- `apps/web/src/features/rooms/api.ts`
- `apps/api/src/rooms/room.entity.ts`, `rooms.service.ts`, and `rooms.service.test.ts`
- `apps/api/src/database/data-source.ts`
- `apps/api/src/migrations/1794096000000-AddBroadcastVisibility.ts`
- `scripts/smoke-broadcast.mjs`
- `apps/api/src/live/live.keys.ts`, `live.repository.ts`, `live.service.ts`, and `scripts/common.lua`
- `apps/api/src/live/scripts/join.lua`, `leave.lua`, `promote.lua`, `demote.lua`, `expire.lua`, and `tryBeginBroadcast.lua`
- `apps/api/src/live/signaling.messages.ts` and `signaling.gateway.ts`
- `apps/api/src/chat/chat.repository.test.ts`
- `apps/web/src/pages/HomePage.tsx` and `RoomPage.tsx`
- `apps/web/src/features/live/components/live-room.tsx` and `green-room.tsx`
- `apps/web/src/app/entry-graph.test.ts`
- `README.md`

## 2. V3P4-C01 — Record the schedule fields

**Status:** committed\
**Proposed commit message:** `feat(api-rooms): record scheduled fields on a room`\
**Actual commit:** `5cf63844223af0f03082bdd9570279ea549e05ac`

**Why:** Create and the lobby need a stored status, start instant, and admission flag before either one changes join. Covers the storage half of SCH-01.

**Depends on:** The existing room catalog.

**Files:**

- `packages/shared/src/contracts.ts`
- `packages/shared/src/contracts.test.ts`
- `apps/web/src/features/rooms/api.ts`
- `apps/api/src/migrations/1794182400000-AddRoomSchedule.ts`
- `apps/api/src/database/data-source.ts`
- `apps/api/src/rooms/room.entity.ts`
- `apps/api/src/rooms/rooms.service.ts`
- `scripts/smoke-broadcast.mjs`
- Room fixtures that construct `RoomResponse`

**Implementation:**

1. Add `SCHEDULED` to `RoomStatus`. Add `scheduledStartAt: string | null` and `requireAdmission: boolean` to `RoomResponse`. Parse a start instant with the same `YYYY-MM-DDTHH:mm:ss.sssZ` rule as a broadcast timestamp, including a past instant.
2. Add the column and status check from phase Section 5.1. Register the migration after `AddBroadcastVisibility1794096000000` and append its name to the smoke list. Existing rows stay `LIVE` or `ENDED`.
3. Map both columns on `Room`. `toResponse` includes them. Create still inserts `LIVE`, a null start, and `requireAdmission: false`. Do not accept the new body fields yet.
4. Update `parseRoom` and every in-repo `RoomResponse` fixture. Search for `hostDisplayName`.
5. Tests prove a migrated row and a newly saved immediate room. Create with only `title` and `mode` is unchanged.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

**Done when:** The catalog carries the new fields, and no client can create a `SCHEDULED` room yet.

**C01 verification (2026-11-05):** Shared tests passed (324), API tests passed (429), web tests passed (488), and `pnpm typecheck` and `pnpm lint` passed. The new owned disposable-Postgres fixture migrates legacy `LIVE` and `ENDED` rows, checks null/false defaults, reads a stored past schedule through the catalog, and verifies immediate create still ignores schedule fields. The smoke migration list and both existing migration-list assertions include `AddRoomSchedule1794182400000`. The affected-check plan selected `pnpm check:release`, which passed: all 49 tooling tests, package checks, builds, formatting, artifact checks, and both smokes. Broadcast smoke used the existing temporary FFmpeg 6.0 binary through a process-local `FFMPEG_PATH` override; it applied all seven migrations in its owned disposable database and verified five WebM chunks, two decoded HLS segments, ENDLIST/READY, restart cleanup, and missing-binary behavior. Edited plan links resolve. Initial API/tooling attempts failed while Docker/Postgres/Redis were unavailable; Docker Desktop was started and the API suite then passed. No developer database was migrated. SCH-01 create/browser and SCH-02 through SCH-05 remain planned; physical observations remain open.

## 3. V3P4-C02 — Host scheduling

**Status:** committed\
**Proposed commit message:** `feat(api-rooms): let a host schedule a room`\
**Actual commit:** `d19211bd2d65a2c7b27bad8e14580a24047d243d`

**Why:** The host needs to create the room and share its slug before anyone can wait in it. Covers the create half of SCH-01.

**Depends on:** V3P4-C01.

**Files:**

- `packages/shared/src/contracts.ts`
- `apps/api/src/rooms/rooms.service.ts`
- `apps/api/src/rooms/rooms.service.test.ts`
- The nearest rooms HTTP test

**Implementation:**

1. Add `schedule_not_allowed`, `invalid_schedule`, and `invalid_admission` to `ApiErrorBody['error']`. Add a create-body parser for optional `status`, `scheduledStartAt`, and `requireAdmission`.
2. Apply phase Section 5.1. A guest body with any of those three fields returns 403 and inserts nothing. A registered body that omits them still inserts `LIVE`.
3. Persist `SCHEDULED` only with a valid instant. Persist `requireAdmission` only for a meeting. Do not start the room because the instant is past, and do not add a timer.
4. Tests cover a past instant, a guest body, a webinar with admission, a `LIVE` body that includes a time, and an immediate host create. Include a Google-only host with `isGuest: false` and a null email. Do not call Google.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** A registered host can create `SCHEDULED`, a guest still creates `LIVE`, and the scheduled row does not become `LIVE` by itself.

**C02 verification (2026-11-06):** Shared tests passed (356), focused room service/integration tests passed (23), API tests passed (440), and `pnpm typecheck` and `pnpm lint` passed. Shared parsing covers omitted defaults, field-presence rejection for guests, exact UTC validation including past dates, invalid statuses, and meeting-only boolean admission. Service regressions verify rejected requests never call create/insert. The owned disposable-Postgres room fixture now serves the real controller, JWT guard, session verifier, and error filter on an ephemeral loopback HTTP port. It proves Google-only hosts with null email can schedule past meetings/webinars, request identity fields cannot override the authenticated caller, rejected bodies insert no row, and guest/registered title-mode create stays immediate. This replaces C01's historical ignored-field assertion with the authorized C02 rejection contract. No Google exchange is called and no timer starts a room. The affected-check plan selected `pnpm check:release`, which passed on full rerun: all 49 tooling tests; 356 shared, 440 API, and 488 web tests; typecheck; lint; both builds; formatting; artifact checks; and both smokes. Broadcast smoke used the existing temporary FFmpeg 6.0 binary with a process-local `FFMPEG_PATH` override and an owned disposable database/Redis namespace. Edited plan links resolve. Its initial attempt stopped in the existing cold app-build consumer tooling test on Windows `EPERM` while renaming an owned temporary writer-lock directory (48/49 tooling tests passed). The isolated `node --test --test-name-pattern="cold app-build consumers" scripts/shared-build.test.mjs` rerun passed; no tooling code changed. SCH-01 browser evidence remains planned, C03 through C06 are not implemented, and existing physical observation gaps remain open.

## 4. V3P4-C03 — Off-stage waiting

**Status:** committed\
**Proposed commit message:** `feat(api-live): hold early joiners off stage`\
**Actual commit:** `30f915641ad99df78fa71b36c00552c2f70ff929`

**Why:** Early joiners need a membership the host can see without taking a stage seat or a resume credential. Covers SCH-02.

**Depends on:** V3P4-C02.

**Files:**

- `packages/shared/src/stage.ts`
- `packages/shared/src/stage.test.ts`
- `packages/shared/src/signaling.ts`
- `apps/api/src/live/live.keys.ts`
- `apps/api/src/live/scripts/common.lua`
- `apps/api/src/live/scripts/join.lua`
- `apps/api/src/live/scripts/leave.lua`
- `apps/api/src/live/live.service.ts`
- `apps/api/src/live/live.integration.test.ts`
- `apps/api/src/live/signaling.messages.ts`
- `apps/api/src/chat/chat.repository.test.ts`

**Implementation:**

1. Add role `WAITING` and `waitingParticipantIds` to the pure stage state and the room snapshot. Add `waiting_full` to `StageError`, `SignalingError`, and `signaling.messages.ts`. The reducer and `join.lua` follow phase Section 5.2.
2. Add the waiting key as the tenth `liveKeys` entry. In `common.lua`, read and write `KEYS[10]` the same way the other sets are saved. Keep `local revKey, participantsKey, stageKey, handsKey, endingKey = unpack(KEYS)`. Do not move `KEYS[6]` through `KEYS[9]`. Include the waiting key in `finish` expiry, `clearRoom`, and `deleteRoom`.
3. A `SCHEDULED` non-host join becomes `WAITING` and is not on stage. The host join is `HOST` and is in neither set. Do not store a resume digest for either. `LIVE` admission behavior stays until C04. A `LIVE` meeting still returns `host_not_present` when no host is present.
4. On a `SCHEDULED` room, host leave and waiter leave remove that membership and do not end the room. `disconnect` for those memberships leaves immediately and does not schedule reconnect grace. A `LIVE` host leave still ends the room.
5. Cap the waiting set at 100. Tests use the reducer for order and the real Redis integration for the 101st joiner, a drop, and a rejoin at the back. Assert `liveKeys` length 10 and that index 5 is still the broadcast key. Assert `tryBeginBroadcast.lua` still uses `KEYS[6]`.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** A scheduled joiner is visible in the waiting list, absent from the stage, and gone without grace when the socket drops.

**C03 verification (2026-11-06):** Shared tests passed (359), API tests passed (454), and `pnpm typecheck` and `pnpm lint` passed. Reducer and real Redis scenarios agree on scheduled meeting/webinar membership, arrival-time/id queue ordering, off-stage media normalization/rejection, host leave/drop without ending, waiter drop, and rejoin at the back. Real Redis rejects waiter 101 without writes or TTL refresh, admits a pre-start host even with 100 waiters, and verifies waiting TTL, room-end cleanup, and `deleteRoom`. Service regressions cover disconnect during a committed join and cleanup retries before/after a lost leave reply without creating a suspended reservation. Gateway regressions return no pre-start resume credential; neither host nor waiter stores a digest/deadline. A connected waiter can chat and loses chat authorization on leave. Repository, chat, and artifact checks use ten live keys, retain the broadcast key at index 5, and assert `tryBeginBroadcast.lua` still uses `KEYS[6]`. Existing snapshot fixtures now include the waiting ids. Immediate `LIVE` admission/recovery remains covered by the existing suite. The affected-check plan selected `pnpm check:release`, which passed: all 49 tooling tests; 359 shared, 454 API, and 488 web tests; typecheck; lint; builds; formatting; artifact checks; and both smokes. The broadcast smoke used the existing temporary FFmpeg 6.0 binary via process-local `FFMPEG_PATH`, with owned database/Redis/media fixtures. Edited plan links resolve. SCH-02's browser waiting-panel/no-capture/no-peer-connection observations remain unverified and belong to C05. C04 through C06 and existing physical observation gaps remain open.

## 5. V3P4-C04 — Start, admit, and cancel

**Status:** committed\
**Proposed commit message:** `feat(api-live): start, admit, and cancel a scheduled room`\
**Actual commit:** `9e7b44eeb307e1c7cec892c8bc9c6e4aa6336c2d`

**Why:** The host needs one atomic way to open the stage, admit a chosen waiter, or end the scheduled room. Covers SCH-03, SCH-04, and the server half of SCH-05.

**Depends on:** V3P4-C03. Pass `requireAdmission` on the room object the Lua scripts already receive. Do not import a new cycle between LiveModule and RoomsModule.

**Files:**

- `packages/shared/src/stage.ts`
- `packages/shared/src/signaling.ts`
- `apps/api/src/live/scripts/common.lua`
- `apps/api/src/live/scripts/start.lua`
- `apps/api/src/live/scripts/admit.lua`
- `apps/api/src/live/scripts/removeWaiter.lua`
- `apps/api/src/live/scripts/cancel.lua`
- `apps/api/src/live/scripts/grantResume.lua`
- `apps/api/src/live/scripts/join.lua`, `leave.lua`, `demote.lua`, and `expire.lua`
- `apps/api/src/live/live.repository.ts`
- `apps/api/src/live/live.service.ts`
- `apps/api/src/live/signaling.gateway.ts`
- `apps/api/src/live/signaling.messages.ts`
- `apps/api/src/live/live.integration.test.ts` and adjacent service/gateway regressions
- `apps/api/src/rooms/rooms.service.ts` and `rooms.integration.test.ts`
- `scripts/check-artifacts.mjs`

**Implementation:**

1. Add socket commands for Start, Admit, Remove, and Cancel. Add `already_started`, `not_scheduled`, `not_waiting`, `admission_off`, and `demo_not_ready` to the stage error, the signaling error, and the message table. Use the sentences in phase Section 5.3.
2. The shared reducer owns the seat decision. The Lua scripts mirror it. Meeting admission off fills the oldest waiters up to four, counting every stage id. Meeting admission on seats only the host at Start, and Admit moves one chosen waiter. A full stage leaves that waiter in the set. Webinar Start seats the host and changes every waiter to `ATTENDEE` without a stage seat. Promote still returns `stage_full` at four.
3. Handle the commands inside the existing per-room queue. Start runs the script while Postgres is `SCHEDULED`, publishes `LIVE`, then updates Postgres only where the status is still `SCHEDULED`. A repeated Start does not add a second host seat. Cancel updates Postgres to `ENDED` first, then clears memberships and the waiting key. It does not insert a broadcast.
4. The join, leave, demote, and expire scripts admit the oldest meeting waiter only when admission is off and a seat was actually freed. Suspend keeps the reservation, so it admits nobody. Join seats remaining waiters before a new meeting joiner can take a free seat.
5. Reject a synthetic join unless the room is `LIVE` and the host is on stage. Tests on real Redis cover five early meeting joiners, a suspended seat, two concurrent Admit commands, webinar release, cancel with no broadcast row, and a past `scheduledStartAt` that remains `SCHEDULED`. Preserve recovery after release: issue `room:resume-credential` only after Start or Admit, never to a waiter or pre-start host.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** Start, Admit, and Cancel match phase Section 5.3, and a concurrent fill never leaves five ids in the stage set.

**C04 verification (2026-11-06):** Shared tests passed (363), API tests passed (470), and workspace typecheck and lint passed. Reducer/real-Redis parity covers Start with five early meeting joiners, arrival/id ordering, admission on/off, removal without filling, webinar release, and the four-seat promote limit. Concurrent Admit scripts count a suspended reservation: one takes the last seat, the other returns `stage_full` and keeps its waiter. Leave, demote, expiry, and join fill in Lua; suspension retains its seat. Tests cover a lost Start reply, failed catalog update, idempotent Start reconciliation, live host suspend/resume/expiry while Postgres still says `SCHEDULED`, and catalog cancellation failure/cleanup retry. An owned disposable-Postgres/Redis scenario verifies a past schedule remains scheduled, cancellation commits `ENDED`/`ended_at` before Redis cleanup, clears memberships/waiting, and inserts no broadcast. Demo joins are refused before a live host has a stage seat. Live waiters have no digest/deadline/grace timer, and Remove detaches the waiter transport. Guarded server-only credential metadata and targeted `room:resume-credential` delivery preserve recovery after release; C05 must handle that event in the browser hook. The existing ending key carries `started` or ending intent `1`; all ten key positions and broadcast `KEYS[6]` remain unchanged. The affected-check plan selected `pnpm check:release`, which passed on the final code: all 49 tooling tests; 363 shared, 470 API, and 488 web tests; typecheck; lint; both builds; formatting; nineteen Lua artifact checks; and both smokes. Broadcast smoke used the existing temporary FFmpeg 6.0 binary through a process-local `FFMPEG_PATH` override, with owned database/Redis/media fixtures. It verified all seven migrations, five chunks, two decoded HLS segments, ENDLIST/READY, restart cleanup, and missing-binary behavior. Edited plan links resolve. SCH-03 is verified by concurrent Redis tests. SCH-01/SCH-02/SCH-04/SCH-05 browser observations belong to C05 and remain unverified; C05/C06 and existing physical observations remain open.

## 6. V3P4-C05 — Schedule form and waiting panel

**Status:** committed\
**Proposed commit message:** `feat(web-room): schedule a room and wait without media`\
**Actual commit:** `2ff08fc175d9f2f8fc33a5d04b7122944d237c30`

**Why:** The host and the early joiner need the controls, and the joiner must not enter the green room. Covers the browser halves of SCH-01 through SCH-05.

**Depends on:** V3P4-C04.

**Files:**

- `apps/web/src/pages/HomePage.tsx`
- `apps/web/src/features/rooms/room-list.tsx`
- `apps/web/src/pages/RoomPage.tsx`
- `apps/web/src/features/live/components/live-room.tsx`
- `apps/web/src/features/live/components/waiting-room.tsx`
- `apps/web/src/features/live/hooks/use-live-room.ts` (existing React subscription)
- `apps/web/src/features/live/services/room-session.ts`, `signaling.ts`, and their regressions
- `apps/web/src/features/live/services/lazy-room-media.ts` and its regression
- `apps/web/src/app/entry-graph.test.ts`

**Implementation:**

1. For a registered host, add **Schedule meeting**, **Schedule webinar**, a UTC start field, and **Require host admission** on a meeting. Guest home keeps **Create meeting** and **Create webinar** only. Submit the C02 body. Show `SCHEDULED` and the UTC instant on the library row. Keep the invitation control.
2. Add a waiting panel. A `SCHEDULED` room, and a participant whose role is `WAITING`, render that panel instead of `GreenRoom`. Its join sends the socket join and does not construct local media or a peer connection. Show the waiting ids in snapshot order and the names beside them.
3. The host sees **Start**, **Remove**, and **Cancel room**. The first cancel click reveals **Cancel this room** and **Keep waiting**. **Admit** is shown only when the room is a `LIVE` meeting and `requireAdmission` is true. Handle the targeted `room:resume-credential` event through the RoomSession signaling owner used by `use-live-room.ts`, for the current connection, room, and membership. When the snapshot places this participant on stage, the existing green room asks for consent before capture. A webinar attendee keeps the current attendee path.
4. Render **Spawn demo peer** only when the host is on stage. Keep `hls`, `LiveRoom`, and chat out of the home page. The entry-graph test still forbids `hls` on home. A source test for the waiting panel forbids `getUserMedia` and `RTCPeerConnection`.
5. In the browser, as a registered host, schedule a meeting with a past UTC time and confirm it stays scheduled. Join from a second window and confirm the waiting copy, no camera prompt, and no peer connection. Start and confirm the host is first. Cover admission on with Admit, a scheduled webinar attendee, Cancel before start, and a guest immediate create. Record the browser. If no browser is available, leave that half unverified and named. Do not mark a physical-device observation verified.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

Then check the home form, the waiting panel, and Start in the browser.

**Done when:** A guest still creates a live room, an early joiner waits without media, and the host can start or cancel from the room.

**C05 verification (2026-11-06):** All 499 web tests passed. Workspace `pnpm typecheck` and `pnpm lint` passed. The affected-check plan selected web-only checks; final formatting, shared preparation, web typecheck/lint/tests/build, and `pnpm check:artifacts --web` passed. Home still excludes the live room, chat, and playback imports; room/replay remain lazy and playback remains deferred. The waiting-panel source regression forbids capture and peer construction. A lazy media adapter does not construct LocalMedia during membership/waiting; explicit preparation creates the owner. Coordinator regressions cover scheduled host/waiter joins, live admission, webinar release, consent after a granted seat, identity-scoped resume grants, bounded early credential delivery, and Start retry after a live snapshot precedes a failed acknowledgement. Existing immediate join, promotion, device, recovery, demo, broadcast, and chat regressions remain passing. The React hook keeps its existing single RoomSession subscription; targeted credentials are handled by that coordinator's current-connection signaling callbacks rather than a second hook workflow.

**C05 browser evidence (2026-11-06):** Chrome `156.0.8078.80` headless on Windows, viewport `1280 by 800`, locale `en-GB`, time zone `UTC`, used the real compiled API and ephemeral Vite web server with an owned disposable PostgreSQL database and Redis namespace. Camera/microphone input and permission UI were synthetic. The host created a meeting with `2000-01-01T00:00:00.000Z` through the schedule form; its HTTP status stayed `SCHEDULED`. A second window joined, and the host saw its waiting name/id. Instrumented host and guest each made zero capture calls and zero peer constructions while waiting, with no green-room enable control or demo control. The library displayed the exact UTC instant and retained the invitation control. Start produced `LIVE` with the host and guest seated, both still at zero capture/peer calls until consent. Each explicit camera/microphone action then made two capture calls and one native peer connection, and both connections reached `connected`. With admission on, Start seated only the host; the guest stayed off stage, Remove returned it to waiting entry, rejoin allocated a new id, and Admit displayed consent without capturing. Scheduled webinar Start released the waiter as an attendee with zero capture calls and zero peer connections. Cancel's **Keep waiting** path kept the room scheduled; **Cancel this room** ended both windows, cleared the waiting key, and left no broadcast row. Guest create stayed `LIVE` with schedule controls absent. Waiting, host form/library, and stage layouts had no horizontal overflow at `390 by 844`; no page errors occurred. Temporary local evidence is `sf-v3p4-c05-20261106` (`result.json`, `waiting.png`, `start-consent.png`); owned browser/process/database/Redis fixtures were cleaned up. These observations complete the browser halves of SCH-01, SCH-02, SCH-04, and SCH-05. SCH-03 retains C04's concurrent Redis evidence. No physical capture device, audible output, camera indicator, or native-picker observation is closed. C06 remains planned; no README implementation was included.

## 7. V3P4-C06 — README

**Status:** committed\
**Proposed commit message:** `docs(readme): describe scheduled rooms and admission`\
**Actual commit:** `bfad84b24a2a1189d78483df5ddfd0c8201e7e88`

**Why:** The README has to say that the advertised time does not start the room and that waiting is off stage.

**Depends on:** V3P4-C05.

**Files:**

- `README.md`
- `plans/phase4.md`
- `plans/phase4/guide.md`
- `plans/README.md`

**Implementation:**

1. Say that a registered host can schedule a meeting or webinar, that a past or future time does not start it, and that guest create remains immediate `LIVE`.
2. Say that early joiners wait without capture or a peer connection, that admission off fills four seats including suspensions, and that admission on seats the next person only through Admit. Say that a scheduled webinar releases waiters as attendees. Say that Cancel ends the room before start and creates no broadcast.
3. Point this behavior at `plans/phase4.md` and this guide. Leave the phase 1, phase 2, and phase 3 links in place.
4. Record the C05 browser result. Do not mark open V2 ids passed.

**Verification:**

```powershell
pnpm exec prettier --check README.md plans/phase4.md plans/phase4/guide.md plans/README.md
```

Read the edited README against phase Sections 5 and 6.

**Done when:** The README matches the schedule and waiting limits and this guide records C01 through C05. C06's hash is recorded in the follow-up `docs(v3-phase4): record the final slice hash`.

**C06 verification (2026-11-06):** `pnpm exec prettier --check README.md plans/phase4.md plans/phase4/guide.md plans/README.md` passed. The affected-check plan selected only `pnpm format:check`, which passed. Mechanical validation resolved all 78 local references and all 7 Markdown anchors across the four edited files; `git diff --check` passed. The README was reviewed against phase Sections 5 and 6: registered scheduling, advertised time without automatic Start, immediate guest create, off-stage waiting, no pre-start/waiter grace, four seats including suspensions, admission on/off, webinar release, Remove, and confirmed Cancel without a broadcast agree. Its existing capture, recovery, chat, Redis-key, and migration descriptions now include the waiting path. Phase 1/2/3 links and earlier acceptance records remain. The C05 Chrome result is recorded in the README and retained in this guide, including synthetic media/permission UI, zero pre-consent capture/peers, connected native peers after consent, and the open physical observations. This slice changes documentation only; application suites and browser probes were not rerun. No open V1/V2 id was promoted. C01 through C06 are verified; record C06's real hash and committed status in the required follow-up `docs(v3-phase4): record the final slice hash`.

**Handoff:** V3 phase 5 is specified in [../phase5.md](../phase5.md). It adds moderated Q&A and the canvas lower-third. That file does not authorize implementation.
