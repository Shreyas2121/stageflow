# V3 Phase 5 — Moderated Q&A and the canvas lower-third

**Status:** in progress. V3P5-C01 shared question bounds and wire contracts are verified; the release broadcast smoke is unverified because `ffmpeg` is absent from `PATH`. C02 through C06 remain planned.\
**Last updated:** 2026-11-06.\
**Master plan:** `MASTER_PLAN_V3.md` version `3.0.0-draft.6`, Sections 4, 9, 10, and 12 (QA3-01 through QA3-04). Identity, Google, replay lifecycle, and scheduling stay as shipped in `plans/phase1.md`, `plans/phase2.md`, `plans/phase3.md`, and `plans/phase4.md`.\
**Execution guide:** [phase5/guide.md](phase5/guide.md). That guide owns V3P5-C01 through V3P5-C06. Those ids are not the V1 commits in [V1/phase5/guide.md](V1/phase5/guide.md) or the V2 commits in [V2/phase5/guide.md](V2/phase5/guide.md).\
**Requirement IDs:** QA3-01, QA3-02, QA3-03, QA3-04.

This file is the contract. It does not authorize implementation.

## 1. Outcome

A person on stage, and a webinar attendee, can ask a question and upvote one. The host can dismiss a question, close new questions, and put one question on the webinar picture. That question and its author are drawn on the same 1280×720 canvas the host already records, so they appear in the live HLS and in the finished replay. A meeting has the same question list and a local banner. A meeting still cannot start a broadcast.

Example: a webinar is already drawing frames. Sam asks `Can we ship the lower third?`. Ava features it. The sidebar shows Sam's name, the question, and one vote. The host sees the same words in a banner above the mesh. The bottom of the recorded frame shows Sam's name and the question, truncated with an ellipsis when the line does not fit. The vote count stays in the sidebar. Featuring the question does not start a second recording.

## 2. Entry prerequisites

Observed while writing this plan, on 2026-11-06. `HEAD` is `23635d32ab7c`. The worktree was clean. This planning change adds the phase contract and guide. Recheck the worktree at execution.

V3 Phases 1 through 4 are complete. ID-01 through ID-06, LIB-01 through LIB-04, and SCH-01 through SCH-05 are verified as recorded in those phases. A real Google round-trip was not run. This phase does not record the open V1 and V2 acceptance ids as passed. A canvas unit test does not close MEDIA-04 or REC-05.

Observed in that tree:

- Chat uses `${prefix}:chat:` keys from `chatKeys`. `accept.lua` checks the participant hash, copies `displayName` from it, and does not use `common.lua`. `CHAT_TEXT_MAX_LENGTH` is 1,000 and `CHAT_TEXT_MAX_BYTES` is 4,000. Retention, pause, history, and the rate numbers in `packages/shared/src/limits.ts` stay as they are.
- `liveKeys` returns ten keys. Waiting is `KEYS[10]`. Broadcast is `KEYS[6]`. `common.lua` unpacks five names. `KEYS[7]` through `KEYS[9]` are transports, resume, and deadlines.
- `finishShutdown` stops the broadcast, ends the room row, calls `deleteRoom`, then `chat.delete`. `deleteRoom` deletes the ten live keys. It does not delete a `:qa:` key. Startup `clearPresence` scans `${namespace}:room:*` and deletes those keys.
- `RoomSnapshot` has no question field. Meeting `broadcast:start` returns `broadcast_not_available` when `mode !== 'WEBINAR'`.
- `StageRecorder.paint` fills 1280×720 and draws `placeStageFrames`. It does not call `fillText`. A screen share still replaces every other frame. Broadcast code does not import `features/live`.
- The room mounts `ChatPanel` after join, including for a waiter. The chat delay sentence is `Chat is live. It is not synced to the delayed video.` Home must not import `hls.js`, the live room, or chat.
- The participant hash stores `role`, `displayName`, `presence`, `socketId`, `connectionGeneration`, and `isSyntheticBot`. A demo peer in a live meeting is role `SPEAKER` and `isSyntheticBot`.

## 3. Included and excluded

### 3.1 Included

