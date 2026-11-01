import { useEffect, useState } from 'react';
import type { RoomSession } from '../services/room-session';

export function useDemoPeers(live: RoomSession): {
  count: number;
  starting: boolean;
  spawn: () => void;
  remove: () => void;
} {
  const [, notify] = useState(0);
  useEffect(() => live.subscribe(() => notify((value) => value + 1)), [live]);
  return {
    count: live.demoCount,
    starting: live.demoStarting,
    spawn: () => void live.spawnDemo(),
    remove: () => live.removeDemos(),
  };
}
