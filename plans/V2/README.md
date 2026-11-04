# V2 plans

These are the V2 phase contracts, guides, and verification records. They were moved here from `plans/` on 2026-11-04 so the active V3 phase can occupy `plans/`.

V2 product authority remains [MASTER_PLAN_V2.md](../../MASTER_PLAN_V2.md) version `2.0.0-draft.9`. V1 history is in [../V1/README.md](../V1/README.md). The active V3 phase stays in the parent `plans/` directory. This directory is history.

V2-P1 through V2-P5 are delivered. Acceptance is partial. UX-01 and QA-01 are verified. QA-02 is partial. QA-03 is the README record in [phase5.md](phase5.md). Each chat line shows the server time. Still partial: WS-01, WS-02, WS-03, MEDIA-01, MEDIA-02, REC-01, REC-03, REC-04, and CHAT-04. Still unverified: MEDIA-03's physical unplug, MEDIA-04 playback and audible check, and REC-05 playback and FFmpeg. P3-A03, P3-A05, and P3-A06 stay open. `pnpm check:release` and `pnpm smoke:broadcast` were skipped because `FFMPEG_PATH` is the bare name `ffmpeg` and is not on PATH.

| Phase | Contract               | Guide                              | State                                                                                                                                                                                                                                        |
| ----- | ---------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2-P1 | [phase1.md](phase1.md) | [phase1/guide.md](phase1/guide.md) | V2P1-C01 through V2P1-C05 are committed. WS-01 and WS-02 have a partial browser result. WS-03 replay and `pnpm smoke:broadcast` remain unverified. Owns WS-01 through WS-03.                                                                 |
| V2-P2 | [phase2.md](phase2.md) | [phase2/guide.md](phase2/guide.md) | V2P2-C01 through V2P2-C06 are committed. MEDIA-01 has a synthetic two-window result. MEDIA-03's physical unplug, MEDIA-04 playback, and P3-A05 remain unverified. Owns MEDIA-01 through MEDIA-04.                                            |
| V2-P3 | [phase3.md](phase3.md) | [phase3/guide.md](phase3/guide.md) | Implemented; acceptance partially verified. Automated checks and isolated synthetic-browser recovery passed. REC-01 has a partial Redis-backed browser resume. Broadcast playback and FFmpeg checks remain open. Owns REC-01 through REC-05. |
| V2-P4 | [phase4.md](phase4.md) | [phase4/guide.md](phase4/guide.md) | Five slices delivered; acceptance partial. CHAT-01 through CHAT-03 verified. CHAT-04 remains partial: the server time is on the page, and playback is still open. Automated and isolated Chrome/Redis checks passed.                         |
| V2-P5 | [phase5.md](phase5.md) | [phase5/guide.md](phase5/guide.md) | Delivered; acceptance partial. UX-01 and QA-01 are verified. QA-02 is partial. QA-03 is the README record. Section 4.1 names the remaining gaps. Owns UX-01 and QA-01 through QA-03.                                                         |

The phase file is the contract. The guide is the only implementation sequence, and it contains every commit for that phase. One commit does not get its own guide.

Do not add a V2 phase here. Accounts, scheduling, replay deletion, and Q&A belong to V3.
