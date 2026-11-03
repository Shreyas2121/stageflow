# Guide — V2 Phase 1, commit by commit

**Status:** V2P1-C01, V2P1-C02, and V2P1-C03 are committed. V2P1-C04 is verified. V2P1-C05 remains planned.\
**Last updated:** 2026-11-03.\
**Phase contract:** [../phase1.md](../phase1.md).\
**Product authority:** [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md) version `2.0.0-draft.2`. Unchanged V1 rules stay in [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.9`.\
**Deliverable:** The current guest can find created rooms, copy an invitation, and open existing replay history, in five commits. This is the only V2 Phase 1 guide. Its commit ids are not the V1 Phase 1 commits in [../V1/phase1/guide.md](../V1/phase1/guide.md).

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `0267919feb41da48eda803498666e3f2b88d3f37`. The worktree was dirty when this guide was written. Recheck it.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run V2P1-C01 through V2P1-C05 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing.
4. After verification, commit that slice under V1 master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(v2-phase1): record the final slice hash`.
5. If a browser cannot be used, leave the browser half of the related acceptance id unverified and name the gap.
6. If disposable Postgres, Redis, or FFmpeg is missing, leave the `pnpm smoke:broadcast` half of WS-03 unverified. Do not point the smoke at the developer database, and do not delete developer recordings to make it pass.

Keep guest JWT lifetime, slug fetch, replay fetch, the mesh, moderation, and the broadcast pipeline. Do not add an account, a device change, reconnect, or chat.

### 1.1 Commit index

| Order | ID       | Proposed message                                                     | Acceptance          |
| ----- | -------- | -------------------------------------------------------------------- | ------------------- |
| 1     | V2P1-C01 | `feat(shared): parse a room link and a history cursor`               | WS-02 parser        |
| 2     | V2P1-C02 | `feat(api-rooms): list rooms for the current guest`                  | WS-01               |
| 3     | V2P1-C03 | `feat(api-broadcast): page broadcast history and expose a thumbnail` | WS-03 catalog       |
| 4     | V2P1-C04 | `feat(web-home): show this guest's rooms and recordings`             | WS-01, WS-02, WS-03 |
| 5     | V2P1-C05 | `docs(readme): describe the guest room workspace`                    | README limits       |

### 1.2 Files to inspect before editing

- `packages/shared/src/contracts.ts`, `contracts.test.ts`, `broadcast.ts`, `limits.ts`, and `index.ts`
- `apps/api/src/rooms/rooms.controller.ts`, `rooms.service.ts`, and `room.entity.ts`
- `apps/api/src/broadcasts/broadcasts.controller.ts`, `broadcasts.service.ts`, `broadcasts.service.test.ts`, and `hls-path.ts`
- `apps/api/src/database/data-source.ts`
- `apps/api/src/migrations/1730332800000-CreateUsersAndRooms.ts` and `1793577600000-CreateBroadcasts.ts`
- `apps/api/src/admission/http-admission.test.ts`
- `apps/web/src/pages/HomePage.tsx`, `RoomPage.tsx`, `ReplayPage.tsx`, and `App.tsx`
- `apps/web/src/app/entry-graph.test.ts`
- `apps/web/src/features/rooms/api.ts` and `query-options.ts`
- `apps/web/src/features/session/session-store.ts` and `guest-entry.ts`
- `apps/web/src/features/broadcast/api.ts` and `services/playback.ts`
- `scripts/smoke-broadcast.mjs`
- `README.md`

## 2. V2P1-C01 — Room link and history cursor

**Status:** committed\
**Proposed commit message:** `feat(shared): parse a room link and a history cursor`\
**Actual commit:** `49eac3904afac2ed6db45c8b8186fc490935c63e`

**Why:** Join and both list routes need one page-size rule, one cursor, and one invitation parser before either app grows a route. Covers the parser half of WS-02.

**Depends on:** The shared Vitest setup.

**Files:**

- `packages/shared/src/contracts.ts`
- `packages/shared/src/contracts.test.ts`
- `packages/shared/src/catalog-page.ts`
- `packages/shared/src/catalog-page.test.ts`
- `packages/shared/src/index.ts`

**Implementation:**

1. Add `invalid_page`, `invalid_cursor`, and `invalid_room_link` to `ApiErrorBody['error']`. The API does not emit `invalid_room_link` in this slice.
2. Add `parseRoomJoinTarget(input, origin)` in `contracts.ts` using the phase Section 5.4 cases. Trim first. Accept a slug, an exact `/r/{slug}` path, and an absolute `http` or `https` URL on the supplied origin. Reject replay URLs, other origins, protocol-relative URLs, queries, hashes, userinfo, extra segments, backslashes, and values the URL parser rewrites. Use a fixed dummy origin for path-only values, in the same way `replayReturnPath` refuses rewritten paths.
3. Add `packages/shared/src/catalog-page.ts` and export it from `index.ts`. `CATALOG_PAGE_DEFAULT` is 20 and `CATALOG_PAGE_MAX` is 50. `parseCatalogLimit` accepts a missing value as 20 and an unpadded integer string from 1 to 50. `0`, `51`, `020`, blanks, arrays, and non-strings are `invalid_page` with `Choose a page size from 1 to 50.`
4. `encodeHistoryCursor(createdAt, id)` returns unpadded base64url of `v1\n${instant}\n${lowercaseUuid}`, or null when the instant does not round-trip through `toISOString` or the id is not a UUID. `parseHistoryCursor` maps a missing or empty value to `{ ok: true, value: null }`. Every other malformed value is `invalid_cursor` with `That page cursor is not valid.` A valid cursor parses back to the same instant and lowercase id.
5. Tests use plain values. Include a slug `Ab12Cd34Ef56`, origin `https://stageflow.test`, the matching absolute URL, the path form, a whitespace-padded slug, a replay URL, `https://evil.example/r/Ab12Cd34Ef56`, a query, a hash, a short slug, and `//stageflow.test/r/Ab12Cd34Ef56`. Include limit values 20, missing, `1`, `50`, `0`, `51`, and `020`. Include a cursor round-trip, an empty cursor, a padded base64 value, and a cursor whose instant is not canonical.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm typecheck
pnpm lint
```

**Done when:** The parser cases above pass and the slice is committed.

**Handoff:** No route reads the new parsers yet. `BroadcastResponse` is unchanged.

## 3. V2P1-C02 — Current guest's rooms

**Status:** committed\
**Proposed commit message:** `feat(api-rooms): list rooms for the current guest`\
**Actual commit:** `538e01788b03f3b1993a26d6aef14fe44bb4e579`

**Why:** The workspace needs a server-owned host list before the page can show one. Covers the API half of WS-01.

**Depends on:** V2P1-C01. `RoomsService.create` and `getBySlug` stay.

**Files:**

- `apps/api/src/migrations/<timestamp>-IndexRoomsByHost.ts`
- `apps/api/src/database/data-source.ts`
- `apps/api/src/rooms/room.entity.ts`
- `apps/api/src/rooms/rooms.service.ts`
- `apps/api/src/rooms/rooms.service.test.ts`
- `apps/api/src/rooms/rooms.controller.ts`

**Implementation:**

1. Add a migration whose timestamp is greater than `1793577600000`. `up` runs `CREATE INDEX rooms_host_created_idx ON rooms (host_id, created_at DESC, id DESC)`. `down` drops only that index. Register the class in `data-source.ts` after the broadcasts migration. Leave `synchronize` and `migrationsRun` off. Do not edit `1730332800000-CreateUsersAndRooms.ts`.
2. Declare `@Index('rooms_host_created_idx', ['hostId', 'createdAt', 'id'])` on `Room`. The migration remains the authority for descending order.
3. Add `listForHost(host, query)` on `RoomsService`. Parse `limit` and `cursor` with the shared helpers. On a failed parse, throw `ApiException` with that status, error, and message, and do not touch the repository. Read no host id from `query`.
4. Query `host_id = host.id` only. Order `createdAt DESC, id DESC`. Take `limit + 1`. With a cursor, add a keyset predicate for `(created_at, id)` strictly before the cursor in that order, comparing `id` as a UUID. Map the returned entities with the same `RoomResponse` fields `getBySlug` already returns, including the host display name. If the extra row exists, drop it and set `nextCursor` from the last kept row through `encodeHistoryCursor`. If encoding fails, throw a 500 rather than returning a cursor `parseHistoryCursor` would reject. Otherwise `nextCursor` is null.
5. Add `@Get()` on `RoomsController` before `@Get(':slug')`. It passes `@CurrentUser()` and the `limit` and `cursor` query values. If either query value is an array, treat it as invalid through the shared parser. `@Get(':slug')` stays public to every authenticated guest.
6. Service tests use a repository fake, not the developer database. Cover: the where parameter is the caller's id when `query.hostId` is someone else; an invalid limit and an invalid cursor never call the repository; a missing limit requests 21 rows; 21 fake rows become 20 items and a cursor that parses to the 20th row; 2 rows produce `nextCursor: null`; a cursor query passes both the instant and the id into the keyset predicate. Follow the mock style in `broadcasts.service.test.ts`.

**Verification:**

```powershell
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** WS-01's API cases pass and the slice is committed.

**Handoff:** The home page does not call `GET /api/rooms` yet. Broadcast history is still a JSON array.

## 4. V2P1-C03 — Paged broadcast history and thumbnail

**Status:** committed\
**Proposed commit message:** `feat(api-broadcast): page broadcast history and expose a thumbnail`\
**Actual commit:** `595fe276a6af6e67e3c8526189340dd79e91c153`

**Why:** The existing list is unbounded and smoke still depends on it. The catalog can name a thumbnail without generating one. Covers the catalog half of WS-03.

**Depends on:** V2P1-C01. V2P1-C02 is independent and already committed.

**Files:**

- `packages/shared/src/broadcast.ts`
- `packages/shared/src/broadcast.test.ts`
- `apps/api/src/broadcasts/broadcasts.service.ts`
- `apps/api/src/broadcasts/broadcasts.service.test.ts`
- `apps/api/src/broadcasts/broadcasts.controller.ts`
- `apps/api/src/broadcasts/hls-path.ts`
- `apps/api/src/broadcasts/hls-path.test.ts`
- `apps/api/src/admission/http-admission.test.ts`
- `apps/web/src/features/broadcast/api.test.ts`
- `scripts/smoke-broadcast.mjs`
- Every other fixture that `parseBroadcast` now rejects because `thumbnailUrl` is missing

**Implementation:**

1. Add `thumbnailUrl: string | null` to `BroadcastResponse`. `parseBroadcast` accepts null or exactly `/api/broadcasts/{uuid}/thumbnail.jpg` for that same id. Reject every other string, including a playlist path, an absolute URL, and a path for a different id. Update the shared broadcast tests and the web catalog fixtures so a parsed body still round-trips.
2. Change `listByRoomSlug(slug, query)` to return `{ items, nextCursor }`. Resolve the room with `getBySlug` first, so a bad slug still throws `room_not_found` and does not query broadcasts. Apply the same limit, cursor, extra-row, and order rules as the room list. Do not filter by host. Keep `getById` as one object.
3. `catalog` sets `thumbnailUrl` to `/api/broadcasts/{id}/thumbnail.jpg` only when the stored path is exactly `broadcasts/{id}/thumbnail.jpg`. Otherwise `thumbnailUrl` is null. The JSON still omits the stored playlist and thumbnail paths. Do not add `thumbnailUrl` to the socket snapshot.
4. Add a confined `thumbnail.jpg` path helper next to `hlsPath`. It accepts only that filename, then uses the existing directory realpath checks. `GET broadcasts/:id/thumbnail.jpg` calls it only when the row's stored path matches the catalog rule and the file exists. Otherwise throw 404 `media_not_found`. Set `Content-Type: image/jpeg` and `Cache-Control: private`. Do not add the file to the HLS filename regex and do not write a thumbnail from FFmpeg.
5. Assert in `http-admission.test.ts` that `GET /api/broadcasts/{id}/thumbnail.jpg` is `control`.
6. Update the list test in `broadcasts.service.test.ts`. It currently expects an array and a `find` ordered by `createdAt DESC, id DESC`. Expect the page object, the default take of 21, and `thumbnailUrl: null`. Add one row whose `thumbnailPath` is the expected relative path and expect the catalog URL. Add one row whose path is `broadcasts/other/thumbnail.jpg` and expect null.
7. In `scripts/smoke-broadcast.mjs`, replace both array reads of `/rooms/${slug}/broadcasts` with `items`. The newest `LIVE` row and the newest missing-FFmpeg `FAILED` row stay at `items[0]`. Assert `thumbnailUrl` is null. Leave the READY playlist, segment, and restart checks in place.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

Run `pnpm smoke:broadcast` when disposable Postgres, Redis, and FFmpeg are available. If they are not, record WS-03's smoke half as unverified.

**Done when:** The five catalog statuses can be represented in one page by the service test, smoke compiles against the page object, and the slice is committed.

**Handoff:** The home page still does not render history. Replay continues to load one broadcast by id.

## 5. V2P1-C04 — Workspace on the home page

**Status:** verified\
**Proposed commit message:** `feat(web-home): show this guest's rooms and recordings`\
**Actual commit:**

**Why:** The guest can now see and use the catalog without entering the live room. Covers the browser half of WS-01 through WS-03.

**Depends on:** V2P1-C02 and V2P1-C03.

**Files:**

- `apps/web/src/features/rooms/api.ts`
- `apps/web/src/features/rooms/query-options.ts`
- `apps/web/src/features/rooms/history.ts`
- `apps/web/src/features/rooms/history.test.ts`
- `apps/web/src/features/rooms/room-list.tsx`
- `apps/web/src/features/rooms/room-history.tsx`
- `apps/web/src/features/rooms/thumbnail.tsx`
- `apps/web/src/pages/HomePage.tsx`
- `apps/web/src/app/entry-graph.test.ts`

**Implementation:**

1. Add `replayHref(broadcast)` in `history.ts`. Return `/replay/${id}` only when `status` is `READY` and `playlistUrl` passes `isBroadcastPlaylistUrl`. Return null for `STARTING`, `LIVE`, `STOPPING`, `FAILED`, a READY row without a playlist, and a READY row with a non-catalog playlist. Test those cases. This module imports shared catalog helpers only. It does not import `playback.ts`, the player, or `hls.js`.
2. Extend the rooms client with `listRooms(token, cursor, signal)` and `listBroadcasts(slug, token, cursor, signal)`. Parse pages with the existing room and broadcast parsers. Reject a room page unless every `hostId` equals the session user id. A 401 still clears that token. Query keys are `['private', userId, 'rooms', cursor]` and `['private', userId, 'room-broadcasts', slug, cursor]`. Use `skipToken` without a session. Do not send `hostId` or a limit above 50. Omit `limit` to take the default of 20.
3. Change `HomePage` so a usable session skips `createGuest` for both create and join. The name field is shown only when no usable session exists. **Use a different name** calls `clearSession` and is preceded by the sentence that the current rooms stay with this guest token and a new session cannot find them by display name. Join runs `parseRoomJoinTarget` against `window.location.origin` and then `getRoom`. Remove the 12-character `maxLength` from the join field so a pasted URL is not truncated. Keep one abort controller for the submit in flight.
4. Render the list below the create and join forms. The heading is `Rooms from this guest session`. While a session exists, show: `These rooms belong to this guest session. A new or expired session cannot find them by typing the same display name.` Also show that `LIVE` means the room has not ended and does not mean someone is connected. Each row shows title, mode, status, a `time` element, **Open room**, **Copy invitation**, and **Recordings**.
5. Copy `{origin}/r/{slug}` with the clipboard API. On success, announce it in a `role="status"` message. On failure, show the URL in a read-only control and say it was not copied. **Open room** is a link to `/r/{slug}`.
6. **Recordings** fetches the first broadcast page only after it is opened. Append later pages on **Load more**, dedupe by id, and keep already loaded rows if a later page fails. Render each status word. Show a trimmed `errorMessage` when it is non-empty. Render **Watch replay** only from `replayHref`. An empty page says the room has no broadcast attempts. `thumbnail.tsx` fetches a non-null `thumbnailUrl` with the bearer header, displays the object URL, and revokes it when the row changes or the view unmounts. A null URL or a failed fetch is a fallback that shows the status and is not a broken image. Do not put the token in the URL.
7. Keep the list outside the form `fieldset`, so a pending create does not freeze the list. Do not mount `LiveRoom`. Extend `entry-graph.test.ts` so `HomePage.tsx` still contains no `hls` and does not import `broadcast-player`, `broadcast-player-gate`, or `hls.js`.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
rg -n "hls" apps/web/src/pages/HomePage.tsx
```

The search prints nothing.

Browser, with the local API and web app:

1. Enter as Ava, create a meeting, return home, and create a webinar without typing the name again. Both rooms appear. A second browser profile as Sam, using the same display name, sees no rooms.
2. Copy the invitation, paste it into Join, and land on that room. Paste the raw slug and land on it again. Paste a replay URL and another origin's room URL. Both fail and the route does not change.
3. Open recordings for a room that has a READY attempt and a failed attempt. The statuses are distinct, the failure reason is visible, and only READY follows to the existing replay player. Confirm the home document did not load `hls.js`.
4. Restart the API. The READY row remains and the replay still plays. Catalog `LIVE` is not described as the host being online.
5. Use **Use a different name**, create a room, and confirm Ava's rooms are gone from the list. Use the keyboard for create, join, copy, recordings, load more, and the replay link.

If no browser is available, leave those observations unverified and keep the automated results.

**Done when:** The browser script above has a recorded result, or an explicit unverified gap, and the slice is committed.

**Handoff:** Replay guest entry, the live room, and the player chunks are unchanged.

## 6. V2P1-C05 — README

**Status:** planned\
**Proposed commit message:** `docs(readme): describe the guest room workspace`\
**Actual commit:**

**Why:** The product README still says V2 has not started. After the workspace exists, a reader needs the session limit and the catalog bounds in the same place as the other limits. Covers the documentation half of the phase exit.

**Depends on:** V2P1-C04.

**Files:**

- `README.md`
- `plans/phase1.md`
- `plans/phase1/guide.md`
- `plans/README.md`

**Implementation:**

1. Replace the sentence that says V2 implementation has not started. State that the home page lists rooms for the current guest session, that create and join reuse that session, and that **Use a different name** starts a different guest. State that the same display name does not recover rooms.
2. Add `GET /api/rooms` to the route list. State that `GET /api/rooms/:slug/broadcasts` returns `{ items, nextCursor }`, default 20 and maximum 50, ordered by creation time and id. Keep the existing slug and replay routes in that list.
3. State that `LIVE` in the room list is the catalog status. State that a recording shows `STARTING`, `LIVE`, `STOPPING`, `READY`, or `FAILED`, and that only `READY` opens the replay. State that `thumbnailUrl` is optional and that this build does not generate thumbnails.
4. Mention the host-list index in the migration paragraph. State that existing replay links remain usable by any guest who has the link.
5. Keep the V1 physical-observation gap explicit. Do not describe device switching, reconnect, chat, or accounts as present.
6. Record each slice hash in this guide. Set the phase contract and `plans/README.md` status from the verification that actually ran. Leave a browser or smoke gap as unverified rather than planned.

**Verification:**

Read the edited README against phase Section 5. `pnpm exec prettier --check README.md plans/phase1.md plans/phase1/guide.md plans/README.md` passes.

**Done when:** The README matches the shipped workspace and this guide names every slice hash.

**Handoff:** V2-P2 has not been written. Do not add device capture in this commit.
