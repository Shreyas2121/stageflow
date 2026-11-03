import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function selectChecks(files, full = false) {
  const packages = new Set();
  let audit = full;
  for (const file of files) {
    if (
      /^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|(?:.*\/)?package\.json|scripts\/audit|audit-exceptions\.json)/.test(
        file,
      )
    )
      audit = true;
    if (file.endsWith('.md')) continue;
    if (file.startsWith('apps/web/')) packages.add('web');
    else if (file.startsWith('apps/api/')) packages.add('api');
    else if (file.startsWith('packages/shared/')) full = true;
    else full = true;
    // Package manifests may change dependency resolution and the task graph.
    if (file.endsWith('/package.json')) full = true;
    // Recorder/uploader changes also require the real HTTP/encoder boundary, including API build.
    if (file.startsWith('apps/web/src/features/broadcast/services/')) full = true;
  }
  return { full, packages: full ? ['shared', 'api', 'web'] : [...packages].sort(), audit };
}

export function checkCommands(plan) {
  if (plan.full) return [['check:release']];
  const commands = [['format:check']];
  if (plan.packages.length) commands.push(['shared:prepare']);
  for (const name of plan.packages) {
    for (const task of ['typecheck', 'lint', 'test', 'build'])
      commands.push(['--filter', `@stageflow/${name}`, task]);
    commands.push(['check:artifacts', `--${name}`]);
    if (name === 'api') commands.push(['smoke:live'], ['smoke:broadcast']);
  }
  return commands;
}

export function pnpm(args, options = {}) {
  const result = spawnSync('pnpm', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`pnpm ${args.join(' ')} failed (${result.status ?? 'signal'}).`);
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const knownFlags = new Set(['--full', '--plan', '--files', '--base']);
  let base = process.env.CHECK_BASE;
  let files;
  let full = args.includes('--full');
  for (let i = 0; i < args.length; i++) {
    if (!knownFlags.has(args[i])) throw new Error(`Unknown option: ${args[i]}`);
    if (args[i] === '--files') {
      files = args.slice(i + 1);
      break;
    }
    if (args[i] === '--base') {
      base = args[++i];
      if (!base) throw new Error('--base needs a commit SHA.');
    }
  }
  if (!files && !full && base) {
    if (!/^[a-f0-9]{7,40}$/i.test(base)) throw new Error('Base must be a commit SHA.');
    const result = spawnSync(
      'git',
      ['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.error || result.status !== 0)
      throw new Error('Cannot determine changed files; fetch the base history or use --full.');
    files = result.stdout.split('\0').filter(Boolean);
  }
  if (!files) full = true;
  const plan = selectChecks(files ?? [], full);
  if (process.env.CHECK_AUDIT === 'true') plan.audit = true;
  console.log(JSON.stringify({ ...plan, commands: checkCommands(plan) }, null, 2));
  if (args.includes('--plan')) return;
  for (const args of checkCommands(plan)) pnpm(args);
  if (plan.audit) pnpm(['audit:check']);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
