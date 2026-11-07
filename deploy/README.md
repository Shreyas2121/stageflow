# StageFlow on the shared Hostinger KVM 2

For GitHub Actions builds, restricted SSH deployment, bootstrap and recovery, see
[the CI/CD runbook](CICD.md). Production deployment remains disabled until setup
and a separately authorized manual dispatch.
On CI-managed hosts, use the operator-installed
`/usr/local/lib/stageflow-ops/{backup,restore}.sh` for root backup/restore commands
below, and install the mandatory infrastructure drop-in from that runbook. Root
helpers stay outside the uploaded release.

For a beginner-friendly visual explanation, open [explained.html](explained.html) in a browser. It includes clickable request journeys, a release simulation, storage and recovery explanations, and a glossary; it works offline.

This profile targets **Ubuntu Server 26.04 LTS, x86-64**, selected for V3M-C12. The VPS is shared with other applications. It runs one native Node API writer and a site in the existing nginx. No cluster, second API, automatic guard takeover, or public media directory is supported. These files do not authorize deployment or an unrestricted launch.

Two dependency modes exist. The isolated Linux fixture still starts **dedicated** PostgreSQL 16.15 and Redis 7.4.12 from [compose.yml](compose.yml). The real Hostinger host already runs `shared-postgres` (`127.0.0.1:5432`) and `stageflow-redis` (`127.0.0.1:6381`). That host uses **external** mode and must not start the Compose project. External mode never stops, restarts, deletes, or recreates those containers, and it never dumps or restores any database except `stageflow_db`.

The public site name is `stage.shreyasrasaikar.cloud`. Leave `shreyasrasaikar.cloud` and its DNS alone. Local fixture evidence is in [the Phase 5 maintenance record](../plans/phase5.md). Phase 6 records which target, browser, and physical checks are still open. Adapting this profile does not close them.

