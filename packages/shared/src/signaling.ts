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
export type SignalingError =
  | StageError
  | 'room_not_found'
  | 'invalid_payload'
  | 'not_joined'
  | 'server_error'
  | 'rate_limited'
  | 'server_busy'
  | 'broadcast_not_available'
  | 'peer_unavailable';
export type CommandAck = { ok: true } | { ok: false; error: SignalingError; message: string };
export type JoinAck =
  { ok: true; selfSocketId: string; iceServers: IceServer[] } | Extract<CommandAck, { ok: false }>;
export type JoinRoomRequest = {
  roomId: string;
  isAudioMuted: boolean;
  isVideoOff: boolean;
  isSyntheticBot: boolean;
};

export type StageDescription = { type: 'offer' | 'answer'; sdp: string };
export type StageIceCandidate = {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string;
};
export type DescriptionRequest = { toSocketId: string; description: StageDescription };
export type IceCandidateRequest = { toSocketId: string; candidate: StageIceCandidate | null };
export type RelayedDescription = DescriptionRequest & { fromSocketId: string };
export type RelayedIceCandidate = IceCandidateRequest & { fromSocketId: string };
export type StageTargetRequest = { targetSocketId: string };
export type StageLockRequest = StageTargetRequest & { kind: 'audio' | 'video'; locked: boolean };
export type StageForceMute = Pick<StageLockRequest, 'kind' | 'locked'>;

export interface ClientToServerEvents {
  'webrtc:description': (payload: DescriptionRequest, ack: (result: CommandAck) => void) => void;
  'webrtc:ice-candidate': (payload: IceCandidateRequest, ack: (result: CommandAck) => void) => void;
  'room:join': (payload: JoinRoomRequest, ack: (result: JoinAck) => void) => void;
  'room:leave': (ack: (result: CommandAck) => void) => void;
  'media:state': (payload: MediaPatch, ack: (result: CommandAck) => void) => void;
  'stage:raise-hand': (payload: { raised: boolean }, ack: (result: CommandAck) => void) => void;
  'stage:promote': (payload: StageTargetRequest, ack: (result: CommandAck) => void) => void;
  'stage:demote': (payload: StageTargetRequest, ack: (result: CommandAck) => void) => void;
  'stage:set-lock': (payload: StageLockRequest, ack: (result: CommandAck) => void) => void;
  'broadcast:start': (ack: (result: CommandAck) => void) => void;
  'broadcast:stop': (ack: (result: CommandAck) => void) => void;
}

export interface ServerToClientEvents {
  'stage:force-mute': (payload: StageForceMute) => void;
  'webrtc:description': (payload: RelayedDescription) => void;
  'webrtc:ice-candidate': (payload: RelayedIceCandidate) => void;
  'room:state': (snapshot: RoomSnapshot) => void;
  'room:ended': (payload: { roomId: string }) => void;
}
