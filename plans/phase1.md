# V3 Phase 1 — Host identity

**Status:** complete. V3P1-C01 through V3P1-C06 are committed, including the README and final slice-hash record. ID-01 through ID-04 are verified. Existing V1/V2 acceptance gaps remain open.\
**Last updated:** 2026-11-05.\
**Master plan:** `MASTER_PLAN_V3.md` version `3.0.0-draft.2`, Sections 1, 3, 4, 5, 6, and 12 (ID-01 through ID-04). Unchanged media, admission, and restart rules stay in `MASTER_PLAN.md` version `1.0.9` and `MASTER_PLAN_V2.md` version `2.0.0-draft.9`.\
**Execution guide:** [phase1/guide.md](phase1/guide.md). That guide owns V3P1-C01 through V3P1-C06. Those ids are not the V1 commits in [V1/phase1/guide.md](V1/phase1/guide.md) or the V2 commits in [V2/phase1/guide.md](V2/phase1/guide.md).\
**Requirement IDs:** ID-01, ID-02, ID-03, ID-04.

## 1. Outcome

A person can register a host account with an email and a password, log in on a later visit, and see the rooms that account created. A guest can turn the current guest session into that host account and keep the rooms already owned by that guest. Logging out leaves the browser signed out. Changing the password makes the previous token fail. A second person with the same display name, or a taken email, does not receive those rooms.

Example: Ava enters as a guest, creates the meeting `Design review`, and promotes that guest with `ava@example.com`. After logout, a fresh browser that logs in with that email sees `Design review` under **Your rooms**. Sam, registered as `sam@example.com`, sees an empty library. Ava's old guest token no longer calls the API. A guest who never promotes still sees **Rooms from this guest session**, and a new guest with the display name Ava does not see Ava's rooms.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-11-04. `HEAD` is `03ac691f661a`. The worktree was not clean: `MASTER_PLAN_V2.md` and `plans/README.md` already had uncommitted V3 pointer edits, and `MASTER_PLAN_V3.md` was untracked. This planning change moves the V2 plans to `plans/V2/` and adds this phase. Recheck the worktree at execution. Do not revert unrelated work.

V2-P1 through V2-P5 are delivered. Acceptance is partial. This phase does not record WS-01, WS-02, WS-03, MEDIA-01, MEDIA-02, REC-01, REC-03, REC-04, CHAT-04, MEDIA-03, MEDIA-04, REC-05, QA-02, P3-A03, P3-A05, or P3-A06 as passed.

Observed in that tree:

- `POST /api/sessions/guest` is the only session route. It inserts `is_guest = true` and signs `{ sub }` with the module lifetime of 12 hours. `verifyToken` checks `sub` and loads the user. It does not read a session version.
- `users` has `id`, `display_name`, `is_guest`, and `created_at`. There is no email, password, or session version. Migrations are `CreateUsersAndRooms1730332800000`, `CreateBroadcasts1793577600000`, and `IndexRoomsByHost1793664000000`. `scripts/smoke-broadcast.mjs` expects that list in that order.
- The web session is `GuestSessionResponse`: `token`, `userId`, `displayName`. It is stored in `sessionStorage` under `stageflow.session`. `usableSession` drops a token whose `exp` is in the past. A token without `exp` stays usable until the server rejects it.
- Home create and join reuse a usable session. **Use a different name** clears it. The list heading is **Rooms from this guest session**. `GET /api/rooms` is already scoped to the caller and ignores a caller-supplied host id.
- `JwtModule` registers `expiresIn: '12h'`. The socket handshake calls `SessionsService.verifyToken`. `LiveModule` imports `SessionsModule` and exports `LiveConnection`.
- Participant JSON in `<LIVE_NAMESPACE>:room:{roomId}:participants` includes `userId`. There is no reverse index. Startup deletes `<LIVE_NAMESPACE>:room:*` only.
- `GUEST_RATE_LIMIT` applies to `POST /api/sessions/guest` after the ordinary control budget. `GUEST_PENDING_LIMIT` bounds in-flight guest inserts. `bcrypt` and `bcryptjs` are not dependencies.
- Home must not import `hls.js`, the live room, or chat. Replay and room routes already accept whatever session is stored.

Recheck at execution. Git follows V1 master Section 1.4. A missing browser leaves the browser half of ID-01, ID-03, and ID-04 unverified and named. A missing disposable Postgres leaves the migration run unverified. Neither gap authorizes skipping the unit checks or deleting developer data.

