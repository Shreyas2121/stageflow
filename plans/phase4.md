# V2 Phase 4 — Room chat

**Status:** in progress. V2P4-C01 is committed and V2P4-C02's Redis store is verified. V2P4-C03 through V2P4-C05 are planned.\
**Last updated:** 2026-11-04.\
**Master plan:** `MASTER_PLAN_V2.md` version `2.0.0-draft.5`, Sections 1, 5, 8, 9, 10, 11, and 12 (CHAT-01 through CHAT-04). Unchanged mesh, lock, device, reconnect, and broadcast rules stay in `MASTER_PLAN.md` version `1.0.9` and in the V2-P2 and V2-P3 contracts.\
**Execution guide:** [phase4/guide.md](phase4/guide.md). That guide owns V2P4-C01 through V2P4-C05. Those ids are not the V1 commits in [V1/phase4/guide.md](V1/phase4/guide.md). This file owns the rules those commits must satisfy.\
**Requirement IDs:** CHAT-01, CHAT-02, CHAT-03, CHAT-04.

## 1. Outcome

People who are connected to a room can exchange plain text while the room is open. The host, speakers, and attendees share one channel. Each message shows the sender's name and role from the moment it was accepted, in server order. The host can pause new messages for everyone, including the host. A person who joins or resumes sees the recent history. Chat trouble stays on the chat panel. The stage, the peer connections, and the broadcast keep running.

Example: Ava is hosting a webinar. Sam is an attendee and sees the delayed broadcast. Ava writes "Starting now." Sam sees that line, then writes a question. Ava pauses chat. Sam's next send is rejected and the panel says the host paused chat. Ava resumes chat. Sam's page reconnects within grace. The question he already sent appears once. A line that was still waiting is marked not sent, and the page does not send it again by itself. The panel says chat is live and is not synced to the delayed video.

`LIVE` catalog status is still not presence. This phase does not change the room list or the recording.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-11-04. `HEAD` is `0a1c9492639762928d56716de0c4cfa2f34c89ac` (`docs(v2-phase3): record the final slice hash`). `plans/phase1.md` and `plans/phase2.md` already had uncommitted handoff sentences. This planning change adds this phase and updates the V2 pointers. Recheck the worktree at execution.

V2-P1 slices are committed. The browser checks for WS-01 through WS-03, and the WS-03 smoke, remain unverified. V2-P2 slices are committed. The two-window device pass and the playback speaker pass were not run. V2-P3 slices are committed: `dcac0b369d1679ccaba2cef56135c7b1b16f4377`, `59244b2843ccad1c1a4797b51d8b039282ca0c39`, `4a39252c5faaeaa3f84d86a30fa68fb5c4ea9bfd`, and `501c490dae070b6ae39459eeb9969737c8d182cf`. Server and Redis tests, the socket smoke, client tests, and an isolated synthetic-browser recovery run passed. The browser pass against Redis, and the reconnect broadcast, playback, and FFmpeg checks, remain unverified. V1 physical observations P3-A03, P3-A05, and P3-A06 remain open. This phase does not record those gaps as passed.

Observed in that tree:

- There is no chat event, chat store, or chat panel. The room page shows the stage, roster, device controls, and, for a webinar attendee, the delayed broadcast.
- A participant has `participantId`, `connectionGeneration`, and `presence`. `validateBinding` requires a connected row, the current socket, and the current generation. A mismatch returns `stale_transport` (`This connection is no longer current.`).
- `liveKeys` has nine entries. `KEYS[6]` is the broadcast lock. `deleteRoom` deletes that list. Startup scans `<namespace>:room:*` and deletes every match. Room ids are UUIDs. An API restart clears presence and fails in-flight broadcasts with `api restarted`. The catalog room can stay `LIVE`.
- Stage commands share one `SerializedOperations` queue. `room:leave` bypasses the socket event budget. Other events use `SOCKET_EVENT_RATE_LIMIT` over `RATE_WINDOW_MS`. A full queue returns `server_busy`.
- The web client uses `reconnection: false`. Resume keeps the credential in page memory, refetches the room snapshot, and does not replay the old socket buffer. `RoomSnapshot` has no message list.
- Lua for the stage is copied from `apps/api/src/live/scripts`. `scripts/check-artifacts.mjs` expects 14 Lua files there and a key list of length 9. Nest copies `live/scripts/*.lua` only.
- Demo peers are separate sockets. Nothing in the demo engine sends text.

