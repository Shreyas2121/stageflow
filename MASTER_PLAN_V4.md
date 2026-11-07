# StageFlow — V4 Master Plan

**Direction:** A hosted small webinar.\
**Status:** Scope approved. No V4 phase file, guide, or application code is authorized. Public release remains unapproved.\
**Plan version:** `4.0.0-draft.1`\
**Date:** 2026-11-07\
**Revision note (4.0.0-draft.1):** Records the approved V4 scope. One public origin, cross-network stage connectivity, a phone audience, password reset, replay size, and one invited-session acceptance are specified here. This file does not deploy, provision TURN, send mail, or close a V3 gate.\
**Inputs:** [Original idea](idea.md), [V1 master plan](MASTER_PLAN.md), [V2 master plan](MASTER_PLAN_V2.md), [V3 master plan](MASTER_PLAN_V3.md), the current repository, and the approved V4 scope.\
**Deployment:** The operating profile already exists. Operating it on the real host, and supplying TURN credentials, are separate requested steps. This document does not perform them.

## 1. Product decisions and document authority

V4 answers the question V3 left open: someone who is not the developer can open a link and attend. The host still runs the stage from a desktop browser. Everyone else watches the host's broadcast.

The approved choices are:

- One public HTTPS origin on the host already named in the deploy profile, using the existing single writer and the shared PostgreSQL/Redis guard.
- TURN for stage peers that cannot connect directly, plus a bounded ICE restart while the signaling socket stays up.
- A phone can watch a webinar and a replay. It can chat, ask a question, and raise a hand. It cannot join the mesh.
- Email/password hosts can reset a forgotten password through one mail path. Login does not require a verified mailbox.
- The host library shows the size of each finished replay. Deletion stays the existing owner action.
- Acceptance is one invited webinar: a remote desktop speaker and a phone viewer. Audience size stays unpromised.

The V2 roadmap's V4 row recommended a media-depth choice. This document replaces that recommendation. The four-person mesh and the single 720p host broadcast stay.

For V4 work, use this chain:

`idea.md` → `MASTER_PLAN.md` (V1 baseline) → `MASTER_PLAN_V2.md` (V2 baseline) → `MASTER_PLAN_V3.md` (shipped product) → `MASTER_PLAN_V4.md` → the requested phase file → its guide.

- This document overrides V1, V2, and V3 only for the explicit changes in Section 5. Every other engineering and media invariant continues to apply.
- `idea.md` stays the original sketch. Its object-storage upload, multi-bitrate ladder, and server-side mix stay out.
- V1 history is under `plans/V1/`. V2 history is under `plans/V2/`. Shipped V3 contracts remain `plans/phase1.md` through `plans/phase6.md` until a V4 phase is requested.
- This file creates no phase. When the user requests V4 phase N, move those V3 contracts and guides to `plans/V3/`, repoint the plans index, and write only `plans/phase<N>.md` and `plans/phase<N>/guide.md`. Do not pre-generate the other V4 guides. Do that move inside the requested planning step, not before it.
- This file is not permission to implement, deploy, or buy a relay. Implementation starts when the user requests a V4 phase. Operating the public host starts only when that request is the public-origin phase and it explicitly includes the host.
- Keep slices small and verified. Commit each slice before the next one, using V1's local git discipline. Planning does not require a commit. Do not push or change git config.
- Ordinary implementation choices belong in the active phase. A change to product scope, identity, media topology, or the exclusions in Section 4 requires a revision of this file first.

## 2. Where V3 leaves us

V3 feature phases 1 through 5 are delivered. [Phase 6](plans/phase6.md) records local acceptance and leaves the target gates open. The shipped product provides:

- Guest sessions, email/password host accounts, optional Google sign-in, and promotion of the current guest row.
- A registered host's library, `LINK` or `HOST` replay visibility, and deletion of a `READY` or `FAILED` attempt.
- Immediate live rooms and `SCHEDULED` rooms with an explicit Start, a waiting queue, and meeting admission.
- A four-person raw WebRTC mesh, in-call device replacement, and a 20-second socket-loss grace period.
- Webinar hand raising, promotion, demotion, and host media locks. Attendees have zero peer connections and watch one 720p HLS broadcast.
- Three synthetic demo peers, a stats drawer, bounded chat, and moderated Q&A with one featured question painted on the webinar canvas.
- Production packaging, a locally tested single-writer profile, and external mode for the existing shared PostgreSQL and StageFlow Redis. No public service has been deployed. Google stays unconfigured for that path.

