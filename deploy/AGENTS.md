# Deployment profile

This directory owns the Ubuntu 26.04 LTS single-writer profile for the shared Hostinger KVM 2. Read [README.md](README.md) before changing units, ingress, recovery, or backup commands. Operational verification history belongs in the maintenance records in `plans/phase5.md` and its guide.

Keep API/Redis/PostgreSQL private, preserve existing applications and nginx sites, and never make owner-guard removal automatic. Recovery requires operator fencing, an empty stopped service cgroup, and an exact compare-delete. Restores require a stopped writer and empty media destination. Local fixtures must use unique Docker names/networks/volumes and loopback-only published ports. Never run these drills against developer or production state. No public deployment or launch acceptance follows from a local drill.

Run `node --test scripts/deploy.test.mjs`, Node/shell syntax checks, `nginx -t`, Compose validation, and `systemd-analyze verify` against the named OS. Exercise the units, TLS/Socket.IO, stop/crash fencing, backup/restore, and health alerts in an isolated Linux fixture. Follow root affected-check selection for remaining gates; record unsupported target observations honestly.
