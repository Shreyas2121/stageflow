# V2 Phase 1 — Room and replay workspace

**Status:** V2P1-C01, V2P1-C02, V2P1-C03, V2P1-C04, and V2P1-C05 are committed. WS-01 and WS-02 have a partial browser result. WS-03 replay and `pnpm smoke:broadcast` remain unverified.\
**Last updated:** 2026-11-04.\
**Master plan:** `MASTER_PLAN_V2.md` version `2.0.0-draft.2`, Sections 1, 3.1, 5, 6, 10, 11, and 12 (WS-01 through WS-03). Unchanged media, admission, and restart rules stay in `MASTER_PLAN.md` version `1.0.9`.\
**Execution guide:** [phase1/guide.md](phase1/guide.md). That guide owns V2P1-C01 through V2P1-C05. Those ids are not the V1 commits in [V1/phase1/guide.md](../V1/phase1/guide.md). This file owns the rules those commits must satisfy.\
**Requirement IDs:** WS-01, WS-02, WS-03.

## 1. Outcome

A guest who already has a session opens the home page and sees the rooms that guest created. The list shows each room's title, mode, catalog status, and creation time. The guest copies an invitation, opens that room's existing broadcast attempts, and plays a READY replay. Joining accepts the raw slug or an invitation link from this app. Another guest cannot retrieve the first guest's list by sending the first guest's user id. Typing the same display name in a new guest session does not bring the rooms back.

Example: Ava's current guest session already created the meeting `Design review` and the webinar `Launch`. On `/` she sees both under **Rooms from this guest session**. `Design review` is `LIVE` and `Launch` is `ENDED`. She copies `http://localhost:5173/r/` plus the meeting slug. She opens Launch's recordings and sees one `READY` row and one `FAILED` row whose stored error is visible. Only the `READY` row links to `/replay/` plus its broadcast id. Sam, in another guest session, receives an empty list even when the request includes Ava's user id.

`LIVE` on that list means the room row has not ended. It does not mean Ava is connected.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-11-03. `HEAD` is `0267919feb41da48eda803498666e3f2b88d3f37` (`docs(v1): record verified acceptance and maintenance outcomes`). The worktree was not clean: `README.md` and `plans/README.md` already had uncommitted V2 pointer edits, `review.md` was deleted, and `MASTER_PLAN_V2.md` and `briefing.html` were untracked. This planning change moves the V1 plans and adds this phase. Recheck the worktree at execution. Do not revert unrelated work, restore `review.md`, or stage `briefing.html` as part of a slice.

V1 feature slices are committed. V1 is not fully verified. P3-A03, P3-A05, and P3-A06 remain open physical observations. This phase does not record them and does not mark them passed.

Observed in that tree:

- There is no room-list route. `RoomsController` exposes `POST /api/rooms` and `GET /api/rooms/:slug` only. Any authenticated guest who knows the slug may fetch the room. `host_id` has no list index. The rooms migration is `1730332800000-CreateUsersAndRooms`.
- `GET /api/rooms/:slug/broadcasts` returns every catalog row for that slug, newest `createdAt` then `id`, as a JSON array. `scripts/smoke-broadcast.mjs` reads that array. The web app does not call it. `GET /api/broadcasts/:id` returns one `BroadcastResponse`.
- `BroadcastResponse` is `id`, `roomId`, `status`, `playlistUrl`, `errorMessage`, `startedAt`, `endedAt`, and `createdAt`. `playlistPath` and `thumbnailPath` stay off the wire. Stored `thumbnailPath` is written only as null. No route serves `thumbnail.jpg`. Thumbnail generation was omitted in V1.
- Catalog playlist URLs are `/api/broadcasts/{uuid}/hls/index.m3u8` or null. The bearer token is attached only to that same-origin playlist and its `segment` plus at least six digits `.ts` files.
- Home creates a new guest user on every create and every join, then replaces the session. A usable session in `sessionStorage` is ignored for those submits. The join field accepts only 12 characters.
- `/r/:slug` and `/replay/:broadcastId` stay separate chunks. `apps/web/src/pages/HomePage.tsx` must not contain the letters `hls`. The home page does not import the room page, the replay page, or `hls.js`.
- Replay without a session still creates one guest through `ReplayGuestEntry` and returns only a validated `/replay/{uuid}` path. Room fetch, replay fetch, and private react-query caches are already scoped by the session user id. A 401 from those clients clears that token.
- `GET /api/rooms/:slug/broadcasts` is ordinary control admission. HLS reads and chunk uploads have their own budgets. Guest JWTs still expire after 12 hours. There is no refresh token.