Still open, and not closed by this document: VPS-INGRESS, VPS-CAPACITY, VPS-TURN, VPS-ALERTS, VPS-RECOVERY, VPS-BACKUP, PHYSICAL, and the partial ACC-01 browser run. Carried V1/V2 gaps stay as Phase 6 names them. A V4 phase must not mark them passed because this plan exists.

The public name in the deploy profile is `stage.shreyasrasaikar.cloud`. The apex stays untouched. External mode talks only to `stageflow_db` and the existing StageFlow Redis. Retained media is capped at 1 GiB. The external-mode mount is 8 GiB because it also holds one local snapshot and a 2 GiB free-space floor. TURN settings exist and are empty. The player uses `hls.js` and tells an unsupported browser that it cannot play. A forgotten password has no recovery. Logout does not revoke other clients. There is no SMTP.

## 3. V4 product promise

**A registered host can share one public link. A desktop speaker on another network can join the stage. A person with a phone can watch the delayed webinar, talk in chat, and see the featured question again in the replay.**

A guest can still enter a display name, create a live room, join by link, watch a link-accessible replay, and run the solo demo on one machine. Those paths stay free of a password, a mailbox, Google, TURN, and a second person. When TURN is unset, the local stage behaves as it does today.

The ceiling is part of the promise. One live room. Four people on a desktop stage, including the host and any suspended seat. The host's open desktop browser remains the encoder. Audience size is unpromised until a measured run says otherwise. The first public trial stays the existing allowlist: one room, four stage users, and two viewers.

### 3.1 Included scope

| Area            | V4 outcome                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Public origin   | The named host serves the production web build over HTTPS, with WSS on that same origin               |
| Stage reach     | Two remote networks can complete a relayed stage call, including audio and video both ways            |
| ICE restart     | A live signaling socket can restart ICE on the existing peer connection                               |
| Phone audience  | Mobile Chrome and Safari play the webinar and the replay, and can use chat, questions, and hand raise |
| Watch-only      | A phone attendee is not captured, not meshed, and not promotable                                      |
| Password reset  | An email/password host sets a new password from a single-use mail link                                |
| Replay size     | The registered owner sees the size of each `READY` or `FAILED` attempt                                |
| Invited session | One real remote speaker and one phone viewer complete the acceptance script                           |

## 4. Ceilings and exclusions

Ceilings that stay:

- Stage occupancy remains four, including suspended reconnect reservations. Waiting people and watch-only attendees do not occupy a seat.
- Webinar attendees have zero peer connections. A watch-only attendee never acquires a camera or microphone.
- Broadcasts stay host-produced, single-rendition 720p HLS on local disk, with one active attempt per room and one FFmpeg process.
- Guest JWTs keep the 12-hour lifetime. Host JWTs keep the 7-day lifetime. There is no refresh token and no server denylist.
- PostgreSQL is the catalog. Redis is ephemeral live state. Media stays on the private disk under `DATA_ROOT`.
- Chrome and Edge on Windows desktop remain the stage acceptance targets. Phone Chrome and phone Safari are audience-playback targets only.
- The shared-host trial allowlist and the 1 GiB retained-media cap stay. V4 does not publish a capacity number.

V4 leaves these out:

- A fifth seat, an SFU, simulcast, a second rendition, low-latency HLS, server-side mixing, and an encoder that is not the host browser.
- Mobile speakers, mobile screen share, and promotion of a watch-only attendee.
- Co-host, host transfer, and a change to the 20-second socket grace.
- Calendar sync, emailed invitations, marketing mail, and an email-verification wall in front of login.
- A password for a Google-only host, account merge, and guest refresh tokens.
- Replay transcripts of chat or Q&A, polls, reactions, direct messages, and attachments.
- A retention sweeper, export, object storage, and a new media quota.
- Removing the trial allowlist, a public audience number, and closing PHYSICAL by writing it into this plan.
- Treating a local fixture, a self-signed certificate, or a loopback candidate as the public-origin or TURN proof.

