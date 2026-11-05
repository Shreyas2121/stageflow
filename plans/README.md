# Plans for agents

V3 Phase 2 is in progress. C01 through C04 are verified; C05 remains planned. Read [MASTER_PLAN_V3.md](../MASTER_PLAN_V3.md) version `3.0.0-draft.3`, then [phase2.md](phase2.md) and [phase2/guide.md](phase2/guide.md). Phase 1 identity is complete in [phase1.md](phase1.md) and [phase1/guide.md](phase1/guide.md).

V2 contracts, guides, and verification records are history in [V2/](V2/README.md). V1 records are history in [V1/](V1/README.md).

The phase file is the contract. The guide is the only implementation sequence, and it contains every commit for that phase. One commit does not get its own guide. Writing this index does not implement the phase.

| Phase | Contract               | Guide                              | State                                                                                                                                            |
| ----- | ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| V3-P1 | [phase1.md](phase1.md) | [phase1/guide.md](phase1/guide.md) | Complete. C01 through C06 are committed and the final slice hash is recorded. ID-01 through ID-04 are verified. Existing V1/V2 gaps remain open. |
| V3-P2 | [phase2.md](phase2.md) | [phase2/guide.md](phase2/guide.md) | In progress. C01 through C04 verified; C05 planned. ID-05 passes with Google unset; ID-06 fake-exchange cases pass.                              |

Do not write `plans/phase3.md` until V3-P2's handoff says the next phase may be written. Scheduling, replay privacy, deletion, and Q&A stay in later V3 phases.
