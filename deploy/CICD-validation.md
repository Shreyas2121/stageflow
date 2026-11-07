# CI/CD local validation

Implementation and validation are local only. No VPS connection, GitHub secret
creation, push or deployment is authorized by this record.

## Results on 2026-11-07

The implementation used an owned `sf-ci-<random>` Docker network, PostgreSQL
16.15, Redis 7.4.12 and a Node 22.23.4 Linux x86-64 builder, with no published
ports or developer data/environment mounts. Source was copied using Git's tracked
and nonignored file list; the local `.env` and Windows node_modules were excluded.
The fixture used pnpm 12.9.1, a frozen install, Debian FFmpeg 5.1.9 and fixture-only
database/Redis URLs. Python safeguards ran separately in Python 3.12.

| Command / observation                                              | Actual result                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:affected --plan --files <scoped implementation paths>` | Selected full `check:release`                                                                                                                                                                                                                   |
| `pnpm install --frozen-lockfile`                                   | Passed in clean Linux source copy                                                                                                                                                                                                               |
| `pnpm check:release`                                               | Passed: 59 tooling, 456 shared, 527 web, 592 API tests; all types, lint, builds, formatting, artifact checks and both smokes                                                                                                                    |
| Previously blocked PostgreSQL integration                          | All 21 tests across catalog cursor, rooms, users and accounts suites passed against disposable PostgreSQL                                                                                                                                       |
| Live smoke                                                         | Passed JWT/origin, stage/media, resume, chat, Q&A, shutdown-retry and cleanup checks                                                                                                                                                            |
| Broadcast smoke                                                    | Passed seven real migrations, pre-V3 preservation/repeat migration, combined room protocol, 5 WebM chunks to 2 HLS segments with audio/video decode, deletion interruption recovery, restart/encoder/budget isolation and owned-fixture cleanup |
| `pnpm audit:check`                                                 | Passed: no production advisories; existing explicit development exceptions for deepmerge/glob/minimatch expire for review on 2026-11-13                                                                                                         |
| `pnpm build:production`                                            | Passed with production domain/API/socket inputs and artifact assertions                                                                                                                                                                         |
| `bash scripts/package-release.sh /tmp/release`                     | Passed, standalone production dependency resolution passed; no direct development dependencies in API node_modules                                                                                                                              |
| Real artifact through receiver `unpack` on Python 3.12             | Passed full path/link/entry/size policy and extraction                                                                                                                                                                                          |
| `python -m unittest discover -s deploy -p test_ci_deploy.py -v`    | All 10 tests passed, including malicious archive subcases, checksum/immutable-release rejection, lock contention, migration failure, health success/deadline and stubbed SSH upload                                                             |
| `bash -n scripts/package-release.sh scripts/ci-upload.sh`          | Passed                                                                                                                                                                                                                                          |
| `actionlint` 1.7.7                                                 | Both workflow files passed, including embedded shell checks                                                                                                                                                                                     |
| Changed-file Prettier and `git diff --check`                       | Passed                                                                                                                                                                                                                                          |

The successful release graph ran under `tini -s` in the local container. Its first
attempt lacked a process reaper; two shutdown tests failed. A second run with the
reaper exposed the existing Unix `killTree` parent-only behavior. Signalling the
captured descendants before the parent fixed that existing regression; all 59
tooling tests then passed without skips. The production systemd units, recording
shutdown policy and owner-fencing implementation were not changed.

The first receiver test attempt used the builder's older Python 3.11, which lacks
the required tar extraction filter; validation moved to Python 3.12 without
weakening extraction. The first package attempt used an incorrect compiled
migration directory; it was corrected to `apps/api/dist/migrations` and repackaged
successfully. The web build emitted its existing deferred-player chunk-size
warning; artifact budget assertions passed.

A subsequent check of the old CI static FFmpeg 6.0 download verified its SHA-256
but failed HLS decoding with an abnormal process exit (`null`, not a timeout).
CI now installs Ubuntu's distribution FFmpeg. A separate Ubuntu 24.04 builder
with the same Node/pnpm and disposable services passed the entire broadcast
smoke with FFmpeg 6.1.1-3ubuntu5, plus the then-current nine safeguards and packaging
checks. This corrected a dependency; no media assertions or smoke steps were removed.

The local rehearsal archive was 18,621,531 bytes, based on source HEAD
`889709c2f6798431749f694bd90577ef94399c3c` plus the uncommitted CI implementation.
It is validation evidence, not an approved production release. Its SHA-256 was
`34d2f63c72776755e57b599a6498cfc849fe59168a7ad8f25d1bb1a41d8f3a2b`.
The migration digest was
`fcb4568d9c66d0eb6f4d65cfcad656e129ed2c76a72eee53a67e4bd04005691e`.
Real GitHub builds use their exact checked-out `github.sha`; no Windows dependency
tree is transferred.

The final Ubuntu rehearsal artifact, including the new FFmpeg provenance field,
was 18,621,167 bytes with SHA-256
`3b2c3605bd3ec9a624cc61ec08e0cf0bb6bdc43db7cbe7321fd896b3f6efb2eb`.
Its checksum and real receiver extraction passed on Ubuntu's Python 3.12.
Only the owned fixture's four containers and their anonymous volumes, private
network and locally built Ubuntu image were removed after evidence collection.
No developer service was stopped. Local evidence logs and the rehearsal artifacts
remain outside the repository under the system temporary directory.

Final privilege review added a mandatory one-time infrastructure-unit drop-in:
root commands now select operator-installed helpers under
`/usr/local/lib/stageflow-ops`, never uploaded release helpers. Backup/restore use
that same protected directory on CI-managed hosts. The tenth safeguard test
rejects infrastructure units that still execute through `current`. The final
Python 3.12 safeguard run passed all ten tests, including health interruption and
pending migration checks. The application/migration units and owner fence remain
unchanged.

Ubuntu 26.04 / systemd 259.9 syntax verification passed for the existing
infrastructure unit with the new CI drop-in and alert unit. A fixture-only
`docker.service` dependency stub was used; no systemd services were started.
The first verification emitted executable-mode warnings from Windows bind-mount
permissions; the bootstrap installs units/drop-ins as 0644.

## Remaining operator gates

No VPS connection, remote bootstrap, GitHub secret/environment configuration,
push, actual Actions execution or deployment was performed. Real restricted SSH,
sudo, target Python/Node, installed units/cgroup, controlled migration activation,
host-key pinning and existing HTTPS-site observations require a future approved
session. The receiver tests mock systemd and HTTP; they do not establish real
Hostinger acceptance. Existing public-launch, capacity, real alert/off-host restore,
TURN, physical-device, audible-output and native-picker gates remain open.

Production automation stays disabled unless `STAGEFLOW_AUTO_DEPLOY=true`; the
initial release path is manual dispatch on main. Bootstrap, environment approval
configuration and a verified pre-migration backup remain required before use.

## Credential startup fix, 2026-11-07

The operator reported that immutable release `0433341` reached a successful
migration service run but failed the API's unprivileged startup check because
the protected `/etc/stageflow` marker was inaccessible. This is operator-provided
incident evidence; this fix did not contact the VPS or rerun its migrations.

The startup check now reads systemd's `external-services` credential. Its exact
token validation fails closed for a missing directory/file, permission failure,
malformed token or conflicting fixture authority. Production is the default;
credential absence never selects dedicated mode. The canonical API unit supplies
`LoadCredential=external-services:/etc/stageflow/external-services`. The existing
root-only source permissions and `InaccessiblePaths=/etc/stageflow` remain intact.
The prepared operator drop-in is compatible with this application fix. Root
infrastructure marker reads, migration service, release receiver, owner fencing
and rollback rules are unchanged.

Dedicated fixtures explicitly select dedicated mode and load the exact
`sf-c12-disposable` fixture credential using the new fixture-only drop-in.
That drop-in must never be installed on the VPS. Neither service mode reads
`/etc/stageflow` directly or invokes Compose.

Fresh local verification used an isolated Ubuntu 24.04 x86-64 builder with Node
22.23.4, pnpm 12.9.1 and FFmpeg 6.1.1-3ubuntu5, plus disposable PostgreSQL 16.15
and Redis 7.4.12 on a uniquely named private network with no published ports.
The original workspace and running developer services were preserved.

- `pnpm check:affected --plan --files <fix paths>` selected the full release graph.
- Frozen dependency installation and complete `pnpm check:release` passed:
  63 tooling, 456 shared, 527 web and 592 API tests, including all 21 PostgreSQL
  integration tests, lint/typecheck, builds, formatting, artifact checks and both
  live/broadcast smokes. Four added deployment tests include credential failure
  subcases and the actual missing-credential startup CLI path.
- Audit passed with the same three existing development exceptions due for
  review on 2026-11-13 and no production advisories. Explicit production build,
  shell syntax, all 10 Python deployment safeguards, production packaging,
  checksum and receiver archive extraction also passed.
- The real `ops.mjs check` command passed as unprivileged `nobody` from both the
  source build and isolated production artifact using a service-readable
  credential copy. In that disposable container the root source stayed owned by
  root at mode 0600, with its parent mode 0700; the same unprivileged user could
  not read the source. This check opened no database connection and started no
  API or migration service. It simulates credential delivery and permissions;
  it does not claim a real systemd activation or target acceptance.
- Ubuntu 26.04 / systemd 259.9 verified production and dedicated fixture unit
  syntax. Node/Docker dependency stubs were used for syntax only; no units were
  started. Real credential transport and activation on the VPS remain a future
  operator check.

The packaging rehearsal used base `0433341` plus this worktree's patch and was
not retained as a deployable release. The next approved deployment must build a
new commit; do not replace the installed failed SHA, automatically revert code
after its migration, or bypass an owner fence. The initial fix push used a
dedicated branch. The user subsequently requested the fix and existing V4
planning changes on main. Those documentation changes passed formatting and
local-link checks; the application fix is unchanged from the complete release
run above. The main-branch push uses `[skip ci]` to suppress push-triggered
workflows and preserve the instruction not to deploy automatically. A later
approved manual release must run the full gate normally.
