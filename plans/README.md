# Plans for agents

For V2 work, read [MASTER_PLAN_V2.md](../MASTER_PLAN_V2.md) version `2.0.0-draft.6`, then the active phase file in this directory. V1 contracts, guides, and verification records are history in [V1/](V1/README.md).

The phase file is the contract. The guide is the only implementation sequence, and it contains every commit for that phase. One commit does not get its own guide.

V2 Phase 1 slices are committed. Its browser checks and WS-03 smoke remain unverified. V2P2-C01 through V2P2-C06 are committed. The two-window pass and the playback speaker pass were not run. V2P3-C01 through V2P3-C04 are implemented. Server/Redis tests, socket smoke, client tests, and an isolated synthetic-browser recovery run passed. The browser pass against Redis and the reconnect broadcast/playback/FFmpeg checks remain unverified. V2 Phase 4's five slices deliver bounded room chat and README limits. Shared/API/web checks and isolated Chrome/Redis discussion and recovery passed; full catalog, multi-peer media and broadcast/playback observations remain open, and the server timestamp is stored but not displayed. P3-A03, P3-A05, and P3-A06 stay open. V2 Phase 5 is specified and not implemented. Writing a phase file does not by itself authorize the next slice.

| Phase | Contract               | Guide                              | State                                                                                                                                                                                                                  |
| ----- | ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2-P1 | [phase1.md](phase1.md) | [phase1/guide.md](phase1/guide.md) | V2P1-C01 through V2P1-C05 are committed. Browser checks and WS-03 smoke are unverified. Owns WS-01 through WS-03.                                                                                                      |
| V2-P2 | [phase2.md](phase2.md) | [phase2/guide.md](phase2/guide.md) | V2P2-C01 through V2P2-C06 are committed. Browser passes are unverified. P3-A03, P3-A05, and P3-A06 stay open. Owns MEDIA-01 through MEDIA-04.                                                                          |
| V2-P3 | [phase3.md](phase3.md) | [phase3/guide.md](phase3/guide.md) | Implemented; acceptance partially verified. Automated checks and isolated synthetic-browser recovery passed. Redis-backed browser and broadcast/playback/FFmpeg checks remain open. Owns REC-01 through REC-05.        |
| V2-P4 | [phase4.md](phase4.md) | [phase4/guide.md](phase4/guide.md) | Five slices delivered; acceptance partial. CHAT-01 through CHAT-03 verified. CHAT-04 catalog/media/playback observations remain open; timestamp display is missing. Automated and isolated Chrome/Redis checks passed. |
| V2-P5 | [phase5.md](phase5.md) | [phase5/guide.md](phase5/guide.md) | Planned. Combined acceptance for the practical local session. Owns UX-01 and QA-01 through QA-03. No slice started.                                                                                                    |

Do not generate a phase after V2-P5. Accounts, scheduling, and deployment are outside V2.
