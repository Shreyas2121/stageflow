import type { ConnectionPhase } from './room-session';

export type DeviceMember = {
  phase: ConnectionPhase;
  audience: 'attendee' | 'stage';
  needsCaptureConsent: boolean;
};

export type DeviceSelects = {
  camera: boolean;
  microphone: boolean;
  speaker: boolean;
};

/** In-call selects. Consent stays in the green room, and attendees get the speaker only. */
export function deviceSelects(member: DeviceMember): DeviceSelects {
  if (member.phase !== 'joined' || member.needsCaptureConsent) {
    return { camera: false, microphone: false, speaker: false };
  }
  if (member.audience === 'attendee') {
    return { camera: false, microphone: false, speaker: true };
  }
  return { camera: true, microphone: true, speaker: true };
}