Recheck at execution. Git follows V1 master Section 1.4. API tests need a reachable Redis and clean up only their `sf:itest:*` keys. A missing browser leaves the browser half of CHAT-01 and CHAT-04 unverified. A missing physical device leaves P3-A03, P3-A05, and P3-A06 unverified. Neither gap authorizes a second stage slot, a chat row in PostgreSQL, or message HTML.

## 3. Included and excluded

### 3.1 Included

- One plain-text channel for a connected host, speaker, or attendee, in a meeting or a webinar.
- Server-assigned order, sender name, and role at accept time.
- A host pause that blocks every sender, including the host and a synthetic participant.
- Recent history for a new join and for a resume, outside the room snapshot.
- Bounds for length, bytes, retention, page size, rate, deduplication, and pending sends.
- A visible retention gap, a failed send, and an explicit retry of the same request id.
- README text for these limits.

### 3.2 Excluded

These are the exclusions this phase is most likely to violate. V2 master Sections 3.2 and 9 still apply.

- Message HTML, links as anchors, uploads, embeds, editing, deletion, or private messages.
- A chat row in PostgreSQL, a replay transcript, or chat that seeks to the HLS playhead.
- Putting the message list into `room:state`.
- An unbounded offline buffer, or a resume that sends a draft by itself.
- Using the stage operation queue for chat, or letting a chat failure close peers, end the room, or stop the broadcast.
- Accounts, scheduling, `restartIce`, and a new recording format.
- Demo peers that invent their own lines. A connected synthetic participant may send only when a test or a future control does. Pause still applies to that send.
- Closing P3-A03, P3-A05, P3-A06, or the unverified V2-P1, V2-P2, and V2-P3 browser and playback checks.

## 4. Requirement mapping

| ID      | Meaning in this phase                                                                                                                                                        | What this phase does not claim                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| CHAT-01 | Two connected members exchange lines in one ascending sequence. Join and resume show the retained page once, with no hole hidden and no duplicate of an accepted request     | A complete archive before the retention window         |
| CHAT-02 | Trimmed text is 1 to 1,000 UTF-16 code units and at most 4,000 UTF-8 bytes. History keeps 500 messages. A page is 50 by default and at most 100. Rates and dedup match below | A limit that evicts an active counter to admit someone |
| CHAT-03 | Pause blocks every sender. A suspended, stale, left, or wrong-room socket cannot send. A client-supplied name or role is not stored                                          | A pause that rewrites messages already accepted        |
| CHAT-04 | A rejected send leaves the mesh and the broadcast up. Room end stops sending and keeps the lines already on the page. The panel says chat is not synced to the delayed video | Proof that a physical room heard the stage             |

## 5. System contracts

### 5.1 Who may speak

The server loads the participant for the bound `participantId`. The socket id and `connectionGeneration` must match, and `presence` must be `connected`. The script checks that again in the same Redis execution as the write. The payload does not carry a room id, a display name, a role, or a timestamp. Extra fields fail `invalid_payload`.

Host, speaker, and attendee use the same channel. A synthetic participant is a normal sender when a caller actually sends. This phase adds no demo composer and no generated lines.

A socket with no bound room returns the existing `not_joined` failure. A suspended, missing, expired, or replaced row returns the existing `stale_transport` failure. The stage stays up. The participant row is the sender: join already rejects a second row for the same user id.

### 5.2 Message, order, and history

A message is `sequence`, `participantId`, `displayName`, `role`, `text`, and `sentAt`. `sequence` is a positive integer from `INCR` and is the message id. `displayName` and `role` are copied from the participant row. `sentAt` is the server clock passed into the script. `text` is trimmed. Internal newlines stay. The stored length is 1 to 1,000 UTF-16 code units and at most 4,000 UTF-8 bytes.

The client request id is a UUID. The accept script remembers the latest 500 `participantId` plus request id pairs for the room. A repeated pair returns the original message and does not append, does not spend rate, and does not change pause. When the 501st pair arrives, the oldest pair is dropped. A retry after that drop can create a second message. That bound is the dedup guarantee.

