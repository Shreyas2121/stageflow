# Guide — V3 Phase 6 acceptance

**Status:** local evidence slice committed; combined/browser and target release gates remain open.\
**Contract:** [phase6.md](../phase6.md).\
**Requested slice:** V3M-C13. This phase adds acceptance evidence, not a product feature or public deployment.

## 1. V3M-C13 — Record V3 and VPS release evidence

**Status:** committed.\
**Proposed commit:** `docs(acceptance): record V3 and VPS release evidence`.\
**Actual commit:** `31b286e`

Read the master, R11/C13 review entry, Phase 5 handoff, relevant maintenance records and current smoke owners before edits. Keep historical observations in place. Do not close target, browser or physical gates without corresponding observations.

Implementation sequence:

1. Create the acceptance contract and identify what is actually proved by earlier source commits and logs. Correct stale master/index status while preserving historical revision notes.
2. Close the local old-data upgrade fixture gap: baseline schema plus guest/room/READY HLS records, four V3 upgrades, exact preservation, legacy guest token, compiled HTTP playback, restart and repeat-run checks. Keep all destructive work in the owned broadcast harness.
3. Collect combined protocol evidence where available, cross-reference existing browser/canvas/player observations, and name any missing fresh combined-browser cases. Keep shared-PostgreSQL adaptation separate from the currently tested dedicated profile.
4. Run focused smoke, inspect affected selection, then full release and audit on the final implementation. Preserve failed-attempt context and cleanup evidence.
5. Record ACC-01/02/03 component results, actual artifact/profile commits, target restrictions and remaining observations in the contract and README. Run documentation formatting/links/whitespace checks.
6. Commit this slice before beginning other work; then record the real hash in `docs(v3-phase6): record the acceptance slice hash`. This follow-up does not turn pending target acceptance into a pass.

## 2. Verification record

Executed on 2026-11-07 against the `fcec172` baseline plus the C13 acceptance-harness changes. No application feature, schema migration or deployment unit changed. `scripts/legacy-upgrade.mjs` now seeds the true pre-V3 schema before the current upgrades; `scripts/combined-acceptance.mjs` joins the real registered/guest/scheduled/admission/suspend/chat/Q&A protocol cases into the existing owned broadcast harness. Focused `pnpm smoke:broadcast` runs passed old-data preservation, legacy-token authenticated playback, exact row/timestamp/HLS-hash checks, combined live policies, real audio/video decode and existing restart/deletion recovery. The initially unready PostgreSQL container and incorrect public-chat-field assertion were corrected as documented in the contract, without relaxing product checks.

The affected planner selected full release; audit was explicitly required by C13. The initial `pnpm check:release` passed all 57 tooling, 456 shared, 527 web and 588 API tests, workspace typecheck/lint and builds, then failed only on master-plan formatting. After formatting, `checkGraph('check:release')` was resumed at `format:check`: formatting, both artifact checks, live smoke and the extended broadcast smoke passed, followed by `pnpm audit:check`. The record does not describe the first invocation as a pass. The produced web artifact is production mode; API/shared/migrations/password worker/all 31 Lua assets are verified. Existing deferred-player chunk warning remains.

Node 22.23.2, pnpm 12.9.1, PostgreSQL 16.15, Redis 7.4.12 and temporary FFmpeg 6.0 were used on Windows. Unique disposable database/namespace/media fixtures were cleaned up; actual VPS/public-origin/physical and fresh combined browser observations were not performed. Earlier Chrome/MediaRecorder/played-featured-HLS and C12 Linux/TLS/restore observations remain explicitly historical and source-pinned. The later shared-PostgreSQL proposal is recorded as unimplemented, so existing dedicated infrastructure ownership is not mistaken for shared-service support.

Changed-file formatting, local Markdown references/anchors, referenced Git commits and whitespace checks passed after the final documentation update. The master status/version and current execution handoff are reconciled; C07/C08 deletion intent is described correctly; feature phase histories are preserved. ACC-01 remains partial, ACC-02 is locally verified, ACC-03 documentation is verified, and public release is not approved. The full evidence matrix, commands, log paths and missing gates are in [phase6.md](../phase6.md).

## 3. Handoff

No further product phase is pre-authorized. Pending external observations stay named in the Phase 6 register. Adapting PostgreSQL to shared infrastructure requires its own scoped request and tests; deploying a public service requires explicit authorization and the target gates.
