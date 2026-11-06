# V3 Phase 3 — Replay visibility and deletion

**Status:** complete. C01 through C05 are committed and the final slice hash is recorded. LIB-01 through LIB-04 are verified; existing V1/V2 gaps remain open.\
**Last updated:** 2026-11-05.\
**Master plan:** `MASTER_PLAN_V3.md` version `3.0.0-draft.4`, Sections 4, 8, and 12 (LIB-01 through LIB-04). Identity stays as shipped in `plans/phase1.md` and `plans/phase2.md`.\
**Execution guide:** [phase3/guide.md](phase3/guide.md). That guide owns V3P3-C01 through V3P3-C05. Those ids are not the V1 commits in [V1/phase3/guide.md](V1/phase3/guide.md) or the V2 commits in [V2/phase3/guide.md](V2/phase3/guide.md).\
**Requirement IDs:** LIB-01, LIB-02, LIB-03, LIB-04.

## 1. Outcome

A registered host can keep a finished replay available to anyone with the link, hide it so only that host can play it, or delete the finished attempt and its files. A guest who has the link can still play a link-visible replay. A hidden replay uses the same not-found response as a missing id. A live attempt cannot be hidden or deleted. Promoting a guest does not hide existing replays.

Example: Ava's host account owns the webinar `Design review` and a finished replay. Sam, in a guest session, opens that replay URL and watches it. Ava chooses **Hide replay**. Sam's same URL then says no broadcast exists, and Ava can still watch it from **Your rooms**. Ava chooses **Delete replay** and confirms. The history row disappears, the replay URL is not found, and the broadcast directory for that id is gone. The room remains. A second host, and a guest who owns a different room, cannot hide or delete Ava's replay.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-11-05. `HEAD` is `7491f8392bcd`. The worktree was clean. This planning change adds the phase contract and guide. Recheck the worktree at execution.

V3P1-C01 through V3P1-C06 and V3P2-C01 through V3P2-C05 are committed. ID-01 through ID-04 are verified. ID-05 is verified with Google unset. ID-06 is verified with a fake exchange. A real Google round-trip was not run. This phase does not record the open V1 and V2 acceptance ids as passed, and a seeded playlist does not close them.

Observed in that tree:

- A registered owner is `users.is_guest = false`. That includes an email/password host and a Google-only host with a null email and a null password hash. Guest rows stay guests. This phase does not read `email`, `password_hash`, or `google_subject`.
- `broadcasts` has `id`, `room_id`, `status`, `playlist_path`, `thumbnail_path`, `error_message`, `started_at`, `ended_at`, and `created_at`. Status is `STARTING`, `LIVE`, `STOPPING`, `READY`, or `FAILED`. There is no visibility column.
- Catalog reads are `GET /api/rooms/:slug/broadcasts`, `GET /api/broadcasts/:id`, `GET /api/broadcasts/:id/hls/:file`, and `GET /api/broadcasts/:id/thumbnail.jpg`. They require a bearer token and do not check the caller against the room owner. Chunk upload remains host-only.
- The home library lists the caller's rooms. **Recordings** loads that room's broadcasts. There is no hide or delete control. `/replay/:broadcastId` plays a `READY` playlist and shows the API error message otherwise.
- HLS paths are confined by `broadcastDirectory`, `checkedHlsPath`, and `checkedThumbnailPath` under `{dataRoot}/broadcasts/{broadcastId}/`.
- The active attempt is Redis `<LIVE_NAMESPACE>:room:{roomId}:broadcast`. `LiveModule` imports `BroadcastsModule`. `failInFlight` marks only `STARTING`, `LIVE`, and `STOPPING` as `FAILED`.
- `scripts/smoke-broadcast.mjs` expects `AddGoogleSubject1794009600000` last.
- Home must not import `hls.js`, the live room, or chat.

## 3. Included and excluded

### 3.1 Included

- `visibility` `LINK` or `HOST` on the existing broadcast row. Existing rows and new rows start as `LINK`.
- Playback and library filtering for `HOST`.
- A registered owner's change from `LINK` to `HOST`, or back, on a `READY` or `FAILED` row.
- Deletion of one `READY` or `FAILED` row and its confined directory, with a claim that fails closed.
- History controls for the registered owner, and README text for these limits.

