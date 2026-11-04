# V2 Phase 5 — Combined acceptance

**Status:** planned. No implementation slice has started.\
**Last updated:** 2026-11-04.\
**Master plan:** `MASTER_PLAN_V2.md` version `2.0.0-draft.6`, Sections 9.1, 11, 12, 13, and 14 (UX-01, QA-01, QA-02, QA-03, and the combined local script). Unchanged mesh, lock, device, reconnect, broadcast, and chat rules stay in `MASTER_PLAN.md` version `1.0.9` and in the V2-P1 through V2-P4 contracts.\
**Execution guide:** [phase5/guide.md](phase5/guide.md). That guide owns V2P5-C01 through V2P5-C04. Those ids are not the V1 commits in [V1/phase5/guide.md](V1/phase5/guide.md). This file owns the rules those commits must satisfy.\
**Requirement IDs:** UX-01, QA-01, QA-02, QA-03.

## 1. Outcome

A host can run the practical local session from the workspace through replay, and the records say what was observed and what remains open. The one known product gap, the missing chat server time, is shown on each accepted line. The same session can be operated from the keyboard at desktop size. Existing demo, stage, upload, migration, and restart behavior still holds on disposable fixtures. The README and the phase matrices account for every V2 requirement id.

Example: Ava creates a webinar from the home page, joins with the keyboard, and sends "Starting now." Sam, an attendee, sees that line with Ava's name, the host role, and the server time. Sam asks a question without a camera prompt. Ava pauses chat, Sam reconnects within grace, and the accepted question appears once. Ava starts a broadcast, stops it, and opens the READY replay. The page still says which physical checks nobody has made.

`LIVE` catalog status is still not presence. This phase records results. It does not add a product family.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-11-04. `HEAD` is `7c8f8ed21bc938c7fbdea337ed69efcc07e9559c` (`docs(v2-phase4): record the final slice hash`). `plans/phase1.md`, `plans/phase2.md`, and `plans/phase3.md` already have uncommitted handoff sentences. This planning change adds this phase and updates the V2 pointers. Recheck the worktree at execution. Leave those handoff sentences in place.

V2-P1 through V2-P4 slices are committed. V2-P4 hashes are `74692c53b6219f39645a773d56f79f2e59c914d9`, `d77747c3cd57a6e2dbb4fe6bb65e434ac48ca890`, `712f7f9fb8bdfd78d3a6f17b2916b53ab4c5b9fd`, `dd993548c7472f71ad99e7e15fb70d2529943cad`, `11115868793b9c205485b20de0f91553ca64ac89`, and the final hash above. Shared, API, and web checks passed in that phase. Isolated Chrome with real Socket.IO and Redis passed the chat discussion. Full catalog, multi-peer media, and broadcast/playback observations remain open.

The carry-forward table in Section 4.1 is the starting result for every earlier id. This phase does not record an earlier gap as passed unless the named observation is made here.

Observed in that tree:

- `ChatMessage.sentAt` is the server clock in epoch milliseconds. `apps/web/src/features/chat/chat-panel.tsx` renders the sender name, role, and text. The time is not on the page. The README states that the visible timestamp is missing.
- The chat log is a region labeled "Chat messages". New-message count and pause, recovery, and room-end sentences use a polite status. The log itself is not an assertive live region. Enter sends. Shift+Enter inserts a newline. A new line does not move focus.
- Visible keyboard focus is the existing `:focus-visible` outline in `apps/web/src/styles/base.css`. Home, green room, room, and replay controls are native buttons, links, inputs, selects, and textareas.
- `scripts/smoke-broadcast.mjs` creates a disposable `sf_broadcast_*` database and then asserts only `CreateUsersAndRooms1730332800000` and `CreateBroadcasts1793577600000`. `apps/api/src/database/data-source.ts` also registers `IndexRoomsByHost1793664000000`, in that order. `pnpm check` typechecks, lints, tests, builds both apps, and checks formatting. `pnpm check:release` adds tooling, artifact, live-smoke, and broadcast-smoke steps.
- API tests need Redis and clean up `sf:itest:*` keys. Broadcast smoke needs a disposable Postgres database and `FFMPEG_PATH` pointing at a file. Phase 1 recorded that the smoke was not run because FFmpeg was absent. Developer Postgres, Redis presence, and recordings stay out of failure tests.

