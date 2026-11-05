# StageFlow — V3 Master Plan

**Direction:** Persistent hosts and organized local sessions.\
**Status:** V3 Phase 1 is complete. V3 Phase 2 is specified in `plans/phase2.md` and is not implemented. Partial and unverified V1 and V2 acceptance ids stay open.\
**Plan version:** `3.0.0-draft.3`\
**Date:** 2026-11-05\
**Revision note (3.0.0-draft.3):** V3 Phase 2, optional Google sign-in, has a contract and guide. Phase 1 identity remains the shipped account behavior. No Google code is included in that planning change.\
**Revision note (3.0.0-draft.2):** V3 Phase 1, host identity, has a contract and guide. The V2 phase files now live in `plans/V2/`. No identity code is included in that planning change.\
**Revision note (3.0.0-draft.1):** Records the approved V3 scope. Identity, scheduling, waiting-room admission, replay privacy, replay deletion, and moderated Q&A are specified here. No application code, phase file, or guide is authorized by this document alone.\
**Inputs:** [Original idea](idea.md), [V1 master plan](MASTER_PLAN.md), [V2 master plan](MASTER_PLAN_V2.md), the current repository, and the approved V3 scope.\
**Deployment:** Excluded. Delivery and acceptance stay local.

## 1. Product decisions and document authority

V3 answers the question V2 left open: a host can come back later and manage sessions over time. Guests and the solo demo stay one click.

The approved choices are:

- Email/password host accounts, plus optional Google sign-in that local acceptance does not require.
- Guest join, guest room creation, and demo peers remain.
- Promoting the current guest turns that same user row into the host account. A matching display name or email never claims history or merges two users.
- Registered hosts can schedule a room, hold early joiners, and admit meeting joiners onto the existing four-person stage.
- Registered hosts get a durable library, link-or-host replay visibility, and deletion of finished or failed broadcast attempts.
- Audience interaction for this version is moderated Q&A. A featured question is drawn on the host's 1280×720 canvas so it is part of the webinar HLS and the replay.

For V3 work, use this chain:

`idea.md` → `MASTER_PLAN.md` (V1 baseline) → `MASTER_PLAN_V2.md` (V2 baseline) → `MASTER_PLAN_V3.md` → `plans/phase<N>.md` → `plans/phase<N>/guide.md`.

- This document overrides V1 and V2 only for the explicit changes in Section 5. Every other engineering and media invariant continues to apply.
- `idea.md` is the original sketch. Its R2 upload, multi-bitrate ladder, BullMQ VOD worker, and email-password-only world stay out. V3 does not revive them.
- V1 history is under `plans/V1/`. V2 history is under `plans/V2/`. Phase 1 is complete. The active V3 phase is `plans/phase2.md` and `plans/phase2/guide.md`. Write a later phase only when that phase is requested.
- Write one phase contract and one guide, after inspecting the repository. Do not pre-generate the other guides.
- This file is not permission to implement. Implementation starts when the user requests a V3 phase.
- Keep slices small and verified. Commit each slice before the next one, using V1's local git discipline. Planning does not require a commit. Do not push or change git config.
- Ordinary implementation choices belong in the active phase. A change to product scope, identity, media topology, or the exclusions in Section 4 requires a revision of this file first.

## 2. Where V2 leaves us

V2 is delivered with partial acceptance. The product today provides:

- Guest JWT sessions, immediate `LIVE` meeting and webinar creation, and join by unguessable slug.
- A current-guest room workspace and per-room broadcast history.
- A four-person raw WebRTC mesh, in-call device replacement, and bounded suspend/resume.
- Webinar hand raising, promotion, demotion, and host media locks. Attendees have zero peer connections and watch HLS.
- Three synthetic demo peers and a live stats drawer.
- Bounded room chat with server timestamps and host pause.
- Host-side 720p composition, ordered WebM uploads, one local FFmpeg process, live HLS, and replay from local disk.
- Server-owned room state, atomic Redis mutations, bounded work, and namespace ownership.