### 3.2 Excluded

These are the exclusions this phase is most likely to violate.

- A retention sweeper, an age limit, an export, a second transcode, or object storage.
- Hiding or deleting `STARTING`, `LIVE`, or `STOPPING`.
- Setting `HOST` from the migration or from guest promotion.
- A distinct "private" error that tells a stranger the row exists.
- Deleting the room, another broadcast's directory, or any path outside `{dataRoot}/broadcasts/{broadcastId}/`.
- Anonymous playback. A bearer token stays required.
- Scheduling, waiting-room admission, Q&A, and any Google change.
- Closing any open V1 or V2 acceptance id.

## 4. Requirement mapping

| ID     | Meaning in this phase                                                                                                                           | What this phase does not claim                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| LIB-01 | A guest with the URL can play a `LINK` replay. A `HOST` replay plays for the registered owner and is not found for anyone else, on every byte   | A physical-device or FFmpeg pixel observation                                   |
| LIB-02 | Migration and new broadcasts are `LINK`. Promotion does not change visibility. A guest owner cannot set `HOST`                                  | Hiding a replay that is still `STARTING`, `LIVE`, or `STOPPING`                 |
| LIB-03 | The registered owner deletes a `READY` or `FAILED` attempt. The row and that broadcast directory are both gone. An escaping path is not removed | Deleting the developer data directory or running the broadcast smoke against it |
| LIB-04 | Live/active attempts cannot be deleted. Uncertain removal retains non-playable deletion intent, discoverable by the owner with explicit retry   | An automatic age-based retention or background deletion job                     |

## 5. System contracts

### 5.1 Stored visibility

Migration `AddBroadcastVisibility1794096000000` adds `visibility text NOT NULL DEFAULT 'LINK'` with a check for `LINK` and `HOST`. It also allows status `DELETING` in `broadcasts_status_check`. Existing rows stay `LINK`. The smoke list appends this name after `AddGoogleSubject1794009600000`.

`DELETING` is the delete claim. It is not a catalog status, not a socket status, and not a value the client can send. `BroadcastResponse` gains `visibility`. The live room snapshot does not gain it. A snapshot projection of a `DELETING` row is null. Owner recovery has a separate `ReplayDeletionPage` of minimal `PendingReplayDeletion` records (id, roomId, createdAt), without media URLs or catalog status.

New broadcasts remain `LINK`. `failInFlight` still changes only `STARTING`, `LIVE`, and `STOPPING`.

### 5.2 Who can see a replay

The registered owner is the caller with `is_guest = false` and `id` equal to the room's `host_id`.

| Caller                         | `LINK`                                  | `HOST`         | `DELETING` |
| ------------------------------ | --------------------------------------- | -------------- | ---------- |
| Registered owner               | JSON, thumbnail, playlist, and segments | The same bytes | Not found  |
| Guest owner, other host, guest | JSON, thumbnail, playlist, and segments | Not found      | Not found  |

Not found is HTTP 404 `broadcast_not_found` with `No broadcast exists for that id.` A missing id uses that same response. An unauthorized thumbnail or segment uses it too. `media_not_found` remains only for an authorized broadcast whose file is absent.

`GET /api/rooms/:slug/broadcasts` stays available to an authenticated caller who knows the slug. The registered owner receives `LINK` and `HOST` rows. Every other caller receives `LINK` rows only. `DELETING` rows are omitted for everyone. The home room list stays limited to the caller's own rooms.

### 5.3 Changing visibility

`POST /api/broadcasts/:id/visibility` with `{ "visibility": "LINK" | "HOST" }` returns the catalog object.

- A caller who is not `host_id` receives `broadcast_not_found`.
- A guest owner receives HTTP 403 `replay_owner_required` with `Create a host account before changing this replay.`
- `STARTING`, `LIVE`, and `STOPPING` receive HTTP 409 `broadcast_not_ready` with `Hide a replay after it has finished.`
- `DELETING` receives `broadcast_not_found`.
- Any other body receives HTTP 400 `invalid_visibility` with `Choose link or host visibility.`
- The current value returns the catalog object and does not write.
- A finished row saves only `visibility`. Status, paths, and the room do not change. Promotion does not call this route and does not update the column.

