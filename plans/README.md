# Plans for agents

Read [MASTER_PLAN.md](../MASTER_PLAN.md) first. Section 1 is the execution chain. Section 17 is the shape of a phase file and a guide.

Phase 1 exited on 2026-11-01. All four implementation slices are committed and A01–A09 are verified. Do not add `phase2.md` or later guides until that work is requested.

Each verified slice is one local git commit before the next slice starts. The rule is master plan Section 1.4.

| Phase | Contract | Guide | State |
| --- | --- | --- | --- |
| 1 | [phase1.md](phase1.md) | [phase1/guide.md](phase1/guide.md) | Complete. All implementation slices committed; A01–A09 verified. |
| 2 | `plans/phase2.md` | `plans/phase2/guide.md` | Not written. |
| 3 | `plans/phase3.md` | `plans/phase3/guide.md` | Not written. |
| 4 | `plans/phase4.md` | `plans/phase4/guide.md` | Not written. |
| 5 | `plans/phase5.md` | `plans/phase5/guide.md` | Not written. |
| 6 | `plans/phase6.md` | `plans/phase6/guide.md` | Not written. |

The phase file is the contract. The guide is the only implementation sequence, and it contains every commit for that phase. One commit does not get its own guide. Split a guide only after that phase has started and the single file is too long to execute in order.
