import { pathToFileURL } from 'node:url';
import { buildShared } from './shared-build.mjs';
import { pnpm } from './check-affected.mjs';

const task = (name, command) => ['--filter', `@stageflow/${name}`, command];
const typecheck = ['shared', 'api', 'web'].map((name) => task(name, 'typecheck'));
const tests = ['shared', 'web', 'api'].map((name) => task(name, 'test'));
const builds = ['api', 'web'].map((name) => task(name, 'build'));
const check = [...typecheck, ['lint'], ...tests, ...builds, ['format:check']];

export function checkGraph(name) {
  const plans = {
    typecheck,
    test: tests,
    'test:unit': tests.slice(0, 2),
    'test:integration': tests.slice(2),
    build: builds,
    'build:production': [...builds, ['check:artifacts']],
    check,
    'check:release': [
      ['test:tooling'],
      ...check,
      ['check:artifacts'],
      ['smoke:live'],
      ['smoke:broadcast'],
    ],
  };
  if (!Object.hasOwn(plans, name)) throw new Error(`Unknown check graph: ${name}`);
  return plans[name];
}

/** Prepare once; leaf commands still validate prerequisites, including mid-run edits. */
export async function runChecks(
  name,
  { prepare = () => buildShared({ force: true }), run = pnpm } = {},
) {
  const commands = checkGraph(name);
  await prepare();
  for (const args of commands) await run(args);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runChecks(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