### 5.4 Deletion

`DELETE /api/broadcasts/:id` returns 204 when the row and that broadcast's directory are both gone. The room remains.

The same owner rules apply. A guest owner receives `replay_owner_required`. Anyone else who is not `host_id` receives `broadcast_not_found`.

`STARTING`, `LIVE`, and `STOPPING` receive HTTP 409 `broadcast_not_deletable` with `A live broadcast cannot be deleted.` The same refusal applies when `<LIVE_NAMESPACE>:room:{roomId}:broadcast` is this id. A Redis read error does not claim the row and returns HTTP 500 `broadcast_delete_failed` with `The replay could not be deleted. Try again.`

For a `READY` or `FAILED` row that is not the active id:

1. Claim it by a conditional update to `DELETING`. A second delete and every playback path then fail closed.
2. Resolve `{dataRoot}/broadcasts/{broadcastId}/` with the existing confinement rule. A path that escapes `dataRoot`, or that is not that id's directory, is not removed. Restore the previous status, set `error_message` to the failure sentence, and return `broadcast_delete_failed`.
3. Remove that directory only after the check. If it is already absent, continue.
4. Delete the row only after the directory is gone.
5. Once recursive removal begins, even a rejected removal may have deleted some media. Keep `DELETING` on partial/uncertain removal or a later row-delete failure; never restore playback. Also keep `DELETING` if the directory was already absent. Record `error_message` as `The replay could not be deleted. Try again.` with a conditional update and return `broadcast_delete_failed`. A failure before removal begins may restore the prior status. The owner can retry by id.
6. If the row is already `DELETING` and the directory is gone, the owner's retry deletes the row and does not offer playback. There is no sweeper.

A failed claim restore or error update matches only a row still `DELETING`; it never recreates a deleted row or overwrites a changed status. Overlapping owner retries may both remove the same confined directory. They must not remove any other path. Failed deletion after the irreversible boundary is omitted from normal history and cannot serve JSON, thumbnails, or HLS.

`GET /api/rooms/:slug/broadcast-deletions` lists only DELETING rows for the current registered room owner. A guest owner receives `replay_owner_required`; other users receive `broadcast_not_found`. Default page size is 20, maximum 50, with the existing exact-timestamp/UUID history cursor and filtering before the page limit. The endpoint returns only id, roomId, and createdAt; it never offers playback. The inventory query does not read Redis.

`POST /api/broadcasts/:id/deletion-retry` returns 204 after finishing an existing DELETING claim. It uses the same ownership, active Redis id, confined-path, conditional-delete, and per-id concurrency checks as DELETE. Any non-DELETING or missing row returns `broadcast_not_found`, so a stale retry cannot start a fresh deletion. Ownership, room id, and status are rechecked after the Redis read before disk work. A Redis read failure leaves the durable claim and files untouched. Explicit retries use the ordinary HTTP control budget; there is no polling, automatic retry loop, or background retention/deletion job. Completion whose reply was lost appears as an empty inventory after refetch/reload; another retry is ordinary not-found.

### 5.5 Home

The recordings list shows **Anyone with the link** or **Only you** on each broadcast. For a registered owner, a `READY` or `FAILED` row offers **Hide replay** or **Share replay**, then **Delete replay**. Delete asks for **Delete this replay** or **Cancel** before it sends the request. In-flight rows and guest sessions do not show these controls. A failed delete reports the API sentence and refetches history and deletion inventory. A restored pre-removal failure stays on the normal list; a retained DELETING claim appears under **Unfinished deletions**, labelled by creation time with **Retry deletion**. No media link, thumbnail, or visibility control is rendered there. An unsuccessful retry refreshes both lists, shows its error, and permits another explicit retry; success removes the claim. Retry buttons are disabled while a retry or inventory refresh is pending. Inventory uses the shared catalog paging/retry controls, has no automatic retries/polling, and stays private to the current session; guests do not mount it. A replaced session cannot repopulate the old cache from a late mutation result. The replay page keeps the existing not-found copy and does not say that a replay is private.

