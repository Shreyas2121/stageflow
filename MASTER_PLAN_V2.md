# StageFlow — V2 Master Plan

**Direction:** A practical local meeting and webinar product.\
**Status:** V2-P1 through V2-P5 are delivered with partial acceptance. UX-01 and QA-01 are verified. QA-02 is partial. QA-03 is the README record in `plans/V2/phase5.md`. Each chat line shows the server time. Still partial: WS-01, WS-02, WS-03, MEDIA-01, MEDIA-02, REC-01, REC-03, REC-04, and CHAT-04. Still unverified: MEDIA-03's physical unplug, MEDIA-04 playback and audible check, and REC-05 playback and FFmpeg. P3-A03, P3-A05, and P3-A06 stay open. `pnpm check:release` and `pnpm smoke:broadcast` were skipped because `FFMPEG_PATH` is the bare name `ffmpeg` and is not on PATH. Redis and disposable Postgres were available. Accounts, scheduling, deployment, and `restartIce` remain future work.\
**Plan version:** `2.0.0-draft.9`\
**Date:** 2026-11-04\
**Revision note (2.0.0-draft.9):** V3 Phase 1 was requested. The V2 phase contracts and guides moved from `plans/` to `plans/V2/`. Their acceptance results are unchanged. Current V2 paths below point at that directory.\
**Revision note (2.0.0-draft.8):** The approved V3 scope now lives in `MASTER_PLAN_V3.md`. Section 4 remains the historical recommendation. V3 implementation still waits for a requested phase. V2 acceptance gaps are unchanged.\
**Revision note (2.0.0-draft.7):** V2-P5 records combined acceptance under `plans/phase5.md`. UX-01 and QA-01 are verified, QA-02 is partial, and QA-03 is the README record. Slice hashes are in `plans/phase5/guide.md`. The server time is on each chat line. Section 4.1 names the partial and unverified ids, including P3-A03, P3-A05, and P3-A06. `pnpm check:release` and `pnpm smoke:broadcast` were skipped because FFmpeg is missing. The phase contract rules are unchanged. V2 has no further phase file.\
**Revision note (2.0.0-draft.6):** V2-P5, combined acceptance, is written at `plans/phase5.md`. It is not implemented.\
**Revision note (2.0.0-draft.5):** V2-P4 delivers bounded room chat, host pause, history after join/resume, and README limits under `plans/phase4.md`. Slice hashes, passing tests, isolated Chrome/Redis evidence, the missing timestamp display, and remaining acceptance gaps are recorded in `plans/phase4/guide.md`. The contract version is unchanged; V2-P5's combined acceptance is not started.\
**Revision note (2.0.0-draft.4):** V2-P3, bounded reconnect, is implemented under `plans/phase3.md`; slice hashes, passing tests, partial synthetic-browser evidence, and remaining verification gaps are recorded in `plans/phase3/guide.md`. The contract version is unchanged.\
**Revision note (2.0.0-draft.3):** V2-P2, in-call devices, is written at `plans/phase2.md`. V2-P1 slices are committed; WS-01 through WS-03 browser checks and the WS-03 smoke remain unverified.\
**Revision note (2.0.0-draft.2):** V1 phase contracts and guides now live in `plans/V1/`. The active V2 phase file is `plans/phase<N>.md` with its guide at `plans/phase<N>/guide.md`.\
**Inputs:** [Original idea](idea.md), [V1 master plan](MASTER_PLAN.md), the current repository, and the user's planning answers.\
**Deployment:** Excluded. All delivery and acceptance run locally.

## 1. Product decisions and document authority

The user selected a practical local product, delegated feature prioritization, and selected guest-only access for V2. The later account discussion is addressed by recommending registered host accounts in V3, including email/password and Google sign-in, while preserving guest joining.

This plan selects three main V2 investments: **in-call device controls, short-disconnect recovery, and room chat**. A small room/replay workspace supports those workflows. Usability and verification are part of each feature, with a final combined acceptance phase.

This is a plan, not authorization to implement application code. Implementation starts when the user requests a V2 phase. Future account and media features below are roadmap recommendations, not implementation commitments.

For V2 work, use this chain:

`idea.md` → `MASTER_PLAN.md` (V1 baseline) → `MASTER_PLAN_V2.md` → `plans/V2/phase<N>.md` → `plans/V2/phase<N>/guide.md`.