- Plain-text questions, one upvote per question, and a host feature, dismiss, and submission lock.
- Redis keys under `${prefix}:qa:`, atomic Lua writes, and deletion when the room ends.
- Socket events for the board. The board stays out of `RoomSnapshot`.
- A question list, host controls, a host banner, and the delay sentence.
- A lower-third drawn with canvas text on the existing webinar recorder.
- README text for these limits.

### 3.2 Excluded

These are the exclusions this phase is most likely to violate.

- Polls, a PostgreSQL question table, and a replay transcript.
- A change to chat keys, chat limits, chat pause, or chat history.
- Putting a Q&A key in `liveKeys` or teaching `common.lua` about questions.
- HTML parsing, `innerHTML`, and painting the upvote count.
- A second encoder, a server-side overlay, or another video track.
- Starting a broadcast because a question was featured. Giving a meeting an HLS file.
- A fifth stage seat, waiter media, or a change to replay visibility, deletion, Google, or guest create.
- Closing any open V1 or V2 acceptance id, including MEDIA-04 and REC-05.

## 4. Requirement mapping

| ID     | Meaning in this phase                                                                                                                                                    | What this phase does not claim                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| QA3-01 | A connected host, speaker, or attendee submits and upvotes once. A forged name is ignored. Length, the 100-question cap, and the rate numbers in Section 5.1 hold        | A vote from a waiter or a demo peer                     |
| QA3-02 | The host can dismiss, close submissions, feature one question, and clear it. Anyone else receives `not_host`                                                             | A second featured question or a featured vote count     |
| QA3-03 | While a webinar is drawing frames, the featured question and author are visible in the played HLS. Tile rectangles stay the same. A meeting feature creates no broadcast | Passing MEDIA-04 or REC-05. A canvas mock of `fillText` |
| QA3-04 | Chat pause, history, and limits still behave as in V2. A Q&A Redis failure returns a command error and leaves the stage and the broadcast up                             | Sharing one queue with chat or with stage operations    |

## 5. System contracts

### 5.1 Text and limits

Question text is trimmed first. The stored value is 1 to 200 UTF-16 code units, the same `string.length` measurement chat uses, and at most 1,000 UTF-8 bytes. ASCII control characters are rejected after trim: any code unit at or below 31, or code unit 127. A newline is a control character, so a question is one line. Angle brackets are ordinary text. `<b>hi</b>` is stored and shown as those characters.

The board retains at most 100 questions. Dismiss frees a slot. The cap is the number still stored, not the lifetime count. Ids come from `INCR` and are not reused after dismiss.

| Constant                      | Value  | Meaning                                                           |
| ----------------------------- | ------ | ----------------------------------------------------------------- |
| `QA_TEXT_MIN_LENGTH`          | 1      | Code units after trim                                             |
| `QA_TEXT_MAX_LENGTH`          | 200    | Code units after trim                                             |
| `QA_TEXT_MAX_BYTES`           | 1,000  | UTF-8 bytes after trim                                            |
| `QA_BOARD_MAX`                | 100    | Questions retained in the room                                    |
| `QA_SUBMIT_PARTICIPANT_LIMIT` | 5      | New questions from one participant in the window                  |
| `QA_SUBMIT_ROOM_LIMIT`        | 30     | New questions in the room in the window                           |
| `QA_VOTE_PARTICIPANT_LIMIT`   | 20     | New votes from one participant in the window                      |
| `QA_VOTE_ROOM_LIMIT`          | 100    | New votes in the room in the window                               |
| `QA_RATE_WINDOW_MS`           | 10,000 | Shared window length for both pairs of counters                   |
| `QA_USER_RATE_MAX_FIELDS`     | 1,000  | Participant counters kept on one rate hash                        |
| `QA_MAX_QUEUED_OPERATIONS`    | 32     | Waiting Q&A operations for one room, same shape as the chat queue |
| `QA_IDLE_TTL_SECONDS`         | 86,400 | TTL refreshed on Q&A keys. This matches the live room key TTL     |

Chat constants in `limits.ts` stay at their current values. Submit counters and vote counters are separate hashes, so a vote does not consume the question budget.

The rate member and the vote member are the participant id on the connected membership. Resume keeps that id. A later join with a new participant id is a new bucket. The server does not read a client-supplied user id.