These controls stay on the home library. They do not import `hls.js`, the live room, or chat.

## 6. Acceptance matrix

| ID     | Observable result                                                                                                                                    | Method                                                                                  | Status   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------- |
| LIB-01 | A guest plays `LINK` JSON and media. `HOST` plays for the registered owner and returns `broadcast_not_found` for a guest and another host            | Route regressions, plus a browser replay of a seeded `LINK` row and a seeded `HOST` row | verified |
| LIB-02 | Migrated rows and a promoted guest's replays stay `LINK`. A guest owner cannot set `HOST`. A live row cannot be hidden                               | Migration and service regressions                                                       | verified |
| LIB-03 | Owner delete removes the `READY` or `FAILED` row and that directory. An escaping path is left in place                                               | Service test on a disposable directory                                                  | verified |
| LIB-04 | Live/active attempts cannot be deleted. Pre-removal failures may restore status; partial/uncertain removal keeps deletion intent and blocks playback | Status, filesystem, and protected HTTP regressions                                      | verified |

A seeded playlist is not an FFmpeg observation. MEDIA-04, REC-05, and the other open physical ids stay open.

## 7. Verification commands

- `pnpm --filter @stageflow/shared test`
- `pnpm --filter @stageflow/api test`
- `pnpm --filter @stageflow/web test`
- `pnpm typecheck`
- `pnpm lint`

Do not run `pnpm smoke:broadcast` against the developer database. Do not delete `apps/api/data`. The migration list in the smoke script still gains the new name. If a browser cannot be opened, leave the browser half of LIB-01 unverified and named.

## 8. Risks

| Risk                                                    | What keeps it contained                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A hidden replay stays readable through the playlist URL | The same owner check runs for JSON, the thumbnail, the playlist, and each segment                               |
| The not-found copy reveals a private row                | Unauthorized `HOST` and `DELETING` use the existing missing-id message                                          |
| Delete follows a symlink outside `dataRoot`             | The confined directory helper refuses before any removal, and the restore path does not remove the other target |
| A live webinar disappears because its row was hidden    | Visibility and delete both refuse `STARTING`, `LIVE`, and `STOPPING`                                            |
| Promotion or migration hides yesterday's replays        | The column default is `LINK`, and promotion does not update it                                                  |
| Restart turns a claim into `FAILED` and publishes it    | `failInFlight` does not match `DELETING`, and the snapshot projection of a claim is null                        |
| Home starts loading the broadcast player                | The entry-graph test still forbids `hls` on the home page                                                       |

## 9. Exit and handoff

The next phase may rely on these once the slices are committed:

- Every broadcast has `visibility`, and older rows are `LINK`.
- A `HOST` replay is readable only by the registered owner. A Google-only host qualifies because `is_guest` is false.
- A deleted attempt is gone from the catalog. Its directory is gone. The room remains.
- An abandoned `DELETING` row stays unplayable and appears in the registered owner's unfinished-deletions list after reload/restart, until an explicit retry completes it. Nothing sweeps it.

V3 phase 4 is specified in [phase4.md](phase4.md). It adds scheduled rooms and waiting-room admission. That file does not authorize implementation.

This phase does not make V2 acceptance complete. Leave the open ids open.

## 10. Implementation evidence

### V3P3-C01 ? Stored visibility (2026-11-05)

Shared 309, API 400, web 477, and tooling 49 tests passed, as did workspace typecheck/lint, both builds, formatting, artifact checks, and live smoke. Broadcast smoke passed with the existing temporary FFmpeg 6.0 executable after its initial PATH lookup failed. All six migrations ran on an owned disposable database, with an empty second run. Migration regressions verify legacy and newly saved LINK rows, visibility constraints, and internal DELETING storage. Snapshot projection omits DELETING and restart recovery leaves it unchanged. No route can set HOST yet. LIB-02 storage is verified; promotion and mutation refusals remain for C03. Browser and physical acceptance remain open.

### V3P3-C02 ? Owner-only reads (2026-11-05)

