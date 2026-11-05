import { useEffect, useState, useSyncExternalStore } from 'react';
import type { GuestSessionResponse, RoomResponse } from '@stageflow/shared';
import { RoomSession } from '../services/room-session';

export function useLiveRoom(
  room: RoomResponse,
  session: GuestSessionResponse,
  onEnded: () => void,
): RoomSession {
  const [live] = useState(
    () =>
      new RoomSession({
        room,
        userId: session.userId,
        token: session.token,
        onEnded,
      }),
  );
  useSyncExternalStore(live.subscribe, live.getSnapshot);
  useEffect(() => {
    live.attach();
    return () => live.dispose();
  }, [live]);
  return live;
}
