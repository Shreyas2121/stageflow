# V1 plans

These are the V1 phase contracts, guides, and verification records. They were moved here from `plans/` on 2026-11-03 so the active V2 phase can occupy `plans/`.

V1 product authority remains [MASTER_PLAN.md](../../MASTER_PLAN.md) version `1.0.9`. [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md) is the V2 authority. Active V2 phase files stay in the parent `plans/` directory. This directory is history.

Section 1 of the V1 master plan is the execution chain that produced these files. Section 17 is the shape of a phase file and a guide.

Phases 1 and 2 exited on 2026-11-01. Phase 3's five slices are committed and verified with test media; physical-device and native picker observations remain pending. Phase 4's four slices are committed and its own acceptance checks are verified with synthetic host devices. Master Section 16 records the user's explicit exception authorizing Phase 5 while retaining the outstanding Phase 3 observations. Phase 5 P5-A01 through P5-A06 passed with synthetic browser devices; all four slices are committed. Phase 6's six slices are committed. P6-A01 through P6-A04 and P6-A07 passed. RC18 verified P6-A05, P6-A06 and P6-A08 with native Chrome, synthetic devices and real FFmpeg after the fixes in `326dea3`. Phase 3 physical observations remain explicitly unverified at the user's request; V1 is not fully verified. Requested remediation in `review.md` Section 8 may proceed independently.

Each verified slice is one local git commit before the next slice starts. The rule is master plan Section 1.4.

| Phase | Contract               | Guide                              | State                                                                                                                                                                                                                      |
| ----- | ---------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | [phase1.md](phase1.md) | [phase1/guide.md](phase1/guide.md) | Complete. All implementation slices committed; A01–A09 verified.                                                                                                                                                           |
| 2     | [phase2.md](phase2.md) | [phase2/guide.md](phase2/guide.md) | Complete. All implementation slices committed; P2-A01–P2-A08 verified.                                                                                                                                                     |
| 3     | [phase3.md](phase3.md) | [phase3/guide.md](phase3/guide.md) | All five slices committed and verified with test media; phase exit pending physical-device and native picker observations.                                                                                                 |
| 4     | [phase4.md](phase4.md) | [phase4/guide.md](phase4/guide.md) | All four slices committed; P4-A01–P4-A06 verified with synthetic host devices. Phase 3 physical follow-up remains required under master Section 16.                                                                        |
| 5     | [phase5.md](phase5.md) | [phase5/guide.md](phase5/guide.md) | Complete. All four slices committed. P5-A01 through P5-A06 passed with synthetic browser devices; Phase 3 physical follow-up remains open.                                                                                 |
| 6     | [phase6.md](phase6.md) | [phase6/guide.md](phase6/guide.md) | All six slices committed. P6-A01 through P6-A04 and P6-A07 passed. P6-A05/A06/A08 passed in RC18 with native Chrome, synthetic devices and real FFmpeg. Physical Phase 3 follow-up remains open; V1 is not fully verified. |

The phase file is the contract. The guide is the only implementation sequence, and it contains every commit for that phase. One commit does not get its own guide. Split a guide only after that phase has started and the single file is too long to execute in order.

Historical entry snapshots and per-slice results describe the repository and checks at that time. Use master version `1.0.9` for current status, feature-local service ownership (Section 12), and affected checks/service-regression scope (Section 14). C01 through C20 are historical remediation. The current review RC01 through RC17 are committed; RC18 records acceptance and remaining limitations. See review.md Section 9 and the Phase 6 guide for commit/evidence mappings.
