# Guide — V3 Phase 2, commit by commit

**Status:** in progress. V3P2-C01's optional configuration is verified. C02 through C05 remain planned.\
**Last updated:** 2026-11-05.\
**Phase contract:** [../phase2.md](../phase2.md).\
**Product authority:** [MASTER_PLAN_V3.md](../../MASTER_PLAN_V3.md) version `3.0.0-draft.3`. Host accounts stay as shipped in [../phase1.md](../phase1.md). Unchanged V2 rules stay in [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md). Unchanged V1 rules stay in [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.9`.\
**Deliverable:** Google sign-in is optional, and a Google subject never claims an existing email account, in five commits. This is the only V3 Phase 2 guide. Its commit ids are not the V1 Phase 2 commits in [../V1/phase2/guide.md](../V1/phase2/guide.md) or the V2 Phase 2 commits in [../V2/phase2/guide.md](../V2/phase2/guide.md).

## 1. Execution rules

Read the phase contract before editing code. Planning-time `HEAD` was `c423d7748c84`. Recheck the worktree.

When implementation is authorized:

1. Reinspect the workspace. If a slice is already present, verify it and continue. Do not duplicate it.
2. Run V3P2-C01 through V3P2-C05 in order. Stop after the requested slice.
3. Each slice leaves `pnpm typecheck`, `pnpm lint`, and the tests introduced so far passing.
4. After verification, commit that slice under V1 master Section 1.4 before starting the next one. Do not push or change git config. Leave `Actual commit` blank inside the slice commit, then record the real hash. The last slice's hash is `docs(v3-phase2): record the final slice hash`.
5. ID-05 is verified with Google unset. Do not add credentials to make that check pass.
6. ID-06 is verified with a fake code exchange. A real Google browser round-trip is recorded only when the three settings and a Google account are available. Otherwise name it as not run.

Keep guest create, register, login, promotion, demo peers, the mesh, reconnect, chat, and the broadcast pipeline. Do not add scheduling, replay privacy, deletion, or Q&A.

### 1.1 Commit index

| Order | ID       | Proposed message                                                 | Acceptance          |
| ----- | -------- | ---------------------------------------------------------------- | ------------------- |
| 1     | V3P2-C01 | `feat(api-config): accept an optional Google trio`               | ID-05 config        |
| 2     | V3P2-C02 | `feat(api-auth): identify a host by Google subject`              | ID-06               |
| 3     | V3P2-C03 | `feat(api-auth): exchange a Google code on the server`           | ID-05 routes, ID-06 |
| 4     | V3P2-C04 | `feat(web-home): show Google sign-in only when it is configured` | ID-05, ID-06        |
| 5     | V3P2-C05 | `docs(readme): describe optional Google sign-in`                 | README limits       |

### 1.2 Files to inspect before editing

- `apps/api/src/config/parse-config.ts` and `parse-config.test.ts`
- `apps/api/src/users/user.entity.ts`
- `apps/api/src/sessions/sessions.service.ts`, `sessions.controller.ts`, and `accounts.module.ts`
- `apps/api/src/admission/http-admission.ts` and `http-admission.test.ts`
- `apps/api/src/database/data-source.ts`
- `apps/api/src/migrations/1793923200000-AddHostCredentials.ts`
- `scripts/smoke-broadcast.mjs`
- `.env.example`
- `apps/web/src/App.tsx`
- `apps/web/src/features/session/account-panel.tsx` and `api.ts`
- `apps/web/src/app/entry-graph.test.ts`
- `README.md`

## 2. V3P2-C01 — Optional Google configuration

**Status:** verified; awaiting implementation commit\
**Proposed commit message:** `feat(api-config): accept an optional Google trio`\
**Actual commit:**

**Why:** The API must know whether Google is configured before any route calls it. Unset is the normal local setup. Covers the config half of ID-05.

**Depends on:** The existing config parser and account routes.

**Files:**

- `apps/api/src/config/parse-config.ts`
- `apps/api/src/config/parse-config.test.ts`
- `packages/shared/src/contracts.ts`
- `.env.example`

