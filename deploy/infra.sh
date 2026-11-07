#!/bin/sh
# Start or stop StageFlow's own dependencies. External mode never controls shared containers.
set -eu
action=${1:?Use start or stop}
dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
node=/opt/stageflow/node/bin/node
test -x "$node" || node=node
mode=$("$node" "$dir/external.mjs" mode) || exit $?
# external-services-begin
if [ "$mode" = external ]; then
  if [ "$action" = stop ]; then
    echo 'External mode: leaving shared-postgres and stageflow-redis untouched.'
    exit 0
  fi
  if [ "$action" != start ]; then
    echo 'Use start or stop.' >&2
    exit 1
  fi
  "$node" "$dir/external.mjs" probe
  exit $?
fi
# external-services-end
if [ "$mode" != dedicated ]; then
  echo 'Refusing unknown deployment mode.' >&2
  exit 1
fi
if [ "$action" = start ]; then
  exec docker compose --project-name stageflow --env-file /etc/stageflow/infrastructure.env \
    -f /etc/stageflow/compose.yml up -d --wait --wait-timeout 90
fi
if [ "$action" = stop ]; then
  exec docker compose --project-name stageflow --env-file /etc/stageflow/infrastructure.env \
    -f /etc/stageflow/compose.yml stop --timeout 45
fi
echo 'Use start or stop.' >&2
exit 1
