import { canRelay, connectedStageIds } from '@stageflow/shared';
import { signalingUrl } from '../../../config/env';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  CommandAck,
  JoinAck,
  JoinRoomRequest,
  MediaPatch,
  RoomSnapshot,
  ServerToClientEvents,
  StageLockRequest,
  StageForceMute,
} from '@stageflow/shared';
import { useRoomStore } from '../stores/room-store';
import type {
  DescriptionRequest,
  IceCandidateRequest,
  RelayedDescription,
  RelayedIceCandidate,
} from '@stageflow/shared';

const PENDING_EVENT_LIMIT = 32;
const PENDING_BYTE_LIMIT = 256 * 1024;
const PENDING_TIMEOUT_MS = 8_000;
/** Server stop allows 10 seconds for FFmpeg, plus persistence/publication time. */
export const BROADCAST_STOP_MS = 15_000;

export type RoomConnection = {
  description: (payload: DescriptionRequest) => Promise<CommandAck>;
  candidate: (payload: IceCandidateRequest) => Promise<CommandAck>;
  join: (payload: JoinRoomRequest) => Promise<JoinAck>;
  media: (patch: MediaPatch) => Promise<CommandAck>;
  hand: (raised: boolean) => Promise<CommandAck>;
  promote: (targetParticipantId: string) => Promise<CommandAck>;
  demote: (targetParticipantId: string) => Promise<CommandAck>;
  setLock: (request: StageLockRequest) => Promise<CommandAck>;
  startBroadcast: () => Promise<CommandAck>;
  stopBroadcast: () => Promise<CommandAck>;
  leave: () => Promise<CommandAck>;
  close: () => void;
};
let current: RoomConnection | null = null;

type SignalingCallbacks = {
  onForceMute?: (payload: StageForceMute) => void;
  onEnded: () => void;
  onDisconnect: () => void;
  onDescription: (payload: RelayedDescription) => void;
  onCandidate: (payload: RelayedIceCandidate) => void;
};