| Code                   | Message                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `qa_invalid`           | `Enter a question from 1 to 200 characters and at most 1,000 UTF-8 bytes.` |
| `qa_closed`            | `The host closed new questions.`                                           |
| `qa_full`              | `This room already has 100 questions.`                                     |
| `qa_rate_limited`      | `Too many questions. Try again shortly.`                                   |
| `qa_vote_rate_limited` | `Too many votes. Try again shortly.`                                       |
| `qa_not_allowed`       | `Demo peers and people who are waiting cannot use questions.`              |
| `qa_missing`           | `That question is no longer on the board.`                                 |
| `qa_busy`              | `Questions are busy. Try again shortly.`                                   |

These codes belong on `SignalingError` and in `signaling.messages.ts`. They do not belong on `StageError`. `not_host` stays `Only the host can do that.` A dead binding stays `stale_transport`.

### 5.2 Redis keys

Q&A keys use the room prefix and are not live keys:

| Key                             | Redis type | Contents                                                                       |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------ |
| `${prefix}:qa:seq`              | string     | `INCR` source for question ids                                                 |
| `${prefix}:qa:questions`        | hash       | Question id to JSON `{ id, text, authorName, authorParticipantId, createdAt }` |
| `${prefix}:qa:votes:{id}`       | set        | Participant ids that upvoted that question. The count is `SCARD`               |
| `${prefix}:qa:featured`         | string     | Featured question id, or the key is absent                                     |
| `${prefix}:qa:submissions`      | string     | `0` closed. `1` or absent means open                                           |
| `${prefix}:qa:submit-room-rate` | string     | Room submit window                                                             |
| `${prefix}:qa:submit-user-rate` | hash       | Per-participant submit windows                                                 |
| `${prefix}:qa:vote-room-rate`   | string     | Room vote window                                                               |
| `${prefix}:qa:vote-user-rate`   | hash       | Per-participant vote windows                                                   |

`qaKeys` lists the fixed keys. Vote-set keys are dynamic. A script that dismisses a question deletes that vote set in the same script. Room delete loads the ids from the questions hash and deletes those vote sets together with the fixed keys. A scan, if one is required for an orphan, is limited to `${prefix}:qa:votes:*` and every returned key must start with that exact prefix. A Q&A script does not delete the participants hash, a chat key, a live key, or another room.

The participants hash is an extra key argument, as in `accept.lua`. The script checks `presence == 'connected'` and matching `socketId` and `connectionGeneration`. It copies `displayName` and `authorParticipantId` from that hash. Client fields named `displayName`, `participantId`, `userId`, `authorName`, `votes`, or `createdAt` are `invalid_payload` when present on the command, and the script never reads them from the command payload.

Writes are one Lua script per command. The script does not use `common.lua`. A successful script sets the 86,400 second TTL on the fixed keys and on every vote set named by the questions hash. It does not expire the participants key.

Startup already removes these keys because they sit under `${namespace}:room:*`. `finishShutdown` also calls `qa.delete(prefix)` beside `chat.delete`. `deleteRoom` stays limited to the ten live keys. There is no migration and no sweeper. The smoke migration list does not gain a name.

### 5.3 Who can submit, vote, and moderate

Submit, vote, and state are allowed for a connected participant whose role is `HOST`, `SPEAKER`, or `ATTENDEE`, and whose `isSyntheticBot` is false. `WAITING` and a synthetic peer receive `qa_not_allowed` and write nothing. The pre-start host is role `HOST` and may use the board before Start.

Closed submissions reject a new question from everyone, including the host, with `qa_closed`. Votes, dismiss, feature, clear, and open are still allowed. The check order for a new question is membership, role, closed, full board, then rate. A refusal before the rate check does not consume a slot. A full board returns `qa_full`.

One upvote is `SADD` of the participant id. A repeat vote returns success, does not raise the count, and does not consume vote rate. A missing question returns `qa_missing` before the rate check. There is no downvote and no unvote.

The host commands require `role == 'HOST'`. Anyone else receives `not_host`. That includes a registered attendee and a guest who is not the room host. A guest who created the room is the host. Authority is the membership role, not `is_guest` and not a Google subject.

