# V3 Phase 4 — Scheduled rooms and waiting admission

**Status:** in progress. C01 through C05 are implemented and verified; C06 remains planned.\
**Last updated:** 2026-11-06.\
**Master plan:** `MASTER_PLAN_V3.md` version `3.0.0-draft.5`, Sections 4, 7, and 12 (SCH-01 through SCH-05). Identity and replay lifecycle stay as shipped in `plans/phase1.md`, `plans/phase2.md`, and `plans/phase3.md`.\
**Execution guide:** [phase4/guide.md](phase4/guide.md). That guide owns V3P4-C01 through V3P4-C06. Those ids are not the V1 commits in [V1/phase4/guide.md](V1/phase4/guide.md) or the V2 commits in [V2/phase4/guide.md](V2/phase4/guide.md).\
**Requirement IDs:** SCH-01, SCH-02, SCH-03, SCH-04, SCH-05.

## 1. Outcome

A registered host can create a scheduled meeting or webinar, share its slug, and see who is waiting. The advertised time does not open the room. The host starts it from inside the room, or cancels it before start. Early joiners wait off stage, without a camera and without a peer connection. A meeting can require the host to admit each person. A webinar releases early joiners as attendees. A guest can still create an immediate live room.

Example: Ava schedules the meeting `Design review` for a UTC time that is already past. It stays `SCHEDULED`. Sam opens the slug and waits. He is not on stage, and the page does not ask for a camera. Ava chooses **Start**. She is seated first. With admission off, Sam is seated next, and a fifth person remains waiting. The same room as a webinar instead makes Sam an attendee with no peer connection. **Cancel room** before start ends it and creates no broadcast.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-11-05. `HEAD` is `ed93ee7a2463`. The worktree was clean. This planning change adds the phase contract and guide. Recheck the worktree at execution.

V3 Phases 1 through 3 are complete. ID-01 through ID-06 and LIB-01 through LIB-04 are verified as recorded in those phases. A real Google round-trip was not run. This phase does not record the open V1 and V2 acceptance ids as passed.

Observed in that tree:

- `rooms.status` is `LIVE` or `ENDED`. Create always inserts `LIVE`. Guest and registered hosts use the same `{ title, mode }` body. `RoomResponse` has no start time and no admission flag.
- Join seats the host and every meeting guest immediately. A meeting guest is rejected with `host_not_present` until a host membership exists. A webinar guest becomes `ATTENDEE` and is not on stage. The stage cap is four, including suspended reservations. `stage_full` writes nothing.
- Host leave ends a live room. A dropped non-bot is suspended with reconnect grace and can resume. Demo peers are synthetic joins. `Spawn demo peer` is a host control in the live room.
- `common.lua` unpacks five key names. `KEYS[6]` is the broadcast key. `KEYS[7]` through `KEYS[9]` are transports, resume, and deadlines. `liveKeys` returns those nine keys. `tryBeginBroadcast.lua` uses `KEYS[6]` only.
- Waiting is not a key, a role, or a snapshot field. Broadcast start remains the host of a `LIVE` webinar. Chat authorization is current membership.
- Home offers **Create meeting** and **Create webinar**. The room page enters through the green room. Home must not import `hls.js`, the live room, or chat.
- `scripts/smoke-broadcast.mjs` expects `AddBroadcastVisibility1794096000000` last.

## 3. Included and excluded

### 3.1 Included

- `SCHEDULED` status, `scheduled_start_at`, and `require_admission` on the existing room row.
- A waiting sorted set and a `WAITING` role. The host can see that queue.
- Socket **Start**, **Cancel**, **Admit**, and **Remove**.
- Automatic seat fill for a meeting that does not require admission.
- Webinar release of pre-start waiters to `ATTENDEE`.
- A home schedule form and a waiting panel that does not capture media.
- README text for these limits.

### 3.2 Excluded

These are the exclusions this phase is most likely to violate.