## 3. Included and excluded

### 3.1 Included

- Email and password registration, login, logout, and in-session password change for a host.
- Promotion of the user row named by the current guest token.
- Token claims `sv` and `guest`, a 7-day host token, and the existing 12-hour guest token.
- Home copy that distinguishes this guest session from the host library.
- README text for these limits.

### 3.2 Excluded

These are the exclusions this phase is most likely to violate. V3 master Sections 4, 7, 8, and 9 still apply.

- Google sign-in, account linking, SMTP, email verification, and a password-reset mail.
- Merging two users, or selecting a user by display name or by an equal email string on a different row.
- A refresh token, a server logout denylist, or a change to the 12-hour guest lifetime.
- Scheduling, waiting rooms, `require_admission`, replay visibility, replay deletion, and Q&A.
- A new room route, a change to slug join, or a private replay. Link-accessible playback stays as it is.
- Renaming a user. Promotion keeps the current display name.
- Putting a password hash, a password, or an email into a log, a socket snapshot, or git.
- Closing any open V1 or V2 physical or FFmpeg acceptance id.

## 4. Requirement mapping

| ID    | Meaning in this phase                                                                                                                                                                                         | What this phase does not claim                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| ID-01 | Register and login return a host token. A fresh client that logs in sees only that user's rooms. A wrong password fails and writes nothing                                                                    | Google, or a session that survives clearing site data without login |
| ID-02 | Logout clears the stored session. Password change increments `session_version`, rejects the previous token, and returns a token that works                                                                    | A server-side list of revoked tokens                                |
| ID-03 | Promote updates that guest row only. Its rooms and broadcasts stay on that user id. A taken email and a live membership leave the guest row unchanged                                                         | Moving rooms from any other user, or promotion during a live call   |
| ID-04 | Guest create, guest join, demo peers, and a current guest token still work. Guest home copy still says the list is this guest session. A new guest with the same display name does not see the promoted rooms | A permanent guest, or a guest refresh token                         |

## 5. System contracts

### 5.1 Account fields

One new migration, `AddHostCredentials1793923200000`, after `IndexRoomsByHost1793664000000`.

| Column            | Rule                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `email`           | `varchar(254)`, null. Unique where it is not null. Guests stay null  |
| `password_hash`   | `text`, null. Never selected by a normal user load. Guests stay null |
| `session_version` | `integer`, not null, default `0`. Existing rows become `0`           |

`synchronize` stays forbidden. `scripts/smoke-broadcast.mjs` gains this migration name at the end of its expected list. Down drops the three columns.

The hash is bcrypt, cost 12, through the pure-JavaScript `bcryptjs` package. Do not add native `bcrypt`. The stored string is the library's hash. Compare with the library's compare. A hash of a fixed dummy password is computed once at cost 12 and reused when login does not find an email, so the missing-user path still compares.

### 5.2 Parsers

Shared parsers live in `packages/shared/src/account.ts` and are exported from the package index.

`parseEmail` trims and lowercases. It accepts 3 to 254 characters with exactly one `@`, a non-empty local part, and a domain that contains a dot and does not start or end with a dot. It rejects whitespace, ASCII control characters, and any other shape. The error is `invalid_email` with `Enter a valid email address.`

`parsePassword` does not trim. It accepts 8 to 72 UTF-8 bytes and at least 8 code points. It rejects ASCII control characters, including newlines. The error is `invalid_password` with `Use 8 to 72 characters, without control characters.`

`parseDisplayName` stays the display-name rule. Register uses it. Login and promote do not change the display name.

### 5.3 Tokens

Every new guest and host token is HS256 and carries `sub`, `sv`, and `guest`.

- Guest `expiresIn` is `12h`. `sv` is that row's `session_version`. `guest` is `true`.
- Host `expiresIn` is `7d`. `sv` is that row's `session_version`. `guest` is `false`.
- The `JwtModule` default stays `12h`. Each `signAsync` passes its own `expiresIn`.

`verifyToken` still requires a UUID `sub` and a row. A missing `sv` means `0`. A present `sv` must be an integer and equal `session_version`. A missing `guest` is accepted only while `is_guest` is true. A present `guest` must be a boolean equal to `is_guest`. Anything else is `unauthorized`. The socket handshake uses this same method, so a promoted user's old guest token fails on the next connection and on resume.

