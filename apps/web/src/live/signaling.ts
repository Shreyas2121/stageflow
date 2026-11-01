import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, CommandAck, JoinAck, JoinRoomRequest, MediaPatch, ServerToClientEvents } from '@stageflow/shared';
import { useRoomStore } from './room-store';

export type RoomConnection = {
  join: (payload: JoinRoomRequest) => Promise<JoinAck>;
  media: (patch: MediaPatch) => Promise<CommandAck>;
  hand: (raised: boolean) => Promise<CommandAck>;
  leave: () => Promise<CommandAck>;
  close: () => void;
};
let current: RoomConnection | null = null;

export function openSignaling(token: string, roomId: string, callbacks: {
  onEnded: () => void; onDisconnect: () => void;
}): RoomConnection {
  const url = import.meta.env.VITE_WS_URL;
  if (!url) throw new Error('The live room address is missing. Set VITE_WS_URL and restart the web app.');
  current?.close();
  useRoomStore.getState().begin(roomId);
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(url, {
    auth: { token }, reconnection: false, autoConnect: false, forceNew: true, timeout: 8000,
  });
  let closed = false;
  let cancelConnect: (() => void) | undefined;
  const connection: RoomConnection = {
    async join(payload) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { socket.off('connect', connected); socket.off('connect_error', failed); cancelConnect = undefined; };
        const connected = () => { cleanup(); resolve(); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        cancelConnect = () => failed(new Error('The live room connection closed.'));
        socket.once('connect', connected);
        socket.once('connect_error', failed);
        socket.connect();
      });
      const result = await socket.timeout(8000).emitWithAck('room:join', payload);
      if (result.ok && !closed) useRoomStore.getState().joined(result.selfSocketId, result.iceServers);
      return result;
    },
    media: (patch) => socket.timeout(8000).emitWithAck('media:state', patch),
    hand: (raised) => socket.timeout(8000).emitWithAck('stage:raise-hand', { raised }),
    leave: () => socket.timeout(8000).emitWithAck('room:leave'),
    close() {
      if (closed) return;
      closed = true;
      cancelConnect?.();
      socket.removeAllListeners();
      socket.disconnect();
      if (current === connection) {
        current = null;
        useRoomStore.getState().clear();
      }
    },
  };
  socket.on('room:state', (snapshot) => {
    if (!closed) useRoomStore.getState().receive(snapshot);
  });
  socket.on('room:ended', (payload) => {
    if (payload.roomId !== roomId || closed) return;
    connection.close();
    callbacks.onEnded();
  });
  socket.on('disconnect', () => {
    if (closed) return;
    connection.close();
    callbacks.onDisconnect();
  });
  current = connection;
  return connection;
}
