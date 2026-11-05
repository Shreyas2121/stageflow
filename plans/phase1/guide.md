# Guide — V3 Phase 1, commit by commit

**Status:** in progress. V3P1-C01 through V3P1-C05 supply parsers, credentials, versioned tokens, account routes, and the home account flows. ID-01 through ID-04 are verified. V3P1-C06's README work is planned.\
**Last updated:** 2026-11-05.\
**Phase contract:** [../phase1.md](../phase1.md).\
**Product authority:** [MASTER_PLAN_V3.md](../../MASTER_PLAN_V3.md) version `3.0.0-draft.2`. Unchanged V2 rules stay in [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md) version `2.0.0-draft.9`. Unchanged V1 rules stay in [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.9`.\
**Deliverable:** A guest can become a host, and that host can log in again and see the same rooms, in six commits. This is the only V3 Phase 1 guide. Its commit ids are not the V1 Phase 1 commits in [../V1/phase1/guide.md](../V1/phase1/guide.md) or the V2 Phase 1 commits in [../V2/phase1/guide.md](../V2/phase1/guide.md).

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `03ac691f661a`. The worktree was dirty when this guide was written. Recheck it.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run V3P1-C01 through V3P1-C06 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing.
4. After verification, commit that slice under V1 master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(v3-phase1): record the final slice hash`.
5. If a browser cannot be used, leave the browser half of ID-01, ID-02, ID-03, and ID-04 unverified and name the gap.
6. If disposable Postgres is missing, leave the migration-run half unverified. Do not point a migration at the developer database, and do not delete developer rows to make it pass.

Keep the guest create route, demo peers, the mesh, reconnect, chat, and the broadcast pipeline. Do not add Google, scheduling, replay privacy, deletion, or Q&A.

### 1.1 Commit index

| Order | ID       | Proposed message                                                      | Acceptance          |
| ----- | -------- | --------------------------------------------------------------------- | ------------------- |
| 1     | V3P1-C01 | `feat(shared): parse a host email and password`                       | ID-01 parsers       |
| 2     | V3P1-C02 | `feat(api-auth): store a host password and version tokens`            | ID-02, ID-04        |
| 3     | V3P1-C03 | `feat(api-auth): register and log in a host`                          | ID-01               |
| 4     | V3P1-C04 | `feat(api-auth): promote the current guest and change the password`   | ID-02, ID-03        |
| 5     | V3P1-C05 | `feat(web-home): sign in, promote a guest, and show the host library` | ID-01 through ID-04 |
| 6     | V3P1-C06 | `docs(readme): describe host accounts and guest promotion`            | README limits       |

### 1.2 Files to inspect before editing

- `packages/shared/src/contracts.ts`, `contracts.test.ts`, `limits.ts`, and `index.ts`
- `apps/api/src/users/user.entity.ts`
- `apps/api/src/sessions/sessions.service.ts`, `sessions.service.test.ts`, `sessions.controller.ts`, and `sessions.module.ts`
- `apps/api/src/database/data-source.ts`
- `apps/api/src/migrations/1793664000000-IndexRoomsByHost.ts`
- `apps/api/src/admission/http-admission.ts` and `http-admission.test.ts`
- `apps/api/src/live/live.connection.ts`, `live.module.ts`, and `signaling.gateway.ts`
- `apps/api/package.json`
- `apps/web/src/pages/HomePage.tsx`
- `apps/web/src/features/session/api.ts`, `session-store.ts`, and `session-store.test.ts`
- `apps/web/src/features/rooms/room-list.tsx`
- `apps/web/src/app/entry-graph.test.ts`
- `scripts/smoke-broadcast.mjs`
- `README.md`

## 2. V3P1-C01 — Email and password parsers

**Status:** committed\
**Proposed commit message:** `feat(shared): parse a host email and password`\
**Actual commit:** `9cfa046c068bf66ff9ac2da3c4c38f2fb28a802f`

**Why:** Register, login, promote, and password change need one email rule and one password rule before either app grows a route. Covers the parser half of ID-01.

**Depends on:** The shared Vitest setup.

**Files:**

- `packages/shared/src/account.ts`
- `packages/shared/src/account.test.ts`
- `packages/shared/src/contracts.ts`
- `packages/shared/src/index.ts`

**Implementation:**

1. Add `invalid_email`, `invalid_password`, `email_taken`, `not_guest`, `not_registered`, `membership_active`, and `wrong_password` to `ApiErrorBody['error']`. Nothing emits them yet.
2. Add `parseEmail` and `parsePassword` with the phase Section 5.2 cases. Export them from `index.ts`.
3. Tests use plain values. Accept `Ava@Example.com` as `ava@example.com`. Accept `a@b.co`. Reject `ava`, `ava@`, `@example.com`, `ava@example`, `ava example@example.com`, a newline, a 255-character address, and a non-string.
4. Accept a password of 8 `a` characters and a 72-byte ASCII password. Reject 7 characters, 73 ASCII characters, a string whose UTF-8 form exceeds 72 bytes, a leading newline, and a non-string. Do not trim a password that starts or ends with a space when the rest is long enough.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm typecheck
pnpm lint
```

