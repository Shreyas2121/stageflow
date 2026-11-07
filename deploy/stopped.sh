#!/bin/sh
# Shared by root-only offline backup/restore. The caller holds the release lock.
assert_stopped() {
    test "$(id -u)" = 0 || { echo 'Run as the local operator.' >&2; exit 1; }
    mountpoint -q /srv/stageflow || { echo 'Persistent StageFlow filesystem is not mounted.' >&2; exit 1; }
    test "$(systemctl show stageflow.service --property=LoadState --value)" = loaded
    active=$(systemctl show stageflow.service --property=ActiveState --value)
    case "$active" in inactive|failed) ;; *) echo 'Stop StageFlow first.' >&2; exit 1 ;; esac
    test "$(systemctl show stageflow.service --property=MainPID --value)" = 0
    test -z "$(systemctl show stageflow.service --property=Job --value)"
    group=$(systemctl show stageflow.service --property=ControlGroup --value)
    if test -n "$group" && test -f "/sys/fs/cgroup$group/cgroup.events"; then
        ! grep -q 'populated 1' "/sys/fs/cgroup$group/cgroup.events"
    fi
}
