# Local disposable Ubuntu/systemd validation host, never the production artifact.
FROM node:22-bookworm-slim AS node
FROM ubuntu:26.04
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update && apt-get install -y --no-install-recommends \
    systemd systemd-sysv nginx openssl curl ca-certificates ffmpeg python3 \
    procps util-linux e2fsprogs logrotate postgresql-client redis-tools docker.io docker-compose-v2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /opt/stageflow/node/bin/node
# Nested Docker uses vfs; production Docker keeps its normal host storage driver.
RUN mkdir -p /etc/docker && printf '%s\n' '{"storage-driver":"vfs","features":{"containerd-snapshotter":false}}' > /etc/docker/daemon.json
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
