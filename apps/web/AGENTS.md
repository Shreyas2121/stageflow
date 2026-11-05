# Web application

Paths below are relative to `apps/web`. Read the [live feature guide](src/features/live/AGENTS.md) for call, recovery, device, and RTC work before opening its large coordinator/test files.

## Find the owner

| Concern                                    | Start here                                                                                                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providers, query cache, routes             | [main.tsx](src/main.tsx), [App.tsx](src/App.tsx), [route-error-boundary.tsx](src/app/route-error-boundary.tsx)                                                                                                                           |
| Home workspace, room/replay entry          | [pages/](src/pages/)                                                                                                                                                                                                                     |
| Catalog paging and retries                 | [catalog-paging.ts](src/features/rooms/catalog-paging.ts), [query-options.ts](src/features/rooms/query-options.ts), [catalog-paging-controls.tsx](src/features/rooms/catalog-paging-controls.tsx)                                        |
| Room/recording rows and links              | [room-list.tsx](src/features/rooms/room-list.tsx), [room-history.tsx](src/features/rooms/room-history.tsx), [history.ts](src/features/rooms/history.ts)                                                                                  |
| Guest/host identity, account forms, expiry | [account-panel.tsx](src/features/session/account-panel.tsx), [api.ts](src/features/session/api.ts), [session-store.ts](src/features/session/session-store.ts), [authenticated-request.ts](src/features/session/authenticated-request.ts) |
| Chat ordering, gaps, failed attempts       | [chat-session.ts](src/features/chat/chat-session.ts)                                                                                                                                                                                     |
| Chat rendering and timestamps              | [chat-panel.tsx](src/features/chat/chat-panel.tsx), [chat-transcript.tsx](src/features/chat/chat-transcript.tsx), [format-chat-time.ts](src/features/chat/format-chat-time.ts)                                                           |
| Broadcast producer and uploads             | [broadcast-session.ts](src/features/broadcast/services/broadcast-session.ts), [stage-recorder.ts](src/features/broadcast/services/stage-recorder.ts), [chunk-upload.ts](src/features/broadcast/services/chunk-upload.ts)                 |
| Deferred playback and recovery             | [broadcast-player-gate.tsx](src/features/broadcast/components/broadcast-player-gate.tsx), [player-session.ts](src/features/broadcast/services/player-session.ts), [playback.ts](src/features/broadcast/services/playback.ts)             |
| HTTP timeout/error parsing                 | [client.ts](src/lib/http/client.ts)                                                                                                                                                                                                      |
| Shared UI and styling                      | [components/ui/](src/components/ui/), [styles/](src/styles/), [index.css](src/index.css)                                                                                                                                                 |

## Boundaries to retain

- Keep app imports separate from the API. Shared browser contracts come through `@stageflow/shared`; Vite compiles their source directly.
- Keep room/replay routes dynamic and the player deferred until playback. Home, meeting, and host entry must not eagerly pull in `hls.js`. Use [entry-graph.test.ts](src/app/entry-graph.test.ts) and artifact checks for import changes.
- Catalogs use one infinite query per user and catalog. Preserve abort signals, token-match 401 cleanup, fresh-cursor refetch, first-id deduplication, and READY-only replay links. Account password errors retain the current session. Binary media requests retain their own transport rules.
- Chat state is independent of stage/media operations. Preserve bounded attempts, visible retention gaps, plain text, and the transcript boundary that keeps draft edits from formatting unchanged messages.

## Focused checks

Tests sit beside their owners as `*.test.ts`; most exercise services with controlled collaborators, without a DOM. For example:

```powershell
pnpm --filter @stageflow/web test -- src/features/rooms/catalog-paging.test.ts src/features/rooms/api.test.ts
pnpm --filter @stageflow/web typecheck
pnpm --filter @stageflow/web lint
```

Run `pnpm --filter @stageflow/web test` for package regression coverage. For production/import/asset changes, run `pnpm --filter @stageflow/web build` then `pnpm check:artifacts --web`. Recorder/uploader changes also require the encoder boundary selected by the affected-check tooling. See [vite.config.ts](vite.config.ts) and [package.json](package.json) for current configuration.