Still partial or unverified, and still not closed by a V3 document: WS-01, WS-02, WS-03, MEDIA-01, MEDIA-02, REC-01, REC-03, REC-04, CHAT-04, MEDIA-03's physical unplug, MEDIA-04 playback, REC-05 playback and FFmpeg, QA-02, and P3-A03, P3-A05, and P3-A06. `pnpm check:release` and `pnpm smoke:broadcast` were skipped when `ffmpeg` was not on `PATH`. Carry these forward. A V3 phase must not mark them passed.

The catalog is PostgreSQL `users`, `rooms`, and `broadcasts`. A user row has `display_name` and `is_guest` only. Room status is `LIVE` or `ENDED`, and creating a room starts it. Broadcast status is `STARTING`, `LIVE`, `STOPPING`, `READY`, or `FAILED`. Live Redis keys live under `<LIVE_NAMESPACE>:room:{roomId}` and include `rev`, `participants`, `stage`, `hands`, `ending`, `broadcast`, `transports`, `resume`, and `deadlines`, plus `:chat:*`. The stage set is keyed by participant id. `LIVE_NAMESPACE` defaults to `sf_<NODE_ENV>`.

V1 keeps HLS directories after the broadcast ends. Disk growth is an accepted limitation until the deletion contract in Section 8 ships.

## 3. V3 product promise

**A registered host can sign in on a later day, find their sessions and replays, schedule a meeting or webinar, admit people onto the stage, hide or delete a finished replay, and feature an audience question on the webinar broadcast.**

A guest can still enter a display name, create a live room, join by link, watch a link-accessible replay, and run the solo demo. New product features must keep that path free of a password, a Google account, an external service, and a second person.

### 3.1 Included scope

| Area            | V3 outcome                                                                             |
| --------------- | -------------------------------------------------------------------------------------- |
| Host account    | Email and password registration, login, logout, and in-session password change         |
| Optional Google | Sign-in and explicit link when configured; hidden and refused when not                 |
| Guest promotion | The current guest row becomes the host account and keeps the rooms it already owns     |
| Guest path      | One-click guest session, immediate live create, demo peers, and link-accessible replay |
| Scheduling      | A registered host creates a `SCHEDULED` room and opens it with an explicit Start       |
| Waiting room    | Early joiners wait off stage. Meeting admission is a host action when required         |
| Library         | A registered host sees their rooms and broadcasts from any browser after login         |
| Replay privacy  | Each broadcast is link-accessible or host-private                                      |
| Deletion        | The owning registered host deletes a `READY` or `FAILED` attempt and its HLS directory |
| Q&A             | Moderated questions, upvotes, and one featured question drawn on the webinar canvas    |

## 4. Ceilings and exclusions

Ceilings that stay:

- Stage occupancy remains four, including suspended reconnect reservations. Waiting people do not occupy a seat.
- Webinar attendees have zero peer connections and acquire no camera or microphone until promoted and consenting.
- Broadcasts stay host-produced, single-rendition 720p HLS on local disk, with one active attempt per room and one FFmpeg process.
- Guest JWTs keep the 12-hour lifetime and have no refresh token.
- Chrome and Edge on Windows desktop remain the acceptance targets.
- PostgreSQL is the catalog. Redis is ephemeral live state. Media stays on local disk.

V3 leaves these out:

- SMTP, email verification, and emailed password reset. A forgotten password is a documented limit.
- Account merge, display-name recovery, and treating an equal email string as proof of ownership.
- Guest refresh tokens and a permanent guest identity that survives the guest row.
- Auto-start when `scheduledStartAt` arrives. No calendar sync and no emailed invite.
- A waiting-room media stage, a fifth seat, or reconnect grace for someone who holds no seat.
- Polls, reactions, direct messages, attachments, transcription, co-host, and host transfer.
- Q&A stored in PostgreSQL, Q&A synced as a replay transcript, and a meeting broadcast created so a question can be recorded.
- A retention sweeper, export, a second transcode, object storage, and deployment.
- SFU, simulcast, multi-rendition HLS, LL-HLS, and `restartIce`.
- Making existing replays private as part of migration or promotion.
- Google credentials as a requirement for acceptance.

## 5. Explicit changes from the V2 contract

