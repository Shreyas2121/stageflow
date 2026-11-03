import type { CommandAck, SignalingError } from '@stageflow/shared';
const messages: Record<SignalingError, string> = {
  broadcast_not_available: 'Broadcast is not available yet.',
  broadcast_active: 'A broadcast is already active.',
  ffmpeg_unavailable: 'FFmpeg is not available. The stage is still up.',
  room_ended: 'This room has ended.',
  already_joined: 'This guest is already in the room.',
  host_not_present: 'The host has to join this meeting before anyone else.',
  stage_full: 'This meeting already has 4 people on stage.',
  room_not_found: 'No room exists for that slug.',
  not_attendee: 'Only attendees can raise a hand.',
  audio_locked: 'The host has muted your microphone.',
  video_locked: 'The host has turned off your camera.',
  participant_not_found: 'This participant is no longer in the room.',
  not_connected: 'This participant is not connected.',
  not_host: 'Only the host can do that.',
  cannot_demote_host: 'The host must stay on stage.',
  not_speaker: 'This participant is not a speaker.',
  invalid_payload: 'The room command is invalid.',
  not_joined: 'Join the room first.',
  server_error: 'Unable to update the live room. Join again.',
  rate_limited: 'Too many room commands. Try again shortly.',
  server_busy: 'The live server is busy. Try again shortly.',
  not_on_stage: 'Only people on stage can enable or exchange media.',
  peer_unavailable: 'That person is no longer on stage.',
};
export function failure(error: SignalingError): Extract<CommandAck, { ok: false }> {
  return { ok: false, error, message: messages[error] };
}