- Preserve V1 plans, guides, commit records, and verification evidence as history under `plans/V1/`. V2 phase files are history under `plans/V2/`. The active phase in `plans/` is V3. Do not write a second copy under `plans/v2/`.
- This document overrides V1 only for the explicit changes in Section 5. All other V1 engineering and media invariants continue to apply.
- A V2 phase contract defines its boundaries and acceptance. Its guide supplies the implementation sequence.
- Write only the requested phase's contract and guide, after inspecting the repository at that time. Do not pre-generate all phase guides.
- Ordinary implementation choices belong in the active phase. Changes to product scope, identity, media topology, or exclusions require an explicit plan revision.
- Keep implementation slices small and verified, then commit each slice before starting the next, following V1's local git discipline. Planning alone does not require a commit. No remote or push is required.

## 2. Where V1 leaves us

V1 feature implementation is complete. It provides:

- Guest JWT sessions, live meeting/webinar creation, and join by unguessable slug.
- A four-person raw WebRTC mesh, counting the host, with Perfect Negotiation.
- A green room, microphone/camera toggles, screen replacement, and active-speaker indication.
- Three synthetic demo peers and a live connection-stats drawer.
- Webinar hand raising, promotion/demotion, and host media locks.
- Host-side stage composition, ordered WebM uploads, local FFmpeg, live single-rendition HLS, and replay.
- Server-owned room state, atomic Redis mutations, bounded work, migrations, and targeted regression/integration checks.

At the V1 baseline, participant identity and moderation targets were tied to socket IDs, host disconnection ended the room, devices were selected before joining, and home created or joined rooms without a room-management workspace. V2-P1 adds the current-guest workspace, V2-P2 adds in-call device replacement, and V2-P3 separates participant identity from transport and adds bounded suspension/resume with media off. Automatic Socket.IO reconnection remains disabled; recovery uses fresh sockets and explicit resume commands. The existing per-room replay catalog and recording pipeline remain.

V1's documentation still records physical microphone/audible-output, native screen-picker/stop-control, and camera-indicator observations as unverified. These are follow-up evidence gaps, not missing feature phases. Preserve that distinction: they do not block writing V2 plans, and no V2 document may silently mark them passed. Recheck changed media behavior in V2 and carry forward any remaining limitations explicitly.

## 3. V2 product promise

This is the target for the full V2 release. The workspace, device controls, bounded reconnect, bounded room chat, and the visible server time are delivered. Combined acceptance is recorded: UX-01 and QA-01 are verified, QA-02 is partial, and QA-03 is the README record. `plans/V2/phase5.md` Section 4.1 names every id that is still partial or unverified.

**A host can run a small local session, change devices without leaving, recover from a brief connection interruption, talk with the audience through chat, and find the session's replay afterward.**

The existing solo demo remains a first-class path. New product features must not make it require accounts, external credentials, paid services, or another person.

### 3.1 Included scope

| Area            | V2 outcome                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Room workspace  | Find rooms created by the current guest identity, open a room, copy its invitation, and see its broadcast attempts |
| Joining         | Accept a room slug or a valid invitation URL; retain direct room and replay links                                  |
| Device controls | Change camera, microphone, or output while on stage; handle device loss without leaving the room                   |
| Recovery        | Rejoin the same participant after a short unexpected socket interruption, with a bounded grace period              |
| Chat            | Bounded plain-text room discussion, recent history, and a host control to pause new messages                       |
| Replay workflow | Discover existing recordings from the room workspace, understand their statuses, and open READY playback           |
| Usability       | Clear connection, permission, recording, and failure states; keyboard-accessible core workflows                    |
| Validation      | Verify the combined local workflow and protect the existing mesh, demo, and broadcast paths                        |

### 3.2 Ceilings and exclusions