| Current rule                           | V3 replacement                                                                                  | Owning phase |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------ |
| Users are guests only                  | Add email/password host accounts on the same `users` table. Guests remain                       | V3-P1        |
| No OAuth                               | Optional Google sign-in and explicit link. Absent configuration refuses the route               | V3-P2        |
| Workspace is "this guest session"      | A registered login resolves the same user, so the list is that host's library. Guest copy stays | V3-P1        |
| Every replay with the link is playable | `LINK` stays that way. `HOST` plays only for the registered owner                               | V3-P3        |
| No replay deletion                     | Registered owner may delete `READY` or `FAILED`, including the validated HLS directory          | V3-P3        |
| Create always starts `LIVE`            | Registered hosts may also create `SCHEDULED`. Guest create stays immediate `LIVE`               | V3-P4        |
| Join of a non-live room is rejected    | `SCHEDULED` joiners wait off stage until Start, and meeting admission can hold them after that  | V3-P4        |
| No Q&A                                 | Bounded moderated Q&A. One featured question is drawn on the live webinar canvas                | V3-P5        |

Chat, device replacement, reconnect, the mesh, and the broadcast pipeline stay as V2 shipped them. Namespace ownership, atomic Lua writes, server authorization, media cleanup, upload budgets, and ordered chunk semantics stay in force.

## 6. Identity

### 6.1 Guest session

`POST /api/sessions/guest` stays `{ displayName }` → `{ token, userId, displayName }`.

- Display name stays 1–40 characters after trim, with ASCII control characters rejected.
- The JWT expires in 12 hours. There is no refresh token.
- The row is inserted with `is_guest = true`.
- Demo peers still request their own guest sessions. `isSyntheticBot` remains a display flag, not a privilege.
- Existing guest tokens keep working through the claim change in Section 6.3. A missing session version means version 0.

### 6.2 Registered email and password

A registered user has `is_guest = false` and a slow password hash. The phase file chooses argon2id or bcrypt, records the choice, and tests it. The password is never stored or logged.

- Email is trimmed and lowercased, unique among password accounts, and rejected when it contains control characters or is empty. The phase sets the maximum length.
- Register and login return the same bearer shape the socket handshake already accepts: `{ token, userId, displayName }`.
- Host token lifetime is 7 days. A phase may tune that value only by recording the old value, the new value, and the reason.
- Logout clears the client token. V3 has no server denylist.
- Password change requires the current password, writes a new hash, and increments `session_version`. Older tokens for that user fail.
- There is no verification mail and no reset mail.

A registered host can create an immediate `LIVE` room or a `SCHEDULED` room. Guest create remains immediate `LIVE` only.

### 6.3 Token claims

Every new token carries `sub` (user id), `sv` (session version), and `guest` (boolean). Requests and the socket handshake load the user and reject the token when `sv` does not match `session_version`, or when `guest` does not match `is_guest`. Signing and verification stay on the server. The client does not choose these claims.

### 6.4 Google

Google is optional. When the Google client settings are absent, the API refuses the Google routes and the web UI hides the control. Email/password and guest acceptance do not call Google.

When settings are present:

- The API performs the code exchange. A client-supplied email or profile is not proof of identity.
- The stored authority is the provider subject, unique on `users`.
- The address returned by Google is not written into the unique email column and is not a lookup key.
- An unknown subject creates a new `is_guest = false` user with no password. It does not attach to an existing row whose email text matches.
- Linking writes that subject onto the user identified by the current registered JWT, and only when the subject is unused. A conflict leaves both users unchanged.

### 6.5 Guest-to-host promotion

Promotion is a dashboard action for the user named by the current guest JWT.

- Set email, password hash, `is_guest = false`, and an incremented `session_version` on that same row.
- Rooms with `host_id` equal to that user id stay on that row. Their broadcasts stay with those rooms.
- Do not search by display name or email. Do not move rooms from any other user. Do not merge rows.
- If the email is already used, fail and leave the guest row unchanged.
- Refuse promotion while that user id is present in any live room membership. The person leaves the live call first.
- Issue a new host token. The previous guest token fails because `guest` and `session_version` no longer match.
- Replays on those rooms stay `LINK` until the host changes visibility.

### 6.6 Library wording

The room list stays a server query scoped to the authenticated user id. A caller-supplied host id is ignored.

- Guest UI copy remains "Rooms from this guest session" and still explains that a new guest session cannot recover rooms by display name.
- Registered UI copy presents that user's rooms and broadcasts as the host library. Login on another browser shows the same rows because it resolves the same user id.

