#!/bin/sh
set -eu
umask 077
exec 9>/run/lock/stageflow-release.lock
flock -n 9
. "$(dirname "$0")/stopped.sh"
assert_stopped
test "${1:-}" = --confirm-offline-restore || { echo 'Pass --confirm-offline-restore and the snapshot directory.' >&2; exit 1; }
snapshot=$(realpath -e "${2:?Supply a snapshot directory}")
case "$snapshot" in /srv/stageflow/backups/*) ;; *) echo 'Use a protected StageFlow snapshot directory.' >&2; exit 1 ;; esac
test -d /srv/stageflow/media
test ! -L /srv/stageflow/media
test -z "$(find /srv/stageflow/media -mindepth 1 -maxdepth 1 -print -quit)" || { echo 'Media destination must be empty; preserve the old copy separately.' >&2; exit 1; }
(cd "$snapshot" && sha256sum --check SHA256SUMS)
# Backups contain only ordinary files/directories below broadcasts, never links.
tar -tf "$snapshot/media.tar" | awk '
    /^\// || /(^|\/)\.\.(\/|$)/ || $0 !~ /^broadcasts(\/|$)/ { bad=1 }
    END { exit bad }
'
tar -tvf "$snapshot/media.tar" | awk 'substr($0,1,1) != "d" && substr($0,1,1) != "-" { bad=1 } END { exit bad }'
# external-services-begin
if [ -f /etc/stageflow/external-services ]; then
  node=/opt/stageflow/node/bin/node
  test -x "$node" || node=node
  "$node" "$(dirname "$0")/external.mjs" restore-catalog "$snapshot/catalog.dump"
# external-services-end
else
  docker compose --project-name stageflow --env-file /etc/stageflow/infrastructure.env \
      -f /etc/stageflow/compose.yml exec -T postgres \
      pg_restore -U stageflow -d stageflow --clean --if-exists --no-owner --exit-on-error --single-transaction < "$snapshot/catalog.dump"
fi
tar --no-same-owner --no-same-permissions -C /srv/stageflow/media -xf "$snapshot/media.tar"
chown -R stageflow:stageflow /srv/stageflow/media
echo 'Catalog/media restored. API remains stopped; verify release compatibility and ownership before starting one writer.'