## 5. Explicit changes from the V3 contract

| Current rule                                                     | V4 replacement                                                                                 | Owning phase |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------ |
| Public ingress is loopback unless a later request says otherwise | The public-origin phase may operate the existing profile on the named host                     | V4-P1        |
| TURN is optional configuration without a remote proof            | A configured relay must be proven between two remote networks, including expiry and exhaustion | V4-P2        |
| ICE failure while the socket stays up is not recovered           | Bounded `restartIce` on that same peer connection, without enabling media or adding a seat     | V4-P2        |
| An unsupported player says the browser cannot play               | Phone Safari uses native HLS. Desktop playback stays on `hls.js`                               | V4-P3        |
| Any attendee may be promoted                                     | A watch-only attendee stays off stage. Promote is refused                                      | V4-P3        |
| A forgotten password has no recovery                             | Email/password accounts reset through one mail path. Missing mail settings refuse the route    | V4-P4        |
| Replay history does not show size                                | The registered owner sees the confined directory size of a `READY` or `FAILED` attempt         | V4-P4        |

Chat, Q&A, scheduling, waiting, visibility, deletion, device replacement, socket grace, the mesh, and the broadcast pipeline stay as V3 shipped them, except where the table changes promotion and playback. Namespace ownership, atomic Lua writes, server authorization, media cleanup, upload budgets, and ordered chunk semantics stay in force.

## 6. Public origin

V4-P1 operates the profile in [deploy/README.md](deploy/README.md) and [deploy/CICD.md](deploy/CICD.md). It does not invent a second topology.

- The origin is `https://stage.shreyasrasaikar.cloud`. Leave `shreyasrasaikar.cloud` and its DNS alone.
- The site serves the production web build. Socket.IO uses WSS on that same origin. The API binds on loopback behind the existing nginx. Media files stay unmapped.
- External mode is mandatory on that host. StageFlow must not start, stop, dump, or restore `shared-postgres`, and it must not touch a database other than `stageflow_db`. The existing StageFlow Redis is the only Redis it may use.
- Google stays unset. The trial stays IP-allowlisted: one room, at most four stage users and two viewers, one recording.
- Certificate renewal, the private port check, and one supported browser flow on the real origin are the ingress observation. A local self-signed fixture is not that observation.
- This phase records VPS-INGRESS only when those public-network facts are seen. It leaves VPS-CAPACITY, VPS-TURN, VPS-ALERTS, VPS-BACKUP, VPS-RECOVERY, and PHYSICAL open.
- No application feature is added to make the origin look finished. Guest create, host login, and the solo demo remain available on that origin within the allowlist.

## 7. Cross-network stage

### 7.1 TURN

The API already accepts `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL` together and rejects a partial set. V4 keeps that shape. Credentials stay in deployment configuration and out of git.

- The relay is an operator-provided server with a quota and an expiry. The API does not embed a TURN server and does not invent long-term relay accounts.
- Stage peers receive the configured ICE servers as they do today. Attendees, waiters, and watch-only clients receive no peer connection, so they allocate no relay.
- Acceptance needs two networks that are not the same LAN. Each desktop speaker is current Chrome or Edge. The stats drawer shows a relay candidate, and each person can see and hear the other.
- After credential expiry, and when the quota is exhausted, a new relay allocation fails, the page says so, and the room gains no seat and no extra peer connection.
- Relay traffic counts against the operator's TURN quota. It is not a license to raise the audience cap.
- With the three settings empty, local behavior stays STUN and host candidates. The solo demo must still pass. That empty configuration does not satisfy the remote proof.

### 7.2 ICE restart

Socket loss keeps the V2 state machine: unexpected loss suspends the membership for 20 seconds, media stops, and resume starts with devices off. ICE restart is the other failure, the one where the signaling socket for the current generation is still up and the ICE transport is not.

- The page may call `restartIce` on the existing `RTCPeerConnection` for that remote participant. It must not open a second connection for the same participant.
- The current tracks stay attached, including muted, video-off, and an active screen share. Restart does not call `getUserMedia`, does not unmute, and does not start screen share.
- A restart from an old connection generation is ignored. A socket drop cancels the restart and the grace-period path owns recovery.
- Success is media on the same seat. Failure shows a visible rejoin error. It does not reserve a second seat and does not mark the participant suspended while the socket remains current.
- The phase sets the debounce and records the old value, the new value, and the reason if it changes. Attendees never call it.

