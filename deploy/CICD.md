# GitHub Actions releases on the existing VPS

This is a prepared implementation, not authorization to provision or deploy.
Read [the host runbook](README.md) first. Keep its external-services mode, existing
Nginx site/certificate, allowlist, private media mount, owner fence and systemd
recording shutdown settings. This workflow never manages shared containers.

## How it works

A pull request runs Checks on a fresh Ubuntu runner with throwaway PostgreSQL and
Redis. The complete release gate runs tooling, lint, typechecking, shared/web/API
tests (including PostgreSQL integration), production builds, artifact assertions,
and live/broadcast smokes. Audit and receiver safeguard tests must also pass.
The database URLs are fixed CI values; no production credentials are available.

After merging, Checks runs again. Initially an operator selects **Actions →
Release → Run workflow → main**. Release runs the entire gate again for that exact
commit, creates a Linux x86-64 artifact and waits at the `production` environment.
The approver reviews the commit, gate and artifact before allowing deployment.
Nothing from a pull request can enter the deployment job. There is no
`pull_request_target`, cross-run artifact lookup or inherited secret forwarding.

The artifact contains the compiled API, its isolated production dependency tree
(including shared contracts), compiled website, lockfile, runtime operations
helpers and `release.json`. Its filename includes the full commit SHA. The JSON
records Node/pnpm, architecture, build FFmpeg version, production web endpoints and migration digest.
The adjacent `.sha256` records the archive checksum; GitHub also records an upload
artifact digest. A checksum detects corruption, not a malicious authorized build.
Treat workflow/code review and the dedicated SSH key as release authority.