## 7. Scheduled sessions and waiting room

### 7.1 Lifecycle

Room status becomes `SCHEDULED | LIVE | ENDED`.

- Guest create inserts `LIVE`, as today.
- Registered create accepts `LIVE`, or `SCHEDULED` with a `scheduledStartAt` UTC timestamp. A timestamp in the past is allowed and does not start the room. Immediate `LIVE` rooms store a null start time.
- `scheduledStartAt` is the advertised time. No clock, worker, or page timer opens the stage, admits waiters, or starts FFmpeg.
- **Start** is available only inside the scheduled room, from the host's current pre-start membership. It moves that room to `LIVE` and seats the host first.
- **Cancel** from `SCHEDULED` sets `ENDED` and `ended_at`, clears that room's waiting key, and never creates a broadcast.
- Existing rows stay `LIVE` or `ENDED`. The migration does not rewrite them to `SCHEDULED`.
- An `ENDED` room still rejects new joins. A broadcast can still be started only by the host of a `LIVE` webinar.

Before Start, the host's socket membership has role `HOST`, is absent from the stage set, and is absent from the waiting set. The host can see the queue. The host has no stage media and no peer connections yet.

### 7.2 Waiting queue

Early joiners of a `SCHEDULED` room, and held joiners of a live meeting that requires admission, enter waiting.

- Redis sorted set: `<LIVE_NAMESPACE>:room:{roomId}:waiting`. Score is the server arrival time. Member is the server-issued participant id, the same identity the stage set uses.
- The key takes the room's live TTL and is deleted with `<LIVE_NAMESPACE>:room:*` on startup and on room end.
- Cap the set at 100 members. Past that, join fails with an explicit error and writes nothing.
- A waiter is not in the stage set, holds no suspended reservation, and does not count toward four.
- Off-stage media policy applies: muted, video off, no screen share. The client does not call `getUserMedia` and does not create a peer connection.
- A waiting socket that drops is removed. There is no 20-second grace and no resume credential for that wait. Rejoin allocates a new membership at the back of the queue.
- The host can remove one waiter. Removal drops that membership and does not seat anyone else.
- Demo peers are created only after the host is `LIVE` and on stage. The demo control stays disabled before Start. A demo peer is never inserted into the waiting set.

Admit and the automatic seat fill are Lua scripts. Node does not read the stage set, decide, and write it back. The seat check is the existing four-person rule, including suspended reservations. A full stage returns `stage_full` and leaves the waiter in the set.

### 7.3 Meetings

Rooms have `require_admission`, default false. It is meaningful for `MEETING` only. Setting it true on a webinar is rejected.

- **Off.** Start seats the host, then admits waiters in score order until four seats are taken. Later joiners use the current meeting join. When a seat frees, the oldest waiter is admitted by the same script.
- **On.** Start seats only the host. Later joiners wait. **Admit** moves one chosen waiter to `SPEAKER` when a seat is free. A leave does not pull the next waiter.

### 7.4 Webinars

Start seats the host, then moves pre-start waiters to `ATTENDEE` without taking stage seats. After `LIVE`, new joiners become attendees directly, still with zero peer connections. The stage is reached only through the existing hand-raise promote path. `require_admission` does not apply.

## 8. Replay privacy and deletion

### 8.1 Visibility

Each broadcast has visibility `LINK` or `HOST`. The default, and the migration value for every existing row, is `LINK`.

- `LINK` keeps today's playback. A guest with the replay URL can open the broadcast JSON, thumbnail, playlist, and segments. The library list remains owner-scoped.
- `HOST` serves those bytes and that JSON only to the registered owner of the room (`is_guest = false` and `host_id` is the caller). Everyone else receives `broadcast_not_found`.
- A guest-owned room cannot be switched to `HOST`. Promotion does not change visibility.

### 8.2 Deletion

The registered owner may delete one broadcast when its status is `READY` or `FAILED`, and when the room's Redis broadcast key is absent or names a different id.

Refuse `STARTING`, `LIVE`, and `STOPPING`.