**Implementation:**

1. Add `google_unavailable`, `google_rejected`, `google_linked`, `google_host_required`, and `password_not_set` to `ApiErrorBody['error']`. Nothing emits them yet.
2. Parse `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` as trimmed strings that default to empty. All empty yields a config with Google disabled. All set yields Google enabled. One or two set fails with the same style of message as the TURN trio: `Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI together.`
3. A set redirect must be an `http` or `https` URL with no userinfo, query, or hash, and with the path exactly `/api/sessions/google/callback`. Reject other paths.
4. Tests cover all empty, all set, each missing member, a redirect with a query, and a redirect whose path is not the callback.
5. Add the three names to `.env.example`, empty, with one comment that they are optional and must be set together. Do not put a real secret in the example.

**Verification:**

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** The default test environment still parses with Google disabled, and no Google route exists yet.

**Verification record (2026-11-05):**

- Execution started at `361f822` with a clean worktree, Node `22.23.2`, and pnpm `12.9.1`. `pnpm install --frozen-lockfile` passed without a lockfile change.
- `pnpm --filter @stageflow/api test -- src/config/parse-config.test.ts` passed all 46 config tests. Coverage includes absent, empty, and whitespace-only settings; trimmed complete HTTP/HTTPS trios; every missing member and singleton; invalid protocols, userinfo, queries, fragments, and callback paths; and diagnostics that omit secret values. Parsed `GOOGLE_ENABLED` is derived from the validated trio.
- `pnpm --filter @stageflow/shared test` passed all 309 tests in 11 files. Its first run alongside the API suite timed out in the existing 50,000-chunk broadcast ledger test; the standalone rerun passed without a source or timeout change.
- `pnpm --filter @stageflow/api test` passed all 371 tests in 27 files, including Redis and disposable PostgreSQL integration. `pnpm typecheck` and `pnpm lint` passed across the workspace.
- `pnpm check:affected --plan --files apps/api/src/config/parse-config.ts apps/api/src/config/parse-config.test.ts packages/shared/src/contracts.ts .env.example plans/phase2.md plans/phase2/guide.md plans/README.md` selected `pnpm check:release`. That run passed all 49 tooling, 309 shared, 456 web, and 371 API tests, workspace typecheck/lint, both builds, repository formatting, artifact checks, and `pnpm smoke:live`.
- `pnpm check:release` failed at its final `pnpm smoke:broadcast` step: `spawn ffmpeg ENOENT` while probing `ffmpeg -version`. No FFmpeg version or broadcast result was obtained. This missing prerequisite does not close any existing V1/V2 gap.
- Changed-file Prettier checks and `git diff --check` passed. All 22 local links in the three changed phase documents resolve, including the C01 record's heading anchor.
- ID-05's config half is verified. Google routes, identity decisions, and browser controls remain for C02 through C04. No Google route was added, no Google exchange or browser round-trip ran, and existing V1/V2 acceptance gaps remain open.

## 3. V3P2-C02 — Subject column and account decisions

**Status:** planned\
**Proposed commit message:** `feat(api-auth): identify a host by Google subject`\
**Actual commit:**

**Why:** Sign-in and link need one place that creates a host, refuses an email match, and links only the current host. Covers ID-06 before HTTP redirects exist.

**Depends on:** V3P2-C01.

**Files:**

- `apps/api/src/migrations/1794009600000-AddGoogleSubject.ts`
- `apps/api/src/database/data-source.ts`
- `apps/api/src/users/user.entity.ts`
- `apps/api/src/sessions/google-identity.ts`
- `apps/api/src/sessions/sessions.service.ts`
- `apps/api/src/sessions/sessions.service.test.ts`
- `scripts/smoke-broadcast.mjs`

**Implementation:**

