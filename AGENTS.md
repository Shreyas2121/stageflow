# StageFlow repository guide

StageFlow is a pnpm TypeScript workspace: React/Vite web, Nest API, and runtime-independent shared contracts. PostgreSQL stores the catalog; Redis owns live membership and chat; the host browser records the stage for FFmpeg/HLS.

## Read only the relevant scope

Read this guide once, then the guide for the code you will change. Follow its deeper guide when applicable; do not load every guide, plan, or test fixture.

| Work                                        | Guide                                                  |
| ------------------------------------------- | ------------------------------------------------------ |
| UI, routes, catalog, chat, browser playback | [apps/web/AGENTS.md](apps/web/AGENTS.md)               |
| HTTP, sockets, persistence, Redis, encoder  | [apps/api/AGENTS.md](apps/api/AGENTS.md)               |
| DTOs, parsers, stage/negotiation rules      | [packages/shared/AGENTS.md](packages/shared/AGENTS.md) |
| Dev runner, checks, builds, smokes, CI      | [scripts/AGENTS.md](scripts/AGENTS.md)                 |
| Phase contracts and acceptance evidence     | [plans/AGENTS.md](plans/AGENTS.md)                     |

Use `rg --files <target-directory>` and `rg -n '<symbol>' <target-directory>` before reading files. Start with the owner, its callers, and adjacent tests. Read bounded sections of large files. Treat `node_modules`, `dist`, coverage, API media data, and temporary browser probes as generated/local material, not source navigation targets.

## Scope and authority

- The user's request defines the work. A plan's existence does not authorize its implementation.
- For phase work, follow the applicable master plan, phase contract, and guide. [plans/README.md](plans/README.md) routes active V3 work; [plans/V2/README.md](plans/V2/README.md) routes V2 requirements. Unchanged V1 invariants remain in [MASTER_PLAN.md](MASTER_PLAN.md).
- For a named review finding, read that finding and its matching maintenance slice in `review.md` if provided, then the affected contract sections. The report may be local/untracked and predate fixes: check current code, `git log`, and the maintenance evidence in `plans/V2/phase*.md` before reimplementing anything.
- Keep the four-person stage, explicit capture consent, bounded recovery, and catalog/live-state boundaries unless the requested contract changes them. Synthetic media or decoded audio does not close physical-device, audible-output, or native-picker observations.

## Work and verification

- Use the pnpm version in [package.json](package.json) and Node from [.nvmrc](.nvmrc). Commands in these guides run from the repository root.
- Inspect `git status --short`; preserve unrelated edits and untracked inputs. Do not stage secrets, `.env`, generated output, or `apps/api/data`.
- Start with focused tests; then run the affected package checks required by the change. Inspect `pnpm check:affected --plan --files <changed-paths>` for the repository's check selection. App test/typecheck/build commands prepare shared output automatically.
- For documentation-only changes, check formatting and referenced paths; application suites are unnecessary. Run `pnpm exec prettier --check <changed-files>` rather than formatting unrelated files.
- Requested implementation slices follow the local verification/commit discipline in [MASTER_PLAN.md](MASTER_PLAN.md) Section 1.4. Record actual results and commit only the scoped work. Do not push or change Git configuration unless requested.
- Keep existing developer services running. Use owned fixtures for integration work; never clear a developer live namespace or remove its owner guard to make a check pass. Setup and prerequisite details are in [README.md](README.md).

Keep these guides as navigation and durable constraints. Update the nearest guide when an owner or command moves; keep task histories, timings, and commit ledgers in the phase records.
