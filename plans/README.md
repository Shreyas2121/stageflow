# Plans for agents

For V2 work, read [MASTER_PLAN_V2.md](../MASTER_PLAN_V2.md) version `2.0.0-draft.3`, then the active phase file in this directory. V1 contracts, guides, and verification records are history in [V1/](V1/README.md).

The phase file is the contract. The guide is the only implementation sequence, and it contains every commit for that phase. One commit does not get its own guide.

V2 Phase 1 slices are committed. Its browser checks and WS-03 smoke remain unverified. V2P2-C01 through V2P2-C05 are committed. V2P2-C06 is verified in this documentation slice. The two-window pass and the playback speaker pass were not run. P3-A03, P3-A05, and P3-A06 stay open. Writing either phase file does not by itself authorize the next slice.

| Phase | Contract               | Guide                              | State                                                                                                                                                               |
| ----- | ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2-P1 | [phase1.md](phase1.md) | [phase1/guide.md](phase1/guide.md) | V2P1-C01 through V2P1-C05 are committed. Browser checks and WS-03 smoke are unverified. Owns WS-01 through WS-03.                                                   |
| V2-P2 | [phase2.md](phase2.md) | [phase2/guide.md](phase2/guide.md) | V2P2-C01 through V2P2-C05 are committed. V2P2-C06 is verified. Browser passes are unverified. P3-A03, P3-A05, and P3-A06 stay open. Owns MEDIA-01 through MEDIA-04. |

Do not generate V2-P3 through V2-P5 until that phase is requested. Reconnect, chat, accounts, scheduling, and deployment are outside V2-P2.