- A clock, worker, or page timer that starts the room, admits waiters, or starts FFmpeg.
- A fifth stage seat, a peer connection for a waiter or webinar attendee, or capture before the person is on stage and has consented.
- Reconnect grace or a resume credential for a waiter or for the host before start.
- Putting a demo peer in the waiting set, or spawning one before the host is live and on stage.
- Changing chat limits, replay visibility, deletion, Google sign-in, or guest immediate create.
- Q&A, polls, and a retention job.
- Closing any open V1 or V2 acceptance id.

## 4. Requirement mapping

| ID     | Meaning in this phase                                                                                                                         | What this phase does not claim                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| SCH-01 | A registered host creates `SCHEDULED`, shares the slug, and sees waiters. A guest create is still `LIVE`. A past time does not start the room | A calendar invite or an email                         |
| SCH-02 | A waiter has no stage seat, no capture, and no peer connection. The 101st waiter is rejected. A drop is gone and the rejoin is at the back    | The 20-second reconnect grace                         |
| SCH-03 | Start seats the host first. Admission off fills free seats in order and counts suspensions. Admission on seats only through Admit             | A fifth seat or a Node read-modify-write of the stage |
| SCH-04 | A scheduled webinar releases pre-start waiters as attendees with zero peer connections. Promote still uses the free-seat rule                 | `require_admission` on a webinar                      |
| SCH-05 | Cancel ends a scheduled room and creates no broadcast. Demo peers cannot be spawned before Start                                              | Cancelling a room that is already `LIVE`              |

## 5. System contracts

### 5.1 Stored schedule

Migration `AddRoomSchedule1794182400000` allows status `SCHEDULED`, adds nullable `scheduled_start_at timestamptz`, and adds `require_admission boolean NOT NULL DEFAULT false`. Existing rows stay `LIVE` or `ENDED`, with a null start and admission false. The smoke list appends this name after `AddBroadcastVisibility1794096000000`.

`RoomResponse` gains `scheduledStartAt` and `requireAdmission`. `scheduledStartAt` uses the same `YYYY-MM-DDTHH:mm:ss.sssZ` instant as a broadcast timestamp. A past instant is valid.

Guest create accepts only `title` and `mode` and still inserts `LIVE`. A guest body that includes `status`, `scheduledStartAt`, or `requireAdmission` is HTTP 403 `schedule_not_allowed` with `Create a host account before scheduling a room.`

A registered host may omit the new fields and still gets today's immediate `LIVE` room. `SCHEDULED` requires a valid start instant. `LIVE` rejects a start instant. Any other status is HTTP 400 `invalid_schedule`. The timestamp message is `Enter a UTC start time.` The status message is `Choose a live or scheduled room.` `requireAdmission: true` on a webinar is HTTP 400 `invalid_admission` with `Admission applies to meetings only.` Omitted admission is false. The flag is chosen at create and is not edited later.

### 5.2 Waiting membership

The waiting key is `<LIVE_NAMESPACE>:room:{roomId}:waiting`, Redis sorted set, score the server arrival millisecond, member the participant id. It is `KEYS[10]`. `common.lua` keeps its five-name unpack. `KEYS[6]` stays the broadcast key, and `KEYS[7]` through `KEYS[9]` stay where they are. The key uses the room TTL, and room end, `deleteRoom`, and the startup `room:*` scan remove it.

A waiter is a connected participant with role `WAITING`, absent from the stage set, with no suspended reservation and no resume digest. The set holds at most 100 waiters. The 101st join is `waiting_full` with `This room cannot take another person yet.` and writes nothing. The host is role `HOST`, in neither set, until Start.

A scheduled meeting can be joined before the host arrives. A `LIVE` meeting still requires the host. Before Start, a dropped host or waiter is removed at once. The room stays `SCHEDULED`, and the next join gets a new participant id at the back of the queue. After Start, today's suspend and resume stay for people on stage. Host leave of a `LIVE` room still ends it.