export function openIndependentSignaling(
  token: string,
  roomId: string,
  callbacks: SignalingCallbacks & {
    onState: (snapshot: RoomSnapshot) => void;
    onJoined: (ack: Extract<JoinAck, { ok: true }>) => void;
    onClosed?: () => void;
  },
): RoomConnection {
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(signalingUrl(), {
    auth: { token },
    reconnection: false,
    autoConnect: false,
    forceNew: true,
    timeout: 8000,
  });
  let closed = false;
  let joined = false;
  let latestSnapshot: RoomSnapshot | null = null;
  let joinSettled = false;
  let pendingBytes = 0;
  let pendingFailed = false;
  const pending: (() => void)[] = [];
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelConnect: (() => void) | undefined;
  let rejectJoin: ((error: Error) => void) | undefined;
  const releasePending = () => {
    pending.length = 0;
    pendingBytes = 0;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
  };
  const failPending = (message: string) => {
    pendingFailed = true;
    releasePending();
    if (joined || joinSettled) return;
    joinSettled = true;
    rejectJoin?.(new Error(message));
  };
  const queuePending = (payload: unknown, deliver: () => void) => {
    if (closed || pendingFailed) return;
    const bytes = JSON.stringify(payload).length;
    if (pending.length + 1 > PENDING_EVENT_LIMIT || pendingBytes + bytes > PENDING_BYTE_LIMIT) {
      failPending('Live signaling overflowed before join.');
      return;
    }
    pending.push(deliver);
    pendingBytes += bytes;
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      if (pending.length === 0) return;
      failPending('Live signaling expired before join.');
    }, PENDING_TIMEOUT_MS);
  };
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
      const result = await new Promise<JoinAck>((resolve, reject) => {
        rejectJoin = reject;
        socket
          .timeout(8000)
          .emitWithAck('room:join', payload)
          .then(
            (ack: JoinAck) => {
              if (joinSettled) return;
              if (pendingFailed) {
                joinSettled = true;
                reject(new Error('Live signaling overflowed before join.'));
                return;
              }
              joinSettled = true;
              resolve(ack);
            },
            (error: unknown) => {
              if (joinSettled) return;
              joinSettled = true;
              releasePending();
              reject(error instanceof Error ? error : new Error('Unable to join this room.'));
            },
          );
      });
      if (result.ok && !closed) {
        joined = true;
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = undefined;
        }
        callbacks.onJoined(result);
        const queued = pending.splice(0);
        pendingBytes = 0;
        for (const deliver of queued) deliver();
      } else releasePending();
      return result;
    },
    media: (patch) => socket.timeout(8000).emitWithAck('media:state', patch),
    description: (payload) => socket.timeout(8000).emitWithAck('webrtc:description', payload),
    candidate: (payload) => socket.timeout(8000).emitWithAck('webrtc:ice-candidate', payload),
    hand: (raised) => socket.timeout(8000).emitWithAck('stage:raise-hand', { raised }),
    promote: (targetParticipantId) =>
      socket.timeout(8000).emitWithAck('stage:promote', { targetParticipantId }),
    demote: (targetParticipantId) =>
      socket.timeout(8000).emitWithAck('stage:demote', { targetParticipantId }),
    setLock: (request) => socket.timeout(8000).emitWithAck('stage:set-lock', request),
    startBroadcast: () => socket.timeout(8000).emitWithAck('broadcast:start'),
    async stopBroadcast() {
      const id = latestSnapshot?.broadcast?.id;
      const terminal = (): CommandAck | undefined => {
        const broadcast = latestSnapshot?.broadcast;
        if (closed || !id || broadcast?.id !== id) return;
        if (broadcast.status === 'READY') return { ok: true };
        if (broadcast.status === 'FAILED')
          return {
            ok: false,
            error: 'server_error',
            message: broadcast.errorMessage ?? 'The broadcast failed.',
          };
      };
      try {
        const result = await socket.timeout(BROADCAST_STOP_MS).emitWithAck('broadcast:stop');
        return terminal() ?? result;
      } catch {
        return (
          terminal() ?? {
            ok: false,
            error: 'server_error',
            message: 'Broadcast stop is not confirmed. Check its status before trying again.',
          }
        );
      }
    },
    leave: () => socket.timeout(8000).emitWithAck('room:leave'),
    close() {
      if (closed) return;
      closed = true;
      releasePending();
      cancelConnect?.();
      socket.removeAllListeners();
      socket.disconnect();
      callbacks.onClosed?.();
    },
  };
  socket.on('webrtc:description', (payload) => {
    if (closed) return;
    const onStage =
      latestSnapshot &&
      canRelay(
        connectedStageIds(latestSnapshot),
        payload.fromParticipantId,
        payload.toParticipantId,
      );
    if (joined) {
      if (onStage) callbacks.onDescription(payload);
    } else
      queuePending(payload, () => {
        if (onStage) callbacks.onDescription(payload);
      });
  });
  socket.on('webrtc:ice-candidate', (payload) => {
    if (closed) return;
    const onStage =
      latestSnapshot &&
      canRelay(
        connectedStageIds(latestSnapshot),
        payload.fromParticipantId,
        payload.toParticipantId,
      );
    if (joined) {
      if (onStage) callbacks.onCandidate(payload);
    } else
      queuePending(payload, () => {
        if (onStage) callbacks.onCandidate(payload);
      });
  });
  socket.on('room:state', (snapshot) => {
    if (closed || snapshot.roomId !== roomId) return;
    if (snapshot.revision > (latestSnapshot?.revision ?? -1)) latestSnapshot = snapshot;
    callbacks.onState(snapshot);
  });
  socket.on('stage:force-mute', (payload) => {
    if (!closed) callbacks.onForceMute?.(payload);
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
  return connection;
}

export function openSignaling(
  token: string,
  roomId: string,
  callbacks: SignalingCallbacks,
): RoomConnection {
  signalingUrl();
  current?.close();
  useRoomStore.getState().begin(roomId);
  const connection = openIndependentSignaling(token, roomId, {
    ...callbacks,
    onState: (snapshot) => useRoomStore.getState().receive(snapshot),
    onJoined: (result) => useRoomStore.getState().joined(result.participantId, result.iceServers),
    onClosed: () => {
      if (current === connection) {
        current = null;
        useRoomStore.getState().clear();
      }
    },
  });
  current = connection;
  return connection;
}
