# Shared contracts and domain rules

This package is CommonJS for the API and exposes TypeScript source to the web build. Keep production source runtime-independent: relative shared imports only, with no app, React, browser-framework, Node, database, or filesystem dependencies.

| Contract                                                      | Source                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Public exports                                                | [src/index.ts](src/index.ts)                                                                                                         |
| Catalog DTOs, identifiers, paging, exact cursor compatibility | [src/contracts.ts](src/contracts.ts), [src/identifiers.ts](src/identifiers.ts), [src/catalog-page.ts](src/catalog-page.ts)           |
| Stage membership, moderation, suspension/resume, limits       | [src/stage.ts](src/stage.ts), [src/limits.ts](src/limits.ts)                                                                         |
| Signaling events, payload parsers, negotiation decisions      | [src/signaling.ts](src/signaling.ts), [src/signaling.parsers.ts](src/signaling.parsers.ts), [src/negotiation.ts](src/negotiation.ts) |
| Broadcast and chat parsers/limits                             | [src/broadcast.ts](src/broadcast.ts), [src/chat.ts](src/chat.ts)                                                                     |
| Question payload parsers and bounds                           | [src/qa.ts](src/qa.ts), [src/limits.ts](src/limits.ts)                                                                               |
| Stats and demo rules                                          | [src/stats.ts](src/stats.ts), [src/demo-peers.ts](src/demo-peers.ts)                                                                 |

Read the matching `*.test.ts` first. Keep parsers strict and compatible with accepted wire formats. PostgreSQL SQL and raw ordering reads belong in API database helpers. Stage reducer changes must agree with API Lua transitions; update both sides and their regressions when behavior changes.

```powershell
pnpm --filter @stageflow/shared test -- src/catalog-page.test.ts
pnpm --filter @stageflow/shared typecheck
pnpm --filter @stageflow/shared lint
```

Shared changes affect both applications. Use the root affected-check planner and follow the selected broader checks. Root/app commands serialize shared preparation automatically; avoid concurrent independent shared writers. Edit `src`, not generated `dist`; tests are typechecked but excluded from production emit.
