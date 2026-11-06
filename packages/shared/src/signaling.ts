import type { RoomMode, RoomStatus } from './contracts';
import type { BroadcastStatus } from './broadcast';
import type { MediaPatch, ParticipantState, StageError } from './stage';
import type {
  ChatHistoryRequest,
  ChatHistoryResult,
  ChatMessage,
  ChatSendRequest,
  ChatSetPausedRequest,
} from './chat';
import type { QaQuestionIdRequest, QaSetSubmissionsRequest, QaSubmitRequest } from './qa';

export type RoomSnapshot = {
  revision: number;
  roomId: string;
  mode: RoomMode;
  status: RoomStatus;
  participants: ParticipantState[];
  stageParticipantIds: string[];
  waitingParticipantIds: string[];
  handParticipantIds: string[];
  broadcast: {
    id: string;
    status: BroadcastStatus;
    playlistUrl: string | null;
    errorMessage: string | null;
  } | null;
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
  | 'broadcast_active'
  | 'encoder_capacity'
  | 'storage_full'
  | 'ffmpeg_unavailable'
  | 'peer_unavailable'
  | 'chat_invalid'
  | 'chat_paused'
  | 'chat_rate_limited'
  | 'chat_busy'
  | 'qa_invalid'
  | 'qa_closed'
  | 'qa_full'
  | 'qa_rate_limited'
  | 'qa_vote_rate_limited'
  | 'qa_not_allowed'
  | 'qa_missing'
  | 'qa_busy';
export type CommandAck = { ok: true } | { ok: false; error: SignalingError; message: string };
export type QaQuestion = {
  id: string;
  text: string;
  authorName: string;
  authorParticipantId: string;
  /** Server clock in milliseconds since the Unix epoch. */
  createdAt: number;
  voteCount: number;
};
export type QaFeature = { questionId: string; text: string; authorName: string };
export type QaState = {
  submissionsOpen: boolean;
  featured: QaFeature | null;
  questions: QaQuestion[];
};
/** Only the caller's ack carries their votes; room events carry QaState alone. */
export type QaStateAck =
  ({ ok: true; votedQuestionIds: string[] } & QaState) | Extract<CommandAck, { ok: false }>;
export type ChatSendAck = { ok: true; message: ChatMessage } | Extract<CommandAck, { ok: false }>;
export type ChatHistoryAck =
  ({ ok: true } & ChatHistoryResult) | Extract<CommandAck, { ok: false }>;
export type ChatSetPausedAck = { ok: true; paused: boolean } | Extract<CommandAck, { ok: false }>;
export type JoinAck =
  | { ok: true; participantId: string; iceServers: IceServer[]; resumeCredential?: string }
  | Extract<CommandAck, { ok: false }>;
export type ResumeRoomRequest = { roomId: string; participantId: string; resumeCredential: string };
export type ResumeAck =
  | {
      ok: true;
      participantId: string;
      connectionGeneration: number;
      iceServers: IceServer[];
      snapshot: RoomSnapshot;
    }
  | Extract<CommandAck, { ok: false }>;
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
export type DescriptionRequest = { toParticipantId: string; description: StageDescription };
export type IceCandidateRequest = { toParticipantId: string; candidate: StageIceCandidate | null };
export type RelayedDescription = DescriptionRequest & { fromParticipantId: string };
export type RelayedIceCandidate = IceCandidateRequest & { fromParticipantId: string };
export type StageTargetRequest = { targetParticipantId: string };
export type StageLockRequest = StageTargetRequest & { kind: 'audio' | 'video'; locked: boolean };
export type StageForceMute = Pick<StageLockRequest, 'kind' | 'locked'>;

export interface ClientToServerEvents {
  'qa:submit': (payload: QaSubmitRequest, ack: (result: QaStateAck) => void) => void;
  'qa:vote': (payload: QaQuestionIdRequest, ack: (result: QaStateAck) => void) => void;
  'qa:dismiss': (payload: QaQuestionIdRequest, ack: (result: QaStateAck) => void) => void;
  'qa:feature': (payload: QaQuestionIdRequest, ack: (result: QaStateAck) => void) => void;
  'qa:clear-feature': (ack: (result: QaStateAck) => void) => void;
  'qa:set-submissions': (
    payload: QaSetSubmissionsRequest,
    ack: (result: QaStateAck) => void,
  ) => void;
  'qa:state': (ack: (result: QaStateAck) => void) => void;
  'chat:send': (payload: ChatSendRequest, ack: (result: ChatSendAck) => void) => void;
  'chat:history': (payload: ChatHistoryRequest, ack: (result: ChatHistoryAck) => void) => void;
  'chat:set-paused': (
    payload: ChatSetPausedRequest,
    ack: (result: ChatSetPausedAck) => void,
  ) => void;
  'webrtc:description': (payload: DescriptionRequest, ack: (result: CommandAck) => void) => void;
  'webrtc:ice-candidate': (payload: IceCandidateRequest, ack: (result: CommandAck) => void) => void;
  'room:join': (payload: JoinRoomRequest, ack: (result: JoinAck) => void) => void;
  'room:resume': (payload: ResumeRoomRequest, ack: (result: ResumeAck) => void) => void;
  'room:start': (ack: (result: CommandAck) => void) => void;
  'room:cancel': (ack: (result: CommandAck) => void) => void;
  'stage:admit': (payload: StageTargetRequest, ack: (result: CommandAck) => void) => void;
  'stage:remove-waiter': (payload: StageTargetRequest, ack: (result: CommandAck) => void) => void;
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
  'qa:state': (state: QaState) => void;
  'room:resume-credential': (payload: {
    roomId: string;
    participantId: string;
    resumeCredential: string;
  }) => void;
  'chat:message': (message: ChatMessage) => void;
  'chat:paused': (payload: ChatSetPausedRequest) => void;
  'stage:force-mute': (payload: StageForceMute) => void;
  'webrtc:description': (payload: RelayedDescription) => void;
  'webrtc:ice-candidate': (payload: RelayedIceCandidate) => void;
  'room:state': (snapshot: RoomSnapshot) => void;
  'room:ended': (payload: { roomId: string }) => void;
}