| Command         | Who                                               | Result                                                                                      |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Submit          | Allowed member, submissions open, board below 100 | Stores one question and returns the board                                                   |
| Vote            | Allowed member                                    | Adds that participant once, or returns the same count when the vote is already there        |
| Dismiss         | Connected host                                    | Removes that question and its vote set. Dismiss of the featured question clears the feature |
| Feature         | Connected host                                    | Stores that one id. A later feature replaces it. Does not call broadcast start              |
| Clear feature   | Connected host                                    | Removes the feature. Success when nothing is featured                                       |
| Set submissions | Connected host                                    | Writes `0` or `1`. Does not delete questions or clear the feature                           |
| State           | Allowed member                                    | Returns the board. Creates nothing                                                          |

The board order is vote count descending, then `createdAt` ascending, then id ascending as a number. One state script returns the list, the counts, and the feature together. The featured value is `{ questionId, text, authorName }` built from the stored question, or null. A featured id that is no longer in the hash is returned as null and the featured key is removed.

### 5.4 Delivery

Q&A stays out of `RoomSnapshot` and out of the stage reducer. The socket events are:

| Direction | Event                | Body                                                                                          |
| --------- | -------------------- | --------------------------------------------------------------------------------------------- |
| Client    | `qa:submit`          | `{ text }`. Ack is the state or an error                                                      |
| Client    | `qa:vote`            | `{ questionId }`. Ack is the state or an error                                                |
| Client    | `qa:dismiss`         | `{ questionId }`                                                                              |
| Client    | `qa:feature`         | `{ questionId }`                                                                              |
| Client    | `qa:clear-feature`   | Empty payload                                                                                 |
| Client    | `qa:set-submissions` | `{ open: boolean }`                                                                           |
| Client    | `qa:state`           | Empty payload. Ack is the caller's state                                                      |
| Server    | `qa:state`           | `{ submissionsOpen, featured, questions }` emitted to the room after each successful mutation |

`questionId` is the decimal `INCR` value without a leading zero, matching `^[1-9][0-9]{0,18}$`. Extra keys on a command are `invalid_payload`.

The room event carries `voteCount` and does not carry who voted. The caller's ack also carries `votedQuestionIds` for that participant only. A room event updates counts without clearing the caller's local voted set. There is no submit dedup key. The composer disables itself while a submit ack is in flight. A lost submit ack can create a second question if the person sends again. A repeated vote ack is safe.

The service has its own repository and its own serialized queue, keyed `room:{roomId}:qa`, with the same 32-waiting bound as chat. It does not run on the stage queue or the chat queue. Redis down, a Lua failure, or a full queue returns `qa_busy`, publishes nothing, and does not call leave, stage apply, or broadcast stop. The membership gate follows `authorizeChat` for `not_joined`, `stale_transport`, and `room_ended`, and it returns `qa_busy` when live Redis is not ready. It is a separate method. Q&A does not call `authorizeChat`, because that success still includes waiters.

### 5.5 Canvas and room

The question list is a feature component mounted from the live room beside chat. It does not own peers, the recorder, or `hls.js`. It is shown for a connected `HOST`, `SPEAKER`, or `ATTENDEE`, including the pre-start host. It is omitted when the role is `WAITING` and before join. Home, the account panel, and the Google return page do not import it.

The heading is `Questions`. The webinar sentence is `Questions in this list are live. The question on the webinar video follows the broadcast delay.` The meeting sentence is `Questions in this list are live. A meeting does not record them.` The chat sentence stays unchanged. After the room ends, the list already on screen remains and the controls stop, with `This room has ended. Questions are closed.`

Host controls, shown only when the connected role is `HOST`, are Dismiss, Feature, Clear feature, Close questions, and Open questions. Everyone who can see the list gets Ask and Upvote. Upvote shows the count. The featured row is marked `Featured` for everyone. The host also sees a local banner above the mesh with the question and the author. The banner is page text. It is not a second canvas. Mesh tiles stay the camera or the screen.

`StageRecorder` gains `setLowerThird({ text, authorName } | null)` on the existing recorder interface, and the broadcast session forwards it. Broadcast code does not import `features/live` or `features/qa`. The live room passes the plain value. It passes that value when it creates the webinar recorder and when the feature changes while that recorder is drawing. It does not call it for a meeting.