1. Add nullable `google_subject varchar(255)` and a unique index where it is not null. Register the migration after `AddHostCredentials1793923200000`. Append `AddGoogleSubject1794009600000` to the smoke list. Map it on `User`. Existing guest and password rows stay null.
2. Define a `GoogleProfile` of `{ subject: string, name: string | null }` and a `GoogleCodeExchange` function type. The service methods accept that function. Do not call `fetch` in this slice.
3. `signInWithGoogle(profile)` applies phase Section 5.2 and Section 5.4. Unknown subject inserts a new host even when a row already has the same email text. Known subject loads that row and does not change its email. Return a 7-day host token through the existing host-sign path. Reject a subject that is empty, longer than 255, or contains whitespace or ASCII controls with `google_rejected`, and do not write.
4. `linkGoogle(user, profile)` requires `isGuest === false`. A guest throws `google_host_required`. A subject owned by another id throws `google_linked` and does not save. A subject already on this user returns a host token without a write. A free subject sets only `google_subject` and does not change `session_version`, email, or password hash.
5. Password change on a host whose `password_hash` is null throws `password_not_set` before comparing. A host with a hash keeps the current password-change behavior.
6. Tests use plain profiles. Include a password user `ava@example.com` and a profile whose address would be that email: the new row's email is null, and Ava's id is unchanged. Include a second link attempt for the same subject from another user. Include a guest caller. Assert the exchange argument is not required for these methods; they take the profile directly.

**Verification:**