History lives in Redis under the room prefix, so the existing `<namespace>:room:*` scan deletes it on startup. Keys are `chat:seq`, `chat:messages`, `chat:paused`, `chat:dedup`, `chat:room-rate`, and `chat:user-rate`. They are not added to `liveKeys`. `KEYS[6]` stays the broadcast lock. Each chat write refreshes a 86,400-second TTL. `deleteRoom`'s stage list stays as it is. Room shutdown deletes the chat keys in that same shutdown, after the stage keys. Deleting them twice is safe.

The room snapshot does not contain messages or the pause flag. History is `chat:history`. The first page is the latest 50 messages, ascending by sequence. `beforeSequence` asks for older messages, at most 100. The response includes `paused`, `oldestSequence`, `latestSequence`, and `retentionGap`. `retentionGap` is true when the caller asked for a sequence the list no longer holds. The panel then shows `Earlier messages are no longer available.` The list keeps at most 500 messages. Appending past that drops the oldest.

Live delivery is `chat:message` to the socket.io room after the script commits. The sender's ack returns the same message. The client applies a sequence at most once. A live sequence below or equal to the applied history is ignored. A live sequence more than one past the applied history fetches that gap once. If the gap was trimmed, the panel shows the retention sentence.

Join fetches history after the join ack. Resume drops every in-flight send to failed, then fetches history. It does not send those lines again. An explicit Retry uses the original request id.

### 5.3 Pause, rate, and capacity

`chat:set-paused` is host-only. The script checks the host row and writes the flag. A send reads that flag in its own script, so a pause and a send cannot both accept. Pause blocks the host, speakers, attendees, and synthetic senders. The panel shows `The host paused chat.` Unpause is the same command with `paused: false`. Old messages stay.

Rate limits are inside the accept script, over a 10-second window: 10 accepts for that participant and 100 accepts for the room. A duplicate request id does not count. Over the limit returns `chat_rate_limited`. The user-rate hash holds at most 1,000 fields, one per participant id. A new field past that returns `chat_busy` and does not evict an active field. The existing socket event budget still applies. Chat does not use the `room:leave` bypass.

Chat work uses a separate queue from stage `SerializedOperations`, keyed by the chat room and capped at 32 waiting operations. Past that, the command returns `chat_busy`. A full chat queue does not reject leave, suspend, or a media command. The client holds at most 5 unacknowledged sends. The sixth stays in the composer and shows `Chat is busy. Try again shortly.`

### 5.4 What the page shows

The panel is on the room page for a joined member, a recovering member, and a page that already has lines when the room ends. The green room does not show it before join. Recovering can read and cannot send. After resume, the history fetch is the source of the list.

The composer is a labeled textarea and a Send button. Enter sends. Shift+Enter inserts a newline. Messages render as text. The page does not parse them as HTML and does not turn URLs into anchors. A new line does not move focus. If the list is away from the latest line, the page shows a button with the new-message count and does not jump. That count is a polite status. The log itself is not an assertive live region.

The panel always shows `Chat is live. It is not synced to the delayed video.` Room end disables the composer, keeps the lines already shown, and shows `This room has ended. Chat is closed.`

A failed send stays on the page with Retry. Retry sends the same request id. Closing the failure does not send it.

### 5.5 What stays unchanged

The four-person mesh, Perfect Negotiation, host locks, device replacement, bounded reconnect, ordered upload, and the single 720p recording stay. Initial stage join still requires both permissions. Attendees still join without capture. Replay links stay available to any guest who has the link. The home page still must not contain the letters `hls` and must not import the chat panel. This phase adds no database migration.

## 6. Acceptance matrix

