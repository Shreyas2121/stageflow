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

| ID     | Meaning in this phase                                                                                                                                | What this phase does not claim                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| LIB-01 | A guest with the URL can play a `LINK` replay. A `HOST` replay plays for the registered owner and is not found for anyone else, on every byte        | A physical-device or FFmpeg pixel observation                                   |
| LIB-02 | Migration and new broadcasts are `LINK`. Promotion does not change visibility. A guest owner cannot set `HOST`                                       | Hiding a replay that is still `STARTING`, `LIVE`, or `STOPPING`                 |
| LIB-03 | The registered owner deletes a `READY` or `FAILED` attempt. The row and that broadcast directory are both gone. An escaping path is not removed      | Deleting the developer data directory or running the broadcast smoke against it |
| LIB-04 | `STARTING`, `LIVE`, and `STOPPING` cannot be deleted. A failed directory delete restores the row, keeps it visible to the owner, and reports failure | A background job that finishes a claim after restart                            |

## 5. System contracts

### 5.1 Stored visibility

Migration `AddBroadcastVisibility1794096000000` adds `visibility text NOT NULL DEFAULT 'LINK'` with a check for `LINK` and `HOST`. It also allows status `DELETING` in `broadcasts_status_check`. Existing rows stay `LINK`. The smoke list appends this name after `AddGoogleSubject1794009600000`.

`DELETING` is the delete claim. It is not a catalog status, not a socket status, and not a value the client can send. `BroadcastResponse` gains `visibility`. The live room snapshot does not gain it. A snapshot projection of a `DELETING` row is null.

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
5. If the directory removal fails, restore the previous status, set `error_message` to `The replay could not be deleted. Try again.`, keep the playlist, and return `broadcast_delete_failed`. The owner can retry.
6. If the row is already `DELETING` and the directory is gone, the owner's retry deletes the row and does not offer playback. There is no sweeper.

A failed claim restore updates a row only while it is still `DELETING`. Overlapping owner retries may both remove the same confined directory. They must not remove any other path.

### 5.5 Home

The recordings list shows **Anyone with the link** or **Only you** on each broadcast. For a registered owner, a `READY` or `FAILED` row offers **Hide replay** or **Share replay**, then **Delete replay**. Delete asks for **Delete this replay** or **Cancel** before it sends the request. In-flight rows and guest sessions do not show these controls. A failed delete stays on the list with the API sentence. A success removes the row. The replay page keeps the existing not-found copy and does not say that a replay is private.

These controls stay on the home library. They do not import `hls.js`, the live room, or chat.

## 6. Acceptance matrix

| ID     | Observable result                                                                                                                         | Method                                                                                  | Status   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------- |
| LIB-01 | A guest plays `LINK` JSON and media. `HOST` plays for the registered owner and returns `broadcast_not_found` for a guest and another host | Route regressions, plus a browser replay of a seeded `LINK` row and a seeded `HOST` row | verified |
| LIB-02 | Migrated rows and a promoted guest's replays stay `LINK`. A guest owner cannot set `HOST`. A live row cannot be hidden                    | Migration and service regressions                                                       | verified |
| LIB-03 | Owner delete removes the `READY` or `FAILED` row and that directory. An escaping path is left in place                                    | Service test on a disposable directory                                                  | verified |
| LIB-04 | `STARTING`, `LIVE`, `STOPPING`, and the active Redis id cannot be deleted. A failed removal restores the row and reports failure          | Status and filesystem regressions                                                       | verified |

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
- An abandoned `DELETING` row stays unplayable until the owner retries. Nothing sweeps it.

V3 phase 4 may add scheduled rooms and waiting-room admission. Do not write `plans/phase4.md` until that phase is requested.

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
