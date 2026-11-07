import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicEndpoints, productionArtifactPlugin } from './build-web.mjs';
import { verifyProductionWeb } from './production-artifacts.mjs';
import { checkGraph } from './checks.mjs';

const endpoints = {
  VITE_API_BASE_URL: 'https://stageflow.example/api',
  VITE_WS_URL: 'https://stageflow.example',
};
const metadata = { mode: 'production', production: true, endpoints };
const javascript = Object.values(endpoints)
  .map((value) => JSON.stringify(value))
  .join(';');

test('packaging includes both builds and artifact verification', () => {
  assert.deepEqual(checkGraph('build:production'), [...checkGraph('build'), ['check:artifacts']]);
});

test('public build inputs reject missing, relative, non-HTTP and credential-bearing URLs', () => {
  for (const key of Object.keys(endpoints)) {
    for (const value of [
      undefined,
      '',
      '/api',
      'wss://example.com',
      'https://u:p@example.com',
      'https://example.com?q=1',
      'https://example.com/#x',
    ]) {
      assert.throws(() => publicEndpoints({ ...endpoints, [key]: value }), new RegExp(key));
    }
  }
  assert.deepEqual(publicEndpoints(endpoints), endpoints);
});

test('metadata is emitted only from resolved production configuration and valid endpoints', () => {
  const config = {
    isProduction: true,
    mode: 'production',
    env: { PROD: true, DEV: false, ...endpoints },
  };
  for (const change of [
    { isProduction: false },
    { mode: 'development' },
    { env: { ...config.env, DEV: true } },
    { env: { ...config.env, PROD: false } },
  ]) {
    assert.throws(
      () => productionArtifactPlugin().configResolved({ ...config, ...change }),
      /production/,
    );
  }
  const plugin = productionArtifactPlugin();
  plugin.configResolved(config);
  let asset;
  plugin.generateBundle.call({
    emitFile: (value) => {
      asset = value;
    },
  });
  assert.equal(asset.fileName, 'build-info.json');
  assert.deepEqual(JSON.parse(asset.source), metadata);
});

test('artifact verification rejects development output, missing URLs and stale endpoint inputs', () => {
  verifyProductionWeb(metadata, javascript, {});
  assert.throws(
    () => verifyProductionWeb({ ...metadata, production: false }, javascript, {}),
    /production/,
  );
  assert.throws(
    () => verifyProductionWeb({ ...metadata, mode: 'development' }, javascript, {}),
    /production/,
  );
  assert.throws(() => verifyProductionWeb(metadata, '', {}), /compiled JavaScript/);
  for (const marker of [
    'react.development',
    'react-dom.development',
    'react-dom-client.development',
    'react-jsx-runtime.development',
    'react-jsx-dev-runtime.development',
    'Download the React DevTools',
  ]) {
    assert.throws(
      () => verifyProductionWeb(metadata, javascript + marker, {}),
      /Development React/,
    );
  }
  assert.throws(
    () => verifyProductionWeb(metadata, javascript, { VITE_WS_URL: 'https://other.example' }),
    /build input/,
  );
});
