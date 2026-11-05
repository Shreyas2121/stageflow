# V3 Phase 2 — Optional Google sign-in

**Status:** in progress. C01 through C04 are verified. C05 remains planned.\
**Last updated:** 2026-11-05.\
**Master plan:** `MASTER_PLAN_V3.md` version `3.0.0-draft.3`, Sections 4, 6.4, and 12 (ID-05 and ID-06). Email and password accounts stay as shipped in `plans/phase1.md`.\
**Execution guide:** [phase2/guide.md](phase2/guide.md). That guide owns V3P2-C01 through V3P2-C05. Those ids are not the V1 commits in [V1/phase2/guide.md](V1/phase2/guide.md) or the V2 commits in [V2/phase2/guide.md](V2/phase2/guide.md).\
**Requirement IDs:** ID-05, ID-06.

## 1. Outcome

With Google settings absent, the home page has no Google control and the Google sign-in routes refuse. Register, login, promotion, and guest entry still work, and they do not call Google.

With the three Google settings present, a person can start sign-in from the home page. An unknown Google subject becomes a new host with no password and no email. A Google address that matches an existing host email does not attach to that host and does not move that host's rooms. A host who is already signed in can link a Google subject that nobody else owns. A subject that already belongs to another user leaves both rows unchanged.

Example: Ava's password account is `ava@example.com` and owns `Design review`. Google is not configured, so Ava sees no Google button. After the three settings are present, a Google subject `subject-1` whose profile also says `ava@example.com` creates a second host named from the profile, with a null email. `Design review` stays on Ava's password account. Ava then links an unused subject `subject-2` while her password token is current. Linking `subject-1` from Sam's account fails, and Sam's row does not gain that subject.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-11-05. `HEAD` is `c423d7748c84`. The worktree was clean. Recheck it at execution.

V3P1-C01 through V3P1-C06 are committed. ID-01 through ID-04 are verified. This phase does not record the open V1 and V2 acceptance ids as passed.

Observed in that tree:

- Host accounts use `users.email`, `users.password_hash`, and `users.session_version`. Email is unique only when it is not null. Guest rows keep a null email and a null hash.
- Register, login, password change, and guest promotion are shipped. Promotion edits the current guest row and refuses a live membership. Login does not merge on display name or email.
- Host tokens last 7 days and carry `sub`, `sv`, and `guest: false`. Guest tokens last 12 hours. `verifyToken` checks those claims against the row.
- There is no Google column, route, or button. The README says Google sign-in is not in this build.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` are not in the config schema. `.env.example` has no Google settings. `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL` are already all-or-nothing.
- Account posts spend `GUEST_RATE_LIMIT` through `GUEST_SESSION_PATHS`. The probe path must not be treated as one of those posts.
- Home renders `AccountPanel`. `App` routes are `/`, `/r/:slug`, `/replay/:broadcastId`, and a 404. The home entry test forbids `hls` on the home page.
- `scripts/smoke-broadcast.mjs` expects `AddHostCredentials1793923200000` last.

## 3. Included and excluded

### 3.1 Included

- Optional Google authorization-code sign-in, with the code exchange on the API.
- A unique `google_subject` on the existing user row.
- Explicit link from the current host account.
- A home control that is hidden while Google is unconfigured.
- README text for the unset path and the no-merge rule.

### 3.2 Excluded

These are the exclusions this phase is most likely to violate.

- Requiring Google for register, login, promotion, guest entry, demo peers, or the ID-01 path.
- Writing the Google address into `users.email`, or finding a user by that address.
- Linking or signing in onto a guest row. Google sign-in does not promote the current guest.
- A client-supplied email, name, or subject as proof of identity.
- Putting the client secret, an authorization code, a ticket, or an id token into a log, a response, or the web bundle.
- Password reset mail, a set-password flow, scheduling, replay privacy, deletion, and Q&A.
- Closing any open V1 or V2 acceptance id.

## 4. Requirement mapping

| ID    | Meaning in this phase                                                                                                                                    | What this phase does not claim                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| ID-05 | Unset Google hides the control, the sign-in routes refuse, and email/password register still creates a host                                              | A live call to Google's servers                                        |
| ID-06 | An unknown subject creates a separate host. An equal email does not attach it. Linking needs the current host token and a subject that no other row owns | A browser round-trip through Google when no credentials are configured |

## 5. System contracts

### 5.1 Configuration

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` are empty together or set together. A partial set fails startup, in the same way an incomplete TURN trio does.

The redirect value is one exact `http` or `https` URL, with no userinfo, query, or hash, and with the path `/api/sessions/google/callback`. The client secret is read only by the API. No response, redirect, or web environment variable carries it.

Empty settings are the acceptance default. ID-05 runs in that default.

### 5.2 Stored identity

Migration `AddGoogleSubject1794009600000` adds `google_subject varchar(255)` null, with a unique index where it is not null. Existing rows stay null. `scripts/smoke-broadcast.mjs` appends this name after `AddHostCredentials1793923200000`.