- Maximum stage occupancy remains **four**, including suspended stage reservations during reconnect.
- Webinar attendees have **zero WebRTC peer connections** and request no camera/microphone permission unless promoted and consenting.
- Broadcasts remain host-produced, single-rendition 720p HLS on local disk, with one active attempt per room.
- Guest sessions retain V1's 12-hour JWT lifetime. There is no refresh or permanent guest identity in V2.
- Chrome and Edge on Windows desktop remain the acceptance targets. Responsive layout does not claim mobile-browser media support.
- No registered accounts, email/password authentication, Google/OAuth integration, account recovery, or cross-browser personal history in V2.
- No scheduling, calendar integration, waiting-room admission, room passwords, polls, Q&A board, direct messages, reactions, file attachments, or transcription.
- No host transfer, co-host roles, resume across API restart, seamless broadcast-upload continuation, or permanent meeting links.
- No SFU, fifth stage slot, simulcast, multi-rendition HLS, LL-HLS, or separate simultaneous camera-and-screen video tracks.
- No object storage, cloud queues, hosted media services, deployment, domain setup, TLS provisioning, ingress, public TURN service, or production rollout.
- No replay deletion, retention automation, or export/transcoding system. These need their own storage lifecycle contract.

Existing CI checks may be maintained for changed code. Infrastructure and deployment work are not V2 deliverables. An attendee-capacity or cross-network reliability claim requires separate measurement; local success is not a scale claim.

## 4. Version roadmap

| Version                                    | Product question                                            | Recommended scope                                                                                                                                                       | Deliberately deferred                                                 |
| ------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| V1 — core media demo                       | Does the full stage → broadcast → replay path work locally? | Existing four-person mesh, moderation, bots, stats, HLS, replay                                                                                                         | Practical session workflows and persistent accounts                   |
| V2 — practical local sessions              | Can someone comfortably run and recover a small session?    | Device controls, bounded reconnect, chat, current-guest room/replay workspace, usability                                                                                | Registered identities, scheduling, richer audience tools, media scale |
| V3 — persistent hosts and organized events | Can a host return and manage sessions over time?            | Email/password and Google host accounts; guest attendees; durable ownership and library; scheduled rooms; waiting-room admission; choose Q&A or polls after V2 feedback | Larger stages and major media-pipeline changes                        |
| V4 — media depth, if useful                | Which measured media limitation should we solve next?       | Choose a focused track: adaptive HLS/replay processing, stronger network recovery, or a separately designed SFU path                                                    | A bundle of every advanced feature or automatic deployment            |

V3 should retain the four-person mesh until there is a reason to change it. V4 is optional and should follow a measured limitation, not a version-number target. Deployment remains a separate, explicitly requested workstream at any version; neither V3 nor V4 requires it.

### 4.1 Why accounts belong in V3

Accounts are valuable for recurring hosts: ownership survives guest-token expiry, scheduled rooms have a durable organizer, and a personal library has a stable owner. They fit together as one product increment.

For V3, recommend email/password plus Google sign-in for hosts, while allowing attendees to join as guests. Localhost development is possible; lack of deployment is not a reason to exclude authentication. Google setup still requires an externally configured OAuth application, while the local email/password path should remain independently testable.

The V3 account contract must decide session handling, verification and password recovery, account linking, authorization for private recordings, logout, and migration of existing guest-owned rooms. A matching display name or email string alone must never claim guest history or merge accounts. Preserve the existing guest entry path and avoid retroactively changing replay access without an explicit migration decision. V2 does not implement provisional OAuth or a partial password system.

## 5. Explicit changes from the V1 contract

| V1 rule                                  | V2 replacement                                                                                        | Owning phase |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| Devices are selected only before joining | On-stage camera, microphone, and output may be changed during a session                               | V2-P2        |
| Every socket drop is a leave             | Unexpected transport loss enters bounded suspension; explicit leave still ends membership immediately | V2-P3        |
| Socket ID is the participant identity    | Stable room participant identity is separate from the current socket and its connection generation    | V2-P3        |
| Host drop ends the room immediately      | Unexpected host loss holds the room briefly; explicit host leave or grace expiry ends it              | V2-P3        |
| No chat                                  | Plain-text, bounded live-room chat with recent history and host pause                                 | V2-P4        |
| Home is create/join only                 | Add a current-guest room workspace and expose existing replay history there                           | V2-P1        |

No account, scheduling, media-topology, storage-provider, or deployment exclusion changes implicitly. V1's restart cleanup, namespace ownership, atomic Lua writes, server authorization, media cleanup, upload budgets, and ordered chunk semantics remain in force unless the active V2 contract explicitly extends them.

## 6. Room workspace and replay workflow

### 6.1 Ownership and discovery