The response body stays `{ token, userId, displayName }`. The client may read `guest === false` to choose home copy. Access control stays on the server.

### 5.4 Routes

All four routes are under `/api/sessions`. Extra JSON fields are ignored. These routes share the existing guest network rate budget and, for the password work, one in-flight cap at `GUEST_PENDING_LIMIT`. Over the cap returns `server_busy` and does not hash.

| Route      | Auth                       | Success                                                                 | Failure without a write                                                           |
| ---------- | -------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `register` | none                       | New `is_guest = false` row, version `0`, host token                     | Invalid fields. `email_taken` if the email exists                                 |
| `login`    | none                       | Host token for that email                                               | `unauthorized`, `Email or password is wrong.` Missing user and bad password match |
| `password` | bearer, `is_guest = false` | New hash, version incremented, new host token                           | Guest receives `not_registered`. Wrong current password receives `wrong_password` |
| `promote`  | bearer, `is_guest = true`  | That row gains the email and hash, `is_guest` becomes false, version +1 | See Section 5.5                                                                   |

Register and login ignore any bearer token. A guest who wants to keep their rooms uses promote, not register. Register always creates a different user.

`email_taken` is HTTP 409 and `That email is already registered.` A unique-constraint race returns that same error. `not_registered` is HTTP 403 and `Create a host account before changing its password.` `not_guest` is HTTP 403 and `This session is already a host account.` `wrong_password` is HTTP 401 and `The current password is wrong.`

Logout has no route. The home control clears `stageflow.session`.

### 5.5 Promotion and live membership

Promote loads the user id from the verified guest token. It writes only that row. It does not query by display name or email except for the unique email check. Rooms and broadcasts stay where they are because `host_id` does not change.

Before the write, and again after it, ask Redis whether that user id appears in any `<LIVE_NAMESPACE>:room:{roomId}:participants` hash. Scan `room:*:participants` under the namespace. Parse each JSON value. A match is a live membership, including a suspended one. Redis trouble, or a scan that cannot finish, returns `server_busy` and must not leave a promoted row behind.

If the first scan matches, return HTTP 409 `membership_active` with `Leave the live room before creating a host account.` and do not write. If the second scan matches, restore that row's email, password hash, `is_guest`, and `session_version`, then return the same 409. A restore failure returns `server_busy` and does not issue a token.

`SessionsModule` cannot import `LiveModule`, because `LiveModule` already imports `SessionsModule`. The promote route lives in a small accounts controller that can see `SessionsService` and `LiveConnection`. The lookup is a method on `LiveConnection`. It does not create a reverse index and it does not change the stage Lua scripts.

A join that lands after the second scan can still overlap the committed promotion. Resume with the old guest token then fails closed. This phase does not evict the socket that is already connected.

### 5.6 Home

Three mutually exclusive session states, all on `/`:

- **Signed out.** The current guest name, create, and join stay. Add login and register. Register uses the same display-name field plus email and password. The list area still says to enter a display name.
- **Guest.** Keep **Rooms from this guest session**, the current explanation, and **Use a different name**. Add email and password and the button **Create host account**. That button calls promote and stores the returned token. Do not also offer register on this state.
- **Host.** `guest === false`. The heading is **Your rooms**. The explanation is `These rooms stay with this account. Sign in with the same email to see them on another browser.` The empty list says `This account has no rooms.` Show **Log out** and a current-password plus new-password form, **Change password**. Create and join send the host token and do not mint a guest.

Login while a guest session is stored replaces that browser session. The form says that rooms which were not promoted stay on the guest. The replay page and the room page keep their current signed-out gates. A stored host token already satisfies them.

Home still must not import `hls.js`, the live room, or chat.

## 6. Acceptance matrix

| ID    | Observable result                                                                                                            | Method                                         | Status                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------- |
| ID-01 | A new account can register, log in from a fresh session, and see its own rooms. A wrong password does not change a row       | API regressions and a browser login            | verified (API and browser)    |
| ID-02 | Logout clears the stored session. The token from before a password change fails, and the returned token works                | Token-version regressions and a browser logout | verified (API and browser)    |
| ID-03 | Promotion keeps that user id's rooms, rejects a taken email, and rejects a live membership without changing the guest        | Service regressions and a browser promotion    | verified (API and browser)    |
| ID-04 | Guest create, join, and the guest list copy still work. The same display name in a new guest session does not show the rooms | Existing guest checks and a browser guest path | verified (guest UI and demos) |