The subject is the `sub` claim from a verified Google id token. It is 1 to 255 characters, without whitespace or ASCII control characters. The address and the profile email are discarded before any database write.

A new Google host has `is_guest = false`, `email = null`, `password_hash = null`, `session_version = 0`, and the subject set. The display name is the profile `name` when `parseDisplayName` accepts it, and otherwise `Host`. The scope is `openid profile`. The email scope is not requested.

### 5.3 Routes

| Route                               | When Google is unset         | When Google is set                                          |
| ----------------------------------- | ---------------------------- | ----------------------------------------------------------- |
| `GET /api/sessions/google`          | `200` `{ "enabled": false }` | `200` `{ "enabled": true }`                                 |
| `GET /api/sessions/google/start`    | `404` `google_unavailable`   | Redirect to Google's authorization URL                      |
| `GET /api/sessions/google/callback` | `404` `google_unavailable`   | Exchange the code, then redirect to the web app             |
| `POST /api/sessions/google/ticket`  | `404` `google_unavailable`   | Redeem one ticket for `{ token, userId, displayName }`      |
| `POST /api/sessions/google/link`    | `404` `google_unavailable`   | Current host receives `{ "url" }` for the authorization URL |

`google_unavailable` uses `Google sign-in is not configured.` The probe is the only Google route that succeeds while unset. It never calls Google and does not return the client id or the secret.

Start and link build the authorization URL on the API. The state and the PKCE verifier stay in Redis for 5 minutes under `<LIVE_NAMESPACE>:google:state:{state}` and are deleted on first use. The callback sends the code, the verifier, the client id, the secret, and the configured redirect to Google's token endpoint. The id token is verified for this client id. A bad state, a reused state, a bad token, or a missing subject is `google_rejected` with `Google did not confirm this sign-in.` and writes nothing.

A successful sign-in stores the host session under `<LIVE_NAMESPACE>:google:ticket:{ticket}` for 60 seconds and redirects to `{CORS_ORIGIN}/auth/google?ticket={ticket}`. The ticket is single-use. The failure redirect is `{CORS_ORIGIN}/auth/google?error=google_rejected`. The query never carries a token, a code, or the secret. The redirect target is not taken from the request.

Ticket redemption returns the same session shape as login and signs a 7-day host token with the row's current `session_version`. A second redeem fails with `google_rejected`.

Link requires a host bearer. A guest receives HTTP 403 `google_host_required` with `Create a host account before linking Google.` The callback for a link state writes the subject onto that host id only. A subject already stored on another row returns HTTP 409 `google_linked` with `That Google account is already linked to another user.` and leaves both rows unchanged. Linking the subject's current owner again is a success and does not change the version. A successful new link does not change email, password hash, or `session_version`.

Sign-in and link spend the account rate budget and the password in-flight cap. The probe spends only the ordinary control budget. Over the in-flight cap returns `server_busy` and does not call Google.

A Google-only host who calls password change receives HTTP 403 `password_not_set` with `This account has no password.` This phase does not add a way to set that password.

### 5.4 Decisions the service must prove

The service takes a code exchange as an argument. Tests use a fake. The real exchange is what the callback uses when Google is configured. There is no environment flag whose only job is to fake Google.

- Unknown subject, even when the fake profile address equals an existing host email: insert a new row. The existing host's id, email, and rooms stay.
- Known subject: sign in to that row. Do not copy the profile address into `email`.
- Link with the current host token and a free subject: set `google_subject` on that row only.
- Link with a subject owned by someone else: write nothing.
- Unset configuration: the service refuses before the exchange is called.

### 5.5 Home

`GET /api/sessions/google` decides the control. `enabled: false` renders nothing about Google. `enabled: true` shows **Continue with Google** as a link to the API start route.

On a guest session, that link is sign-in, not promotion. The panel says `Google sign-in starts a separate host. It does not promote this guest.`

On a host session, **Link Google** posts to the link route with the bearer token and then navigates to the returned URL.

`/auth/google` reads `ticket` or `error`, redeems a ticket through the API, stores the session, and navigates to `/`. It does not import `hls.js`, the live room, or chat. Home still must not import them either.

A real Google browser round-trip is recorded only when the three settings and a Google account are available. ID-05 does not need them. ID-06's service cases do not need them.

## 6. Acceptance matrix

| ID    | Observable result                                                                                                                     | Method                                                                | Status                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| ID-05 | Unset Google returns `{ enabled: false }`, hides the control, refuses start, callback, ticket, and link, and register still works     | Config and route regressions, plus the home page with settings absent | verified: config/routes and unset browser registration/login |
| ID-06 | A fake exchange creates a separate host, does not attach an equal email, and links only for the current host when the subject is free | Service regressions. A real Google browser pass is optional and named | verified with fake exchange; real Google round-trip not run  |

## 7. Verification commands

- `pnpm --filter @stageflow/shared test`
- `pnpm --filter @stageflow/api test`
- `pnpm --filter @stageflow/web test`
- `pnpm typecheck`
- `pnpm lint`