All 404 API tests passed, including real-JWT HTTP requests against disposable media files, service checks that reject before resolving files, and disposable PostgreSQL privacy filtering across keyset pages. Password and Google-only registered owners can read HOST catalogs, thumbnails, playlists and segments. Guest owners, other registered hosts and guests receive the same broadcast-not-found response as a missing id. LINK remains readable by any valid bearer, and DELETING is omitted for everyone. Workspace typecheck/lint, repository formatting, shared preparation, API build/artifacts, live smoke, and disposable FFmpeg broadcast smoke passed. The latter used the same existing temporary FFmpeg 6.0 executable as C01. LIB-01 API coverage is verified; the browser half remains open for C04. C03 through C05 are not implemented.

### V3P3-C03 - Hide and delete (2026-11-05)

Registered owners, including Google-only owners, can change only a finished replay's visibility or delete that attempt and its confined directory. Guest owners receive the account-required sentence; other callers receive broadcast-not-found. Live statuses and the active Redis id refuse deletion. A Redis read failure occurs before claiming. Conditional DELETING claims block playback and concurrent deletion; the owner can retry an interrupted persisted claim. Removal failures conditionally restore the previous status, retain the playlist and visibility, and record the retry sentence. Escaping junctions and their external targets remain untouched. Deleting a replay preserves the room. Guest promotion retains LINK visibility, and both mutations spend only the ordinary control budget.

The final stable-source verification passed: shared 310 tests, API 425 tests, web 477 tests, workspace typecheck/lint, both builds, formatting, and artifact checks. The 49 tooling tests passed in the initial release invocation; its unused-fixture-argument lint failure was fixed before the final rerun. Live smoke and the disposable real-FFmpeg broadcast smoke both passed, using the same existing FFmpeg 6.0 executable recorded for C01. Focused mutation and concurrent PostgreSQL tests passed (20 tests). LIB-02, LIB-03, and LIB-04 are verified by these regressions. C04 library controls and C05 README work remain planned; LIB-01 browser and prior physical acceptance remain open.

### V3P3-C04 - Library controls (2026-11-05)

The home recordings list labels every row Anyone with the link or Only you. Registered hosts can hide/share or confirm deletion of READY/FAILED rows. Guests and in-flight rows have no mutation controls. Successful mutations update loaded query pages without losing cursor metadata; failures refetch history and show the API sentence. Session-token checks prevent an old mutation from repopulating a replaced session's cache. Empty 204 transport handling and API DELETE CORS support enable real browser deletion. Home/history retain their player/live/chat import boundaries.

Web 481, API 425, and shared 310 tests, workspace typecheck/lint, both builds, formatting, artifact checks, and live/FFmpeg broadcast smokes passed. Final web checks passed again after the session guard. Chromium 156.0.8078.4 headless on Windows verified guest LINK and owner HOST playback using decoded frames and advancing playback time, guest HOST not-found, hide/share, two-step delete/Cancel, injected-delete-failure refetch/copy, successful row/directory removal with room preservation, and absent in-flight controls. Desktop and 390px mobile screenshots were inspected. No uncaught page errors occurred. The probe used a disposable migrated database, unique Redis namespace, real compiled API, and temporary media; all owned runtime fixtures were cleaned up. Browser videos, screenshots, and result.json remain at C:/Users/rasai/AppData/Local/Temp/sf-v3p3-c04-nBuSiE/. LIB-01 is verified. Seeded replay playback does not close any prior FFmpeg/recorder, physical-device, audible-output, native-picker, or V1/V2 acceptance gap. C05 remains planned.

### V3P3-C05 - README and phase handoff (2026-11-05)

README documents default link playback, owner-only hidden replay bytes and ordinary not-found for others, confirmed READY/FAILED deletion with the room retained, live/active-id refusals, migration/promotion preserving LINK visibility, and no sweeper. Identity links remain; replay contract/guide links and C04's seeded-browser result are recorded without closing prior V1/V2 observations. The master plan's completion status and next-execution note now match the phase records; product contracts/version are unchanged and no Phase 4 work was started.