- Add a host room-list query scoped on the server to the authenticated guest's user ID. Never accept a caller-supplied host ID as authority.
- Show room title, mode, LIVE/ENDED status, creation time, invitation action, and entry into its broadcast history. Do not label LIVE catalog state as proof that the host is currently connected.
- Keep current create/join actions immediately available. Accept a raw slug or a URL matching the application's room-link format; reject unrelated URLs and malformed input.
- List room history with cursor pagination: default 20, maximum 50 items, stable ordering by creation time plus ID. Bound broadcast-history requests too.
- Preserve existing per-room broadcast and replay routes. Any response-shape change updates shared types, API, UI, and current consumers together.
- A list is **"Rooms from this guest session"**, not an enduring personal account. Explain that a new or expired guest identity cannot recover ownership through its display name.

The workspace does not create a global directory of every local room or recording. Existing slug/recording-link access continues under V1 rules; ownership filtering for the host list does not make old replay URLs private.

### 6.2 Replay states

Show STARTING, LIVE, STOPPING, READY, and FAILED as distinct states. Only READY recordings offer replay playback. An ended room can still have playable recordings. Failed attempts stay visible with a useful reason; they do not look like missing videos.

Expose the existing thumbnail when available, with a stable fallback when absent. Do not make thumbnail generation a prerequisite for READY. Keep HLS/player loading deferred until playback is needed. No new recording format, encoder, or queue is required.

## 7. In-call device and media contract

Keep media acquisition, sender replacement, compositor inputs, and cleanup in feature-owned services. React components invoke the service and render its state.

### 7.1 Device replacement

1. Serialize device changes and identify each operation by a lifecycle generation.
2. Acquire only the requested replacement kind. Keep the current usable track until the replacement is ready.
3. Apply the current mute/video state and host locks to the replacement **before** attaching it to any sender or recording input.
4. Update all current peer senders and local preview/analysis/recording consumers. After successful replacement, stop the superseded track and release its processing nodes.
5. On acquisition failure, keep the previous usable device and show the error. If replacement partially succeeds, restore consistent senders or enter an explicit unavailable-media state; never leave different peers silently using different devices.
6. If leave, demotion, suspension, or a newer operation wins the race, stop the late replacement immediately. It must never reactivate capture.

Camera changes during screen sharing update the camera that will be restored later; they do not replace the screen share currently being sent. Microphone changes must also update the host compositor's local audio input. Remote microphone replacement must remain audible through the existing remote stream. Device changes do not create additional peer connections or additional video transceivers.

Same-kind replacement uses `replaceTrack` within the negotiated envelope. If the browser rejects replacement, report it and restore the previous state; do not promise zero renegotiation for every hardware/format combination or silently grow the media topology.

### 7.2 Device loss and output routing

- Handle device enumeration changes and track-ended events. Mark a lost camera as unavailable/video-off and a lost microphone as unavailable/muted without forcing room leave.
- Do not silently select and activate another input. Offer a deliberate selection/retry action.
- Update the active-speaker analyser, mic meter, and recorder inputs when a track changes; dispose of old nodes.
- Apply speaker output selection to every applicable playback element, including later-created elements and attendee/replay players where supported. Show a clear fallback when output routing is unavailable.
- A host lock still prevents sending the locked media even after replacement, resume, or device recovery.
- Attendee settings never acquire camera or microphone tracks. Promotion retains the existing device-consent step.

Initial green-room permission requirements remain V1 behavior. Audio-only entry and listen-only stage participation are separate product decisions, not hidden additions to this phase.

## 8. Bounded reconnect contract

The V2-P3 implementation uses server-owned membership transitions and fresh sockets with `reconnection: false`. Its [phase contract](plans/V2/phase3.md) and [execution guide](plans/V2/phase3/guide.md) record the shipped rules, slice hashes, and verification results. Automated checks passed; the isolated synthetic browser run covers part of recovery. The browser pass against Redis, webinar playback/host-interruption/new-attempt browser check, and reconnect-specific audible FFmpeg run remain unverified.

### 8.1 Identity, authority, and stage reservations

- Introduce a stable, server-issued participant ID for one room membership. A socket ID identifies only its current transport.
- Authenticate resume with the existing valid guest JWT and a high-entropy, room/member-bound resume credential. Keep that credential in page memory, store a verifier server-side, and invalidate it on leave/expiry. Do not log or include it in room snapshots.
- Only one current transport may own a participant. Atomically bind the replacement socket and advance a connection generation; messages from old sockets/generations cannot signal, moderate, send chat, or mutate media.
- Preserve role, host locks, original join order, and hand-queue position through a successful resume. The server snapshot is authoritative.
- Suspended stage members reserve their slot and count toward the cap of four, but are not eligible signaling peers. A host may demote a suspended speaker, releasing the reservation; resume cannot restore the old role afterward.
- Move moderation references, hand references, and the client peer map to a consistent identity model. Convert the demo engine and existing consumers in the same phase; do not keep two competing stage authorities.

