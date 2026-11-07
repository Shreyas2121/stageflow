# Tooling and integration harnesses

Paths below are relative to `scripts`; commands run from the repository root. These are Node ESM tools, primarily verified with the built-in Node test runner.

| Work                                                   | Owner                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Change selection and command graph                     | [check-affected.mjs](check-affected.mjs), [checks.mjs](checks.mjs)                   |
| Shared build/watch serialization and verified reuse    | [shared-build.mjs](shared-build.mjs)                                                 |
| Typed-lint dependency fingerprints                     | [lint.mjs](lint.mjs)                                                                 |
| Dev compiler/API/web supervision and graceful restart  | [dev.mjs](dev.mjs), [dev-shutdown.mjs](dev-shutdown.mjs)                             |
| Artifact/Lua/deferred-player checks                    | [check-artifacts.mjs](check-artifacts.mjs)                                           |
| Production web build and mode/endpoint evidence        | [build-web.mjs](build-web.mjs), [production-artifacts.mjs](production-artifacts.mjs) |
| Dependency audit policy                                | [audit.mjs](audit.mjs), [audit-exceptions.json](../audit-exceptions.json)            |
| Real socket or encoder integration                     | [smoke-live.mjs](smoke-live.mjs), [smoke-broadcast.mjs](smoke-broadcast.mjs)         |
| Linux operating profile and isolated deployment drills | [deployment guide](../deploy/AGENTS.md), [deploy.test.mjs](deploy.test.mjs)          |

Prefer adjacent `*.test.mjs` and owned helper fixtures over reproducing a failure against a running developer process. Keep Windows helpers hidden, clean up only owned processes/directories/keys, and retain namespace guard protections. Dev shutdown/restart tests must not kill the real API or take over another shared writer.

Dev owner tests need reachable Redis, configured through `REDIS_URL` or the root `.env`; their namespaces and processes are isolated fixtures.

Shared output is reused only after source/configuration generation and emitted-file verification. Preserve dependency-scoped lint invalidation and conservative affected-check fallback. Keep schema/migration and artifact assertions synchronized with actual application contracts.

```powershell
node --test scripts/check-affected.test.mjs
pnpm test:tooling
pnpm lint:config
pnpm check:affected --plan --files scripts/check-affected.mjs
```

`pnpm check:release` includes tooling tests, package gates, artifacts, and both smokes. Audit is separate: `pnpm audit:check`. Broadcast smoke needs disposable PostgreSQL, Redis, and an available FFmpeg path. Report prerequisites and actual command outcomes precisely; temporary review probes are not a maintained browser test suite. CI selection lives in [checks.yml](../.github/workflows/checks.yml).
