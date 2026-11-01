# Plans for agents

Read [MASTER_PLAN.md](../MASTER_PLAN.md) first. Section 1 is the execution chain. Section 17 is the shape of a phase file and a guide.

Phases 1 and 2 exited on 2026-11-01. Phase 3 implementation is verified with automated test media; physical-device and native picker observations remain pending. Do not add `phase4.md` or later guides until Phase 3 has exited.

Each verified slice is one local git commit before the next slice starts. The rule is master plan Section 1.4.

| Phase | Contract               | Guide                              | State                                                                                                                      |
| ----- | ---------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1     | [phase1.md](phase1.md) | [phase1/guide.md](phase1/guide.md) | Complete. All implementation slices committed; A01–A09 verified.                                                           |
| 2     | [phase2.md](phase2.md) | [phase2/guide.md](phase2/guide.md) | Complete. All implementation slices committed; P2-A01–P2-A08 verified.                                                     |
| 3     | [phase3.md](phase3.md) | [phase3/guide.md](phase3/guide.md) | All five slices committed and verified with test media; phase exit pending physical-device and native picker observations. |
| 4     | `plans/phase4.md`      | `plans/phase4/guide.md`            | Not written.                                                                                                               |
| 5     | `plans/phase5.md`      | `plans/phase5/guide.md`            | Not written.                                                                                                               |
| 6     | `plans/phase6.md`      | `plans/phase6/guide.md`            | Not written.                                                                                                               |

The phase file is the contract. The guide is the only implementation sequence, and it contains every commit for that phase. One commit does not get its own guide. Split a guide only after that phase has started and the single file is too long to execute in order.