**Done when:** The parsers accept and reject the cases above, and no API route exists for them yet.

**Verification record (2026-11-05):**

- `pnpm --filter @stageflow/shared test -- src/account.test.ts` passed all 46 account cases.
- `pnpm --filter @stageflow/shared test` passed all 309 tests in 11 files.
- `pnpm typecheck` and `pnpm lint` passed across the workspace.
- `pnpm check:affected --plan --files packages/shared/src/account.ts packages/shared/src/account.test.ts packages/shared/src/contracts.ts packages/shared/src/index.ts` selected `pnpm check:release`. That run passed all 49 tooling, 309 shared, 428 web, and 237 API tests, workspace typecheck/lint, both app builds, repository formatting, artifact checks, and `pnpm smoke:live`.
- `pnpm check:release` failed at its final `pnpm smoke:broadcast` step: `spawn ffmpeg ENOENT` while probing `ffmpeg -version`. No FFmpeg version, broadcast result, or migration-run result was obtained. This does not close any open V1/V2 acceptance gap.
- Prettier passed on all seven changed files. Local links in the changed phase records resolve; the phase contract's two archived-guide links were corrected.
- Coverage includes email normalization and the 254/255-character boundary, every ASCII control character before/within/after an address or password, unchanged password spaces, the 72-byte UTF-8 boundary, and the eight-code-point minimum with astral characters.
- ID-01's parser coverage is verified. Account API routes and browser flows remain planned for later slices; ID-02 through ID-04 are not marked verified. No API route was added.

## 3. V3P1-C02 — Password hash and token claims

**Status:** committed\
**Proposed commit message:** `feat(api-auth): store a host password and version tokens`\
**Actual commit:** `18ba20e23f73948048221234171b0671d8fcd1fa`

**Why:** Guest tokens issued after this slice carry `sv` and `guest`, and old guest tokens still verify. Later slices can register against that row. Covers the token half of ID-02 and the guest-token half of ID-04.

**Depends on:** V3P1-C01.

**Files:**

- `apps/api/package.json` and the lockfile
- `apps/api/src/sessions/password.ts`
- `apps/api/src/sessions/password.test.ts`
- `apps/api/src/users/user.entity.ts`
- `apps/api/src/migrations/1793923200000-AddHostCredentials.ts`
- `apps/api/src/database/data-source.ts`
- `apps/api/src/sessions/sessions.service.ts`
- `apps/api/src/sessions/sessions.service.test.ts`
- `apps/api/src/users/user.integration.test.ts`
- `apps/api/src/database/catalog-cursor.integration.test.ts`
- `scripts/smoke-broadcast.mjs`
- `scripts/smoke-live.mjs`

**Implementation:**