### 8.2 State machine and timing

`CONNECTED → SUSPENDED → CONNECTED`, or `SUSPENDED → LEFT/ROOM_ENDED` on deadline expiry.

- Default grace: **20 seconds after the server detects unexpected socket loss**. The phase may tune this with recorded reasoning, but it stays bounded. Show the client a recovering state as soon as it detects loss; server detection can occur later.
- Retry with bounded backoff within the server deadline. Obtain a fresh full snapshot before rebuilding media. Do not replay buffered media, SDP, ICE, chat sends, or moderation commands from the disconnected socket.
- Use atomic suspend/resume/expire transitions. A stale expiry callback cannot evict an already resumed participant. Sweep overdue reservations as well as using timers, so delayed callbacks do not permanently reserve slots.
- Expiry processing uses the existing bounded work and cleanup mechanisms. Uncertainty or dependency failure must reject conflicting joins/resumes rather than allocate a fifth slot.
- On successful resume, replace the stale snapshot baseline and create fresh peer connections only between connected current stage members. Reconnecting attendees create none.
- Broadcast/playback, stats baselines, and peer resources follow the new connection generation; late callbacks from the old generation are ignored and released.

### 8.3 Media, host loss, and explicit limits

On detected disconnect, close the affected peer connections and stop that client's local capture, screen sharing, meters, demo activity, and upload producer. Suspended metadata is muted/video-off/not sharing. Resume restores membership with media off; enabling devices requires an explicit user action and still obeys current host locks. Screen sharing never resumes automatically.

Other connected stage members close their connection to the suspended member. A suspended non-host does not stop the host's broadcast: the compositor removes that source and continues. If the **host** loses transport, fail the interrupted in-flight broadcast through a bounded cleanup path and stop its FFmpeg process. A late chunk cannot revive it. On host resume, the host may explicitly start a new attempt; do not append a new recorder stream to the old attempt or claim an uninterrupted replay.

Explicit Leave, End room, route navigation, and component disposal do not schedule client recovery. A delivered host-leave command ends the room immediately. Browsers cannot guarantee delivery during tab close/refresh; an undelivered departure may remain suspended until grace expiry, but capture must stop locally immediately.

Resume is supported only for the same live page and guest session. Tab refresh, browser restart, guest-token expiry, API restart, Redis presence reset, and another device are outside the resume guarantee. API restart retains V1's fail-in-flight/reset-presence policy. A JWT that expires during grace cannot resume. No host transfer or automatic promotion occurs.

Demo peers use the same caps and authorization. On loss of the parent host session, dispose of its demo resources and memberships; recreate them explicitly after recovery. A bot cannot keep the room or the broadcast alive on behalf of the host.

This phase recovers signaling transport interruptions by rebuilding peers. ICE-only failure recovery, `restartIce`, seamless media continuity, and network handoff are deferred; show actionable failure/rejoin information rather than claiming they work.

## 9. Room chat contract

### 9.1 Product behavior

- One room-wide plain-text channel for connected hosts, speakers, and attendees, in meetings and webinars.
- Show sender name, host/speaker identity at send time, server timestamp, pending/failed state, and unread activity without stealing focus.
- The host can pause and resume new chat messages. Everyone can read the retained recent history while connected. The paused state applies to all senders, including the host and demo participants.
- New joins and resumed participants fetch recent history. Do not render chat history inside every full room snapshot.
- Chat is real-time discussion. HLS audience video is delayed; communicate that chat is not synchronized to the frame being watched.
- On room end, sending stops and clients may retain their displayed transcript for that page. Chat is not a replay transcript or persistent account history.

### 9.2 Authority, ordering, and bounds