The snapshot gains `waitingParticipantIds` in score order, then participant id. `DELETING` and replay visibility are unchanged. Chat stays authorized for a connected member, including a waiter. This phase does not change chat limits.

### 5.3 Start, admit, remove, and cancel

These are socket commands from the host's current membership. Lua is the only writer of the stage set and the waiting set. Node does not read the stage, choose a seat, and write it back. The seat count is the stage set, including suspended reservations. A full stage returns the existing `stage_full` and leaves the waiter in the set.

| Command | Who                                                             | Result                                                                                                                                                                                      |
| ------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start   | Connected pre-start host of a `SCHEDULED` room                  | Seats that host, then applies the mode rules below. Postgres then becomes `LIVE` only if it is still `SCHEDULED`. A second start is `already_started` with `This room has already started.` |
| Admit   | Connected host of a `LIVE` meeting whose admission flag is true | One chosen waiter becomes `SPEAKER` when a seat is free.                                                                                                                                    |
| Remove  | Connected host                                                  | Drops one waiter and seats nobody.                                                                                                                                                          |
| Cancel  | Connected pre-start host                                        | Postgres becomes `ENDED` with `ended_at`. The waiting key and memberships are cleared. No broadcast is created.                                                                             |

Start on a meeting with admission off fills waiters in score order until four seats are taken. A later joiner uses today's meeting join, but the join script seats any remaining waiters before giving that joiner a free seat. When a seat frees, the script that frees it admits the oldest waiter. Start on a meeting with admission on seats only the host. Later joiners, and the people already waiting, stay waiting. Admit is rejected with `admission_off` and `This meeting seats people automatically.` when the flag is false. Leave does not pull the next waiter while the flag is true.

Start on a webinar seats the host, then sets every pre-start waiter to `ATTENDEE` without a stage seat. After `LIVE`, a new webinar joiner is an attendee immediately. Promote still refuses a fifth stage seat. `require_admission` does not apply.

Cancel of a `LIVE` or `ENDED` room is `not_scheduled` with `Only a scheduled room can be cancelled.` Admit of someone who is not waiting is `not_waiting` with `That person is not waiting.`

A synthetic join is `demo_not_ready` with `Start the room before adding a demo peer.` unless the room is `LIVE` and the host is on stage. A demo peer is never a waiter.

If the process stops after the start script and before the Postgres update, a repeated Start seats nobody a second time and commits `LIVE`. There is no sweeper and no automatic start. Once Lua releases a pre-start member or admits a waiter, the server sends a targeted `room:resume-credential` for that membership. A waiter and a pre-start host still have no resume digest or credential. Credentials never appear in room snapshots.

### 5.4 Home and room

A registered host sees **Schedule meeting** and **Schedule webinar**, a UTC start field, and, for a meeting, **Require host admission**. Guest home does not show them. The library shows `SCHEDULED` and the UTC instant. The existing invitation control still shares the slug.

Inside a scheduled room, or while this participant is `WAITING`, the page shows the queue and does not mount the green room, request a camera or microphone, or create a peer connection. The host sees **Start**, **Remove**, and **Cancel room**. Cancel asks for **Cancel this room** or **Keep waiting** before it sends. **Admit** appears only for a live meeting that requires admission. When this participant is placed on stage, the existing green room asks for capture consent before any media. A webinar attendee keeps the existing path with zero peer connections. **Spawn demo peer** is absent until the host is live and on stage.

## 6. Acceptance matrix

| ID     | Observable result                                                                                                                                             | Method                                                                     | Status   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| SCH-01 | Host creates `SCHEDULED`, another session opens the slug, and the host sees that waiter. Guest create is `LIVE`. A past time does not start it                | API regressions and a two-window browser flow                              | verified |
| SCH-02 | The waiter is absent from the stage, the page does not capture, and there is no peer connection. Joiner 101 is rejected. A dropped waiter rejoins at the back | Reducer and real Redis tests, plus the browser waiting panel               | verified |
| SCH-03 | Start seats the host first. Admission off fills in order and never makes five seats, counting a suspension. Admission on waits for Admit                      | Concurrent Redis tests                                                     | verified |
| SCH-04 | Scheduled webinar Start makes pre-start waiters attendees. They have no stage seat and no peer connection. Promote still stops at four                        | Webinar join and promote regression, plus the attendee path in the browser | verified |
| SCH-05 | Cancel ends the scheduled room, leaves no broadcast row, and clears the waiting key. A demo join before Start is refused                                      | Service test and the browser cancel control                                | verified |