Recheck at execution. Git follows V1 master Section 1.4. A missing browser leaves the browser half of UX-01 and the combined script unverified. A missing disposable Postgres or FFmpeg leaves the smoke half of QA-02 and WS-03 unverified. A missing physical device leaves P3-A03, P3-A05, and P3-A06 unverified. None of those gaps authorizes an account, a new migration, a second stage slot, or `restartIce`.

## 3. Included and excluded

### 3.1 Included

- The server time on each accepted chat line.
- A desktop keyboard pass over create, join, devices, recovery, chat, moderation, and replay.
- Fixes for defects that block that pass or the combined local script, with a regression test when the defect can be reproduced in a service.
- The broadcast smoke asserting the migrations already registered in the data source.
- `pnpm check`, and `pnpm check:release` when its disposable services exist.
- README text and phase matrices that give every V2 requirement id a result.

### 3.2 Excluded

These are the exclusions this phase is most likely to violate. V2 master Sections 3.2, 4, and 11 still apply.

- Accounts, scheduling, a waiting room, deployment, or a media-topology change.
- `restartIce`, a Socket.IO reconnect buffer, or a PostgreSQL message table.
- A new recording format, a fourth migration, or a thumbnail generator.
- A new settings page, a skip-link system, or a second focus style.
- Marking P3-A03, P3-A05, or P3-A06 passed from synthetic devices or from an earlier automated run.
- Wiping the developer database, deleting real recordings, stopping shared containers, or running a failure test against developer live presence.
- Writing `plans/phase6.md` or a V3 contract.

## 4. Requirement mapping

| ID    | Meaning in this phase                                                                                                                                        | What this phase does not claim                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| UX-01 | Create, join, device controls, recovery, chat, moderation, and replay can be completed from the keyboard. Focus is visible. State changes have readable text | A certified audit, a mobile layout, or a new interaction model |
| QA-01 | The solo demo, four-slot cap, attendee isolation, locks, cleanup, ordered upload, and missing-FFmpeg behavior still pass their existing checks               | A new demo peer or a second recorder                           |
| QA-02 | Disposable Postgres applies the registered migrations once. Restart evidence stays on disposable fixtures. Developer data is left where it is                | A migration of the developer's own catalog                     |
| QA-03 | The README and the phase records name the acceptance result and every remaining gap, including the server time once it is on the page                        | A statement that every physical observation passed             |

### 4.1 Earlier ids at entry

| ID       | Result already recorded                                                                                        | What this phase may add                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| WS-01    | API passed. Browser unverified                                                                                 | A browser session in the combined script, or the same gap with a reason                                      |
| WS-02    | Parser passed. Browser unverified                                                                              | A browser join from a slug and from this app's room link, or the same gap with a reason                      |
| WS-03    | Catalog tests passed. Smoke and browser unverified                                                             | The corrected disposable smoke when FFmpeg and Postgres exist, and a READY replay when the script reaches it |
| MEDIA-01 | Service tests passed. Two-window browser unverified                                                            | The script's camera and microphone change, or the same gap with a reason                                     |
| MEDIA-02 | Service tests passed. P3-A05 open                                                                              | A native picker observation only when that picker is actually used                                           |
| MEDIA-03 | Service tests passed. Physical unplug unverified                                                               | A physical unplug only when someone performs it                                                              |
| MEDIA-04 | Output tests passed. Playback browser and audible check unverified                                             | Playback in the script. Audible proof only when a person hears it                                            |
| REC-01   | Redis and reducer tests passed. Browser partial, and the Redis-backed browser pass open                        | A resume against the real API and Redis, or the same gap with a reason                                       |
| REC-02   | Redis races and socket smoke passed                                                                            | Nothing further unless the script shows a fifth slot or a duplicate membership                               |
| REC-03   | Web tests passed. Browser partial                                                                              | Media staying off until an explicit device action in the script                                              |
| REC-04   | Server and restart tests passed. Host browser check open                                                       | Host grace, explicit leave, and a disposable restart when the script runs them                               |
| REC-05   | Broadcast service tests passed. Playback and FFmpeg check open                                                 | A real FFmpeg attempt when `FFMPEG_PATH` points at a file                                                    |
| CHAT-01  | Verified in V2-P4                                                                                              | The server time beside the role. Ordering stays as recorded                                                  |
| CHAT-02  | Verified in V2-P4                                                                                              | No new bound                                                                                                 |
| CHAT-03  | Verified in V2-P4                                                                                              | No new authority                                                                                             |
| CHAT-04  | Partial. Isolated chat UI passed. Catalog, media, and playback observations open. The server time is not shown | C01 shows the time. The script may add the catalog and playback observations                                 |
| P3-A03   | Open. Physical microphone and human audible output                                                             | Stays open unless that physical observation is made                                                          |
| P3-A05   | Open. Native screen picker and browser stop control                                                            | Stays open unless that picker observation is made                                                            |
| P3-A06   | Open. Physical camera indicator after leave                                                                    | Stays open unless that indicator observation is made                                                         |

