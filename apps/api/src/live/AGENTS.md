# Live membership and transport

Paths below are relative to this directory. Keep transport effects, serialized room work, and atomic Redis authority distinct.

| Concern                                                                          | Start here                                                                                                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Socket adapter, authentication/event admission, disconnect delivery              | [signaling.gateway.ts](signaling.gateway.ts), [socket-options.ts](socket-options.ts)                                               |
| Established socket authorization deadline and freshness                          | [socket-authorization.ts](socket-authorization.ts), [socket-authorization.test.ts](socket-authorization.test.ts)                   |
| Membership commands, binding compensation, resume generations, suspension/expiry | [live.service.ts](live.service.ts), [live.service.test.ts](live.service.test.ts)                                                   |
| Redis arguments, snapshots, keys and atomic transitions                          | [live.repository.ts](live.repository.ts), [live.keys.ts](live.keys.ts), [scripts/](scripts/)                                       |
| Namespace ownership, readiness, startup reset, graceful release                  | [live.connection.ts](live.connection.ts), [live.readiness.controller.ts](live.readiness.controller.ts)                             |
| Bounded queues and reserved cleanup capacity                                     | [serialized-operations.ts](serialized-operations.ts)                                                                               |
| Ack/error mapping                                                                | [signaling.messages.ts](signaling.messages.ts)                                                                                     |
| Domain reference and transport contracts                                         | [shared stage reducer](../../../../packages/shared/src/stage.ts), [shared signaling](../../../../packages/shared/src/signaling.ts) |

## Non-obvious invariants

- A disconnect can win before room association, during a mutation, or after commit. Compensate committed abandoned membership through bounded cleanup and preserve a newer connection generation. A single pre-mutation connected check is insufficient.
- Participant identity survives transport replacement. Generation checks apply to commands and relays; suspended stage reservations still count toward the four-person cap. Preserve bounded host grace and expiry behavior.
- Update repository arguments, key ordering, Lua transitions, shared domain rules, and relevant tests together when the state contract changes. [check-artifacts.mjs](../../../../scripts/check-artifacts.mjs) verifies the compiled Lua/key contract.
- Scheduled Start uses the existing `:ending` key as a lifecycle marker: `started` records the Redis transition before the catalog update; `1` records ending intent. Compare its value when checking room end. Keep all ten key positions unchanged. Start retries must reconcile the catalog without seating again.
- Pre-start members and live waiters have no resume digest. After release or admission, `grantResume.lua` guards credential metadata and the targeted `room:resume-credential` event enables recovery; never put credentials in room snapshots.
- Namespace startup cleanup requires ownership. Release only this process's guard on graceful shutdown. Never delete a foreign/stale-looking owner guard or reset developer room keys as a test shortcut.
- Broadcast reservation clearing is attempt-specific. Chat has its own Redis scripts, queue and limits; do not make stage leave depend on chat queue capacity.

```powershell
pnpm --filter @stageflow/api test -- src/live/live.service.test.ts src/live/signaling.gateway.test.ts
pnpm --filter @stageflow/api test -- src/live/live.repository.test.ts src/live/live.integration.test.ts
```

The first group exercises controlled lifecycle orderings; the second includes real Redis behavior. Check the adjacent connection/queue tests when touching those owners. The compiled socket smoke is `pnpm smoke:live`; build the API first when required. The recovery contract and maintenance evidence are in [V2 phase 3](../../../../plans/V2/phase3.md).
