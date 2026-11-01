import type { RoomMode, RoomStatus } from './contracts';
import type { MediaPatch, ParticipantState, StageError } from './stage';

export type RoomSnapshot = {
  revision: number;
  roomId: string;
  mode: RoomMode;
  status: RoomStatus;
  participants: ParticipantState[];
  stageSocketIds: string[];
  handSocketIds: string[];
  broadcast: null;
};

export type IceServer = { urls: string | string[]; username?: string; credential?: string };
export type SignalingError = StageError | 'room_not_found' | 'invalid_payload' | 'not_joined' | 'server_error';
export type CommandAck = { ok: true } | { ok: false; error: SignalingError; message: string };
export type JoinAck = { ok: true; selfSocketId: string; iceServers: IceServer[] } | Extract<CommandAck, { ok: false }>;
export type JoinRoomRequest = {
  roomId: string;
  isAudioMuted: boolean;
  isVideoOff: boolean;
  isSyntheticBot: boolean;
};

export interface ClientToServerEvents {
  'room:join': (payload: JoinRoomRequest, ack: (result: JoinAck) => void) => void;
  'room:leave': (ack: (result: CommandAck) => void) => void;
  'media:state': (payload: MediaPatch, ack: (result: CommandAck) => void) => void;
  'stage:raise-hand': (payload: { raised: boolean }, ack: (result: CommandAck) => void) => void;
}

export interface ServerToClientEvents {
  'room:state': (snapshot: RoomSnapshot) => void;
  'room:ended': (payload: { roomId: string }) => void;
}