```powershell
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** The decisions in Section 5.4 pass against a fake profile, and no route redirects to Google yet.

## 4. V3P2-C03 — Code exchange and routes

**Status:** planned\
**Proposed commit message:** `feat(api-auth): exchange a Google code on the server`\
**Actual commit:**

**Why:** The browser must not be trusted for the subject. The API exchanges the code, keeps the secret, and hands the web app a one-time ticket. Covers the route half of ID-05 and the HTTP half of ID-06.

**Depends on:** V3P2-C02. Redis is already the live store. Use a separate short-lived client or the existing Redis connection, quit it on shutdown, and do not put Google keys under `room:*`.

**Files:**

- `apps/api/package.json` and the lockfile
- `apps/api/src/sessions/google-exchange.ts`
- `apps/api/src/sessions/google-exchange.test.ts`
- `apps/api/src/sessions/google-state.ts`
- `apps/api/src/sessions/google.controller.ts`
- `apps/api/src/sessions/accounts.module.ts`
- `apps/api/src/admission/http-admission.ts`
- `apps/api/src/admission/http-admission.test.ts`
- `apps/api/src/sessions/sessions.controller.test.ts` or the nearest existing HTTP test

**Implementation:**

1. Add `google-auth-library`. The real exchange posts the authorization code to Google's token endpoint with the client id, secret, redirect, and PKCE verifier, then verifies the id token for this client id. Read `sub` and, if present, `name`. Drop every email field before returning the profile. A network or verification failure becomes `google_rejected` and does not include Google's body in the message.
2. When Google is disabled, `GET /api/sessions/google` returns `{ enabled: false }`. Start, callback, ticket, and link return 404 `google_unavailable` and do not call the exchange.
3. When Google is enabled, the probe returns `{ enabled: true }` and nothing else. Start stores `{ kind: 'sign-in', verifier }` for 5 minutes and redirects to the authorization URL with `response_type=code`, scope `openid profile`, state, and S256 PKCE. Link does the same with `{ kind: 'link', userId, verifier }` and returns `{ url }` to the current host. The URL host is `accounts.google.com`. The secret is absent from the URL.
4. Callback deletes the state on first read. Sign-in success stores a ticket for 60 seconds and redirects to `{CORS_ORIGIN}/auth/google?ticket={ticket}`. Link success redirects to `{CORS_ORIGIN}/auth/google?linked=1` after the service link writes. Every rejection redirects to `{CORS_ORIGIN}/auth/google?error=google_rejected` or, for a link conflict, `?error=google_linked`. Do not read a return URL from the query.
5. `POST /api/sessions/google/ticket` with `{ ticket }` deletes the ticket and returns the stored session. A missing ticket is `google_rejected`.
6. Start, callback, ticket, and link spend `GUEST_RATE_LIMIT` for any method. The probe does not. Token exchange shares the existing password in-flight cap. Tests can use an in-memory state store and a fake exchange. Assert the fake exchange is not called when Google is disabled. Assert an equal profile email still creates a separate user through the callback service path.
7. Do not log the secret, the code, the verifier, the id token, or the ticket.

**Verification:**

```powershell
pnpm --filter @stageflow/api test
pnpm typecheck
pnpm lint
```

**Done when:** Unset Google refuses the four action routes, and a fake exchange completes sign-in and link without a real Google call.

## 5. V3P2-C04 — Home control and return page

**Status:** planned\
**Proposed commit message:** `feat(web-home): show Google sign-in only when it is configured`\
**Actual commit:**

**Why:** The home page has to hide Google in the ordinary local setup and accept a ticket when sign-in is enabled. Covers the browser half of ID-05.

**Depends on:** V3P2-C03.

**Files:**

- `apps/web/src/features/session/api.ts`
- `apps/web/src/features/session/account-panel.tsx`
- `apps/web/src/pages/GoogleReturnPage.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/app/entry-graph.test.ts`

**Implementation:**

1. Add a probe helper for `GET /sessions/google`. Parse only `{ enabled: boolean }`. Any other body, or a failed response, is treated as disabled.
2. In `AccountPanel`, request the probe when the panel mounts. Render no Google copy while it is disabled or loading failed. When it is enabled, show **Continue with Google** pointing at `{apiUrl()}/sessions/google/start`. On a guest session, include the sentence from phase Section 5.5. On a host session, **Link Google** posts with the bearer token and navigates to the returned `url`.
3. Add `/auth/google`. A `ticket` query redeems `POST /sessions/google/ticket`, stores the session, and navigates to `/`. `linked=1` navigates to `/` and leaves the current session in place. `error=google_rejected` or `error=google_linked` shows that sentence and a link home. Any other query shows the rejected sentence. Replace the history entry so the ticket does not remain in the address bar.
4. Keep `hls`, `LiveRoom`, and chat out of the home page, the account panel, and the return page. Extend the entry-graph test to require the `/auth/google` route and to forbid `hls` in the return page source.
5. With Google unset, open home in the browser and confirm the Google control is absent, then register or log in with email and password. Record the browser. If no browser is available, leave that half of ID-05 unverified and named. Do not mark a real Google round-trip verified unless it was actually run.

**Verification:**

```powershell
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
```

Then check the unset home page in the browser.

**Done when:** Disabled Google adds no control, and the return page can store a redeemed session.

## 6. V3P2-C05 — README

**Status:** planned\
**Proposed commit message:** `docs(readme): describe optional Google sign-in`\
**Actual commit:**

**Why:** The README still says Google is absent. After C04 it must say the feature is optional and that an equal email does not merge accounts.

**Depends on:** V3P2-C04.

**Files:**

- `README.md`
- `plans/phase2.md`
- `plans/phase2/guide.md`
- `plans/README.md`

**Implementation:**

1. Say that Google sign-in appears only when the three API settings are set together. Unset is the local default, and register, login, promotion, and guest entry do not call Google.
2. Say that a new Google subject creates a separate host, that a matching email does not take over an existing account, and that linking uses the current host token. Say that Google does not promote a guest. Say that a Google-only host has no password.
3. Point this behavior at `plans/phase2.md` and this guide. Leave the phase 1 identity links in place.
4. Record the C04 browser result, and say whether a real Google round-trip was run. Do not mark open V2 ids passed.

**Verification:**

```powershell
pnpm exec prettier --check README.md plans/phase2.md plans/phase2/guide.md plans/README.md
```

Read the edited README against phase Sections 5 and 6.

**Done when:** The README matches the optional Google limits and this guide records C01 through C04. C05's hash is recorded in the follow-up `docs(v3-phase2): record the final slice hash`.

**Handoff:** V3 phase 3 is replay visibility and deletion. Do not write `plans/phase3.md` until that phase is requested.