Ubuntu 26.04 is the selected LTS; Ubuntu 26.10 has a much shorter support window. See [Ubuntu's release cycle](https://ubuntu.com/about/release-cycle). Keep an existing shared 24.04 server until a separately planned OS upgrade. Never reimage it to apply this profile.

## Allocation and restricted trial

These are conservative **resource ceilings to validate**, not measured capacity. The KVM 2's published 2 vCPU/8 GB/100 GB/8 TB belong to the whole VPS. Confirm `nproc`, `free -h`, `lsblk -f`, `df -h`, architecture and cgroup v2 on the actual host, then reconcile all apps' reservations before installing anything. Stop if these reservations do not fit.

| Owner                           | CPU ceiling           | RAM / tasks                                            | Storage / work budget                                                                                                                            |
| ------------------------------- | --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| API plus FFmpeg                 | 75% of one core       | 1536 MiB hard, 1280 MiB high, no swap; 96 tasks        | One encoder, one encoder thread, 15 minutes/256 MiB per recording; retained media 1 GiB; 2 GiB free-space floor                                  |
| Dedicated PostgreSQL            | 25% of one core       | 768 MiB, no swap; 128 tasks                            | 30 connections; 128 MiB shared buffers; dedicated catalog                                                                                        |
| Dedicated Redis                 | 10% of one core       | 256 MiB container, 160 MiB keyspace, no swap; 32 tasks | AOF; `noeviction` preserves the owner guard                                                                                                      |
| Health / explicit migration job | 10% / 25% of one core | 128 / 512 MiB                                          | Health every minute; migration runs with API stopped                                                                                             |
| Persistent StageFlow data       | Separate filesystem   | Existing apps keep their own filesystems               | Fixture: 12 GiB for PostgreSQL, Redis, media, and one snapshot. VPS external mode: 8 GiB for media and one snapshot only. Alert below 2 GiB free |
| Ingress / logs                  | Existing shared nginx | 32 active requests for this virtual host               | API responses limited to 512 KiB/s per response; upload 2 MiB; access/error log sizes checked every five minutes, rotated at 10 MiB, 7 copies    |

API/FFmpeg + a dedicated database + Redis reserve at most 1.1 cores and 2.5 GiB, plus the health job and shared ingress. That sum is the **fixture** budget, where StageFlow owns both containers. On the current VPS those containers already exist, so do not add the table's 768 MiB PostgreSQL or a second Redis. The extra StageFlow cost is the API/FFmpeg ceiling (0.75 core, 1536 MiB) and a short health check. The shared server already uses about 0.65 core and 1024 MiB; Redis already uses 0.10 core and 256 MiB. Together with the API that is about 1.5 cores and 2.8 GiB of ceilings inside 2 vCPU and 7.7 GiB, before the operating system, Nginx, and Beszel. Migration and backup run while the API is stopped. Leave every other application's units, Docker daemon, database settings, ports, firewall, and nginx defaults unchanged.

### Why the media disk is 8 GiB here and 12 GiB in the fixture

The original 12 GiB filesystem was one ceiling for PostgreSQL, Redis, media, and a local backup. External mode does not move those Docker volumes. The mount only has to hold private media and one local backup:

| Piece                                 | Budget                                |
| ------------------------------------- | ------------------------------------- |
| Retained media (`STORAGE_MAX_BYTES`)  | 1 GiB                                 |
| One local catalog+media snapshot      | about 1 GiB                           |
| Free-space floor (`MIN_FREE_BYTES`)   | 2 GiB                                 |
| One recording (`RECORDING_MAX_BYTES`) | 256 MiB, already inside the media cap |
| Mount size                            | 8 GiB                                 |

1 + 1 + 2 GiB fits in 8 GiB and leaves room for a second snapshot before you delete one by hand. Nothing in this profile prunes backups automatically. Do not store a week of copies on this mount; copy them off the server. The fixture keeps a 12 GiB mount because its dedicated database and Redis still live on it. Recording limits, the one-encoder cap, and the 2 GiB free-space floor are the same in both modes. An 8 GiB file mounted at `/srv/stageflow` still satisfies the "this path must be a mount" check. A plain directory does not. Create that file only when the root filesystem has at least 20 GiB free. Format the new file only. Do not partition or format the VPS disk.

Empty `/srv/stageflow/postgres` and `/srv/stageflow/redis` directories may exist so the API sandbox has a path to hide. They stay empty. The real data remains in the existing Docker volumes.

The shipped allowlist admits only loopback. The first externally reachable trial must be operator-controlled and IP-allowlisted: one room, up to four stage users and two viewers, one recording, and Google disabled. This is a test restriction, **not a supported six-user capacity promise**. Keep a StageFlow egress allocation of 5 GiB/day and 100 GiB/month, with alerts at 80% and an operator stop at the budget. Collect the site's `$body_bytes_sent` access-log field into the existing monitoring system; per-response rate limiting is not an aggregate or monthly traffic quota. Include WebRTC/TURN traffic separately. Do not remove the allowlist until target workload, egress and alert gates below are satisfied.

## Prepare the host and release

Run provisioning only during an authorized maintenance window after backing up the other apps and recording free resources. Use the existing Docker/nginx installations when present. On a clean Ubuntu 26.04 host, install `nginx certbot docker.io docker-compose-v2 ffmpeg curl openssl logrotate` with apt; do not replace an already managed Docker installation with another distribution. Check `docker compose version`, `systemctl --version`, and `stat -fc %T /sys/fs/cgroup` (`cgroup2fs`). Keep Docker access root-only/trusted operators: access to its socket is equivalent to root.

Install the supported Node 22 binary under `/opt/stageflow/node` (fixture tested 22.23.4), after verifying its release SHA-256 from [Node's official distribution](https://nodejs.org/dist/). Use pnpm 12.9.1 from the root manifest on the build host. Use the correct Linux architecture; do not copy Windows node_modules. Keep the Node install root-owned, execute-only for the service, and apply supported security updates through a tested release.

Build a frozen Linux release with the actual public URLs following [the root production build instructions](../README.md). Run `pnpm build:production` and the release/audit gates. Install production dependencies with `pnpm install --prod --frozen-lockfile --ignore-scripts`. Preserve workspace links, package manifests, lockfile, compiled shared/API/web output, and this `deploy` directory. Copy into a **new**, root-owned `/opt/stageflow/releases/<commit>` directory. It must contain no `.env`, secrets or media. Make the static web output traversable/readable by `www-data`, and the runtime readable by `stageflow`. Never grant the API write access to releases or nginx certificates. Record the source commit, Node/pnpm/FFmpeg versions and image digests with each release.

Create the non-login service user once (`useradd --system --home-dir /var/lib/stageflow-control --shell /usr/sbin/nologin stageflow` if absent). Install a dedicated 12 GiB filesystem at `/srv/stageflow`, with `nodev,nosuid,noexec` and a persistent mount. A separately provisioned LV/project quota is preferred. If using a preallocated loopback ext4 image, create it only when the image and mount do not already exist, verify at least 24 GiB free on its backing filesystem, preallocate 12 GiB, format that **new file only**, and add its loop mount to fstab. Do not format a block device or resize an existing application's filesystem. The API/infrastructure/migration units assert that `/srv/stageflow` is mounted and refuse otherwise. Verify the actual mount with `findmnt /srv/stageflow`; a directory on the root disk alone does not establish the storage ceiling. Account Docker image/log storage separately on the host.

Create `/etc/stageflow` root-owned mode 0700; `/srv/stageflow/{postgres,redis,backups}` root-owned mode 0700; `/srv/stageflow/media` owned by `stageflow:stageflow`, mode 0700. In the fixture, Docker initializes the dedicated database directories. In external mode those two directories stay empty and root-owned. Create `media/broadcasts` as stageflow before the first offline backup. Do not expose any of `/srv/stageflow` through nginx.

On the fixture, copy `stageflow.env.example` to `/etc/stageflow/stageflow.env` and `infrastructure.env.example` to `/etc/stageflow/infrastructure.env`, mode 0600. Generate **separate** 32-byte hex JWT, database, and Redis secrets (`openssl rand -hex 32`); replace every `CHANGE_ME`. Hex avoids shell/systemd/URL escaping ambiguity. Match the database secret in both files. Copy `redis.conf.example` to `/etc/stageflow/redis.conf`, replace its secret to match `REDIS_URL`, and set it mode 0444 inside the protected 0700 parent (the read-only container mount must be readable by Redis).

On the real VPS, copy `stageflow.external.env.example` instead, and do not install a second Redis config. Generate a new JWT and a new `stageflow_app` database password. Copy the Redis password that `stageflow-redis` already uses; a new Redis password will not log in, and changing Redis is outside this install. Set `DATABASE_POOL_MAX=4`. The URL is `postgresql://stageflow_app:SECRET@127.0.0.1:5432/stageflow_db` and Redis stays `127.0.0.1:6381`. Create the external marker from `external-services.example` at `/etc/stageflow/external-services`, mode 0600, with no extra words. Do not create `/etc/stageflow/fixture-only` on the VPS. Do not create the external marker in the fixture. If both files exist, startup refuses and Compose does not run.

Never print `docker compose config` without `-q`, put credentials in command arguments or history, or commit these installed files. Keep encrypted copies of secrets separately from the data snapshot.

Set `CORS_ORIGIN=https://stage.shreyasrasaikar.cloud` (the fixture uses its own test name). API bind is `127.0.0.1:4100` and `TRUSTED_PROXIES=127.0.0.1`. The fixture database is `127.0.0.1:5542/stageflow`. The VPS database is `127.0.0.1:5432/stageflow_db`. Keep Google unset pending real-provider acceptance. Keep `DATA_ROOT=/srv/stageflow/media` outside the replaceable release.

The database role is `stageflow_app`: login, not a superuser, and not allowed to create databases or roles. It owns only `stageflow_db`. Create that role and database in a separately approved step. Do not restart `shared-postgres` to do it, and do not revoke privileges on databases you did not create. A non-superuser still cannot read another project's tables unless those tables were granted to everyone.

Copy `compose.yml` to `/etc/stageflow/compose.yml` for the fixture only. Installing the unit on the VPS is safe because external mode does not run Compose: it only checks that the two existing containers are up. Install the `stageflow*.service` and `stageflow*.timer` files into `/etc/systemd/system` as root mode 0644. Point `/opt/stageflow/current` to the new release while the API is stopped. Validate before starting:

```sh
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/stageflow*.service /etc/systemd/system/stageflow*.timer
sudo docker compose -p stageflow --env-file /etc/stageflow/infrastructure.env -f /etc/stageflow/compose.yml config -q
sudo docker compose -p stageflow --env-file /etc/stageflow/infrastructure.env -f /etc/stageflow/compose.yml pull
sudo systemctl start stageflow-infra
```

Redis is durable here to preserve fencing across restarts. An unauthenticated PING must return NOAUTH; the API readiness check proves authenticated usability. A full keyspace fails writes instead of evicting live authority. Do not run `FLUSHDB`, `FLUSHALL`, or delete a key prefix. In the fixture, PostgreSQL and Redis belong to the Compose project and are bound to loopback. On the VPS, `shared-postgres` and `stageflow-redis` already are, and StageFlow must not publish or replace them. Keep host/cloud firewall access to SSH from operator addresses and existing authorized ingress ports; this profile does not rewrite a shared firewall. A remote port scan must confirm 4100, 5432, and 6381 are closed. The fixture also keeps 5542 closed.

## TLS and shared nginx

The fixture renders a new site from `nginx.conf`. The VPS already has HTTPS for `stage.shreyasrasaikar.cloud`, so do not install that file as a second server and do not run `nginx-acme.conf` or Certbot for a name that already has a certificate. Back up the existing site file first. Copy the `map`, `limit_conn_zone`, `limit_req_zone`, and `log_format` lines into the `http` context once, if they are not already there. Copy the `location` blocks, the allowlist include, and the security headers into the **existing** `server` for that hostname. Keep its current `ssl_certificate` lines. `map` directives are invalid inside `server`. Two `server_name` entries for one hostname make Nginx pick one of them.

For a host that does not yet have the name, render `__DOMAIN__` in `nginx-acme.conf` into a new `/etc/nginx/conf.d/stageflow-acme.conf`; create `/var/lib/letsencrypt` and the dedicated log directory `/var/log/stageflow-nginx` (root:adm, 0750). Validate `nginx -t` before reloading the **existing** nginx. Obtain a certificate with `certbot certonly --webroot -w /var/lib/letsencrypt -d YOUR_DOMAIN` and the operator's renewal contact. This is a real public action and is not performed by local verification. Then install the full `nginx.conf` as described below and remove **only** the temporary StageFlow ACME file.

Install `nginx-proxy.conf` as `/etc/nginx/snippets/stageflow-proxy.conf`, and `nginx-allowlist.conf` as `/etc/nginx/snippets/stageflow-allowlist.conf`. The fixture renders `nginx.conf` into `/etc/nginx/conf.d/stageflow.conf`, replacing `__DOMAIN__` and checking the certificate paths. The permanent HTTP server retains the ACME webroot when StageFlow created the certificate. Do not duplicate a domain already owned by another site or overwrite nginx.conf/default sites. Run `nginx -t`, inspect `nginx -T` locally for server-name collisions, and reload only after validation. HSTS on this hostname does not include subdomains, so it does not force HTTPS onto the portfolio apex.

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

The provisional recovery objectives are **RPO ≤24 hours**, plus a snapshot before each release, and **RTO ≤30 minutes after fencing**. They remain targets until an off-host restore on the actual VPS is timed. Back up after important recordings if a day's loss is unacceptable. Keep one local complete snapshot awaiting encrypted export, seven daily and four weekly snapshots off-host under an operator retention policy, and the required protected secrets and release manifest separately. Do not let backup retention consume the media filesystem (12 GiB in the fixture, 8 GiB in external mode). No script here recursively prunes data.

Stop the writer and health timer and hold no other release lock while invoking the helper (the helper acquires it). Run `sudo sh /opt/stageflow/current/deploy/backup.sh`. It refuses a live or pending writer, archives only private `broadcasts`, and hashes catalog, media, and release information. In the fixture it dumps the Compose database `stageflow`. In external mode it dumps only `stageflow_db` as `stageflow_app` inside `shared-postgres`, after a read-only check that the session is that database and the role is not a superuser. A wrong `DATABASE_URL` refuses the backup; it does not redirect the dump. The script has no `pg_dumpall`, `DROP DATABASE`, or `docker stop`. A partial snapshot without a complete SHA256SUMS is not a backup. Encrypt and copy the complete directory off-host. The whole-cluster backup already configured for every database is a separate safety net: restoring it rolls every project back together, so it is not how you undo a StageFlow release. The helper does not send files externally. Preserve the stopped state until the backup is complete, then start one API and the health timer. Off-server storage was not confirmed when this profile was adapted. Do not keep a recording you cannot recreate until a copy has been restored somewhere else.

Restore first in a **disposable environment**. For an actual recovery, stop/fence all writers and snapshot/preserve the current state separately. Stage a trusted decrypted snapshot under `/srv/stageflow/backups`, validate its checksums, and select the compatible release. Prepare an empty, real `/srv/stageflow/media` owned by stageflow; preserve the prior media directory separately on adequate storage rather than deleting it. Run:

```sh
sudo sh /opt/stageflow/current/deploy/restore.sh --confirm-offline-restore \
  /srv/stageflow/backups/SNAPSHOT_DIRECTORY
```

This replaces the StageFlow catalog transactionally and restores media. External mode restores only `stageflow_db` and refuses a superuser session. It refuses nonempty media, traversal paths, and archive links. It never starts the API automatically. `systemctl stop stageflow-infra` in external mode does not stop `shared-postgres` or `stageflow-redis`. Do not restore Redis live state; fence any old guard explicitly, then start one writer. Log in as the restored registered owner, play/decode a READY HOST replay through the authenticated API, verify another account is denied, and verify LINK behavior separately. Test a pre-V3 upgrade fixture under the Phase 6 record too. Database-only restore or a raw file listing is insufficient evidence.

## Monitoring, TURN and release drills

`stageflow-health.timer` runs both HTTP dependency checks, disk free-space checks and status-only broadcast counts. Failed units invoke `stageflow-alert@.service`, which writes a local daemon.alert entry in the `stageflow` journal namespace. Beszel already graphs the host, but it does not receive this journal tag until you connect them. **Do that before anyone but you can open the site.** No remote alert destination is configured here. Test failure and recovery delivery. Monitor dependency outages, restarts/start limits/OOM, cgroup CPU/RSS/tasks, certificate expiry, free space/Docker/log growth, HTTP 429/503 and latency/egress, password/admission rejections, active encoders, failed/in-flight/DELETING counts and prolonged deletion claims. Q&A queues/event-loop delay need application/load instrumentation during acceptance; the health endpoint does not expose those metrics.

Before widening the allowlist, record a real mixed-load run on the **shared target with its other apps running**: allowed recording/uploads, password work, HTTP/HLS readers, sockets/chat/Q&A. Capture p95 request/socket latency, event-loop delay, FFmpeg CPU/RSS, cgroup process counts, disk growth/free space and site/TURN egress. Exercise encoder over-capacity and disk refusal in disposable data, Redis loss, SIGTERM and SIGKILL, guard refusal/recovery, certificate renewal failure, health/disk alerts and off-host restore. Stop the trial if it harms other apps. Establish the actual supported audience from these observations; the unit budgets and sequential fixture probes cannot establish it.

TURN remains unset until configured for an invited remote trial. Use short-lived trial credentials (rotate after each session) or a provider/source-IP restriction and finite relay allocation/bandwidth quotas; the current API uses configured credentials and does not implement automatic REST credential issuance. Do not expose permanent unrestricted relay credentials to public guests. Record provider/expiry/quotas, test two real remote networks with relay-only browser RTC policy, verify an actual selected relay candidate and bidirectional audible/video output, then test invalid/expired credentials and exhausted relay budget. Public TLS/WSS, real TURN, supported browsers and physical device/native-picker observations are target acceptance gates, not closed by a local Socket.IO connection.

## Local Linux fixture

`fixture.Dockerfile` builds an **isolated test host**, not a production image. It runs Ubuntu 26.04 systemd and nested Docker (vfs inside the fixture to avoid nested overlay limitations). It needs privileged Docker locally, no host Docker socket, and only loopback-published test TLS/HTTP ports. Provision the private 12 GiB test filesystem before starting the units; a sparse ext4 loop image is sufficient inside this disposable fixture, while the actual host must reserve the backing space. Never mount production/developer data or a host cgroup root into it. Build a clean Linux production release in a separate builder, transfer its compiled output/runtime dependencies, and install this profile inside the disposable host. Generate fixture-only secrets and a self-signed `stageflow.test` certificate, map that hostname to loopback, and trust that certificate only for the fixture process.

After provisioning those owned resources, create `/etc/stageflow/fixture-only` containing exactly `sf-c12-disposable` (no newline). Do **not** create this marker on a real host. The canonical API unit requires the external-services credential by default. In this disposable fixture only, install `stageflow-fixture.conf` as `/etc/systemd/system/stageflow.service.d/20-fixture.conf`, mode 0644, then reload systemd. This clears the external credential load, explicitly selects dedicated mode, and loads the root-only fixture marker as `fixture-only`. The unprivileged check requires that exact fixture credential; a missing production credential never selects dedicated mode. Root infrastructure checks continue using the original on-disk markers. Copy the current profile into the fixture release and run, from `/opt/stageflow/current`:

```sh
NODE_EXTRA_CA_CERTS=/etc/letsencrypt/live/stageflow.test/fullchain.pem \
  /opt/stageflow/node/bin/node --env-file=/etc/stageflow/stageflow.env deploy/drill.mjs
```

The guarded drill exercises real systemd/Compose/nginx, TLS/WSS/Q&A/encoding, graceful child cleanup, crash fencing, offline backup/restore and HOST replay authorization. It intentionally changes only that fixture's catalog/media/unit state; it preserves an old media directory for comparison. Remove the entire owned fixture containers/networks/volumes after collecting evidence. Run the root release/audit gates as well. Record unsupported host observations rather than describing fixture results as VPS acceptance. The fixture must not contain `/etc/stageflow/external-services`.

## First deployment checklist

Do this only after a separate approval to touch the VPS. Stop at the first failure. Nothing below is permission to do it now.

1. Run the read-only inventory (disk free space, Nginx site and certificate paths, Redis `appendonly` / `appendfsync` / `maxmemory-policy`, PostgreSQL connection headroom). Do not print passwords.
2. Build on Linux with Node 22 and pnpm 12.9.1. Set `VITE_API_BASE_URL=https://stage.shreyasrasaikar.cloud/api` and `VITE_WS_URL=https://stage.shreyasrasaikar.cloud`. Do not copy a Windows `node_modules`.
3. If the root disk has at least 20 GiB free, create one new 8 GiB file, format only that file, and mount it on `/srv/stageflow`. Leave the PostgreSQL and Redis directories on that mount empty.
4. When database creation is approved, create `stageflow_db` owned by non-superuser `stageflow_app`. Do not restart `shared-postgres`.
5. Install `stageflow.external.env.example` as `/etc/stageflow/stageflow.env`. New JWT and database password. Existing Redis password. `DATABASE_POOL_MAX=4`. Install the external-services marker. Do not install the fixture marker.
6. Confirm `docker ps` container IDs for `shared-postgres` and `stageflow-redis`, start `stageflow-infra`, and confirm those IDs did not change.
7. With the API stopped, run `stageflow-migrate` twice. The second run applies nothing.
8. Start one API. Both loopback health URLs succeed. An unauthenticated Redis PING returns NOAUTH. Do not flush Redis.
9. Merge Nginx locations into the existing `stage.shreyasrasaikar.cloud` server. `nginx -t`, then reload. The allowlist stays loopback until you add your own IP. The public site should be 403 until then.
10. One room, at most four people on stage, one recording, Google off, TURN off. Stop if Beszel shows the host or PostgreSQL in distress. `systemctl stop stageflow-infra` must not stop the shared containers.

Rollback before a migration is pointing `current` at the previous release. After a migration, restore the StageFlow database dump and media snapshot together. Do not restore the whole-cluster backup to undo StageFlow alone.
