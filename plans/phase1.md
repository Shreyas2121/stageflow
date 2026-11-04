# V3 Phase 1 — Host identity

**Status:** planned. No slice is implemented.\
**Last updated:** 2026-11-04.\
**Master plan:** `MASTER_PLAN_V3.md` version `3.0.0-draft.2`, Sections 1, 3, 4, 5, 6, and 12 (ID-01 through ID-04). Unchanged media, admission, and restart rules stay in `MASTER_PLAN.md` version `1.0.9` and `MASTER_PLAN_V2.md` version `2.0.0-draft.9`.\
**Execution guide:** [phase1/guide.md](phase1/guide.md). That guide owns V3P1-C01 through V3P1-C06. Those ids are not the V1 commits in [../V1/phase1/guide.md](../V1/phase1/guide.md) or the V2 commits in [../V2/phase1/guide.md](../V2/phase1/guide.md).\
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

| ID    | Observable result                                                                                                            | Method                                         | Status  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------- |
| ID-01 | A new account can register, log in from a fresh session, and see its own rooms. A wrong password does not change a row       | API regressions and a browser login            | planned |
| ID-02 | Logout clears the stored session. The token from before a password change fails, and the returned token works                | Token-version regressions and a browser logout | planned |
| ID-03 | Promotion keeps that user id's rooms, rejects a taken email, and rejects a live membership without changing the guest        | Service regressions and a browser promotion    | planned |
| ID-04 | Guest create, join, and the guest list copy still work. The same display name in a new guest session does not show the rooms | Existing guest checks and a browser guest path | planned |

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

The next phase may rely on these once the slices are committed:

- A guest token and a host token both pass the socket handshake when their claims match the row.
- `users.email`, `users.password_hash`, and `users.session_version` exist. Existing guest rows have a null email, a null hash, and version `0`.
- Home can show either the guest sentence or **Your rooms** from the stored token.
- Promote refuses a live membership and a taken email.

V3 phase 2 may add optional Google on top of this account row. It must not treat a Google email as a merge key. Do not write `plans/phase2.md` until that phase is requested.

This phase does not make V2 acceptance complete. Leave the open ids open.