Recheck at execution. Git follows V1 master Section 1.4. A missing browser leaves the browser half of WS-01 through WS-03 unverified and named. A missing disposable Postgres leaves the migration run unverified. Neither gap authorizes skipping the unit checks or deleting developer data.

## 3. Included and excluded

### 3.1 Included

- A host-scoped, cursor-paged room list for the authenticated guest.
- An index on `rooms (host_id, created_at DESC, id DESC)`.
- Create and join reuse the current usable guest session. A different name starts a new guest only after the current session is cleared.
- Join accepts a raw slug or a room link from this app's origin.
- Copying `{origin}/r/{slug}`.
- The same cursor contract on the existing per-room broadcast list, including the smoke consumer.
- `thumbnailUrl` on the catalog object, and one confined thumbnail read when the stored path is the expected file.
- A home workspace that lists this guest's rooms and their broadcast attempts, and links a READY replay to the existing replay route.
- README text for this workspace and for the limits it does not cross.

### 3.2 Excluded

These are the exclusions this phase is most likely to violate. V2 master Sections 3.2, 7, 8, and 9 still apply.

- Registered accounts, email/password, Google or other OAuth, refresh tokens, display-name recovery, and renaming a guest.
- A global directory of rooms or recordings. Joining a room does not add it to the caller's list.
- Making an existing replay URL private, or requiring the caller to be the host before `GET /api/rooms/:slug`, `GET /api/broadcasts/:id`, or the replay page.
- Device replacement, device loss, output routing, reconnect, suspension, chat, scheduling, waiting rooms, and polls.
- A new recording pipeline, encoder, thumbnail job, queue, or retention rule. `READY` does not depend on a thumbnail.
- Loading `hls.js`, the broadcast player, or the live room socket from the home page.
- Treating catalog `LIVE` as proof that the host socket is connected.
- Offset pagination, an unbounded list, or a total-count query.
- Closing P3-A03, P3-A05, or P3-A06.

## 4. Requirement mapping

| ID    | Meaning in this phase                                                                                                                                                                                                         | What this phase does not claim                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| WS-01 | The authenticated guest receives only rooms whose `host_id` is that guest. A caller-supplied host id is ignored. The home list uses the current session and says that a new session cannot recover it by display name         | An account, a rename, or rooms the guest only joined           |
| WS-02 | A raw slug and a valid invitation URL open the same room. A malformed target fails before navigation. Create, `/r/:slug`, and `/replay/:broadcastId` remain available                                                         | Accepting links from another origin                            |
| WS-03 | Broadcast history is paged and shows `STARTING`, `LIVE`, `STOPPING`, `READY`, and `FAILED` as different states. Only a `READY` row with a catalog playlist links to the existing replay. The row remains after an API restart | A new recording, a required thumbnail, or private replay links |

## 5. System contracts

### 5.1 Guest identity on the home page

`usableSession` is the current guest. While it is present, create and join send that token and do not call `POST /api/sessions/guest`. The displayed name is the session's `displayName`. The form does not edit it.

While no usable session is present, create and join keep today's order: parse the display name, create one guest, store that session, then create or fetch the room. One submit creates one user.

**Use a different name** clears the current session through the existing store. The next submit creates a new guest. The cleared session's rooms remain in PostgreSQL and disappear from this browser. The page states that before the control is used. The same display name does not select the old user.

