export type NegotiationFlags = {
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  signalingState: 'stable' | 'have-local-offer' | 'have-remote-offer'
    | 'have-local-pranswer' | 'have-remote-pranswer' | 'closed';
  remoteDescriptionSet: boolean;
};

export type NegotiationEvent =
  | { type: 'negotiation-needed' }
  | { type: 'local-offer-finished' }
  | { type: 'description'; description: { type: 'offer' | 'answer' } }
  | { type: 'candidate' };

export type NegotiationAction = 'none' | 'send-offer' | 'ignore-description'
  | 'accept-offer' | 'accept-answer' | 'queue-candidate' | 'add-candidate' | 'drop-candidate';

export type NegotiationResult = { flags: NegotiationFlags; action: NegotiationAction };

export function meshPeers(selfSocketId: string, stageSocketIds: readonly string[]): string[] {
  return stageSocketIds.includes(selfSocketId)
    ? stageSocketIds.filter((id) => id !== selfSocketId) : [];
}

export function canRelay(stageSocketIds: readonly string[], fromSocketId: string, toSocketId: string): boolean {
  return fromSocketId !== toSocketId
    && stageSocketIds.includes(fromSocketId) && stageSocketIds.includes(toSocketId);
}

// Decisions only: the caller applies descriptions and flushes queued candidates after success.
export function reduceNegotiation(flags: NegotiationFlags, event: NegotiationEvent): NegotiationResult {
  const next = { ...flags };
  switch (event.type) {
    case 'negotiation-needed':
      if (flags.signalingState !== 'stable' || flags.makingOffer) return { flags: next, action: 'none' };
      next.makingOffer = true;
      return { flags: next, action: 'send-offer' };
    case 'local-offer-finished':
      next.makingOffer = false;
      return { flags: next, action: 'none' };
    case 'description': {
      if (event.description.type === 'offer') {
        const readyForOffer = !flags.makingOffer
          && (flags.signalingState === 'stable' || flags.isSettingRemoteAnswerPending);
        const offerCollision = !readyForOffer;
        if (!flags.polite && offerCollision) {
          next.ignoreOffer = true;
          return { flags: next, action: 'ignore-description' };
        }
      }
      next.remoteDescriptionSet = true;
      next.ignoreOffer = false;
      return { flags: next, action: event.description.type === 'offer' ? 'accept-offer' : 'accept-answer' };
    }
    case 'candidate':
      return { flags: next, action: flags.ignoreOffer ? 'drop-candidate'
        : flags.remoteDescriptionSet ? 'add-candidate' : 'queue-candidate' };
  }
}