CI installs the [Ubuntu-packaged FFmpeg](https://packages.ubuntu.com/noble/ffmpeg)
and records its actual version. The old static FFmpeg 6.0 download failed the
local Linux HLS decode check and is no longer used.

SSH streams a commit/checksum header and archive to a single forced receiver.
It stages the upload privately, verifies checksum and archive paths/links, installs
a new root-owned `/opt/stageflow/releases/<commit>`, gracefully stops StageFlow,
checks the stopped cgroup, atomically switches `current`, runs the existing
`stageflow-migrate.service`, starts one `stageflow.service`, then polls both
loopback health endpoints. It does not copy units or execute uploaded scripts as
root. The API and migration execute uploaded application code as `stageflow`.
No release is overwritten or automatically deleted.

GitHub production concurrency never cancels an in-progress deployment. The VPS
also holds `/run/lock/stageflow-release.lock`, shared with backup/restore, for the
entire operation. Concurrent operator operations must acquire that same lock.
Health success confirms dependency readiness, not browser, capacity or public TLS
acceptance. Nginx and TLS are never changed by this pipeline.

## One-time operator bootstrap (future approved VPS session)

1. Confirm the existing host runbook prerequisites: mounted private media,
   external marker containing `sf-external-shared-services`, no fixture marker,
   root-owned `/opt/stageflow/releases`, Node **22.23.4** at
   `/opt/stageflow/node/bin/node`, existing FFmpeg, the reviewed systemd units and
   environment file. API must use `127.0.0.1:4100`; Nginx must serve web output via
   `/opt/stageflow/current/apps/web/dist`. Install Python 3.12+ and sudo if absent.
   Validate installed units with `systemd-analyze verify`; do not replace units
   from CI. No application secret leaves `/etc/stageflow/stageflow.env`.
2. Review `ci-deploy.py` before installing it. Create a dedicated account, with
   no Docker, stageflow or administrator group memberships. Its shell is needed
   by OpenSSH to launch the forced command, but the key cannot invoke a shell.

   ```sh
   sudo useradd --system --create-home --home-dir /var/lib/stageflow-deploy-ssh --shell /bin/sh stageflow-deploy
   sudo chown root:root /var/lib/stageflow-deploy-ssh
   sudo chmod 0755 /var/lib/stageflow-deploy-ssh
   sudo install -d -o root -g root -m 0755 /var/lib/stageflow-deploy-ssh/.ssh
   sudo install -d -o root -g root -m 0700 /var/lib/stageflow-deploy
   sudo install -d -o root -g root -m 0755 /opt/stageflow/releases
   sudo install -o root -g root -m 0755 deploy/ci-deploy.py /usr/local/sbin/stageflow-deploy
   sudo install -d -o root -g root -m 0755 /usr/local/lib/stageflow-ops
   sudo install -o root -g root -m 0644 deploy/infra.sh deploy/external.mjs deploy/backup.sh deploy/restore.sh deploy/stopped.sh /usr/local/lib/stageflow-ops/
   sudo install -d -o root -g root -m 0755 /etc/systemd/system/stageflow-infra.service.d
   sudo install -o root -g root -m 0644 deploy/stageflow-infra-ci.conf /etc/systemd/system/stageflow-infra.service.d/ci-external.conf
   sudo systemctl daemon-reload
   sudo systemd-analyze verify /etc/systemd/system/stageflow-infra.service
   ```

   The existing infrastructure unit follows `current` by default. This mandatory
   drop-in anchors both its root commands to operator-owned code outside releases;
   the receiver checks the effective commands before activation. Updating these
   privileged helpers requires separate operator review/install. CI cannot update
   them. On CI-managed hosts, run offline backup and restore with
   `/usr/local/lib/stageflow-ops/backup.sh` and
   `/usr/local/lib/stageflow-ops/restore.sh`, retaining the existing confirmation
   flag, fencing, lock and snapshot rules. They are intentionally excluded from
   uploaded artifacts. Do not run uploaded root scripts manually.

3. Generate a dedicated Ed25519 key on a trusted operator machine:
   `ssh-keygen -t ed25519 -f stageflow-actions -C stageflow-actions`.
   Use no passphrase for this automation key. Keep the private key out of Git.
   Install its public key in the root-owned mode 0644
   `/var/lib/stageflow-deploy-ssh/.ssh/authorized_keys` with this exact prefix:

   ```text
   restrict,command="sudo -n /usr/local/sbin/stageflow-deploy" ssh-ed25519 PUBLIC_KEY stageflow-actions
   ```

   Use `sudo visudo -f /etc/sudoers.d/stageflow-deploy` to install this rule,
   then set mode 0440 and run `sudo visudo -cf /etc/sudoers.d/stageflow-deploy`:

   ```text
   stageflow-deploy ALL=(root) NOPASSWD: /usr/local/sbin/stageflow-deploy ""
   ```

   The `""` permits **no arguments**. No shell, systemctl, Docker, file-copy or
   arbitrary Python sudo permission is granted. The account must not be able to
   edit its home, authorized key, helper, releases, units, secrets or release lock.
   Disable password and keyboard-interactive authentication for this account in
   an sshd `Match User stageflow-deploy` block; disable forwarding and TTY there
   as defense in depth. Validate `sshd -t` before reloading SSH and retain an
   existing operator session. Check account expiration/lock policies allow public
   key authentication without enabling password login.

4. Obtain the SSH host public key through the Hostinger console or a trusted
   existing operator connection. Compare its fingerprint out of band. Construct
   a known_hosts entry for the exact hostname/IP used by CI (use `[host]:port`
   for a nonstandard port). Do not trust a fresh unauthenticated `ssh-keyscan`.
   Rotation is a reviewed secret update, never `StrictHostKeyChecking=no`.

## GitHub setup (do not do this until approved)

Create an environment named **production**. Restrict deployment branches to
**main**, require reviewers, prevent self-review, and disable administrator bypass
where the repository plan supports it. GitHub documents plan-dependent environment
protections in [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
If reviewer protection is unavailable, leave automatic deployment disabled and
restrict who can dispatch Release; manual dispatch is the initial approval gate.

| Location            | Name                    | Value                                            |
| ------------------- | ----------------------- | ------------------------------------------------ |
| production secret   | `STAGEFLOW_DEPLOY_KEY`  | Complete private Ed25519 key, including newlines |
| production secret   | `STAGEFLOW_KNOWN_HOSTS` | Independently verified host key entry            |
| production variable | `STAGEFLOW_SSH_HOST`    | Verified VPS hostname or IPv4 address            |
| production variable | `STAGEFLOW_SSH_PORT`    | Existing SSH port, default `22`                  |
| repository variable | `STAGEFLOW_AUTO_DEPLOY` | Unset or `false` initially                       |

There are no database, Redis, JWT or OAuth secrets in GitHub. Public build inputs
are explicitly pinned in Checks: `VITE_API_BASE_URL=https://stage.shreyasrasaikar.cloud/api`
and `VITE_WS_URL=https://stage.shreyasrasaikar.cloud`. Change these only through
reviewed workflow changes. Keep optional Google configuration disabled until its
separate acceptance gate passes. No VITE variable may contain a secret.

Protect main with the **Checks / checks** required status, reviews, no force pushes
and review ownership of `.github/workflows`, `scripts/package-release.sh`,
`scripts/ci-upload.sh` and `deploy`. Release additionally uses `needs: validate`,
so it cannot deploy when any required command fails. Permissions are read-only
repository contents; no write token, OIDC token, package publication or persistent
checkout credentials. Third-party Actions use full release commit SHAs resolved
from upstream tags; updates require inspecting upstream changes and revalidation.
No deployment secrets are passed to the reusable validation workflow.

For later automatic main deployment, set repository variable
`STAGEFLOW_AUTO_DEPLOY=true` after a successful manual release and recovery drill.
The same checks and production environment still apply. Keep reviewers enabled
unless a separately reviewed decision removes that approval gate.

## First deployment

1. Complete the host runbook's read-only inventory and one-time provisioning
   separately. Do not restart/recreate `shared-postgres` or `stageflow-redis`.
   Preserve existing Nginx server blocks and certificate paths. Confirm installed
   unit files retain `KillMode=mixed`, 45-second stop, no automatic guard takeover,
   the controlled migration lock, and only one API service.
2. Run a disposable local release check as below; merge the reviewed implementation
   later. Confirm main's full Checks job is green. Reserve a maintenance window:
   deployment stops active recording and disconnects clients. Notify users through
   your normal process before approval.
3. Before schema changes, stop StageFlow and create an offline catalog+media
   snapshot using the existing runbook. Copy it off-host and verify restore in a
   disposable environment. First install on an empty catalog needs a recorded
   empty-state baseline. Record the previous release, migration digest and snapshot
   location. Do not run backup while this receiver owns the release lock.
4. Dispatch Release on **main**. Review artifact `release.json`, source SHA and
   checksum before approving production. Check enough free space for upload,
   expanded release and retained rollback release. Bootstrap must already exist.
5. After success, inspect both health URLs, the existing HTTPS site from an
   allowlisted client, login, sockets and a short explicitly consented recording.
   Compare shared-container IDs before/after without modifying them. Target unit,
   TLS, SSH restriction and recording observations remain operator acceptance.

## Failure handling and rollback

Stop at the first failed step. Upload/checksum/archive/identity rejection occurs
before the running service changes. An existing release SHA is rejected; do not
delete it to bypass investigation. The receiver retains installed releases and
root-only `/var/lib/stageflow-deploy/<commit>.json` phase/previous-path records and
`.sha256` files. Temporary uploads are removed; application data is never removed.

After stop begins, failures leave the API stopped. The journal's
`migration-started` means schema changes may have happened, including a timeout or
lost SSH connection. Treat an interrupted deployment as indeterminate until the
operator inspects the journal and systemd. Do not retry blindly or launch a second
API. Inspect `journalctl --namespace=stageflow -u stageflow.service -u stageflow-migrate.service`
and the protected receiver record. CI logs intentionally omit raw exceptions and
production environment values. If SSH disconnects, wait/inspect whether the lock
is held before taking action. Never unlink a held lock file.

The receiver also refuses activation while the controlled migration unit has a
process, active state or pending job. A disconnected systemctl client can leave a
job running; resolve that job before another release. Upload and activation have
a ten-minute receiver deadline, and TERM/HUP interruptions use the same failure
path. A host crash or forced KILL still requires operator inspection.

There is **no automatic application rollback**. If migration never began, an
operator can select the previous immutable release. If it did begin, inspect the
actual migration table and validate old-code compatibility; matching migration
digests are useful evidence but are not a compatibility guarantee. Prefer a
reviewed forward fix. For incompatible changes, stop/fence the writer and restore
the matching StageFlow catalog **and media snapshot together** using the existing
controlled restore guide. Never restore the whole shared PostgreSQL cluster.

For an explicitly verified compatible code-only rollback, a trusted local
operator holds `flock -n /run/lock/stageflow-release.lock`, stops
`stageflow.service`, sources `/usr/local/lib/stageflow-ops/stopped.sh` and calls
`assert_stopped`, then creates a new temporary symlink to the chosen root-owned
release and atomically renames it over
`/opt/stageflow/current`. Start only `stageflow.service`, verify `/api/health` and
`/api/health/live`, then verify the allowlisted HTTPS flow. Do not run a down
migration automatically. This operator-only path is intentionally unavailable to
the CI SSH key.

An owner-fence refusal requires the existing manual **fence all writers → empty
stopped cgroup → exact observed-token compare-delete** procedure in the host
runbook. The receiver never removes a guard or clears Redis. Never use FLUSHDB,
FLUSHALL, namespace deletion, container replacement or database cleanup to recover.
Do not widen the allowlist or claim public launch acceptance from green CI.

## Local validation

Run `python3 -m unittest discover -s deploy -p 'test_ci_deploy.py' -v` on Linux.
The tests use temporary directories and mocked systemd/HTTP; they validate
malformed headers, traversal, links, special entries, duplicate paths, environment
files, stopped-writer checks, migration failure and both health outcomes.

For a full release check, use a disposable Linux x86-64 builder with Node 22.23.4,
pnpm 12.9.1, FFmpeg, Python 3.12+, a clean source copy and a frozen install. Connect
it only to newly created PostgreSQL 16.15 and Redis 7.4.12 containers on a uniquely
named private Docker network. Publish no service ports, mount no developer data or
environment files, set fixture-only DATABASE_URL/REDIS_URL and the public VITE
values above, wait for PostgreSQL readiness, then run `pnpm check:release`,
`pnpm audit:check`, `pnpm build:production` and
`bash scripts/package-release.sh /tmp/release`. Validate the archive/checksum and
standalone runtime before removing only those named fixture containers/network.
The maintained verification record is [CICD validation](CICD-validation.md).
