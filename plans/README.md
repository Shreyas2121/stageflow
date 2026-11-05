# Plans for agents

V3 Phase 3 has verified LIB-01 through LIB-04. C01 through C04 are committed; C05 documentation is verified and awaiting commit. Read [MASTER_PLAN_V3.md](../MASTER_PLAN_V3.md) version `3.0.0-draft.4`, then [phase3.md](phase3.md) and [phase3/guide.md](phase3/guide.md). Phase 2 Google sign-in is complete in [phase2.md](phase2.md) and [phase2/guide.md](phase2/guide.md). Phase 1 identity is complete in [phase1.md](phase1.md) and [phase1/guide.md](phase1/guide.md).

V2 contracts, guides, and verification records are history in [V2/](V2/README.md). V1 records are history in [V1/](V1/README.md).

The phase file is the contract. The guide is the only implementation sequence, and it contains every commit for that phase. One commit does not get its own guide. Writing this index does not implement the phase.

| Phase | Contract               | Guide                              | State                                                                                                                                                                                          |
| ----- | ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V3-P1 | [phase1.md](phase1.md) | [phase1/guide.md](phase1/guide.md) | Complete. C01 through C06 are committed and the final slice hash is recorded. ID-01 through ID-04 are verified. Existing V1/V2 gaps remain open.                                               |
| V3-P2 | [phase2.md](phase2.md) | [phase2/guide.md](phase2/guide.md) | Complete. C01 through C05 committed; final slice hash recorded. ID-05 passes with Google unset; ID-06 fake-exchange cases pass. Real Google round-trip not run; existing V1/V2 gaps stay open. |
| V3-P3 | [phase3.md](phase3.md) | [phase3/guide.md](phase3/guide.md) | LIB-01 through LIB-04 verified. C01 through C04 committed; C05 documentation verified and awaiting commit. Existing V1/V2 gaps stay open.                                                      |

Do not write `plans/phase4.md` until V3-P3's handoff says the next phase may be written. Scheduling and Q&A stay in later V3 phases.