- Derive room membership, participant identity, display name, and role from authenticated server state. Ignore client-supplied sender fields.
- Use dedicated typed send/history/message contracts and stable error codes. Acknowledgements settle sends; room delivery uses a separate ordered chat sequence.
- Defaults: 1–1,000 characters after trim and at most 4,000 UTF-8 bytes per message; retain at most 500 recent messages per room, with a 24-hour idle TTL; fetch 50 initially and at most 100 per history page.
- Rate-limit sends per authenticated user and per room, in addition to existing network/event budgets. Initial budgets: 10 messages per user per 10 seconds and 100 messages per room per 10 seconds. Tune only with the phase contract and tests updated.
- Bound client history, pending sends, server deduplication, and outgoing work. A full or unavailable queue returns an explicit error; no unbounded offline-send buffer.
- Store recent messages and ordering in namespaced Redis data with atomic writes. Give retries a client request ID; bounded deduplication prevents a repeated accepted send from creating a second message. Do not automatically send uncertain drafts after reconnect.
- History pagination and live delivery deduplicate by message identity/sequence, close the subscription/history race, and visibly identify history lost to retention. Chat failures do not tear down the stage or broadcast.
- Respect host pause atomically with message acceptance. Suspended, left, expired, wrong-room, or stale-generation clients cannot send.
- Use text rendering, never message HTML. No uploads, rich embeds, link previews, editing, deletion, or private messages in V2.

Chat keys join the namespace cleanup and room lifecycle contract. Namespace recovery must not accidentally expose stale chat as a fresh active room's history. PostgreSQL message persistence and synchronized replay chat are deferred.

## 10. Architecture and compatibility

Keep the current pnpm workspace, React/Vite web app, NestJS API, shared contracts, PostgreSQL catalog, Redis live state, and FFmpeg pipeline. Do not introduce a framework rewrite or generic plugin system for these features.

| Responsibility                                                      | Ownership                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Shared DTOs, parsers, identifiers, limits, and state-machine rules  | `packages/shared`                                                          |
| Room list, catalog queries, and schema migrations                   | Existing API rooms/broadcasts features                                     |
| Membership, suspend/resume/expiry, roles, and signaling eligibility | API live services and atomic Redis scripts                                 |
| Chat acceptance, sequencing, history, and pause                     | A feature-owned chat service/repository integrated with live authorization |
| Capture, replacement, generation cancellation, and cleanup          | Web live media services                                                    |
| Reconnect coordination and demo lifecycle                           | Web room-session/signaling services                                        |
| UI and user actions                                                 | Feature components/hooks, without direct peer or recorder ownership        |

V2 may update shared contracts across both apps together; it does not promise mixed V1/V2 runtime interoperability. Apply database changes through migrations. Preserve existing rooms, guest users, and READY recording paths. Test upgrades on a disposable copy/fixture; never wipe developer data to make an upgrade pass. Live presence may reset during an application upgrade under the existing restart policy.

PostgreSQL remains the durable room/broadcast catalog. Redis remains ephemeral live state and bounded chat. Media remains local files. No recordings, credentials, tokens, or filled `.env` files enter git.

## 11. Delivery phases and exit gates

Phase order limits the number of moving parts. Do not add future-phase features to make the current phase appear complete. All phases start in **planned** state; none of the acceptance IDs below is verified by this document.

| Phase                             | Outcome                                                                                             | Main boundary                                                                               | Exit evidence                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| V2-P1 — room and replay workspace | A current guest finds created rooms, shares an invitation, and opens existing replay history        | Reuse current guest identity and existing recording pipeline; add bounded catalog discovery | WS-01 through WS-03, V1 entry and replay regressions                |
| V2-P2 — in-call devices           | A speaker changes inputs/output and handles a lost device while remaining joined                    | Track lifecycle, locks, screen restore, recorder/analyser inputs                            | MEDIA-01 through MEDIA-04, real-browser media observations          |
| V2-P3 — reconnect                 | A brief unexpected socket drop preserves membership without duplicating participants or stage slots | Stable identity, transport generations, Lua transitions, expiry, host/broadcast failure     | REC-01 through REC-05, real Redis races and browser recovery        |
| V2-P4 — chat                      | Stage members and attendees exchange bounded messages, retrieve recent history, and obey host pause | Independent bounded chat sequence; reuse P3 membership authority                            | CHAT-01 through CHAT-04, two-window discussion and reconnect checks |
| V2-P5 — combined acceptance       | The complete practical-session script works locally and limitations are documented                  | Fix defects, verify accessibility, finish docs and evidence; no additional feature family   | UX-01, QA-01 through QA-03, all earlier IDs accounted for           |

