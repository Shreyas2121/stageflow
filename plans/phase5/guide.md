# Guide — V2 Phase 5, commit by commit

**Status:** in progress. V2P5-C01's server-time display is implemented and verified. V2P5-C02 through V2P5-C04 remain planned.\
**Last updated:** 2026-11-04.\
**Phase contract:** [../phase5.md](../phase5.md).\
**Product authority:** [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md) version `2.0.0-draft.6`. Unchanged V1 rules stay in [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.9`.\
**Deliverable:** The practical local session has a visible chat server time, a recorded keyboard pass, and an honest acceptance record, in four commits. This is the only V2 Phase 5 guide. Its commit ids are not the V1 Phase 5 commits in [../V1/phase5/guide.md](../V1/phase5/guide.md).

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `7c8f8ed21bc938c7fbdea337ed69efcc07e9559c`. Recheck the worktree. `plans/phase1.md`, `plans/phase2.md`, and `plans/phase3.md` were already dirty when this guide was written.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run V2P5-C01 through V2P5-C04 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing. API tests that touch Redis fail when Redis is unreachable. Do not point them at developer keys outside `sf:itest:*`.
4. After verification, commit that slice under V1 master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(v2-phase5): record the final slice hash`.
5. If a browser cannot be used, leave the browser half of the related acceptance id unverified and name the gap.
6. Do not mark P3-A03, P3-A05, or P3-A06 passed unless that physical or native-picker observation was actually made.

Keep the mesh cap, the negotiation reducer, device replacement, reconnect, chat bounds, and the single 720p pipeline. Do not add accounts, `restartIce`, or a PostgreSQL message table.

### 1.1 Commit index

| Order | ID       | Proposed message                                      | Acceptance                |
| ----- | -------- | ----------------------------------------------------- | ------------------------- |
| 1     | V2P5-C01 | `feat(web-room): show the chat server time`           | Section 5.1, CHAT-04 time |
| 2     | V2P5-C02 | `docs(v2-phase5): record the keyboard walk`           | UX-01                     |
| 3     | V2P5-C03 | `test(release): account for the local session script` | QA-01, QA-02, Section 4.1 |
| 4     | V2P5-C04 | `docs(readme): record the V2 acceptance result`       | QA-03                     |

When V2P5-C02 changes product code, commit it as `fix(web): keep the session usable from the keyboard`.

### 1.2 Files to inspect before editing

- `apps/web/src/features/chat/chat-panel.tsx` and `packages/shared/src/chat.ts`
- `apps/web/src/styles/base.css`, `pages/HomePage.tsx`, and `pages/ReplayPage.tsx`
- `apps/web/src/features/live/components/live-room.tsx` and `app/entry-graph.test.ts`
- `apps/api/src/database/data-source.ts` and `scripts/smoke-broadcast.mjs`
- `scripts/checks.mjs`
- `README.md`, `plans/phase1.md`, `plans/phase2.md`, `plans/phase3.md`, and `plans/phase4.md`

## 2. V2P5-C01 — Server time

**Status:** verified; awaiting commit\
**Proposed commit message:** `feat(web-room): show the chat server time`\
**Actual commit:**

**Why:** Master Section 9.1 requires the server time on a line. The server already stores it, and the panel renders name, role, and text. Covers the timestamp gap inside CHAT-04.

**Depends on:** The shipped chat panel and `ChatMessage.sentAt`.

**Files:**

- `apps/web/src/features/chat/format-chat-time.ts`
- `apps/web/src/features/chat/format-chat-time.test.ts`
- `apps/web/src/features/chat/chat-panel.tsx`
- `README.md`

**Implementation:**

1. Add the pure formatter from phase Section 5.1. Return no time for a non-finite `sentAt`. Return the UTC ISO instant for `dateTime`, and the locale time for the visible text. Include the calendar date only when that local date differs from `now`.
2. Test it with locale `en-GB`, time zone `UTC`, and a fixed `now`. Cover the same local day, another local day, and a non-finite instant. The same-day string contains the time and omits the year. The other-day string contains the day and the year.
3. Render a `time` element after the role. Pass `Date.now()` as `now`. Omit the element when the formatter returns no time. Do not move focus and do not make the log assertive.
4. Replace the README sentence that says the panel does not display `sentAt`. State that each line shows the server time as the local hour and minute, and includes the date when the message falls on another local day.
5. Leave the wire format, the history payload, and the home page alone. The home page still must not import the chat panel.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

**Done when:** The formatter tests pass, the panel renders the time, the README sentence matches Section 5.1, and the slice is committed.

**Verification result (2026-11-04):** `pnpm --filter @stageflow/web test` passed (313 tests), including seven new formatter cases covering same-day time, another-day date/time, local calendar comparison across a UTC boundary, non-finite timestamps, and a finite out-of-range instant. `pnpm check` passed with typecheck, lint, shared tests (262), web tests (313), API tests against Redis (219), both builds, and repository formatting. The panel formats the stored server instant after the role and omits invalid times; its focus behavior and chat region are unchanged. The README now describes the displayed time. The home entry regression passed. No browser walk, combined session, or release smoke was run in this slice; those observations remain for C02 and C03, and CHAT-04's other observations and the physical/native-picker gaps remain open.

**Handoff:** The keyboard walk and the release script have not been recorded.

## 3. V2P5-C02 — Keyboard walk

**Status:** planned\
**Proposed commit message:** `docs(v2-phase5): record the keyboard walk`\
**Actual commit:**

**Why:** The session controls are native controls with an existing focus outline, and UX-01 still has no recorded walk. Covers UX-01.

**Depends on:** V2P5-C01. The server time is already on the line.

**Files:**

- The product files the walk shows cannot be operated from the keyboard
- `plans/phase5.md`
- `plans/phase5/guide.md`

**Implementation:**

1. Walk Section 5.2 in Chrome or Edge on Windows at 1280 by 800 and at 1024 by 768. Use the keyboard for every control named there. Confirm the existing outline is visible on the focused control.
2. Confirm the server time is readable with the name and role. Confirm recovery, pause, room end, and a failed send expose their existing sentences as text. Leave the chat log a region.
3. Fix a control that cannot be reached or operated, or a walked state change that has no readable text. Use a native control or the existing outline, and one polite status. Keep the composer label **Message the room**.
4. When that fix changes product code, commit this slice as `fix(web): keep the session usable from the keyboard` and add a regression for a failure that can be reproduced in a service. When the walk finds no defect, commit the evidence with the proposed docs message.
5. Record the browser, OS, both widths, and the result on UX-01. A missing browser leaves UX-01 unverified. Do not add a settings page.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

Run those commands when this slice changes product code. The docs-only result still records the walk in this guide.

**Done when:** UX-01 has a walk result or an explicit unverified gap, any required fix is committed with this slice, and the slice is committed.

**Handoff:** The release script and the migration assertion are unchanged.

## 4. V2P5-C03 — Local session evidence

**Status:** planned\
**Proposed commit message:** `test(release): account for the local session script`\
**Actual commit:**

**Why:** The release smoke still expects two migrations, and the combined script has no single record. Covers QA-01, QA-02, and the earlier ids in Section 4.1.

**Depends on:** V2P5-C02. Keyboard evidence stays in that slice.

**Files:**

- `scripts/smoke-broadcast.mjs`
- A service test only when the script exposes a reproducible defect
- `plans/phase5.md`
- `plans/phase1.md`, `plans/phase2.md`, `plans/phase3.md`, and `plans/phase4.md` when an observation in this slice changes that id's status

**Implementation:**

1. Change the smoke assertion to the three migration classes in phase Section 5.3, in that order. Assert that the second run applies nothing. Update the log so it describes the registered list. Keep the disposable `sf_broadcast_*` database.
2. Run `pnpm check`. Then run `pnpm check:release` when Redis, disposable Postgres, and `FFMPEG_PATH` are available. When one is missing, run the commands that can run and name the skipped command.
3. Run V2 master Section 13.1 against the local web app and API. Synthetic devices are enough. Map each step to the id in Section 4.1. Cite the V2P5-C02 walk for the keyboard step unless this slice changes one of those controls.
4. Update an earlier id only when this slice produces that observation. Leave P3-A03, P3-A05, and P3-A06 open unless the physical or native-picker observation happens.
5. Fix a defect that stops the script. Keep the current mesh, replacement, reconnect, chat, and broadcast behavior. Add a service regression when the defect can be reproduced there. Do not add an account, a migration, or `restartIce` to make a step pass.

**Verification:**

```powershell
pnpm check
pnpm smoke:broadcast
```

Missing Redis leaves the API tests unverified. Missing disposable Postgres or FFmpeg leaves `pnpm smoke:broadcast` unverified. Record the browser, OS, widths, and FFmpeg version for the steps that ran.

**Done when:** QA-01 and QA-02 have a result, Section 4.1 matches the observations from this slice, and the slice is committed.

**Handoff:** The README acceptance summary is still the pre-acceptance text.

## 5. V2P5-C04 — Acceptance record

**Status:** planned\
**Proposed commit message:** `docs(readme): record the V2 acceptance result`\
**Actual commit:**

**Why:** The product README does not yet give one result for the practical session, the visible server time, and the checks that remain open.

**Depends on:** V2P5-C03.

**Files:**

- `README.md`
- `plans/phase5.md`
- `plans/phase5/guide.md`
- `plans/README.md`
- `MASTER_PLAN_V2.md`

**Implementation:**

1. Replace the sentence that says combined acceptance is not implemented. State the result of UX-01, QA-01, QA-02, and QA-03 from the slices that ran.
2. State that each chat line shows the server time as specified in phase Section 5.1. Keep the shipped guest, device, reconnect, chat, and broadcast limits.
3. Name every Section 4.1 id that is still partial or unverified, including P3-A03, P3-A05, and P3-A06 when those observations were not made. Name any skipped browser, Postgres, Redis, or FFmpeg command.
4. Keep accounts, scheduling, deployment, and `restartIce` described as future work.
5. Record each slice hash in this guide. Set this phase's status from the verification that actually ran.

**Verification:**

Read the edited README against phase Sections 4.1 and 5. `pnpm exec prettier --check README.md plans/phase5.md plans/phase5/guide.md plans/README.md MASTER_PLAN_V2.md` passes.

**Done when:** The README matches the recorded acceptance result and this guide names every slice hash.

**Handoff:** V2 has no further phase file. Do not add accounts in this commit.