## 5. System contracts

### 5.1 Server time on a chat line

The panel shows `sentAt` for every accepted message. The value on the wire stays the server epoch milliseconds already stored. The page does not replace it with the client clock.

A pure function formats one instant. Its inputs are `sentAt`, `now`, a locale, and a time zone. `sentAt` and `now` are epoch milliseconds. A non-finite `sentAt`, or an instant that does not format, returns no time, and the panel omits the time element. The `dateTime` value is the UTC ISO instant from that `sentAt`. The visible text uses `Intl.DateTimeFormat` with `hour: 'numeric'` and `minute: '2-digit'`. When the local calendar date in that time zone differs from `now`, the same format also includes `year: 'numeric'`, `month: 'short'`, and `day: 'numeric'`. Tests call it with locale `en-GB`, time zone `UTC`, and a fixed `now`.

The panel passes `Date.now()` as `now` and places the result in a `time` element after the role, in the existing muted line. The reading order is name, role, then time. The time is text. A new line still does not move focus, and the time is not its own assertive announcement.

The home page still must not contain the letters `hls` and must not import the chat panel.

### 5.2 Keyboard session

The walk uses current Chrome or Edge on Windows at 1280 by 800 and at 1024 by 768. It uses the keyboard for:

- Home: display name, create meeting, create webinar, join by slug or room link, the room list, copy invitation, broadcast history, a replay link, and **Use a different name**.
- Green room: device selects and join. Mute and camera toggles stay reachable.
- Joined room: leave, camera, microphone, speaker, hand, promote, demote, host locks, the chat textarea, Send, pause, Retry, and the new-message button when it is present.
- Recovery: the reconnecting sentence is available as text, leave stays reachable, and media stays off until the explicit device control.
- Replay: play and the path back to the workspace. Native video controls count.

Visible focus is the existing outline. A control that cannot be reached or operated from the keyboard becomes a native control or receives that outline in this phase. A state change in the walk that has no readable text receives one polite status. The chat log stays a region. The composer label stays **Message the room**.

The walk fixes only a defect it demonstrates. It does not add a settings page.

### 5.3 Release evidence

`pnpm check` is the required gate for every slice that changes code. `pnpm check:release` runs when Redis, a disposable Postgres, and `FFMPEG_PATH` are available. A missing dependency leaves that command unverified and names the reason. The smoke keeps its disposable `sf_broadcast_*` database. Its first migration run expects the three classes registered in `data-source.ts`, in that order: `CreateUsersAndRooms1730332800000`, `CreateBroadcasts1793577600000`, and `IndexRoomsByHost1793664000000`. The second run applies nothing. The log stops describing two migrations.

Developer data is not the fixture. Do not point the smoke at the developer database, delete unrelated Redis keys, stop shared containers, or remove real recordings. Restart evidence remains the existing disposable restart test plus a restart inside the smoke's own process when that smoke runs. An API restart still clears presence, fails an in-flight broadcast with `api restarted`, and leaves a READY catalog row playable.

The combined local script is V2 master Section 13.1. Synthetic devices are enough for the repeatable browser path. Record the browser, the OS, the two widths, and the FFmpeg version when a command prints it. A step that cannot run stays on its requirement id as unverified.

A defect that stops the script is fixed in the slice that finds it, with a service regression when the failure can be reproduced there. The fix keeps the current mesh, device replacement, reconnect, chat bounds, and single 720p pipeline.