V3P1-C01 verification (2026-11-05): the 46 account parser cases and all 309 shared tests passed. Workspace typecheck and lint passed. Email normalization, invalid shapes, control characters, password spaces, UTF-8 byte limits, and the code-point minimum are covered. Register/login API and browser acceptance remain planned. See the [C01 verification record](phase1/guide.md#2-v3p1-c01--email-and-password-parsers). No ID is fully verified by this slice.

During C01, the affected-check planner selected `pnpm check:release`. Tooling, both app test suites and builds, repository formatting, artifact checks, and the live socket smoke passed. The final broadcast smoke failed at the FFmpeg version probe with `spawn ffmpeg ENOENT`; broadcast and migration execution were unverified in that run. Existing V1/V2 acceptance gaps stay open.

V3P1-C02 verification (2026-11-05): all 39 focused password, token, credential-schema, and catalog cases passed. The new migration applied after the existing three in a disposable PostgreSQL database, and its second run was empty. Another disposable database verified defaults on a pre-migration guest, ordinary guest inserts, unique non-null emails, hidden password selection, and rollback of the three new columns without removing that guest. Those databases were dropped by their owned fixtures; the developer database was not migrated. Legacy version-0 guest tokens work, and mismatched or malformed claims fail. Password change, logout, register/login, and browser guest acceptance remain planned; no ID is fully verified by C02.

C02's frozen install, audit, workspace typecheck/lint, 49 tooling tests, 309 shared tests, 428 web tests, 274 API tests, both builds, formatting, and artifact checks passed. The release run exposed two incomplete chat-user fixtures in the live smoke; after updating them, the live smoke and script lint passed. A separate broadcast smoke failed at the FFmpeg version probe with `spawn ffmpeg ENOENT`. The complete release gate and broadcast acceptance remain unverified; migration verification above is complete. See the [C02 verification record](phase1/guide.md#3-v3p1-c02--password-hash-and-token-claims).

V3P1-C03 verification (2026-11-05): all 67 focused service/controller/admission cases and all 302 API tests passed. Workspace typecheck/lint, API build/artifact checks, formatting, and the live socket smoke passed. The configured local services were stopped, so the integration checks used owned disposable PostgreSQL/Redis containers with tmpfs storage, random loopback ports, and process-only overrides; those containers and their runtime configuration were removed. Existing StageFlow containers remained stopped; developer configuration/data were not changed. Register/login normalize and validate fields, issue seven-day host tokens, ignore guest bearer/extra fields, reject duplicate email races, and return one login failure message. Shared password-work capacity and the guest network budget are covered. Unexpected account failures become a clean 503 so database email/hash parameters cannot reach the default error logger. The broadcast smoke failed at the missing FFmpeg version probe. Fresh-client room-library/browser acceptance, promotion, and password change remain planned; no complete ID is closed. See the [C03 verification record](phase1/guide.md#4-v3p1-c03--register-and-login).

V3P1-C04 verification (2026-11-05): the focused account/service/controller/admission/connection run passed all 120 cases; the final API suite passed all 350 tests in 27 files. Workspace typecheck/lint, API build/artifact checks, formatting, and the live socket smoke passed. Owned disposable PostgreSQL/Redis fixtures verified same-user promotion without moving either user's rooms or broadcasts, taken-email refusal, suspended membership before and after the write, transactional rollback when Redis and the explicit restore fail, password replacement, and concurrent stale-bearer rejection. The compiled Nest HTTP probe verified the actual module wiring, membership refusal, preserved room library, replacement token, and fresh login. Fixture databases, keys, containers, temporary configuration, and probe/media files were removed; developer data and live namespaces were not migrated or reset. The broadcast smoke failed at the missing FFmpeg version probe. ID-02 and ID-03 are API-verified only; browser logout, promotion, and home account flows remain planned, and no complete ID or older V1/V2 gap is closed. See the [C04 verification record](phase1/guide.md#5-v3p1-c04--password-change-and-promotion).

V3P1-C05 verification (2026-11-05): all 39 focused account/session/import cases and all 456 web tests passed. Workspace typecheck/lint, web build/artifact checks, and formatting passed. Chrome `156.0.8078.80` headless on Windows NT `10.0` x64, locale `en-GB`, time zone `UTC`, and viewport `1280 × 800` exercised the real compiled C04 API against owned disposable PostgreSQL 16/Redis 7 fixtures. Guest create/promotion retained the same user and room; logout cleared storage; fresh login restored that library; a wrong password stayed on the form. Password change retained the host on a wrong current password, replaced its token on success, and made the old token fail. A second registered host created a room and recovered only its own library from a fresh context. A fresh same-name guest saw an empty guest library; a taken email preserved that guest; guest login showed the warning and replaced the browser session. Real live membership blocked promotion in another dashboard tab, and leaving permitted it. The guest live path added and removed three demo peers with explicitly enabled synthetic camera/microphone input. Parser errors, shared pending-disable controls, host token reuse for create/join, and host/guest copy passed. Host layouts had no horizontal overflow at `1024 × 768` and `390 × 844`, and desktop/mobile screenshots were inspected. All C05 browser steps ran; ID-01 through ID-04 are verified for identity only. These observations do not close existing V1/V2 physical, audible, native-picker, FFmpeg, or replay-pixel gaps. The owned databases, namespaces, containers, and temporary probe artifacts were cleaned up; developer services/data/configuration were untouched. C05 did not run broadcast smoke; C04's missing-FFmpeg result remains the latest evidence. C06 README work is still planned. See the [C05 verification record](phase1/guide.md#6-v3p1-c05--home-account-panel).

V3P1-C06 verification (2026-11-05): the README was reviewed against Sections 5 and 6 and the shipped account routes, token lifetimes, account controls, credential migration, and admission settings. It documents guest/host entry, promotion of only the current guest, retained ownership, taken-email and live-membership refusal, logout and password change, and unavailable Google/email-verification/password-reset services. It summarizes the C05 browser result already recorded above and preserves the V2 verification gaps. Scoped Prettier checks, local Markdown paths/heading anchors, and `git diff --check` passed; the affected-check planner selected formatting only. This documentation slice ran no application suite, browser, migration, service, or smoke check and adds no acceptance or media observation. C05's ID-01 through ID-04 verification and C04's missing-FFmpeg result remain unchanged. The final slice hash and completion statuses are recorded in the required ledger follow-up. See the [C06 verification record](phase1/guide.md#7-v3p1-c06--readme).

## 7. Verification commands

Commands already in the repo:

- `pnpm --filter @stageflow/shared test`
- `pnpm --filter @stageflow/api test`
- `pnpm --filter @stageflow/web test`
- `pnpm typecheck`
- `pnpm lint`

The slice that edits the smoke migration list updates `scripts/smoke-broadcast.mjs`. Do not run that smoke against the developer database. Do not require `pnpm smoke:broadcast` to pass in this phase when FFmpeg is absent. Record that gap instead of deleting media.

## 8. Risks

| Risk                                                                | What keeps it contained                                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A host token is issued for 12 hours because the module default wins | Every `signAsync` passes `expiresIn`                                                                       |
| An old guest token dies on deploy                                   | Missing `sv` means `0`, and missing `guest` matches a guest row                                            |
| Promotion attaches another person's rooms                           | The only write is the JWT user id. Email uniqueness rejects the other row                                  |
| A guest promotes from inside a call and keeps both                  | The participant scan runs before the write and again before success. Resume with the old token fails       |
| Login reveals which emails exist                                    | One message and one compare for a missing user and a bad password                                          |
| The home page starts loading the broadcast player                   | The entry-graph test still forbids `hls` on the home page                                                  |
| Password hashes show up in query logs or git                        | `select: false`, no logging of the password or hash, and no fixture that commits a real user's credentials |

## 9. Exit and handoff

All six slices are committed. The next requested phase may rely on these:

- A guest token and a host token both pass the socket handshake when their claims match the row.
- `users.email`, `users.password_hash`, and `users.session_version` exist. Existing guest rows have a null email, a null hash, and version `0`.
- Home can show either the guest sentence or **Your rooms** from the stored token.
- Promote refuses a live membership and a taken email.

V3 phase 2 is specified in [phase2.md](phase2.md). It adds optional Google on top of this account row and must not treat a Google email as a merge key. That file does not authorize implementation.

This phase does not make V2 acceptance complete. Leave the open ids open.

## Maintenance: V3-R01 / V3M-C02 (2026-11-06)

Status: committed. Proposed commit: `fix(auth): revoke established socket sessions`.
Actual commit: `5235ee6`.

Established sockets now enforce the verified JWT deadline, including idle connections. Every protected packet passes the same authorization lease; explicit leave retains its bypass. Password changes and guest promotion invalidate this process's sockets immediately after transaction commit. The namespace has one API writer under LiveConnection's existing owner guard. External account changes have a five-second freshness bound during activity, with one coalesced lookup per socket per interval rather than a lookup per ICE candidate. Failed revalidation disconnects through the existing suspension, resume-generation, and bounded host-expiry lifecycle. Timers and the session-change subscription are disposed on disconnect/shutdown.

Evidence:

- Focused session/gateway/lease tests: 95 passed. Controlled clock tests cover idle expiry, rejected authorization, coalesced 100-packet bursts, and revocation during an outstanding freshness lookup.
- API package tests: 522 passed across 36 files, including owned Redis and disposable PostgreSQL fixtures. API typecheck, lint, build, and artifact checks passed.
- The maintained compiled live smoke uses two actual sockets for one registered account and the real password-change service with a controlled user repository. Both old transports disconnect, the HTTP guard's token verifier rejects the old token, a new old-token handshake fails, and the replacement token resumes exactly one host seat. A second password change during suspension rejects the intermediate token and host expiry ends the room. Existing media, chat, Q&A, recovery, and cleanup checks pass. This is not a separate HTTP network probe.
- `pnpm check:affected --plan --files apps/api/src/live/signaling.gateway.ts apps/api/src/sessions/sessions.service.ts scripts/smoke-live.mjs` selected the full release gate. `pnpm check:release` passed: 49 tooling, 454 shared, 525 web, and 522 API tests; workspace typecheck/lint; builds; formatting; artifacts; and both smokes. FFmpeg came from the existing temporary `stageflow-ffmpeg-b6.0/ffmpeg.exe` through process-local `FFMPEG_PATH`; no environment file changed. The broadcast smoke applied all seven migrations, decoded video/audio, and preserved READY media across restart.

No physical-device acceptance, Google provider round trip, VPS capacity, or production launch approval is claimed. The untracked review report remains outside the commit.

## Maintenance: V3-R03 / V3M-C04 (2026-11-06)

Status: verified. Proposed commit: `fix(auth): bound and isolate password computation`.
Actual commit:

Cost-12 bcryptjs now runs on a reusable worker pool. The pool defaults to one worker and a queue of four, clamped to available CPUs, and rejects overflow with `server_busy` before the password is retained. Register, login, promotion, and password change use that pool. Guest creation and Google exchange keep `GUEST_PENDING_LIMIT`. Each email, and each signed-in user, has ten password attempts per rate window. The window expires, the message is the same for a missing email and a bad password, and a full pool does not consume that window. Wrong-credential responses, the dummy compare, UTF-8 validation, and cost 12 stay as they were. Idle workers are unreferenced so a one-shot script can exit. Nest shutdown closes the pool. Three consecutive worker boot failures stop further spawn attempts. A timed-out or crashed worker does not keep the password.

Evidence:

- Focused password, session, and config tests passed, including queue overflow, close, a crashed worker, repeated boot failure, per-account limits without a permanent lock, and a child process that exits after one hash without an explicit pool close.
- Isolated fixture, with owned Nest readiness and a socket.io handshake on `127.0.0.1`, four parallel cost-12 hashes: event-loop delay 21.7 ms while the slowest hash took 578.4 ms; readiness max 44 ms; socket handshake max 25.3 ms. The configured budget admitted 5 jobs. The review's main-thread probe on this machine was about 95 ms of timer delay for one hash and 799 ms for eight.
- During the full API suite the same fixture stayed inside its bounds: event-loop delay 38.4 ms, readiness max 129.4 ms, socket max 36.8 ms, slowest parallel hash 1334.5 ms.
- `pnpm check:release` passed with process-local `FFMPEG_PATH` pointing at the existing temporary FFmpeg 6.0 binary: 49 tooling, 454 shared, 525 web, and 541 API tests; workspace typecheck/lint; both builds; formatting; artifacts, including a byte-identical password worker; and live and broadcast smokes. The first release run reached a passing live smoke and then stayed up because idle workers kept that process alive. The unref fix is what this passing run includes. No environment file changed. The Vite large-chunk warning remains.

The target VPS has not been measured. These defaults are a pre-measurement ceiling, not a capacity promise. No physical-device acceptance or production launch approval is claimed. The untracked review report remains outside the commit.
