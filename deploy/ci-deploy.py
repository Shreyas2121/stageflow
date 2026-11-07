#!/usr/bin/python3
"""Root-owned forced-SSH receiver. No shell, CLI options or uploaded root code."""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

BASE = Path('/opt/stageflow')
STATE = Path('/var/lib/stageflow-deploy')
LIMIT = 512 * 1024 * 1024


class DeploymentInterrupted(RuntimeError):
    pass


def run(*args):
    return subprocess.check_output(args, text=True, timeout=180).strip()


def header(stream):
    line = stream.readline(150).decode('ascii')
    if not re.fullmatch(r'[0-9a-f]{40} [0-9a-f]{64}\n', line):
        raise ValueError('Expected commit and SHA-256 header')
    return line.strip().split(' ')


def unpack(archive, destination):
    """Validate the entire archive before extraction; allow internal pnpm links."""
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        if len(members) > 100000 or sum(m.size for m in members) > 2 * 1024**3:
            raise ValueError('Expanded release exceeds limit')
        seen = set()
        links = set()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or str(path) in seen:
                raise ValueError('Unsafe or duplicate archive path')
            seen.add(str(path))
            if not (member.isdir() or member.isfile() or member.issym()):
                raise ValueError('Unsupported archive entry')
            if member.issym():
                if PurePosixPath(member.linkname).is_absolute():
                    raise ValueError('Absolute release link forbidden')
                links.add(path)
                target = (destination / str(path.parent) / member.linkname).resolve()
                if not target.is_relative_to(destination.resolve()):
                    raise ValueError('Link escapes release')
            if any(part == '.env' or part.startswith('.env.') for part in path.parts):
                raise ValueError('Environment files forbidden')
            if path.parts and path.parts[0] not in ('apps', 'deploy', 'release.json', 'pnpm-lock.yaml'):
                raise ValueError('Unexpected release root')
            name = str(path)
            allowed = ('apps/api/dist', 'apps/api/node_modules', 'apps/web/dist')
            parents = ('.', 'apps', 'apps/api', 'apps/web', 'deploy')
            files = ('release.json', 'pnpm-lock.yaml', 'apps/api/package.json',
                     'apps/api/pnpm-lock.yaml', 'deploy/ops.mjs', 'deploy/external.mjs',
                     'deploy/stopped.sh')
            if name not in parents + files and not any(name == prefix or name.startswith(prefix + '/') for prefix in allowed):
                raise ValueError('Unexpected production file')
        for member in members:
            if any(parent in links for parent in PurePosixPath(member.name).parents):
                raise ValueError('Archive writes through a link')
        source.extractall(destination, members=members, filter='data')
    for item in destination.rglob('*'):
        if not item.is_symlink():
            item.chmod(0o755 if item.is_dir() or item.stat().st_mode & 0o111 else 0o644)


def stopped():
    run('/usr/bin/mountpoint', '-q', '/srv/stageflow')
    for key, allowed in [('LoadState', ['loaded']), ('ActiveState', ['inactive', 'failed']),
                         ('MainPID', ['0']), ('Job', [''])]:
        if run('/usr/bin/systemctl', 'show', 'stageflow.service', f'--property={key}', '--value') not in allowed:
            raise RuntimeError('Writer not fully stopped')
    group = run('/usr/bin/systemctl', 'show', 'stageflow.service', '--property=ControlGroup', '--value')
    events = Path('/sys/fs/cgroup' + group) / 'cgroup.events'
    if group and events.exists() and 'populated 1' in events.read_text():
        raise RuntimeError('Writer cgroup is populated')


def migration_idle():
    # A disconnected systemctl client does not necessarily cancel its systemd job.
    # Refuse another release until the operator resolves any outstanding migration.
    for key, allowed in [('LoadState', ['loaded']), ('ActiveState', ['inactive', 'failed']),
                         ('MainPID', ['0']), ('Job', [''])]:
        if run('/usr/bin/systemctl', 'show', 'stageflow-migrate.service', f'--property={key}', '--value') not in allowed:
            raise RuntimeError('Migration service is not idle')


def trusted_infra():
    for key in ('ExecStart', 'ExecStop'):
        command = run('/usr/bin/systemctl', 'show', 'stageflow-infra.service', f'--property={key}', '--value')
        if '/usr/local/lib/stageflow-ops/infra.sh' not in command or '/opt/stageflow/current' in command:
            raise RuntimeError('Install the operator-owned infrastructure override first')