The cleanup service resolves `{dataRoot}/broadcasts/{broadcastId}/` and refuses a path that escapes `dataRoot` or does not belong to that id. This is the same confinement rule the HLS server already uses.

Deletion order:

1. Claim the row so a second delete and playback both fail closed.
2. Delete that directory only after the path check.
3. Delete the row only after the directory is gone.
4. If the directory delete fails, restore the previous status, keep the row visible to the owner, record the failure, and report failure. Retry is allowed.
5. If the directory is already gone and the row remains, a retry removes the row and does not offer playback.

Success means both the row and that directory are gone. The room row remains. The old replay URL then follows the normal not-found path. There is no sweeper, no age-based retention, and no export. Replays the host does not delete continue to use disk.

## 9. Moderated Q&A

Polls stay out. Chat's keys, limits, pause, and history stay as V2 shipped them. Q&A uses its own `:qa:` keys under the same room prefix and is not a chat message.

### 9.1 Who can do what

Connected hosts, speakers, and attendees may submit a question and cast one upvote per question. The server copies the author display name and participant id from membership and ignores client-supplied identity fields.

The host may dismiss one question, close or open new submissions, feature one question, or clear the feature. A dismiss of the featured question clears the feature. Room end and namespace reset drop the Q&A keys with the rest of the room.

### 9.2 Bounds

- Question text is 1–200 characters after trim, at most 1,000 UTF-8 bytes, with ASCII control characters rejected.
- At most 100 questions are retained per room. A full board rejects a new question with an explicit error.
- Submissions and votes have per-user and per-room rate limits. The phase records the numbers and tests them.
- Store questions, votes, submission lock, and the featured id in Redis. Writes are atomic. The room TTL applies.
- Render text. Do not accept or display HTML.
- Q&A is not written to PostgreSQL and is not a replay transcript.

### 9.3 Feature on stage

The featured value is `{ questionId, text, authorName }` or null. It is included in the room snapshot, or in a dedicated ordered event if the phase keeps it out of the full snapshot. It is small either way. One question is featured at a time.

While a webinar broadcast is drawing frames, the existing 1280×720 host canvas paints a lower-third with that question and author using canvas text. Text that does not fit is truncated with an ellipsis. Those pixels travel through the current WebM chunks into the live HLS and the `READY` replay.

- Featuring a question does not start a broadcast.
- Before frames are running, the feature is room state only.
- The host UI shows a local banner for the same text. Mesh tiles remain the camera or screen. The banner is not a second recording, a second encoder, a server-side overlay, or another video track.
- Upvote counts stay in the sidebar and are not painted on the frame.
- A meeting has the same sidebar and local banner. Meeting broadcast start remains rejected, so a meeting feature is not in an HLS file.

Sidebar Q&A is live and ahead of the attendee player. The lower-third inside the HLS frame is the copy that matches the recording. The room says so, in the same spirit as the existing chat delay note.

## 10. Architecture and compatibility

Keep the pnpm workspace, React/Vite web app, NestJS API, shared contracts, PostgreSQL, Redis, and the FFmpeg pipeline.

| Responsibility                                         | Ownership                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| DTOs, parsers, visibility, room status, and Q&A limits | `packages/shared`                                           |
| Users, password hash, tokens, promotion                | API sessions/users                                          |
| Google code exchange, only when configured             | API auth, behind a missing-config refusal                   |
| Room status, admission flag, library queries           | API rooms                                                   |
| Visibility and deletion                                | API broadcasts plus the existing path confinement           |
| Waiting, admit, and seat fill                          | Live Lua scripts and the current stage-cap rule             |
| Q&A acceptance and feature state                       | A feature-owned service using room membership for authority |
| Canvas lower-third                                     | The existing host compositor                                |
| Library, schedule, admit, and Q&A UI                   | Feature components that do not own peers or the recorder    |

Schema changes are TypeORM migrations. `synchronize` stays forbidden. Preserve existing guest users, rooms, and `READY` media. Test upgrades on a disposable copy. Live presence may reset on restart under the current policy. New tokens must not invalidate a current guest token that has no `sv` claim.

No recordings, credentials, tokens, password hashes, or filled `.env` files enter git.

## 11. Delivery phases and exit gates

Do not add a later phase's feature to finish the current one. All ids below start **planned**.

