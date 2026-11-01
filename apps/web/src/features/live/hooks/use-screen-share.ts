import { useEffect, useState } from 'react';
import type { RoomSession } from '../services/room-session';

export function useScreenShare(live: RoomSession): {
  sharing: boolean;
  pending: boolean;
  start: () => void;
  stop: () => void;
} {
  const [, notify] = useState(0);
  useEffect(() => live.subscribe(() => notify((value) => value + 1)), [live]);
  return {
    sharing: live.sharing,
    pending: live.sharePending,
    start: () => void live.startSharing(),
    stop: () => void live.stopSharing(),
  };
}