Direct `/r/:slug` without a session still sends the person home to enter a name. Replay without a session still uses `ReplayGuestEntry`. That replay guest is a new user and does not inherit the host's room list.

A 401 still clears only the token that failed. `room_not_found` does not clear the session.

### 5.2 Room list

`GET /api/rooms` requires the existing bearer token. The host is `CurrentUser.id`. The handler reads `limit` and `cursor` and ignores every other query field, including `hostId`, `userId`, and `displayName`.

Declare this handler so it is not captured by `GET /api/rooms/:slug`. Slug fetch stays any authenticated guest who knows the slug. Slug validation and `room_not_found` stay as they are.

The response is:

```json
{
  "items": [],
  "nextCursor": null
}
```

Each item is the existing `RoomResponse`. Do not add a connection flag, a broadcast count, or a second room shape. An authenticated guest with no rooms gets an empty `items` array and `nextCursor: null`, not 404.

Order is `created_at DESC, id DESC`. `id` is compared as a UUID. The page size defaults to 20 and cannot exceed 50. Request one extra row to decide `nextCursor`, then omit that row. `nextCursor` is the cursor of the last returned item when the extra row existed, otherwise null.

The cursor is the shared history cursor from Section 5.4. A missing or empty cursor is the first page. A cursor is not a host selector. Rows that do not belong to the caller are never queried.

Invalid `limit` or `cursor` is HTTP 400 and does not query:

```json
{ "statusCode": 400, "error": "invalid_page", "message": "Choose a page size from 1 to 50." }
```

```json
{ "statusCode": 400, "error": "invalid_cursor", "message": "That page cursor is not valid." }
```

A new migration adds `rooms_host_created_idx` on `(host_id, created_at DESC, id DESC)` and its `down` drops only that index. Register it after `CreateBroadcasts1793577600000`. Leave `synchronize` and `migrationsRun` off. Do not edit the original rooms migration. Existing room rows stay.

The entity may declare the same index name. The migration SQL is the authority for the descending order.

### 5.3 Broadcast history and thumbnail

`GET /api/rooms/:slug/broadcasts` keeps slug capability: any authenticated guest, same `room_not_found` behavior, no host filter. The body becomes a page with the same `limit` and `cursor` rules as Section 5.2. Order stays `createdAt DESC, id DESC`.

```json
{
  "items": [],
  "nextCursor": null
}
```

Each item is `BroadcastResponse` plus `thumbnailUrl`. Update shared parsing, the API catalog, the web parser, catalog fixtures, and `scripts/smoke-broadcast.mjs` in the same slice. Smoke reads `items` and no longer treats the body as an array.

`thumbnailUrl` is `/api/broadcasts/{id}/thumbnail.jpg` only when the stored `thumbnailPath` is exactly `broadcasts/{id}/thumbnail.jpg`. Every other stored value, including null, is `thumbnailUrl: null`. `playlistPath` and `thumbnailPath` remain absent from JSON. The socket snapshot's `broadcast` field does not gain a thumbnail.

`GET /api/broadcasts/:id/thumbnail.jpg` requires the bearer token. It serves that one filename from the broadcast directory only after the row's stored path matches the rule above and the real path is a file inside that directory. Reuse the HLS confinement checks. Any other name, a missing file, a symlink escape, or a non-matching row is 404 `media_not_found`. The response type is `image/jpeg` and the cache header is private. The route stays on the ordinary HTTP admission budget. It is not an HLS read and it is not exempt.

This phase does not write `thumbnail.jpg` and does not run FFmpeg for a thumbnail. A null thumbnail leaves `READY` unchanged.

The client loads a non-null thumbnail with the bearer header and an object URL. It does not put the token in the query string and does not point an image element at the API path directly. A null URL or a failed fetch uses a stable fallback that shows the status and does not look like a broken image. Playback does not wait for the thumbnail.