1. Add the `bcryptjs` dependency to `@stageflow/api`. Do not add native `bcrypt`. Put `hashPassword` and `verifyPassword` in `password.ts`. Cost is 12. A test hashes one short password, checks that the stored string contains `$12$`, checks that the plaintext is absent, and checks that a different password fails.
2. Add the migration from phase Section 5.1. Register it after `IndexRoomsByHost1793664000000` in `data-source.ts`. Append `AddHostCredentials1793923200000` to the expected list in `scripts/smoke-broadcast.mjs`.
3. Map the columns on `User`. `passwordHash` is `select: false`. Defaults keep existing guest inserts valid: null email, null hash, `isGuest: true`, `sessionVersion: 0`.
4. `createGuest` still inserts a guest. It signs `{ sub: user.id, sv: user.sessionVersion, guest: true }` with `{ expiresIn: '12h' }`. Leave the module default at `12h`.
5. `verifyToken` applies phase Section 5.3. Missing `sv` is `0`. Missing `guest` matches only a guest row. A boolean `guest` must match `isGuest`. A non-integer `sv` is `unauthorized`.
6. Update the pending-guest test. The released user includes `sessionVersion: 0` and `isGuest: true`. Expect `signAsync` to receive the guest claims and `expiresIn: '12h'`.
7. Add verify cases: a guest token with no `sv` and no `guest` still loads a version-0 guest; `sv: 1` on a version-0 user fails; `guest: false` on a guest fails; `guest: true` on a host fails; a missing user fails. Build those tokens with the same `JwtService` settings the app uses, or a test `JwtService` with the test secret. Do not log the secret.
8. Keep the existing catalog integration's migration assertion synchronized. Give the live smoke's in-memory guest rows `isGuest: true` and `sessionVersion: 0`; its legacy tokens continue to exercise backward compatibility. Add a disposable-database regression for existing guest defaults, nullable unique emails, hidden password selection, and migration rollback. Never migrate the developer database.

**Verification:**

