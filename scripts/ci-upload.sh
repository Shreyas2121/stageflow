#!/bin/bash
set -euo pipefail
umask 077
[[ ${GITHUB_SHA:?} =~ ^[0-9a-f]{40}$ ]]
[[ ${DEPLOY_HOST:?} =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]
[[ ${DEPLOY_PORT:?} =~ ^[0-9]{1,5}$ ]]
directory=${1:?artifact directory required}
file=stageflow-$GITHUB_SHA.tar.gz
(cd "$directory" && sha256sum --check "$file.sha256")
checksum=$(sha256sum "$directory/$file")
checksum=${checksum%% *}
sshdir=$(mktemp -d)
trap 'rm -rf "$sshdir"' EXIT
printf '%s\n' "${DEPLOY_KEY:?}" > "$sshdir/key"
printf '%s\n' "${DEPLOY_KNOWN_HOSTS:?}" > "$sshdir/known_hosts"
chmod 600 "$sshdir/key" "$sshdir/known_hosts"
{ printf '%s %s\n' "$GITHUB_SHA" "$checksum"; cat "$directory/$file"; } |
  ssh -T -F /dev/null -i "$sshdir/key" -p "$DEPLOY_PORT" \
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$sshdir/known_hosts" -o ConnectTimeout=15 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    "stageflow-deploy@$DEPLOY_HOST"