### 5.4 Shared page and link rules

Add these error codes to `ApiErrorBody`: `invalid_page`, `invalid_cursor`, and `invalid_room_link`. The API emits the first two. The room-link code is returned by the client parser and is not an API response.

`parseCatalogLimit` accepts a missing value as 20. It accepts a string of digits without a leading zero whose integer value is 1 through 50. Everything else, including arrays, blanks, `0`, `51`, and `020`, is `invalid_page`.

The history cursor is unpadded base64url of the ASCII text `v1\n`, the instant, `\n`, and the lowercase UUID. The instant matches the catalog rule: `YYYY-MM-DDTHH:mm:ss.sssZ`, and it must equal `new Date(value).toISOString()`. `encodeHistoryCursor` returns null for anything else. `parseHistoryCursor` accepts a missing or empty value as the first page and rejects every other malformed value with `invalid_cursor`. Parsing does not query and does not grant access.

`parseRoomJoinTarget(input, origin)` trims a string and then accepts:

- a value `isRoomSlug` accepts;
- a path that is exactly `/r/` plus that slug, with no query, hash, extra segment, or backslash;
- an `http` or `https` URL whose origin equals the supplied origin and whose path is exactly `/r/` plus that slug, with no username, password, query, or hash.

Reject replay paths, other origins, protocol-relative URLs, and any value the URL parser would rewrite. The failure is `invalid_room_link` with `Enter a room slug or a link to a room on this app.` The API still receives only the slug.

The invitation string is the page origin plus `/r/` plus the slug, built with the URL constructor.

### 5.5 Workspace behavior

The create and join actions stay on `/` and stay available above the list. The list heading is **Rooms from this guest session**. Beside it, while a session exists, the page says that these rooms belong to this guest session and that a new or expired session cannot find them by typing the same display name.

Each row shows title, mode, catalog status, and creation time. The time uses a `time` element whose `dateTime` is the catalog instant. **Open room** goes to the existing `/r/{slug}` route. **Copy invitation** writes the invitation URL. If the clipboard rejects it, the URL stays visible in a read-only field and the status says it was not copied. Success is a status message, not a navigation.

**Recordings** loads that room's broadcast page only after the guest asks. It does not mount `LiveRoom`, open a socket, or import the player. Each attempt shows its status word: `STARTING`, `LIVE`, `STOPPING`, `READY`, or `FAILED`. A non-empty `errorMessage` is shown. **Watch replay** is a link to `/replay/{id}` only when the status is `READY` and `playlistUrl` is a catalog playlist URL. An ended room can still show a READY replay. An empty history says the room has no broadcast attempts.

Load more appends the next page and does not discard rows already shown. Rows are deduplicated by id. The control is absent when `nextCursor` is null. A later page error keeps the rows already shown.

Query keys for the room list and the recording pages start with `private` and the session user id, so the existing session subscription drops them when the guest changes. The list is not fetched without a token.

The home source still must not contain `hls`. The room route and the replay route stay dynamically imported.

### 5.6 Restart and old links

API restart keeps the existing fail-in-flight behavior. `READY` rows and their playlists stay. The workspace reads those rows through the catalog. It does not read Redis presence and does not show a suspended participant.

Owning a room in the host list does not change who may open `/replay/{id}` or `GET /api/broadcasts/:id`. A guest who knows the replay link can still watch a READY recording.

## 6. Acceptance matrix

| ID    | Observable result                                                                                                                                                                                                                                    | Method                                                                                                    | Status                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| WS-01 | Two guest sessions. Each list contains only that guest's rooms. A `hostId` query for the other guest does not change the result. The home page reuses the session for a second create, and a new guest with the same display name sees an empty list | API service test and a browser session                                                                    | API passed; browser partial                       |
| WS-02 | The raw slug and this app's `/r/{slug}` URL open the same room. Another origin, a replay URL, a query string, and a short slug fail with `invalid_room_link` and do not navigate. Existing room and replay entry still render                        | Shared parser tests and a browser join                                                                    | parser passed; browser partial                    |
| WS-03 | One history page can show all five statuses. Only `READY` with a catalog playlist links to the current replay route. After an API restart the READY row is still listed and its replay plays. Smoke reads the page object and still finishes READY   | API catalog test, web history test, `pnpm smoke:broadcast` when disposable services exist, browser replay | catalog tests passed; smoke and replay unverified |