A browser waiting panel does not close a physical-device, audible-output, or native-picker observation.

## 7. Verification commands

- `pnpm --filter @stageflow/shared test`
- `pnpm --filter @stageflow/api test`
- `pnpm --filter @stageflow/web test`
- `pnpm typecheck`
- `pnpm lint`

Redis races use the existing real Redis integration test. Do not run `pnpm smoke:broadcast` against the developer database. The migration list in the smoke script still gains the new name. If a browser cannot be opened, leave the browser halves unverified and named.

## 8. Risks

| Risk                                         | What keeps it contained                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The advertised time opens the stage          | No timer calls Start. A past timestamp test stays `SCHEDULED`                                        |
| Admit or join creates a fifth seat           | The stage set, including suspensions, is counted inside the Lua script that writes it                |
| A waiter captures or opens a peer connection | The waiting panel does not mount the green room or the peer manager. The server refuses waiter media |
| The waiting key shifts the broadcast key     | The new key is `KEYS[10]`. The five-name unpack and `KEYS[6]` through `KEYS[9]` stay                 |
| Host refresh before Start ends the room      | A pre-start host drop removes that membership and leaves the room `SCHEDULED`                        |
| A demo peer occupies a waiting place         | Synthetic join is refused until the host is live and on stage                                        |
| Home starts loading the broadcast player     | The schedule form stays on the home page, and the entry-graph test still forbids `hls` there         |

## 9. Exit and handoff

The next phase may rely on these once the slices are committed:

- A room is `SCHEDULED`, `LIVE`, or `ENDED`. Older rows are unchanged.
- A registered host, including a Google-only host, can schedule. A guest create is still immediate `LIVE`.
- Waiters are off stage until Start or Admit. Webinar attendees still have zero peer connections.
- The stage cap is still four, including suspended reservations.

V3 phase 5 may add moderated Q&A and the canvas lower-third. Do not write `plans/phase5.md` until that phase is requested.

This phase does not make V2 acceptance complete. Leave the open ids open.

## 10. C01 storage evidence (2026-11-05)

C01 adds the registered room schedule migration, entity fields, shared response contract, strict UTC instant validation, and client parser/fixture updates. Existing rows keep their status and gain null start/false admission. Immediate create explicitly stores `LIVE`, null start, and false admission; request scheduling fields are not accepted yet. Real disposable-Postgres tests cover legacy migration and newly inserted immediate rooms, plus catalog serialization of a past scheduled instant. Shared/API/web suites, typecheck, and lint pass. The execution guide records the broader affected checks. SCH-01 remains planned as an end-to-end requirement until create and browser slices ship; other acceptance ids and existing physical observation gaps are unchanged.

## 11. C02 host scheduling evidence (2026-11-06)

C02 adds create-body parsing and the three schedule/admission errors. A verified registered host, including a Google-only host with null email, can create `SCHEDULED` meetings and webinars with canonical UTC instants, including past times. Guests with any scheduling field receive 403 before insertion. Invalid status/start combinations and webinar admission receive 400. Omitted scheduling fields keep both host and guest creation immediate `LIVE`. Real authenticated HTTP tests use an owned disposable PostgreSQL database and verify stored status, response serialization, identity boundaries, and unchanged row counts on rejection. Shared/API suites, focused room tests, typecheck, and lint pass; the guide records broader affected checks. The C01 verification above remains historical evidence for that slice. SCH-01 remains incomplete until waiting/browser work ships; no later slice or physical observation is marked passed.