| ID      | Observable result                                                                                                                                                                                                             | Method                                                                                        | Status  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------- |
| CHAT-01 | Two sockets receive the same ascending sequences. A history page and a live event for one sequence render once. Resume shows the accepted line once and leaves an in-flight line unsent                                       | Real Redis integration, web session tests, then a two-window browser check                    | partial |
| CHAT-02 | Empty, 1,001-code-unit, and over-4,000-byte texts fail. The 501st stored message drops the oldest and sets `retentionGap`. The 11th accept in a window returns `chat_rate_limited`. A repeated request id returns one message | Shared parser tests and Redis tests with a controlled clock and a small retention argument    | partial |
| CHAT-03 | Pause rejects the host and a synthetic sender. A stale generation and a suspended row return `stale_transport`. A payload that includes `displayName` is `invalid_payload`, and the stored name is the participant row's name | Redis script tests and a gateway test                                                         | partial |
| CHAT-04 | `chat_paused`, `chat_rate_limited`, and `chat_busy` leave the stage queue able to leave. Room end deletes the chat keys and the page keeps its lines. The delayed-video sentence is in the panel                              | Service tests and a browser check. Physical stage audio stays unverified unless someone hears | planned |

A missing browser or Redis leaves only that method unverified. Tests pass `now` and a small retention cap into the script. They do not insert 500 messages and they do not sleep 10 seconds.

**V2P4-C01 verification (2026-11-04):** Shared tests passed (262), including the CHAT-02 parser cases for trimmed text, UTF-16 boundaries, oversized UTF-8 input, strict request fields, history pagination, and pause payloads. `pnpm typecheck` and `pnpm lint` passed. CHAT-02's Redis retention, rate, and dedup checks remain planned. No chat socket event, store, or panel is implemented yet; all browser and earlier physical/native-picker gaps remain open.

**V2P4-C02 verification (2026-11-04):** API tests passed against Redis (205), including 11 chat repository/cache and integration tests. The store verifies ordered acceptance, server-derived sender identity, concurrent deduplication, pause for every sender, stale transport rejection, bounded retention and ascending pages, rate windows, user-rate capacity, idle TTL refresh, and idempotent chat-only deletion. `pnpm typecheck`, `pnpm lint`, the API build, and the API artifact check passed. The fourteen live scripts and nine stage keys remain unchanged. Gateway authorization, queue isolation, shutdown wiring, and client/browser acceptance remain planned.

## 7. Verification commands

```powershell
pnpm --filter @stageflow/shared test
pnpm --filter @stageflow/api test
pnpm --filter @stageflow/web test
pnpm typecheck
pnpm lint
rg -n "hls" apps/web/src/pages/HomePage.tsx
```

The search prints nothing. API tests require Redis. Chat tests use an `sf:itest:*` prefix and delete those keys.

The two-window check uses the local web app and API. Send from the host and from an attendee, pause, resume the socket, and confirm one copy of an accepted line. Synthetic devices are enough. Physical microphone, speaker, camera-indicator, and native screen-picker results stay open unless they are observed in this phase.

## 8. Risks

| Risk                                                                | What to do                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| The client name is stored, so the roster and the line disagree      | Section 5.1. Copy the name and role from the participant row        |
| History is embedded in `room:state` and every media tick carries it | Section 5.2. History is a separate ack and a separate event         |
| Resume replays an uncertain composer line                           | Section 5.2. Mark it failed and wait for Retry                      |
| Pause and send both win                                             | Section 5.3. The accept script reads the flag in the same execution |
| Chat uses the stage queue and a flood blocks leave                  | Section 5.3. A separate queue returns `chat_busy`                   |
| Startup leaves the previous room's lines under a reused id          | Section 5.2. Keys sit under `room:*` and shutdown deletes them      |
| The panel injects message HTML                                      | Section 5.4. Render text                                            |
| A chat error calls `teardownLocal` or stops the broadcast           | Section 5.5. The failure stays on the panel                         |
| Accounts or a replay transcript are added so the log looks durable  | Section 3.2. Those stores are not started                           |

## 9. Exit and handoff

V2-P4 is done when CHAT-01 through CHAT-04 have a result, each slice is committed under V1 master Section 1.4, and the README describes the channel, the pause, the retention, the resume behavior, and the delayed-video sentence. Unverified browser and physical checks stay named. P3-A03, P3-A05, P3-A06, and the earlier unverified V2 browser, smoke, and FFmpeg checks stay open.

V2-P5 may rely on this separate chat channel, the host pause, and history that is absent from the room snapshot. It may rely on resume leaving an unsent draft unsent. It may not rely on a written combined-acceptance plan. Do not implement that acceptance pass in this phase.

Do not write `plans/phase5.md` until that work starts.