The first phase does not claim permanent personal history. Phase 3 does not introduce accounts or seamless recording recovery. Phase 5 is a regression/acceptance phase, not a place to add scheduling or cloud services.

## 12. Requirement and acceptance register

Each active phase adds implementation locations, exact methods, observed results, and evidence links to its acceptance matrix. Every ID starts **planned**.

| ID       | Observable result                                                                                                                                           | Required evidence                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| WS-01    | A guest sees only rooms owned by that guest in the host workspace; another guest cannot query another host's list by supplying an ID                        | API authorization and paginated-query regressions; two guest sessions    |
| WS-02    | Raw slug and valid invitation URL reach the same room; malformed input fails clearly; create/direct room/replay entry remain available                      | Parsing regressions and browser navigation                               |
| WS-03    | Room history shows all five broadcast statuses correctly and opens an existing READY replay, including after API restart                                    | Catalog/pagination regression and real local replay                      |
| MEDIA-01 | Camera and microphone changes reach all current peers without adding peer connections; superseded tracks stop                                               | Service races and two-window browser observation                         |
| MEDIA-02 | Mute and host locks survive replacements; camera choice during sharing is used when screen share stops                                                      | Service regressions and native screen-share observation                  |
| MEDIA-03 | Denied/missing devices produce a clear state; late operations after leave/demotion never reactivate capture                                                 | Failure/race regressions and physical-device observation where available |
| MEDIA-04 | Output selection reaches existing/new playback elements where supported, and microphone replacement is audible in the stage broadcast/replay                | Routing regressions plus audible stage/HLS/replay checks                 |
| REC-01   | Resume within grace returns the same participant, role, locks, hand position, and stage reservation with exactly one current transport                      | State-machine tests, real Redis integration, socket transport test       |
| REC-02   | Suspended slots count toward four; concurrent resume/expiry/join/demotion never duplicate or over-allocate membership; stale sockets lose authority         | Real Redis concurrency and service regressions                           |
| REC-03   | Media stops on loss; resume requires explicit device activation; screen sharing and stale signaling never resume automatically; attendees retain zero peers | Lifecycle regressions and browser interruption                           |
| REC-04   | Host resume within grace preserves the room; explicit leave or host grace expiry ends it; API restart cannot resume old presence                            | Controlled-clock tests, transport integration, isolated real restart     |
| REC-05   | Non-host suspension removes that source from a continuing broadcast; host loss terminates its attempt, and explicit restart creates a new playable attempt  | Real FFmpeg integration and host/attendee browser observations           |
| CHAT-01  | Connected participants exchange ordered messages; joins/resumes merge retained history without gaps hidden by the UI or duplicate messages                  | Service/Redis tests and two-window browser discussion                    |
| CHAT-02  | Length/byte/history/rate/queue limits and bounded deduplication behave as documented                                                                        | Boundary, duplicate-send, and overload regressions                       |
| CHAT-03  | Host pause is authoritative; wrong-room, suspended, expired, and stale transports cannot send; forged names/roles are ignored                               | Authorization and atomic-transition regressions                          |
| CHAT-04  | Chat problems do not drop media; room end prevents sending; HLS delay and temporary history are explained                                                   | Failure-isolation regression and browser observation                     |
| UX-01    | Create/join, settings, recovery, chat, moderation, and replay work by keyboard with visible focus and readable state announcements                          | Browser keyboard walkthrough at supported desktop sizes                  |
| QA-01    | V1's solo demo, stage cap, attendee isolation, locks, cleanup, ordered upload, and missing-FFmpeg behavior still hold                                       | Existing affected checks plus combined demo evidence                     |
| QA-02    | Existing catalog/READY media survive migration and restart; destructive checks affect only disposable fixtures                                              | Migration/restart integration and recorded fixture ownership             |
| QA-03    | README and phase records explain V2 behavior, guest-history limits, reconnect/broadcast limits, local setup, and outstanding physical observations          | Documentation review and complete acceptance matrix                      |

## 13. Verification policy and practical-session script

Use V1's affected-check policy while implementing. Run relevant shared/API/web typecheck, lint, and existing tests according to changed ownership. Add behavioral tests for new state transitions, authorization, device races, stale callbacks, bounded queues, and chat ordering. Do not add boilerplate component/controller/entity tests.

