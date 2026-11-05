# Guide — V3 Phase 3, commit by commit

**Status:** in progress. C01 records replay visibility; C02 through C05 remain planned.\
**Last updated:** 2026-11-05.\
**Phase contract:** [../phase3.md](../phase3.md).\
**Product authority:** [MASTER_PLAN_V3.md](../../MASTER_PLAN_V3.md) version `3.0.0-draft.4`. Identity stays as shipped in [../phase1.md](../phase1.md) and [../phase2.md](../phase2.md). Unchanged V2 rules stay in [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md). Unchanged V1 rules stay in [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.9`.\
**Deliverable:** A registered host can hide or delete a finished replay, and a hidden replay is not found for everyone else, in five commits. This is the only V3 Phase 3 guide. Its commit ids are not the V1 Phase 3 commits in [../V1/phase3/guide.md](../V1/phase3/guide.md) or the V2 Phase 3 commits in [../V2/phase3/guide.md](../V2/phase3/guide.md).

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `7491f8392bcd`. Recheck the worktree.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run V3P3-C01 through V3P3-C05 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing.
4. After the focused commands, inspect `pnpm check:affected --plan --files <changed-paths>` and run the checks it selects.
5. After verification, commit that slice under V1 master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(v3-phase3): record the final slice hash`.
6. LIB-01's browser half uses a seeded playlist in a disposable data directory. Do not point it at `apps/api/data`, and do not run `pnpm smoke:broadcast` against the developer database.
7. A missing browser leaves the browser half of LIB-01 unverified and named. A missing disposable Postgres leaves the migration run unverified. Neither gap authorizes skipping the unit checks.

Keep guest create, register, login, promotion, Google sign-in, demo peers, the mesh, reconnect, chat, and the broadcast pipeline. Do not add scheduling, waiting-room admission, or Q&A.

### 1.1 Commit index

| Order | ID       | Proposed message                                               | Acceptance             |
| ----- | -------- | -------------------------------------------------------------- | ---------------------- |
| 1     | V3P3-C01 | `feat(api-broadcast): record link visibility on replays`       | LIB-02 storage         |
| 2     | V3P3-C02 | `feat(api-broadcast): show a private replay only to its owner` | LIB-01                 |
| 3     | V3P3-C03 | `feat(api-broadcast): hide or delete a finished replay`        | LIB-02, LIB-03, LIB-04 |
| 4     | V3P3-C04 | `feat(web-library): hide and delete a finished replay`         | LIB-01 browser         |
| 5     | V3P3-C05 | `docs(readme): describe replay privacy and deletion`           | README limits          |

### 1.2 Files to inspect before editing

- `packages/shared/src/broadcast.ts`, `broadcast.test.ts`, and `contracts.ts`
- `packages/shared/src/signaling.ts`
- `apps/api/src/broadcasts/broadcast.entity.ts`, `broadcasts.service.ts`, `broadcasts.controller.ts`, and `hls-path.ts`
- `apps/api/src/broadcasts/broadcasts.module.ts`
- `apps/api/src/rooms/rooms.service.ts`
- `apps/api/src/live/live.keys.ts` and `live.module.ts`
- `apps/api/src/database/data-source.ts`
- `apps/api/src/migrations/1794009600000-AddGoogleSubject.ts`
- `scripts/smoke-broadcast.mjs`
- `apps/web/src/features/rooms/room-history.tsx`, `room-list.tsx`, and `api.ts`
- `apps/web/src/pages/ReplayPage.tsx`
- `apps/web/src/app/entry-graph.test.ts`
- `README.md`

## 2. V3P3-C01 — Record link visibility

**Status:** verified, awaiting commit\
**Proposed commit message:** `feat(api-broadcast): record link visibility on replays`\
**Actual commit:**

**Why:** Later slices need one stored value and one catalog field before any replay becomes private. Covers the storage half of LIB-02.

**Depends on:** The existing broadcast catalog and migration list.

**Files:**

- `packages/shared/src/broadcast.ts`
- `packages/shared/src/broadcast.test.ts`
- `apps/api/src/migrations/1794096000000-AddBroadcastVisibility.ts`
- `apps/api/src/database/data-source.ts`
- `apps/api/src/broadcasts/broadcast.entity.ts`
- `apps/api/src/broadcasts/broadcasts.service.ts`
- The broadcast catalog fixtures that construct `BroadcastResponse`
- `scripts/smoke-broadcast.mjs`

**Implementation:**

1. Add `BroadcastVisibility` as `LINK` or `HOST`. Add required `visibility` to `BroadcastResponse` and `parseBroadcast`. Reject a missing value, a lowercase value, and any other string. Do not add `visibility` to `RoomSnapshot['broadcast']`.
2. Add the column and the `DELETING` status check from phase Section 5.1. Register the migration after `AddGoogleSubject1794009600000`. Append its name to the smoke list. Map `visibility` on `Broadcast` with default `LINK`. Keep `DELETING` off the shared status union. The entity may use a wider internal status type.
3. `catalog` includes the stored visibility. `start` relies on the default and must not write null. `projection` returns null for a `DELETING` row. `failInFlight` still matches only `STARTING`, `LIVE`, and `STOPPING`.
4. Update in-repo catalog fixtures so typecheck passes. Search for `BroadcastResponse` object literals and playlist fixtures. Give them `visibility: 'LINK'`.
5. Tests prove a parsed `LINK` and `HOST` catalog, a rejected missing visibility, and a new saved row whose visibility is `LINK`.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

**Done when:** Existing playback still works, every catalog object includes `visibility`, and no route can set `HOST` yet.

**Verification record (2026-11-05):** Shared 309, API 400, and web 477 tests passed. Workspace typecheck and lint passed. The affected plan selected `check:release`: tooling 49 tests, both builds, repository formatting, artifact checks, and live smoke passed. Broadcast smoke initially failed because `ffmpeg` was absent from PATH, then passed with `FFMPEG_PATH=C:/Users/rasai/AppData/Local/Temp/stageflow-ffmpeg-b6.0/ffmpeg.exe` (FFmpeg 6.0). Its disposable database applied all six migrations and a second run was empty; real WebM/HLS encoding, decoded audio/video, startup recovery, and owned cleanup passed. The PostgreSQL regression also verifies legacy LINK backfill, a new saved LINK row, invalid visibility constraints, and the internal DELETING status. No browser or physical-device observation is claimed.

## 3. V3P3-C02 — Owner-only private playback

**Status:** planned\
**Proposed commit message:** `feat(api-broadcast): show a private replay only to its owner`\
**Actual commit:**

**Why:** A private row has to be enforced on every read before the product offers a hide button. Covers LIB-01.

**Depends on:** V3P3-C01.

**Files:**

- `apps/api/src/broadcasts/broadcasts.service.ts`
- `apps/api/src/broadcasts/broadcasts.controller.ts`
- `apps/api/src/broadcasts/broadcasts.service.test.ts`
- The nearest HTTP test for broadcast reads

**Implementation:**

1. Pass the current user into `getById`, `mediaPath`, `thumbnailFile`, and `listByRoomSlug`. Load the room with `RoomsService.getById`. Apply phase Section 5.2.
2. Check the caller before resolving a file. Unauthorized `HOST` returns `broadcast_not_found` and does not stat the path. An authorized missing file stays `media_not_found`.
3. Filter the history query in SQL. The registered owner sees `LINK` and `HOST`. Every other caller sees `LINK` only. Omit `DELETING` for everyone. Keep cursor ordering on the filtered query.
4. `LINK` playback stays allowed for any bearer token, including a guest and a host who does not own the room. Chunk upload is unchanged.
5. Tests insert a `HOST` row directly. Cover the registered owner, a guest owner, another registered host, the thumbnail, and one segment. Include a Google-only owner fixture with `isGuest: false`, a null email, and a null password hash. Do not call Google.

**Verification:**

```powershell
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** `HOST` bytes are limited to the registered owner, and `LINK` bytes still play for a guest token.

## 4. V3P3-C03 — Hide and delete

**Status:** planned\
**Proposed commit message:** `feat(api-broadcast): hide or delete a finished replay`\
**Actual commit:**

**Why:** The owner needs one mutation for visibility and one confined delete. Covers LIB-02's refusal rules, LIB-03, and LIB-04.

**Depends on:** V3P3-C02. Read `<LIVE_NAMESPACE>:room:{roomId}:broadcast` without importing `LiveModule`. A short-lived Redis client, quit on broadcast shutdown, is enough. Tests pass a fake reader.

**Files:**

- `packages/shared/src/contracts.ts`
- `packages/shared/src/broadcast.ts`
- `apps/api/src/broadcasts/hls-path.ts`
- `apps/api/src/broadcasts/hls-path.test.ts`
- `apps/api/src/broadcasts/broadcasts.service.ts`
- `apps/api/src/broadcasts/broadcasts.controller.ts`
- `apps/api/src/broadcasts/broadcasts.module.ts`
- `apps/api/src/admission/http-admission.test.ts`
- The promotion test nearest `accounts.integration.test.ts` or `sessions.service.test.ts`

**Implementation:**

1. Add `invalid_visibility`, `replay_owner_required`, `broadcast_not_ready`, `broadcast_not_deletable`, and `broadcast_delete_failed` to `ApiErrorBody['error']`. Add `parseBroadcastVisibility` for the `visibility` field. Other body keys are ignored.
2. `POST /api/broadcasts/:id/visibility` implements phase Section 5.3. The guest-owner message is `Create a host account before changing this replay.` Saving `HOST` or `LINK` changes only that column.
3. `DELETE /api/broadcasts/:id` implements phase Section 5.4 and returns 204. Add `removeBroadcastDirectory` next to the existing path helpers. It returns missing when the directory is absent. It throws, and removes nothing, when the real path is not `{dataRoot}/broadcasts/{id}`. The service restores the previous status only while the row is still `DELETING`.
4. Classify both routes as ordinary control traffic. Do not add them to the guest or Google budget sets. HLS stays media. Chunk upload stays upload.
5. Tests use a disposable directory. Cover a `READY` delete, a `FAILED` delete, each in-flight status, an active Redis id, a Redis read error before the claim, a missing directory retry, a removal failure that restores `READY` and the failure sentence, and a symlink or parent path that remains. Assert promotion of a guest leaves `visibility` at `LINK`. Do not delete `apps/api/data`.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** The owner can hide and delete a finished replay, a live attempt is unchanged, and an escaping path is still on disk.

## 5. V3P3-C04 — Library controls

**Status:** planned\
**Proposed commit message:** `feat(web-library): hide and delete a finished replay`\
**Actual commit:**

**Why:** The registered owner needs the controls on the existing recordings list. Covers the browser half of LIB-01.

**Depends on:** V3P3-C03.

**Files:**

- `apps/web/src/features/rooms/api.ts`
- `apps/web/src/features/rooms/room-history.tsx`
- `apps/web/src/features/rooms/room-list.tsx`
- `apps/web/src/features/rooms/history.test.ts`
- `apps/web/src/app/entry-graph.test.ts`

**Implementation:**

1. Add a visibility request and a delete request next to `listBroadcasts`. Parse the visibility response with `parseBroadcast`. A 204 delete has no catalog body.
2. Pass `isHost` from `RoomList` into `RoomHistory`. Render phase Section 5.5. Use the existing `Button`. The first delete click only reveals **Delete this replay** and **Cancel**.
3. After a successful hide or share, show the new label. After a successful delete, remove the row. After a failure, refetch the recordings and show the API message. Guest sessions and `STARTING`, `LIVE`, and `STOPPING` rows render no hide or delete control.
4. Keep `hls`, `LiveRoom`, and chat out of the home page and the history component. The entry-graph test still forbids `hls` on home. The replay page is unchanged apart from receiving `visibility` on the catalog object.
5. In the browser, seed two disposable `READY` rows and playlists under a temporary data root: one `LINK` and one `HOST`. As a guest, play the link replay and confirm the hidden replay says no broadcast exists. As the registered owner, play the hidden replay, hide the link replay, share it again, and delete one finished row. Confirm the in-flight row has no delete control. Record the browser. If no browser is available, leave this half unverified and named. Do not mark an FFmpeg or physical-device observation verified.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

Then check the recordings list and the replay page in the browser.

**Done when:** A guest still plays a link replay, a hidden replay is not found for that guest, and the owner can hide and delete from the library.

## 6. V3P3-C05 — README

**Status:** planned\
**Proposed commit message:** `docs(readme): describe replay privacy and deletion`\
**Actual commit:**

**Why:** The README has to state who can play a replay and what deletion removes.

**Depends on:** V3P3-C04.

**Files:**

- `README.md`
- `plans/phase3.md`
- `plans/phase3/guide.md`
- `plans/README.md`

**Implementation:**

1. Say that finished replays stay available to anyone with the link until the registered owner hides them. A hidden replay plays for that owner and uses the normal not-found response for everyone else.
2. Say that the owner can delete a `READY` or `FAILED` attempt, that the room remains, and that a live attempt cannot be hidden or deleted. Say that promotion and the migration leave replays link-visible. Say that nothing sweeps old files.
3. Point this behavior at `plans/phase3.md` and this guide. Leave the phase 1 and phase 2 links in place.
4. Record the C04 browser result. Do not mark open V2 ids passed. A seeded playlist is not an FFmpeg result.

**Verification:**

```powershell
pnpm exec prettier --check README.md plans/phase3.md plans/phase3/guide.md plans/README.md
```

Read the edited README against phase Sections 5 and 6.

**Done when:** The README matches the privacy and deletion limits and this guide records C01 through C04. C05's hash is recorded in the follow-up `docs(v3-phase3): record the final slice hash`.

**Handoff:** V3 phase 4 is scheduled rooms and waiting-room admission. Do not write `plans/phase4.md` until that phase is requested.