`paint` still fills the background and draws `placeStageFrames` at the current rectangles. A lower-third is painted after those videos and covers the bottom of the frame. It does not move the tile rectangles. The band is `{ x: 0, y: 624, width: 1280, height: 96 }` with fill `#161b22`. Padding is 24, so the text box is 1,232 wide. The author is `600 22px sans-serif` in `#9ca3af` at baseline y 660. The question is `28px sans-serif` in `#f9fafb` at baseline y 696. Each line that is wider than the box is cut on a UTF-16 boundary and ends with `…`. `fillText` is the only text call. The vote count is not an argument. A `measureText` throw skips that line and does not leave `paint`. A null lower-third paints no band. Featuring paints the next frame of a broadcast that is already drawing. It does not call `tryBeginBroadcast` or `broadcast:start`.

## 6. Acceptance matrix

| ID     | Observable result                                                                                                                                                                     | Method                                                                        | Status  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------- |
| QA3-01 | Two members submit and upvote. A forged name is stored as the membership name. Over-long text, controls, question 101, and the rate caps fail with the codes in Section 5.1           | Shared parser tests, real Redis scripts, and a two-window room                | planned |
| QA3-02 | The host dismisses, closes, features, and clears. A non-host is refused. Dismiss of the featured question clears it. A repeat vote does not raise the count                           | Real Redis authorization tests                                                | planned |
| QA3-03 | A webinar frame that is already drawing shows the question and author in the played HLS. Tile rectangles are unchanged. A meeting feature leaves broadcast start rejected             | Canvas unit test plus an FFmpeg replay observation when `ffmpeg` is on `PATH` | planned |
| QA3-04 | Existing chat pause, history, and limit checks stay green. A thrown Q&A repository does not change the stage revision or stop the broadcast. A paint throw does not stop the recorder | Existing chat tests plus the isolation tests                                  | planned |

A canvas mock that records `fillText` proves the paint call. It does not prove the played HLS. When `ffmpeg` is absent, the HLS half of QA3-03 stays unverified and named. MEDIA-04, REC-05, and the other open physical ids stay open.

## 7. Verification commands

- `pnpm --filter @stageflow/shared test`
- `pnpm --filter @stageflow/api test`
- `pnpm --filter @stageflow/web test`
- `pnpm typecheck`
- `pnpm lint`

Redis races use the existing real Redis integration style under an owned `sf:itest:` prefix. Cleanup deletes that prefix's Q&A keys and the fixture participant hash. Do not run `FLUSHDB`, do not clear a developer live namespace, and do not run `pnpm smoke:broadcast` against the developer database. There is no new migration. If a browser cannot be opened, leave the browser halves unverified and named. If `ffmpeg` is not on `PATH`, leave the played-HLS half of QA3-03 unverified and named.

## 8. Risks

| Risk                                              | What keeps it contained                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The replay shows the sidebar and misses the words | The words are painted in `StageRecorder.paint` after the tiles, on the canvas that already feeds the WebM    |
| A question command takes down the mesh            | Q&A uses its own keys and its own queue. Failure returns `qa_busy` and does not call leave or broadcast stop |
| The lower-third shifts the tile grid              | `placeStageFrames` stays as it is. The band is drawn on top at y 624                                         |
| Featuring starts FFmpeg                           | The feature script writes one Redis id. Meeting start still returns `broadcast_not_available`                |
| A waiter or a demo peer fills the board           | The script requires `HOST`, `SPEAKER`, or `ATTENDEE`, and `isSyntheticBot` false                             |
| Vote sets outlive the room or delete another room | Dismiss and room delete remove the sets for that prefix. Startup still scans only `${namespace}:room:*`      |
| The question list pulls `hls.js` into home        | The panel is mounted from the live room. The entry-graph test forbids it on home                             |

## 9. Exit and handoff

The next phase may rely on these once the slices are committed:

- A connected host, speaker, or attendee can submit and upvote within the limits in Section 5.1. A waiter and a synthetic peer cannot.
- The host can dismiss, close submissions, feature one question, and clear it. One featured question is canvas text on the webinar frame while frames are drawing, and therefore in the HLS and the `READY` replay.
- A meeting has the list and the host banner only.
- Chat keys and chat limits are unchanged. A Q&A failure does not drop the stage or the broadcast.
- Q&A keys die with the room.

V3 phase 6 is local acceptance. Do not write `plans/phase6.md` until that phase is requested.

This phase does not make V2 acceptance complete. Leave the open ids open.