## 8. Phone audience

### 8.1 Playback

The attendee room and the replay page play the existing single playlist.

- On desktop Chrome and Edge, playback stays on `hls.js`, loaded only from the playback chunk. Home still must not import it.
- On phone Safari, and on any browser where `hls.js` is unavailable and the video element can play HLS, the page sets the playlist on the element and does not load `hls.js`.
- `playsInline` stays. A failed playlist shows the existing failure state. Speaker selection keeps its current fallback where `setSinkId` is missing.
- The attendee view states that the picture lags the room. The chat sentence stays: chat is live and is not synced to the delayed video.
- A featured question is still the pixels in the HLS frame. The phone does not get a second overlay renderer.

### 8.2 Watch-only attendance

Watch-only is a property of one webinar membership, not a new role. The participant remains `ATTENDEE`.

- The audience client declares watch-only at join. The server stores that declaration on the membership and ignores a later client attempt to clear it. Leaving and joining again without the declaration is a desktop join.
- A watch-only member is muted, video off, and not sharing. The client does not call `getUserMedia` and does not create a peer connection. A stale promote event does not change that.
- The host may see the raised hand. Promote returns an explicit error and leaves the person an attendee. The roster says this person cannot be seated.
- Chat, questions, and votes follow the current attendee rules. Waiters still cannot use questions. A phone may wait in a scheduled webinar, and Start releases that waiter as a watch-only attendee when the join declared it.
- A meeting join that declares watch-only is refused. Meetings have no HLS audience. The refusal tells the person that a meeting stage needs a desktop browser.
- A desktop attendee who does not declare watch-only can still be promoted, with the existing consent step, and only on a desktop stage browser.
- Demo peers are unchanged. They are not watch-only, and they are not the phone-audience proof.

## 9. Account recovery and replay size

### 9.1 Password reset

One transactional mail path. No invitation mail and no marketing. Registration and login stay available when the mailbox has never been verified.

- The phase chooses the SMTP settings. When they are absent, the reset routes refuse and the control is hidden. Email/password login, guest entry, and Google behavior do not send mail.
- The request names an email address. The acknowledgement is the same whether or not that address has an email/password account. Mail is sent only when it does.
- The message contains a single-use link and no password. The server stores a hash of the token, not the token. The phase sets the lifetime, starting from 30 minutes, and tests it. Tuning records the old value, the new value, and the reason.
- Opening the link sets a new password hash, increments `session_version`, and consumes the token. Older tokens fail later API calls and handshakes, as they do after a password change. Connected sockets are not actively evicted. There is still no denylist.
- A Google-only user has a null password hash. Reset does not write one and does not look the user up by a Google profile address. `password_not_set` stays the password-change result for that user.
- The phase sets request budgets and tests them. Initial ceilings: 5 requests per email address per hour and 20 per client address per hour. A busy or unknown result uses the same acknowledgement.
- Logs, ingress, and error reports must not contain the token, the full link, or the new password.

### 9.2 Replay size

The registered owner sees a byte size on each `READY` or `FAILED` broadcast in the library.

- The size is the measured size of that broadcast's confined directory, the same directory deletion already resolves under `DATA_ROOT`. A path that escapes the root is not measured and is not deleted.
- If the directory cannot be measured, the row says the size is unknown. It must not show zero in place of an error.
- `STARTING`, `LIVE`, and `STOPPING` stay undeletable. Size does not add a delete right. `DELETING` stays on the existing owner recovery path.
- Guest session lists do not become a durable library. Deletion remains registered-owner only.
- `STORAGE_MAX_BYTES`, `MIN_FREE_BYTES`, and the guest recording allowance stay the enforcement. The 8 GiB mount is the operational disk, not a new per-host quota. Nothing in this phase deletes by age.

## 10. Architecture and compatibility

Keep the pnpm workspace, React/Vite web app, NestJS API, shared contracts, PostgreSQL, Redis, and the FFmpeg pipeline.