```powershell
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** Existing guest verification still passes, the new claims are signed, and the migration is registered. Register and login routes are still absent.

**Verification record (2026-11-05):**

- The focused API command covering `src/sessions/password.test.ts`, `src/sessions/sessions.service.test.ts`, `src/users/user.integration.test.ts`, and `src/database/catalog-cursor.integration.test.ts` passed all 39 cases in four files.
- `pnpm --filter @stageflow/api test`, invoked by the release graph, passed all 274 tests in 25 files. Workspace `pnpm typecheck` and `pnpm lint` passed.
- The affected-check planner selected `pnpm check:release` plus the separate audit gate. The release run passed all 49 tooling, 309 shared, 428 web, and 274 API tests, both app builds, repository formatting, and artifact checks. It stopped at the live smoke because two later chat-user fixtures were missing the new guest fields. After correcting all four in-memory users, `pnpm smoke:live` passed, as did a fresh `pnpm lint:config`.
- A separate `pnpm smoke:broadcast` attempt failed at `ffmpeg -version` with `spawn ffmpeg ENOENT`. The complete release gate and broadcast path remain unverified. Migration execution is independently verified by the disposable PostgreSQL tests; this gap does not close any V1/V2 acceptance ID.
- `pnpm install --frozen-lockfile` passed with pnpm `12.9.1`. `pnpm audit:check` passed with no production advisories and only the existing explicit, unexpired development exceptions.
- Prettier passed on all 16 changed files, and local links in the changed phase records resolve. C01's recorded commit hash is included in this slice under the existing ledger rule.
- The catalog fixture applied all four registered migrations once to its random disposable database, then applied none. The credential fixture inserted a guest before the new migration and verified backfilled null credentials/version 0, new guest defaults, the unique non-null email index, hidden normal password-hash selection, and the down migration. Each fixture dropped only its owned database; the developer database was not migrated.
- Real HS256 tokens cover matching host/guest claims, legacy version-0 guests, missing claims, version mismatches, malformed claims, missing users, expiry, and algorithm rejection. The pending-guest regression asserts the new claims and explicit 12-hour signing option. The module default remains 12 hours.
- The catalog migration assertion and live smoke's in-memory guest rows were updated alongside the planned broadcast migration assertion. Password helpers use `bcryptjs` `3.0.3` at cost 12; the regression checks the stored format and both matching and different passwords.
- Register/login routes, password change, promotion, logout, and browser acceptance remain planned. ID-02 and ID-04 have only their token coverage verified by this slice; no complete acceptance ID is closed.

## 4. V3P1-C03 — Register and login

**Status:** committed\
**Proposed commit message:** `feat(api-auth): register and log in a host`\
**Actual commit:** `abef5bf94518801ebf36ceb8766c7440472e15c4`

**Why:** A host can be created and can return with the same email. A wrong password does not reveal whether the email exists. Covers ID-01 on the API.

**Depends on:** V3P1-C02.

**Files:**

- `apps/api/src/sessions/sessions.service.ts`
- `apps/api/src/sessions/sessions.service.test.ts`
- `apps/api/src/sessions/sessions.controller.ts`
- `apps/api/src/sessions/sessions.controller.test.ts`
- `apps/api/src/admission/http-admission.ts`
- `apps/api/src/admission/http-admission.test.ts`

**Implementation:**

1. `POST /api/sessions/register` reads `displayName`, `email`, and `password` from a JSON object. Parse each field. Ignore every other field. Insert `isGuest: false`, the lowercase email, the hash, and `sessionVersion: 0`. Sign a host token with `{ sub, sv: 0, guest: false }` and `{ expiresIn: '7d' }`. Return `{ token, userId, displayName }`.
2. A duplicate email, including a unique-constraint race (`23505`), throws HTTP 409 `email_taken` with `That email is already registered.` Do not attach the new row to an existing user.
3. `POST /api/sessions/login` reads `email` and `password`. Load the user with `passwordHash` selected. Compare against the stored hash, or against one lazily cached cost-12 dummy hash when the email is missing. Both failures throw HTTP 401 `unauthorized` with `Email or password is wrong.` Success signs a host token for that row's current `sessionVersion`.
4. Register and login do not read the Authorization header. A guest bearer does not turn register into promote.
5. Share one in-flight counter for this password work, capped by `GUEST_PENDING_LIMIT`. The existing guest-insert counter stays separate. Over the cap throws `server_busy` with `Account sign-in is busy. Try again shortly.` and does not start another hash.
6. Extend the guest network budget in `http-admission.ts` so `POST /api/sessions/register` and `POST /api/sessions/login` spend it the same way `/api/sessions/guest` does. The ordinary control budget still applies first. Cover both new paths in `http-admission.test.ts`.
7. Service tests use mocked repositories and a real `hashPassword` for one register-and-login pair. Assert the wrong-password and missing-email responses are the same error code and message. Assert a second register with that email does not call `save` a second time after the uniqueness failure is simulated. Assert `signAsync` receives `guest: false` and `expiresIn: '7d'`.
8. Exercise the actual controller routes on an owned loopback HTTP server with mocked persistence. Verify ignored bearer headers and extra fields, invalid JSON-object shapes and fields, and the host response/token shape. Service regressions also cover one shared cap across register/login, capacity release on success/failure, independence from guest inserts, and single-flight reuse of the lazy dummy hash.
9. Enforce the phase's no-credential-logging boundary by mapping unexpected account-work failures to a clean `server_busy` API error. Raw database errors can retain email/hash query parameters and must not reach Nest's default error logger. Preserve intentional API errors, including `email_taken` and `unauthorized`.

**Verification:**

```powershell
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** Register and login match Section 5.4, guest create is unchanged, and promote is still absent.

**Verification record (2026-11-05):**