| Phase                           | Outcome                                                                                    | Main boundary                                                                                 | Exit evidence         |
| ------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------- |
| V3-P1 Identity                  | Register, login, logout, password change, and dashboard promotion of the current guest row | Guest create, guest join, and demo peers stay. No Google. No promotion from a live membership | ID-01 through ID-04   |
| V3-P2 Google                    | Optional sign-in and explicit link                                                         | Acceptance passes with Google unset                                                           | ID-05, ID-06          |
| V3-P3 Library lifecycle         | `HOST` visibility and safe delete of `READY` / `FAILED`                                    | No sweeper. In-flight attempts stay                                                           | LIB-01 through LIB-04 |
| V3-P4 Schedule and waiting room | `SCHEDULED` rooms, Start, Cancel, waiting Lua, meeting Admit                               | Cap includes suspensions. Webinar attendees still have zero peers                             | SCH-01 through SCH-05 |
| V3-P5 Q&A                       | Moderated questions and the canvas lower-third                                             | Chat unchanged. Meetings do not gain a broadcast                                              | QA3-01 through QA3-04 |
| V3-P6 Acceptance                | The local script passes and the README records the limits                                  | No new feature family. Open V1/V2 physical gaps stay named                                    | ACC-01 through ACC-03 |

## 12. Requirement register

| ID     | Observable result                                                                                                                                                                          | Required evidence                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| ID-01  | A new email and password can register, log in from a fresh client, and see rooms owned by that user. A wrong password fails and changes nothing                                            | API regressions and a browser login                      |
| ID-02  | Logout drops the client session. Password change makes the previous token fail and the new token work                                                                                      | Token-version regressions                                |
| ID-03  | Promotion of the current guest keeps that user id's rooms and broadcasts, rejects a taken email, and rejects a live membership                                                             | Service regressions with two users and a live membership |
| ID-04  | Guest create, guest join, demo peers, and a 12-hour guest token still work. A guest list still says it is this guest session                                                               | Existing guest checks plus the unchanged copy            |
| ID-05  | With Google settings absent, Google controls are hidden, Google routes refuse, and ID-01 still passes                                                                                      | Config-off regression                                    |
| ID-06  | With Google settings present, an unknown subject creates a separate user. An equal email does not attach it. Linking requires the current account's token and a free subject               | Service regressions against a fake code exchange         |
| LIB-01 | `LINK` playback still works for a guest with the URL. `HOST` plays for the registered owner and returns `broadcast_not_found` for anyone else                                              | Authorization regressions and a browser replay           |
| LIB-02 | Existing rows and promoted rooms stay `LINK` until the owner changes them. A guest owner cannot set `HOST`                                                                                 | Migration and authorization regressions                  |
| LIB-03 | The owner can delete a `READY` or `FAILED` attempt. The row and that broadcast directory are both gone. A path outside `dataRoot` is not deleted                                           | Service test on a disposable directory                   |
| LIB-04 | `STARTING`, `LIVE`, and `STOPPING` cannot be deleted. A failed directory delete keeps the row visible and reports failure                                                                  | Status and failure regressions                           |
| SCH-01 | A registered host can create `SCHEDULED`, share the slug, and see waiters. A guest create is still `LIVE`. Nothing starts because the clock passed                                         | API and browser schedule flow                            |
| SCH-02 | Waiters have no stage seat, no capture, and no peer connection. The 101st waiter is rejected. A dropped waiter is gone and rejoins at the back                                             | Lua/Redis integration and a browser join                 |
| SCH-03 | Start seats the host first. With admission off, waiters fill free seats in order, counting suspensions, and never create a fifth seat. With admission on, only Admit seats the next person | Concurrent Redis tests                                   |
| SCH-04 | A scheduled webinar releases pre-start waiters as attendees with zero peer connections. Promote still uses the free-seat rule                                                              | Webinar join and promote regression                      |
| SCH-05 | Cancel ends a scheduled room without a broadcast. Demo peers cannot be spawned before Start                                                                                                | Service and browser check                                |
| QA3-01 | Connected members submit and upvote. Forged names are ignored. Length, count, and rate limits hold                                                                                         | Service/Redis tests and a two-window room                |
| QA3-02 | The host can dismiss, close submissions, feature one question, and clear it. Non-hosts cannot                                                                                              | Authorization regressions                                |
| QA3-03 | During a webinar broadcast, the featured question and author are visible in the played HLS. The mesh tile is unchanged. A meeting feature does not create a broadcast                      | Browser broadcast and a real FFmpeg replay check         |
| QA3-04 | Chat pause, history, and limits still behave as in V2. Q&A failure does not drop the stage or the broadcast                                                                                | Existing chat checks plus failure isolation              |
| ACC-01 | Guest demo, four-seat cap, attendee isolation, reconnect reservation, ordered upload, and missing-FFmpeg behavior still hold                                                               | Affected existing checks                                 |
| ACC-02 | Migrations preserve prior guests, rooms, and `READY` files. Destructive tests use disposable fixtures                                                                                      | Migration/restart record                                 |
| ACC-03 | The README states host accounts, guest limits, scheduling, waiting, privacy, deletion, Q&A burn-in, local setup, and every still-open physical gap                                         | Documentation review                                     |