| Responsibility                                   | Ownership                                                |
| ------------------------------------------------ | -------------------------------------------------------- |
| Watch-only parsing, reset limits, and size DTOs  | `packages/shared`                                        |
| Origin, TLS, allowlist, and the single writer    | `deploy/`, operated only in the requested public phase   |
| ICE server configuration                         | Existing API config and the stage handshake              |
| ICE restart                                      | Web live media services, on the current generation       |
| Native HLS versus `hls.js`                       | The existing playback chunk                              |
| Watch-only membership and promote refusal        | Live Lua and the current stage-cap rule                  |
| Reset token hash, mail send, and session version | API sessions, behind a missing-config refusal            |
| Directory size                                   | API broadcasts, using the existing path confinement      |
| Library size, reset, and phone audience UI       | Feature components that do not own peers or the recorder |

Schema changes are TypeORM migrations. `synchronize` stays forbidden. Preserve existing guest users, rooms, and `READY` media. Test upgrades on a disposable copy. Live presence may reset on restart under the current policy.

No recordings, credentials, tokens, password hashes, reset tokens, or filled `.env` files enter git.

## 11. Delivery phases and exit gates

Do not add a later phase's feature to finish the current one. No phase below is started by this file.

| Phase                              | Outcome                                                                               | Main boundary                                                                        | Exit evidence         |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------- |
| V4-P1 Public origin                | The named host serves one allowlisted HTTPS/WSS origin                                | Existing profile only. No new feature family. Google unset                           | PUB-01 through PUB-03 |
| V4-P2 Cross-network stage          | Two remote desktops complete a relayed call, and a live socket can restart ICE        | Same four seats. Attendees still have zero peers. Local empty-TURN demo still passes | NET-01 through NET-03 |
| V4-P3 Phone audience               | A phone watches, chats, asks, and raises a hand, and cannot be seated                 | Desktop `hls.js` stays. Meetings reject watch-only                                   | AUD-01 through AUD-03 |
| V4-P4 Account recovery and library | An email/password host resets a password, and the library shows finished replay sizes | No invite mail. No sweeper. Google-only users gain no password                       | HST-01 through HST-03 |
| V4-P5 Invited session              | The acceptance script passes on the public origin, and open gates stay named          | No new feature family. Physical observations stay open until seen                    | SES-01, SES-02        |

## 12. Requirement register

| ID     | Observable result                                                                                                                                                                                                             | Required evidence                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| PUB-01 | `https://stage.shreyasrasaikar.cloud` serves the production web build, and the room socket connects with WSS. API ports and media directories stay private                                                                    | Real DNS, certificate, and a supported-browser flow      |
| PUB-02 | External mode leaves `shared-postgres` and every other database untouched, and uses only `stageflow_db` and the existing StageFlow Redis                                                                                      | Operator record against the running host                 |
| PUB-03 | The allowlist still admits one room, four stage users, and two viewers. The README publishes no audience capacity                                                                                                             | Config inspection and the current README                 |
| NET-01 | Two desktop speakers on different remote networks see and hear each other, and the stats drawer shows a relay candidate                                                                                                       | Two-network browser session with audio and video         |
| NET-02 | Expired credentials and an exhausted quota fail the new allocation, show an error, and add neither a seat nor a peer connection                                                                                               | Controlled expiry and quota observation                  |
| NET-03 | With the signaling socket still current, ICE restart restores media on the same connection. Devices stay as they were. A dropped socket uses grace instead                                                                    | Service regression and a browser path change             |
| AUD-01 | Phone Safari plays live HLS and a replay through the video element. Phone Chrome plays them too. Desktop Chrome still uses `hls.js`, and home still does not load it                                                          | Device playback plus the entry-graph check               |
| AUD-02 | A watch-only phone attendee sends chat, submits and upvotes a question, and raises a hand, with no capture prompt and no peer connection. Promote fails and the roster says they cannot be seated                             | Two-party browser check, one of them a phone             |
| AUD-03 | The attendee view states the broadcast delay. A meeting join declared watch-only is refused. A desktop attendee can still be promoted after consent                                                                           | Copy check and an authorization regression               |
| HST-01 | An email/password host who has forgotten the password sets a new one from the mail link. The old token fails, and a second use of the link fails                                                                              | Service regression and a captured or delivered message   |
| HST-02 | With mail settings absent, reset is hidden and refused, and login still works. A Google-only account does not gain a password. The acknowledgement does not reveal whether the email exists                                   | Config-off regression and a Google-only fixture          |
| HST-03 | The registered owner sees the directory size of a `READY` or `FAILED` attempt, or an explicit unknown. A path outside `DATA_ROOT` is not reported as that attempt's size                                                      | Service test on a disposable directory                   |
| SES-01 | A registered host schedules a webinar on the public origin. A remote desktop speaker joins through TURN. A phone attendee watches the delayed HLS, sends chat, and sees the featured question and author in the played replay | The invited session, with versions and what was observed |
| SES-02 | Guest create, the solo demo, and the four-seat cap still hold. PHYSICAL and every other unobserved gate stay named as open                                                                                                    | Existing affected checks and the acceptance record       |