- `pnpm --filter @stageflow/api test -- src/sessions/sessions.service.test.ts src/sessions/sessions.controller.test.ts src/admission/http-admission.test.ts` passed all 67 focused cases in three files. `pnpm typecheck` and `pnpm lint` passed across the workspace.
- The first full API test attempt could not reach the configured PostgreSQL/Redis services: PostgreSQL refused port 5432 and Redis closed its connection. The existing project containers were stopped. Owned temporary containers using the local `postgres:16` and `redis:7` images, tmpfs storage, random loopback ports, and process-only environment overrides supplied subsequent checks. After the final account-error sanitization, `pnpm --filter @stageflow/api test` passed all 302 tests in 26 files, including real Redis and disposable PostgreSQL regressions.
- `pnpm --filter @stageflow/api build`, `pnpm check:artifacts --api`, and `pnpm smoke:live` passed. The affected-check planner selected the API checks, artifacts, and both smokes; it did not select a full release or audit gate. The temporary containers and their runtime configuration file were removed after the checks. Existing StageFlow project containers remained stopped; the developer database was not migrated.
- `pnpm smoke:broadcast` was attempted with the isolated configuration and failed at `ffmpeg -version` with `spawn ffmpeg ENOENT`. Broadcast verification and existing V1/V2 acceptance gaps remain open.
- `pnpm format:check` and scoped Prettier checks passed; local links in changed phase records resolve. C02's recorded hash is included in this slice under the existing ledger rule.
- Service coverage includes a real bcrypt register/login pair, normalized identity, current-version seven-day host signing, identical wrong-password/missing-email failures without writes, unique-constraint races and duplicate prechecks, invalid fields, one shared password-work cap, release on success/failure, guest-insert independence, and concurrent/later reuse of one lazy dummy hash. Unexpected account-work failures return a clean 503 `server_busy`; database error query/parameter/cause fields are discarded so email/hash parameters cannot reach Nest's default error logger. Intentional API errors are preserved.
- Owned loopback HTTP tests exercise the actual controller/service with mocked persistence and password work, and real JWT signing. They verify the seven-day host response, ignored guest bearer and extra fields, existing display name on login, and rejected object/field shapes. Admission tests cover register/login aliases sharing the guest budget, rate rejection before JSON parsing, and the ordinary control budget applying first.
- ID-01 has register/login API coverage; the fresh-client room-library browser flow remains planned for C05. Password change and promotion remain C04 work. No complete acceptance ID is closed by C03.

## 5. V3P1-C04 — Password change and promotion

**Status:** committed\
**Proposed commit message:** `feat(api-auth): promote the current guest and change the password`\
**Actual commit:** `bcfe8fb5e808fa9106ebecdf127ae52b3dce48a4`

**Why:** The current guest can keep their rooms, a live call blocks that change, and a password change kills the previous token. Covers ID-02 and ID-03 on the API.

**Depends on:** V3P1-C03. The live connection and its Redis client.

**Files:**

- `apps/api/src/sessions/sessions.service.ts`
- `apps/api/src/sessions/sessions.service.test.ts`
- `apps/api/src/sessions/accounts.controller.ts`
- `apps/api/src/sessions/accounts.module.ts`
- `apps/api/src/sessions/accounts.integration.test.ts`
- `apps/api/src/sessions/sessions.controller.ts` and `sessions.controller.test.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/live/live.connection.ts`
- `apps/api/src/live/live.connection.test.ts`
- `apps/api/src/admission/http-admission.ts`
- `apps/api/src/admission/http-admission.test.ts`

**Implementation:**

1. Add `LiveConnection.hasUserMembership(userId)`. Scan `<namespace>:room:*:participants`. For each hash, treat a JSON value whose `userId` equals the argument as a membership. Return false when the scan finishes with no match. Throw if Redis fails or the cursor never returns to `0`. Do not delete keys and do not add a reverse index. Cover a matching hash, an empty scan, and a Redis error in the connection test.
2. Add `AccountsModule` that imports `SessionsModule` and `LiveModule`. Declare the promote route there. Do not import `AccountsModule` from `LiveModule`. Register `AccountsModule` from `AppModule`.
3. `POST /api/sessions/promote` uses the existing bearer guard. The caller must be `isGuest`. Otherwise throw `not_guest`. Parse `email` and `password`. Ignore a display name in the body. Call `hasUserMembership` before writing. On a match, throw `membership_active` and do not write. Then set email, hash, `isGuest: false`, and `sessionVersion + 1` on that same row. Scan again. On a match, restore the previous email, hash, `isGuest`, and `sessionVersion`, then throw `membership_active`. If the restore throws, throw `server_busy` and do not sign. Success signs a host token. A taken email throws `email_taken` and leaves the guest row as it was.
4. `POST /api/sessions/password` stays on `SessionsController` because it does not need Redis. The caller must be a host. A guest receives `not_registered`. Parse `currentPassword` and `password` with `parsePassword`. A bad current password throws `wrong_password` and does not change the version. Success stores the new hash, increments `session_version`, and returns a host token. The previous token then fails `verifyToken`.
5. Both routes spend the password in-flight cap and the guest network budget. Add `/api/sessions/password` and `/api/sessions/promote` beside the paths from C03.
6. Tests pass a fake membership function into the service. One case finds a membership and expects no `save`. One case saves, then finds a membership and expects the guest columns restored. One case with Redis trouble expects `server_busy` and no host token. One password-change case expects `sv` to move from `0` to `1` and the old token to fail. A second user's rooms are not in the test writes.

