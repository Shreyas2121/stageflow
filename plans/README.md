# Plans for agents

For V2 work, read [MASTER_PLAN_V2.md](../MASTER_PLAN_V2.md) version `2.0.0-draft.2`, then the active phase file in this directory. V1 contracts, guides, and verification records are history in [V1/](V1/README.md).

The phase file is the contract. The guide is the only implementation sequence, and it contains every commit for that phase. One commit does not get its own guide.

V2 Phase 1 is the current-guest room and replay workspace. V2P1-C01 through V2P1-C05 are committed. Browser checks for WS-01 through WS-03 remain unverified. WS-03 smoke remains unverified. Writing a later phase file does not authorize that phase.

| Phase | Contract               | Guide                              | State                                                                                                             |
| ----- | ---------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| V2-P1 | [phase1.md](phase1.md) | [phase1/guide.md](phase1/guide.md) | V2P1-C01 through V2P1-C05 are committed. Browser checks and WS-03 smoke are unverified. Owns WS-01 through WS-03. |

Do not generate V2-P2 through V2-P5 until that phase is requested. Device controls, reconnect, chat, accounts, scheduling, and deployment are outside V2-P1.