V3-P2 may ship ID-06 only when Google settings and a fake or real code exchange are available. ID-05 is the acceptance path that must pass in the ordinary local setup.

## 13. Verification

Use the V1 affected-check policy. Run typecheck, lint, and the existing tests for the packages a slice touches. Add tests for token version, promotion, visibility, path confinement, waiting-queue races, and the stage cap. Redis races use real Redis. Browser fakes do not verify capture, HLS pixels, or device behavior. An FFmpeg check looks at the playlist output.

The combined local script, when V3-P6 is requested:

1. Enter as a guest, create a live meeting, run the solo demo, and confirm the four-seat cap and cleanup.
2. Promote that guest from the dashboard. Log out. Log in from a fresh client and see the same rooms.
3. Register a second host and confirm they cannot see or delete the first host's rows.
4. Create a scheduled meeting, join early in another window, confirm the waiter has no media, Start, and confirm admission order and the seat cap.
5. Create a scheduled webinar, hold early attendees, Start, and confirm they watch with zero peer connections.
6. Start a broadcast, feature a question, and play the HLS back far enough to see that question and author.
7. Set a finished replay to `HOST` and confirm a different guest with the URL is refused. Delete a `READY` or `FAILED` disposable attempt and confirm the URL and directory are gone.
8. Repeat the important controls by keyboard. Leave every context and confirm tracks, peers, recorders, and FFmpeg are released.

Outstanding V1 and V2 physical observations stay unverified until they are actually observed.

## 14. Risks

| Risk                                                                | Control                                                                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Promotion or Google attaches somebody else's rooms                  | Mutate only the JWT user id. Unique email and unique Google subject. No match on display name or email text |
| A host token and a guest token disagree about the same row          | `guest` and `session_version` are checked against the row on every request                                  |
| Admit creates a fifth stage member                                  | One Lua script uses the current seat count, including suspensions                                           |
| Waiters are given peer connections "just for the lobby"             | Off-stage policy and a client that does not capture or negotiate before seating                             |
| Delete removes the wrong directory                                  | Confined path check before any unlink. Failure restores the row                                             |
| A private replay stays reachable through an old playlist URL        | `HOST` is enforced on JSON, thumbnail, playlist, and segments                                               |
| The lower-third exists only in the sidebar, so the replay misses it | Paint it in the host canvas that already feeds the WebM                                                     |
| Q&A or waiting work delays leave and signaling                      | Separate bounded keys and queues, same as chat                                                              |
| V3 turns into an SFU, a mailer, or a deployment                     | Section 4 exclusions. One phase at a time                                                                   |
| Open hardware gaps disappear from the status                        | ACC-03 names them until they are observed                                                                   |

## 15. Next execution request

V3 Phase 2 is specified and not implemented. V3 Phase 1 is complete.

> Read `MASTER_PLAN_V3.md`, `plans/phase2.md`, and `plans/phase2/guide.md`. Implement V3P2-C01 through V3P2-C05 in order when implementation is requested. Keep email/password accounts, the guest session, demo peers, the mesh, reconnect, chat, and the broadcast pipeline. Do not write `plans/phase3.md` in that work. Leave the open V2 acceptance ids open. Google stays optional: the unset configuration must pass.
