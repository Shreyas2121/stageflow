# API application

Paths below are relative to `apps/api`. This is a Nest/CommonJS application with TypeORM/PostgreSQL and Redis/Lua. For membership, signaling, or namespace ownership, continue to the [live guide](src/live/AGENTS.md).

## Find the owner

| Concern                                                   | Entry points                                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bootstrap, module wiring, shutdown                        | [main.ts](src/main.ts), [app.module.ts](src/app.module.ts), [dev-shutdown.ts](src/dev-shutdown.ts)                                                                                         |
| Validated environment                                     | [config/env.ts](src/config/env.ts), [config/parse-config.ts](src/config/parse-config.ts)                                                                                                   |
| Guest JWT, HTTP authentication, current user              | [sessions/](src/sessions/)                                                                                                                                                                 |
| Password hashing off the API event loop                   | [sessions/password.ts](src/sessions/password.ts), [sessions/password.worker.cjs](src/sessions/password.worker.cjs)                                                                         |
| Browser-bound optional Google transactions                | [sessions/google.controller.ts](src/sessions/google.controller.ts), [sessions/google-browser.ts](src/sessions/google-browser.ts), [sessions/google-state.ts](src/sessions/google-state.ts) |
| Room creation, slug access, host catalog                  | [rooms/rooms.controller.ts](src/rooms/rooms.controller.ts), [rooms/rooms.service.ts](src/rooms/rooms.service.ts)                                                                           |
| Shared catalog ordering/cursors                           | [database/catalog-cursor.ts](src/database/catalog-cursor.ts), [database/ordering-instant.ts](src/database/ordering-instant.ts)                                                             |
| Broadcast reservation, cleanup, upload lifecycle, catalog | [broadcasts/broadcasts.service.ts](src/broadcasts/broadcasts.service.ts), `broadcasts.service.test.ts`, `broadcasts.runtime.test.ts`                                                       |
| Encoder process and media-path confinement                | [broadcasts/ffmpeg-supervisor.ts](src/broadcasts/ffmpeg-supervisor.ts), [broadcasts/hls-path.ts](src/broadcasts/hls-path.ts), [broadcasts/chunk-parser.ts](src/broadcasts/chunk-parser.ts) |
| Independent chat history, deduplication, pause/rates      | [chat/chat.service.ts](src/chat/chat.service.ts), [chat/chat.repository.ts](src/chat/chat.repository.ts), [chat/scripts/](src/chat/scripts/)                                               |
| Independent question board, submit/vote rates and state   | [qa/qa.service.ts](src/qa/qa.service.ts), [qa/qa.repository.ts](src/qa/qa.repository.ts), [qa/scripts/](src/qa/scripts/)                                                                   |
| Admission, network identity, upload budgets               | [admission/](src/admission/)                                                                                                                                                               |
| Schema/migrations                                         | [database/data-source.ts](src/database/data-source.ts), [migrations/](src/migrations/)                                                                                                     |
| HTTP error shape and health                               | [http/](src/http/), [health/](src/health/)                                                                                                                                                 |

Tests are adjacent to these modules. The broadcast test names above are in `src/broadcasts/`.

## Persistence and lifecycle constraints

- Identity comes from verified authentication, not request-supplied host/user ids. Preserve slug-capability access separately from the host-filtered room list.
- Keyset ordering uses exact PostgreSQL timestamp text and UUID comparison. Keep human-facing Date serialization separate from cursor precision; retain the shared cursor compatibility contract.
- Add a new migration for schema changes; do not edit applied migrations or enable automatic synchronization. Update data-source registration and explicit migration-list assertions in integration/smoke fixtures together.
- An ambiguous reservation failure can leave a committed claim. Retain cleanup evidence and conditionally clear only the known attempt; stale cleanup must preserve a newer claim. Keep cleanup idempotent and bounded.
- Preserve admission/media budgets and media-path confinement. Missing FFmpeg must not prevent ordinary API/stage use. Keep chat work independent from the stage operation queue.
- Password hashes stay at bcrypt cost 12 on the bounded worker pool. Do not hash on the API thread, lower the cost to hide latency, or share that budget with guest creation or Google exchange. Idle workers are unreferenced so a one-shot script can exit; Nest shutdown still closes the pool.
- Reserve an encoder slot before FFmpeg setup and release it when the attempt leaves the running set or the process shuts down. Do not start libx264 without the configured thread cap. A full budget is `encoder_capacity`.

## Checks and prerequisites

```powershell
pnpm --filter @stageflow/api test -- src/rooms/rooms.service.test.ts src/broadcasts/broadcasts.service.test.ts src/database/catalog-cursor.integration.test.ts
pnpm --filter @stageflow/api typecheck
pnpm --filter @stageflow/api lint
```

Tests load the root `.env`. Redis integration uses owned `sf:itest:*` keys; catalog cursor integration creates/migrates/drops a uniquely named disposable PostgreSQL database. Missing prerequisites are failures to report, not reasons to weaken assertions.

For package coverage use `pnpm --filter @stageflow/api test`. Build changes require `pnpm --filter @stageflow/api build` then `pnpm check:artifacts --api`; Lua assets must remain byte-identical to source and emitted tests must stay absent. Use `pnpm smoke:live` for compiled gateway/Redis behavior and `pnpm smoke:broadcast` for real API/PostgreSQL/Redis/FFmpeg behavior when the task calls for those boundaries. See the root README for fixture ownership and configuration; do not restart or reset the developer API to run a probe.