Redis identity migration, resume races, expiry, and chat atomicity require real Redis integration. Browser fakes cannot verify native device replacement or ICE negotiation. Real FFmpeg checks must verify output, not only the argument builder. Before calling V2 complete, run the full existing release checks and both builds with isolated service fixtures; record exact commands and actual outcomes. Existing checks may need meaningful V2 cases added, not a duplicate test runner.

Do not start a failure-test API against developer live presence, delete unrelated Redis keys, stop shared containers to simulate failure, or remove real recordings. Missing dependencies or browser access leave the corresponding acceptance **unverified**, with a stated reason.

### 13.1 Combined local acceptance script

1. Start the existing local dependencies, API, and web app. Enter as a guest and create a meeting from the workspace.
2. Add three demo peers, inspect stats, share a screen, change the restore camera, stop sharing, and remove the demos. Confirm the four-slot cap and cleanup.
3. Join a second browser context as a human stage peer. Change camera, microphone, and speaker output; verify reception and mute/lock behavior. Unplug or end an input and recover deliberately.
4. Interrupt only the joining client's signaling connection. Observe suspension and reserved capacity. Restore it within grace; confirm stable identity, fresh peer connections, and media off until enabled.
5. Repeat past the grace deadline, then test explicit leave. Neither should secretly resume or leave a reserved slot forever.
6. Create a webinar and open an attendee context without camera/microphone capture. Exchange chat messages, pause/resume chat, and verify that reconnect recovers recent history without resending uncertain drafts.
7. Promote/demote an attendee. Verify stage-only signaling, host locks, no off-stage capture, and chat continuity.
8. Start a broadcast, change microphones, and verify attendee audio/video. Suspend a non-host speaker and confirm the broadcast continues without that source. Suspend the host: its attempt fails cleanly. Resume the host within grace and explicitly start/stop a new attempt.
9. Open the completed recording through room history and a fresh guest replay link. Restart the API; verify READY replay still works while old live presence does not resume.
10. Repeat the important controls by keyboard. Leave every context and verify tracks, peers, audio contexts, timers, recorder/upload work, demo sockets, and FFmpeg resources are released.

Use synthetic media for repeatable browser checks, and distinguish it from physical camera/mic/speaker and native-picker observations. Record browser/OS/FFmpeg versions and any failed or unavailable check. Outstanding V1 physical observations remain visible until actually observed; final acceptance must state any remaining gap rather than implying all hardware behavior was verified.

## 14. Risks and completion rule

| Risk                                                                 | Required control                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Reconnect accidentally creates a fifth stage member or a second host | Stable identity, atomic transport ownership, reserved-slot accounting, concurrency tests |
| Reconnect revives a revoked role or unmutes a locked track           | Current server snapshot, generation checks, explicit media activation                    |
| Device changes break the recording while peers look correct          | Update recorder/analyser consumers and verify audible HLS output                         |
| Host recovery corrupts the existing WebM/HLS attempt                 | Fail interrupted production; explicit new attempt and recorder                           |
| Chat overload delays cleanup or signaling                            | Separate bounded storage/work, rate limits, no transcript in full room snapshots         |
| Guest workspace looks like a durable account                         | Current-session wording, ownership-scoped queries, no display-name recovery              |
| V2 expands into every previously excluded feature                    | Three main priorities, explicit phase boundaries, V3/V4 backlog                          |
| Deferred hardware evidence disappears from status                    | Carry acceptance gaps forward until actual observations exist                            |

V2 is complete when all requirement IDs have an implementation location and recorded result, the combined local script passes within its stated evidence scope, existing V1 paths still work, migration preserves prior data/media, and the README accurately describes the remaining limits. Any unavailable physical observation must remain explicitly unverified in the final handoff.

There is no deployment gate. No V3 account, scheduling, waiting-room, or V4 media feature is needed to finish V2.

## 15. Next execution request

V2-P5 is recorded. There is no further V2 phase file.

> Read `MASTER_PLAN_V2.md`, `plans/V2/phase5.md`, and `plans/V2/phase5/guide.md` for the recorded acceptance result, slice hashes, and remaining gaps. V2-P5's four slices are delivered; acceptance remains partial. The active phase file is V3 Phase 1 at `plans/phase1.md`. Do not write `plans/phase6.md` or a second V2 phase. Do not implement V3-P1 until that phase is requested.