### 5.4 What the records say

Each id in Section 4.1 ends this phase with one of three results: verified, partial, or unverified with the command or observation that was missing. The phase acceptance matrix records UX-01, QA-01, QA-02, and QA-03 the same way. Earlier phase files change a status only when this phase actually runs that observation.

The README describes the visible server time, the keyboard result, the checks that ran, and the gaps that remain. Those gaps include P3-A03, P3-A05, and P3-A06 until someone makes those observations. The README keeps the guest-session, device, reconnect, chat, and broadcast limits already shipped.

### 5.5 What stays unchanged

The four-person mesh, Perfect Negotiation, host locks, device replacement, bounded reconnect, ordered upload, and the single 720p recording stay. Chat bounds, pause, history outside the room snapshot, and resume leaving an unsent draft unsent stay. Attendees still join without capture. Replay links stay available to any guest who has the link. This phase adds no database migration.

## 6. Acceptance matrix

| ID    | Observable result                                                                                                                                                                      | Method                                                                                          | Status  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| UX-01 | The Section 5.2 controls complete from the keyboard at both desktop sizes. Focus is visible. Recovery, pause, room end, and chat failure are readable text. The server time is visible | Browser keyboard walk. A missing browser leaves this id unverified                              | planned |
| QA-01 | Existing demo, cap, attendee, lock, cleanup, upload, and missing-FFmpeg tests pass. The script can add and remove three demos inside the four-slot cap                                 | `pnpm check` and the demo steps of the combined script                                          | planned |
| QA-02 | A disposable database applies the three registered migrations and then applies none. Developer recordings remain. READY replay survives a disposable restart                           | Corrected `pnpm smoke:broadcast` when Postgres and FFmpeg exist, plus the existing restart test | planned |
| QA-03 | README and phase records match Section 4.1 after the slices that actually ran. The visible time, the open physical checks, and any skipped command are named                           | Documentation review against the guide's verification results                                   | planned |

A missing browser, Redis, disposable Postgres, or FFmpeg leaves only that method unverified. Synthetic media does not close P3-A03, P3-A05, or P3-A06.

## 7. Verification commands

```powershell
pnpm --filter @stageflow/web test
pnpm check
pnpm smoke:broadcast
```

`pnpm check` includes typecheck, lint, shared, API, and web tests, both builds, and the format check. API tests require Redis. `pnpm smoke:broadcast` requires disposable Postgres and `FFMPEG_PATH`. Skip that smoke when either is missing and name the gap. Chat and live tests still use an `sf:itest:*` prefix.

The keyboard walk and the combined script use the local web app and API. Synthetic devices are enough. Physical microphone, speaker, camera-indicator, and native screen-picker results stay open unless they are observed in this phase.

## 8. Risks

| Risk                                                                        | What to do                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The panel invents a client clock and the line disagrees with `sentAt`       | Section 5.1. Format the stored server instant                             |
| The time is announced on every new line and steals attention                | Section 5.1. Keep the log a region and leave focus where it is            |
| The keyboard pass adds a new settings product                               | Section 5.2. Fix the control the walk cannot operate                      |
| Smoke is pointed at the developer database so the migration list will match | Section 5.3. Keep the disposable database and expect the registered three |
| An unverified browser check is copied forward as verified                   | Section 4.1. Change a status only after the named observation             |
| Physical observations disappear because the script used synthetic devices   | Section 6. P3-A03, P3-A05, and P3-A06 stay named                          |
| Accounts or `restartIce` are added so the session looks finished            | Section 3.2. Those behaviors are not started                              |

## 9. Exit and handoff

V2-P5 is done when UX-01, QA-01, QA-02, and QA-03 have a result, every id in Section 4.1 has a result, each slice is committed under V1 master Section 1.4, and the README describes the visible server time, the checks that ran, and the gaps that remain. A check that could not be run stays unverified with a reason. P3-A03, P3-A05, and P3-A06 stay open unless the physical observation was made.

V2 ends with this phase. A later request may start V3 accounts. It may rely on the guest workspace, in-call devices, bounded reconnect, room chat with the server time visible, and these acceptance records. It may not rely on a written V3 plan.

Do not write `plans/phase6.md`.