Do not run `pnpm smoke:broadcast` against the developer database. If FFmpeg is absent, leave that smoke unverified. The migration list in the smoke script still gains the new name.

## 8. Risks

| Risk                                                 | What keeps it contained                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| The profile email becomes the login                  | The email scope is not requested, and any address on the token is discarded before a write |
| Sign-in attaches Ava's rooms to a new Google subject | A new subject always inserts. Linking is a separate host-token action                      |
| The client secret reaches the browser                | The secret stays in the API process. The probe and the authorization URL omit it           |
| A ticket in the query is a reusable session          | One Redis get-and-delete, a 60-second TTL, and no token in the query                       |
| Unset Google breaks register                         | The exchange is not called, and ID-05 includes a register success                          |
| Home starts loading the broadcast player             | The entry-graph test still forbids `hls` on the home page and the callback page            |

## 9. Exit and handoff

The next phase may rely on these once the slices are committed:

- `users.google_subject` exists, is null on older rows, and is unique when set.
- Unset Google leaves email, password, guest, and promotion behavior unchanged.
- A configured Google sign-in can create a host the room list already understands, because it is a normal `is_guest = false` row and a normal host token.

V3 phase 3 may add replay visibility and deletion for registered owners. A Google-only host is a registered owner. Do not write `plans/phase3.md` until that phase is requested.

This phase does not make V2 acceptance complete. Leave the open ids open.

## 10. Implementation record

### V3P2-C01 — Optional Google configuration (2026-11-05)

The API accepts the trimmed Google trio only when all settings are empty or all are set, derives `GOOGLE_ENABLED`, and validates the callback URL. The shared error union includes the five planned Google/password codes, and `.env.example` leaves all three settings empty. No Google route exists yet.

All 46 config tests, 309 shared tests, and 371 API tests passed, as did workspace typecheck/lint and frozen installation. The affected-check planner selected `pnpm check:release`: 49 tooling tests, all package tests (including 456 web tests), both builds, formatting, artifact checks, and the live socket smoke passed. The final broadcast smoke failed at `ffmpeg -version` with `spawn ffmpeg ENOENT`; no FFmpeg version or broadcast result was obtained. The [C01 verification record](phase2/guide.md#2-v3p2-c01--optional-google-configuration) records the commands and the shared-test timeout followed by a passing standalone rerun.

Only ID-05's config half is verified. Its route and browser halves, ID-06, and a real Google browser round-trip remain unverified. Existing V1/V2 acceptance gaps stay open. C02 through C05 were not started.

### V3P2-C02 ? Subject column and account decisions (2026-11-05)

The nullable Google subject migration and direct-profile account decisions are implemented. New subjects create separate hosts, equal profile emails are discarded, linking requires the current host and refuses conflicts, and Google-only hosts cannot change a nonexistent password. The guide records disposable migration and service regressions. ID-06 HTTP exchange coverage remains planned; no Google routes or real round-trip are claimed.

### V3P2-C03 ? Code exchange and routes (2026-11-05)

The optional Google HTTP flow now performs code exchange and token verification on the API, discards email, uses PKCE and one-use Redis state/tickets, and links only the authenticated host. Disabled Google refuses all four actions without exchange. Google actions share account rate budgets for every method, and exchange shares the password in-flight cap.

All 398 API tests, workspace typecheck/lint, frozen installation, and dependency audit passed. The guide records the focused fake-exchange HTTP cases, real Redis TTL/single-use/shutdown coverage, and release-gate outcome. ID-05 still needs C04 browser acceptance. ID-06 is verified against a fake exchange; no real Google browser round-trip ran. Existing V1/V2 physical observations remain open.

C03 release evidence: the ordinary full-gate run hit the existing cross-fixture Redis MONITOR race. The API retry, explicit serial API run, and all remaining release components passed, including both app builds, formatting, artifacts, live smoke, and real FFmpeg 6.0 broadcast/restart/missing-binary checks. This is component completion after a retry, not an uninterrupted full-gate pass. Disposable migration execution included all five registered migrations once, followed by an empty second run. These automated results do not close outstanding browser or physical-device observations.

### V3P2-C04 ? Home control and return page (2026-11-05)

The account panel probes optional Google availability, hides disabled/invalid/failed probes, distinguishes separate-host guest sign-in from current-host linking, and sends host link requests with the current bearer. `/auth/google` redeems one ticket across StrictMode effect replay, preserves the session after linking, renders the required rejection/conflict copy, and removes return queries from history.

All 477 web tests, workspace typecheck/lint, web build, and web artifact checks passed. Chrome 156 headless at 1280 by 900 used real API/PostgreSQL/Redis fixtures with all Google settings empty: Google was absent and email registration plus fresh login succeeded. ID-05 is verified. Controlled enabled responses also verified guest/host controls, ticket persistence, one redemption, link-session preservation, return errors and history cleanup. These controls did not contact Google. The guide records browser details and owned-fixture cleanup. A real Google round-trip and existing V1/V2 physical/native-picker observations remain unverified. C05 remains planned.