**Verification:**

```powershell
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** Promotion and password change match Sections 5.4 and 5.5, and the stage Lua scripts are unchanged.

**Verification record (2026-11-05):**

- The focused service/controller/admission/connection/account-integration run passed all 120 cases in five files. After adding further shared-cap and credential-error regressions, `pnpm --filter @stageflow/api test` passed all 350 tests in 27 files. Workspace `pnpm typecheck` and `pnpm lint` passed.
- `pnpm --filter @stageflow/api build`, `pnpm check:artifacts --api`, and `pnpm smoke:live` passed. The affected-check planner selected the API checks, formatting, artifacts, and both smokes; it did not select a full release or audit gate. The fourteen live and three chat Lua files remain unchanged and match their compiled copies.
- `pnpm smoke:broadcast` failed at `ffmpeg -version` with `spawn ffmpeg ENOENT`. No FFmpeg version or broadcast result was obtained. This does not close any existing V1/V2 acceptance gap.
- Real PostgreSQL/Redis regressions used owned temporary PostgreSQL 16 and Redis 7 containers with tmpfs storage, random loopback ports, and process-only overrides. The new account fixture created, migrated, and dropped its random database, and deleted only its own membership keys. The compiled Nest probe used another random disposable database and namespace. Cleanup found zero leftover fixture databases and zero Redis keys, then removed only the owned containers and temporary configuration/probe/media files. The developer database and live namespace were not migrated or reset.
- Promotion keeps the verified guest id and display name, normalizes email, signs a seven-day host token at the incremented version, and invalidates the old guest token. Two same-name users retain their respective rooms and `READY` broadcasts; a taken email leaves the other guest unchanged. Unit tests also cover the unique-constraint race.
- Membership scans cover pagination, suspended membership, unrelated users, empty pages, Redis scan/hash errors, malformed participant JSON, repeated cursors, and page/time bounds. Promotion refuses the first matching scan without a write, restores all four credential columns after a second-scan match or error, and never signs on failure. A real PostgreSQL connection-loss regression proves the transaction rolls back even when the explicit restore cannot run.
- Both credential routes use a transaction and row lock, then recheck the caller's version and account kind before writing. Real simultaneous password changes allow one commit; the request holding the stale bearer fails. Password change checks the current hash, increments version 0 to 1, rejects the old token/password, and accepts the replacement token/password. Wrong passwords and guests cause no credential write. Shared register/login/password/promote capacity, slot release, guest network admission, and sanitization of database errors carrying credential parameters are covered.
- Owned loopback HTTP tests cover bearer authentication, invalid fields, wrong account kinds, ignored ids/display names/credential claims, and the replacement response/token shape. A separate compiled `AppModule` HTTP probe passed real module wiring, membership refusal, promotion with the same room library, password change, old-token rejection, and fresh login. This is API evidence, not browser acceptance.
- Repository formatting, scoped Prettier checks, and local links in the changed phase records passed. C03's pre-existing hash/status edit is preserved under the ledger rule. ID-02 and ID-03 have their API behavior verified; browser promotion, logout, and home account flows remain for C05. No complete acceptance ID is closed by C04.

## 6. V3P1-C05 — Home account panel

**Status:** verified\
**Proposed commit message:** `feat(web-home): sign in, promote a guest, and show the host library`\
**Actual commit:**

**Why:** The API from C03 and C04 is reachable on the home page, and a host sees a different sentence from a guest. Covers the browser half of ID-01 through ID-04.

**Depends on:** V3P1-C04. The existing home session store and room list.

**Files:**

- `apps/web/src/features/session/api.ts`
- `apps/web/src/features/session/api.test.ts`
- `apps/web/src/features/session/session-store.ts`
- `apps/web/src/features/session/session-store.test.ts`
- `apps/web/src/features/session/account-panel.tsx`
- `apps/web/src/pages/HomePage.tsx`
- `apps/web/src/features/rooms/room-list.tsx`
- `apps/web/src/app/entry-graph.test.ts`
- `apps/web/AGENTS.md`

**Implementation:**

1. Reuse `parseGuest` for register, login, promote, and password responses. Add those four POST helpers next to `createGuest`. They send JSON and, for promote and password, the bearer token.
2. Add `isHostSession`. It returns true only when the token payload's `guest` value is boolean `false`. A missing claim, a string, or `true` is a guest session. Test a host token, a guest token, and a token with no `guest` claim.
3. Render `AccountPanel` from `HomePage` for the three states in phase Section 5.6. Keep **Rooms from this guest session** and **Your rooms** in `HomePage.tsx`. Keep the guest explanation. Use the host explanation and empty-list sentence from that section. `RoomList` takes a flag for the empty sentence rather than reading the token itself.
4. Guest state shows **Create host account** and does not show **Register**. Host state shows **Log out** and **Change password**, and hides **Use a different name**. Signed-out state keeps the display-name field for both guest create and register. Login while a guest session is stored includes the sentence that unpromoted rooms stay on that guest.
5. Success stores the returned session through `setSession`. Logout calls `clearSession`. Field errors use the parser message. API errors use the response message in an alert. Buttons are real submits, with labels, and the fieldset follows the existing pending-disable pattern.
6. Do not import `hls.js`, `LiveRoom`, or chat into the home page or the account panel. Extend `entry-graph.test.ts` so the home source still contains the guest heading, also contains `Your rooms`, and still does not contain `hls`.
7. In the browser, as one guest: create a meeting, promote, log out, and log in from a cleared session. The meeting is listed under **Your rooms**. A wrong password stays on the login form. A second account sees no such meeting. A fresh guest with the same display name sees the guest heading and an empty list. A guest who is inside a live room receives the membership error and still sees the guest heading. Record the browser, the viewport, and any step that could not be run. Update the phase acceptance matrix with that record. Do not mark an unrun browser step verified.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

Then exercise the home flow in the browser. A missing browser leaves ID-01 through ID-04 partial and named.

**Done when:** The three home states match Section 5.6, and the replay and room signed-out gates are unchanged.

**Verification record (2026-11-05):**

- `pnpm --filter @stageflow/web test -- src/features/session/api.test.ts src/features/session/session-store.test.ts src/app/entry-graph.test.ts` passed all 39 focused cases. The final `pnpm --filter @stageflow/web test` passed all 456 tests in 32 files. Workspace `pnpm typecheck` and `pnpm lint` passed.
- `pnpm --filter @stageflow/web build` and `pnpm check:artifacts --web` passed. The affected-check planner selected only web checks, formatting, and web artifacts; it selected neither API tests, smokes, nor audit. The existing deferred playback chunk still produces Vite's size warning; it remains outside the home import graph. Room/replay sources and their signed-out gates are unchanged.
- The account helpers reuse `parseGuest`, send only each route's JSON fields, and add a bearer only for promotion/password change. Regressions cover cancellation, invalid responses, API messages, and preservation of the existing session after account errors, including `wrong_password`. Host copy requires the literal boolean `guest: false`; legacy, malformed, and other claims retain guest copy. Same-user promotion/password replacement clear private catalog caches without clearing a newer token on an old request's 401.
- Browser checks used Playwright `1.64.1`, installed Chrome `156.0.8078.80` headless on Windows NT `10.0` x64, locale `en-GB`, time zone `UTC`, and a primary viewport of `1280 × 800`. The web ran from current Vite source against the real compiled C04 `AppModule`, PostgreSQL 16, Redis 7, bcrypt, and JWTs. Each run created/migrated/dropped its own database and acquired/released its own random live namespace. Owned containers used tmpfs storage, random loopback ports, and process-only overrides. A controlled request delay checked pending controls; account responses and persistence were real.
- A guest created `C05 Design review`, returned home, and promoted. The same user id and room appeared under **Your rooms**, the old guest token returned 401, **Register** was absent for the guest, and **Use a different name** was absent for the host. Logout removed `stageflow.session`; after reload, a wrong password stayed on the login form and a correct login recovered that library. Host create/join reused the host token without another guest request. The browser also checked the original guest token's 12-hour lifetime.
- Wrong current-password submission retained the host and its token. Successful password change cleared password fields, announced success, stored a replacement token, made the old token return 401, and let the replacement token read the library. A second account registered with the shared display-name field, initially saw **This account has no rooms.**, created its own room, logged out, and recovered only that room from a fresh browser context. Invalid email/password fields showed shared parser messages; while registration was delayed, account switches, name edits, and room create/join were disabled and the fieldset reported busy.
- A fresh guest with the same display name joined the first room by link, returned home, and saw **Rooms from this guest session** and **This guest session has no rooms.** A taken email showed the API message and preserved that guest's token/copy. Guest login displayed the unpromoted-room warning, then replaced the session with the registered user's library.
- Another guest joined a real live meeting with explicitly enabled synthetic camera/microphone input and added three demo peers; the spawn control then disabled. An opener-created dashboard tab retained that guest token. Promotion returned the real membership error and preserved the guest heading/token. After removing the demos and leaving the room, membership was absent and promotion succeeded with the same user and room. No C05 browser step from the guide was left unrun.
- The host layout had no horizontal overflow at `1024 × 768` or `390 × 844`; desktop/mobile screenshots were inspected. The primary browser page reported no uncaught runtime errors. These are identity/UI and synthetic-media observations, not physical-device, audible-output, native-picker, recording, or replay-pixel evidence.
- Repository/scoped formatting and local links in the changed guides/phase records passed. Cleanup found zero fixture databases, Redis keys, and owner guards before removing the owned containers; temporary scripts, configuration, reports, and screenshots were removed. Developer services, data, configuration, and live namespaces were not restarted, migrated, or reset. C04's pre-existing status/hash update is preserved under the ledger rule.
- ID-01 through ID-04 are verified for this phase's identity contract using C01–C04 API evidence and these browser checks. Existing V1/V2 acceptance gaps stay open. No broadcast smoke was run by C05; C04's missing-FFmpeg result remains the latest broadcast evidence. C06 README work remains planned.

## 7. V3P1-C06 — README

**Status:** planned\
**Proposed commit message:** `docs(readme): describe host accounts and guest promotion`\
**Actual commit:**

**Why:** The README currently says accounts are future work. After C05 it must describe the host token, the guest path, and the promotion limit. This slice adds no runtime behavior.

**Depends on:** V3P1-C05.

**Files:**

- `README.md`
- `plans/phase1.md`
- `plans/phase1/guide.md`
- `plans/README.md`

**Implementation:**

1. State that a host registers and logs in with email and password, that the host token lasts 7 days, and that the guest token still lasts 12 hours. State that logout clears the browser session and that password change invalidates older tokens.
2. State that **Create host account** updates the current guest only, that a taken email does nothing, and that a live membership must be left first. State that the same display name does not recover rooms. State that Google, email verification, and password reset mail are not in this build.
3. Point the identity contract at `plans/phase1.md` and this guide. Leave the V2 workspace, device, reconnect, chat, and acceptance links on `plans/V2/`.
4. Record the C05 browser result, or the reason it was not run, in the phase matrix. Do not mark open V2 ids passed. Do not claim `pnpm smoke:broadcast` ran unless it did.

**Verification:**

```powershell
pnpm exec prettier --check README.md plans/phase1.md plans/phase1/guide.md plans/README.md
```

Read the edited README against phase Sections 5 and 6.

**Done when:** The README matches the shipped account limits and this guide records C01 through C05. C06's hash is recorded in the follow-up `docs(v3-phase1): record the final slice hash`.

**Handoff:** V3 phase 2 is optional Google. Do not write `plans/phase2.md` until that phase is requested.