## 12. C03 waiting membership evidence (2026-11-06)

C03 adds `WAITING`, ordered `waitingParticipantIds`, `waiting_full`, and the tenth live key. Before start, joiners wait without a stage seat and the host is in neither set. Both are muted/video-off and have no resume digest or credential. Scheduled leave/drop removes membership immediately and keeps the room scheduled; bounded cleanup retries preserve this rule after lost Redis replies. Real Redis and reducer tests cover order, overflow without writes, drop/rejoin, TTL/cleanup, and unchanged broadcast key indexing. Connected waiters retain chat authorization until they leave. Shared/API tests, typecheck, and lint pass; the guide records the broader affected checks. SCH-02's server behavior is covered, while its browser no-capture/no-peer-connection observations remain unverified until C05. Start/admission/cancel and later browser work are not implemented here. Existing physical observation gaps remain open.

## 13. C04 start, admission, and cancellation evidence (2026-11-06)

C04 adds host socket commands `room:start`, `stage:admit`, `stage:remove-waiter`, and `room:cancel`. The shared reducer and atomic Redis scripts seat the host before filling a meeting, keep admission-on joiners waiting, release webinar waiters as attendees, and count suspended stage reservations. A concurrent Admit race cannot create a fifth seat. Automatic filling stays inside the script that frees a seat, or join before a newcomer takes a seat. Removal drops the waiter and its transport without filling. Synthetic joins require a live host stage seat.

Start publishes the Redis `LIVE` transition before conditionally updating a still-scheduled catalog row. The existing lifecycle key makes a lost Start reply or catalog failure retry safe. Regressions retain bounded host recovery and finish shutdown even when the catalog still says scheduled. Cancel commits `ENDED`/`ended_at` before clearing live memberships and the waiting key; an owned disposable-Postgres/Redis test verifies no broadcast row exists. Released members receive resume credentials through a targeted event, with guarded metadata kept on the server; waiters and pre-start hosts receive none. C05 must consume that event in its room hook.

Shared/API tests, workspace typecheck/lint, and the complete affected release gate pass. The guide records counts, compiled artifacts, and both smokes. SCH-03 is verified at the reducer/real-Redis boundary. SCH-01, SCH-02, SCH-04, and SCH-05 still need their C05 browser observations. No browser or physical-device observation is closed by this server slice; C05 and C06 remain planned.

## 14. C05 schedule form and browser waiting evidence (2026-11-06)

Registered hosts can schedule a meeting or webinar with an exact UTC instant, including a past instant, and choose admission for meetings. Guests retain immediate create. Library rows show the schedule and keep the invitation control. Scheduled hosts and waiting members join without constructing the capture owner or opening peers. The ordered waiting panel provides host Start/Remove, live meeting Admit when required, and two-step Cancel. An uncertain Start acknowledgement retains a retry action. Server-granted stage membership leads to the existing explicit capture consent flow; released webinar attendees keep their attendee path. Targeted resume credentials are accepted only for the active connection, room, and membership through the RoomSession owner used by the React hook.

All 499 web tests, workspace typecheck/lint, and the selected web formatting/preparation/build/artifact checks pass. Home keeps live/chat/playback code outside its entry graph. The guide records Chrome `156.0.8078.80` headless on Windows with synthetic media/permission UI, real API/PostgreSQL/Redis fixtures, `1280 by 800` and `390 by 844` layouts, and locale `en-GB`/time zone `UTC`. Browser observations cover a past schedule staying scheduled, the host-visible waiting membership, zero capture/peer calls before Start or Admit consent, native peer connections reaching connected after consent, admission on and Remove/rejoin, webinar attendee release with zero peers, confirmed cancellation with no broadcast row or waiting key, and guest immediate create. Combined with C01 through C04 server evidence, SCH-01 through SCH-05 are verified for this phase. Existing V1/V2 physical-device, audible-output, camera-indicator, and native-picker observations remain open. C06 is still planned.
