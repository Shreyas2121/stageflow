#!/bin/bash
# Run only in a clean Linux x86-64 build job after the complete release gate.
set -euo pipefail
test "$(uname -sm)" = 'Linux x86_64'
test "$(node --version)" = v22.23.4
test "$(pnpm --version)" = 12.9.1
commit=${GITHUB_SHA:-$(git rev-parse HEAD)}
[[ $commit =~ ^[0-9a-f]{40}$ ]]
output=${1:?absolute output directory required}
[[ $output = /* ]]
mkdir -p "$output"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/workspace/apps/api" "$work/workspace/apps/web" "$work/workspace/packages/shared"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$work/workspace/"
for package in apps/api apps/web packages/shared; do
  cp "$package/package.json" "$work/workspace/$package/"
done
cp -R apps/api/dist "$work/workspace/apps/api/"
cp -R packages/shared/dist "$work/workspace/packages/shared/"
# The staging workspace contains only manifests and compiled code: deploy cannot
# accidentally package a developer .env, media directory, or source fixture.
(cd "$work/workspace" && HUSKY=0 pnpm install --prod --frozen-lockfile --ignore-scripts &&
  pnpm --filter @stageflow/api deploy --legacy --prod "$work/api")
mkdir -p "$work/release/apps/api" "$work/release/apps/web" "$work/release/deploy"
cp -R "$work/api/." "$work/release/apps/api/"
cp -R apps/web/dist "$work/release/apps/web/"
cp deploy/ops.mjs deploy/external.mjs deploy/stopped.sh "$work/release/deploy/"
cp pnpm-lock.yaml "$work/release/"
COMMIT="$commit" RELEASE="$work/release" node --input-type=module <<'JS'
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const migrations = 'apps/api/dist/migrations';
const hash = createHash('sha256');
for (const file of readdirSync(migrations).filter(x => x.endsWith('.js')).sort()) {
  hash.update(file).update(readFileSync(`${migrations}/${file}`));
}
writeFileSync(`${process.env.RELEASE}/release.json`, JSON.stringify({
  commit: process.env.COMMIT, node: '22.23.4', pnpm: '12.9.1', platform: 'linux-x64',
  migrations: hash.digest('hex'),
  ffmpeg: execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
  web: JSON.parse(readFileSync('apps/web/dist/build-info.json', 'utf8')),
}, null, 2) + '\n');
JS
# Prove runtime resolution without the repository's development dependencies.
(cd "$work/release/apps/api" && node -e 'require("@stageflow/shared"); require("pg"); require("typeorm"); require("./dist/config/parse-config.js")')
tar --hard-dereference -C "$work/release" -czf "$output/stageflow-$commit.tar.gz" .
(cd "$output" && sha256sum "stageflow-$commit.tar.gz" > "stageflow-$commit.tar.gz.sha256")
cp "$work/release/release.json" "$output/"