Changed-file Prettier verification passed for README.md, MASTER_PLAN_V3.md, this contract, its guide, and plans/README.md. All 70 local Markdown link targets exist. The affected-check plan selects formatting only. No application suite, browser probe, migration, or smoke was rerun for this documentation-only slice. LIB-01 through LIB-04 remain verified within the evidence recorded above; all previously open V1/V2/physical observations remain open. C05's hash is recorded after its commit.

## Maintenance: V3-R06 / V3M-C07 (2026-11-06)

Status: committed. Proposed commit: `fix(replay): preserve non-playable state after file removal`.
Actual commit: `c0ef435`.

The confined directory helper now notifies the service immediately before recursive removal. A failed pre-removal validation may restore the original READY/FAILED status, but once removal starts the claim stays DELETING even if removal rejects before deleting a file, deletes only some files, or completes with a lost reply. A missing directory also prevents restoration if the subsequent database delete fails. Error recording matches only the still-DELETING row, so it cannot recreate a deleted row or overwrite a changed status; if that update also fails, the original durable claim remains. Cache invalidation preserves the null room projection. The existing ownership, active Redis id, finished-status, and canonical-directory checks remain. No migration or public DTO change was needed.

The former database-failure assertion expecting READY was replaced. Tests now cover READY/FAILED/DELETING attempts, absent directories, partial removal with actual temporary files, lost removal/database replies, zero affected rows, a failed error update, retries, and the removal notification occurring before files disappear but never on missing/escaping paths. The authenticated HTTP fixture injects a row-delete failure after actual file removal for both password and Google-only owners. Owner/other-host/guest reads then return broadcast_not_found for JSON, thumbnails, playlist, and segments; history omits the row, the room snapshot is null, foreign retries and visibility changes fail, and the owner's retry completes with 204. The HTTP fixture uses a controlled repository, real JWT/service/controller, and disposable media; the separate PostgreSQL fixture verifies real concurrent claims and history filtering.

Evidence:

- Before the source fix, `pnpm --filter @stageflow/api test -- src/broadcasts/replay-mutations.test.ts` failed seven cases, including the incorrect READY/FAILED restoration after removed media. After the fix and final coverage additions, the focused mutation/path/HTTP/PostgreSQL run passed all 35 tests across four files.
- The affected-check plan selected API gates. `pnpm check:affected --files apps/api/src/broadcasts/broadcasts.service.ts apps/api/src/broadcasts/hls-path.ts apps/api/src/broadcasts/replay-mutations.test.ts apps/api/src/broadcasts/hls-path.test.ts apps/api/src/broadcasts/broadcasts.controller.test.ts plans/phase3.md plans/phase3/guide.md README.md` passed repository formatting, shared preparation, API typecheck/lint, all 566 API tests across 40 files, build, API artifacts, live smoke, and broadcast smoke. FFmpeg 6.0 used the existing temporary executable via process-local FFMPEG_PATH. The owned broadcast fixture applied all seven migrations with an empty second run, decoded HLS video/audio, preserved READY/media across restart, verified guest allowance refusal and missing-binary behavior, and cleaned up its processes/database/Redis/media. No developer service or environment file was changed.
- Final changed-file formatting, local Markdown target checks, and `git diff --check` passed. The untracked review.md remains untouched and outside the commit.

This closes R06's deletion-integrity defect within the tested boundaries. V3M-C08/R07 is not implemented: persisted claims still need discoverable retry/restart reconciliation, and an owner currently retries by known broadcast id. No new browser, physical-device, audible-output, native-picker, VPS capacity, or public-launch acceptance is claimed. Earlier historical evidence remains scoped to its original revision; Sections 5.4/5.5 and LIB-04 above now state the corrected failure contract.

## Maintenance: V3-R07 / V3M-C08 (2026-11-06)

Status: verified; awaiting commit. Proposed commit: `fix(replay): reconcile interrupted replay deletion`.
Actual commit:

Chose the review's owner-visible pending/retry option. Registered owners now discover durable DELETING claims under Your rooms > Recordings > Unfinished deletions after a failure, reload, or API restart. A separate owner-only paginated endpoint returns minimal id/roomId/createdAt records; DELETING remains excluded from playable catalogs, snapshots, thumbnails, and HLS. The pending-only POST retry finishes the original deletion, returns ordinary not-found if its row is missing or has changed status, rechecks ownership/state after Redis, and preserves C07's irreversible-removal boundary and confined paths. Redis errors refuse disk work without losing the claim. Inventory pages default to 20, cap at 50, and use exact timestamp/UUID cursors. Explicit retries use the existing ordinary control rate budget and per-id concurrency guard. No automatic retries, polling, retention sweeper, schema migration, or background filesystem work were introduced, which also preserves headroom on the shared Hostinger KVM 2 target.

The web inventory uses the existing infinite-query paging, cancellation, session cache isolation, explicit Retry/Load more controls, and guest exclusion. Mutations refresh both catalogs only for the initiating session token; successful recovery clears the original deletion error without reloading. Failed retries stay actionable. The API/web guides now point to this owner and record the durable constraints.

Evidence:

- Focused API mutation/HTTP/PostgreSQL/admission tests passed (55 across four files). They cover minimal private inventory, guest/foreign-owner refusal, invalid paging, exact PostgreSQL pagination with filtering before limits, pending-only refusal for all other statuses, ownership/status changes during Redis reads, Redis failure/active-id refusal, and successful retries. Focused web API/catalog/entry-graph tests passed (36); focused shared broadcast/parser tests passed (11).
- The affected planner selected the full release. `pnpm check:release` passed 49 tooling, 456 shared, 527 web, and 575 API tests; workspace typecheck/lint, both builds, formatting, artifacts, and live/broadcast smokes. Process-local FFMPEG_PATH used the existing temporary FFmpeg 6.0 executable. The maintained broadcast smoke now abruptly exits four compiled-service children against its disposable PostgreSQL/media fixture after a committed claim, partial file removal, full removal before row deletion, and a committed delete before its reply. The restarted real API lists only the three unfinished claims to their owner with page size one, excludes them from normal history, rejects other accounts, finishes each retry, and preserves the room. The already deleted row stays gone. The smoke also retains its real HLS decode, READY restart, guest-budget, missing-binary, and foreign-namespace checks and cleans up owned fixtures.
- A final UI follow-up clears the original deletion error after successful recovery. After it, `pnpm check:affected --files apps/web/src/features/rooms/room-history.tsx apps/web/src/features/rooms/replay-deletions.tsx` passed formatting, shared preparation, web typecheck/lint, all 527 web tests, build, and web artifacts. The existing Vite large-chunk warning remains; the deferred player stays deferred.
- Final browser probe: `pnpm --filter @stageflow/api exec dotenv -e ../../.env -- node C:/Users/rasai/AppData/Local/Temp/stageflow-c08-browser.cjs` passed in Chromium 156.0.8078.4 headless on Windows. Real API/PostgreSQL/Redis and Vite used owned ports, namespace, database, and media. A fixture-only PostgreSQL trigger injected real row-delete failures after media removal. The UI revealed the pending claim with no automatic retry, retained a failed explicit retry, completed recovery and cleared both errors without reload, discovered another persisted claim after actual API restart/reload, rejected guest/foreign inventory access, and completed its retry. Guest UI made no deletion-inventory requests. Desktop and 390px screenshots were inspected; no horizontal overflow or uncaught page errors occurred. Final result/screenshots remain in C:/Users/rasai/AppData/Local/Temp/sf-c08-browser-egVvE3/; the initial passing probe is in sf-c08-browser-5i6emM. Both probes cleaned up owned API/Vite/browser/database/Redis/media fixtures. Temporary evidence is outside Git.
- Changed-file formatting, local Markdown targets, and `git diff --check` passed. Developer services, environment files, and the untracked review.md were preserved.

This resolves R07 through discoverable explicit owner recovery, including after restart; automatic startup reconciliation is not implemented or needed by this chosen option. No VPS load/capacity, real Google-provider, physical-device, audible-output, native-picker, or public-launch acceptance is claimed. The earlier C07 record's pending-C08 note describes that earlier commit and is superseded by this record.