def activate(release, commit):
    trusted_infra()
    migration_idle()
    previous = str((BASE / 'current').resolve()) if (BASE / 'current').exists() else None
    def record(phase):
        (STATE / f'{commit}.json').write_text(json.dumps({
            'commit': commit, 'previous': previous, 'phase': phase,
            'time': time.time(), 'automaticRollback': False}) + '\n')
    record('stopping')
    run('/usr/bin/systemctl', 'stop', 'stageflow.service')
    stopped()
    record('switching')
    next_link = BASE / 'next-ci'
    if next_link.exists() or next_link.is_symlink():
        raise RuntimeError('Unexpected pending symlink; operator inspection required')
    next_link.symlink_to(release)
    next_link.replace(BASE / 'current')
    # A failed/partial migration is deliberately not followed by an old-code start.
    record('migration-started')
    run('/usr/bin/systemctl', 'start', 'stageflow-migrate.service')
    record('starting')
    run('/usr/bin/systemctl', 'start', 'stageflow.service')
    for attempt in range(30):
        try:
            for path in ('/api/health', '/api/health/live'):
                with urllib.request.urlopen('http://127.0.0.1:4100' + path, timeout=3) as response:
                    if response.status != 200:
                        raise RuntimeError('Health failed')
            record('healthy')
            return
        except DeploymentInterrupted:
            raise
        except Exception:
            time.sleep(2)
    raise RuntimeError('Health deadline exceeded')


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise RuntimeError('Root receiver takes no arguments')
    os.umask(0o077)
    def timeout(_signal, _frame):
        raise DeploymentInterrupted('Deployment deadline/interruption')
    signal.signal(signal.SIGALRM, timeout)
    signal.signal(signal.SIGTERM, timeout)
    signal.signal(signal.SIGHUP, timeout)
    signal.alarm(600)
    # All deploy/backup/restore operations share this existing lock.
    with open('/run/lock/stageflow-release.lock', 'w',
              opener=lambda path, flags: os.open(path, flags | os.O_NOFOLLOW, 0o600)) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (Path('/etc/stageflow/external-services').read_bytes().strip() != b'sf-external-shared-services'
                or Path('/etc/stageflow/fixture-only').exists()):
            raise RuntimeError('External-services mode required')
        if run('/opt/stageflow/node/bin/node', '--version') != 'v22.23.4':
            raise RuntimeError('Expected Node 22.23.4')
        commit, checksum = header(sys.stdin.buffer)
        STATE.mkdir(mode=0o700, exist_ok=True)
        release = BASE / 'releases' / commit
        if release.exists() or release.is_symlink():
            raise RuntimeError('Immutable release already exists; inspect before retrying')
        with tempfile.TemporaryDirectory(prefix='upload-', dir=STATE) as temporary:
            archive = Path(temporary) / 'release.tar.gz'
            digest = hashlib.sha256()
            size = 0
            with archive.open('wb') as output:
                while chunk := sys.stdin.buffer.read(1024 * 1024):
                    size += len(chunk)
                    if size > LIMIT:
                        raise ValueError('Upload exceeds limit')
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != checksum:
                raise ValueError('Checksum mismatch')
            unpacked = Path(temporary) / 'release'
            unpacked.mkdir()
            unpack(archive, unpacked)
            metadata = json.loads((unpacked / 'release.json').read_text())
            if any(metadata.get(k) != v for k, v in {
                'commit': commit, 'node': '22.23.4', 'pnpm': '12.9.1', 'platform': 'linux-x64'
            }.items()):
                raise ValueError('Release identity mismatch')
            if metadata.get('web') != {
                'mode': 'production', 'production': True, 'endpoints': {
                    'VITE_API_BASE_URL': 'https://stage.shreyasrasaikar.cloud/api',
                    'VITE_WS_URL': 'https://stage.shreyasrasaikar.cloud'
                }
            }:
                raise ValueError('Production web identity mismatch')
            for path in ('apps/api/dist/main.js', 'apps/api/node_modules/typeorm/cli.js',
                         'apps/api/dist/database/data-source.js', 'apps/web/dist/index.html',
                         'deploy/ops.mjs', 'deploy/external.mjs'):
                if not (unpacked / path).is_file():
                    raise ValueError('Incomplete release')
            shutil.move(str(unpacked), release)
            release.chmod(0o755)
            (STATE / f'{commit}.sha256').write_text(checksum + '\n')
        try:
            activate(release, commit)
        except Exception:
            # No guard removal, automatic rollback, infra mutation or data cleanup.
            run('/usr/bin/systemctl', 'stop', 'stageflow.service')
            raise
        print(f'Activated {commit}; both health endpoints passed')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Deployment refused/failed. Inspect protected deployment journal and systemd logs; no automatic rollback.', file=sys.stderr)
        sys.exit(1)
