#!/bin/sh
set -eu
umask 077
exec 9>/run/lock/stageflow-release.lock
flock -n 9
. "$(dirname "$0")/stopped.sh"
assert_stopped
test -d /srv/stageflow/media/broadcasts
test -d /srv/stageflow/backups
destination=$(mktemp -d "/srv/stageflow/backups/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
# external-services-begin
if [ -f /etc/stageflow/external-services ]; then
  node=/opt/stageflow/node/bin/node
  test -x "$node" || node=node
  "$node" "$(dirname "$0")/external.mjs" dump-catalog "$destination/catalog.dump" || {
    rm -rf "$destination"
    exit 1
  }
# external-services-end
else
  docker compose --project-name stageflow --env-file /etc/stageflow/infrastructure.env \
      -f /etc/stageflow/compose.yml exec -T postgres \
      pg_dump -U stageflow -d stageflow --format=custom > "$destination/catalog.dump"
fi
tar -C /srv/stageflow/media -cf "$destination/media.tar" broadcasts
readlink -f /opt/stageflow/current > "$destination/release.txt"
(cd "$destination" && sha256sum catalog.dump media.tar release.txt > SHA256SUMS)
echo "Offline snapshot complete: $destination. Encrypt/copy off-host and verify restore before pruning manually."