NET-01 and NET-02 require the relay settings and two remote networks. Until they are run, those IDs stay unverified. HST-01 may use a captured message in local acceptance. SES-01 may not substitute a demo peer for the remote speaker or a desktop window for the phone.

## 13. Verification

Use the V1 affected-check policy. Run typecheck, lint, and the existing tests for the packages a slice touches. Add tests for watch-only promote refusal, ICE-restart generation races, reset token single use, and confined size measurement. Redis races use real Redis. A browser fake does not prove a relay candidate, phone playback, or audible media. An HLS check looks at the played frame, not only the playlist text.

The invited script, when V4-P5 is requested:

1. On the public origin, register or sign in as a host and schedule a webinar. Confirm the room does not start because the clock passed.
2. From a second desktop network, join as a speaker through the waiting room and Start. Confirm a relay candidate, two-way audio, and two-way video. Confirm a fifth seat is refused.
3. From a phone, join as a watch-only attendee. Confirm there is no capture prompt and no peer connection. Send a chat line, ask a question, and raise a hand. Confirm promote fails.
4. Start the broadcast, feature that question, and play the phone's HLS far enough to see the question and the author. Stop it and play the replay on the phone far enough to see them again.
5. On a local or public email/password account, reset the password and confirm the previous token fails. Confirm a Google-only account is unchanged.
6. Delete nothing required by the script. On a disposable attempt, confirm the library shows a size and the existing delete still removes that attempt only.
7. Run the solo demo on one desktop and confirm the four-seat cap and cleanup. Leave every context and confirm tracks, peers, and FFmpeg are released.

Outstanding physical observations stay unverified until they are actually observed. A passed script does not remove the allowlist and does not publish a capacity number.

## 14. Risks

| Risk                                                             | Control                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| The public phase becomes a feature release                       | Section 6 adds no product family. The allowlist and the 1 GiB media cap stay                     |
| TURN proof is a loopback candidate renamed in the drawer         | NET-01 requires two remote networks and audible, visible media both ways                         |
| ICE restart unmutes a locked speaker or opens a second peer      | Same connection, same tracks, generation check, no `getUserMedia`                                |
| A phone is promoted "just to try the camera"                     | Server-side watch-only refusal, and a client that does not capture on a stale event              |
| Native HLS on desktop silently replaces the tested `hls.js` path | Desktop Chrome and Edge stay on `hls.js`. Native playback is the phone fallback                  |
| Reset mail becomes a verification wall or an account oracle      | Login stays open. The acknowledgement is identical. Google-only users gain no password           |
| Size measurement follows a path outside the broadcast directory  | The deletion confinement rule. Unknown on failure, never a borrowed zero                         |
| The invited session is counted as a capacity result              | SES-02 names the allowlist and the open gates. Two viewers are a trial, not a limit to advertise |
| Open hardware gaps disappear from the status                     | PHYSICAL stays open until a person observes the named devices                                    |

## 15. Next execution request

This file is the V4 scope. It authorizes no code, no phase file, and no deploy.

> Read `MASTER_PLAN_V4.md` version `4.0.0-draft.1`. Write the requested V4 phase contract and its guide only, after inspecting the repository. Move the V3 phase files to `plans/V3/` as part of that planning step. Do not pre-generate later V4 guides and do not implement application code unless the request also asks for implementation. Do not operate the public host unless the requested phase is V4-P1 and the request explicitly includes that host. Do not treat this plan as evidence that a gate closed.
