# StageFlow on the shared Hostinger KVM 2

For a beginner-friendly visual explanation, open [explained.html](explained.html) in a browser. It includes clickable request journeys, a release simulation, storage and recovery explanations, and a glossary; it works offline.

This profile targets **Ubuntu Server 26.04 LTS, x86-64**, selected for V3M-C12. The VPS is shared with other applications. It runs one native Node API writer, a site in the existing nginx, and dedicated Docker PostgreSQL 16.15/standalone Redis 7.4.12 instances. No cluster, second API, automatic guard takeover, or public media directory is supported. The actual VPS inventory, domain, remote access, and other applications' allocations have not been supplied; local Linux evidence is recorded in [the maintenance record](../plans/phase5.md). These files do not authorize deployment or an unrestricted launch.

Ubuntu 26.04 is the selected LTS; Ubuntu 26.10 has a much shorter support window. See [Ubuntu's release cycle](https://ubuntu.com/about/release-cycle). Keep an existing shared 24.04 server until a separately planned OS upgrade. Never reimage it to apply this profile.

## Allocation and restricted trial

These are conservative **resource ceilings to validate**, not measured capacity. The KVM 2's published 2 vCPU/8 GB/100 GB/8 TB belong to the whole VPS. Confirm `nproc`, `free -h`, `lsblk -f`, `df -h`, architecture and cgroup v2 on the actual host, then reconcile all apps' reservations before installing anything. Stop if these reservations do not fit.

| Owner                           | CPU ceiling                | RAM / tasks                                            | Storage / work budget                                                                                                                         |
| ------------------------------- | -------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| API plus FFmpeg                 | 75% of one core            | 1536 MiB hard, 1280 MiB high, no swap; 96 tasks        | One encoder, one encoder thread, 15 minutes/256 MiB per recording; retained media 1 GiB; 2 GiB free-space floor                               |
| Dedicated PostgreSQL            | 25% of one core            | 768 MiB, no swap; 128 tasks                            | 30 connections; 128 MiB shared buffers; dedicated catalog                                                                                     |
| Dedicated Redis                 | 10% of one core            | 256 MiB container, 160 MiB keyspace, no swap; 32 tasks | AOF; `noeviction` preserves the owner guard                                                                                                   |
| Health / explicit migration job | 10% / 25% of one core      | 128 / 512 MiB                                          | Health every minute; migration runs with API stopped                                                                                          |
| Persistent StageFlow data       | Separate 12 GiB filesystem | Existing apps keep their own filesystems               | PostgreSQL, Redis, media, one local pending encrypted-export snapshot; alert below 2 GiB free                                                 |
| Ingress / logs                  | Existing shared nginx      | 32 active requests for this virtual host               | API responses limited to 512 KiB/s per response; upload 2 MiB; access/error log sizes checked every five minutes, rotated at 10 MiB, 7 copies |

API/FFmpeg + database + Redis reserve at most 1.1 cores and 2.5 GiB, plus the health job and shared ingress. Migration/backup work runs offline. Leave the remaining resources to the OS and other apps; do not change their units, Docker daemon, database, ports, firewall, or nginx defaults. Application storage limits do not bound database, Docker, journal or backup growth; the dedicated filesystem and monitoring are required too.

The shipped allowlist admits only loopback. The first externally reachable trial must be operator-controlled and IP-allowlisted: one room, up to four stage users and two viewers, one recording, and Google disabled. This is a test restriction, **not a supported six-user capacity promise**. Keep a StageFlow egress allocation of 5 GiB/day and 100 GiB/month, with alerts at 80% and an operator stop at the budget. Collect the site's `$body_bytes_sent` access-log field into the existing monitoring system; per-response rate limiting is not an aggregate or monthly traffic quota. Include WebRTC/TURN traffic separately. Do not remove the allowlist until target workload, egress and alert gates below are satisfied.

## Prepare the host and release

Run provisioning only during an authorized maintenance window after backing up the other apps and recording free resources. Use the existing Docker/nginx installations when present. On a clean Ubuntu 26.04 host, install `nginx certbot docker.io docker-compose-v2 ffmpeg curl openssl logrotate` with apt; do not replace an already managed Docker installation with another distribution. Check `docker compose version`, `systemctl --version`, and `stat -fc %T /sys/fs/cgroup` (`cgroup2fs`). Keep Docker access root-only/trusted operators: access to its socket is equivalent to root.

Install the supported Node 22 binary under `/opt/stageflow/node` (fixture tested 22.23.4), after verifying its release SHA-256 from [Node's official distribution](https://nodejs.org/dist/). Use pnpm 12.9.1 from the root manifest on the build host. Use the correct Linux architecture; do not copy Windows node_modules. Keep the Node install root-owned, execute-only for the service, and apply supported security updates through a tested release.

Build a frozen Linux release with the actual public URLs following [the root production build instructions](../README.md). Run `pnpm build:production` and the release/audit gates. Install production dependencies with `pnpm install --prod --frozen-lockfile --ignore-scripts`. Preserve workspace links, package manifests, lockfile, compiled shared/API/web output, and this `deploy` directory. Copy into a **new**, root-owned `/opt/stageflow/releases/<commit>` directory. It must contain no `.env`, secrets or media. Make the static web output traversable/readable by `www-data`, and the runtime readable by `stageflow`. Never grant the API write access to releases or nginx certificates. Record the source commit, Node/pnpm/FFmpeg versions and image digests with each release.

Create the non-login service user once (`useradd --system --home-dir /var/lib/stageflow-control --shell /usr/sbin/nologin stageflow` if absent). Install a dedicated 12 GiB filesystem at `/srv/stageflow`, with `nodev,nosuid,noexec` and a persistent mount. A separately provisioned LV/project quota is preferred. If using a preallocated loopback ext4 image, create it only when the image and mount do not already exist, verify at least 24 GiB free on its backing filesystem, preallocate 12 GiB, format that **new file only**, and add its loop mount to fstab. Do not format a block device or resize an existing application's filesystem. The API/infrastructure/migration units assert that `/srv/stageflow` is mounted and refuse otherwise. Verify the actual mount with `findmnt /srv/stageflow`; a directory on the root disk alone does not establish the storage ceiling. Account Docker image/log storage separately on the host.

Create `/etc/stageflow` root-owned mode 0700; `/srv/stageflow/{postgres,redis,backups}` root-owned mode 0700; `/srv/stageflow/media` owned by `stageflow:stageflow`, mode 0700. Docker initializes the dedicated database directories' ownership. Create `media/broadcasts` as stageflow before the first offline backup. Do not expose any of `/srv/stageflow` through nginx.

Copy `stageflow.env.example` to `/etc/stageflow/stageflow.env` and `infrastructure.env.example` to `/etc/stageflow/infrastructure.env`, mode 0600. Generate **separate** 32-byte hex JWT, database and Redis secrets (`openssl rand -hex 32`); replace every `CHANGE_ME`. Hex avoids shell/systemd/URL escaping ambiguity. Match the database secret in both files. Copy `redis.conf.example` to `/etc/stageflow/redis.conf`, replace its secret to match REDIS_URL, and set it mode 0444 inside the protected 0700 parent (the read-only container mount must be readable by Redis). Never print `docker compose config` without `-q`, put credentials in command arguments/history, or commit these installed files. Keep encrypted copies of secrets separately from the data snapshot.

Set the exact real HTTPS `CORS_ORIGIN`; API bind is `127.0.0.1:4100`, PostgreSQL `127.0.0.1:5542`, Redis `127.0.0.1:6381`, and `TRUSTED_PROXIES=127.0.0.1`. Check for port collisions first. Preserve other applications' database and Redis namespaces/credentials. If these ports conflict, change all matching unit/env/proxy/Compose references and repeat the drills. Keep Google unset pending real-provider acceptance. Keep `DATA_ROOT=/srv/stageflow/media` outside the replaceable release.

Copy `compose.yml` to `/etc/stageflow/compose.yml`; install the `stageflow*.service` and `stageflow*.timer` files into `/etc/systemd/system` as root mode 0644. Point `/opt/stageflow/current` to the new release while the API is stopped. Validate before starting:

```sh
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/stageflow*.service /etc/systemd/system/stageflow*.timer
sudo docker compose -p stageflow --env-file /etc/stageflow/infrastructure.env -f /etc/stageflow/compose.yml config -q
sudo docker compose -p stageflow --env-file /etc/stageflow/infrastructure.env -f /etc/stageflow/compose.yml pull
sudo systemctl start stageflow-infra
```

Redis is durable here to preserve fencing across restarts. An unauthenticated PING must return NOAUTH; the API readiness check proves authenticated usability. A full keyspace fails writes instead of evicting live authority. PostgreSQL and Redis are dedicated to StageFlow, bound to loopback, and are never published publicly. Keep host/cloud firewall access to SSH from operator addresses and existing authorized ingress ports; this profile does not rewrite a shared firewall. A remote port scan must confirm 4100/5542/6381 are closed.

## TLS and shared nginx

Use a real domain whose DNS resolves to this host. Render `__DOMAIN__` in `nginx-acme.conf` into a new `/etc/nginx/conf.d/stageflow-acme.conf`; create `/var/lib/letsencrypt` and the dedicated log directory `/var/log/stageflow-nginx` (root:adm, 0750). Validate `nginx -t` before reloading the **existing** nginx. Obtain a certificate with `certbot certonly --webroot -w /var/lib/letsencrypt -d YOUR_DOMAIN` and the operator's renewal contact. This is a real public action and is not performed by local verification.

Then install `nginx-proxy.conf` as `/etc/nginx/snippets/stageflow-proxy.conf`, and `nginx-allowlist.conf` as `/etc/nginx/snippets/stageflow-allowlist.conf`. Render `nginx.conf` into `/etc/nginx/conf.d/stageflow.conf`, replacing `__DOMAIN__` with the same hostname and checking the actual certificate paths. Remove **only** the temporary StageFlow ACME config. The permanent HTTP server retains the ACME webroot. Do not duplicate a domain already owned by another site or overwrite nginx.conf/default sites. Run `nginx -t`, inspect `nginx -T` locally for server-name collisions, and reload only after validation.

The config provides HTTPS/WSS upgrade, SPA fallback, immutable hashed assets, CSP/framing/referrer/HSTS headers, no public media mapping, and no API/HLS caching. It overwrites forwarding headers so untrusted client chains are not trusted. Both API and nginx enforce origins. OAuth callback access/error logging is disabled because nginx errors can include query strings; other access logs omit query/body/auth/cookie data. Keep upstream application logging free of credentials too. Check 32 active-request limits against the real trial: this bounds active transport requests, not unique users or idle browser sessions.

Install `nginx-logrotate.conf` as `/etc/logrotate.d/stageflow`, root mode 0644. Its dedicated log directory avoids overlap with the distribution?s `/var/log/nginx/*.log` rotation. Start/enable `stageflow-logrotate.timer` after validating its service; it checks size every five minutes with a protected separate state file. Size thresholds are checked periodically, so monitor burst growth too. Run `logrotate --debug /etc/logrotate.d/stageflow`; monitor total log usage, including journald and Docker. Install `journald-stageflow.conf` as `/etc/systemd/journald@stageflow.conf.d/limits.conf`, creating that directory first. The API/infrastructure/migration/health/alert/logrotate units use their own `stageflow` journal namespace (128 MiB persistent/32 MiB runtime, seven days); this preserves the other apps? journal policy. Read it with `journalctl --namespace=stageflow`. API journal rate limits and each dedicated container's 3 × 5 MiB local log rotation are already supplied. Ensure a certificate-renewal timer is enabled. Install `renew-hook.sh` under `/etc/letsencrypt/renewal-hooks/deploy/stageflow`, mode 0755; run `certbot renew --dry-run` and verify nginx reload plus an alert on failure before launch. Do not enable global HSTS includeSubDomains/preload for domains belonging to other apps.

## Serialized migration and activation

Hold `/run/lock/stageflow-release.lock` with `flock` throughout the operator release/rollback procedure; only one operator/release job may run. Stop the health timer during planned downtime. Stop the API **before** changing `current`, migrating or taking a backup. `stageflow-migrate` also conflicts with the API and takes its own migration lock. It is a separate explicit job, never an automatic schema change on API boot:

```sh
sudo systemctl stop stageflow-health.timer stageflow.service
# Take the offline snapshot below before changing a previously used catalog.
# Atomically point current to the staged release, then:
sudo systemctl start stageflow-migrate.service
sudo systemctl start stageflow-migrate.service  # repeat must report no pending migrations
sudo systemctl reset-failed stageflow.service
sudo systemctl start stageflow.service
curl --fail http://127.0.0.1:4100/api/health
curl --fail http://127.0.0.1:4100/api/health/live
sudo systemctl start stageflow-health.timer
```

Only after successful acceptance enable `stageflow-infra.service`, `stageflow.service` and `stageflow-health.timer` and `stageflow-logrotate.timer` for boot. The native unit runs Node directly as a non-root user, sends SIGTERM to Node for graceful app/encoder shutdown, and kills the remaining cgroup after 45 seconds. Three failures in five minutes stop repeated restarts; inspect the failure before resetting it. See [systemd stop semantics](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html) and [resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html). Validate cgroup limits and process-tree cleanup on the actual VPS; a syntax check alone is insufficient.

Startup fails in-flight recordings and resets ephemeral memberships; it never resumes a live room. READY media remains private and playable subject to authorization. A release must not revert applied migrations automatically. Prefer a tested forward fix. If an older binary is incompatible, stop the service, restore the pre-upgrade database/media snapshot with its matching release and secrets, then verify playback. Record the explicit rollback/compatibility decision for each future schema migration.

## Fenced owner recovery

A crash/Redis failure can leave `<LIVE_NAMESPACE>:owner` deliberately non-expiring. Restarting cannot take it over. Never use FLUSHDB, delete a prefix, remove a guard merely because its PID/age looks old, or put recovery in ExecStartPre/a timer. Redis AOF is not a guarantee against lost last-second writes; a Redis restore/failover must fence the API first too.

1. Stop the API and health timer, stop any alternate/manual API or deployment job, and fence the old machine if the server was restored/cloned. Confirm the previous writer and its FFmpeg processes are dead. `systemctl stop` cancels pending restart attempts; external supervisors must also be stopped.
2. Verify `systemctl show stageflow -p ActiveState -p MainPID -p ControlGroup -p Job`: inactive/failed, PID 0, no job, empty/deleted cgroup. Check the old owner process and any other writer independently; an empty service cgroup cannot prove that an externally launched process or cloned VM is dead.
3. Using a protected local console, read the **exact current token** with `REDISCLI_AUTH` supplied from the protected environment, not `redis-cli -a` or a credential URL in argv. Do not log credentials. Hold the release lock and run:

```sh
sudo flock -n /run/lock/stageflow-release.lock \
  /opt/stageflow/node/bin/node --env-file=/etc/stageflow/stageflow.env \
  /opt/stageflow/current/deploy/ops.mjs recover-guard --fenced 'OBSERVED_PID:OBSERVED_UUID'
```

The helper requires local root, explicit fencing acknowledgement, stopped/no-job/no-process service state, an empty cgroup, and exact atomic compare-delete. A changed/missing guard refuses without touching room keys. The operator, not the script, establishes fencing of writers outside this service. If it refuses, investigate; do not bypass its checks. Reset failed state, start **one** API, and confirm both health endpoints, a new guard, expected presence reset, failed in-flight attempts and retained READY playback. Document incident cause and lost live-session scope.

## Offline backup and restore

The provisional recovery objectives are **RPO ≤24 hours**, plus a snapshot before each release, and **RTO ≤30 minutes after fencing**. They remain targets until an off-host restore on the actual VPS is timed. Back up after important recordings if a day's loss is unacceptable. Keep one local complete snapshot awaiting encrypted export, seven daily/four weekly snapshots off-host under an operator retention policy, and the required protected secrets/release manifest separately. Do not let backup retention consume the 12 GiB data allocation. No script here recursively prunes data.

Stop the writer/health timer and hold no other release lock while invoking the helper (the helper acquires it). Run `sudo sh /opt/stageflow/current/deploy/backup.sh`. It refuses a live/pending writer, dumps the dedicated catalog with its matching PostgreSQL client, archives only private `broadcasts`, and hashes catalog/media/release information. A partial snapshot without a complete SHA256SUMS is not a backup. Encrypt and copy the complete directory off-host with the existing authorized backup system; verify checksums after transfer and test restore. The helper does not send files externally. Preserve the stopped state until the backup is complete, then start one API and health timer.

Restore first in a **disposable environment**. For an actual recovery, stop/fence all writers and snapshot/preserve the current state separately. Stage a trusted decrypted snapshot under `/srv/stageflow/backups`, validate its checksums, and select the compatible release. Prepare an empty, real `/srv/stageflow/media` owned by stageflow; preserve the prior media directory separately on adequate storage rather than deleting it. Run:

```sh
sudo sh /opt/stageflow/current/deploy/restore.sh --confirm-offline-restore \
  /srv/stageflow/backups/SNAPSHOT_DIRECTORY
```

This replaces the dedicated StageFlow catalog transactionally and restores media; it refuses nonempty media, traversal paths and archive links. It never starts the API automatically. Do not restore Redis live state; fence any old guard explicitly, then start one writer. Log in as the restored registered owner, play/decode a READY HOST replay through the authenticated API, verify another account is denied, and verify LINK behavior separately. Test a pre-V3 upgrade fixture under C13 too. Database-only restore or a raw file listing is insufficient evidence.

## Monitoring, TURN and release drills

`stageflow-health.timer` runs both HTTP dependency checks, disk free-space checks and status-only broadcast counts. Failed units invoke `stageflow-alert@.service`, which writes a local daemon.alert entry in the `stageflow` journal namespace. **Connect that tag/unit failures to the existing external alert system before exposure**; no remote alert destination is configured here. Test failure and recovery delivery. Monitor dependency outages, restarts/start limits/OOM, cgroup CPU/RSS/tasks, certificate expiry, free space/Docker/log growth, HTTP 429/503 and latency/egress, password/admission rejections, active encoders, failed/in-flight/DELETING counts and prolonged deletion claims. Q&A queues/event-loop delay need application/load instrumentation during acceptance; the health endpoint does not expose those metrics.

Before widening the allowlist, record a real mixed-load run on the **shared target with its other apps running**: allowed recording/uploads, password work, HTTP/HLS readers, sockets/chat/Q&A. Capture p95 request/socket latency, event-loop delay, FFmpeg CPU/RSS, cgroup process counts, disk growth/free space and site/TURN egress. Exercise encoder over-capacity and disk refusal in disposable data, Redis loss, SIGTERM and SIGKILL, guard refusal/recovery, certificate renewal failure, health/disk alerts and off-host restore. Stop the trial if it harms other apps. Establish the actual supported audience from these observations; the unit budgets and sequential fixture probes cannot establish it.

TURN remains unset until configured for an invited remote trial. Use short-lived trial credentials (rotate after each session) or a provider/source-IP restriction and finite relay allocation/bandwidth quotas; the current API uses configured credentials and does not implement automatic REST credential issuance. Do not expose permanent unrestricted relay credentials to public guests. Record provider/expiry/quotas, test two real remote networks with relay-only browser RTC policy, verify an actual selected relay candidate and bidirectional audible/video output, then test invalid/expired credentials and exhausted relay budget. Public TLS/WSS, real TURN, supported browsers and physical device/native-picker observations are target acceptance gates, not closed by a local Socket.IO connection.

## Local Linux fixture

`fixture.Dockerfile` builds an **isolated test host**, not a production image. It runs Ubuntu 26.04 systemd and nested Docker (vfs inside the fixture to avoid nested overlay limitations). It needs privileged Docker locally, no host Docker socket, and only loopback-published test TLS/HTTP ports. Provision the private 12 GiB test filesystem before starting the units; a sparse ext4 loop image is sufficient inside this disposable fixture, while the actual host must reserve the backing space. Never mount production/developer data or a host cgroup root into it. Build a clean Linux production release in a separate builder, transfer its compiled output/runtime dependencies, and install this profile inside the disposable host. Generate fixture-only secrets and a self-signed `stageflow.test` certificate, map that hostname to loopback, and trust that certificate only for the fixture process.

After provisioning those owned resources, create `/etc/stageflow/fixture-only` containing exactly `sf-c12-disposable` (no newline). Do **not** create this marker on a real host. Copy the current profile into the fixture release and run, from `/opt/stageflow/current`:

```sh
NODE_EXTRA_CA_CERTS=/etc/letsencrypt/live/stageflow.test/fullchain.pem \
  /opt/stageflow/node/bin/node --env-file=/etc/stageflow/stageflow.env deploy/drill.mjs
```

The guarded drill exercises real systemd/Compose/nginx, TLS/WSS/Q&A/encoding, graceful child cleanup, crash fencing, offline backup/restore and HOST replay authorization. It intentionally changes only that fixture's catalog/media/unit state; it preserves an old media directory for comparison. Remove the entire owned fixture containers/networks/volumes after collecting evidence. Run the root release/audit gates as well. Record unsupported host observations rather than describing fixture results as VPS acceptance.
