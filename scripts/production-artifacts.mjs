import assert from 'node:assert/strict';
import { publicEndpoints } from './build-web.mjs';

export function verifyProductionWeb(metadata, javascript, expectedEnv = process.env) {
  assert.equal(metadata.mode, 'production', 'Web mode must be production.');
  assert.equal(metadata.production, true, 'Web artifact must be production.');
  const endpoints = publicEndpoints(metadata.endpoints);
  for (const [key, value] of Object.entries(endpoints)) {
    assert(javascript.includes(value), `${key} is missing from compiled JavaScript.`);
    if (expectedEnv[key]) assert.equal(value, expectedEnv[key], `${key} differs from build input.`);
  }
  assert(
    !/react(?:-dom(?:-client)?|-jsx(?:-dev)?-runtime)?\.development|Download the React DevTools/.test(
      javascript,
    ),
    'Development React leaked into the web artifact.',
  );
}
