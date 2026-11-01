import { useEffect, useState } from 'react';
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
  const [, notify] = useState(0);
  useEffect(() => live.subscribe(() => notify((value) => value + 1)), [live]);
  useEffect(() => {
    live.attach();
    return () => live.dispose();
  }, [live]);
  return live;
}
