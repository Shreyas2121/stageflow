import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));

describe('broadcast service boundaries', () => {
  it('keeps services free of React and the live feature', () => {
    const sources = readdirSync(directory).filter(
      (name) => /\.tsx?$/.test(name) && !name.includes('.test.'),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      const source = readFileSync(join(directory, name), 'utf8');
      expect(source, name).not.toMatch(/from ['"]react['"]/);
      expect(source, name).not.toMatch(/features\/live/);
      expect(source, name).not.toMatch(/from ['"]hls\.js['"]/);
    }
  });
});
