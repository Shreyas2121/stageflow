import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = fileURLToPath(new URL('../apps/web/', import.meta.url));

export function publicEndpoints(env) {
  return Object.fromEntries(
    ['VITE_API_BASE_URL', 'VITE_WS_URL'].map((key) => {
      const value = env[key];
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new Error(`Set ${key} to an absolute HTTP(S) URL before building.`);
      }
      assert(
        ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash,
        `${key} must be an HTTP(S) URL without credentials, query, or fragment.`,
      );
      return [key, value];
    }),
  );
}

export function productionArtifactPlugin() {
  let metadata;
  return {
    name: 'stageflow-production-artifact',
    configResolved(config) {
      assert(
        config.isProduction && config.env.PROD && !config.env.DEV && config.mode === 'production',
        'Web artifacts require NODE_ENV=production and production mode.',
      );
      metadata = { mode: config.mode, production: true, endpoints: publicEndpoints(config.env) };
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-info.json',
        source: JSON.stringify(metadata),
      });
    },
  };
}

export async function buildWeb() {
  // Set this before Vite or its plugins are imported, regardless of the local .env.
  process.env.NODE_ENV = 'production';
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const { build } = await import(pathToFileURL(require.resolve('vite')).href);
  await build({ root: web, mode: 'production', plugins: [productionArtifactPlugin()] });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await buildWeb();
}
