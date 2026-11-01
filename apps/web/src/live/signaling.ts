import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  CommandAck,
  JoinAck,
  JoinRoomRequest,
  MediaPatch,
  ServerToClientEvents,
} from '@stageflow/shared';
import { useRoomStore } from './room-store';
import type {
  DescriptionRequest,
  IceCandidateRequest,
  RelayedDescription,
  RelayedIceCandidate,
} from '@stageflow/shared';

export type RoomConnection = {
  description: (payload: DescriptionRequest) => Promise<CommandAck>;
  candidate: (payload: IceCandidateRequest) => Promise<CommandAck>;
  join: (payload: JoinRoomRequest) => Promise<JoinAck>;
  media: (patch: MediaPatch) => Promise<CommandAck>;
  hand: (raised: boolean) => Promise<CommandAck>;
  leave: () => Promise<CommandAck>;
  close: () => void;
};
let current: RoomConnection | null = null;

export function openSignaling(
  token: string,
  roomId: string,
  callbacks: {
    onEnded: () => void;
    onDisconnect: () => void;
    onDescription: (payload: RelayedDescription) => void;
    onCandidate: (payload: RelayedIceCandidate) => void;
  },
): RoomConnection {
  const url = import.meta.env.VITE_WS_URL;
  if (!url)
    throw new Error('The live room address is missing. Set VITE_WS_URL and restart the web app.');
  current?.close();
  useRoomStore.getState().begin(roomId);
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(url, {
    auth: { token },
    reconnection: false,
    autoConnect: false,
    forceNew: true,
    timeout: 8000,
  });
  let closed = false;
  let joined = false;
  const pending: (() => void)[] = [];
  let cancelConnect: (() => void) | undefined;
  const connection: RoomConnection = {
    async join(payload) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.off('connect', connected);
          socket.off('connect_error', failed);
          cancelConnect = undefined;
        };
        const connected = () => {
          cleanup();
          resolve();
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        cancelConnect = () => failed(new Error('The live room connection closed.'));
        socket.once('connect', connected);
        socket.once('connect_error', failed);
        socket.connect();
      });
      const result = await socket.timeout(8000).emitWithAck('room:join', payload);
      if (result.ok && !closed) {
        useRoomStore.getState().joined(result.selfSocketId, result.iceServers);
        joined = true;
        for (const deliver of pending.splice(0)) deliver();
      }
      return result;
    },
    media: (patch) => socket.timeout(8000).emitWithAck('media:state', patch),
    description: (payload) => socket.timeout(8000).emitWithAck('webrtc:description', payload),
    candidate: (payload) => socket.timeout(8000).emitWithAck('webrtc:ice-candidate', payload),
    hand: (raised) => socket.timeout(8000).emitWithAck('stage:raise-hand', { raised }),
    leave: () => socket.timeout(8000).emitWithAck('room:leave'),
    close() {
      if (closed) return;
      closed = true;
      pending.length = 0;
      cancelConnect?.();
      socket.removeAllListeners();
      socket.disconnect();
      if (current === connection) {
        current = null;
        useRoomStore.getState().clear();
      }
    },
  };
  socket.on('webrtc:description', (payload) => {
    if (closed) return;
    if (joined) callbacks.onDescription(payload);
    else pending.push(() => callbacks.onDescription(payload));
  });
  socket.on('webrtc:ice-candidate', (payload) => {
    if (closed) return;
    if (joined) callbacks.onCandidate(payload);
    else pending.push(() => callbacks.onCandidate(payload));
  });
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
