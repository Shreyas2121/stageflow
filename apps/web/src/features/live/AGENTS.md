# Browser live feature

Paths below are relative to this feature. Locate the state owner first; keep RoomSession as the room-membership coordinator rather than adding independent workflows to it.

| Concern                                                                                           | Owner and nearby regression tests                                                                                    |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Join/leave, membership phase, role consent, page lifecycle, owner wiring                          | [services/room-session.ts](services/room-session.ts), `room-session.test.ts`                                         |
| Resume credentials, attempt epochs, retry/deadline timers, obsolete bindings, leave deduplication | [services/recovery-controller.ts](services/recovery-controller.ts), `recovery-controller.test.ts`                    |
| Replacement queue/cancellation, enumeration, loss/pending flags, speaker state/listeners          | [services/in-call-devices.ts](services/in-call-devices.ts), `in-call-devices.test.ts`                                |
| Capture, held/committed tracks, preview, meter, capture cleanup                                   | [services/local-media.ts](services/local-media.ts), `local-media.test.ts`                                            |
| Per-peer transceiver ownership, Perfect Negotiation, ICE queue, sender replacement                | [services/peer-manager.ts](services/peer-manager.ts), `peer-manager.test.ts`                                         |
| Socket acknowledgements, pending events, snapshot ordering                                        | [services/signaling.ts](services/signaling.ts), [stores/room-store.ts](stores/room-store.ts)                         |
| Screen lifecycle and camera restore                                                               | [services/screen-share.ts](services/screen-share.ts), [hooks/use-screen-share.ts](hooks/use-screen-share.ts)         |
| Output binding/fallback                                                                           | [services/output-route.ts](services/output-route.ts), `output-route.test.ts`                                         |
| Demo lifecycle                                                                                    | [services/demo-registry.ts](services/demo-registry.ts), [services/demo-peer.ts](services/demo-peer.ts)               |
| Active speaker and on-demand stats                                                                | [services/active-speaker.ts](services/active-speaker.ts), [services/stats-collector.ts](services/stats-collector.ts) |
| React subscription and controls                                                                   | [hooks/use-live-room.ts](hooks/use-live-room.ts), [components/](components/)                                         |

The named tests are in `services/`. Search their test titles before reading the large RoomSession fixture. [services/boundaries.test.ts](services/boundaries.test.ts) covers feature boundaries. Broadcast and chat have their own owners outside this feature.

## Lifecycle constraints

- A fresh transport must earn server authority; discard obsolete callbacks and stage events. Resume keeps the selected bounded schedule, captures nothing, and leaves media off until an explicit action. Leave/pagehide/disposal cancel recovery; pageshow does not rejoin.
- Device work belongs to the generation that accepted it, including queued requests. Release late tracks and suppress stale rollback errors. LocalMedia owns capture; PeerManager owns senders; the device controller coordinates them through room capabilities.
- Keep one negotiated audio/video transceiver per peer. The initial impolite endpoint offers; missing polite-side kinds are adopted from that offer. Compatible replacement uses owned senders, not an arbitrary first-by-kind lookup. Preserve the shared negotiation reducer and bounded ICE handling.
- Preserve screen share during camera replacement, current mute/host locks, explicit promotion consent, and teardown on demotion. Keep cached snapshots stable between notifications for `useSyncExternalStore`.

```powershell
pnpm --filter @stageflow/web test -- src/features/live/services/recovery-controller.test.ts src/features/live/services/in-call-devices.test.ts src/features/live/services/room-session.test.ts
pnpm --filter @stageflow/web test -- src/features/live/services/peer-manager.test.ts src/features/live/services/signaling.test.ts
```

RTC association claims need native-browser evidence when relevant; a simple fake array is insufficient. Record controlled signaling/synthetic sources separately from real transport, physical devices, audible output, and the native picker. Device and recovery contracts are in [V2 phase 2](../../../../../plans/V2/phase2.md) and [V2 phase 3](../../../../../plans/V2/phase3.md).
