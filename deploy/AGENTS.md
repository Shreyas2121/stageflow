# Deployment profile

GitHub Actions release ownership is documented in [CICD.md](CICD.md).
`ci-deploy.py` is a root-owned forced SSH receiver; its safeguard tests are
`test_ci_deploy.py`. Keep root deployment logic outside uploaded artifacts and
preserve the shared release lock and fail-stopped migration behavior.

This directory owns the Ubuntu 26.04 LTS single-writer profile for the shared Hostinger KVM 2. Read [README.md](README.md) before changing units, ingress, recovery, or backup commands. The isolated fixture still starts dedicated PostgreSQL and Redis from [compose.yml](compose.yml). A real host that already runs `shared-postgres` and `stageflow-redis` installs the external-services marker and must not let StageFlow start, stop, or restore those containers. Operational verification history belongs in the maintenance records in `plans/phase5.md`, `plans/phase6.md`, and their guides.

Keep API/Redis/PostgreSQL private, preserve existing applications and nginx sites, and never make owner-guard removal automatic. Recovery requires operator fencing, an empty stopped service cgroup, and an exact compare-delete. Restores require a stopped writer and empty media destination. Local fixtures must use unique Docker names/networks/volumes and loopback-only published ports. Never run these drills against developer or production state. No public deployment or launch acceptance follows from a local drill.

Run `node --test scripts/deploy.test.mjs`, Node/shell syntax checks, `nginx -t`, Compose validation, and `systemd-analyze verify` against the named OS. Exercise the units, TLS/Socket.IO, stop/crash fencing, backup/restore, and health alerts in an isolated Linux fixture. Follow root affected-check selection for remaining gates; record unsupported target observations honestly.
