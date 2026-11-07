"""Disposable filesystem and mocked systemd tests; never contact a host."""
import importlib.util
import fcntl
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('receiver', Path(__file__).with_name('ci-deploy.py'))
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


class Safeguards(unittest.TestCase):
    def test_header(self):
        self.assertEqual(receiver.header(io.BytesIO(b'a' * 40 + b' ' + b'b' * 64 + b'\n')), ['a' * 40, 'b' * 64])
        for value in (b'../../root x\n', b'a' * 200, b'command\n', b''):
            with self.assertRaises((ValueError, UnicodeError)):
                receiver.header(io.BytesIO(value))

    def archive(self, entries, callback):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            archive = root / 'input.tar.gz'
            with tarfile.open(archive, 'w:gz') as output:
                for name, kind, link in entries:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.linkname = link
                    output.addfile(member)
            destination = root / 'release'
            destination.mkdir()
            callback(archive, destination)

    def test_unsafe_archives(self):
        for entries in (
            [('../escape', tarfile.REGTYPE, '')],
            [('/absolute', tarfile.REGTYPE, '')],
            [('apps/.env', tarfile.REGTYPE, '')],
            [('apps/link', tarfile.SYMTYPE, '../../../etc')],
            [('apps/hard', tarfile.LNKTYPE, 'apps/file')],
            [('apps/fifo', tarfile.FIFOTYPE, '')],
            [('etc/config', tarfile.REGTYPE, '')],
            [('apps/file', tarfile.REGTYPE, ''), ('apps/file', tarfile.REGTYPE, '')],
            [('apps/api/node_modules/link', tarfile.SYMTYPE, 'target'), ('apps/api/node_modules/link/file', tarfile.REGTYPE, '')],
            [('apps/api/data/recording', tarfile.REGTYPE, '')],
            [('apps/api/node_modules/link', tarfile.SYMTYPE, '/opt/stageflow/current')],
        ):
            with self.subTest(entries=entries), self.assertRaises((ValueError, tarfile.FilterError)):
                self.archive(entries, receiver.unpack)

    def test_internal_pnpm_link(self):
        self.archive([('apps/api/node_modules/pg', tarfile.SYMTYPE, '.pnpm/pg/node_modules/pg')], receiver.unpack)

    def test_release_lock_excludes_second_operator(self):
        with tempfile.TemporaryDirectory() as root:
            with open(Path(root) / 'lock', 'w') as first, open(Path(root) / 'lock', 'w') as second:
                fcntl.flock(first, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(second, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_receiver_checksum_and_existing_release_leave_writer_alone(self):
        import builtins
        real_open = builtins.open
        for existing in (False, True):
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as root:
                base = Path(root)
                (base / 'releases').mkdir()
                state = base / 'state'
                if existing:
                    (base / 'releases' / ('a' * 40)).mkdir()
                stream = io.BytesIO(b'a' * 40 + b' ' + b'b' * 64 + b'\ncorrupt upload')
                def lock_open(path, mode, **kwargs):
                    self.assertEqual(path, '/run/lock/stageflow-release.lock')
                    return real_open(base / 'lock', mode, **kwargs)
                with patch.object(receiver, 'BASE', base), patch.object(receiver, 'STATE', state), \
                        patch.object(receiver, 'run', return_value='v22.23.4') as commands, \
                        patch.object(receiver.os, 'geteuid', return_value=0), \
                        patch.object(receiver.os, 'umask'), \
                        patch.object(receiver.signal, 'signal'), patch.object(receiver.signal, 'alarm'), \
                        patch.object(receiver.sys, 'argv', ['receiver']), \
                        patch.object(receiver.sys, 'stdin', SimpleNamespace(buffer=stream)), \
                        patch.object(Path, 'read_bytes', return_value=b'sf-external-shared-services'), \
                        patch.object(receiver, 'open', side_effect=lock_open, create=True):
                    with self.assertRaises((ValueError, RuntimeError)):
                        receiver.main()
                    self.assertEqual(commands.call_args_list, [unittest.mock.call('/opt/stageflow/node/bin/node', '--version')])
                    self.assertFalse((base / 'current').exists())
                    self.assertEqual(list(state.glob('upload-*')), [])

    def test_upload_checks_checksum_and_enforces_ssh_identity(self):
        script = Path(__file__).resolve().parents[1] / 'scripts/ci-upload.sh'
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            binary = root / 'bin'
            binary.mkdir()
            ssh = binary / 'ssh'
            ssh.write_text('#!/bin/bash\nprintf "%s\\n" "$@" > "$CAPTURE.args"\ncat > "$CAPTURE.input"\n')
            ssh.chmod(0o755)
            artifact = root / ('stageflow-' + 'a' * 40 + '.tar.gz')
            artifact.write_bytes(b'fixture-only archive')
            import hashlib
            checksum = hashlib.sha256(artifact.read_bytes()).hexdigest()
            sums = artifact.with_name(artifact.name + '.sha256')
            sums.write_text(checksum + '  ' + artifact.name + '\n')
            env = {**os.environ, 'PATH': str(binary) + ':' + os.environ['PATH'],
                   'GITHUB_SHA': 'a' * 40, 'DEPLOY_HOST': 'fixture.invalid', 'DEPLOY_PORT': '22',
                   'DEPLOY_KEY': 'fixture-key', 'DEPLOY_KNOWN_HOSTS': 'fixture-host-key',
                   'CAPTURE': str(root / 'capture')}
            result = subprocess.run(['/bin/bash', str(script), str(root)], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            arguments = (root / 'capture.args').read_text()
            for required in ('StrictHostKeyChecking=yes', 'IdentitiesOnly=yes', 'BatchMode=yes',
                             'stageflow-deploy@fixture.invalid', 'UserKnownHostsFile='):
                self.assertIn(required, arguments)
            self.assertEqual((root / 'capture.input').read_bytes(),
                             ('a' * 40 + ' ' + checksum + '\n').encode() + artifact.read_bytes())
            (root / 'capture.args').unlink()
            artifact.write_bytes(b'corrupt')
            result = subprocess.run(['/bin/bash', str(script), str(root)], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / 'capture.args').exists())
            env['DEPLOY_HOST'] = '-oProxyCommand=bad'
            result = subprocess.run(['/bin/bash', str(script), str(root)], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / 'capture.args').exists())

    def test_stopped_refuses_writer_and_pending_jobs(self):
        normal = {'LoadState': 'loaded', 'ActiveState': 'inactive', 'MainPID': '0', 'Job': '', 'ControlGroup': ''}
        def command(*args):
            for argument in args:
                if argument.startswith('--property='):
                    return state[argument.split('=')[1]]
            return ''
        with patch.object(receiver, 'run', side_effect=command):
            for check in (receiver.stopped, receiver.migration_idle):
                state = normal.copy()
                check()
                for key, value in [('LoadState', 'not-found'), ('ActiveState', 'active'), ('MainPID', '42'), ('Job', '1')]:
                    state = {**normal, key: value}
                    with self.subTest(check=check.__name__, key=key), self.assertRaises(RuntimeError):
                        check()

    def test_root_infrastructure_cannot_execute_uploaded_helpers(self):
        with patch.object(receiver, 'run', return_value='/bin/sh /usr/local/lib/stageflow-ops/infra.sh start'):
            receiver.trusted_infra()
        for command in ('', '/bin/sh /opt/stageflow/current/deploy/infra.sh start',
                        '/usr/local/lib/stageflow-ops/infra.sh /opt/stageflow/current/evil'):
            with self.subTest(command=command), patch.object(receiver, 'run', return_value=command):
                with self.assertRaises(RuntimeError):
                    receiver.trusted_infra()

    def test_migration_failure_never_starts_writer_or_reverts_current(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            old, new = base / 'old', base / 'new'
            old.mkdir()
            new.mkdir()
            (base / 'current').symlink_to(old)
            calls = []
            def command(*args):
                calls.append(args)
                if args[-1] == 'stageflow-migrate.service':
                    raise RuntimeError('injected migration failure')
                return ''
            with patch.object(receiver, 'BASE', base), patch.object(receiver, 'STATE', base), \
                    patch.object(receiver, 'run', side_effect=command), patch.object(receiver, 'stopped'), \
                    patch.object(receiver, 'migration_idle'), patch.object(receiver, 'trusted_infra'):
                with self.assertRaises(RuntimeError):
                    receiver.activate(new, 'a' * 40)
            self.assertEqual((base / 'current').resolve(), new)
            self.assertNotIn(('/usr/bin/systemctl', 'start', 'stageflow.service'), calls)
            self.assertEqual(json.loads((base / ('a' * 40 + '.json')).read_text())['phase'], 'migration-started')

    def test_health_success_and_deadline(self):
        for healthy in (True, False, None):
            with self.subTest(healthy=healthy), tempfile.TemporaryDirectory() as root:
                base = Path(root)
                release = base / 'release'
                release.mkdir()
                response = unittest.mock.MagicMock()
                response.__enter__.return_value.status = 200
                with patch.object(receiver, 'BASE', base), patch.object(receiver, 'STATE', base), \
                        patch.object(receiver, 'run'), patch.object(receiver, 'stopped'), patch.object(receiver, 'migration_idle'), \
                        patch.object(receiver, 'trusted_infra'), \
                        patch.object(receiver.time, 'sleep'), \
                        patch.object(receiver.urllib.request, 'urlopen', return_value=response,
                                     side_effect=None if healthy else (
                                         receiver.DeploymentInterrupted('interrupted') if healthy is None else OSError('offline'))) as health:
                    if healthy:
                        receiver.activate(release, 'a' * 40)
                        self.assertEqual([x.args[0] for x in health.call_args_list], [
                            'http://127.0.0.1:4100/api/health', 'http://127.0.0.1:4100/api/health/live'])
                    elif healthy is None:
                        with self.assertRaises(receiver.DeploymentInterrupted):
                            receiver.activate(release, 'a' * 40)
                        self.assertEqual(health.call_count, 1)
                    else:
                        with self.assertRaises(RuntimeError):
                            receiver.activate(release, 'a' * 40)
                        self.assertEqual(health.call_count, 30)


if __name__ == '__main__':
    unittest.main()
