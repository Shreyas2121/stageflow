# Plans for agents

For V2 work, read [MASTER_PLAN_V2.md](../MASTER_PLAN_V2.md) version `2.0.0-draft.4`, then the active phase file in this directory. V1 contracts, guides, and verification records are history in [V1/](V1/README.md).

The phase file is the contract. The guide is the only implementation sequence, and it contains every commit for that phase. One commit does not get its own guide.

V2 Phase 1 slices are committed. Its browser checks and WS-03 smoke remain unverified. V2P2-C01 through V2P2-C06 are committed. The two-window pass and the playback speaker pass were not run. V2P3-C01 through V2P3-C04 are implemented. Server/Redis tests, socket smoke, client tests, and an isolated synthetic-browser recovery run passed. The browser pass against Redis and the reconnect broadcast/playback/FFmpeg checks remain unverified. P3-A03, P3-A05, and P3-A06 stay open. Writing a phase file does not by itself authorize the next slice.

| Phase | Contract               | Guide                              | State                                                                                                                                                                                                           |
| ----- | ---------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2-P1 | [phase1.md](phase1.md) | [phase1/guide.md](phase1/guide.md) | V2P1-C01 through V2P1-C05 are committed. Browser checks and WS-03 smoke are unverified. Owns WS-01 through WS-03.                                                                                               |
| V2-P2 | [phase2.md](phase2.md) | [phase2/guide.md](phase2/guide.md) | V2P2-C01 through V2P2-C06 are committed. Browser passes are unverified. P3-A03, P3-A05, and P3-A06 stay open. Owns MEDIA-01 through MEDIA-04.                                                                   |
| V2-P3 | [phase3.md](phase3.md) | [phase3/guide.md](phase3/guide.md) | Implemented; acceptance partially verified. Automated checks and isolated synthetic-browser recovery passed. Redis-backed browser and broadcast/playback/FFmpeg checks remain open. Owns REC-01 through REC-05. |

Do not generate V2-P4 or V2-P5 until that phase is requested. Chat, accounts, scheduling, and deployment are outside V2-P3.
