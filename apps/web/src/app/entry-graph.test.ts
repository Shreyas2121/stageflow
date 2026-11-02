import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');

function source(path: string): string {
  return readFileSync(join(src, path), 'utf8');
}

describe('home entry', () => {
  it('does not mention hls on the home page or the web entry', () => {
    expect(source('pages/HomePage.tsx').toLowerCase()).not.toContain('hls');
    expect(source('main.tsx').toLowerCase()).not.toContain('hls');
  });

  it('keeps the room and the replay behind dynamic imports', () => {
    const app = source('App.tsx');
    const boundary = source('app/route-error-boundary.tsx');
    expect(app).toContain('path="/r/:slug"');
    expect(app).toContain('path="/replay/:broadcastId"');
    expect(app).not.toMatch(/from ['"][^'"]*ReplayPage['"]/);
    expect(app).not.toMatch(/from ['"][^'"]*RoomPage['"]/);
    expect(app).not.toMatch(/from ['"][^'"]*broadcast-player['"]/);
    expect(boundary).toContain("import('../pages/RoomPage')");
    expect(boundary).toContain("import('../pages/ReplayPage')");
    expect(boundary).not.toMatch(/from ['"]hls\.js['"]/);
  });
});