WS-01 includes the visible session-limit sentence. WS-03 includes a null thumbnail and a fallback. A missing browser or disposable Postgres leaves only the corresponding method unverified. On 2026-11-03 the broadcast catalog service test shows `STARTING`, `LIVE`, `STOPPING`, `READY`, and `FAILED` on one page. The home workspace tests cover replay links, private catalog queries, and a home page that does not mention `hls`. On 2026-11-04 V2P5-C03 pointed the smoke assertion at `CreateUsersAndRooms1730332800000`, `CreateBroadcasts1793577600000`, and `IndexRoomsByHost1793664000000`, then an empty second run. `pnpm smoke:broadcast` was still not run because `FFMPEG_PATH` is the bare name `ffmpeg` and `ffmpeg` is not on PATH, so the smoke half of WS-03 and READY replay stay unverified. The combined session saw a second guest with the same display name and an empty room list, and the raw slug plus this app's `/r/{slug}` link opened the same room. An unknown slug stayed on the home page with the API error. Another origin, a replay URL, a query string, and a short slug were not repeated in that browser.

## 7. Verification commands

These commands already exist. Run the package checks for the slices that changed, and the smoke only when its disposable Postgres, Redis, and FFmpeg are available.

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
pnpm smoke:broadcast
```

`pnpm smoke:broadcast` builds the API, creates its own database, and runs the migrations. Do not point it at the developer database.

Search from the repo root after the web slice:

```powershell
rg -n "hls" apps/web/src/pages/HomePage.tsx
```

That search prints nothing.

## 8. Risks

| Risk                                                                          | What to do                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| A caller-supplied host id lists another guest's rooms                         | Section 5.2. The only host is the authenticated user          |
| Every create mints a guest, so the list never accumulates                     | Section 5.1. Reuse a usable session                           |
| The same display name is treated as recovering the old rooms                  | Section 5.1. A new guest is a new user, and the page says so  |
| The broadcast array change leaves smoke unable to find `LIVE` or `FAILED`     | Section 5.3. Update the smoke in the same slice               |
| The thumbnail route reads `thumbnailPath` as a client path or leaks the token | Section 5.3. One confined filename, bearer header, object URL |
| The home page imports the player or `hls.js` to show a preview                | Section 5.5. Link to the existing replay route                |
| `LIVE` is labeled as the host being online                                    | Section 1. Catalog status is not presence                     |
| Replay links become host-only while fixing the list                           | Section 5.6. Slug and replay capability stay                  |
| Offset paging skips or repeats a row created during the next fetch            | Section 5.2. Keyset on `created_at` and `id`                  |
| Device capture, reconnect, or chat starts inside the workspace slice          | Section 3.2. Stop at the catalog                              |

## 9. Exit and handoff

V2-P1 is done when WS-01 through WS-03 have a result, each slice is committed under V1 master Section 1.4, and the README describes the guest-session list, the page bounds, the invitation rule, the optional thumbnail, and the unchanged replay links. A check that could not be run stays unverified with a reason. P3-A03, P3-A05, and P3-A06 stay open.

V2-P2 may rely on the current guest remaining the host of rooms created from the workspace, the paged room list, the paged broadcast catalog, `thumbnailUrl` being null when no thumbnail file was stored, and the existing mesh and recording pipeline. It may not rely on in-call device changes. Do not start those changes in V2P1-C05.

V2 phase 2 is specified in [phase2.md](phase2.md). That file does not authorize implementation.
