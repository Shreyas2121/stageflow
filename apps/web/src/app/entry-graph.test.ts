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
    const home = source('pages/HomePage.tsx');
    expect(home.toLowerCase()).not.toContain('hls');
    expect(home).not.toContain('broadcast-player');
    expect(home).not.toContain('broadcast-player-gate');
    expect(home).not.toContain('hls.js');
    expect(home).not.toContain('LiveRoom');
    expect(home).not.toMatch(/chat-panel|ChatPanel|features\/chat/);
    expect(home).toContain('Rooms from this guest session');
    expect(home).toContain('Your rooms');
    const account = source('features/session/account-panel.tsx');
    expect(account.toLowerCase()).not.toContain('hls');
    expect(account).not.toMatch(
      /LiveRoom|features\/live|features\/chat|chat-panel|ChatPanel|broadcast-player/,
    );
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

  it('loads hls.js only from the playback chunk', () => {
    const gate = source('features/broadcast/components/broadcast-player-gate.tsx');
    const player = source('features/broadcast/components/broadcast-player.tsx');
    const config = readFileSync(join(src, '../vite.config.ts'), 'utf8');
    expect(player).toMatch(/from ['"]hls\.js['"]/);
    expect(config).not.toContain('chunkSizeWarningLimit');
    for (const line of gate.split('\n')) {
      if (!line.includes('broadcast-player') || line.includes('import type')) continue;
      expect(line).toContain("import('./broadcast-player')");
      expect(line).not.toContain('from ');
    }
    for (const file of [
      'pages/RoomPage.tsx',
      'pages/ReplayPage.tsx',
      'features/live/components/live-room.tsx',
      'features/broadcast/components/attendee-broadcast.tsx',
    ]) {
      expect(source(file), file).not.toMatch(/from ['"]hls\.js['"]/);
      expect(source(file), file).not.toMatch(/from ['"][^'"]*broadcast-player['"]/);
    }
    expect(source('features/broadcast/components/attendee-broadcast.tsx')).toContain(
      "from './broadcast-player-gate'",
    );
    expect(source('pages/ReplayPage.tsx')).toContain(
      "from '../features/broadcast/components/broadcast-player-gate'",
    );
  });
});
