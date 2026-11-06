# Plans for agents

V3 Phase 4 is in progress: C01 through C05 are implemented and verified; C06 remains planned. Read [MASTER_PLAN_V3.md](../MASTER_PLAN_V3.md) version `3.0.0-draft.5`, then [phase4.md](phase4.md) and [phase4/guide.md](phase4/guide.md). Phase 3 replay privacy is complete in [phase3.md](phase3.md) and [phase3/guide.md](phase3/guide.md). Phase 2 Google sign-in is complete in [phase2.md](phase2.md) and [phase2/guide.md](phase2/guide.md). Phase 1 identity is complete in [phase1.md](phase1.md) and [phase1/guide.md](phase1/guide.md).

V2 contracts, guides, and verification records are history in [V2/](V2/README.md). V1 records are history in [V1/](V1/README.md).

The phase file is the contract. The guide is the only implementation sequence, and it contains every commit for that phase. One commit does not get its own guide. Writing this index does not implement the phase.

| Phase | Contract               | Guide                              | State                                                                                                                                                                                          |
| ----- | ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V3-P1 | [phase1.md](phase1.md) | [phase1/guide.md](phase1/guide.md) | Complete. C01 through C06 are committed and the final slice hash is recorded. ID-01 through ID-04 are verified. Existing V1/V2 gaps remain open.                                               |
| V3-P2 | [phase2.md](phase2.md) | [phase2/guide.md](phase2/guide.md) | Complete. C01 through C05 committed; final slice hash recorded. ID-05 passes with Google unset; ID-06 fake-exchange cases pass. Real Google round-trip not run; existing V1/V2 gaps stay open. |
| V3-P3 | [phase3.md](phase3.md) | [phase3/guide.md](phase3/guide.md) | Complete. C01 through C05 committed; final slice hash recorded. LIB-01 through LIB-04 verified. Existing V1/V2 gaps stay open.                                                                 |
| V3-P4 | [phase4.md](phase4.md) | [phase4/guide.md](phase4/guide.md) | In progress. C01 through C05 verified; C06 planned. SCH-01 through SCH-05 have server and controlled-browser evidence; existing physical observations remain open.                             |

Do not write `plans/phase5.md` until V3-P4's handoff says the next phase may be written. Q&A stays in a later V3 phase.
